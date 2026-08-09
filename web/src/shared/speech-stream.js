import { api } from './api-client.js';

export const SPEECH_STREAM_ENDPOINT = '/api/chat/transcribe/stream';
export const SPEECH_STREAM_PROTOCOL_VERSION = 1;
export const SPEECH_PCM_SAMPLE_RATE = 16000;
export const SPEECH_PCM_FRAME_SAMPLES = 1600;
export const SPEECH_PCM_WORKLET_NAME = 'cockpit-speech-pcm16';
export const SPEECH_STREAM_AUDIO = Object.freeze({
  encoding: 'pcm_s16le',
  sampleRate: SPEECH_PCM_SAMPLE_RATE,
  channels: 1,
  frameSamples: SPEECH_PCM_FRAME_SAMPLES,
});

// Server даёт worker-у до 120 с, но окно не держит live-path так долго:
// после 45 с полный MediaRecorder остаётся для предсказуемого batch fallback.
const DEFAULT_READY_TIMEOUT_MS = 45000;
const DEFAULT_DRAIN_TIMEOUT_MS = 30000;
const DEFAULT_WORKLET_FLUSH_TIMEOUT_MS = 500;
const DEFAULT_AUDIO_CLOSE_TIMEOUT_MS = 750;
const DEFAULT_SOCKET_CLOSE_TIMEOUT_MS = 750;
// Около 24 с PCM16/16k mono. Это намеренно меньше server maxPending/maxWindow
// (30 с): cold start либо успевает перейти в rolling decode, либо заранее и
// предсказуемо включает полный batch fallback, не обрушивая серверную очередь.
const DEFAULT_MAX_BUFFERED_BYTES = 768 * 1024;
const DEFAULT_SOCKET_HIGH_WATER_BYTES = 128 * 1024;
const DEFAULT_WORKLET_URL = new URL('./speech-pcm-worklet.js', import.meta.url);
const SOCKET_OPEN = 1;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // Ошибка live-транспорта может произойти до Stop. Отдельный обработчик не
  // даёт браузеру считать внутренний promise необработанным; вызывающий всё
  // равно получает ту же ошибку через onError и из stop().
  promise.catch(() => {});
  return { promise, resolve, reject, settled: false };
}

function settle(target, method, value) {
  if (target.settled) return;
  target.settled = true;
  target[method](value);
}

function asError(error, fallbackCode = 'speech_stream_failed') {
  if (error instanceof Error) {
    if (!error.code) error.code = fallbackCode;
    return error;
  }
  const result = new Error(String(error || 'Live-распознавание недоступно'));
  result.code = fallbackCode;
  return result;
}

function protocolError(message) {
  const error = new Error(message);
  error.code = 'speech_stream_protocol';
  return error;
}

function abortError(message = 'Live-распознавание отменено') {
  const error = new Error(message);
  error.name = 'AbortError';
  error.code = 'speech_stream_cancelled';
  return error;
}

function parseServerMessage(raw) {
  if (typeof raw !== 'string') throw protocolError('Сервер речи прислал не JSON-сообщение');
  let message;
  try { message = JSON.parse(raw); }
  catch { throw protocolError('Сервер речи прислал повреждённый JSON'); }
  if (!message || typeof message !== 'object' || Array.isArray(message)
    || typeof message.type !== 'string') {
    throw protocolError('В сообщении сервера речи отсутствует type');
  }
  return message;
}

function validateStart({ mediaStream, sessionId, revision }) {
  if (!mediaStream || typeof mediaStream !== 'object') {
    throw new TypeError('Для live-распознавания нужен MediaStream');
  }
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    throw new TypeError('Для live-распознавания нужен sessionId');
  }
  if (typeof revision !== 'string' || !revision) {
    throw new TypeError('Для live-распознавания нужна revision настроек речи');
  }
}

function sameAudioContract(audio) {
  return !!audio
    && audio.encoding === SPEECH_STREAM_AUDIO.encoding
    && audio.sampleRate === SPEECH_STREAM_AUDIO.sampleRate
    && audio.channels === SPEECH_STREAM_AUDIO.channels
    && audio.frameSamples === SPEECH_STREAM_AUDIO.frameSamples;
}

/** Кодирует один непрерывный PCM-кадр: uint32 LE seq + little-endian PCM16. */
export function encodeSpeechPcmPacket(seq, pcm) {
  if (!Number.isSafeInteger(seq) || seq < 1 || seq > 0xffffffff) {
    throw new RangeError('seq PCM-кадра вне диапазона uint32');
  }
  const bytes = pcm instanceof ArrayBuffer
    ? new Uint8Array(pcm)
    : ArrayBuffer.isView(pcm)
      ? new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
      : null;
  if (!bytes || !bytes.byteLength || bytes.byteLength % 2 !== 0) {
    throw new TypeError('PCM-кадр должен быть непустым набором 16-битных samples');
  }
  const packet = new ArrayBuffer(4 + bytes.byteLength);
  new DataView(packet).setUint32(0, seq, true);
  new Uint8Array(packet, 4).set(bytes);
  return packet;
}

class SpeechStreamSession {
  constructor(config) {
    this.config = config;
    this.state = 'connecting';
    this.socket = null;
    this.context = null;
    this.source = null;
    this.node = null;
    this.silentGain = null;
    this.nextSeq = 1;
    this.lastSeq = 0;
    this.highestSentSeq = 0;
    this.ackSeq = 0;
    this.queue = [];
    this.queueBytes = 0;
    this.inFlight = new Map();
    this.inFlightBytes = 0;
    this.serverReady = false;
    this.ready = deferred();
    this.done = deferred();
    this.failure = null;
    this.stopPromise = null;
    this.cancelPromise = null;
    this.terminalPromise = null;
    this.cleanupPromise = null;
    this.socketClosePromise = null;
    this.readyTimer = null;
    this.drainTimer = null;
    this.pumpTimer = null;
    this.workletFlush = null;
    this.stopSent = false;
    this.finalSeen = false;
    this.abortHandler = null;
  }

  async open() {
    const {
      signal,
      apiClient,
      endpoint,
      WebSocketCtor,
      readyTimeoutMs,
    } = this.config;
    if (signal?.aborted) throw abortError();
    if (typeof WebSocketCtor !== 'function') {
      throw asError('Браузер не поддерживает WebSocket', 'speech_stream_unsupported');
    }

    if (signal) {
      this.abortHandler = () => { void this.cancel(); };
      signal.addEventListener('abort', this.abortHandler, { once: true });
    }

    let socket;
    try {
      socket = new WebSocketCtor(apiClient.wsUrl(endpoint));
    } catch (error) {
      this.#fail(asError(error));
      return this.ready.promise;
    }
    this.socket = socket;
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => {
      if (this.state !== 'connecting') return;
      try {
        socket.send(JSON.stringify({
          type: 'start',
          protocolVersion: SPEECH_STREAM_PROTOCOL_VERSION,
          sessionId: this.config.sessionId,
          revision: this.config.revision,
          audio: SPEECH_STREAM_AUDIO,
        }));
      } catch (error) {
        this.#fail(asError(error));
      }
    };
    socket.onmessage = (event) => { this.#onSocketMessage(event); };
    socket.onerror = () => {
      this.#fail(asError('Соединение live-распознавания оборвалось'));
    };
    socket.onclose = () => {
      if (this.state === 'done' || this.state === 'cancelled' || this.state === 'failed') return;
      this.#fail(asError('Сервер закрыл live-распознавание до результата'));
    };
    this.readyTimer = setTimeout(() => {
      this.#fail(asError('Сервер речи не подтвердил готовность вовремя', 'speech_stream_ready_timeout'));
    }, readyTimeoutMs);

    try {
      // Захват стартует сразу, параллельно cold-start модели. До server ready
      // PCM лежит в bounded queue — начало фразы не теряется.
      await Promise.all([this.ready.promise, this.#startCapture()]);
    } catch (error) {
      if (this.state === 'cancelled') {
        await (this.cancelPromise || this.terminalPromise);
        throw abortError();
      }
      await this.#fail(asError(error, 'speech_stream_capture_failed'));
      if (this.state === 'cancelled') {
        await (this.cancelPromise || this.terminalPromise);
        throw abortError();
      }
      throw this.failure || asError(error, 'speech_stream_capture_failed');
    }
    if (this.failure) throw this.failure;
    if (this.state === 'cancelled') {
      await (this.cancelPromise || this.terminalPromise);
      throw abortError();
    }
    if (this.state === 'done') return this;
    this.state = 'recording';
    return this;
  }

  #emit(message) {
    try { this.config.onEvent(message); }
    catch { /* ошибка UI-слушателя не должна рвать аудиопоток */ }
  }

  #notifyError(error) {
    try { this.config.onError(error); }
    catch { /* ошибка UI-слушателя не должна скрывать исходный сбой */ }
  }

  #onSocketMessage(event) {
    if (['done', 'cancelled', 'failed'].includes(this.state)) return;
    let message;
    try { message = parseServerMessage(event?.data); }
    catch (error) {
      this.#fail(error);
      return;
    }

    switch (message.type) {
      case 'ready':
        if (this.state !== 'connecting' || this.ready.settled) {
          this.#fail(protocolError('Повторное или позднее ready от сервера речи'));
          return;
        }
        if (message.protocolVersion !== SPEECH_STREAM_PROTOCOL_VERSION
          || !sameAudioContract(message.audio)) {
          this.#fail(protocolError('Версия или PCM-контракт сервера речи не совпадает с клиентом'));
          return;
        }
        clearTimeout(this.readyTimer);
        this.readyTimer = null;
        this.serverReady = true;
        this.state = 'starting';
        settle(this.ready, 'resolve', message);
        this.#emit(message);
        this.#flushQueue();
        return;
      case 'ack': {
        if (!['starting', 'recording', 'stopping'].includes(this.state)) {
          this.#fail(protocolError('ack получен до ready сервера речи'));
          return;
        }
        const ackSeq = message.ackSeq ?? message.seq;
        if (!Number.isSafeInteger(ackSeq) || ackSeq < 0 || ackSeq > this.highestSentSeq) {
          this.#fail(protocolError('Некорректный ackSeq от сервера речи'));
          return;
        }
        if (ackSeq > this.ackSeq) {
          this.ackSeq = ackSeq;
          for (const [seq, bytes] of this.inFlight) {
            if (seq > ackSeq) break;
            this.inFlight.delete(seq);
            this.inFlightBytes -= bytes;
          }
        }
        this.#emit(message);
        this.#flushQueue();
        return;
      }
      case 'partial':
        if (!['starting', 'recording', 'stopping'].includes(this.state)) {
          this.#fail(protocolError('partial получен до ready сервера речи'));
          return;
        }
        if (typeof message.text !== 'string') {
          this.#fail(protocolError('В partial отсутствует текст'));
          return;
        }
        this.#emit(message);
        return;
      case 'final':
        if (this.state !== 'stopping' || this.finalSeen || typeof message.text !== 'string') {
          this.#fail(protocolError('Некорректный или повторный final сервера речи'));
          return;
        }
        this.finalSeen = true;
        this.#emit(message);
        return;
      case 'done':
        if (this.state !== 'stopping' || !this.finalSeen || typeof message.text !== 'string') {
          this.#fail(protocolError('Некорректный done сервера речи'));
          return;
        }
        void this.#complete(message);
        this.#emit(message);
        return;
      case 'error': {
        this.#emit(message);
        const error = new Error(message.message || 'Сервер не смог распознать речь');
        error.code = message.code || 'speech_stream_server_error';
        this.#fail(error);
        return;
      }
      default:
        this.#fail(protocolError(`Неизвестный тип сообщения речи: ${message.type}`));
    }
  }

  async #startCapture() {
    const {
      AudioContextCtor,
      AudioWorkletNodeCtor,
      mediaStream,
      workletUrl,
    } = this.config;
    if (typeof AudioContextCtor !== 'function' || typeof AudioWorkletNodeCtor !== 'function') {
      throw asError('Браузер не поддерживает AudioWorklet', 'speech_stream_unsupported');
    }

    let context;
    try { context = new AudioContextCtor({ latencyHint: 'interactive' }); }
    catch { context = new AudioContextCtor(); }
    this.context = context;
    if (!context.audioWorklet?.addModule) {
      throw asError('Браузер не поддерживает AudioWorklet', 'speech_stream_unsupported');
    }
    await context.audioWorklet.addModule(String(workletUrl));
    if (this.failure) return;
    if (this.state === 'cancelled') throw abortError();
    if (this.state === 'done') return;

    this.source = context.createMediaStreamSource(mediaStream);
    this.node = new AudioWorkletNodeCtor(context, SPEECH_PCM_WORKLET_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
      processorOptions: {
        targetSampleRate: SPEECH_PCM_SAMPLE_RATE,
        frameSamples: SPEECH_PCM_FRAME_SAMPLES,
      },
    });
    this.silentGain = context.createGain();
    this.silentGain.gain.value = 0;
    this.node.port.onmessage = (event) => { this.#onWorkletMessage(event); };
    this.node.port.start?.();
    this.source.connect(this.node);
    this.node.connect(this.silentGain);
    this.silentGain.connect(context.destination);
    await context.resume?.();
  }

  #onWorkletMessage(event) {
    const message = event?.data;
    if (message?.type === 'flushed') {
      if (this.workletFlush) settle(this.workletFlush, 'resolve');
      return;
    }
    if (message?.type !== 'pcm'
      || !['connecting', 'starting', 'recording', 'stopping'].includes(this.state)) return;
    let packet;
    try {
      const seq = this.nextSeq;
      packet = encodeSpeechPcmPacket(seq, message.pcm);
      this.nextSeq += 1;
      this.lastSeq = seq;
    } catch (error) {
      this.#fail(asError(error, 'speech_stream_pcm_invalid'));
      return;
    }

    const pendingBytes = this.queueBytes + this.inFlightBytes + packet.byteLength;
    if (pendingBytes > this.config.maxBufferedBytes) {
      this.#fail(asError(
        'Live-распознавание не успевает за записью',
        'speech_stream_backpressure',
      ));
      return;
    }
    this.queue.push({ seq: this.lastSeq, packet });
    this.queueBytes += packet.byteLength;
    this.#flushQueue();
  }

  #flushQueue() {
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN || !this.serverReady || this.failure) return;
    while (this.queue.length
      && socket.bufferedAmount <= this.config.socketHighWaterBytes) {
      const frame = this.queue.shift();
      this.queueBytes -= frame.packet.byteLength;
      try { socket.send(frame.packet); }
      catch (error) {
        this.#fail(asError(error));
        return;
      }
      this.inFlight.set(frame.seq, frame.packet.byteLength);
      this.inFlightBytes += frame.packet.byteLength;
      this.highestSentSeq = frame.seq;
    }
    if (this.queue.length) this.#schedulePump();
    else this.#maybeSendStop();
  }

  #schedulePump() {
    if (this.pumpTimer || this.failure) return;
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      this.#flushQueue();
    }, 20);
  }

  #maybeSendStop() {
    if (this.state !== 'stopping' || this.stopSent || this.queue.length
      || !this.socket || this.socket.readyState !== SOCKET_OPEN) return;
    try {
      this.socket.send(JSON.stringify({ type: 'stop', seq: this.lastSeq }));
      this.stopSent = true;
    } catch (error) {
      this.#fail(asError(error));
    }
  }

  async #stopCapture(flush) {
    if (!this.context && !this.node) return;
    if (flush && this.node?.port) {
      this.workletFlush = deferred();
      const timeout = setTimeout(() => {
        settle(this.workletFlush, 'reject', asError(
          'AudioWorklet не подтвердил последний PCM-кадр',
          'speech_stream_flush_timeout',
        ));
      }, this.config.workletFlushTimeoutMs);
      try {
        this.node.port.postMessage({ type: 'flush' });
        await this.workletFlush.promise;
      } catch (error) {
        const failure = asError(error, 'speech_stream_flush_failed');
        await this.#fail(failure);
        if (this.state === 'cancelled') throw abortError();
        throw this.failure || failure;
      } finally {
        clearTimeout(timeout);
        this.workletFlush = null;
      }
    }
    await this.#teardownAudio();
  }

  async #teardownAudio() {
    if (this.cleanupPromise) return this.cleanupPromise;
    const context = this.context;
    const source = this.source;
    const node = this.node;
    const silentGain = this.silentGain;
    this.context = null;
    this.source = null;
    this.node = null;
    this.silentGain = null;
    this.cleanupPromise = (async () => {
      if (node?.port) {
        node.port.onmessage = null;
        try { node.port.close?.(); } catch { /* MessagePort уже закрыт */ }
      }
      for (const current of [source, node, silentGain]) {
        try { current?.disconnect?.(); } catch { /* AudioNode уже отключён */ }
      }
      // Safari/Chromium при смене устройства иногда не разрешают close(). Узлы и
      // port уже синхронно отсоединены выше; сам close ждём лишь ограниченно, чтобы
      // Esc/fallback не зависали за пределами transport timeout.
      let closeTimer = null;
      try {
        const closing = Promise.resolve(context?.close?.()).catch(() => {});
        await Promise.race([
          closing,
          new Promise((resolve) => {
            closeTimer = setTimeout(resolve, this.config.audioCloseTimeoutMs);
          }),
        ]);
      } catch { /* AudioContext уже закрыт */ }
      finally { clearTimeout(closeTimer); }
    })();
    return this.cleanupPromise;
  }

  #detachSignal() {
    if (this.abortHandler && this.config.signal) {
      this.config.signal.removeEventListener('abort', this.abortHandler);
    }
    this.abortHandler = null;
  }

  #closeSocket() {
    if (this.socketClosePromise) return this.socketClosePromise;
    const socket = this.socket;
    this.socket = null;
    if (!socket) return Promise.resolve();
    socket.onopen = null;
    socket.onmessage = null;
    this.socketClosePromise = new Promise((resolve) => {
      let timer = null;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.onerror = null;
        socket.onclose = null;
        resolve();
      };
      socket.onerror = finish;
      socket.onclose = finish;
      timer = setTimeout(finish, this.config.socketCloseTimeoutMs);
      try {
        if (socket.readyState < 2) socket.close(1000);
        if (socket.readyState === 3) finish();
      } catch { finish(); }
    });
    return this.socketClosePromise;
  }

  #clearTimers() {
    clearTimeout(this.readyTimer);
    clearTimeout(this.drainTimer);
    clearTimeout(this.pumpTimer);
    this.readyTimer = null;
    this.drainTimer = null;
    this.pumpTimer = null;
  }

  #fail(rawError) {
    if (this.failure) return this.terminalPromise || Promise.resolve();
    if (this.state === 'cancelled') return this.cancelPromise || this.terminalPromise || Promise.resolve();
    if (this.state === 'done') return this.terminalPromise || Promise.resolve();
    const error = asError(rawError);
    this.failure = error;
    this.state = 'failed';
    this.#clearTimers();
    this.queue = [];
    this.queueBytes = 0;
    this.inFlight.clear();
    this.inFlightBytes = 0;
    this.#detachSignal();
    this.terminalPromise = Promise.all([this.#closeSocket(), this.#teardownAudio()]).then(() => {
      this.#notifyError(error);
      settle(this.ready, 'reject', error);
      settle(this.done, 'reject', error);
    });
    return this.terminalPromise;
  }

  async #complete(message) {
    if (this.failure || this.state === 'cancelled' || this.done.settled) {
      return this.terminalPromise;
    }
    this.state = 'done';
    this.#clearTimers();
    this.#detachSignal();
    this.terminalPromise = Promise.all([this.#closeSocket(), this.#teardownAudio()]).then(() => {
      settle(this.done, 'resolve', message);
    });
    await this.terminalPromise;
    return message;
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      if (this.failure) {
        await this.terminalPromise;
        throw this.failure;
      }
      if (this.state === 'done') return this.done.promise;
      if (this.state === 'cancelled') {
        await (this.cancelPromise || this.terminalPromise);
        throw abortError();
      }
      if (this.state !== 'recording') {
        throw asError('Live-распознавание ещё не готово', 'speech_stream_not_ready');
      }
      this.state = 'stopping';
      await this.#stopCapture(true);
      if (this.failure) {
        await this.terminalPromise;
        throw this.failure;
      }
      if (this.state === 'cancelled') {
        await (this.cancelPromise || this.terminalPromise);
        throw abortError();
      }
      if (this.state === 'done') return this.done.promise;
      this.#flushQueue();
      this.#maybeSendStop();
      this.drainTimer = setTimeout(() => {
        this.#fail(asError(
          'Финальное live-распознавание не завершилось вовремя',
          'speech_stream_drain_timeout',
        ));
      }, this.config.drainTimeoutMs);
      return this.done.promise;
    })();
    return this.stopPromise;
  }

  async cancel() {
    if (this.cancelPromise) return this.cancelPromise;
    if (this.state === 'done') return this.terminalPromise;
    this.state = 'cancelled';
    this.#clearTimers();
    this.queue = [];
    this.queueBytes = 0;
    this.inFlight.clear();
    this.inFlightBytes = 0;
    this.#detachSignal();
    if (this.workletFlush) settle(this.workletFlush, 'reject', abortError());
    const socket = this.socket;
    if (socket?.readyState === SOCKET_OPEN) {
      try { socket.send(JSON.stringify({ type: 'cancel' })); }
      catch { /* закрытие ниже остаётся авторитетным cancel */ }
    }
    const precedingTerminal = this.terminalPromise;
    this.cancelPromise = Promise.all([
      precedingTerminal,
      this.#closeSocket(),
      this.#teardownAudio(),
    ]).then(() => {
      const error = abortError();
      settle(this.ready, 'reject', error);
      settle(this.done, 'reject', error);
    });
    if (!this.terminalPromise) this.terminalPromise = this.cancelPromise;
    return this.cancelPromise;
  }
}

/**
 * Открывает одну live-сессию Whisper поверх уже полученного MediaStream.
 * Владелец MediaRecorder и дорожек — вызывающий: helper никогда не вызывает
 * track.stop(), поэтому тот же полный recording остаётся пригоден для batch fallback.
 */
export async function createSpeechStream({
  mediaStream,
  sessionId,
  revision,
  onEvent = () => {},
  onError = () => {},
  signal = null,
  endpoint = SPEECH_STREAM_ENDPOINT,
  apiClient = api,
  WebSocketCtor = globalThis.WebSocket,
  AudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext,
  AudioWorkletNodeCtor = globalThis.AudioWorkletNode,
  workletUrl = DEFAULT_WORKLET_URL,
  readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
  drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
  workletFlushTimeoutMs = DEFAULT_WORKLET_FLUSH_TIMEOUT_MS,
  audioCloseTimeoutMs = DEFAULT_AUDIO_CLOSE_TIMEOUT_MS,
  socketCloseTimeoutMs = DEFAULT_SOCKET_CLOSE_TIMEOUT_MS,
  maxBufferedBytes = DEFAULT_MAX_BUFFERED_BYTES,
  socketHighWaterBytes = DEFAULT_SOCKET_HIGH_WATER_BYTES,
} = {}) {
  validateStart({ mediaStream, sessionId, revision });
  const config = {
    mediaStream,
    sessionId,
    revision,
    onEvent: typeof onEvent === 'function' ? onEvent : () => {},
    onError: typeof onError === 'function' ? onError : () => {},
    signal,
    endpoint,
    apiClient,
    WebSocketCtor,
    AudioContextCtor,
    AudioWorkletNodeCtor,
    workletUrl,
    readyTimeoutMs,
    drainTimeoutMs,
    workletFlushTimeoutMs,
    audioCloseTimeoutMs,
    socketCloseTimeoutMs,
    maxBufferedBytes,
    socketHighWaterBytes,
  };
  return new SpeechStreamSession(config).open();
}

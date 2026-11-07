import { isRecord } from '../../../shared/lib/objects.ts';
import { api } from './apiClient.ts';
import defaultWorkletUrl from './speechPcmWorklet.ts?worker&url';

interface StreamMessage extends Record<string, unknown> {
  type: string;
  text?: string;
  protocolVersion?: number;
  audio?: unknown;
  ackSeq?: number;
  seq?: number;
  message?: string;
  code?: string;
}

interface Deferred {
  promise: Promise<unknown>;
  resolve: (value?: unknown) => void;
  reject: (reason?: unknown) => void;
  settled: boolean;
}

type StreamError = Error & { code?: string };
type Timer = ReturnType<typeof setTimeout> | null;

interface StreamOptions {
  mediaStream?: MediaStream;
  sessionId?: string;
  revision?: string;
  onEvent?: (message: StreamMessage) => void;
  onError?: (error: StreamError) => void;
  signal?: AbortSignal | null;
  endpoint?: string;
  apiClient?: Pick<typeof api, 'wsUrl'>;
  WebSocketCtor?: typeof WebSocket;
  AudioContextCtor?: typeof AudioContext;
  AudioWorkletNodeCtor?: typeof AudioWorkletNode;
  workletUrl?: string | URL;
  readyTimeoutMs?: number;
  drainTimeoutMs?: number;
  workletFlushTimeoutMs?: number;
  audioCloseTimeoutMs?: number;
  socketCloseTimeoutMs?: number;
  maxBufferedBytes?: number;
  socketHighWaterBytes?: number;
}

type StreamConfig = Required<StreamOptions>;

export const SPEECH_STREAM_ENDPOINT = '/api/chat/transcribe/stream';
export const SPEECH_STREAM_PROTOCOL_VERSION = 1;
export const SPEECH_PCM_SAMPLE_RATE = 16000;
export const SPEECH_PCM_FRAME_SAMPLES = 1600;
export const SPEECH_PCM_WORKLET_NAME = 'grigdesk-speech-pcm16';
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
const DEFAULT_WORKLET_URL = defaultWorkletUrl;
const SOCKET_OPEN = 1;

/**
 * Внутреннее ожидание может завершиться раньше, чем UI вызовет stop.
 * Локальный обработчик исключает необработанный rejection, сохраняя отказ вызывающему.
 */
function deferred(): Deferred {
  let resolve!: Deferred['resolve'];
  let reject!: Deferred['reject'];
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // Ошибка live-транспорта может произойти до Stop. Отдельный обработчик не
  // даёт браузеру считать внутренний promise необработанным; вызывающий всё
  // равно получает ту же ошибку через onError и из stop().
  promise.catch(() => {});

  return {
    promise,
    resolve,
    reject,
    settled: false,
  };
}

function settle(target: Deferred | null, method: 'resolve' | 'reject', value?: unknown) {
  if (!target || target.settled) {
    return;
  }

  target.settled = true;
  target[method](value);
}

/**
 * Исходная ошибка сохраняет identity и свой код, если транспорт уже его назначил.
 * Для иных отказов создаётся Error с прежним кодом транспортной ошибки.
 */
function asError(error: unknown, fallbackCode = 'speech_stream_failed') {
  if (error instanceof Error) {
    const coded: StreamError = error;

    if (!coded.code) {
      coded.code = fallbackCode;
    }

    return error;
  }

  const result: StreamError = new Error(String(error || 'Live-распознавание недоступно'));

  result.code = fallbackCode;

  return result;
}

function protocolError(message: string) {
  const error: StreamError = new Error(message);

  error.code = 'speech_stream_protocol';

  return error;
}

/**
 * Отмена отличается от отказа сервера именем AbortError и стабильным кодом.
 * Эти признаки сохраняются при завершении внутренних ожиданий транспорта.
 */
function abortError(message = 'Live-распознавание отменено') {
  const error: StreamError = new Error(message);

  error.name = 'AbortError';
  error.code = 'speech_stream_cancelled';

  return error;
}

/**
 * WebSocket принимает только JSON-текст с проверенными полями envelope.
 * Ошибка формы следует прежнему пути protocol error до публикации сообщения UI.
 */
function parseServerMessage(raw: unknown): StreamMessage {
  if (typeof raw !== 'string') {
    throw protocolError('Сервер речи прислал не JSON-сообщение');
  }

  let message: unknown;

  try {
    message = JSON.parse(raw);
  } catch {
    throw protocolError('Сервер речи прислал повреждённый JSON');
  }

  if (!isStreamMessage(message)) {
    throw protocolError('В сообщении сервера речи отсутствует type');
  }

  return message;
}

/**
 * Проверка аргументов выполняется до создания сокета или AudioContext.
 * Пустой sessionId и непрозрачная revision не подменяются запасными значениями.
 */
function validateStart({ mediaStream, sessionId, revision }: StreamOptions) {
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

function sameAudioContract(audio: unknown) {
  return isRecord(audio)
    && audio.encoding === SPEECH_STREAM_AUDIO.encoding
    && audio.sampleRate === SPEECH_STREAM_AUDIO.sampleRate
    && audio.channels === SPEECH_STREAM_AUDIO.channels
    && audio.frameSamples === SPEECH_STREAM_AUDIO.frameSamples;
}

/**
 * Кодирует один непрерывный PCM-кадр: uint32 LE seq и little-endian PCM16.
 * Неверный номер или нечётный набор байтов отклоняется до добавления в очередь.
 */
export function encodeSpeechPcmPacket(seq: number, pcm: unknown) {
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

/**
 * Проверяет читаемые поля протокола до передачи сообщения машине состояний.
 * Текст и номера остаются серверными значениями без преобразования типов.
 */
function isStreamMessage(value: unknown): value is StreamMessage {
  return isRecord(value) && typeof value.type === 'string'
    && ['text', 'message', 'code'].every((key) => value[key] == null || typeof value[key] === 'string')
    && ['protocolVersion', 'ackSeq', 'seq'].every((key) => (
      value[key] == null || typeof value[key] === 'number'
    ));
}

class SpeechStreamSession {
  config: StreamConfig;
  state: string;
  socket: WebSocket | null;
  context: AudioContext | null;
  source: MediaStreamAudioSourceNode | null;
  node: AudioWorkletNode | null;
  silentGain: GainNode | null;
  nextSeq: number;
  lastSeq: number;
  highestSentSeq: number;
  ackSeq: number;
  queue: Array<{ seq: number; packet: ArrayBuffer }>;
  queueBytes: number;
  inFlight: Map<number, number>;
  inFlightBytes: number;
  serverReady: boolean;
  ready: Deferred;
  done: Deferred;
  failure: StreamError | null;
  stopPromise: Promise<unknown> | null;
  cancelPromise: Promise<void> | null;
  terminalPromise: Promise<void> | null;
  cleanupPromise: Promise<void> | null;
  socketClosePromise: Promise<void> | null;
  readyTimer: Timer;
  drainTimer: Timer;
  pumpTimer: Timer;
  workletFlush: Deferred | null;
  stopSent: boolean;
  finalSeen: boolean;
  abortHandler: (() => void) | null;

  constructor(config: StreamConfig) {
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

  /**
   * Открывает сокет и захват параллельно, сохраняя bounded очередь до ready.
   * При отказе или отмене ожидания завершаются после освобождения оборудования.
   */
  async open(): Promise<SpeechStreamSession> {
    const {
      signal,
      apiClient,
      endpoint,
      WebSocketCtor,
      readyTimeoutMs,
    } = this.config;

    if (signal?.aborted) {
      throw abortError();
    }
    if (typeof WebSocketCtor !== 'function') {
      throw asError('Браузер не поддерживает WebSocket', 'speech_stream_unsupported');
    }

    if (signal) {
      this.abortHandler = () => {
        void this.cancel();
      };
      signal.addEventListener('abort', this.abortHandler, { once: true });
    }

    let socket;

    try {
      socket = new WebSocketCtor(apiClient.wsUrl(endpoint));
    } catch (error) {
      this.#fail(asError(error));
      await this.ready.promise;

      return this;
    }

    this.socket = socket;
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => {
      if (this.state !== 'connecting') {
        return;
      }

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
    socket.onmessage = (event) => {
      this.#onSocketMessage(event);
    };
    socket.onerror = () => {
      this.#fail(asError('Соединение live-распознавания оборвалось'));
    };
    socket.onclose = () => {
      if (this.state === 'done' || this.state === 'cancelled' || this.state === 'failed') {
        return;
      }

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

    if (this.failure) {
      throw this.failure;
    }
    if (this.state === 'cancelled') {
      await (this.cancelPromise || this.terminalPromise);

      throw abortError();
    }
    if (this.state === 'done') {
      return this;
    }

    this.state = 'recording';

    return this;
  }

  /**
   * Доставляет серверное событие слушателю интерфейса.
   * Исключение потребителя не разрывает захват PCM и очередь транспорта.
   */
  #emit(message: StreamMessage) {
    try { this.config.onEvent(message); }
    catch { /* ошибка UI-слушателя не должна рвать аудиопоток */ }
  }

  /**
   * Сообщает владельцу исходный отказ транспорта.
   * Ошибка обработчика не скрывает исходную причину и не прерывает cleanup.
   */
  #notifyError(error: StreamError) {
    try { this.config.onError(error); }
    catch { /* ошибка UI-слушателя не должна скрывать исходный сбой */ }
  }

  /**
   * Проверяет порядок сообщений относительно состояния live-сессии.
   * Неверный ready, ack или финал завершает транспорт прежней protocol error.
   */
  #onSocketMessage(event: MessageEvent<unknown>) {
    if (['done', 'cancelled', 'failed'].includes(this.state)) {
      return;
    }

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
        clearTimeout(this.readyTimer ?? undefined);
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

        if (typeof ackSeq !== 'number' || !Number.isSafeInteger(ackSeq)
          || ackSeq < 0 || ackSeq > this.highestSentSeq) {
          this.#fail(protocolError('Некорректный ackSeq от сервера речи'));

          return;
        }
        if (ackSeq > this.ackSeq) {
          this.ackSeq = ackSeq;

          for (const [seq, bytes] of this.inFlight) {
            if (seq > ackSeq) {
              break;
            }

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

        const error: StreamError = new Error(message.message || 'Сервер не смог распознать речь');

        error.code = message.code || 'speech_stream_server_error';
        this.#fail(error);

        return;
      }
      default:
        this.#fail(protocolError(`Неизвестный тип сообщения речи: ${message.type}`));
    }
  }

  /**
   * Подключает компилированный worklet к уже выданному MediaStream.
   * Выход остаётся заглушённым, а владение дорожками сохраняет вызывающий рекордер.
   */
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

    if (this.failure) {
      return;
    }
    if (this.state === 'cancelled') {
      throw abortError();
    }
    if (this.state === 'done') {
      return;
    }

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
    this.node.port.onmessage = (event) => {
      this.#onWorkletMessage(event);
    };
    this.node.port.start?.();
    this.source.connect(this.node);
    this.node.connect(this.silentGain);
    this.silentGain.connect(context.destination);
    await context.resume?.();
  }

  /**
   * Принимает PCM только пока транспорт может доставить его серверу.
   * Переполнение общей очереди и in-flight завершает сессию вместо потери звука.
   */
  #onWorkletMessage(event: MessageEvent<unknown>) {
    const message = isRecord(event.data) ? event.data : {};

    if (message?.type === 'flushed') {
      if (this.workletFlush) {
        settle(this.workletFlush, 'resolve');
      }

      return;
    }
    if (message?.type !== 'pcm'
      || !['connecting', 'starting', 'recording', 'stopping'].includes(this.state)) {
      return;
    }

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

  /**
   * Передаёт накопленные PCM-кадры с ограничением браузерного буфера.
   * Порядок seq и учёт in-flight сохраняются до получения серверного ack.
   */
  #flushQueue() {
    const socket = this.socket;

    if (!socket || socket.readyState !== SOCKET_OPEN || !this.serverReady || this.failure) {
      return;
    }

    while (this.queue.length
      && socket.bufferedAmount <= this.config.socketHighWaterBytes) {
      const frame = this.queue.shift()!;

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

    if (this.queue.length) {
      this.#schedulePump();
    } else {
      this.#maybeSendStop();
    }
  }

  /**
   * Создаёт не больше одного короткого таймера дренирования очереди.
   * Повторная проверка сокета остаётся внутри общего flushQueue.
   */
  #schedulePump() {
    if (this.pumpTimer || this.failure) {
      return;
    }

    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      this.#flushQueue();
    }, 20);
  }

  /**
   * Команда Stop уходит после последнего накопленного PCM-кадра.
   * Флаг исключает повтор команды при нескольких обновлениях очереди.
   */
  #maybeSendStop() {
    if (this.state !== 'stopping' || this.stopSent || this.queue.length
      || !this.socket || this.socket.readyState !== SOCKET_OPEN) {
      return;
    }

    try {
      this.socket.send(JSON.stringify({ type: 'stop', seq: this.lastSeq }));
      this.stopSent = true;
    } catch (error) {
      this.#fail(asError(error));
    }
  }

  /**
   * Остановка ждёт flush AudioWorklet до отключения аудиоузлов.
   * Отсутствие подтверждения имеет ограниченный timeout и прежний отказ транспорта.
   */
  async #stopCapture(flush: boolean) {
    if (!this.context && !this.node) {
      return;
    }
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

        if (this.state === 'cancelled') {
      throw abortError();
    }

        throw this.failure || failure;
      } finally {
        clearTimeout(timeout ?? undefined);
        this.workletFlush = null;
      }
    }

    await this.#teardownAudio();
  }

  /**
   * Все пути завершения разделяют одно освобождение аудиооборудования.
   * Закрытие контекста ограничено по времени, чтобы отмена не зависала в браузере.
   */
  async #teardownAudio() {
    if (this.cleanupPromise) {
      return this.cleanupPromise;
    }

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
      let closeTimer: Timer = null;

      try {
        const closing = Promise.resolve(context?.close?.()).catch(() => {});

        await Promise.race([
          closing,
          new Promise<void>((resolve) => {
            closeTimer = setTimeout(resolve, this.config.audioCloseTimeoutMs);
          }),
        ]);
      } catch { /* AudioContext уже закрыт */ }
      finally { clearTimeout(closeTimer ?? undefined); }
    })();

    return this.cleanupPromise;
  }

  /**
   * Снимает только обработчик AbortSignal, созданный этой сессией.
   * Повторный cleanup не удерживает завершённый транспорт через внешний signal.
   */
  #detachSignal() {
    if (this.abortHandler && this.config.signal) {
      this.config.signal.removeEventListener('abort', this.abortHandler);
    }

    this.abortHandler = null;
  }

  /**
   * Закрывает один WebSocket и разделяет ожидание между путями cleanup.
   * Таймаут снимает callbacks даже при отсутствии браузерного события close.
   */
  #closeSocket() {
    if (this.socketClosePromise) {
      return this.socketClosePromise;
    }

    const socket = this.socket;

    this.socket = null;

    if (!socket) {
      return Promise.resolve();
    }

    socket.onopen = null;
    socket.onmessage = null;
    this.socketClosePromise = new Promise<void>((resolve) => {
      let timer: Timer = null;
      let settled = false;
      /**
       * Событие close и страховочный timeout сходятся в одном завершении.
       * После resolve callbacks больше не удерживают сокет.
       */
      const finish = () => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer ?? undefined);
        socket.onerror = null;
        socket.onclose = null;
        resolve();
      };

      socket.onerror = finish;
      socket.onclose = finish;
      timer = setTimeout(finish, this.config.socketCloseTimeoutMs);

      try {
        if (socket.readyState < 2) {
          socket.close(1000);
        }
        if (socket.readyState === 3) {
          finish();
        }
      } catch { finish(); }
    });

    return this.socketClosePromise;
  }

  /**
   * Снимает таймеры подготовки, финала и опустошения очереди.
   * Обнуление ручек позволяет повторному cleanup оставаться безопасным.
   */
  #clearTimers() {
    clearTimeout(this.readyTimer ?? undefined);
    clearTimeout(this.drainTimer ?? undefined);
    clearTimeout(this.pumpTimer ?? undefined);
    this.readyTimer = null;
    this.drainTimer = null;
    this.pumpTimer = null;
  }

  /**
   * Первый отказ определяет итог и сообщает исходную ошибку владельцу.
   * Готовность и результат отклоняются после освобождения сокета и аудиоузлов.
   */
  #fail(rawError: unknown): Promise<void> {
    if (this.failure) {
      return this.terminalPromise || Promise.resolve();
    }
    if (this.state === 'cancelled') {
      return this.cancelPromise || this.terminalPromise || Promise.resolve();
    }
    if (this.state === 'done') {
      return this.terminalPromise || Promise.resolve();
    }

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

  /**
   * Готовый итог публикуется после общего освобождения транспорта.
   * Отмена и уже завершённое ожидание исключают повторную доставку результата.
   */
  async #complete(message: StreamMessage) {
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

  /**
   * Повторный Stop разделяет одно ожидание flush и серверного финала.
   * Отмена и timeout сохраняют свои ошибки вместо успешного пустого результата.
   */
  stop() {
    if (this.stopPromise) {
      return this.stopPromise;
    }

    this.stopPromise = (async () => {
      if (this.failure) {
        await this.terminalPromise;

        throw this.failure;
      }
      if (this.state === 'done') {
        return this.done.promise;
      }
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
      if (this.state === 'done') {
        return this.done.promise;
      }

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

  /**
   * Отмена отзывает захват и сокет без публикации итогового текста.
   * Все внутренние ожидания получают один AbortError после завершения cleanup.
   */
  async cancel() {
    if (this.cancelPromise) {
      return this.cancelPromise;
    }
    if (this.state === 'done') {
      return this.terminalPromise;
    }

    this.state = 'cancelled';
    this.#clearTimers();
    this.queue = [];
    this.queueBytes = 0;
    this.inFlight.clear();
    this.inFlightBytes = 0;
    this.#detachSignal();

    if (this.workletFlush) {
      settle(this.workletFlush, 'reject', abortError());
    }

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

    if (!this.terminalPromise) {
      this.terminalPromise = this.cancelPromise;
    }

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
  AudioContextCtor = globalThis.AudioContext || (globalThis as typeof globalThis & {
    webkitAudioContext?: typeof AudioContext;
  }).webkitAudioContext!,
  AudioWorkletNodeCtor = globalThis.AudioWorkletNode,
  workletUrl = DEFAULT_WORKLET_URL,
  readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
  drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
  workletFlushTimeoutMs = DEFAULT_WORKLET_FLUSH_TIMEOUT_MS,
  audioCloseTimeoutMs = DEFAULT_AUDIO_CLOSE_TIMEOUT_MS,
  socketCloseTimeoutMs = DEFAULT_SOCKET_CLOSE_TIMEOUT_MS,
  maxBufferedBytes = DEFAULT_MAX_BUFFERED_BYTES,
  socketHighWaterBytes = DEFAULT_SOCKET_HIGH_WATER_BYTES,
}: StreamOptions = {}) {
  validateStart({
    mediaStream,
    sessionId,
    revision,
  });

  const config = {
    mediaStream: mediaStream!,
    sessionId: sessionId!,
    revision: revision!,
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

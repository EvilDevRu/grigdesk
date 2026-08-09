import { EventEmitter } from 'node:events';
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  openSync,
  unlinkSync,
  writeSync,
} from 'node:fs';

import { SpeechRuntimeError } from './errors.js';
import {
  SPEECH_STREAM_AUDIO,
  SPEECH_STREAM_PROTOCOL_VERSION,
  createSpeechStreamProcess,
} from './stream-process.js';

const BYTES_PER_MILLISECOND = SPEECH_STREAM_AUDIO.sampleRate * 2 / 1000;
const DEFAULT_LIMITS = Object.freeze({
  decodeIntervalMs: 2_000,
  overlapMs: 1_500,
  maxWindowMs: 30_000,
  maxPendingMs: 30_000,
  maxDurationMs: 5 * 60_000,
  maxFrameBytes: 64 * 1024,
  drainTimeoutMs: 30_000,
  idleTimeoutMs: 30_000,
  hardTimeoutMs: 6 * 60_000,
});

const PUBLIC_ERRORS = Object.freeze({
  speech_model_missing: 'Локальная модель речи не установлена',
  speech_unavailable: 'Локальное распознавание сейчас недоступно',
  speech_stream_protocol: 'Поток речи нарушил протокол',
  speech_stream_too_long: 'Достигнут предел длительности диктовки',
  speech_stream_backpressure: 'Распознавание не успевает за диктовкой',
  speech_stream_timeout: 'Не удалось завершить распознавание вовремя',
  speech_stream_closed: 'Поток распознавания уже закрыт',
  transcribe_failed: 'Не удалось распознать речь',
});

function streamError(code, message, cause = undefined) {
  return new SpeechRuntimeError(message, code, cause ? { cause } : {});
}

function positiveInteger(value, fallback, name) {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected <= 0) {
    throw new TypeError(`${name} должен быть положительным целым`);
  }
  return selected;
}

function nonNegativeInteger(value, fallback, name) {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < 0) {
    throw new TypeError(`${name} должен быть неотрицательным целым`);
  }
  return selected;
}

function bytesToMs(bytes) {
  return Math.round(bytes / BYTES_PER_MILLISECOND);
}

function msToBytes(milliseconds) {
  return Math.floor(milliseconds * BYTES_PER_MILLISECOND / 2) * 2;
}

function wordKey(word) {
  return word.text.trim().toLocaleLowerCase('ru-RU');
}

function sameWord(left, right, toleranceMs = 750) {
  return wordKey(left) === wordKey(right)
    && Math.abs(left.startMs - right.startMs) <= toleranceMs;
}

function commonPrefixLength(left, right) {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && sameWord(left[index], right[index])) index += 1;
  return index;
}

function trimCommittedPrefix(committed, words) {
  if (!committed.length || !words.length) return [...words];
  const maxOverlap = Math.min(committed.length, words.length);
  for (let length = maxOverlap; length > 0; length -= 1) {
    const suffix = committed.slice(committed.length - length);
    const prefix = words.slice(0, length);
    if (commonPrefixLength(suffix, prefix) === length) return words.slice(length);
  }
  const committedUntilMs = committed.at(-1)?.endMs || 0;
  return words.filter((word) => word.endMs > committedUntilMs + 80);
}

export function speechWordsText(words) {
  return words
    .map((word) => word.text)
    .join('')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?…])/g, '$1')
    .trim();
}

/** Два последовательных совпавших префикса становятся неизменяемой частью текста. */
export function advanceLocalAgreement(state, words, { final = false } = {}) {
  const committed = Array.isArray(state?.committed) ? state.committed : [];
  const previous = Array.isArray(state?.previous) ? state.previous : [];
  const candidate = trimCommittedPrefix(committed, words);
  const stableLength = final ? candidate.length : commonPrefixLength(previous, candidate);
  const nextCommitted = [...committed, ...candidate.slice(0, stableLength)];
  const nextPrevious = final ? [] : candidate.slice(stableLength);
  return Object.freeze({
    committed: Object.freeze(nextCommitted),
    previous: Object.freeze(nextPrevious),
    committedText: speechWordsText(nextCommitted),
    partialText: speechWordsText(nextPrevious),
    text: speechWordsText([...nextCommitted, ...nextPrevious]),
  });
}

function normalizeWorkerWords(result, expected) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw streamError('speech_stream_protocol', 'Worker вернул невалидный result');
  }
  if (
    result.window?.startByte !== expected.startByte
    || result.window?.endByte !== expected.endByte
    || result.window?.offsetMs !== expected.offsetMs
    || result.window?.final !== expected.final
    || !Array.isArray(result.words)
    || result.words.length > 4096
  ) {
    throw streamError('speech_stream_protocol', 'Worker вернул несовместимое PCM window');
  }
  let previousStart = -1;
  return result.words.map((word) => {
    const startMs = Number(word?.startMs);
    const endMs = Number(word?.endMs);
    const text = typeof word?.text === 'string' ? word.text : '';
    if (
      !Number.isFinite(startMs)
      || !Number.isFinite(endMs)
      || startMs < 0
      || endMs < startMs
      || startMs + 100 < previousStart
      || endMs > bytesToMs(expected.endByte) + 2_000
      || !text.trim()
      || text.length > 512
    ) {
      throw streamError('speech_stream_protocol', 'Worker вернул невалидные word timestamps');
    }
    previousStart = startMs;
    return Object.freeze({ startMs: Math.round(startMs), endMs: Math.round(endMs), text });
  });
}

function publicFailure(error) {
  const code = typeof error?.code === 'string' ? error.code : 'transcribe_failed';
  return Object.freeze({
    type: 'error',
    code,
    message: PUBLIC_ERRORS[code] || PUBLIC_ERRORS.transcribe_failed,
  });
}

/**
 * Состояние одной диктовки. PCM никогда не выбрасывается ради interim: один decode
 * работает, а накопившиеся watermark схлопываются в следующий, самый свежий запрос.
 */
export class SpeechStreamSession extends EventEmitter {
  #controller;
  #filePath;
  #fd;
  #cleanupFile;
  #closeFile;
  #unlinkFile;
  #writeFile;
  #setTimer;
  #clearTimer;
  #limits;
  #state = 'starting';
  #bytesReceived = 0;
  #lastDecodedEndByte = 0;
  #prunedUntilMs = 0;
  #previousEmptyEndMs = null;
  #lastSeq = 0;
  #decodeInFlight = false;
  #decodeAbort = null;
  #agreement = Object.freeze({ committed: Object.freeze([]), previous: Object.freeze([]) });
  #completion;
  #resolveCompletion;
  #rejectCompletion;
  #doneResult = null;
  #drainTimer = null;
  #idleTimer = null;
  #hardTimer = null;
  #cleanupPromise = null;
  #deathPromise = null;
  #deathConfirmed = false;

  constructor({
    controller,
    filePath,
    cleanupFile = true,
    decodeIntervalMs,
    overlapMs,
    maxWindowMs,
    maxPendingMs,
    maxDurationMs,
    maxFrameBytes,
    drainTimeoutMs,
    idleTimeoutMs,
    hardTimeoutMs,
  }, deps = {}) {
    super();
    if (!controller?.ready || typeof controller.decode !== 'function' || typeof controller.cancel !== 'function') {
      throw new TypeError('SpeechStreamSession требует process controller');
    }
    if (typeof filePath !== 'string' || !filePath) throw new TypeError('filePath обязателен');
    this.#limits = Object.freeze({
      decodeIntervalMs: positiveInteger(decodeIntervalMs, DEFAULT_LIMITS.decodeIntervalMs, 'decodeIntervalMs'),
      overlapMs: nonNegativeInteger(overlapMs, DEFAULT_LIMITS.overlapMs, 'overlapMs'),
      maxWindowMs: positiveInteger(maxWindowMs, DEFAULT_LIMITS.maxWindowMs, 'maxWindowMs'),
      maxPendingMs: positiveInteger(maxPendingMs, DEFAULT_LIMITS.maxPendingMs, 'maxPendingMs'),
      maxDurationMs: positiveInteger(maxDurationMs, DEFAULT_LIMITS.maxDurationMs, 'maxDurationMs'),
      maxFrameBytes: positiveInteger(maxFrameBytes, DEFAULT_LIMITS.maxFrameBytes, 'maxFrameBytes'),
      drainTimeoutMs: positiveInteger(drainTimeoutMs, DEFAULT_LIMITS.drainTimeoutMs, 'drainTimeoutMs'),
      idleTimeoutMs: positiveInteger(idleTimeoutMs, DEFAULT_LIMITS.idleTimeoutMs, 'idleTimeoutMs'),
      hardTimeoutMs: positiveInteger(hardTimeoutMs, DEFAULT_LIMITS.hardTimeoutMs, 'hardTimeoutMs'),
    });
    if (this.#limits.maxPendingMs < this.#limits.decodeIntervalMs) {
      throw new TypeError('maxPendingMs не может быть меньше decodeIntervalMs');
    }
    if (this.#limits.maxWindowMs < this.#limits.decodeIntervalMs) {
      throw new TypeError('maxWindowMs не может быть меньше decodeIntervalMs');
    }
    this.#controller = controller;
    this.#filePath = filePath;
    this.#cleanupFile = cleanupFile;
    this.#closeFile = deps.closeSync || closeSync;
    this.#unlinkFile = deps.unlinkSync || unlinkSync;
    this.#writeFile = deps.writeSync || writeSync;
    this.#setTimer = deps.setTimeout || setTimeout;
    this.#clearTimer = deps.clearTimeout || clearTimeout;
    const openFile = deps.openSync || openSync;
    const chmodFile = deps.fchmodSync || fchmodSync;
    try {
      this.#fd = openFile(
        filePath,
        fsConstants.O_CREAT
          | fsConstants.O_EXCL
          | fsConstants.O_WRONLY
          | fsConstants.O_CLOEXEC
          | fsConstants.O_NOFOLLOW,
        0o600,
      );
      chmodFile(this.#fd, 0o600);
    } catch (error) {
      void Promise.resolve(controller.cancel()).catch(() => {});
      throw error;
    }
    this.#completion = new Promise((resolve, reject) => {
      this.#resolveCompletion = resolve;
      this.#rejectCompletion = reject;
    });
    // Ошибка может возникнуть до Stop; она хранится для будущего stop(), не становится unhandled.
    this.#completion.catch(() => {});
  }

  #emitEvent(type, payload = {}) {
    const event = Object.freeze({ type, ...payload });
    this.emit('event', event);
    return event;
  }

  #cleanupRaw() {
    if (this.#fd != null) {
      try { this.#closeFile(this.#fd); } catch { /* cleanup best-effort */ }
      this.#fd = null;
    }
    if (this.#cleanupFile) {
      try { this.#unlinkFile(this.#filePath); } catch { /* workDir удалит оставшийся файл */ }
    }
  }

  #clearSessionTimers() {
    this.#clearTimer(this.#idleTimer);
    this.#clearTimer(this.#hardTimer);
    this.#idleTimer = null;
    this.#hardTimer = null;
  }

  #resetIdleTimer() {
    this.#clearTimer(this.#idleTimer);
    this.#idleTimer = this.#setTimer(() => {
      this.#idleTimer = null;
      void this.#fail(streamError(
        'speech_stream_timeout',
        'Speech stream не получил PCM до idle deadline',
      ));
    }, this.#limits.idleTimeoutMs);
    this.#idleTimer?.unref?.();
  }

  #armSessionTimers() {
    this.#resetIdleTimer();
    this.#hardTimer = this.#setTimer(() => {
      this.#hardTimer = null;
      void this.#fail(streamError(
        'speech_stream_timeout',
        'Speech stream превысил wall-clock deadline',
      ));
    }, this.#limits.hardTimeoutMs);
    this.#hardTimer?.unref?.();
  }

  #confirmDeath() {
    if (!this.#deathConfirmed) {
      this.#deathConfirmed = true;
      this.#cleanupRaw();
    }
    return true;
  }

  #watchControllerExit() {
    if (this.#deathConfirmed) return Promise.resolve(true);
    if (!this.#deathPromise) {
      const exit = this.#controller.exit;
      this.#deathPromise = exit && typeof exit.then === 'function'
        ? Promise.resolve(exit).then(() => this.#confirmDeath())
        : new Promise(() => {});
      // Quarantine watcher не должен сам стать unhandled, даже если внешний transport ушёл.
      this.#deathPromise.catch(() => {});
    }
    return this.#deathPromise;
  }

  #terminateAndCleanup() {
    if (this.#deathConfirmed) return Promise.resolve(false);
    if (!this.#cleanupPromise) {
      this.#cleanupPromise = Promise.resolve(this.#controller.cancel()).then(
        (value) => {
          this.#confirmDeath();
          return value;
        },
        (error) => {
          // Bounded cancel уже исчерпан, но process ещё не объявлен мёртвым. Raw и
          // runtime slot остаются до настоящего child `close` через waitForDeath().
          void this.#watchControllerExit();
          throw error;
        },
      );
      this.#cleanupPromise.catch(() => {});
    }
    return this.#cleanupPromise;
  }

  async #fail(error) {
    if (['done', 'cancelled', 'failed', 'finishing'].includes(this.#state)) return;
    this.#state = 'failed';
    this.#clearTimer(this.#drainTimer);
    this.#clearSessionTimers();
    this.#decodeAbort?.abort();
    try { await this.#terminateAndCleanup(); } catch { /* остаётся quarantine до child close */ }
    this.#emitEvent('error', publicFailure(error));
    this.#rejectCompletion(error);
  }

  #rejectFrame(code, message) {
    const error = streamError(code, message);
    void this.#fail(error);
    throw error;
  }

  #writeAll(pcm) {
    let offset = 0;
    while (offset < pcm.length) {
      const written = this.#writeFile(this.#fd, pcm, offset, pcm.length - offset, null);
      if (!Number.isInteger(written) || written <= 0) {
        throw new Error('Не удалось дописать PCM frame');
      }
      offset += written;
    }
  }

  #window(endByte, final) {
    const committedUntilMs = this.#agreement.committed.at(-1)?.endMs || 0;
    const startMs = Math.max(
      this.#prunedUntilMs,
      Math.max(0, committedUntilMs - this.#limits.overlapMs),
    );
    const startByte = Math.min(endByte, msToBytes(startMs));
    if (endByte - startByte > msToBytes(this.#limits.maxWindowMs)) {
      throw streamError(
        'speech_stream_backpressure',
        'Не удалось стабилизировать текст в пределах rolling window',
      );
    }
    return Object.freeze({
      filePath: this.#filePath,
      startByte,
      endByte,
      offsetMs: bytesToMs(startByte),
      final,
    });
  }

  #resultPayload(processedUntilMs) {
    const receivedUntilMs = bytesToMs(this.#bytesReceived);
    return {
      text: this.#agreement.text || '',
      committed: this.#agreement.committedText || '',
      partial: this.#agreement.partialText || '',
      ackSeq: this.#lastSeq,
      processedUntilMs,
      receivedUntilMs,
      lagMs: Math.max(0, receivedUntilMs - processedUntilMs),
    };
  }

  async #finish(processedUntilMs) {
    if (this.#state === 'finishing' || this.#state === 'done') return;
    this.#state = 'finishing';
    this.#clearTimer(this.#drainTimer);
    this.#clearSessionTimers();
    const result = Object.freeze(this.#resultPayload(processedUntilMs));
    try {
      await this.#terminateAndCleanup();
    } catch (error) {
      if (this.#state !== 'finishing') return;
      this.#state = 'failed';
      this.#emitEvent('error', publicFailure(error));
      this.#rejectCompletion(error);
      return;
    }
    // Batch fallback или закрытие WebSocket могли отменить session, пока общий
    // process death barrier завершался. Cancel никогда не должен воскресать в done.
    if (this.#state !== 'finishing') return;
    this.#doneResult = result;
    this.#state = 'done';
    this.#emitEvent('final', result);
    this.#emitEvent('done', result);
    this.#resolveCompletion(result);
  }

  async #decode(final) {
    if (this.#decodeInFlight || ['cancelled', 'failed', 'done', 'finishing'].includes(this.#state)) return;
    const endByte = this.#bytesReceived;
    if (final && endByte === 0) {
      this.#agreement = advanceLocalAgreement(this.#agreement, [], { final: true });
      await this.#finish(0);
      return;
    }
    if (!final && endByte - this.#lastDecodedEndByte < msToBytes(this.#limits.decodeIntervalMs)) return;
    let window;
    try {
      window = this.#window(endByte, final);
    } catch (error) {
      await this.#fail(error);
      return;
    }
    this.#decodeInFlight = true;
    this.#decodeAbort = new AbortController();
    try {
      const workerResult = await this.#controller.decode({ ...window, signal: this.#decodeAbort.signal });
      if (['cancelled', 'failed', 'done'].includes(this.#state)) return;
      const words = normalizeWorkerWords(workerResult, window);
      this.#lastDecodedEndByte = endByte;
      const previousAgreement = this.#agreement;
      this.#agreement = advanceLocalAgreement(previousAgreement, words, { final });
      const processedUntilMs = bytesToMs(endByte);
      const noNewCandidate = this.#agreement.committed.length === previousAgreement.committed.length
        && this.#agreement.previous.length === 0;
      if (!final && noNewCandidate && previousAgreement.previous.length === 0) {
        if (this.#previousEmptyEndMs != null) {
          // Отбрасываем только звук, который уже попал в две последовательные
          // пустые/VAD-гипотезы, и оставляем overlap перед прошлым watermark.
          this.#prunedUntilMs = Math.max(
            this.#prunedUntilMs,
            Math.max(0, this.#previousEmptyEndMs - this.#limits.overlapMs),
          );
        }
        this.#previousEmptyEndMs = processedUntilMs;
      } else {
        this.#previousEmptyEndMs = null;
      }
      if (final) {
        await this.#finish(processedUntilMs);
      } else {
        this.#emitEvent('partial', this.#resultPayload(processedUntilMs));
      }
    } catch (error) {
      if (this.#state !== 'cancelled') await this.#fail(error);
    } finally {
      this.#decodeInFlight = false;
      this.#decodeAbort = null;
    }
    if (this.#state === 'stopping') {
      void this.#decode(true);
    } else if (
      this.#state === 'recording'
      && this.#bytesReceived - this.#lastDecodedEndByte >= msToBytes(this.#limits.decodeIntervalMs)
    ) {
      void this.#decode(false);
    }
  }

  async start() {
    if (this.#state !== 'starting') {
      throw streamError('speech_stream_closed', 'Speech stream session уже запущена или закрыта');
    }
    this.#controller.exit?.then(({ expected } = {}) => {
      if (!expected && ['starting', 'recording', 'stopping'].includes(this.#state)) {
        void this.#fail(streamError('speech_unavailable', 'Speech stream worker неожиданно завершился'));
      }
    });
    try {
      await this.#controller.ready;
    } catch (error) {
      await this.#fail(error);
      throw error;
    }
    if (this.#state !== 'starting') {
      throw streamError('speech_stream_closed', 'Speech stream session закрыта до ready');
    }
    this.#state = 'recording';
    this.#armSessionTimers();
    return this.#emitEvent('ready', {
      protocolVersion: SPEECH_STREAM_PROTOCOL_VERSION,
      audio: SPEECH_STREAM_AUDIO,
    });
  }

  pushFrame(seq, value) {
    if (this.#state !== 'recording') {
      return this.#rejectFrame('speech_stream_closed', 'PCM frame пришёл вне recording state');
    }
    if (!Number.isInteger(seq) || seq !== this.#lastSeq + 1) {
      return this.#rejectFrame('speech_stream_protocol', 'Нарушена последовательность PCM frames');
    }
    const pcm = Buffer.isBuffer(value)
      ? value
      : (ArrayBuffer.isView(value) ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : null);
    if (!pcm || pcm.length === 0 || pcm.length % 2 !== 0 || pcm.length > this.#limits.maxFrameBytes) {
      return this.#rejectFrame('speech_stream_protocol', 'Некорректный PCM16 frame');
    }
    const nextBytes = this.#bytesReceived + pcm.length;
    if (nextBytes > msToBytes(this.#limits.maxDurationMs)) {
      return this.#rejectFrame('speech_stream_too_long', 'Превышена длительность speech stream');
    }
    if (nextBytes - this.#lastDecodedEndByte > msToBytes(this.#limits.maxPendingMs)) {
      return this.#rejectFrame('speech_stream_backpressure', 'Speech stream decode не успевает за PCM');
    }
    try {
      this.#writeAll(pcm);
    } catch (error) {
      const wrapped = streamError('speech_unavailable', 'Не удалось сохранить PCM stream', error);
      void this.#fail(wrapped);
      throw wrapped;
    }
    this.#bytesReceived = nextBytes;
    this.#lastSeq = seq;
    this.#resetIdleTimer();
    const receivedUntilMs = bytesToMs(this.#bytesReceived);
    const ack = this.#emitEvent('ack', { seq, ackSeq: seq, receivedUntilMs });
    void this.#decode(false);
    return ack;
  }

  stop({ drainTimeoutMs = this.#limits.drainTimeoutMs } = {}) {
    if (this.#state === 'done') return Promise.resolve(this.#doneResult);
    if (this.#state === 'stopping' || this.#state === 'finishing') return this.#completion;
    if (this.#state !== 'recording') {
      return Promise.reject(streamError('speech_stream_closed', 'Speech stream нельзя завершить в текущем state'));
    }
    const timeout = positiveInteger(drainTimeoutMs, this.#limits.drainTimeoutMs, 'drainTimeoutMs');
    this.#state = 'stopping';
    this.#clearSessionTimers();
    this.#drainTimer = this.#setTimer(() => {
      void this.#fail(streamError('speech_stream_timeout', 'Stop drain speech stream истёк'));
    }, timeout);
    if (!this.#decodeInFlight) void this.#decode(true);
    return this.#completion;
  }

  async cancel() {
    if (this.#state === 'done') return false;
    if (this.#state === 'cancelled') {
      await this.#cleanupPromise;
      return false;
    }
    this.#state = 'cancelled';
    this.#clearTimer(this.#drainTimer);
    this.#clearSessionTimers();
    this.#decodeAbort?.abort();
    const cancelled = Object.assign(new Error('Распознавание отменено'), { name: 'AbortError' });
    this.#rejectCompletion(cancelled);
    await this.#terminateAndCleanup();
    return true;
  }

  get deathConfirmed() {
    return this.#deathConfirmed;
  }

  /** Разрешается только после фактического child close и безопасного удаления raw. */
  waitForDeath() {
    if (this.#deathConfirmed) return Promise.resolve(true);
    if (this.#cleanupPromise) {
      return this.#cleanupPromise.then(
        () => true,
        () => this.#watchControllerExit(),
      );
    }
    return this.#watchControllerExit();
  }

  snapshot() {
    return Object.freeze({
      state: this.#state,
      lastSeq: this.#lastSeq,
      prunedUntilMs: this.#prunedUntilMs,
      ...this.#resultPayload(this.#lastDecodedEndByte ? bytesToMs(this.#lastDecodedEndByte) : 0),
    });
  }
}

export function createSpeechStreamSession({
  pythonPath,
  env,
  options,
  filePath,
  process: processOptions = {},
  ...sessionOptions
}, deps = {}) {
  const createProcess = deps.createSpeechStreamProcess || createSpeechStreamProcess;
  const controller = createProcess({ pythonPath, env, options, ...processOptions }, deps.processDeps);
  try {
    return new SpeechStreamSession(
      { controller, filePath, ...sessionOptions },
      deps.sessionDeps,
    );
  } catch (error) {
    void controller.cancel().catch(() => {});
    throw error;
  }
}

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { SpeechRuntimeError } from './errors.ts';
import { buildWarmupArgv, readProcessIdentity, sameProcessIdentity } from './warmup.ts';
import type { WarmupDeps, WarmupIdentity } from './warmup.ts';

export const SPEECH_STREAM_PROTOCOL_VERSION = 1;
export const SPEECH_STREAM_AUDIO = Object.freeze({
  encoding: 'pcm_s16le',
  sampleRate: 16_000,
  channels: 1,
  frameSamples: 1_600,
});
export const STREAM_WORKER_PY = fileURLToPath(new URL('./stream-worker.py', import.meta.url));

// PCM-окно одного decode: границы в байтах файла плюс смещение звука.
export interface DecodeWindow {
  filePath: string;
  startByte: number;
  endByte: number;
  offsetMs: number;
  final?: boolean;
  signal?: AbortSignal | null;
}

// Как процесс закончился: код, сигнал и был ли выход ожидаемым.
export interface StreamExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  expected: boolean;
}

// Что умеет один session worker диктовки.
export interface StreamController {
  identity: WarmupIdentity | null;
  ready: Promise<unknown>;
  exit: Promise<StreamExit>;
  decode: (window: DecodeWindow) => Promise<Record<string, unknown>>;
  cancel: () => Promise<boolean>;
  isAlive: () => boolean;
}

// Сообщение protocol-линии воркера потока.
interface StreamMessage {
  type?: string;
  nonce?: string;
  protocolVersion?: number;
  requestId?: string;
  result?: Record<string, unknown>;
  message?: string;
  code?: string;
  audio?: {
    encoding?: string;
    sampleRate?: number;
    channels?: number;
    frameSamples?: number;
  };
}

export function buildSpeechStreamArgv({ workerPath = STREAM_WORKER_PY, nonce, options }: {
  workerPath?: string;
  nonce?: string;
  options: unknown;
}): string[] {
  return buildWarmupArgv({ workerPath, nonce, options });
}

function abortError(): Error {
  return Object.assign(new Error('Распознавание отменено'), { name: 'AbortError' });
}

function processError(message: StreamMessage | null, fallback = 'transcribe_failed'): SpeechRuntimeError {
  return new SpeechRuntimeError(
    message?.message || 'Session worker завершился с ошибкой',
    message?.code || fallback,
  );
}

function waitWithSignal<Value>(
  promise: Promise<Value>,
  signal: AbortSignal | null | undefined,
  onAbort: () => void,
): Promise<Value> {
  if (!signal) return promise;
  if (signal.aborted) {
    onAbort();
    return Promise.reject(abortError());
  }
  return new Promise<Value>((resolve, reject) => {
    const abort = () => {
      cleanup();
      onAbort();
      reject(abortError());
    };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

/**
 * Один неотсоединённый Python-процесс на диктовку. Он держит модель в памяти и
 * последовательно принимает decode-команды. Любой сигнал сверяется с полной
 * `/proc` identity, поэтому переиспользованный PID не может получить TERM/KILL.
 */
export function createSpeechStreamProcess({
  pythonPath,
  env,
  options,
  nonce = randomUUID(),
  workerPath = STREAM_WORKER_PY,
  readyTimeoutMs = 120_000,
  decodeTimeoutMs = 120_000,
  killGraceMs = 500,
}: {
  pythonPath: string;
  env?: NodeJS.ProcessEnv;
  options: unknown;
  nonce?: string;
  workerPath?: string;
  readyTimeoutMs?: number;
  decodeTimeoutMs?: number;
  killGraceMs?: number;
}, deps: WarmupDeps & { randomUUID?: () => string } = {}): StreamController {
  const spawnProcess = deps.spawn || spawn;
  const readIdentity = deps.readProcessIdentity || readProcessIdentity;
  const setTimer = deps.setTimeout
    || ((handler: () => void, ms: number) => setTimeout(handler, ms));
  const clearTimer = deps.clearTimeout
    || ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const createId = deps.randomUUID || randomUUID;
  const argv = buildSpeechStreamArgv({ workerPath, nonce, options });
  const child = spawnProcess(pythonPath, argv, {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: false,
  });
  child.once('error', () => {});
  let identity: WarmupIdentity | null = null;
  let identityFailure: SpeechRuntimeError | null = null;
  const pid = child.pid ?? 0;
  if (!Number.isInteger(pid) || pid <= 0) {
    identityFailure = new SpeechRuntimeError(
      'Не удалось получить PID speech stream process',
      'speech_unavailable',
    );
  } else {
    let observed: WarmupIdentity | null = null;
    try { observed = readIdentity(pid, { nonce }); } catch { /* fail-closed ниже */ }
    if (!observed?.starttime) {
      identityFailure = new SpeechRuntimeError(
        'Не удалось закрепить process identity speech stream process',
        'speech_unavailable',
      );
    } else {
      identity = Object.freeze({
        pid,
        starttime: observed.starttime,
        cmdline: Object.freeze([pythonPath, ...argv]),
        nonce,
      });
    }
  }

  let stdoutBuffer = '';
  let stderr = '';
  let closed = false;
  let closing = false;
  let request: {
    requestId: string;
    resolve: (value: Record<string, unknown>) => void;
    reject: (error: unknown) => void;
    timer?: unknown;
    signal?: AbortSignal | null;
    abort?: () => void;
  } | null = null;
  let cancelPromise: Promise<boolean> | null = null;
  let readySettled = false;
  let workerReady = false;
  let readyResolve: (value: unknown) => void = () => {};
  let readyReject: (error: unknown) => void = () => {};
  let exitResolve: (value: StreamExit) => void = () => {};
  const exit = new Promise<StreamExit>((resolve) => { exitResolve = resolve; });
  const ready = new Promise<unknown>((resolve, reject) => {
    readyResolve = (value: unknown) => {
      if (readySettled) return;
      readySettled = true;
      resolve(value);
    };
    readyReject = (error: unknown) => {
      if (readySettled) return;
      readySettled = true;
      reject(error);
    };
  });
  ready.catch(() => {});

  const clearRequest = () => {
    if (!request) return null;
    const pending = request;
    request = null;
    clearTimer(pending.timer);
    if (pending.abort) pending.signal?.removeEventListener('abort', pending.abort);
    return pending;
  };

  const rejectPending = (error: unknown) => {
    readyReject(error);
    clearRequest()?.reject(error);
  };

  const fatalProtocol = (message: string) => {
    const error = new SpeechRuntimeError(message, 'speech_stream_protocol');
    rejectPending(error);
    void cancel().catch(() => {});
  };

  const acceptMessage = (message: StreamMessage | null) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      fatalProtocol('Некорректный ответ speech stream worker');
      return;
    }
    if (message.type === 'ready') {
      if (
        workerReady
        || message.nonce !== nonce
        || message.protocolVersion !== SPEECH_STREAM_PROTOCOL_VERSION
        || message.audio?.encoding !== SPEECH_STREAM_AUDIO.encoding
        || message.audio?.sampleRate !== SPEECH_STREAM_AUDIO.sampleRate
        || message.audio?.channels !== SPEECH_STREAM_AUDIO.channels
        || message.audio?.frameSamples !== SPEECH_STREAM_AUDIO.frameSamples
      ) {
        fatalProtocol('Speech stream worker сообщил несовместимый протокол');
        return;
      }
      workerReady = true;
      readyResolve(message);
      return;
    }
    if (message.type === 'result') {
      if (!request || message.requestId !== request.requestId) {
        fatalProtocol('Speech stream worker нарушил порядок ответов');
        return;
      }
      clearRequest()?.resolve(message.result ?? {});
      return;
    }
    if (message.type === 'error') {
      const error = processError(message);
      if (request && message.requestId === request.requestId) {
        clearRequest()?.reject(error);
      } else {
        rejectPending(error);
        void cancel().catch(() => {});
      }
      return;
    }
    fatalProtocol('Speech stream worker прислал неизвестное сообщение');
  };

  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuffer += chunk.toString('utf8');
    let newline;
    while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      try {
        acceptMessage(JSON.parse(line));
      } catch {
        fatalProtocol('Speech stream worker прислал невалидный JSON');
      }
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk}`.slice(-4000); });
  child.once('error', (error: unknown) => {
    rejectPending(error);
    void cancel().catch(() => {});
  });
  child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
    closed = true;
    clearTimer(readyTimer);
    const failure = new Error(
      `Speech stream process завершился с кодом ${code}${signal ? ` (${signal})` : ''}: ${stderr}`,
    );
    if (!closing || !readySettled || request || code !== 0) rejectPending(failure);
    exitResolve(Object.freeze({ code, signal, expected: closing }));
  });

  const readyTimer = setTimer(() => {
    const error = new SpeechRuntimeError(
      'Speech stream process не успел загрузить модель',
      'speech_unavailable',
    );
    readyReject(error);
    void cancel().catch(() => {});
  }, readyTimeoutMs);
  readyTimer?.unref?.();
  ready.finally(() => clearTimer(readyTimer)).catch(() => {});

  if (identityFailure) {
    // Фабрика всё равно возвращает controller с exit barrier. Синхронный throw
    // потерял бы child до того, как runtime смог бы удержать slot/workDir.
    readyReject(identityFailure);
    void cancel().catch(() => {});
  }

  function verifiedSignal(signal: NodeJS.Signals): boolean {
    if (closed || !identity) return false;
    let actual: WarmupIdentity | null;
    try { actual = readIdentity(identity.pid, { nonce: identity.nonce }); } catch { return false; }
    if (!sameProcessIdentity(identity, actual)) return false;
    return child.kill?.(signal) ?? false;
  }

  function cancel(): Promise<boolean> {
    if (closed) return Promise.resolve(false);
    if (cancelPromise) return cancelPromise;
    closing = true;
    rejectPending(abortError());
    cancelPromise = (async () => {
      child.stdin?.once?.('error', () => {});
      child.stdin?.end();
      const termTimer = setTimer(() => verifiedSignal('SIGTERM'), killGraceMs);
      const killTimer = setTimer(() => verifiedSignal('SIGKILL'), killGraceMs * 2);
      termTimer?.unref?.();
      killTimer?.unref?.();
      let doneTimer: { unref?: () => void } | null = null;
      await Promise.race([
        exit,
        new Promise<void>((resolve) => {
          doneTimer = setTimer(resolve, killGraceMs * 3);
          doneTimer?.unref?.();
        }),
      ]);
      clearTimer(termTimer);
      clearTimer(killTimer);
      clearTimer(doneTimer);
      if (!closed) {
        throw new SpeechRuntimeError(
          'Не подтверждено завершение speech stream process после TERM/KILL',
          'speech_unavailable',
        );
      }
      return true;
    })();
    return cancelPromise;
  }

  async function decode({
    filePath, startByte, endByte, offsetMs, final = false, signal = null,
  }: DecodeWindow): Promise<Record<string, unknown>> {
    if (closed || closing) throw new SpeechRuntimeError('Speech stream process уже закрыт', 'speech_stream_closed');
    if (
      typeof filePath !== 'string'
      || !filePath
      || !Number.isInteger(startByte)
      || !Number.isInteger(endByte)
      || !Number.isInteger(offsetMs)
      || startByte < 0
      || endByte <= startByte
      || offsetMs < 0
      || startByte % 2 !== 0
      || endByte % 2 !== 0
    ) {
      throw new SpeechRuntimeError('Некорректное PCM window', 'speech_stream_protocol');
    }
    await waitWithSignal(ready, signal, () => { void cancel().catch(() => {}); });
    if (closed || closing) throw new SpeechRuntimeError('Speech stream process уже закрыт', 'speech_stream_closed');
    if (request) throw new SpeechRuntimeError('Decode уже выполняется', 'speech_stream_busy');
    const requestId = createId();
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const abort = () => {
        if (!request || request.requestId !== requestId) return;
        clearRequest()?.reject(abortError());
        void cancel().catch(() => {});
      };
      const timer = setTimer(() => {
        if (!request || request.requestId !== requestId) return;
        clearRequest()?.reject(new SpeechRuntimeError(
          'Decode speech stream превысил допустимое время',
          'speech_stream_timeout',
        ));
        void cancel().catch(() => {});
      }, decodeTimeoutMs);
      timer?.unref?.();
      request = { requestId, resolve, reject, timer, signal, abort };
      signal?.addEventListener('abort', abort, { once: true });
      const payload = {
        type: 'decode',
        requestId,
        filePath,
        startByte,
        endByte,
        offsetMs,
        final: final === true,
      };
      try {
        child.stdin?.write(`${JSON.stringify(payload)}\n`, (error: unknown) => {
          if (!error || !request || request.requestId !== requestId) return;
          clearRequest()?.reject(error);
          void cancel().catch(() => {});
        });
      } catch (error) {
        clearRequest()?.reject(error);
        void cancel().catch(() => {});
      }
    });
  }

  return Object.freeze({
    identity,
    ready,
    exit,
    decode,
    cancel,
    // `closing` означает только начатую отмену. Живость подтверждает исключительно
    // событие child `close`: до него runtime обязан держать slot/workDir в quarantine.
    isAlive: () => !closed,
  });
}

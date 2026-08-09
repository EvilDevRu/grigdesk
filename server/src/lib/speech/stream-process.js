import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { SpeechRuntimeError } from './errors.js';
import { buildWarmupArgv, readProcessIdentity, sameProcessIdentity } from './warmup.js';

export const SPEECH_STREAM_PROTOCOL_VERSION = 1;
export const SPEECH_STREAM_AUDIO = Object.freeze({
  encoding: 'pcm_s16le',
  sampleRate: 16_000,
  channels: 1,
  frameSamples: 1_600,
});
export const STREAM_WORKER_PY = fileURLToPath(new URL('./stream-worker.py', import.meta.url));

export function buildSpeechStreamArgv({ workerPath = STREAM_WORKER_PY, nonce, options }) {
  return buildWarmupArgv({ workerPath, nonce, options });
}

function abortError() {
  return Object.assign(new Error('Распознавание отменено'), { name: 'AbortError' });
}

function processError(message, fallback = 'transcribe_failed') {
  return new SpeechRuntimeError(
    message?.message || 'Session worker завершился с ошибкой',
    message?.code || fallback,
  );
}

function waitWithSignal(promise, signal, onAbort) {
  if (!signal) return promise;
  if (signal.aborted) {
    onAbort();
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
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
}, deps = {}) {
  const spawnProcess = deps.spawn || spawn;
  const readIdentity = deps.readProcessIdentity || readProcessIdentity;
  const setTimer = deps.setTimeout || setTimeout;
  const clearTimer = deps.clearTimeout || clearTimeout;
  const createId = deps.randomUUID || randomUUID;
  const argv = buildSpeechStreamArgv({ workerPath, nonce, options });
  const child = spawnProcess(pythonPath, argv, {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: false,
  });
  child.once('error', () => {});
  let identity = null;
  let identityFailure = null;
  if (!Number.isInteger(child.pid) || child.pid <= 0) {
    identityFailure = new SpeechRuntimeError(
      'Не удалось получить PID speech stream process',
      'speech_unavailable',
    );
  } else {
    let observed = null;
    try { observed = readIdentity(child.pid, { nonce }); } catch { /* fail-closed ниже */ }
    if (!observed?.starttime) {
      identityFailure = new SpeechRuntimeError(
        'Не удалось закрепить process identity speech stream process',
        'speech_unavailable',
      );
    } else {
      identity = Object.freeze({
        pid: child.pid,
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
  let request = null;
  let cancelPromise = null;
  let readySettled = false;
  let workerReady = false;
  let readyResolve;
  let readyReject;
  let exitResolve;
  const exit = new Promise((resolve) => { exitResolve = resolve; });
  const ready = new Promise((resolve, reject) => {
    readyResolve = (value) => {
      if (readySettled) return;
      readySettled = true;
      resolve(value);
    };
    readyReject = (error) => {
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
    pending.signal?.removeEventListener('abort', pending.abort);
    return pending;
  };

  const rejectPending = (error) => {
    readyReject(error);
    clearRequest()?.reject(error);
  };

  const fatalProtocol = (message) => {
    const error = new SpeechRuntimeError(message, 'speech_stream_protocol');
    rejectPending(error);
    void cancel().catch(() => {});
  };

  const acceptMessage = (message) => {
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
      const pending = clearRequest();
      pending.resolve(message.result);
      return;
    }
    if (message.type === 'error') {
      const error = processError(message);
      if (request && message.requestId === request.requestId) {
        clearRequest().reject(error);
      } else {
        rejectPending(error);
        void cancel().catch(() => {});
      }
      return;
    }
    fatalProtocol('Speech stream worker прислал неизвестное сообщение');
  };

  child.stdout?.on('data', (chunk) => {
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
  child.stderr?.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
  child.once('error', (error) => {
    rejectPending(error);
    void cancel().catch(() => {});
  });
  child.once('close', (code, signal) => {
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

  function verifiedSignal(signal) {
    if (closed || !identity) return false;
    let actual;
    try { actual = readIdentity(identity.pid, { nonce: identity.nonce }); } catch { return false; }
    if (!sameProcessIdentity(identity, actual)) return false;
    return child.kill?.(signal) ?? false;
  }

  function cancel() {
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
      let doneTimer;
      await Promise.race([
        exit,
        new Promise((resolve) => {
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

  async function decode({ filePath, startByte, endByte, offsetMs, final = false, signal = null }) {
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
    return new Promise((resolve, reject) => {
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
        child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
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

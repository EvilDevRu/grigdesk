import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { SpeechRuntimeError } from './errors.js';
import { normalizeSpeechOptions } from './options.js';
import { speechModel } from './catalog.js';

export const WARMUP_WORKER_PY = fileURLToPath(new URL('./warmup-worker.py', import.meta.url));

export function speechOptionsRevision(options, explicitRevision = null) {
  if (explicitRevision != null) return explicitRevision;
  const normalized = normalizeSpeechOptions(options, 'dictation');
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 16);
}

export function buildWarmupArgv({ workerPath = WARMUP_WORKER_PY, nonce, options }) {
  if (!nonce) throw new TypeError('Warmup process требует nonce');
  const speech = normalizeSpeechOptions(options, 'dictation');
  const catalogModel = speechModel(speech.model);
  if (!catalogModel) throw new TypeError(`Модель ${speech.model} отсутствует в catalog`);
  const argv = [
    workerPath,
    '--nonce', nonce,
    '--model', speech.model,
    '--model-repo', catalogModel.repo,
    '--model-revision', catalogModel.revision,
  ];
  for (const alias of catalogModel.aliases) argv.push('--model-alias', alias);
  argv.push(
    '--lang', speech.language,
    '--device', speech.device,
    '--compute-type', speech.computeType,
    '--beam-size', String(speech.beamSize),
    '--vad-silence-ms', String(speech.vadSilenceMs),
  );
  if (speech.hotwords) argv.push('--hotwords', speech.hotwords);
  if (!speech.conditionOnPreviousText) argv.push('--no-condition-previous');
  return argv;
}

function procStarttime(stat) {
  const closeParen = stat.lastIndexOf(')');
  if (closeParen < 0) return null;
  const fieldsAfterCommand = stat.slice(closeParen + 1).trim().split(/\s+/);
  // После comm идут поля с №3; starttime — поле №22, то есть индекс 19.
  return fieldsAfterCommand[19] || null;
}

export function readProcessIdentity(pid, { nonce = null, read = readFileSync } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const stat = read(`/proc/${pid}/stat`, 'utf8');
    const cmdline = read(`/proc/${pid}/cmdline`)
      .toString('utf8')
      .split('\0')
      .filter(Boolean);
    const starttime = procStarttime(stat);
    if (!starttime || cmdline.length === 0) return null;
    return Object.freeze({ pid, starttime, cmdline: Object.freeze(cmdline), nonce });
  } catch {
    return null;
  }
}

export function sameProcessIdentity(expected, actual) {
  return Boolean(
    expected
    && actual
    && expected.pid === actual.pid
    && expected.starttime === actual.starttime
    && typeof expected.nonce === 'string'
    && expected.nonce.length > 0
    && actual.cmdline.includes(expected.nonce)
    && expected.cmdline.length === actual.cmdline.length
    && expected.cmdline.every((value, index) => value === actual.cmdline[index]),
  );
}

function wireError(message) {
  const error = new SpeechRuntimeError(
    message.message || 'Warmup process завершился с ошибкой',
    message.code || 'transcribe_failed',
  );
  return error;
}

/**
 * Одноразовый newline-JSON процесс: грузит модель до upload и принимает ровно один файл.
 * Процесс не detached; EOF, timeout и shutdown завершают его с проверкой полной identity.
 */
export function createWarmupProcess({
  pythonPath,
  env,
  options,
  nonce = randomUUID(),
  workerPath = WARMUP_WORKER_PY,
  killGraceMs = 500,
}, deps = {}) {
  const spawnProcess = deps.spawn || spawn;
  const readIdentity = deps.readProcessIdentity || readProcessIdentity;
  const setTimer = deps.setTimeout || setTimeout;
  const clearTimer = deps.clearTimeout || clearTimeout;
  const argv = buildWarmupArgv({ workerPath, nonce, options });
  const child = spawnProcess(pythonPath, argv, {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: false,
  });
  // При ENOENT Node может вернуть ChildProcess без pid и лишь затем emit('error').
  // Listener нужен до ранних проверок, иначе ошибка станет необработанным событием.
  child.once('error', () => {});
  if (!Number.isInteger(child.pid) || child.pid <= 0) {
    throw new Error('Не удалось получить PID warmup process');
  }
  const observed = readIdentity(child.pid, { nonce });
  if (!observed?.starttime) {
    // stdin — точный дескриптор порождённого нами процесса, поэтому
    // cooperative EOF безопасен. child.kill() здесь запрещён: пока
    // нет полной identity, это был бы сигнал по raw PID.
    child.stdin?.once?.('error', () => {});
    child.stdin?.end();
    throw new Error('Не удалось закрепить process identity warmup process');
  }
  const identity = Object.freeze({
    pid: child.pid,
    starttime: observed.starttime,
    cmdline: Object.freeze([pythonPath, ...argv]),
    nonce,
  });

  let stdoutBuffer = '';
  let stderr = '';
  let closed = false;
  let used = false;
  let request = null;
  let cancelPromise = null;
  let readySettled = false;
  let readyResolve;
  let readyReject;
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
  // Spawn может умереть до upload; rejection хранится в controller, а не становится unhandled.
  ready.catch(() => {});

  const rejectPending = (error) => {
    readyReject(error);
    if (request) {
      const pending = request;
      request = null;
      pending.cleanup?.();
      pending.reject(error);
    }
  };

  const acceptMessage = (message) => {
    if (message.type === 'ready' && message.nonce === nonce) {
      readyResolve(message);
      return;
    }
    if (message.type === 'result' && request && message.requestId === request.requestId) {
      const pending = request;
      request = null;
      pending.cleanup?.();
      pending.resolve(message.result);
      return;
    }
    if (message.type === 'error') rejectPending(wireError(message));
  };

  child.stdout?.on('data', (chunk) => {
    stdoutBuffer += chunk.toString('utf8');
    let newline;
    while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      try { acceptMessage(JSON.parse(line)); } catch { /* следующий protocol line ещё может быть валиден */ }
    }
  });
  child.stderr?.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
  child.once('error', (error) => rejectPending(error));
  child.once('close', (code) => {
    closed = true;
    if (!readySettled || request || code !== 0) {
      rejectPending(new Error(`Warmup process завершился с кодом ${code}: ${stderr}`));
    }
  });

  function verifiedSignal(signal) {
    if (closed) return false;
    const actual = readIdentity(identity.pid, { nonce: identity.nonce });
    if (!sameProcessIdentity(identity, actual)) return false;
    return child.kill?.(signal) ?? false;
  }

  function cancel() {
    if (closed) return Promise.resolve(false);
    if (cancelPromise) return cancelPromise;
    cancelPromise = (async () => {
      child.stdin?.end();
      const termTimer = setTimer(() => verifiedSignal('SIGTERM'), killGraceMs);
      const killTimer = setTimer(() => verifiedSignal('SIGKILL'), killGraceMs * 2);
      termTimer?.unref?.();
      killTimer?.unref?.();
      let doneTimer;
      await new Promise((resolve) => {
        if (closed) resolve();
        else child.once('close', resolve);
        doneTimer = setTimer(resolve, killGraceMs * 3);
        doneTimer?.unref?.();
      });
      clearTimer(termTimer);
      clearTimer(killTimer);
      clearTimer(doneTimer);
      return true;
    })();
    return cancelPromise;
  }

  async function transcribe({ filePath, progressFile = null, signal = null }) {
    if (used) throw new Error('Warmup process уже использован');
    used = true;
    const aborted = () => Object.assign(new Error('Распознавание отменено'), { name: 'AbortError' });
    if (signal?.aborted) {
      void cancel();
      throw aborted();
    }
    if (signal) {
      await new Promise((resolve, reject) => {
        const onAbort = () => {
          cleanup();
          reject(aborted());
          void cancel();
        };
        const cleanup = () => signal.removeEventListener('abort', onAbort);
        signal.addEventListener('abort', onAbort, { once: true });
        ready.then(
          (value) => {
            cleanup();
            resolve(value);
          },
          (error) => {
            cleanup();
            reject(error);
          },
        );
      });
    } else {
      await ready;
    }
    if (signal?.aborted) {
      void cancel();
      throw aborted();
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      request = { requestId, resolve, reject };
      const abort = () => {
        if (!request || request.requestId !== requestId) return;
        const pending = request;
        request = null;
        pending.cleanup?.();
        reject(aborted());
        void cancel();
      };
      signal?.addEventListener('abort', abort, { once: true });
      request.cleanup = () => signal?.removeEventListener('abort', abort);
      child.stdin.write(`${JSON.stringify({
        type: 'transcribe',
        requestId,
        filePath,
        progressFile,
      })}\n`, (error) => {
        if (!error || !request || request.requestId !== requestId) return;
        const pending = request;
        request = null;
        pending.cleanup?.();
        reject(error);
        void cancel();
      });
    });
  }

  return Object.freeze({
    identity,
    ready,
    transcribe,
    cancel,
    isAlive: () => !closed,
  });
}

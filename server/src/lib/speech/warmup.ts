import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { SpeechRuntimeError } from './errors.ts';
import { normalizeSpeechOptions } from './options.ts';
import { speechModel } from './catalog.ts';
import { decodeSpeechTranscript } from './transport.ts';

export const WARMUP_WORKER_PY = fileURLToPath(new URL('./warmup-worker.py', import.meta.url));

// Полная identity процесса прогрева: PID+starttime+argv+nonce. Сигнал уходит только при
// совпадении всех четырёх — переиспользованный номер чужого процесса TERM не получит.
export interface WarmupIdentity {
  pid: number;
  starttime: string;
  cmdline: readonly string[];
  nonce: string | null;
}

// Что умеет один прогретый процесс: дождаться готовности, принять файл и умереть.
export interface WarmupController {
  identity: WarmupIdentity;
  ready: Promise<unknown>;
  transcribe: (input: {
    filePath: string;
    progressFile?: string | null;
    wordTimestamps?: boolean;
    signal?: AbortSignal | null;
  }) => Promise<Record<string, unknown>>;
  cancel: () => Promise<boolean>;
  isAlive: () => boolean;
}

// Подменяемые в тестах запуск процесса и таймеры.
export interface WarmupDeps {
  spawn?: typeof spawn;
  readProcessIdentity?: typeof readProcessIdentity;
  setTimeout?: (handler: () => void, ms: number) => { unref?: () => void };
  clearTimeout?: (timer: unknown) => void;
}

// Сообщение protocol-линии воркера.
interface WireMessage {
  type?: string;
  nonce?: string;
  requestId?: string;
  result?: unknown;
  message?: string;
  code?: string;
}

export function speechOptionsRevision(
  options: unknown,
  explicitRevision: string | null = null,
): string {
  if (explicitRevision != null) return explicitRevision;
  const normalized = normalizeSpeechOptions(options, 'dictation');
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 16);
}

export function buildWarmupArgv({ workerPath = WARMUP_WORKER_PY, nonce, options }: {
  workerPath?: string;
  nonce?: string;
  options: unknown;
}): string[] {
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

function procStarttime(stat: string): string | null {
  const closeParen = stat.lastIndexOf(')');
  if (closeParen < 0) return null;
  const fieldsAfterCommand = stat.slice(closeParen + 1).trim().split(/\s+/);
  // После comm идут поля с №3; starttime — поле №22, то есть индекс 19.
  return fieldsAfterCommand[19] || null;
}

export function readProcessIdentity(pid: number, { nonce = null, read = readFileSync }: {
  nonce?: string | null;
  read?: typeof readFileSync;
} = {}): WarmupIdentity | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const stat = String(read(`/proc/${pid}/stat`, 'utf8'));
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

export function sameProcessIdentity(
  expected: WarmupIdentity | null | undefined,
  actual: WarmupIdentity | null | undefined,
): boolean {
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

function wireError(message: WireMessage): SpeechRuntimeError {
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
}: {
  pythonPath: string;
  env?: NodeJS.ProcessEnv;
  options: unknown;
  nonce?: string;
  workerPath?: string;
  killGraceMs?: number;
}, deps: WarmupDeps = {}): WarmupController {
  const spawnProcess = deps.spawn || spawn;
  const readIdentity = deps.readProcessIdentity || readProcessIdentity;
  const setTimer = deps.setTimeout
    || ((handler: () => void, ms: number) => setTimeout(handler, ms));
  const clearTimer = deps.clearTimeout
    || ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const argv = buildWarmupArgv({ workerPath, nonce, options });
  const child = spawnProcess(pythonPath, argv, {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: false,
  });
  // При ENOENT Node может вернуть ChildProcess без pid и лишь затем emit('error').
  // Listener нужен до ранних проверок, иначе ошибка станет необработанным событием.
  child.once('error', () => {});
  const pid = child.pid ?? 0;
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error('Не удалось получить PID warmup process');
  }
  const observed = readIdentity(pid, { nonce });
  if (!observed?.starttime) {
    // stdin — точный дескриптор порождённого нами процесса, поэтому
    // cooperative EOF безопасен. child.kill() здесь запрещён: пока
    // нет полной identity, это был бы сигнал по raw PID.
    child.stdin?.once?.('error', () => {});
    child.stdin?.end();
    throw new Error('Не удалось закрепить process identity warmup process');
  }
  const identity: WarmupIdentity = Object.freeze({
    pid,
    starttime: observed.starttime,
    cmdline: Object.freeze([pythonPath, ...argv]),
    nonce,
  });

  let stdoutBuffer = '';
  let stderr = '';
  let closed = false;
  let used = false;
  let request: {
    requestId: string;
    resolve: (value: Record<string, unknown>) => void;
    reject: (error: unknown) => void;
    cleanup?: () => void;
    timer?: unknown;
    wordTimestamps: boolean;
  } | null = null;
  let cancelPromise: Promise<boolean> | null = null;
  let readySettled = false;
  let readyResolve: (value: unknown) => void = () => {};
  let readyReject: (error: unknown) => void = () => {};
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
  // Spawn может умереть до upload; rejection хранится в controller, а не становится unhandled.
  ready.catch(() => {});

  const rejectPending = (error: unknown) => {
    readyReject(error);
    if (request) {
      const pending = request;
      request = null;
      pending.cleanup?.();
      pending.reject(error);
    }
  };

  const acceptMessage = (message: WireMessage) => {
    if (message.type === 'ready' && message.nonce === nonce) {
      readyResolve(message);
      return;
    }
    if (message.type === 'result' && request && message.requestId === request.requestId) {
      const pending = request;
      request = null;
      pending.cleanup?.();
      try {
        pending.resolve(decodeSpeechTranscript(message.result, {
          wordTimestampsRequested: pending.wordTimestamps,
        }));
      } catch (error) {
        pending.reject(error);
      }
      return;
    }
    if (message.type === 'error') rejectPending(wireError(message));
  };

  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuffer += chunk.toString('utf8');
    let newline;
    while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      try { acceptMessage(JSON.parse(line)); } catch { /* следующий protocol line ещё может быть валиден */ }
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk}`.slice(-4000); });
  child.once('error', (error: unknown) => rejectPending(error));
  child.once('close', (code: number | null) => {
    closed = true;
    if (!readySettled || request || code !== 0) {
      rejectPending(new Error(`Warmup process завершился с кодом ${code}: ${stderr}`));
    }
  });

  function verifiedSignal(signal: NodeJS.Signals): boolean {
    if (closed) return false;
    const actual = readIdentity(identity.pid, { nonce: identity.nonce });
    if (!sameProcessIdentity(identity, actual)) return false;
    return child.kill?.(signal) ?? false;
  }

  function cancel(): Promise<boolean> {
    if (closed) return Promise.resolve(false);
    if (cancelPromise) return cancelPromise;
    cancelPromise = (async () => {
      child.stdin?.end();
      const termTimer = setTimer(() => verifiedSignal('SIGTERM'), killGraceMs);
      const killTimer = setTimer(() => verifiedSignal('SIGKILL'), killGraceMs * 2);
      termTimer?.unref?.();
      killTimer?.unref?.();
      let doneTimer: { unref?: () => void } | null = null;
      await new Promise<void>((resolve) => {
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

  async function transcribe({
    filePath,
    progressFile = null,
    wordTimestamps = false,
    signal = null,
  }: {
    filePath: string;
    progressFile?: string | null;
    wordTimestamps?: boolean;
    signal?: AbortSignal | null;
  }): Promise<Record<string, unknown>> {
    if (used) throw new Error('Warmup process уже использован');
    used = true;
    const aborted = () => Object.assign(new Error('Распознавание отменено'), { name: 'AbortError' });
    if (signal?.aborted) {
      void cancel();
      throw aborted();
    }
    if (signal) {
      await new Promise<unknown>((resolve, reject) => {
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
    if (typeof wordTimestamps !== 'boolean') {
      throw new TypeError('wordTimestamps warmup-запроса должен быть boolean');
    }
    const requestId = randomUUID();
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      request = { requestId, resolve, reject, wordTimestamps };
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
      child.stdin?.write(`${JSON.stringify({
        type: 'transcribe',
        requestId,
        filePath,
        progressFile,
        wordTimestamps,
      })}\n`, (error: unknown) => {
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

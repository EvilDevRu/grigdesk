import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

import { sha256File } from '../../../../shared/node/hash.ts';
import hostContract from '../../../deepseek-host-contract.json' with { type: 'json' };
import {
  assertDeepSeekHostCompatibility,
  decodeDeepSeekRuntimeInfo,
  type DeepSeekRuntimeInfo,
} from '../../../../shared/chat/deepSeekBinary.ts';

export interface BinaryProbeOptions {
  timeoutMs?: number;
  maxBuffer?: number;
  hostContract?: unknown;
}

const exec = promisify(execFile);
const installCommand = 'npm --prefix deepseek run install:binary';

export interface DeepSeekBinaryFile {
  signature: string;
  sha256: string;
}

interface CachedBinary {
  info: DeepSeekRuntimeInfo;
  file: DeepSeekBinaryFile;
}

const metadataCache = new Map<string, { signature: string; pending: Promise<CachedBinary> }>();

function failure(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function unsupported(): Error & { code: string } {
  return failure('deepseek_binary_unsupported',
    `Нужна автономная поставка DeepSeek для GrigDesk: ${installCommand}`);
}

/**
 * Выбор бинарника абсолютный; имя dsh никогда не запускает поиск в PATH.
 * Ошибка не включает недоверенное значение пути или сырой вывод процесса.
 */
function assertBinaryPath(binary: string): void {
  if (!path.isAbsolute(binary) || binary.includes('\0')) {
    throw unsupported();
  }
}

/**
 * Metadata не требует HOME, кэша и provider credentials, поэтому список минимален.
 * Пустой coverage подавляет автоматическое наследование этого input в child_process.
 */
function probeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_V8_COVERAGE: '' };

  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR']) {
    if (process.env[key]) {
      env[key] = process.env[key];
    }
  }

  return env;
}

/**
 * Формат и контракт проверяет установленный host, без ограничения upstream или ABI сервера.
 * Raw JSON, stderr и значения полей не попадают в публичную диагностику.
 */
function decodeReply(stdout: string, requiredHost: unknown = hostContract): DeepSeekRuntimeInfo {
  let value: unknown;

  try {
    value = JSON.parse(stdout);
  } catch {
    throw failure('deepseek_binary_metadata_invalid', 'Описание бинарника DeepSeek не является JSON');
  }

  if (value && typeof value === 'object'
    && ('format' in value && value.format !== 1 || 'hostContract' in value && value.hostContract !== 1)) {
    throw unsupported();
  }

  let info: DeepSeekRuntimeInfo;

  try {
    info = decodeDeepSeekRuntimeInfo(value);
  } catch {
    throw failure('deepseek_binary_metadata_invalid', 'Описание бинарника DeepSeek повреждено');
  }

  try {
    assertDeepSeekHostCompatibility(info, requiredHost);

    if (info.platform !== process.platform || info.arch !== process.arch) {
      throw new Error('Несовместимая платформа');
    }
  } catch {
    throw failure('deepseek_binary_incompatible', 'Поставка DeepSeek несовместима с установленным GrigDesk');
  }

  return info;
}

/**
 * Отдельные безопасные коды различают отсутствие, права, timeout и превышение вывода.
 * Неуспешная CLI-команда означает неподдержанный бинарник, а не установленный Harness.
 */
function probeFailure(error: unknown): Error & { code: string } {
  const value = error as { code?: unknown; killed?: boolean };
  const code = typeof value.code === 'string' ? value.code : '';

  if (code.startsWith('deepseek_')) {
    return error as Error & { code: string };
  }

  if (code === 'ENOENT') {
    return failure('deepseek_binary_missing', 'Бинарник DeepSeek отсутствует');
  }

  if (['EACCES', 'EPERM', 'EISDIR'].includes(code)) {
    return failure('deepseek_binary_not_executable', 'Бинарник DeepSeek недоступен для запуска');
  }

  if (['ERR_CHILD_PROCESS_STDIO_MAXBUFFER', 'ENOBUFS'].includes(code)) {
    return failure('deepseek_binary_output_limit', 'Описание DeepSeek превысило предел вывода');
  }

  if (code === 'ETIMEDOUT' || value.killed) {
    return failure('deepseek_binary_timeout', 'Истекло время чтения описания DeepSeek');
  }

  return unsupported();
}

/**
 * Асинхронная проба вызывает только metadata argv без runtime prefix и без распаковки.
 * Таймаут принудительно завершает свой процесс; execFile ждёт закрытия его stdio.
 */
export async function probeDeepSeekBinary(
  binary: string,
  options: BinaryProbeOptions = {},
): Promise<DeepSeekRuntimeInfo> {
  assertBinaryPath(binary);

  try {
    if (!(await fsp.stat(binary)).isFile()) {
      throw failure('deepseek_binary_not_executable', 'Бинарник DeepSeek не является обычным файлом');
    }

    await fsp.access(binary, fs.constants.X_OK);

    const { stdout } = await exec(binary, ['--runtime-info', '--json'], {
      encoding: 'utf8',
      timeout: options.timeoutMs ?? 10000,
      maxBuffer: options.maxBuffer ?? 65536,
      killSignal: 'SIGKILL',
      env: probeEnvironment(),
    });

    return decodeReply(stdout, options.hostContract);
  } catch (error) {
    throw probeFailure(error);
  }
}

/**
 * Переходный sync caller сохраняет тот же metadata-контракт, env и безопасные ошибки.
 * Серверные пути используют async вариант; sync callers будут удалены отдельной карточкой.
 */
export function probeDeepSeekBinarySync(binary: string): DeepSeekRuntimeInfo {
  assertBinaryPath(binary);

  try {
    if (!fs.statSync(binary).isFile()) {
      throw failure('deepseek_binary_not_executable', 'Бинарник DeepSeek не является обычным файлом');
    }

    fs.accessSync(binary, fs.constants.X_OK);

    return decodeReply(execFileSync(binary, ['--runtime-info', '--json'], {
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 65536,
      killSignal: 'SIGKILL',
      env: probeEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
  } catch (error) {
    throw probeFailure(error);
  }
}

/**
 * Сигнатура включает сам symlink, его фактическую цель и bigint атрибуты executable.
 * Смена файла, mode, ctime или target не наследует metadata прежней успешной поставки.
 */
async function binarySignature(binary: string): Promise<string> {
  const link = await fsp.lstat(binary, { bigint: true });
  const target = await fsp.realpath(binary);
  const file = await fsp.stat(target, { bigint: true });
  const fields = ['dev', 'ino', 'size', 'mode', 'mtimeNs', 'ctimeNs', 'uid', 'gid'] as const;
  const values = (stat: typeof file) => fields.map((field) => stat[field].toString());

  return JSON.stringify([target, values(link), values(file)]);
}

/**
 * SHA читается потоком только для нового файлового отпечатка; metadata probe общий.
 * Изменение во время hash/probe даёт отказ текущей попытке и не публикует stale cache.
 */
async function loadBinary(binary: string, signature: string): Promise<CachedBinary> {
  const sha256 = await sha256File(binary);
  const info = await probeDeepSeekBinary(binary);

  if (await binarySignature(binary) !== signature) {
    throw failure('deepseek_binary_changed', 'Бинарник DeepSeek изменился во время проверки');
  }

  return {
    info,
    file: Object.freeze({ signature, sha256 }),
  };
}

/**
 * Concurrent callers одного файлового отпечатка делят один SHA и один metadata процесс.
 * Ошибка удаляет только свой pending entry и не возвращает прежнюю успешную identity.
 */
async function cachedBinary(binary: string): Promise<CachedBinary> {
  assertBinaryPath(binary);

  try {
    const signature = await binarySignature(binary);
    const previous = metadataCache.get(binary);

    if (previous?.signature === signature) {
      return await previous.pending;
    }

    const entry = { signature, pending: loadBinary(binary, signature) };

    metadataCache.set(binary, entry);
    void entry.pending.catch(() => {
      if (metadataCache.get(binary) === entry) {
        metadataCache.delete(binary);
      }
    });

    return await entry.pending;
  } catch (error) {
    throw probeFailure(error);
  }
}

/**
 * Отмена завершает только ожидание клиента, а shared SHA/probe остаётся ограничен timeout.
 * Оба исхода underlying promise наблюдаются, listener снимается без unhandled rejection.
 */
function waitForMetadata(pending: Promise<CachedBinary>, signal?: AbortSignal): Promise<CachedBinary> {
  if (!signal) {
    return pending;
  }

  signal.throwIfAborted();

  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);

    signal.addEventListener('abort', abort, { once: true });
    void pending.then((value) => {
      signal.removeEventListener('abort', abort);
      resolve(value);
    }, (error) => {
      signal.removeEventListener('abort', abort);
      reject(error);
    });

    if (signal.aborted) {
      abort();
    }
  });
}

/**
 * Async resolver делит метаданные по файловому отпечатку, сохраняя личный signal caller.
 * Отменённый клиент не отнимает результат у других и не отменяет будущий cache hit.
 */
export async function probeDeepSeekBinaryCached(
  binary: string,
  signal?: AbortSignal,
): Promise<CachedBinary> {
  signal?.throwIfAborted();

  return waitForMetadata(cachedBinary(binary), signal);
}

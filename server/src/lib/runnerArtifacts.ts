// Ограниченное чтение артефактов завершённого запуска для диагностических DTO.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

import { translate } from '../../../shared/i18n/catalogs.ts';

import {
  cleanRunnerFailureMessage,
  inspectRunnerStderr,
  RUNNER_FAILURE_READERS,
  runnerFailureDetail,
} from './runnerFailure.ts';
import type { RunnerFailure } from './runnerFailure.ts';

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const MAX_TAIL_BYTES = 256 * 1024;

/**
 * Каждый дочерний каталог открывается относительно удерживаемого родителя.
 * Подмена пути ссылкой не позволяет карточке читать файлы за пределами run-каталога.
 */
export async function openRunDirectory(root: string, parts: string[]): Promise<FileHandle> {
  let directory = await open(root, DIRECTORY_FLAGS);

  try {
    for (const part of parts) {
      const child = await open(`/proc/self/fd/${directory.fd}/${part}`, DIRECTORY_FLAGS);

      await directory.close();
      directory = child;
    }

    return directory;
  } catch (error) {
    await directory.close();

    throw error;
  }
}

/**
 * Метаданные читаются целиком, журнал — только с конца. Не принимаем ссылку, FIFO,
 * hardlink или файл, изменившийся во время чтения; крупная первая строка хвоста отбрасывается.
 */
export async function readRunFile(directory: FileHandle, name: string, tail = false): Promise<string> {
  const file = await open(`/proc/self/fd/${directory.fd}/${name}`, FILE_FLAGS);

  try {
    const before = await file.stat();
    const limit = tail ? MAX_TAIL_BYTES : 64 * 1024;

    if (!before.isFile() || before.nlink !== 1 || (!tail && before.size > limit)) {
      throw new Error('unsupported run file');
    }

    const start = Math.max(0, before.size - limit);
    const bytes = Buffer.alloc(Math.min(before.size, limit));
    const { bytesRead } = await file.read(bytes, 0, bytes.length, start);
    const after = await file.stat();

    if (bytesRead !== bytes.length || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error('unstable run file');
    }

    const text = bytes.toString('utf8');

    if (start === 0) {
      return text;
    }

    const firstNewline = text.indexOf('\n');

    return firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
  } finally {
    await file.close();
  }
}

/**
 * Все читающие карточки используют одну цепочку: mirror, протокол исполнителя, stderr.
 * При отсутствии доказанной причины возвращаем честную диагностику с кодом завершения.
 */
export async function readRunnerFailure(
  directory: FileHandle,
  meta: Record<string, string | undefined>,
): Promise<RunnerFailure> {
  const mirrored = cleanRunnerFailureMessage(meta.FAILURE_MESSAGE || '');

  if (meta.FAILURE_CODE && mirrored) {
    return { code: meta.FAILURE_CODE, message: mirrored };
  }

  const runner = meta.RUNNER || '';
  const reader = Object.hasOwn(RUNNER_FAILURE_READERS, runner) ? RUNNER_FAILURE_READERS[runner] : null;
  let available = false;

  if (reader) {
    try {
      const raw = await readRunFile(directory, reader.file, true);

      available = true;

      const failure = reader.inspect(raw);

      if (failure?.message) {
        return failure;
      }

      if (reader.file === 'stderr.log') {
        const diagnostic = inspectRunnerStderr(raw);

        if (diagnostic) {
          return diagnostic;
        }
      }
    } catch { /* Недоступный основной журнал не скрывает отдельную диагностику CLI. */ }
  }

  if (reader?.file !== 'stderr.log') {
    try {
      const raw = await readRunFile(directory, 'stderr.log', true);

      available = true;

      const diagnostic = inspectRunnerStderr(raw);

      if (diagnostic) {
        return diagnostic;
      }
    } catch { /* Ссылка, исчезнувший или повреждённый файл не становится причиной отказа. */ }
  }

  const knownCodes: Record<string, string> = {
    limited: 'usage_limit',
    denied: 'permission_denied',
    context_overflow: 'context_overflow',
  };
  const result = meta.RESULT_CLASS || '';
  const knownCode = Object.hasOwn(knownCodes, result) ? knownCodes[result] : null;

  if (knownCode) {
    return { code: knownCode, message: runnerFailureDetail({ code: knownCode, message: '' }) };
  }

  return {
    code: 'diagnostic_missing',
    message: translate(available ? 'core.runnerExitReasonMissing' : 'core.runnerDiagnosticUnavailable', {
      code: meta.RC || '',
    }),
  };
}


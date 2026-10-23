// Диагностическое дополнение остановки: читаем только exact завершившийся run.
// Текст ошибки не изменяет курсор, вердикт, разрешение повтора или арбитраж.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

import { parsePipeline } from './pipelineParse.ts';
import {
  cleanRunnerFailureMessage,
  inspectCodexFailure,
  inspectGlmFactoryFailure,
  runnerFailureDetail,
} from './runnerFailure.ts';
import type { RunnerFailure } from './runnerFailure.ts';
import type { StallEvent, StallInfo } from './stall.ts';

interface RunnerStallInput {
  stateDir: string;
  task: string | number;
  registry: Record<string, string | undefined>;
  timeline: StallEvent[];
  stall: StallInfo | null;
  attempt?: string;
}

interface RunFailure {
  failure: RunnerFailure;
  model: string;
}

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const MAX_TAIL_BYTES = 256 * 1024;

/**
 * Каждый дочерний каталог открывается относительно удерживаемого родителя.
 * Подмена пути ссылкой не позволяет карточке читать файлы за пределами run-каталога.
 */
async function openRunDirectory(root: string, parts: string[]): Promise<FileHandle> {
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
async function readRunFile(directory: FileHandle, name: string, tail = false): Promise<string> {
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

    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    await file.close();
  }
}

// Раннеры с доказанным разбором терминального отказа в retained-потоке. Остальные
// остановки сохраняют прежнюю карточку: чужой формат не угадывается.
const RUNNER_FAILURE_READERS: Record<string, (raw: string) => RunnerFailure | null> = {
  codex: (raw) => inspectCodexFailure(raw).failure,
  glm: inspectGlmFactoryFailure,
};

/**
 * Сверка attempt/run/epoch и временного окна отсеивает ошибку прошлой попытки или визита.
 * Остановленный по таймауту или вручную процесс не наследует старый ответ провайдера.
 */
function matchingRun(meta: Record<string, string>, input: RunnerStallInput): boolean {
  const { registry, stall, timeline } = input;
  const stage = stall?.stage || '';
  const expectedAttempt = input.attempt || registry.ATTEMPT_ID;
  const started = Date.parse(meta.STARTED_AT || '');
  const finished = Date.parse(meta.FINISHED_AT || '');
  const stopped = Date.parse(stall?.since || '');
  const visit = timeline.findLast((event) => (
    /(?:^|route: )узел \S+: подготовка к исполнению/.test(event.event)
  ));
  const visitStarted = Date.parse(visit?.ts || '');

  return Boolean(expectedAttempt && meta.ATTEMPT_ID === expectedAttempt
    && meta.TASK === `t${input.task}` && meta.STAGE === stage && meta.SOURCE === 'runtime'
    && meta.RUN_ID === registry[`ACTIVE_RUN_${stage}`] && meta.EPOCH === registry[`ACTIVE_EPOCH_${stage}`]
    && RUNNER_FAILURE_READERS[meta.RUNNER || ''] !== undefined && /^-?\d+$/.test(meta.RC || '')
    && ![0, 124, 130, 143].includes(Number(meta.RC))
    && !['ok', 'timeout', 'manual_switch'].includes(meta.RESULT_CLASS || '')
    && Number.isFinite(started) && Number.isFinite(finished) && Number.isFinite(stopped)
    && finished >= started && finished <= stopped + 1000
    && Number.isFinite(visitStarted) && started >= visitStarted);
}

/**
 * Новые запуски уже имеют diagnostic mirror ошибки. Для старых unknown читаем
 * терминальные события того же run; это только пояснение, не пересмотр результата.
 */
async function readFailure(input: RunnerStallInput): Promise<RunFailure | null> {
  const stage = input.stall?.stage || '';
  const run = input.registry[`ACTIVE_RUN_${stage}`] || '';

  if (!/^[1-9]\d*$/.test(String(input.task)) || !/^[A-Z][A-Z0-9_]*$/.test(stage)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(run)) {
    return null;
  }

  const directory = await openRunDirectory(input.stateDir, ['logs', 'runs', `t${input.task}`, stage, run]);

  try {
    const meta = parsePipeline(await readRunFile(directory, 'meta.env'));

    if (!matchingRun(meta, input)) {
      return null;
    }

    const failure = meta.FAILURE_CODE && meta.FAILURE_MESSAGE
      ? { code: meta.FAILURE_CODE, message: cleanRunnerFailureMessage(meta.FAILURE_MESSAGE) }
      : RUNNER_FAILURE_READERS[meta.RUNNER || '']!(await readRunFile(directory, 'events.jsonl', true));

    return failure ? { failure, model: meta.RESOLVED_MODEL || meta.MODEL || '' } : null;
  } finally {
    await directory.close();
  }
}

/**
 * Сводка и граф получают одинаковую причину, включая старые остановки без FAILURE_*.
 * При недоступных доказательствах возвращаем прежнюю карточку и не меняем арбитраж.
 */
export async function enrichRunnerStall(input: RunnerStallInput): Promise<StallInfo | null> {
  const { stall } = input;

  if (!stall || stall.outcome !== 'exhausted') {
    return stall;
  }

  try {
    const evidence = await readFailure(input);

    if (!evidence) {
      return stall;
    }

    const detail = runnerFailureDetail(evidence.failure, evidence.model);
    // Старые retained-события не всегда содержат код лимита. Уточняем только подпись:
    // машинный класс, политика повтора и исходный текст провайдера остаются прежними.
    const displayFailure = evidence.failure.code === 'unknown'
      && /^Rate limit reached\b/iu.test(evidence.failure.message)
      ? { ...evidence.failure, code: 'rate_limit' } : evidence.failure;
    const lastFailure = runnerFailureDetail(displayFailure);
    const runs = stall.title.match(/\d+ заход(?:а|ов)? без результата/u)?.[0];
    const attempts = stall.presentation?.attempts ?? (runs ? Number.parseInt(runs, 10) : undefined);
    const temporary = ['capacity', 'rate_limit'].includes(displayFailure.code);
    const hint = temporary
      ? 'Провайдер временно отклонил запрос. Повторите этап позже;'
        + ' если черновик записан, он будет передан следующему заходу.'
      : 'Проверьте сообщение провайдера. Если черновик записан, при повторе этап получит его.';

    return {
      ...stall,
      title: `${stall.stage}: ${detail}${runs ? ` — ${runs}` : ''}`,
      comment: stall.comment?.replace(/последний —[^\n]*$/u, () => `последний — ${detail}`) ?? null,
      detail: `${stall.detail || stall.comment || ''}\nОтвет провайдера: ${evidence.failure.message}`,
      hint,
      presentation: {
        reason: 'агент не вернул результат',
        summary: temporary
          ? 'Провайдер отклонил запрос; повторите этап позже.'
          : 'Проверьте сообщение провайдера перед повтором этапа.',
        details: {
          what: 'Результат этапа не получен после завершившихся заходов.',
          cause: lastFailure,
          retained: 'Если черновик хода записан, он сохраняется и передаётся следующему заходу.',
          action: hint,
        },
        ...(attempts !== undefined ? { attempts } : {}),
        lastFailure,
        ...(evidence.model ? { model: evidence.model } : {}),
      },
    };
  } catch {
    return stall;
  }
}

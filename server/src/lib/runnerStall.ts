// Диагностическое дополнение остановки: читаем только exact завершившийся run.
// Текст ошибки не изменяет курсор, вердикт, разрешение повтора или арбитраж.
import { openRunDirectory, readRunFile, readRunnerFailure } from './runnerArtifacts.ts';
import { runnerModelName } from './runnerModel.ts';

import { translate } from '../../../shared/i18n/catalogs.ts';

import { parsePipeline } from './pipelineParse.ts';
import { runnerFailureDetail } from './runnerFailure.ts';
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
    && /^-?\d+$/.test(meta.RC || '')
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

    const failure = await readRunnerFailure(directory, meta);

    return failure ? { failure, model: runnerModelName(meta.RESOLVED_MODEL || meta.MODEL) || '' } : null;
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
    const diagnostic = ['stderr', 'diagnostic_missing'].includes(displayFailure.code);
    const hint = diagnostic ? translate('core.runnerFailureInspectLog') : temporary
      ? 'Провайдер временно отклонил запрос. Повторите этап позже;'
        + ' если черновик записан, он будет передан следующему заходу.'
      : 'Проверьте сообщение провайдера. Если черновик записан, при повторе этап получит его.';
    const previousDetail = (stall.detail || stall.comment || '')
      .replace(/последний —[^\n]*$/u, () => `последний — ${detail}`);

    return {
      ...stall,
      title: `${stall.stage}: ${detail}${runs ? ` — ${runs}` : ''}`,
      comment: stall.comment?.replace(/последний —[^\n]*$/u, () => `последний — ${detail}`) ?? null,
      detail: `${previousDetail}\n${translate('core.runnerFailureDiagnostic', {
        message: evidence.failure.message,
      })}`,
      hint,
      presentation: {
        reason: 'агент не вернул результат',
        summary: diagnostic ? hint : temporary
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

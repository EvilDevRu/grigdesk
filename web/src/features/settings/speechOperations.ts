import { shallowRef } from 'vue';
import { isPlainRecord } from '../../../../shared/lib/objects.ts';
import { failureText, type ApiClient } from '../../shared/apiClient.ts';

export interface SpeechBenchmarkParameters {
  modelId: string;
  language: string;
  device: string;
  computeType: string;
}

export interface SpeechJob {
  jobId: string;
  kind: string;
  modelId: string;
  status: string;
  percent: number | null;
  error: string;
  result: Record<string, number>;
}

const TERMINAL = new Set(['done', 'failed', 'cancelled', 'interrupted']);

/**
 * Серверный job содержит больше данных; UI получает только статус, прогресс и результат.
 * Неполный start-ответ дополняется явно известным типом операции и моделью.
 */
function decodeJob(value: unknown, previous?: SpeechJob): SpeechJob {
  if (!isPlainRecord(value) || typeof value.jobId !== 'string' || !value.jobId) {
    throw new TypeError('Сервер не вернул задание речи');
  }

  const progress = isPlainRecord(value.progress) ? value.progress : {};
  const result = isPlainRecord(value.result) ? value.result : {};
  const numbers = Object.fromEntries(Object.entries(result).filter(([, number]) =>
    typeof number === 'number' && Number.isFinite(number))) as Record<string, number>;
  const error = isPlainRecord(value.error) ? value.error.message : value.error;

  return {
    jobId: value.jobId,
    kind: typeof value.kind === 'string' ? value.kind : previous?.kind ?? '',
    modelId: typeof value.modelId === 'string' ? value.modelId : previous?.modelId ?? '',
    status: typeof value.status === 'string' ? value.status : previous?.status ?? 'queued',
    percent: typeof progress.percent === 'number' ? Math.max(0, Math.min(100, progress.percent)) : null,
    error: typeof error === 'string' ? error : '',
    result: numbers,
  };
}

/**
 * Задания живут на сервере; контроллер запоминает ID в пределах открытия настроек.
 * Уход со страницы прекращает только UI-опрос, возврат перечитывает прежние задания.
 */
export function createSpeechOperations(
  client: Pick<ApiClient, 'get' | 'post' | 'del'>,
  parameters: () => SpeechBenchmarkParameters,
  refreshModels: () => Promise<unknown>,
) {
  const jobs = shallowRef<SpeechJob[]>([]);
  const busy = shallowRef<string[]>([]);
  const message = shallowRef('');
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const revisions = new Map<string, number>();
  let active = false;
  let disposed = false;
  let generation = 0;
  let reads = new AbortController();

  function isActive(job?: SpeechJob): boolean {
    return Boolean(job && !TERMINAL.has(job.status));
  }

  function jobFor(modelId: string, benchmark = false): SpeechJob | undefined {
    return jobs.value.filter((job) => benchmark ? job.kind === 'benchmark'
      : job.modelId === modelId && job.kind !== 'benchmark').at(-1);
  }

  function remember(job: SpeechJob): void {
    jobs.value = [...jobs.value.filter((previous) => previous.jobId !== job.jobId), job];
  }

  /**
   * Опрос не переживает деактивацию страницы и не повторяет мутацию задания.
   * Ошибка чтения оставляет серверное задание рабочим и допускает следующий опрос.
   */
  async function poll(jobId: string): Promise<void> {
    if (!active || disposed) {
      return;
    }

    const visiting = generation;
    const revision = revisions.get(jobId) ?? 0;
    const previous = jobs.value.find((job) => job.jobId === jobId);

    try {
      const response = await client.get(`/api/settings/speech/jobs/${encodeURIComponent(jobId)}`,
        { signal: reads.signal });

      if (!active || disposed || generation !== visiting
          || (revisions.get(jobId) ?? 0) !== revision) {
        return;
      }

      const next = decodeJob(response, previous);

      remember(next);

      if (!isActive(next)) {
        if (next.status === 'done' && next.kind !== 'benchmark') {
          await refreshModels();
        }

        return;
      }
    } catch (error) {
      if (!active || disposed || generation !== visiting
          || (revisions.get(jobId) ?? 0) !== revision) {
        return;
      }

      message.value = failureText(error);
    }

    if (active && !disposed && generation === visiting) {
      timers.set(jobId, setTimeout(() => {
        timers.delete(jobId);
        void poll(jobId);
      }, 900));
    }
  }

  /**
   * Двойной клик и уже известное активное задание не запускают второй POST.
   * Замер получает параметры из текущего черновика непосредственно перед запросом.
   */
  async function start(kind: 'download' | 'copy' | 'benchmark', modelId = ''): Promise<void> {
    const key = `${kind}:${modelId}`;

    if (disposed || busy.value.includes(key) || isActive(jobFor(modelId, kind === 'benchmark'))) {
      return;
    }

    busy.value = [...busy.value, key];
    message.value = '';

    try {
      const body = kind === 'benchmark' ? parameters() : {};
      const response = await client.post(kind === 'benchmark' ? '/api/settings/speech/benchmark'
        : `/api/settings/speech/models/${encodeURIComponent(modelId)}/${kind}`, body);

      if (disposed) {
        return;
      }

      const next = decodeJob(response);

      next.kind ||= kind;
      next.modelId ||= kind === 'benchmark' ? (body as SpeechBenchmarkParameters).modelId : modelId;
      remember(next);
      await poll(next.jobId);
    } catch (error) {
      if (!disposed) {
        message.value = failureText(error);
      }
    } finally {
      busy.value = busy.value.filter((item) => item !== key);
    }
  }

  /**
   * Отмена адресует существующий job и не записывает настройки речи.
   * После отказа серверный job остаётся в списке и продолжает обычный опрос.
   */
  async function cancel(job?: SpeechJob): Promise<void> {
    const key = `cancel:${job?.jobId}`;

    if (!job || disposed || busy.value.includes(key)) {
      return;
    }

    busy.value = [...busy.value, key];
    revisions.set(job.jobId, (revisions.get(job.jobId) ?? 0) + 1);

    const timer = timers.get(job.jobId);

    clearTimeout(timer);
    timers.delete(job.jobId);

    try {
      const response = await client.del(`/api/settings/speech/jobs/${encodeURIComponent(job.jobId)}`);

      if (!disposed) {
        remember(decodeJob(response, job));
      }
    } catch (error) {
      message.value = failureText(error);
      void poll(job.jobId);
    } finally {
      busy.value = busy.value.filter((item) => item !== key);
    }
  }

  /**
   * Все таймеры и текущие чтения принадлежат посещению, а не серверному job.
   * Возврат сразу читает известные ID, в том числе успевшие завершиться задания.
   */
  function setActive(value: boolean): void {
    if (value === active || disposed) {
      return;
    }

    active = value;
    generation += 1;
    reads.abort();
    reads = new AbortController();

    for (const timer of timers.values()) {
      clearTimeout(timer);
    }

    timers.clear();

    if (active) {
      for (const job of jobs.value) {
        void poll(job.jobId);
      }
    }
  }

  return {
    jobs,
    busy,
    message,
    jobFor,
    isActive,
    start,
    cancel,
    setActive,
    /**
     * Закрытие освобождает UI и запросы чтения без остановки серверной работы.
     * Поздний start-ответ после dispose не возвращает job в закрытую форму.
     */
    dispose() {
      setActive(false);
      disposed = true;
      jobs.value = [];
      busy.value = [];
    },
  };
}

/**
 * Результат замера читается в тех же единицах, что и прежний экран речи.
 * Пустой результат остаётся понятным сообщением, а не пустой строкой.
 */
export function speechBenchmarkText(job?: SpeechJob): string {
  const result = job?.result;

  if (!result) {
    return '';
  }

  const parts = [];

  if (Number.isFinite(result.audioSec ?? result.audioSeconds)) {
    parts.push(`${(result.audioSec ?? result.audioSeconds)!.toFixed(1)} с речи`);
  }
  if (Number.isFinite(result.elapsedSec)) {
    parts.push(`${result.elapsedSec!.toFixed(2)} с обработки`);
  } else if (Number.isFinite(result.durationMs ?? result.duration)) {
    parts.push(`${((result.durationMs ?? result.duration)! / 1000).toFixed(2)} с обработки`);
  }
  if (Number.isFinite(result.realtimeFactor)) {
    parts.push(`RTF ${result.realtimeFactor!.toFixed(2)}`);
  }

  return parts.join(' · ') || 'Замер завершён.';
}

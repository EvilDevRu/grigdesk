import type { GraphModelJob, GraphModelResult } from './graphWorkflowExecutor.ts';
import { GraphCommandError } from './graphWorkflows.ts';

interface Update {
  id: string;
  revision?: number;
}
interface Job extends GraphModelJob {
  id: string;
  nodeId: string;
  generation: number;
  claimId: string;
  expiresAt: number;
}
interface Claim {
  job: Job | null;
  changed: Update[];
  pending: boolean;
  nextWakeAt?: number;
}

interface WorkerPorts {
  claim(): Promise<Claim>;
  settle(job: Job, result: GraphModelResult): Promise<Update>;
  run(job: Job, signal: AbortSignal): Promise<GraphModelResult | { committed: Update }>;
  announce(update: Update): void;
  unavailable(error: unknown): void;
  invalidateRuns(): void;
  deadlineSignal?: () => AbortSignal;
}

type WaitResult<T> = { value: T } | { interrupted: true };

/**
 * Завершает ожидание у сервера, даже когда транспорт продолжает очистку.
 * Поздний ответ обрабатывает обработчик промиса транспорта.
 */
export async function waitForWork<T>(work: Promise<T>, signal: AbortSignal): Promise<WaitResult<T>> {
  let abort: (() => void) | undefined;
  const cancelled = new Promise<WaitResult<T>>((resolve) => {
    abort = () => resolve({ interrupted: true });

    if (signal.aborted) {
      abort();
    } else {
      signal.addEventListener('abort', abort, { once: true });
    }
  });

  try {
    return await Promise.race([work.then((value): WaitResult<T> =>
      signal.aborted ? { interrupted: true } : { value }), cancelled]);
  } finally {
    if (abort) {
      signal.removeEventListener('abort', abort);
    }
  }
}

export class GraphWorkflowWorkers {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private polling: Promise<void> | undefined;
  private readonly active = new Set<Promise<void>>();
  private readonly lifetime = new AbortController();
  private again = false;
  private againDelay = 1000;

  private readonly ports: WorkerPorts;

  constructor(ports: WorkerPorts) {
    this.ports = ports;
  }

  /** Одно пробуждение объединяет серию ответов, mutex хранит Go. */
  wake(delay = 0): void {
    if (this.lifetime.signal.aborted) {
      return;
    }
    if (this.polling) {
      this.again = true;
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.polling = this.poll().finally(() => {
        this.polling = undefined;

        if (this.again) {
          this.again = false;
          this.wake(this.againDelay);
          this.againDelay = 1000;
        }
      });
    }, delay);
  }

  /**
   * Последовательно запрашивает выдачи, чтобы остальные процессы видели каждое назначение.
   * Обработку выданных заданий запускает параллельно, по расписанию Go.
   */
  private async poll(): Promise<void> {
    try {
      while (!this.lifetime.signal.aborted) {
        const state = await this.ports.claim();

        state.changed.forEach((item) => this.ports.announce(item));
        if (!state.job) {
          this.again ||= state.pending;
          if (state.nextWakeAt !== undefined) {
            const delay = state.nextWakeAt - Date.now();
            this.againDelay = Math.max(1000, Math.min(delay, 6 * 60 * 1000));
          }
          return;
        }
        if (this.lifetime.signal.aborted) {
          return;
        }
        const work = this.work(state.job);

        this.active.add(work);
        void work.finally(() => {
          this.active.delete(work);
          this.wake();
        });
      }
    } catch (error) {
      this.ports.unavailable(error);
      this.ports.invalidateRuns();

      if (error instanceof GraphCommandError && error.code === 'workflow_storage_invalid') {
        this.again = false;
        return;
      }
      this.again = true;
      this.againDelay = 5000;
    }
  }

  /**
   * Выполнение с ограниченным сроком. Даже позднее завершение несёт исходный claimId.
   * Go решает, принадлежит ли полученный результат ещё открытому поколению.
   */
  private async work(job: Job): Promise<void> {
    const remaining = Math.max(0, job.expiresAt - 60_000 - Date.now());
    const deadline = this.ports.deadlineSignal?.()
      ?? (remaining === 0 ? AbortSignal.abort() : AbortSignal.timeout(remaining));
    const signal = AbortSignal.any([this.lifetime.signal, deadline]);
    let result: GraphModelResult;

    try {
      signal.throwIfAborted();
      const transport = this.ports.run(job, signal).then((value) => {
        if ('committed' in value && !this.lifetime.signal.aborted) {
          this.ports.announce(value.committed);
          this.wake();
        }

        return value;
      });
      const outcome = await waitForWork(transport, signal);

      if ('interrupted' in outcome) {
        this.ports.announce({ id: job.id });
        return;
      }
      if ('committed' in outcome.value) {
        return;
      }
      result = outcome.value;
    } catch {
      if (signal.aborted) {
        this.ports.announce({ id: job.id });
        return;
      }

      result = { errorCode: 'run_failed' };
    }

    try {
      const updated = await this.ports.settle(job, result);

      this.ports.announce(updated);
    } catch (error) {
      this.ports.unavailable(error);
      this.ports.announce({ id: job.id });
    }
  }

  /**
   * Останавливает собственные обращения и закрывает принятые выдачи.
   * После принудительного обрыва чужой процесс разберёт их по сроку lease.
   */
  async close(): Promise<void> {
    this.lifetime.abort();
    clearTimeout(this.timer);
    await this.polling;
    await Promise.all(this.active);
  }
}
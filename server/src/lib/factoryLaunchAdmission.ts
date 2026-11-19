import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import { FACTORY_TASK_ID, decodeCompleteFactoryOwnership } from '../../../shared/runtime/factoryOwnership.ts';

export class FactoryLaunchAdmissionError extends Error {
  readonly status = 409;
  readonly code: 'release_drain_busy' | 'release_activity_unknown';

  constructor(code: FactoryLaunchAdmissionError['code']) {
    super(code);
    this.code = code;
  }
}

interface Admission {
  task: string;
  references: number;
}

interface Drain {
  id: string;
  owner: string;
  phase: 'acquired' | 'confirmed' | 'dispatched';
  confirmedAt: number | null;
}

export interface FactoryAdmissionReference {
  run<T>(operation: () => Promise<T>): Promise<T>;
  release(): void;
}

export class FactoryLaunchAdmission {
  private readonly context = new AsyncLocalStorage<Admission>();

  private readonly writers = new Set<Admission>();

  private generation = 0;

  private drain: Drain | null = null;

  private pending: () => boolean = () => false;

  bindPending(reader: () => boolean): void {
    this.pending = reader;
  }

  isDraining(): boolean {
    return this.drain !== null;
  }

  /**
   * Номер поколения меняется даже если между обходами работал короткий writer.
   * Повторный обход различает тот же пустой снимок и заново опустевший.
   */
  snapshot() {
    return {
      generation: this.generation,
      tasks: [...new Set([...this.writers].map((writer) => writer.task))].sort(),
    };
  }

  /**
   * Повторное использование допустимо только под живым допуском той же задачи.
   * Длинный writer держит собственную ссылку после завершения HTTP запроса.
   */
  retain(task: string): FactoryAdmissionReference {
    const existing = this.context.getStore();

    if (!FACTORY_TASK_ID.test(task) || existing && this.writers.has(existing) && existing.task !== task) {
      throw new FactoryLaunchAdmissionError('release_activity_unknown');
    }

    let admission: Admission;

    if (existing?.task === task && this.writers.has(existing)) {
      admission = existing;
    } else {
      if (this.drain) {
        throw new FactoryLaunchAdmissionError('release_drain_busy');
      }

      admission = {
        task,
        references: 0,
      };
      this.writers.add(admission);
    }

    let released = false;

    admission.references += 1;
    this.generation += 1;

    return {
      run: async (operation) => {
        if (released || !this.writers.has(admission)) {
          throw new FactoryLaunchAdmissionError('release_activity_unknown');
        }

        return this.context.run(admission, operation);
      },
      release: () => {
        if (released) {
          return;
        }

        released = true;
        admission.references -= 1;
        this.generation += 1;

        if (admission.references === 0) {
          this.writers.delete(admission);
        }
      },
    };
  }

  /**
   * Внешний вызов владеет своей ссылкой до последнего await.
   * Вложенный sync или async вызов остаётся под тем же допуском.
   */
  async run<T>(task: string, operation: () => Promise<T>): Promise<T> {
    const reference = this.retain(task);

    try {
      return await reference.run(operation);
    } finally {
      reference.release();
    }
  }

  /**
   * Сначала закрывает допуск. При in-flight откатывает только свой drain,
   * чтобы отказ acquire не запирал обычные операции над конвейером.
   */
  acquire(owner: string, hasPending = this.pending): string {
    if (this.drain) {
      throw new FactoryLaunchAdmissionError('release_drain_busy');
    }

    const id = randomUUID();

    this.drain = {
      id,
      owner,
      phase: 'acquired',
      confirmedAt: null,
    };

    try {
      if (this.writers.size > 0 || hasPending()) {
        throw new FactoryLaunchAdmissionError('release_activity_unknown');
      }

      return id;
    } catch (error) {
      this.drain = null;

      throw error;
    }
  }

  /**
   * Пока выполняется повторный read-only обход, обычные writers уже закрыты.
   * Отказ снимает только активный токен владельца с этой фазой.
   */
  async confirm(id: string, owner: string, ownership: () => Promise<unknown>): Promise<void> {
    const drain = this.drain;

    if (drain?.id !== id || drain.owner !== owner || drain.phase !== 'acquired') {
      throw new FactoryLaunchAdmissionError('release_drain_busy');
    }

    try {
      const rows = decodeCompleteFactoryOwnership(await ownership());

      if (this.drain !== drain || drain.phase !== 'acquired' || this.writers.size > 0 || rows.some((row) =>
        row.orchestrator !== 'dead' || row.runner !== 'dead' || row.finalization !== 'done')) {
        throw new FactoryLaunchAdmissionError('release_activity_unknown');
      }

      drain.phase = 'confirmed';
      drain.confirmedAt = performance.now();
    } catch {
      if (this.drain === drain && drain.phase === 'acquired') {
        this.drain = null;
      }

      throw new FactoryLaunchAdmissionError('release_activity_unknown');
    }
  }

  /**
   * Право на выключение одноразовое и требует непосредственно предшествующего confirm.
   * До доказанного выхода или отмены выключения допуск остаётся закрыт.
   */
  dispatch(id: string, owner: string): void {
    if (this.drain?.id !== id || this.drain.owner !== owner || this.drain.phase !== 'confirmed') {
      throw new FactoryLaunchAdmissionError('release_drain_busy');
    }

    this.drain.phase = 'dispatched';
    this.drain.confirmedAt = performance.now();
  }

  /**
   * Повтор release безопасен. Чужой или уже отправленный drain не освобождается.
   * За dispatched отвечает отдельная проверка жизненного цикла сервера.
   */
  release(id: string, owner: string): void {
    if (this.drain?.id === id && this.drain.owner === owner && this.drain.phase !== 'dispatched') {
      this.drain = null;
    }
  }

  /**
   * Таймер передаёт только доказанную смерть exact владельца. После confirm
   * повторное открытие возможно по истечении общего срока и при живом сервере.
   */
  reapDeadOwner(id: string, owner: string, shutdownPending: boolean): boolean {
    const drain = this.drain;

    if (drain?.id !== id || drain.owner !== owner) {
      return true;
    }

    if (drain.confirmedAt === null
      || performance.now() - drain.confirmedAt >= 65000 && !shutdownPending) {
      this.drain = null;

      return true;
    }

    return false;
  }

  owns(id: string, owner: string): boolean {
    return this.drain?.id === id && this.drain.owner === owner;
  }
}

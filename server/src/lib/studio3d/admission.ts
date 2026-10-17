// Lifecycle и отправки используют один краткий допуск. Долгие копии имеют lease,
// но сетевые ответы никогда не удерживают этот lock и не задерживают disable.
import { randomUUID } from 'node:crypto';

import { withPathLock } from '../pathLock.ts';
import { IntentError } from './intents.ts';

export interface AdmissionToken {
  generation: number;
  libraryId: string;
}

class Admission {
  private readonly key = `studio3d:admission:${randomUUID()}`;
  private generation = 1;
  private enabled = true;
  private closing = false;
  private libraryId: string;
  private pending = 0;

  constructor(libraryId: string) {
    this.libraryId = libraryId;
  }

  /**
   * Snapshot снимается синхронно до первого await и повторяется перед POST.
   * Чужая библиотека проверяется прежде поиска UUID и любых файловых эффектов.
   */
  capture(libraryId: string): AdmissionToken {
    if (libraryId !== this.libraryId) {
      throw new IntentError('stale_library');
    }

    if (!this.enabled || this.closing) {
      throw new IntentError('plugin_disabled');
    }

    return { generation: this.generation, libraryId: this.libraryId };
  }

  current(token: AdmissionToken): boolean {
    return this.enabled && !this.closing && token.generation === this.generation
      && token.libraryId === this.libraryId;
  }

  canAccept(): boolean {
    return this.enabled && !this.closing;
  }

  pendingCount(): number {
    return this.pending;
  }

  /**
   * Lease удерживает выбранную библиотеку во время copy вне короткого lock.
   * Идемпотентный release позволяет безопасно завершить любой путь отказа.
   */
  lease(): () => void {
    let released = false;

    this.pending += 1;

    return () => {
      if (!released) {
        released = true;
        this.pending -= 1;
      }
    };
  }

  /**
   * Смена допуска инвалидирует все прежние подготовленные токены в памяти.
   * Опрос принятых заказов остаётся обязанностью прежнего worker и библиотеки.
   */
  configure(input: {
    enabled: boolean;
    libraryId?: string;
    closing?: boolean
  }): void {
    this.generation += 1;
    this.enabled = input.enabled;
    this.closing = input.closing ?? false;
    this.libraryId = input.libraryId ?? this.libraryId;
  }

  locked<T>(callback: () => Promise<T>): Promise<T> {
    return withPathLock(this.key, callback);
  }
}

/**
 * Допуск создаётся без файловых/сетевых эффектов. Модуль плагина использует
 * тот же экземпляр для transactional switch и последней проверки worker.
 */
export function createAdmission(libraryId: string): Admission {
  return new Admission(libraryId);
}

export type StudioAdmission = ReturnType<typeof createAdmission>;

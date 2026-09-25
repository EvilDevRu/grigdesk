import { diagnosticLevel, DIAGNOSTIC_TIMER_LIMIT_MS } from '../../../shared/diagnosticLogging.ts';

import type { DiagnosticLevel } from '../../../shared/diagnosticLogging.ts';
import type { FactoryDebugSettings, FactoryDebugView } from './factoryDebug.ts';

const SERVER_LOG_LEVEL: Record<DiagnosticLevel, 'silent' | 'error' | 'info' | 'debug'> = {
  off: 'silent',
  errors: 'error',
  decisions: 'info',
  verbose: 'debug',
};

/**
 * Уровень logger-а сервера по общему диагностическому уровню. «Выключено»
 * означает `silent`: сервер тоже перестаёт писать диагностику.
 */
export function serverLogLevel(level: DiagnosticLevel): 'silent' | 'error' | 'info' | 'debug' {
  return SERVER_LOG_LEVEL[level];
}

/**
 * Единый источник уровня — глобальная настройка engine CLI. Фабрика разрешает
 * профильные и задачные переопределения только для своих запусков; окно и сервер
 * используют глобальный уровень. Состояние не дублируется в prefs.
 */
export class DiagnosticLoggingPolicy {
  private readonly factoryDebug: Pick<FactoryDebugSettings, 'show' | 'set' | 'clear'>;

  private readonly listeners = new Set<(level: DiagnosticLevel) => void>();

  private current: DiagnosticLevel | null = null;

  private tail: Promise<unknown> = Promise.resolve();

  private expiryTimer: NodeJS.Timeout | null = null;

  constructor(factoryDebug: Pick<FactoryDebugSettings, 'show' | 'set' | 'clear'>) {
    this.factoryDebug = factoryDebug;
  }

  private exclusive<Value>(operation: () => Promise<Value>): Promise<Value> {
    const result = this.tail.then(operation, operation);

    this.tail = result.then(() => undefined, () => undefined);

    return result;
  }

  async view(): Promise<FactoryDebugView> {
    return this.exclusive(async () => {
      try {
        const view = await this.factoryDebug.show({
          scope: 'global',
          profile: undefined,
          task: undefined,
        });

        this.publish(view);

        return view;
      } catch (error) {
        this.publishLevel('off');

        throw error;
      }
    });
  }

  /**
   * Применяем ответ CLI: перезапускаем таймер срока действия уровня и
   * обновляем зависимые модули лишь при реальном изменении глобального уровня.
   */
  private publish(view: FactoryDebugView): void {
    const level = diagnosticLevel(view.effective);

    if (level === null) {
      throw new Error('Некорректный уровень диагностического логирования.');
    }

    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }

    if (Number.isSafeInteger(view.expiresAt) && view.expiresAt > Date.now() / 1000) {
      this.expiryTimer = setTimeout(() => {
        void this.level().catch(() => undefined);
      }, Math.min(DIAGNOSTIC_TIMER_LIMIT_MS, view.expiresAt * 1000 - Date.now() + 10));
      this.expiryTimer.unref();
    }

    this.publishLevel(level);
  }

  /**
   * Рассылаем новый уровень подписчикам. Сбой одного подписчика не мешает
   * остальным и не отменяет смену уровня.
   */
  private publishLevel(level: DiagnosticLevel): void {
    if (level === this.current) {
      return;
    }

    this.current = level;

    for (const listener of this.listeners) {
      try {
        listener(level);
      } catch {
        /* чужой logger не влияет на настройку фабрики */
      }
    }
  }

  /**
   * Подписка сразу получает текущий уровень, если он уже известен, а затем
   * каждую смену. Возвращает функцию отписки.
   */
  subscribe(listener: (level: DiagnosticLevel) => void): () => void {
    this.listeners.add(listener);

    if (this.current !== null) {
      try {
        listener(this.current);
      } catch {
        /* подписчик не влияет на источник уровня */
      }
    }

    return () => this.listeners.delete(listener);
  }

  async level(): Promise<DiagnosticLevel> {
    return this.view().then((view) => view.effective as DiagnosticLevel);
  }

  async set(level: string, duration?: unknown): Promise<FactoryDebugView> {
    return this.exclusive(async () => {
      const view = await this.factoryDebug.set({
        scope: 'global',
        profile: undefined,
        task: undefined,
        level,
        duration,
      });

      this.publish(view);

      return view;
    });
  }

  async clear(): Promise<FactoryDebugView> {
    return this.exclusive(async () => {
      const view = await this.factoryDebug.clear({
        scope: 'global',
        profile: undefined,
        task: undefined,
      });

      this.publish(view);

      return view;
    });
  }

  close(): void {
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }

    this.listeners.clear();
  }
}

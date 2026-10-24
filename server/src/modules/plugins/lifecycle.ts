import type { FastifyReply, FastifyRequest } from 'fastify';
import { installError } from '../../lib/pluginInstall/errors.ts';
import { changeError } from './changes.ts';
import type { PluginChange, PluginTransition } from './changes.ts';

export interface ReplacementLease {
  finish(outcome: 'installed' | 'reverted' | 'blocked'): Promise<void>;
}

export interface PluginLifecycle {
  busyReason: null | (() => unknown);
  prepareReplace: null | ((signal: AbortSignal) => Promise<ReplacementLease>);
  onEnable?: () => unknown;
  onDisable?: () => unknown;
  prepareChange?: (change: PluginChange, signal: AbortSignal) =>
    PluginTransition | undefined | Promise<PluginTransition | undefined>;
}

export const BUSY_UNKNOWN = 'Не удалось подтвердить, что плагин свободен.';

/**
 * Объект создаётся отдельно для каждого runtime и мутируется его серверным модулем.
 * Диагностика занятости и право замены являются разными контрактами.
 */
export function createPluginLifecycle(): PluginLifecycle {
  return { busyReason: null, prepareReplace: null };
}

/**
 * Диагностика возвращает безопасную причину, не разрешая filesystem эффекты.
 * Произвольный текст исключения не должен попадать в интерфейс.
 */
export async function askPluginBusy(lifecycle?: PluginLifecycle, timeoutMs = 5000): Promise<string | null> {
  if (!lifecycle?.busyReason) {
    return null;
  }

  let value: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    value = await Promise.race([
      Promise.resolve().then(() => lifecycle.busyReason!()),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(true), timeoutMs);
      }),
    ]);
  } catch {
    return BUSY_UNKNOWN;
  } finally {
    clearTimeout(timer);
  }

  if (value === null || value === false) {
    return null;
  }

  return typeof value === 'string' ? value.trim() || null : BUSY_UNKNOWN;
}

export interface PluginAdmissionOptions {
  lifecycle: PluginLifecycle;
  hasServer: boolean;
  stopRequired?: boolean;
  timeoutMs?: number;
}

/**
 * Gate принадлежит одному зарегистрированному scope и закрывает новый допуск.
 * Streaming response удерживает замену до событий окончания, а не return handler.
 */
export class PluginAdmission {
  readonly options: PluginAdmissionOptions;
  private phase: 'open' | 'replacing' | 'installed' | 'blocked' = 'open';
  private active = 0;
  private hookPending = false;
  private enabled = true;
  private changePending = false;
  private readonly drained = new Set<() => void>();

  constructor(options: PluginAdmissionOptions) {
    this.options = options;
  }

  get obsolete(): boolean {
    return this.phase === 'installed' || this.phase === 'blocked';
  }

  get needsRestart(): boolean {
    return this.phase === 'installed' || !!this.options.stopRequired;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Reservation не ставит HTTP в очередь и не меняет текущий допуск плагина.
   * До освобождения она запрещает другую подготовку настроек и замену файлов.
   */
  beginChange(): () => void {
    if (this.phase !== 'open' || this.changePending) {
      throw changeError('plugin_change_busy',
        'Изменение плагина ещё не завершено. Если ожидание не заканчивается, перезапустите GrigDesk.');
    }

    this.changePending = true;

    return () => {
      this.changePending = false;
    };
  }

  /**
   * Допуск учитывает весь response/upgrade lifetime до единственного release.
   * Закрытый gate отвечает до пользовательского handler и чтения static файлов.
   */
  admit(request: FastifyRequest, reply: FastifyReply): void {
    if (this.phase !== 'open') {
      const code = this.phase === 'installed' ? 'plugin_restart_required'
        : this.phase === 'blocked' ? 'recovery_required' : 'plugin_replacing';

      reply.code(this.phase === 'blocked' ? 503 : 409).send({ error: code });

      return;
    }

    if (!this.enabled) {
      reply.code(404).send({ error: 'plugin_disabled', message: 'Плагин выключен.' });

      return;
    }

    this.active += 1;

    const websocket = request.headers.upgrade?.toLowerCase() === 'websocket';
    const lifetime = websocket ? request.raw.socket : reply.raw;
    const events = websocket ? ['close', 'error'] : ['finish', 'close', 'error'];
    let released = false;

    // Один response может доставить finish и close вслед друг за другом.
    // Его допуск освобождается один раз и снимает все оставшиеся listeners.
    const release = () => {
      if (released) {
        return;
      }

      released = true;

      for (const event of events) {
        lifetime.removeListener(event, release);
      }

      this.active -= 1;

      if (this.active === 0) {
        for (const resolve of this.drained) {
          resolve();
        }
      }
    };

    for (const event of events) {
      lifetime.once(event, release);
    }
  }

  /**
   * Закрытие admission происходит синхронно до ожидания старых responses.
   * Возобновление допуска возможно лишь после подтверждённого reverted outcome.
   */
  async prepare(signal: AbortSignal): Promise<ReplacementLease> {
    if (this.phase !== 'open' || this.changePending) {
      throw installError('plugin_busy');
    }

    this.phase = 'replacing';

    let lease: ReplacementLease | null = null;

    try {
      await this.waitForDrain(signal);

      if (await askPluginBusy(this.options.lifecycle, this.options.timeoutMs ?? 5000)) {
        throw installError('plugin_busy');
      }

      if (this.options.stopRequired || (this.options.hasServer && !this.options.lifecycle.prepareReplace)) {
        throw installError('plugin_stop_required');
      }

      lease = await this.obtainLease(signal);
    } catch (error) {
      if (!this.hookPending) {
        this.phase = 'open';
      }

      throw error;
    }

    let finishing: Promise<void> | null = null;

    return {
      finish: (outcome) => {
        finishing ??= (async () => {
          await lease?.finish(outcome);
          this.phase = outcome === 'reverted' ? 'open' : outcome;
        })();

        return finishing;
      },
    };
  }

  /**
   * Timeout отменяет hook, но не объявляет его ресурсы автоматически свободными.
   * Поздний lease возвращается как reverted и лишь успешный cleanup открывает gate.
   */
  private async obtainLease(signal: AbortSignal): Promise<ReplacementLease | null> {
    const hook = this.options.lifecycle.prepareReplace;

    if (!hook) {
      return null;
    }

    const controller = new AbortController();
    const task = Promise.resolve().then(() => hook(controller.signal));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: () => void = () => {};

    this.hookPending = true;

    try {
      const lease = await Promise.race([
        task,
        new Promise<ReplacementLease>((_resolve, reject) => {
          abort = () => reject(installError('cancelled'));
          signal.addEventListener('abort', abort, { once: true });
          timer = setTimeout(() => reject(installError('plugin_busy')), this.options.timeoutMs ?? 5000);

          if (signal.aborted) {
            abort();
          }
        }),
      ]);

      this.hookPending = false;

      return lease;
    } catch (error) {
      controller.abort();
      void task.then(async (lease) => {
        await lease.finish('reverted');
        this.hookPending = false;
        this.phase = 'open';
      }, () => {
        this.hookPending = false;
        this.phase = 'open';
      }).catch(() => {});

      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
      clearTimeout(timer);
    }
  }

  /**
   * Drain ограничивает ожидание и не закрывает socket или stream клиента.
   * Счётчики продолжают учитывать старый response после неудачной попытки замены.
   */
  private async waitForDrain(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      throw installError('cancelled');
    }

    if (this.active === 0) {
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    let complete: () => void = () => {};
    let abort: () => void = () => {};

    try {
      await new Promise<void>((resolve, reject) => {
        complete = resolve;
        abort = () => reject(installError('cancelled'));
        this.drained.add(complete);
        signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => reject(installError('plugin_busy')), this.options.timeoutMs ?? 5000);
      });
    } finally {
      this.drained.delete(complete);
      signal.removeEventListener('abort', abort);
      clearTimeout(timer);
    }
  }
}

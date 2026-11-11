export type UsagePollMode = 'automatic' | 'manual';

export interface UsagePollContext {
  isCurrent(): boolean;
}

interface PendingPoll {
  mode: UsagePollMode;
  promise: Promise<void>;
  cancel(): void;
}

interface PollSlot {
  at: number | null;
  generation: number;
  pending: PendingPoll | null;
}

/**
 * Независимые часы и поколения удерживают адресную проверку в границах одного аккаунта.
 * Запрет автоматики отзывает публикацию, не отменяя явный ручной запрос пользователя.
 */
export function createProviderUsagePoller(
  load: (id: string, context: UsagePollContext) => Promise<void>,
  initiallyEnabled: boolean,
  now: () => number = Date.now,
) {
  const slots = new Map<string, PollSlot>();
  let enabled = initiallyEnabled;
  let stopped = false;

  /**
   * Создаёт ленивое состояние только запрошенного исполнителя.
   * Соседние аккаунты сохраняют свои часы и незавершённые операции.
   */
  function slotOf(id: string): PollSlot {
    let slot = slots.get(id);

    if (!slot) {
      slot = {
        at: null,
        generation: 0,
        pending: null,
      };
      slots.set(id, slot);
    }

    return slot;
  }

  /**
   * Освобождает ожидающих читателей и отзывает побочные эффекты старого loader.
   * Заморозка сохраняет возраст замера; смена аккаунта требует следующего измерения.
   */
  function invalidate(id: string, keepAge = false): void {
    const slot = slotOf(id);
    const pending = slot.pending;

    slot.generation += 1;
    slot.pending = null;

    if (!keepAge) {
      slot.at = null;
    }

    pending?.cancel();
  }

  /**
   * Свежий снимок не ждёт фонового refresh; устаревшие читатели делят один запрос.
   * Ручной читатель повышает общее разрешение, чтобы выключение не потеряло его клик.
   */
  function poll(id: string, mode: UsagePollMode, minAgeMs: number): Promise<void> {
    if (stopped || mode === 'automatic' && !enabled) {
      return Promise.resolve();
    }

    const slot = slotOf(id);

    if (slot.at !== null && now() - slot.at < minAgeMs) {
      return Promise.resolve();
    }
    if (slot.pending) {
      if (mode === 'manual') {
        slot.pending.mode = mode;
      }

      return slot.pending.promise;
    }

    const generation = slot.generation;
    let cancel: () => void = () => {};
    const cancelled = new Promise<boolean>((resolve) => {
      cancel = () => resolve(false);
    });
    const task: PendingPoll = {
      mode,
      cancel,
      promise: Promise.resolve(),
    };
    const isCurrent = () => !stopped && slot.generation === generation
      && (task.mode === 'manual' || enabled);
    const loading = Promise.resolve().then(async () => {
      if (!isCurrent()) {
        return false;
      }

      await load(id, { isCurrent });

      return true;
    });

    task.promise = Promise.race([loading, cancelled]).then(async (complete) => {
      if (!complete || !isCurrent()) {
        return poll(id, task.mode, minAgeMs);
      }

      slot.at = now();
    }, async (error: unknown) => {
      if (!isCurrent()) {
        return poll(id, task.mode, minAgeMs);
      }

      throw error;
    }).finally(() => {
      if (slot.pending === task) {
        slot.pending = null;
      }
    });
    slot.pending = task;

    return task.promise;
  }

  /**
   * Старые автоматические операции теряют право записи до подтверждения переключения.
   * Уже присоединённый ручной запрос продолжает владеть своим результатом.
   */
  function setEnabled(next: boolean): void {
    enabled = next;

    if (!next) {
      for (const [id, slot] of slots) {
        if (slot.pending?.mode === 'automatic') {
          invalidate(id, true);
        }
      }
    }
  }

  /**
   * Остановка не создаёт новый loader через перенаправление старых читателей.
   * Реальную отмену внешних операций и drain по-прежнему выполняет владелец модуля.
   */
  function stop(): void {
    stopped = true;

    for (const id of slots.keys()) {
      invalidate(id, true);
    }
  }

  return {
    poll,
    invalidate,
    setEnabled,
    isEnabled: () => enabled,
    stop,
  };
}

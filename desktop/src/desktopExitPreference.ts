import type { DesktopSettings } from './settings.ts';

export interface DesktopExitPreference {
  get(): boolean;
  set(value: boolean): Promise<void>;
  subscribe(listener: () => void): () => void;
}

/**
 * Согласие хранится только явным boolean true.
 * Мусор и отсутствие поля сохраняют вопрос по умолчанию.
 */
export function normalizeExitPreference(value: unknown): boolean {
  return value === true;
}

/**
 * Remember и настройки используют один принятый выбор и последовательную запись.
 * Отказ writer возвращает прежнее поле, не публикуя несохранённое согласие.
 */
export function createDesktopExitPreference(options: {
  settings: DesktopSettings;
  save(): Promise<void>;
}): DesktopExitPreference {
  const listeners = new Set<() => void>();
  let accepted = normalizeExitPreference(options.settings.skipExitConfirmation);
  let queue = Promise.resolve();

  /**
   * Каждая запись меняет только своё поле общего объекта настроек.
   * Подписчики получают изменение после успешного атомарного сохранения.
   */
  function set(value: boolean): Promise<void> {
    const pending = queue.catch(() => {}).then(async () => {
      const previous = options.settings.skipExitConfirmation;

      options.settings.skipExitConfirmation = value;

      try {
        await options.save();
      } catch (error) {
        if (previous === undefined) {
          delete options.settings.skipExitConfirmation;
        } else {
          options.settings.skipExitConfirmation = previous;
        }

        throw error;
      }

      accepted = value;

      for (const listener of listeners) {
        listener();
      }
    });

    queue = pending;

    return pending;
  }

  return {
    get: () => accepted,
    set,
    subscribe(listener) {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
  };
}

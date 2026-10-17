// Общий бюджет контекстов и памяти одного графа модулей viewer.
// Временный резерв загрузки передаёт владение опубликованной модели без двойного учёта.
import { VIEWER_MEMORY } from './resourcePolicy.ts';

let contexts = 0;
let heldMemory = 0;

export interface ViewerModelLease {
  release(): void;
}

export interface ViewerLoadLease {
  reserve(amount: number): void;
  publish(amount: number): ViewerModelLease;
  release(): void;
}

/**
 * Временный резерв и память опубликованной модели имеют разное время жизни.
 * Reserve принимает абсолютный объём, а release снимает только свою долю.
 */
export function createViewerLease(): ViewerLoadLease {
  let temporaryMemory = 0;

  return {
    /**
     * Резерв растёт до абсолютного максимума загрузки, а не на каждом куске потока.
     * Собственная доля вычитается до проверки общего предела.
     */
    reserve(amount) {
      const next = Math.max(temporaryMemory, amount);

      if (heldMemory - temporaryMemory + next > VIEWER_MEMORY) {
        throw new Error('Загрузка и две модели превышают общий бюджет 1024 МиБ.');
      }

      heldMemory += next - temporaryMemory;
      temporaryMemory = next;
    },
    /**
     * Публикация заменяет временный резерв долей модели в одной точке учёта.
     * При отказе обе прежние доли остаются нетронутыми.
     */
    publish(amount) {
      if (heldMemory - temporaryMemory + amount > VIEWER_MEMORY) {
        throw new Error('Две модели превышают общий бюджет 1024 МиБ.');
      }

      heldMemory += amount - temporaryMemory;
      temporaryMemory = 0;

      let released = false;

      return {
        release() {
          if (released) {
            return;
          }

          released = true;
          heldMemory = Math.max(0, heldMemory - amount);
        }
      };
    },
    release() {
      heldMemory = Math.max(0, heldMemory - temporaryMemory);
      temporaryMemory = 0;
    }
  };
}

/**
 * Лимит проверяется до конструктора WebGLRenderer, который может завершиться ошибкой.
 * Неудавшийся конструктор не занимает слот.
 */
export function checkViewerContext(): void {
  if (contexts >= 2) {
    throw new Error('Уже открыты два 3D холста. Закройте сравнение или другое окно.');
  }
}

/**
 * Успешно созданный renderer занимает контекст до идемпотентного освобождения.
 * Счётчик общий для обоих холстов сравнения.
 */
export function claimViewerContext(): () => void {
  contexts += 1;

  let released = false;

  return () => {
    if (released) {
      return;
    }

    released = true;
    contexts = Math.max(0, contexts - 1);
  };
}

/**
 * Диагностика читает общий бюджет текущего графа модулей.
 * Счётчики не принадлежат отдельному renderer.
 */
export function viewerDiagnostics(): { contexts: number; memory: number } {
  return { contexts, memory: heldMemory };
}

import { onBeforeUnmount, shallowReactive } from 'vue';

import { useUiContextStore } from '../stores/ui-context.js';

// Что компонент рассказывает о себе кокпиту. Слой отвечает на «где человек сейчас»,
// приоритет разводит одновременно открытые слои, `details` — свободная форма самого
// раздела: её читает агент, и придумывать ей общую схему здесь нечем.
export interface UiContextDescriptor {
  layer: string;
  active: boolean;
  routingScope: string | null;
  details: Record<string, unknown> | null;
  priority?: number;
}

// То, что компонент передаёт при обновлении: любое подмножество дескриптора.
// Отсутствие поля и его сброс — разные вещи, поэтому проверяется наличие ключа.
export type UiContextPatch = Partial<UiContextDescriptor>;

// Ручка компонента в реестре контекста. Каждый метод отвечает, изменилось ли
// состояние: повторный вызов на уже снятом источнике — не ошибка, а «нет».
export interface UiContextSource {
  update: (next?: UiContextPatch) => boolean;
  focus: (next?: UiContextPatch) => boolean;
  blur: (next?: UiContextPatch) => boolean;
  dispose: () => boolean;
}

// Стор ещё на JavaScript, и вывод типов не знает форму его ручки. Объявлено ровно то,
// что зовёт этот файл: реестр возвращает замороженный объект из трёх методов.
interface RegistryOwner {
  update: (value: UiContextDescriptor) => boolean;
  focus: () => boolean;
  dispose: () => boolean;
}

const DESCRIPTOR_KEYS = ['layer', 'priority', 'active', 'routingScope', 'details'] as const;

const owns = (value: object, key: string): boolean => (
  Object.prototype.hasOwnProperty.call(value, key)
);

/**
 * Источник UI-контекста, принадлежащий компоненту.
 *
 * `update()` меняет устойчивый реактивный дескриптор, затем уведомляет владельца реестра.
 * Обновление владельца увеличивает только публичную ревизию реактивного стора, но не focusRevision:
 * обновлённые заголовки и статусы инвалидируют вычисленные снимки, не отнимая фокус
 * у слоя, открытого позже. Только явный `focus()` увеличивает focusRevision.
 */
export function useUiContextSource(id: string, initial: UiContextPatch = {}): UiContextSource {
  const ui = useUiContextStore() as { register: (id: string, value: unknown) => RegistryOwner };
  const descriptor = shallowReactive<UiContextDescriptor>({
    layer: initial.layer || 'background',
    active: initial.active !== false,
    routingScope: initial.routingScope ?? null,
    details: initial.details ?? null,
    ...(Number.isFinite(initial.priority) ? { priority: Number(initial.priority) } : {}),
  });
  const owner = ui.register(id, descriptor);
  let disposed = false;

  /**
   * Переносит присланные поля в устойчивый дескриптор. Приоритет без числа означает
   * «его нет вовсе»: оставленный ноль поставил бы слой в конец очереди вместо снятия.
   */
  function update(next: UiContextPatch = {}): boolean {
    if (disposed || !next || typeof next !== 'object') {
      return false;
    }

    for (const key of DESCRIPTOR_KEYS) {
      if (!owns(next, key)) {
        continue;
      }
      if (key === 'priority' && !Number.isFinite(next.priority)) {
        delete descriptor.priority;
      } else {
        Object.assign(descriptor, { [key]: next[key] });
      }
    }

    // capture() намеренно читает только дескрипторы данных, без геттеров. Vue не
    // гарантирует, что getOwnPropertyDescriptor создаёт реактивную зависимость, поэтому
    // одной мутации устойчивого прокси недостаточно: вычисленный снимок мог бы остаться в кэше навсегда.
    return owner.update(descriptor);
  }

  /**
   * Забирает фокус контекста себе. Только этот путь двигает focusRevision: обычное
   * обновление заголовка не имеет права отнимать внимание у открытого позже слоя.
   */
  function focus(next?: UiContextPatch): boolean {
    if (disposed) {
      return false;
    }
    if (next !== undefined) {
      update(next);
    }

    descriptor.active = true;

    return owner.focus();
  }

  /**
   * Отдаёт фокус, оставаясь зарегистрированным. Снятие с учёта — это `dispose()`:
   * закрытая панель и неактивная панель для агента разные состояния.
   */
  function blur(next?: UiContextPatch): boolean {
    if (disposed) {
      return false;
    }
    if (next !== undefined) {
      update(next);
    }

    descriptor.active = false;

    return owner.update(descriptor);
  }

  /** Снимает источник с учёта. Повторный вызов безопасен и отвечает `false`. */
  function dispose(): boolean {
    if (disposed) {
      return false;
    }

    disposed = true;

    return owner.dispose();
  }

  onBeforeUnmount(dispose);

  return Object.freeze({
    update,
    focus,
    blur,
    dispose,
  });
}

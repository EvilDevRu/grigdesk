import { onBeforeUnmount, shallowReactive } from 'vue';
import { useUiContextStore } from '../stores/ui-context.js';

const DESCRIPTOR_KEYS = ['layer', 'priority', 'active', 'routingScope', 'details'];
const owns = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

/**
 * Источник UI-контекста, принадлежащий компоненту.
 *
 * `update()` меняет устойчивый реактивный дескриптор, затем уведомляет владельца реестра.
 * Обновление владельца увеличивает только публичную ревизию реактивного стора, но не focusRevision:
 * обновлённые заголовки и статусы инвалидируют вычисленные снимки, не отнимая фокус
 * у слоя, открытого позже. Только явный `focus()` увеличивает focusRevision.
 */
export function useUiContextSource(id, initial = {}) {
  const ui = useUiContextStore();
  const descriptor = shallowReactive({
    layer: initial.layer || 'background',
    active: initial.active !== false,
    routingScope: initial.routingScope ?? null,
    details: initial.details ?? null,
    ...(Number.isFinite(initial.priority) ? { priority: Number(initial.priority) } : {}),
  });
  const owner = ui.register(id, descriptor);
  let disposed = false;

  function update(next = {}) {
    if (disposed || !next || typeof next !== 'object') return false;
    for (const key of DESCRIPTOR_KEYS) {
      if (!owns(next, key)) continue;
      if (key === 'priority' && !Number.isFinite(next.priority)) delete descriptor.priority;
      else descriptor[key] = next[key];
    }
    // capture() намеренно читает только дескрипторы данных, без геттеров. Vue не
    // гарантирует, что getOwnPropertyDescriptor создаёт реактивную зависимость, поэтому
    // одной мутации устойчивого прокси недостаточно: вычисленный снимок мог бы остаться в кэше навсегда.
    return owner.update(descriptor);
  }

  function focus(next) {
    if (disposed) return false;
    if (next !== undefined) update(next);
    descriptor.active = true;
    return owner.focus();
  }

  function blur(next) {
    if (disposed) return false;
    if (next !== undefined) update(next);
    descriptor.active = false;
    return owner.update(descriptor);
  }

  function dispose() {
    if (disposed) return false;
    disposed = true;
    return owner.dispose();
  }

  onBeforeUnmount(dispose);
  return Object.freeze({ update, focus, blur, dispose });
}

import type { Router } from 'vue-router';
import { useSettingsStore, type SettingsOpenRequest } from '../stores/settings.ts';

interface SettingsOpenPort {
  requestOpen(request: SettingsOpenRequest): unknown;
}

const openListeners = new WeakMap<EventTarget, () => void>();

/**
 * Все кнопки обращаются к одной сессии текущего документа, без смены маршрута.
 * Пустая цель сохраняет принятое правило выбора последней страницы.
 */
export function openSettings(request: SettingsOpenRequest = {}): boolean {
  return useSettingsStore().requestOpen({ source: 'button', ...request });
}

/**
 * Старый маршрут открывает общий модал во всех режимах, сохраняя работающую страницу.
 * Первый вход заменяется доской; запрос хранится в store до подтверждённой авторизации.
 */
export function installSettingsRouteGuard(router: Router, settings: SettingsOpenPort): () => void {
  return router.beforeEach((to, from) => {
    if (to.name !== 'settings') {
      return true;
    }

    const page = typeof to.query.page === 'string' ? to.query.page : undefined;

    settings.requestOpen({ source: 'route', queryPage: page });

    return from.matched.length === 0 ? { name: 'board', replace: true } : false;
  });
}

/**
 * Единственный слушатель принимает лишь факт нативной команды, не event.detail.
 * Повторная установка снимает прежний обработчик, disposer безопасен для HMR.
 */
export function installSettingsOpenListener(
  target: EventTarget,
  open: (request: SettingsOpenRequest) => unknown,
): () => void {
  openListeners.get(target)?.();

  const handler = () => open({ source: 'shortcut' });
  const dispose = () => {
    target.removeEventListener('grigdesk:open-settings', handler);

    if (openListeners.get(target) === dispose) {
      openListeners.delete(target);
    }
  };

  target.addEventListener('grigdesk:open-settings', handler);
  openListeners.set(target, dispose);

  return dispose;
}

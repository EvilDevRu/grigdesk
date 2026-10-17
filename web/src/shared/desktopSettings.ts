import type { Router } from 'vue-router';

import { desktopDocumentMode, settingsWindowUrl } from '../../../shared/desktop/desktopWindowContract.ts';
import type { DesktopDocumentMode } from '../../../shared/desktop/desktopWindowContract.ts';

let cachedMode: DesktopDocumentMode | null = null;

/**
 * Роль фиксируется один раз для документа до монтирования приложения.
 * Смена query после старта не меняет оболочку уже работающего окна.
 */
export function currentDesktopMode(): DesktopDocumentMode {
  cachedMode ??= desktopDocumentMode(navigator.userAgent, location.search);

  return cachedMode;
}

/**
 * Главное окно передаёт запрос специальным адресом в guard Electron.
 * Возвращённый null штатен: главный процесс создаёт окно и отвечает deny.
 */
export function openSettingsWindow(): void {
  window.open(settingsWindowUrl(window.location.href));
}

/**
 * В desktop-main переход сохраняет смонтированную страницу и открывает модальное окно.
 * Первая навигация документа перенаправляется на доску без создания окна настроек.
 */
export function installSettingsRouteGuard(
  router: Router,
  mode: DesktopDocumentMode,
  open: () => void,
): () => void {
  if (mode !== 'main') {
    return () => { };
  }

  return router.beforeEach((to, from) => {
    if (to.name !== 'settings') {
      return true;
    }

    if (from.matched.length === 0) {
      return { name: 'board', replace: true };
    }

    open();

    return false;
  });
}

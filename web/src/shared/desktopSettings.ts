import { desktopDocumentMode } from '../../../shared/desktop/desktopWindowContract.ts';
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

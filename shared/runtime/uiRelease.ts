export const UI_RELEASE_VERSION = 1;
export const UI_RELEASE_PREFIX = '/ui/';
export const UI_RELEASE_ID = /^[a-f0-9]{64}$/;

/**
 * Версия адресует весь неизменяемый набор файлов, включая основной документ.
 * API остаётся на прежнем origin, поэтому cookie и общий SSE не меняют владельца.
 */
export function uiReleaseUrl(origin: string, id: string): string {
  if (!UI_RELEASE_ID.test(id)) {
    throw new Error('Некорректная версия интерфейса.');
  }

  return `${origin}${UI_RELEASE_PREFIX}${id}/`;
}

/**
 * Только корень известной версии является документом интерфейса.
 * Ресурсы, похожие префиксы и произвольные пути не становятся адресом настроек.
 */
export function isUiDocumentPath(pathname: string): boolean {
  return pathname === '/' || /^\/ui\/[a-f0-9]{64}\/$/.test(pathname);
}

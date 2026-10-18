import { isUiDocumentPath } from '../runtime/uiRelease.ts';

export const TERMINAL_INSERT_LIMIT_BYTES = 16384;

export type DesktopWindowRole = 'main';
export type DesktopDocumentMode = 'page' | 'main';

/**
 * Только точный адрес своего HTTP-документа означает запрос модального окна.
 * Похожие query, пути и внешние адреса сохраняют обычную политику навигации.
 */
export function isSettingsWindowRequest(target: string, origin: string): boolean {
  try {
    const url = new URL(target);

    return url.protocol === 'http:' && !url.username && !url.password
      && url.origin === origin && isUiDocumentPath(url.pathname)
      && url.search === '?window=settings' && url.hash === '#/settings';
  } catch {
    return false;
  }
}

/**
 * Роль относится к конкретному документу, поэтому прежние маркеры удаляются.
 * Повторная установка не создаёт неоднозначный комплект токенов.
 */
export function desktopUserAgent(base: string, role: DesktopWindowRole): string {
  const tokens = base.split(/\s+/).filter((token) => token
    && !token.startsWith('GrigDeskSettings/') && !token.startsWith('GrigDeskWindow/'));

  return [...tokens, 'GrigDeskSettings/1', `GrigDeskWindow/${role}`].join(' ');
}

/**
 * Неполный или повторённый комплект не определяет роль документа.
 * Проверяются целые токены, чтобы подстрока чужого UA не включала режим.
 */
export function desktopWindowRole(userAgent: string): DesktopWindowRole | null {
  const tokens = userAgent.split(/\s+/);
  const versions = tokens.filter((token) => token.startsWith('GrigDeskSettings/'));
  const roles = tokens.filter((token) => token.startsWith('GrigDeskWindow/'));

  if (versions.length !== 1 || versions[0] !== 'GrigDeskSettings/1' || roles.length !== 1) {
    return null;
  }

  if (roles[0] === 'GrigDeskWindow/main') {
    return 'main';
  }

  return null;
}

/**
 * Только полная роль главного окна включает системный заголовок.
 * Старый query настроек остаётся обычным адресом того же документа.
 */
export function desktopDocumentMode(userAgent: string, _search: string): DesktopDocumentMode {
  return desktopWindowRole(userAgent) === 'main' ? 'main' : 'page';
}

/**
 * Команда передаётся только как текст без управляющих клавиш.
 * Лимит считается в байтах UTF-8, Enter в намерение не входит.
 */
export function validTerminalInsert(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value)
    && new TextEncoder().encode(value).byteLength <= TERMINAL_INSERT_LIMIT_BYTES;
}

/**
 * Ключ чата ограничен длиной и не содержит управляющих символов.
 * Значение остаётся адресом чата, а не произвольным действием страницы.
 */
export function validChatKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
    && !/[\u0000-\u001f\u007f]/.test(value);
}

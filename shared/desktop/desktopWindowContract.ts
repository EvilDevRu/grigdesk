import { isUiDocumentPath } from '../runtime/uiRelease.ts';

export const DESKTOP_WINDOW_VERSION = 1;
export const SETTINGS_CHANNEL_NAME = 'grigdesk-desktop-settings-v1';
export const TERMINAL_INSERT_LIMIT_BYTES = 16384;
export const INTENT_TIMEOUT_MS = 5000;

export type DesktopWindowRole = 'main' | 'settings';
export type DesktopDocumentMode = 'page' | 'main' | 'settings';
export type SettingsWindowMessage =
  | { version: 1; type: 'settings-changed' }
  | {
    version: 1;
    type: 'terminal-request';
    requestId: string;
    insert: string
  }
  | {
    version: 1;
    type: 'open-chat-request';
    requestId: string;
    chatKey: string
  }
  | {
    version: 1;
    type: 'intent-result';
    requestId: string;
    ok: boolean
  };

/**
 * Собирает единственный адрес запроса окна настроек.
 * Hash и query являются частью точного контракта двух процессов.
 */
export function settingsWindowUrl(address: string): string {
  const url = new URL(address);
  const pathname = isUiDocumentPath(url.pathname) ? url.pathname : '/';

  return `${url.origin}${pathname}?window=settings#/settings`;
}

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

  return roles[0] === 'GrigDeskWindow/settings' ? 'settings' : null;
}

/**
 * Query подтверждает предназначение отдельного окна настроек.
 * Обычный документ без полного комплекта остаётся страницей браузера.
 */
export function desktopDocumentMode(userAgent: string, search: string): DesktopDocumentMode {
  const role = desktopWindowRole(userAgent);

  if (role === 'main') {
    return 'main';
  }

  return role === 'settings' && search === '?window=settings' ? 'settings' : 'page';
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

/**
 * Декодер принимает только известные поля и создаёт собственный объект.
 * Данные другого документа не получают эффект до проверки каждого значения.
 */
export function decodeSettingsWindowMessage(value: unknown): SettingsWindowMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !('version' in value) || value.version !== 1 || !('type' in value)) {
    return null;
  }

  const fields = Object.keys(value).sort().join(',');

  if (value.type === 'settings-changed') {
    return fields === 'type,version' ? { version: 1, type: value.type } : null;
  }

  if (!('requestId' in value) || typeof value.requestId !== 'string'
    || !/^[A-Za-z0-9_-]{1,64}$/.test(value.requestId)) {
    return null;
  }

  const requestId = value.requestId;

  if (value.type === 'terminal-request' && fields === 'insert,requestId,type,version'
    && 'insert' in value && validTerminalInsert(value.insert)) {
    return {
      version: 1,
      type: 'terminal-request',
      requestId,
      insert: value.insert
    };
  }

  if (value.type === 'open-chat-request' && fields === 'chatKey,requestId,type,version'
    && 'chatKey' in value && validChatKey(value.chatKey)) {
    return {
      version: 1,
      type: 'open-chat-request',
      requestId,
      chatKey: value.chatKey
    };
  }

  if (value.type === 'intent-result' && fields === 'ok,requestId,type,version'
    && 'ok' in value && typeof value.ok === 'boolean') {
    return {
      version: 1,
      type: 'intent-result',
      requestId,
      ok: value.ok
    };
  }

  return null;
}

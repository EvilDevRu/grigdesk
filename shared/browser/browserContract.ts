import { isPlainRecord } from '../lib/objects.ts';

export interface BrowserPreferences {
  open: 'external' | 'internal';
  external: string;
  agents: boolean;
  search: 'yandex' | 'google';
}

/**
 * Иконка сайта передаётся в UI только встроенным изображением ограниченного размера.
 * Сетевые URL и исполняемые схемы не заставляют привилегированный документ делать запросы.
 */
export function browserFavicon(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 350_000) {
    return null;
  }

  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/u.exec(value);
  const type = /^image\/(?:png|jpeg|gif|webp|avif|svg\+xml|x-icon|vnd\.microsoft\.icon)$/u;

  return match && type.test(match[1]!) ? value : null;
}

/**
 * Повреждённый файл настроек сохраняет безопасные независимые defaults.
 * Идентификатор приложения не является командой или файловым путём.
 */
export function normalizeBrowserPreferences(value: unknown): BrowserPreferences {
  const source = isPlainRecord(value) ? value : {};
  const external = typeof source.external === 'string'
    && /^(system|app:[a-zA-Z0-9._-]{1,160})$/u.test(source.external)
    ? source.external : 'system';

  return {
    open: source.open === 'internal' ? 'internal' : 'external',
    external,
    agents: source.agents === true,
    search: source.search === 'google' ? 'google' : 'yandex',
  };
}

/**
 * Адресная строка человека принимает домены без схемы и поисковые запросы.
 * Строгий IPC URL-контракт остаётся отдельным: нестандартные схемы и credentials запрещены.
 */
export function browserAddress(value: string, search: BrowserPreferences['search']): string {
  const input = value.trim();

  if (!input || input.length > 8192 || /[\u0000-\u001f\u007f]/u.test(input)) {
    throw new Error('invalid_browser_url');
  }

  if (/^https?:/iu.test(input)) {
    return browserUrl(input);
  }

  const host = input.split(/[/?#]/u, 1)[0]!;
  const address = /^(?:localhost|\[[\da-f:]+\]|[^\s:@]+\.[^\s:@]+)(?::\d{1,5})?$/iu.test(host);

  if (address && !/\s/u.test(input)) {
    const local = /^(?:localhost|127(?:\.\d+){3}|\[::1\])(?::|$)/iu.test(host);

    return browserUrl(`${local ? 'http' : 'https'}://${input}`);
  }

  if (/^[a-z][a-z\d+.-]*:/iu.test(input) || /^\/\//u.test(input)
    || /^[^\s/]*@[^\s/]+(?:\/|$)/u.test(input)) {
    throw new Error('invalid_browser_url');
  }

  const url = new URL(search === 'google' ? 'https://www.google.com/search' : 'https://yandex.ru/search/');

  url.searchParams.set(search === 'google' ? 'q' : 'text', input);

  return browserUrl(url.href);
}

/**
 * В браузер и системный launcher попадает только абсолютный web URL.
 * Credentials, управляющие символы и альтернативные схемы отклоняются до эффекта.
 */
export function browserUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u0020]/u.test(value)) {
    throw new Error('invalid_browser_url');
  }

  const url = new URL(value);

  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('invalid_browser_url');
  }

  return url.href;
}

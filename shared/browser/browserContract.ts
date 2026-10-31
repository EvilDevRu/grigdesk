import { isPlainRecord } from '../lib/objects.ts';

export interface BrowserPreferences {
  open: 'external' | 'internal';
  external: string;
  agents: boolean;
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
  };
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

import { installError } from './errors.ts';

/**
 * Адрес нормализуется до команд; исходный URL не включается в отказ.
 * Разбор сохраняет регистр пути и убирает завершающий slash.
 */
export function normalizeGitUrl(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw installError('source_url_invalid');
  }

  const text = raw.trim();

  if (!text || text.length > 512 || /[\s\u0000-\u001f\u007f]/u.test(text) || text.startsWith('-')) {
    throw installError('source_url_invalid');
  }

  try {
    const short = /^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):([A-Za-z0-9._~/-]+)$/u.exec(text);

    if (short) {
      const remotePath = short[3] ?? '';

      if ((short[1] ?? '').startsWith('-') || (short[2] ?? '').startsWith('-')
        || remotePath.startsWith('-') || remotePath.split('/').includes('..')) {
        throw installError('source_url_invalid');
      }

      return text;
    }

    const url = new URL(text);
    const authority = text.split('/')[2] ?? '';

    if (text.includes('?') || text.includes('#') || !url.pathname || url.pathname === '/') {
      throw installError('source_url_invalid');
    }

    if (!['https:', 'ssh:', 'file:'].includes(url.protocol)) {
      throw installError('source_url_invalid');
    }

    if (url.protocol === 'https:' && (url.username || url.password || authority.includes('@'))) {
      throw installError('source_url_invalid');
    }

    if (url.protocol === 'file:' && (!text.startsWith('file:///') || url.host || url.pathname === '/')) {
      throw installError('source_url_invalid');
    }

    if (url.password) {
      throw installError('source_url_invalid');
    }

    if (url.protocol === 'ssh:') {
      const userName = decodeURIComponent(url.username);
      const hostName = decodeURIComponent(url.hostname);

      if (!hostName || userName.startsWith('-') || hostName.startsWith('-')
        || /[\u0000-\u001f\u007f]/u.test(userName + hostName)) {
        throw installError('source_url_invalid');
      }
    }

    const user = url.protocol === 'ssh:' && url.username ? `${url.username}@` : '';

    return `${url.protocol}//${user}${url.host}${url.pathname.replace(/\/+$/u, '')}`;
  } catch {
    throw installError('source_url_invalid');
  }
}

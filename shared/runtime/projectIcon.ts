// Ограниченный raster data URL не создаёт сетевых запросов и ссылок на файлы.
// Один контракт работает на входе паспорта и при чтении недоверенных prefs.
export const PROJECT_ICON_MAX_LENGTH = 32768;

/**
 * Принимает только маленький PNG с ограниченной геометрией.
 * Полное декодирование выполняет браузер; сломанная картинка имеет буквенный fallback.
 */
export function projectIcon(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > PROJECT_ICON_MAX_LENGTH
    || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    return null;
  }

  try {
    const bytes = atob(value.slice('data:image/png;base64,'.length));
    const signature = '\x89PNG\r\n\x1a\n';

    if (bytes.length < 45 || !bytes.startsWith(signature) || bytes.slice(12, 16) !== 'IHDR'
      || bytes.slice(-8, -4) !== 'IEND') {
      return null;
    }

    const numberAt = (offset: number) => [0, 1, 2, 3].reduce(
      (result, index) => result * 256 + bytes.charCodeAt(offset + index), 0,
    );
    const width = numberAt(16);
    const height = numberAt(20);

    return width >= 1 && width <= 64 && height >= 1 && height <= 64 ? value : null;
  } catch {
    return null;
  }
}

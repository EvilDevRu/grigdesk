import { isRecord } from '../../../../shared/lib/objects.ts';
import { readTextOrNull } from '../../../../shared/node/files.ts';
import { BUILTIN_DRIVER_SOURCES } from '../../../../shared/trackers/driverSources.ts';

export { BUILTIN_DRIVER_SOURCES } from '../../../../shared/trackers/driverSources.ts';

export interface DriverSource {
  title: string;
  url: string;
}

/**
 * Локальная надстройка принимается целиком: неоднозначный URL отменяет весь файл.
 * Ярлыки и адреса очищаются от краевых пробелов, содержимое пакетов здесь не проверяется.
 */
function parseSources(raw: unknown): DriverSource[] {
  if (!Array.isArray(raw)) {
    throw new Error('Ожидается массив источников');
  }

  const urls = new Set<string>();

  return raw.map((entry) => {
    if (!isRecord(entry) || typeof entry.title !== 'string' || !entry.title.trim()
      || typeof entry.url !== 'string' || !entry.url.trim()) {
      throw new Error('Ожидаются непустые title и url');
    }

    const title = entry.title.trim();
    const url = entry.url.trim();
    const parsed = new URL(url);

    if (!['http:', 'https:'].includes(parsed.protocol) || urls.has(url)) {
      throw new Error('Нужны уникальные HTTP(S) адреса');
    }

    urls.add(url);

    return { title, url };
  });
}

/**
 * Файл расширяет встроенные ярлыки по URL и никогда не участвует в регистрации драйверов.
 * Отсутствие файла штатно; прочие отказы оставляют встроенный каталог и предупреждение.
 */
export async function readDriverSources(
  file: string,
  log: { warn(message: string): void },
): Promise<DriverSource[]> {
  let local: DriverSource[] = [];

  try {
    const text = await readTextOrNull(file);

    if (text !== null) {
      local = parseSources(JSON.parse(text));
    }
  } catch {
    log.warn('Файл driver-sources.json не читается или имеет неверный формат; '
      + 'локальные источники проигнорированы.');
  }

  const merged = new Map([...BUILTIN_DRIVER_SOURCES, ...local].map((source) => [source.url, { ...source }]));

  return [...merged.values()];
}

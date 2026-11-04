import { createHash } from 'node:crypto';

export interface TrackerIdentity {
  baseUrl: string;
  userId: string;
}

/**
 * Адрес нормализуется прежним способом: завершающий слеш, query и hash не меняют scope.
 * Путь подключения остаётся частью ключа, как у уже сохранённых личных подборок.
 */
function normalizedPortal(baseUrl: unknown): string {
  const url = new URL(String(baseUrl));

  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';

  return url.toString().replace(/\/$/, '');
}

/**
 * Личный scope выводится сервером; строковый id допускает любые идентификаторы драйвера.
 * Формула portal\0userId сохранена побитово для чтения прежних favorites, seen и shelf.
 */
export function trackerAccountScope(identity: TrackerIdentity | null | undefined): string {
  const userId = String(identity?.userId ?? '').trim();

  if (!userId) {
    throw new Error('Пустой идентификатор пользователя трекера');
  }

  const portal = normalizedPortal(identity?.baseUrl);

  return createHash('sha256').update(`${portal}\0${userId}`).digest('hex');
}

import { dbApi } from '../../shared/dbApi.ts';
import type { DbProfile, DbProfileInput, DbSession } from '../../../../shared/plugins/db/dbContracts.ts';
import { useDbStore } from '../../stores/db.ts';
import { loadDb } from './loadDb.ts';

/**
 * Новый профиль или правка существующего. После записи раздел перечитывается
 * целиком: правка профиля может закрыть его живые сессии, и список обязан это
 * показать, а не остаться со вкладкой закрытого подключения.
 */
export async function saveDbProfile(profile: DbProfileInput): Promise<DbProfile> {
  const saved = await dbApi.saveProfile(profile);

  await loadDb();

  return saved;
}

/**
 * Удаление профиля. Его живые сессии сервер закрывает сам: держать открытым вход
 * в базу, описания которой больше нет, значило бы потерять его из виду.
 */
export async function deleteDbProfile(id: string): Promise<void> {
  const store = useDbStore();

  await dbApi.deleteProfile(id);
  store.dropProfile(id);
}

/**
 * Вход паролем. Сессию открывает сервер, а вкладка получает её отражение; профиль
 * через туннель называет свою SSH-сессию — сервер не выбирает её за человека.
 */
export async function openDbSession(
  profileId: string,
  password: string,
  sshSessionId = '',
): Promise<DbSession> {
  const store = useDbStore();
  const session = await dbApi.openSession(profileId, password, sshSessionId);

  store.upsertSession(session);

  return session;
}

import { dbApi } from '../../shared/dbApi.ts';
import type { DbResult } from '../../../../shared/plugins/db/dbContracts.ts';
import { useDbStore } from '../../stores/db.ts';

/**
 * Явное закрытие сессии человеком. Вместе с сессией уходит и её схема: та
 * относилась к конкретному подключению, а не к профилю вообще.
 */
export async function closeDbSession(id: string): Promise<void> {
  const store = useDbStore();

  await dbApi.closeSession(id);
  store.dropSession(id);
}

/**
 * Доступ агента к сессии. Потерянная сессия отвечает машинным кодом вместо записи —
 * тогда список не трогаем: строка останется прежней до ближайшего снимка, а
 * подставлять в неё отказ значило бы показать несуществующую сессию.
 */
export async function setDbAgentAccess(id: string, allowed: boolean): Promise<void> {
  const store = useDbStore();
  const result = await dbApi.setAgentAccess(id, allowed);

  if (result.session) {
    store.patchSession(id, result.session);
  }
}

/**
 * Схема сессии. Она привязана к её идентификатору, чтобы поздний ответ не сменил
 * содержимое другой вкладки, пока человек уже смотрит на соседнюю базу.
 */
export async function loadDbSchema(id: string): Promise<DbResult> {
  const store = useDbStore();
  const schema = await dbApi.schema(id);

  store.setSchema(id, schema);

  return schema;
}

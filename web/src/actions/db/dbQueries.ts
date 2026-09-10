import { dbApi } from '../../shared/dbApi.ts';
import type { DbCancelOutcome } from '../../../../shared/dbContracts.ts';
import { useDbStore } from '../../stores/db.ts';
import { refreshDbQueries } from './loadDb.ts';

// Нажатие «Прервать» обязано что-то ответить: часть команд снять нельзя вовсе,
// а часть снимается только вместе с соединением — и тогда сессии больше нет.
const CANCEL_FAILURES: Record<string, string> = {
  cancel_not_supported: 'Команда уже выполняется на сервере и прервать её нечем — дождитесь ответа.',
  cancel_failed: 'Прервать запрос не удалось.',
  not_found: 'Запрос уже завершился.',
};

/**
 * Текст исхода отмены. Успех молчит, кроме одного случая: снятый вместе с
 * соединением запрос закрыл и сессию, и человеку придётся открывать её заново.
 */
function cancelNotice(outcome: DbCancelOutcome): string {
  if (outcome.ok) {
    return outcome.method === 'connection'
      ? 'Запрос снят вместе с соединением — сессия закрыта, откройте её заново.'
      : '';
  }

  return CANCEL_FAILURES[String(outcome.error)] || 'Прервать запрос не удалось.';
}

/**
 * Запуск запроса. Ответ базы приходит позже живой лентой, поэтому здесь возвращается
 * только идентификатор: панель запоминает его и ждёт результат по нему.
 */
export async function runDbQuery(
  sessionId: string,
  text: string,
  params: unknown[] = [],
): Promise<string> {
  const queryId = await dbApi.runQuery(sessionId, text, params);

  await refreshDbQueries();

  return queryId;
}

/**
 * Отмена запроса. Серверное объяснение сохраняется как есть: невозможность прервать
 * команду — это факт для человека, а не повод показать общее «не удалось».
 */
export async function cancelDbQuery(queryId: string): Promise<DbCancelOutcome> {
  const store = useDbStore();
  const outcome = await dbApi.cancelQuery(queryId);

  store.setCancelNotice(cancelNotice(outcome));
  await refreshDbQueries();

  return outcome;
}

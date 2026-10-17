import type { DbProfile, DbQuery, DbSession } from '../../shared/plugins/db/dbContracts.ts';
import { parseDbQueries, parseDbSessions } from '../../shared/plugins/db/dbContracts.ts';
import { dbApi } from '../../web/src/shared/dbApi.ts';
import { runDbQuery, setDbAgentAccess, useDbStore } from '../../web/src/actions/db';

type IsUnchecked<Value> = 0 extends (1 & Value) ? true : false;
type Checked<Value extends false> = Value;

export type ProfileIsChecked = Checked<IsUnchecked<DbProfile>>;
export type SessionIsChecked = Checked<IsUnchecked<DbSession>>;
export type ApiSessionsIsChecked = Checked<IsUnchecked<Awaited<ReturnType<typeof dbApi.sessions>>>>;

/**
 * Примеры запускает только компилятор. Роль подключения и состояние запроса — рубежи
 * решений: по первой видно, что вообще разрешено, по второму — идёт запрос ещё или
 * уже снят. Непроверенный JSON не имеет права стать ни тем, ни другим.
 */
function checkContracts(input: unknown, store: ReturnType<typeof useDbStore>): void {
  // @ts-expect-error Непроверенный JSON не является списком сессий.
  const unchecked: DbSession[] = input;
  // @ts-expect-error Роль подключения закрыта перечислением.
  const role: DbProfile['role'] = 'админ';
  // @ts-expect-error Состояние запроса закрыто перечислением.
  const state: DbQuery['state'] = 'думает';
  // @ts-expect-error Доступ агента снимается и выдаётся булевым решением.
  setDbAgentAccess('session-a', 'yes');
  // @ts-expect-error Запуск запроса называет сессию и сам текст.
  runDbQuery('session-a');
  // @ts-expect-error Стор состояния сам в сеть не ходит.
  store.load();

  const sessions = parseDbSessions(input);
  const queries = parseDbQueries(input);

  // @ts-expect-error Список сессий может быть пустым.
  sessions[0].label.trim();
  // @ts-expect-error Результата у идущего запроса ещё нет.
  queries[0]?.result.rows.length;

  void [unchecked, role, state];
}

void checkContracts;

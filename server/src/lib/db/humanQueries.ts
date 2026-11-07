import { randomUUID } from 'node:crypto';

import { cancelDbQuery } from './broker.ts';
import { normalizeDbFailure, normalizeDbResult } from './result.ts';
import type { DbQueryFailure, LimitedDbResult, LimitOptions } from './result.ts';
import type { createDbSessionManager } from './sessionManager.ts';

export interface DbQueryRecord extends Record<string, unknown> {
  id: string;
  sessionId: string;
  actor: string;
  text: string;
  queryClass: string | null;
  tables: string[];
  state: 'running' | 'done' | 'error' | 'cancelled';
  startedAt: string;
  finishedAt: string | null;
  error?: string | null;
  result: LimitedDbResult | DbQueryFailure | null;
}

type Sessions = Pick<ReturnType<typeof createDbSessionManager>, 'find' | 'trackRun' | 'close'>;
type Session = NonNullable<ReturnType<Sessions['find']>>;
type Cancellation = Awaited<ReturnType<typeof cancelDbQuery>>;

interface HumanQueriesOptions {
  sessions: Sessions;
  queries: Map<string, DbQueryRecord>;
  settings: () => LimitOptions & Record<string, unknown>;
  audit: { append(entry: Record<string, unknown>): Promise<unknown> };
  publish(queryId: string): void;
  onAuditError(error: unknown): void;
}

/**
 * Человеческая консоль владеет выполнением и конечным статусом своих запросов.
 * Ответ отмены согласуется с поздним ответом движка до публикации результата и аудита.
 */
export function createHumanDbQueries(options: HumanQueriesOptions) {
  const { sessions, queries, settings, audit, publish, onAuditError } = options;
  const cancellations = new Map<string, Promise<Cancellation>>();

  /**
   * Выполнение ждёт уже начатую отмену, даже если движок завершился раньше KILL.
   * Неудачная отмена не превращает успешно выполненный запрос в прерванный.
   */
  async function cancelled(query: DbQueryRecord): Promise<boolean> {
    try {
      await cancellations.get(query.id);
    } catch {
      // Отказ отмены вернётся её вызывающему; результат самого SQL остаётся законным.
    }

    return query.state === 'cancelled';
  }

  /**
   * Завершение SQL и запись журнала разделены: отказ аудита не меняет исход запроса.
   * После подтверждённой отмены ни строки, ни ошибка драйвера не заменяют cancelled.
   */
  async function execute(
    query: DbQueryRecord,
    session: Session,
    params: unknown[],
    untrack: () => void,
  ): Promise<void> {
    try {
      const run = session.engine.execute as (
        handle: unknown,
        request: Record<string, unknown>,
      ) => Promise<unknown>;
      const raw = await run.call(session.engine, session.handle, {
        text: query.text,
        params,
        queryId: query.id,
        limits: settings(),
      });
      const result = await normalizeDbResult(raw, { ...settings(), completed: true });

      if (!await cancelled(query)) {
        query.result = result;
        query.state = 'done';
      }
    } catch (error) {
      if (!await cancelled(query)) {
        query.state = 'error';
        query.result = normalizeDbFailure(error);
        query.error = query.result.error;
      }
    } finally {
      query.finishedAt ??= new Date().toISOString();
      untrack();
      publish(query.id);
    }

    const result = query.result as LimitedDbResult | null;
    const outcome = query.state === 'done' ? 'success'
      : query.state === 'cancelled' ? 'cancelled' : 'query_failed';

    try {
      await audit.append({
        projectId: session.profile.projectId,
        sessionId: session.id,
        actor: 'human',
        query: query.text,
        outcome,
        ...(query.state === 'done' ? {
          rows: result?.totalRows ?? 0,
          bytes: result?.totalBytes ?? 0,
          truncated: result?.truncated === true,
        } : {}),
        ...(query.error ? { error: query.error } : {}),
      });
    } catch (error) {
      onAuditError(error);
    }
  }

  /**
   * HTTP получает ID сразу, а параметры остаются только в замыкании выполнения.
   * Сессия и лента принадлежат серверу; повторной команды при обновлении UI нет.
   */
  async function query(id: string, input: { text?: unknown; params?: unknown[] }) {
    const session = sessions.find(id);

    if (!session) {
      throw Object.assign(new Error('DB-сессия не найдена'), { code: 'session_not_found' });
    }

    const item: DbQueryRecord = {
      id: randomUUID(),
      sessionId: session.id,
      actor: 'human',
      text: String(input.text || ''),
      queryClass: null,
      tables: [],
      state: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      result: null,
    };

    queries.set(item.id, item);

    const untrack = sessions.trackRun(session.id, { id: item.id, queryId: item.id });

    if (!untrack) {
      queries.delete(item.id);

      throw Object.assign(new Error('DB-сессия не найдена'), { code: 'session_not_found' });
    }

    publish(item.id);
    void execute(item, session, input.params || [], untrack);

    return { queryId: item.id };
  }

  /**
   * Повторные отмены ждут одну операцию движка. Конечный статус меняется лишь после
   * её подтверждения; позднее выполнение ждёт ту же операцию и сохраняет результат отмены.
   */
  function cancel(id: string): Promise<Cancellation> {
    const pending = cancellations.get(id);

    if (pending) {
      return pending;
    }

    const item = queries.get(id);
    const session = item ? sessions.find(item.sessionId) : null;
    const operation = cancelDbQuery({
      query: item,
      session: session as unknown as Record<string, unknown> | null,
      sessions: sessions as unknown as Record<string, unknown>,
    }).then((outcome) => {
      if (outcome.ok && item) {
        item.state = 'cancelled';
        item.result = null;
        item.finishedAt = new Date().toISOString();
        publish(item.id);
      }

      return outcome;
    }).finally(() => cancellations.delete(id));

    cancellations.set(id, operation);

    return operation;
  }

  return { query, cancel };
}

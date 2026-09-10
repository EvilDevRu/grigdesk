import { randomUUID } from 'node:crypto';

import { evaluateAutoRead } from './autoRead.ts';
import { normalizeDbResult } from './result.ts';

type Payload = Record<string, unknown>;

// Что модель говорит инструменту. Адрес, пользователь и пароль сюда не входят
// намеренно: их выбирает человек в панели, а агент называет метку и роль сессии.
export interface DbBrokerInput {
  action?: string;
  label?: string;
  role?: string;
  text?: string;
  params?: unknown[];
}

// Область, которую навязывает сервер: проект берётся из чата, а не из аргументов
// модели — иначе агент дотянулся бы до базы соседнего проекта, назвав её метку.
export interface DbBrokerScope {
  projectId?: string;
  chatKey?: string;
}

export interface DbBrokerResult {
  ok: boolean;
  error?: string;
  comment?: string;
  rows?: unknown[];
  shownRows?: number;
  totalRows?: number | null;
  shownBytes?: number;
  totalBytes?: number | null;
  truncated?: boolean;
  untrusted?: boolean;
  notice?: string;
}

export interface AgentDbSession {
  label: string;
  role: string;
  engine: string;
}

// Запись живой ленты запроса. Она уходит и в SSE панели, и в общий список: одна
// форма на оба места, иначе панель показывала бы одно, а лента — другое.
interface LiveQuery {
  id: string;
  sessionId: string;
  projectId: string;
  actor: string;
  text: string;
  queryClass: string;
  tables: string[];
  state: string;
  startedAt: string;
  finishedAt: string | null;
  result: DbBrokerResult | null;
  error?: string;
}

interface PendingDecision {
  result: Promise<{ allow?: boolean; error?: string; comment?: string }>;
}

// Рубеж агента: единственный способ дотянуться до базы из чата.
export interface DbBroker {
  invoke: (
    scope?: DbBrokerScope,
    input?: DbBrokerInput,
  ) => Promise<DbBrokerResult | AgentDbSession[]>;
}

export interface DbBrokerOptions {
  pluginEnabled?: (id: string) => boolean;
  sessions?: Payload;
  engines?: Payload;
  permissionQueue?: Payload;
  audit?: { append?: (entry: Payload) => Promise<unknown> } | null;
  settings?: () => Payload;
  onQuery?: (query: LiveQuery) => void;
}

// Что видит модель о сессии: метка, роль и движок. Ни адреса, ни пользователя,
// ни имени базы — их знание ей для запроса не нужно.
function safeSession(session: Payload | null) {
  return session ? {
    profile: { label: String(session.label || ''), role: String(session.role || '') },
    engine: { id: String(session.engine || ''), label: '' },
    prod: session.prod === true,
  } : null;
}

/**
 * Как снять запрос — знает движок, но последствие для сессии одно на всех: запрос,
 * снятый вместе с соединением, делает сессию непригодной, и показывать её живой
 * нельзя. Неотменяемую команду честнее оставить выполняющейся, чем солгать «отменено».
 */
export async function cancelDbQuery({ query, session, sessions }: {
  query?: Payload | null;
  session?: Payload | null;
  sessions?: Payload;
} = {}): Promise<{ ok: boolean; error?: string; method?: string }> {
  if (!query || !session || query.state !== 'running') {
    return { ok: false, error: 'not_found' };
  }

  const engine = session.engine as Payload;
  const cancel = engine.cancel as (handle: unknown, run: Payload) => Promise<Payload>;
  const outcome = await cancel.call(engine, session.handle, {
    id: query.id,
    queryId: query.id,
    text: query.text || '',
    command: query.command || '',
  }) || {};

  if (outcome.method === 'connection') {
    const close = sessions?.close as ((id: unknown, reason: string) => Promise<unknown>) | undefined;

    await close?.call(sessions, session.id, 'connection_reset');
  }
  if (outcome.ok === false) {
    return {
      ok: false,
      error: outcome.method === 'wait' ? 'cancel_not_supported' : 'cancel_failed',
    };
  }
  return { ok: true, method: String(outcome.method || 'query') };
}

// Текст запроса едет в карточку человека, в SSE панели и в журнал: неограниченная
// длина превращает один вызов агента в мусор во всех трёх местах сразу.
const MAX_QUERY_CHARS = 20_000;

/** Все ранние решения тоже фиксируются общей origin-aware очередью без UI waiting. */
export function createDbBroker(options: DbBrokerOptions = {}): DbBroker {
  const enabled = options.pluginEnabled || (() => false);
  const sessions = options.sessions;
  const engines = options.engines;
  const queue = options.permissionQueue;
  const audit = options.audit;
  const settingsOf = options.settings || ((): Payload => ({}));
  const onQuery = typeof options.onQuery === 'function' ? options.onQuery : () => {};
  const autoUses: number[] = [];

  function startQuery(scope: DbBrokerScope, input: DbBrokerInput, text: string): LiveQuery {
    const query: LiveQuery = {
      id: randomUUID(),
      sessionId: '',
      projectId: String(scope.projectId || ''),
      actor: 'agent',
      text,
      queryClass: 'unknown',
      tables: [],
      state: 'checking',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      result: null,
    };
    onQuery({ ...query });

    return query;
  }

  function updateQuery(query: LiveQuery | null, state: string, extra: Payload = {}): void {
    if (!query) return;
    Object.assign(query, extra, { state });
    if (['done', 'denied', 'error', 'cancelled'].includes(state)) {
      query.finishedAt = new Date().toISOString();
    }
    onQuery({ ...query });
  }

  // Решение, принятое без человека, всё равно проходит общей очередью: так оно
  // попадает в её журнал и в карточки, а не исчезает как внутренняя деталь.
  function internal(request: Payload, decision: Payload, reason: string): PendingDecision {
    const decide = queue?.decide as
      ((request: Payload, decision: Payload, reason: string) => PendingDecision) | undefined;

    return decide?.call(queue, request, decision, reason) || {
      ...request,
      result: Promise.resolve(decision),
    } as PendingDecision;
  }

  async function appendAudit(entry: Payload): Promise<void> {
    await audit?.append?.(entry);
  }

  function findSession(projectId: string, input: DbBrokerInput): Payload | null {
    const find = sessions?.findForAgent as
      ((projectId: string, label?: string, role?: string) => Payload | null) | undefined;

    return find?.call(sessions, projectId, input.label, input.role) || null;
  }

  async function deny(
    scope: DbBrokerScope,
    input: DbBrokerInput,
    code: string,
    session: Payload | null = null,
    analysis: Payload | null = null,
    query: LiveQuery | null = null,
  ): Promise<DbBrokerResult> {
    internal({
      origin: 'db',
      chatKey: String(scope.chatKey || ''),
      sessionId: session?.id || '',
      presentation: {
        query: String(input.text || ''),
        queryClass: analysis?.queryClass || 'unknown',
      },
    }, { allow: false, error: code }, code);
    await appendAudit({
      projectId: String(scope.projectId || ''),
      sessionId: session?.id,
      actor: 'agent',
      query: String(input.text || ''),
      queryClass: analysis?.queryClass || 'unknown',
      tables: analysis?.tables || [],
      decision: 'internal_deny',
      outcome: code,
    });
    updateQuery(query, 'denied', {
      sessionId: session?.id || '',
      queryClass: analysis?.queryClass || 'unknown',
      tables: analysis?.tables || [],
      error: code,
    });
    return { ok: false, error: code };
  }

  async function invoke(
    scope: DbBrokerScope = {},
    input: DbBrokerInput = {},
  ): Promise<DbBrokerResult | AgentDbSession[]> {
    const projectId = String(scope.projectId || '');
    if (!enabled('db')) {
      return { ok: false, error: 'plugin_disabled' };
    }
    if (!projectId) {
      return input.action === 'list' ? [] : { ok: false, error: 'project_scope_unavailable' };
    }
    if (input.action === 'list') {
      const list = sessions?.listForAgent as ((projectId: string) => Payload[]) | undefined;

      return (list?.call(sessions, projectId) || []).map((session) => ({
        label: String(session.label || ''),
        role: String(session.role || ''),
        engine: String(session.engine || ''),
      }));
    }
    if (!['schema', 'query'].includes(String(input.action))) {
      return { ok: false, error: 'invalid_action' };
    }
    const text = input.action === 'schema' ? 'Просмотр схемы' : String(input.text || '');
    if (text.length > MAX_QUERY_CHARS) {
      return deny(scope, { ...input, text: `${text.slice(0, 200)}…` }, 'query_too_long');
    }
    const liveQuery = startQuery(scope, input, text);
    const session = await findSession(projectId, input);
    if (!session) return deny(scope, { ...input, text }, 'not_available', null, null, liveQuery);
    if (!session.agentAllowed) {
      return deny(scope, { ...input, text }, 'not_allowed', session, null, liveQuery);
    }
    const lookup = engines?.get as ((id: unknown) => Payload | null) | undefined;
    const engine = lookup?.call(engines, session.engine);
    if (!engine) {
      return deny(scope, { ...input, text }, 'engine_not_found', session, null, liveQuery);
    }

    const config: Payload = settingsOf() || {};
    let analysis: Payload | null = null;

    try {
      const analyze = engine.analyze as (text: string, handle: unknown) => Promise<Payload>;

      analysis = input.action === 'schema'
        ? { queryClass: 'read', single: true, tables: [], forbidden: [], tableFunctions: [] }
        : await analyze.call(engine, text, session.handle);
    } catch {
      // Разбор не удался — запрос остаётся неразобранным со всеми последствиями.
      analysis = null;
    }
    if (!analysis) {
      return deny(scope, { ...input, text }, 'query_not_understood', session, null, liveQuery);
    }
    updateQuery(liveQuery, 'checking', {
      sessionId: session.id,
      queryClass: analysis?.queryClass || 'unknown',
      tables: analysis?.tables || [],
    });
    if (!text || analysis?.queryClass === 'unknown' || analysis?.single !== true) {
      return deny(
        scope,
        { ...input, text },
        'query_not_understood',
        session,
        analysis,
        liveQuery,
      );
    }
    if (['ddl', 'admin'].includes(String(analysis.queryClass)) && config.allowDdlAdmin !== true) {
      return deny(scope, { ...input, text }, 'ddl_admin_disabled', session, analysis, liveQuery);
    }

    // EXPLAIN исполняется на сервере БД ДО решения человека, поэтому оценка снимается
    // только с запроса, прошедшего формальный фильтр: ради структуры url(), s3() или
    // remote() ClickHouse сходил бы в сеть сам, а решения это всё равно не меняет.
    // Там, где авто-чтение выключено, оценка не нужна и не оправдывает лишний запуск.
    const suspicious = Boolean((analysis.tableFunctions as unknown[] | undefined)?.length
      || (analysis.forbidden as unknown[] | undefined)?.length);
    const needsEstimate = !suspicious && (
      analysis.queryClass === 'write'
      || (analysis.queryClass === 'read' && config.autoRead === true)
    );
    let limits: Payload = {};

    if (needsEstimate) {
      try {
        const estimate = engine.estimate as
          ((handle: unknown, request: Payload, config: Payload) => Promise<Payload>) | undefined;

        limits = await estimate?.call(engine, session.handle, {
          ...analysis,
          text,
          params: input.params || [],
        }, config) || {};
      } catch {
        limits = {};
      }
    }
    const rowEstimate = analysis.queryClass === 'write' && Number.isFinite(limits.rows)
      ? limits.rows as number
      : null;
    let autoReadReason: { code: string; message: string } | null = null;
    let autoAllowed = false;

    if (analysis.queryClass === 'read') {
      let rights: Payload = {};

      if (config.autoRead === true) {
        try {
          const inspect = engine.inspectRights as
            (handle: unknown, session: Payload) => Promise<Payload>;

          rights = await inspect.call(engine, session.handle, session) || {};
        } catch {
          rights = {};
        }
      }

      const minuteAgo = Date.now() - 60_000;
      while (autoUses.length && Number(autoUses[0]) < minuteAgo) autoUses.shift();
      const auto = evaluateAutoRead({
        settings: {
          enabled: config.autoRead === true,
          prodEnabled: config.autoReadProd === true,
          maxRows: Number(config.maxRows),
          maxBytes: Number(config.maxBytes),
          timeoutMs: Number(config.timeoutMs),
          maxPerMinute: Number(config.autoReadPerMinute),
        },
        profile: { prod: session.prod === true },
        rights,
        connection: { readOnlyActive: session.readOnlyActive === true },
        analysis,
        limits,
        rate: { used: autoUses.length },
      });
      autoAllowed = auto.eligible;
      autoReadReason = auto.reason;
    }
    const identity = safeSession(session) as {
      profile: { label: string; role: string };
      engine: { id: string; label: string };
      prod: boolean;
    };

    identity.engine.label = String(engine.label || engine.id || '');
    const presentation = {
      ...identity,
      query: text,
      queryClass: analysis.queryClass,
      tables: analysis.tables || [],
      tableFunctions: analysis.tableFunctions || [],
      forbidden: analysis.forbidden || [],
      rowEstimate,
      autoReadReason,
    };
    const request = {
      origin: 'db',
      chatKey: String(scope.chatKey || ''),
      sessionId: session.id,
      generation: session.generation,
      canRemember: false,
      presentation,
    };
    const enqueue = queue?.enqueue as ((request: Payload) => PendingDecision) | undefined;
    const pending = autoAllowed
      ? internal(request, { allow: true }, 'auto_allow')
      : enqueue?.call(queue, request);
    if (!pending) {
      return deny(
        scope,
        { ...input, text },
        'approval_unavailable',
        session,
        analysis,
        liveQuery,
      );
    }
    updateQuery(liveQuery, autoAllowed ? 'running' : 'waiting');
    if (autoAllowed) autoUses.push(Date.now());
    const decision = await pending.result;
    if (!decision.allow) {
      const code = decision.error || 'denied';
      updateQuery(liveQuery, 'denied', { error: code });
      await appendAudit({
        projectId,
        sessionId: session.id,
        actor: 'agent',
        query: text,
        queryClass: analysis.queryClass,
        tables: analysis.tables || [],
        decision: autoAllowed ? 'auto_deny' : 'human_deny',
        outcome: code,
      });
      return { ok: false, error: code, ...(decision.comment ? { comment: decision.comment } : {}) };
    }
    if (!enabled('db')) {
      updateQuery(liveQuery, 'denied', { error: 'plugin_disabled' });
      await appendAudit({ projectId, actor: 'agent', query: text, outcome: 'plugin_disabled' });
      return { ok: false, error: 'plugin_disabled' };
    }
    const currentOf = sessions?.current as ((id: unknown) => Payload | null) | undefined;
    const findOf = sessions?.find as ((id: unknown) => Payload | null) | undefined;
    const current = currentOf?.call(sessions, session.id)
      || findOf?.call(sessions, session.id)
      || session;
    if (!current || current.id !== session.id || current.generation !== session.generation
      || !current.agentAllowed) {
      updateQuery(liveQuery, 'denied', { error: 'session_lost' });
      await appendAudit({ projectId, actor: 'agent', query: text, outcome: 'session_lost' });
      return { ok: false, error: 'session_lost' };
    }

    let result: DbBrokerResult;

    try {
      updateQuery(liveQuery, 'running');

      const schema = engine.schema as (handle: unknown) => Promise<unknown>;
      const execute = engine.execute as (handle: unknown, request: Payload) => Promise<unknown>;
      const raw = input.action === 'schema'
        ? await schema.call(engine, current.handle)
        : await execute.call(engine, current.handle, {
          text,
          params: input.params || [],
          queryId: liveQuery.id,
          limits: config,
        });
      result = {
        ok: true,
        ...await normalizeDbResult(raw, {
          maxRows: Number(config.maxRows) || 1000,
          maxBytes: Number(config.maxBytes) || 256 * 1024,
          completed: true,
        }),
      };
      updateQuery(liveQuery, 'done', { result });
      await appendAudit({
        projectId,
        sessionId: session.id,
        actor: 'agent',
        query: text,
        queryClass: analysis.queryClass,
        tables: analysis.tables || [],
        decision: autoAllowed ? 'auto_allow' : 'human_allow',
        outcome: 'success',
        rows: result.totalRows,
        bytes: result.totalBytes,
        truncated: result.truncated,
      });
      return result;
    } catch {
      updateQuery(liveQuery, 'error', { error: 'query_failed' });
      await appendAudit({
        projectId, sessionId: session.id, actor: 'agent', query: text,
        queryClass: analysis.queryClass, tables: analysis.tables || [], outcome: 'query_failed',
      });
      return { ok: false, error: 'query_failed' };
    }
  }

  return { invoke };
}

export default createDbBroker;

import { randomUUID } from 'node:crypto';

import { evaluateAutoRead } from './auto-read.js';
import { normalizeDbResult } from './result.js';

function safeSession(session) {
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
export async function cancelDbQuery({ query, session, sessions } = {}) {
  if (!query || !session || query.state !== 'running') {
    return { ok: false, error: 'not_found' };
  }
  const outcome = await session.engine.cancel(session.handle, {
    id: query.id,
    queryId: query.id,
    text: query.text || '',
    command: query.command || '',
  }) || {};
  if (outcome.method === 'connection') {
    await sessions?.close?.(session.id, 'connection_reset');
  }
  if (outcome.ok === false) {
    return {
      ok: false,
      error: outcome.method === 'wait' ? 'cancel_not_supported' : 'cancel_failed',
    };
  }
  return { ok: true, method: outcome.method || 'query' };
}

// Текст запроса едет в карточку человека, в SSE панели и в журнал: неограниченная
// длина превращает один вызов агента в мусор во всех трёх местах сразу.
const MAX_QUERY_CHARS = 20_000;

/** Все ранние решения тоже фиксируются общей origin-aware очередью без UI waiting. */
export function createDbBroker(options = {}) {
  const enabled = options.pluginEnabled || (() => false);
  const sessions = options.sessions;
  const engines = options.engines;
  const queue = options.permissionQueue;
  const audit = options.audit;
  const settingsOf = options.settings || (() => ({}));
  const onQuery = typeof options.onQuery === 'function' ? options.onQuery : () => {};
  const autoUses = [];

  function startQuery(scope, input, text) {
    const query = {
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

  function updateQuery(query, state, extra = {}) {
    if (!query) return;
    Object.assign(query, extra, { state });
    if (['done', 'denied', 'error', 'cancelled'].includes(state)) {
      query.finishedAt = new Date().toISOString();
    }
    onQuery({ ...query });
  }

  function internal(request, decision, reason) {
    return queue?.decide?.(request, decision, reason) || {
      ...request,
      result: Promise.resolve(decision),
    };
  }

  async function appendAudit(entry) {
    await audit?.append?.(entry);
  }

  function findSession(projectId, input) {
    return sessions?.findForAgent?.(projectId, input.label, input.role) || null;
  }

  async function deny(scope, input, code, session = null, analysis = null, query = null) {
    internal({
      origin: 'db',
      chatKey: String(scope.chatKey || ''),
      sessionId: session?.id || '',
      presentation: { query: String(input.text || ''), queryClass: analysis?.queryClass || 'unknown' },
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

  async function invoke(scope = {}, input = {}) {
    const projectId = String(scope.projectId || '');
    if (!enabled('db')) {
      return { ok: false, error: 'plugin_disabled' };
    }
    if (!projectId) {
      return input.action === 'list' ? [] : { ok: false, error: 'project_scope_unavailable' };
    }
    if (input.action === 'list') {
      return (sessions?.listForAgent?.(projectId) || []).map((session) => ({
        label: String(session.label || ''),
        role: String(session.role || ''),
        engine: String(session.engine || ''),
      }));
    }
    if (!['schema', 'query'].includes(input.action)) {
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
    const engine = engines?.get?.(session.engine);
    if (!engine) {
      return deny(scope, { ...input, text }, 'engine_not_found', session, null, liveQuery);
    }

    const config = settingsOf() || {};
    let analysis = null;
    try {
      analysis = input.action === 'schema'
        ? { queryClass: 'read', single: true, tables: [], forbidden: [], tableFunctions: [] }
        : await engine.analyze(text, session.handle);
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
    if (['ddl', 'admin'].includes(analysis.queryClass) && config.allowDdlAdmin !== true) {
      return deny(scope, { ...input, text }, 'ddl_admin_disabled', session, analysis, liveQuery);
    }

    // EXPLAIN исполняется на сервере БД ДО решения человека, поэтому оценка снимается
    // только с запроса, прошедшего формальный фильтр: ради структуры url(), s3() или
    // remote() ClickHouse сходил бы в сеть сам, а решения это всё равно не меняет.
    // Там, где авто-чтение выключено, оценка не нужна и не оправдывает лишний запуск.
    const suspicious = Boolean(analysis.tableFunctions?.length || analysis.forbidden?.length);
    const needsEstimate = !suspicious && (
      analysis.queryClass === 'write'
      || (analysis.queryClass === 'read' && config.autoRead === true)
    );
    let limits = {};
    if (needsEstimate) {
      try {
        limits = await engine.estimate?.(session.handle, {
          ...analysis,
          text,
          params: input.params || [],
        }, config) || {};
      } catch {
        limits = {};
      }
    }
    const rowEstimate = analysis.queryClass === 'write' && Number.isFinite(limits.rows)
      ? limits.rows
      : null;
    let autoReadReason = null;
    let autoAllowed = false;
    if (analysis.queryClass === 'read') {
      let rights = {};
      if (config.autoRead === true) {
        try {
          rights = await engine.inspectRights(session.handle, session) || {};
        } catch {
          rights = {};
        }
      }
      const minuteAgo = Date.now() - 60_000;
      while (autoUses.length && autoUses[0] < minuteAgo) autoUses.shift();
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
    const identity = safeSession(session);
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
    const pending = autoAllowed
      ? internal(request, { allow: true }, 'auto_allow')
      : queue?.enqueue?.(request);
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
    const current = sessions?.current?.(session.id) || sessions?.find?.(session.id) || session;
    if (!current || current.id !== session.id || current.generation !== session.generation
      || !current.agentAllowed) {
      updateQuery(liveQuery, 'denied', { error: 'session_lost' });
      await appendAudit({ projectId, actor: 'agent', query: text, outcome: 'session_lost' });
      return { ok: false, error: 'session_lost' };
    }

    let result;
    try {
      updateQuery(liveQuery, 'running');
      const raw = input.action === 'schema'
        ? await engine.schema(current.handle)
        : await engine.execute(current.handle, {
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

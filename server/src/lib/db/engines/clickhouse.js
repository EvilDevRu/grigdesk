import http from 'node:http';

import { createClient } from '@clickhouse/client';

const TABLE_FUNCTIONS = ['url', 'file', 's3', 'remote', 'mysql', 'executable'];
const FORBIDDEN = [
  ['SLEEP', /\bSLEEP\s*\(/iu],
  ['GET_LOCK', /\bGET_LOCK\s*\(/iu],
];

function splitStatements(text) {
  return String(text || '').split(';').map((part) => part.trim()).filter(Boolean);
}

function queryClassOf(text) {
  const first = String(text).trim().match(/^([A-Za-z]+)/u)?.[1]?.toUpperCase();
  if (['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN'].includes(first)) return 'read';
  if (['INSERT', 'UPDATE', 'DELETE'].includes(first)) return 'write';
  if (['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME'].includes(first)) return 'ddl';
  if (['GRANT', 'REVOKE', 'KILL', 'SET', 'SYSTEM', 'OPTIMIZE'].includes(first)) return 'admin';
  return 'unknown';
}

function tablesOf(text) {
  return [...String(text).matchAll(/\b(?:FROM|JOIN|INTO|TABLE)\s+`?([A-Za-z0-9_.-]+)`?/giu)]
    .map((match) => match[1])
    .filter((value, index, all) => all.indexOf(value) === index);
}

function insertedRows(text) {
  const values = String(text || '').match(/\bVALUES\b([\s\S]*)$/iu)?.[1] || '';
  const rows = values.match(/\([^)]*\)/gu)?.length || 0;
  return rows || null;
}

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** SSH channel становится единственным HTTP transport: второй socket не уйдёт напрямую. */
export function createClickHouseHttpAgent(stream) {
  let timeout = null;
  if (typeof stream.setTimeout !== 'function') {
    stream.setTimeout = (delay, listener) => {
      clearTimeout(timeout);
      if (typeof listener === 'function') stream.once('timeout', listener);
      if (Number(delay) > 0) {
        timeout = setTimeout(() => stream.emit('timeout'), Number(delay));
        timeout.unref?.();
      }
      return stream;
    };
    stream.once('close', () => clearTimeout(timeout));
  }
  if (typeof stream.setNoDelay !== 'function') stream.setNoDelay = () => stream;
  if (typeof stream.setKeepAlive !== 'function') stream.setKeepAlive = () => stream;

  let claimed = false;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  agent.createConnection = (_options, callback) => {
    if (claimed) {
      const error = new Error('SSH-канал ClickHouse уже занят');
      error.code = 'ssh_channel_exhausted';
      callback?.(error);
      return undefined;
    }
    claimed = true;
    callback?.(null, stream);
    return stream;
  };
  agent.keepSocketAlive = () => true;
  agent.reuseSocket = () => {};
  return agent;
}

/** Закрываются оба клиента сессии: рабочий и служебный, вместе со своими агентами. */
async function closeHandle(handle) {
  const client = handle?.client || handle;
  try {
    await Promise.allSettled([client?.close?.(), handle?.control?.close?.()]);
  } finally {
    handle?.httpAgent?.destroy?.();
    handle?.controlAgent?.destroy?.();
  }
}

export default {
  id: 'clickhouse',
  label: 'ClickHouse',
  capabilities: { schema: true, readOnly: true, estimate: true, cancel: 'query' },
  async open({ profile, password, stream, openStream, clientFactory = createClient } = {}) {
    const secret = Buffer.isBuffer(password) ? password.toString('utf8') : String(password || '');
    const build = (channel) => {
      const httpAgent = channel ? createClickHouseHttpAgent(channel) : null;
      return {
        httpAgent,
        client: clientFactory({
          url: `http://${profile?.host}:${Number(profile?.port) || 8123}`,
          username: profile?.user,
          password: secret,
          database: profile?.database || undefined,
          clickhouse_settings: profile?.role === 'read' ? { readonly: 1 } : {},
          ...(httpAgent ? {
            http_agent: httpAgent,
            max_open_connections: 1,
            keep_alive: { enabled: true },
          } : {}),
        }),
      };
    };

    const primary = build(stream);
    // Туннельный агент держит ровно один сокет, занятый самим запросом: без своего
    // канала KILL QUERY встал бы в очередь за ответом, который он и должен прервать.
    let control = null;
    if (stream) {
      try {
        const channel = typeof openStream === 'function' ? await openStream() : null;
        control = channel ? build(channel) : null;
      } catch {
        control = null;
      }
    }

    const handle = {
      client: primary.client,
      httpAgent: primary.httpAgent,
      control: control?.client || null,
      controlAgent: control?.httpAgent || null,
      readOnlyActive: profile?.role === 'read',
    };
    handle.close = () => closeHandle(handle);
    return handle;
  },
  close: closeHandle,
  async schema(handle) {
    const result = await (handle?.client || handle).query({
      query: 'SHOW TABLES', format: 'JSONEachRow',
    });
    return result.json();
  },
  async analyze(text) {
    const parts = splitStatements(text);
    const query = parts[0] || '';
    const tableFunctions = TABLE_FUNCTIONS.filter((name) => (
      new RegExp(`\\b${name}\\s*\\(`, 'iu').test(query)
    ));
    return {
      queryClass: parts.length === 1 ? queryClassOf(query) : 'unknown',
      single: parts.length === 1,
      text: query,
      tables: tablesOf(query),
      forbidden: FORBIDDEN.filter(([, pattern]) => pattern.test(query)).map(([name]) => name),
      tableFunctions,
      rowEstimate: insertedRows(query),
    };
  },
  async inspectRights(handle) {
    const result = await (handle?.client || handle).query({
      query: 'SHOW GRANTS', format: 'JSONEachRow',
    });
    const grants = JSON.stringify(await result.json()).toUpperCase();
    const writable = /\b(?:INSERT|ALTER|CREATE|DROP|GRANT|ALL)\b/u.test(grants);
    return { confirmedReadOnly: /\bSELECT\b/u.test(grants) && !writable, writable };
  },
  async estimate(handle, analysis = {}, limits = {}) {
    const client = handle?.client || handle;
    let rows = numeric(analysis.rowEstimate);
    let bytes = null;
    try {
      const result = await client.query({
        query: `EXPLAIN ESTIMATE ${String(analysis.text || '')}`,
        format: 'JSONEachRow',
        query_params: analysis.params || {},
      });
      const estimates = await result.json();
      rows = estimates.reduce((sum, item) => sum + (numeric(item?.rows) || 0), 0);
      bytes = estimates.reduce((sum, item) => sum + (numeric(item?.bytes) || 0), 0) || null;
    } catch {
      // Для неподдерживаемого EXPLAIN оставляем только доказуемую оценку INSERT.
    }
    return {
      rows,
      // ClickHouse жёстко применяет этот предел в execute, даже если EXPLAIN не дал bytes.
      bytes: bytes ?? numeric(limits.maxBytes),
      timeoutMs: numeric(limits.timeoutMs),
    };
  },
  async execute(handle, request = {}) {
    const limits = request.limits || {};
    const result = await (handle?.client || handle).query({
      query: String(request.text || ''),
      query_params: request.params || {},
      format: 'JSONEachRow',
      query_id: request.queryId || undefined,
      clickhouse_settings: {
        max_execution_time: Math.max(1, Math.ceil((numeric(limits.timeoutMs) || 15_000) / 1000)),
        max_result_rows: numeric(limits.maxRows) || 1000,
        max_result_bytes: numeric(limits.maxBytes) || 256 * 1024,
        result_overflow_mode: 'throw',
      },
    });
    return result.json();
  },
  async cancel(handle, run = {}) {
    await (handle?.control || handle?.client || handle).command({
      query: `KILL QUERY WHERE query_id = {query_id:String}`,
      query_params: { query_id: String(run.queryId || run.id || '') },
    });
    return { ok: true, method: 'query' };
  },
};

import http from 'node:http';

import { createClient } from '@clickhouse/client';

import type { Duplex } from 'node:stream';

const TABLE_FUNCTIONS = ['url', 'file', 's3', 'remote', 'mysql', 'executable'];
// Опасные конструкции чтения: данные они не меняют, но держат сервер занятым —
// авто-подтверждение к ним не применяется.
const FORBIDDEN: [string, RegExp][] = [
  ['SLEEP', /\bSLEEP\s*\(/iu],
  ['GET_LOCK', /\bGET_LOCK\s*\(/iu],
];

type Payload = Record<string, unknown>;

// Клиент ClickHouse, как его видит адаптер. Служебный клиент открывается своим
// каналом: туннельный агент держит ровно один сокет, занятый самим запросом.
interface ClickHouseClient {
  query: (request: Payload) => Promise<{ json: () => Promise<unknown> }>;
  command: (request: Payload) => Promise<unknown>;
  close?: () => Promise<unknown>;
}

interface ClickHouseAgent {
  destroy?: () => void;
}

interface ClickHouseHandle {
  client: ClickHouseClient;
  httpAgent: ClickHouseAgent | null;
  control: ClickHouseClient | null;
  controlAgent: ClickHouseAgent | null;
  readOnlyActive: boolean;
  close?: () => Promise<void>;
}

function splitStatements(text: unknown): string[] {
  return String(text || '').split(';').map((part) => part.trim()).filter(Boolean);
}

function queryClassOf(text: unknown): string {
  const first = String(String(text).trim().match(/^([A-Za-z]+)/u)?.[1] || '').toUpperCase();
  if (['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN'].includes(first)) return 'read';
  if (['INSERT', 'UPDATE', 'DELETE'].includes(first)) return 'write';
  if (['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME'].includes(first)) return 'ddl';
  if (['GRANT', 'REVOKE', 'KILL', 'SET', 'SYSTEM', 'OPTIMIZE'].includes(first)) return 'admin';
  return 'unknown';
}

function tablesOf(text: unknown): string[] {
  return [...String(text).matchAll(/\b(?:FROM|JOIN|INTO|TABLE)\s+`?([A-Za-z0-9_.-]+)`?/giu)]
    .map((match) => String(match[1]))
    .filter((value, index, all) => all.indexOf(value) === index);
}

function insertedRows(text: unknown): number | null {
  const values = String(text || '').match(/\bVALUES\b([\s\S]*)$/iu)?.[1] || '';
  const rows = values.match(/\([^)]*\)/gu)?.length || 0;
  return rows || null;
}

function numeric(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** SSH channel становится единственным HTTP transport: второй socket не уйдёт напрямую. */
export function createClickHouseHttpAgent(source: unknown) {
  const stream = source as Duplex & Payload;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  if (typeof stream.setTimeout !== 'function') {
    stream.setTimeout = (delay: unknown, listener?: unknown) => {
      if (timeout) clearTimeout(timeout);
      if (typeof listener === 'function') stream.once('timeout', listener as () => void);
      if (Number(delay) > 0) {
        timeout = setTimeout(() => stream.emit('timeout'), Number(delay));
        timeout.unref?.();
      }

      return stream;
    };
    stream.once('close', () => {
      if (timeout) clearTimeout(timeout);
    });
  }
  if (typeof stream.setNoDelay !== 'function') stream.setNoDelay = () => stream;
  if (typeof stream.setKeepAlive !== 'function') stream.setKeepAlive = () => stream;

  let claimed = false;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 }) as http.Agent & Payload;

  agent.createConnection = (_options: unknown, callback?: unknown) => {
    const done = callback as ((error: unknown, socket?: unknown) => void) | undefined;

    if (claimed) {
      done?.(Object.assign(
        new Error('SSH-канал ClickHouse уже занят'),
        { code: 'ssh_channel_exhausted' },
      ));

      return undefined;
    }
    claimed = true;
    done?.(null, stream);

    return stream;
  };
  agent.keepSocketAlive = () => true;
  agent.reuseSocket = () => {};

  return agent;
}

/** Закрываются оба клиента сессии: рабочий и служебный, вместе со своими агентами. */
async function closeHandle(handle: ClickHouseHandle | ClickHouseClient | null): Promise<void> {
  const owner = handle as ClickHouseHandle | null;
  const client = owner?.client || handle as ClickHouseClient | null;

  try {
    await Promise.allSettled([client?.close?.(), owner?.control?.close?.()]);
  } finally {
    owner?.httpAgent?.destroy?.();
    owner?.controlAgent?.destroy?.();
  }
}

export default {
  id: 'clickhouse',
  label: 'ClickHouse',
  capabilities: { schema: true, readOnly: true, estimate: true, cancel: 'query' },
  async open({
    profile, password, stream, openStream,
    clientFactory = createClient as unknown as (options: Payload) => ClickHouseClient,
  }: {
    profile?: Payload;
    password?: unknown;
    stream?: unknown;
    openStream?: () => Promise<unknown>;
    // Фабрику клиента подменяют в проверке: заглушке незачем повторять весь
    // официальный клиент, ей достаточно query и command.
    clientFactory?: (options: Payload) => ClickHouseClient;
  } = {}): Promise<ClickHouseHandle> {
    const secret = Buffer.isBuffer(password) ? password.toString('utf8') : String(password || '');
    const build = (channel: unknown) => {
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
    let control: { client: ClickHouseClient; httpAgent: ClickHouseAgent | null } | null = null;

    if (stream) {
      try {
        const channel = typeof openStream === 'function' ? await openStream() : null;
        control = channel ? build(channel) : null;
      } catch {
        control = null;
      }
    }

    const handle: ClickHouseHandle = {
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
  async schema(handle: ClickHouseHandle | ClickHouseClient | null) {
    const client = (handle as ClickHouseHandle)?.client || handle as ClickHouseClient;
    const result = await client.query({ query: 'SHOW TABLES', format: 'JSONEachRow' });

    return result.json();
  },
  async analyze(text: unknown) {
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
  async inspectRights(handle: ClickHouseHandle | ClickHouseClient | null) {
    const client = (handle as ClickHouseHandle)?.client || handle as ClickHouseClient;
    const result = await client.query({ query: 'SHOW GRANTS', format: 'JSONEachRow' });
    const grants = JSON.stringify(await result.json()).toUpperCase();
    const writable = /\b(?:INSERT|ALTER|CREATE|DROP|GRANT|ALL)\b/u.test(grants);
    return { confirmedReadOnly: /\bSELECT\b/u.test(grants) && !writable, writable };
  },
  async estimate(
    handle: ClickHouseHandle | ClickHouseClient | null,
    analysis: Payload = {},
    limits: Payload = {},
  ) {
    const client = (handle as ClickHouseHandle)?.client || handle as ClickHouseClient;
    let rows = numeric(analysis.rowEstimate);
    let bytes: number | null = null;
    try {
      const result = await client.query({
        query: `EXPLAIN ESTIMATE ${String(analysis.text || '')}`,
        format: 'JSONEachRow',
        query_params: analysis.params || {},
      });
      const estimates = await result.json() as Payload[];

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
  async execute(handle: ClickHouseHandle | ClickHouseClient | null, request: Payload = {}) {
    const limits = (request.limits ?? {}) as Payload;
    const client = (handle as ClickHouseHandle)?.client || handle as ClickHouseClient;
    const result = await client.query({
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
  async cancel(handle: ClickHouseHandle | ClickHouseClient | null, run: Payload = {}) {
    const owner = handle as ClickHouseHandle | null;
    const client = owner?.control || owner?.client || handle as ClickHouseClient;

    await client.command({
      query: `KILL QUERY WHERE query_id = {query_id:String}`,
      query_params: { query_id: String(run.queryId || run.id || '') },
    });
    return { ok: true, method: 'query' };
  },
};

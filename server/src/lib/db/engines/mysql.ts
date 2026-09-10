import mysql from 'mysql2/promise';

type Payload = Record<string, unknown>;

// Соединение драйвера, как его видит адаптер. Служебное соединение открывается
// вместе с рабочим: снять запрос по занятому сокету нечем.
interface MysqlConnection {
  query: (text: string, params?: unknown[]) => Promise<unknown[]>;
  execute?: (text: string, params?: unknown[]) => Promise<unknown[]>;
  end?: () => Promise<unknown>;
  destroy?: () => void;
  threadId?: number;
}

interface MysqlHandle {
  connection: MysqlConnection;
  control: MysqlConnection | null;
  threadId?: number;
  readOnlyActive: boolean;
  close?: () => Promise<void>;
}

interface PlanMetrics {
  rows: number[];
  bytes: number[];
}

// Опасные конструкции чтения: они не меняют данные, но читают файлы, держат
// блокировки или тормозят сервер — авто-подтверждение к ним не применяется.
const FORBIDDEN: [string, RegExp][] = [
  ['LOAD_FILE', /\bLOAD_FILE\s*\(/iu],
  ['SLEEP', /\bSLEEP\s*\(/iu],
  ['BENCHMARK', /\bBENCHMARK\s*\(/iu],
  ['GET_LOCK', /\bGET_LOCK\s*\(/iu],
  ['INTO OUTFILE', /\bINTO\s+OUTFILE\b/iu],
  ['LOCK IN SHARE MODE', /\bLOCK\s+IN\s+SHARE\s+MODE\b/iu],
  ['FOR UPDATE', /\bFOR\s+UPDATE\b/iu],
];

function statements(text: unknown): string[] {
  return String(text || '').split(';').map((part) => part.trim()).filter(Boolean);
}

function tablesOf(text: unknown): string[] {
  const tables: string[] = [];
  const pattern = /\b(?:FROM|JOIN|UPDATE|INTO|TABLE)\s+`?([A-Za-z0-9_.-]+)`?/giu;
  for (const match of String(text).matchAll(pattern)) {
    const name = String(match[1]);

    if (!tables.includes(name)) tables.push(name);
  }
  return tables;
}

function queryClassOf(text: unknown): string {
  const first = String(String(text || '').trim().match(/^([A-Za-z]+)/u)?.[1] || '')
    .toUpperCase();
  if (['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN'].includes(first)) return 'read';
  if (['INSERT', 'UPDATE', 'DELETE', 'REPLACE'].includes(first)) return 'write';
  if (['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME'].includes(first)) return 'ddl';
  if (['GRANT', 'REVOKE', 'KILL', 'SET', 'FLUSH', 'OPTIMIZE'].includes(first)) return 'admin';
  return 'unknown';
}

function insertedRows(text: unknown): number | null {
  const values = String(text || '').match(/\bVALUES\b([\s\S]*)$/iu)?.[1] || '';
  const rows = values.match(/\([^)]*\)/gu)?.length || 0;
  return rows || null;
}

// Планировщик отдаёт объём то числом, то строкой с единицей. Обе формы законны, и
// «непонятный объём» должен стать null, а не нулём: ноль выключил бы предел.
function bytesOf(value: unknown): number | null {
  if (Number.isFinite(Number(value))) return Number(value);

  const match = String(value || '').trim().match(/^([\d.]+)\s*([KMGT]?I?B?)$/iu);

  if (!match) return null;

  const unit = String(match[2]).toUpperCase();
  const powers: Record<string, number> = {
    B: 1,
    K: 1_024,
    KB: 1_000,
    KIB: 1_024,
    M: 1_024 ** 2,
    MB: 1_000 ** 2,
    MIB: 1_024 ** 2,
    G: 1_024 ** 3,
    GB: 1_000 ** 3,
    GIB: 1_024 ** 3,
    T: 1_024 ** 4,
    TB: 1_000 ** 4,
    TIB: 1_024 ** 4,
  };

  return Number(match[1]) * (powers[unit] || 1);
}

/** Из JSON EXPLAIN берём оценки планировщика, а не пользовательские потолки результата. */
function explainMetrics(
  value: unknown,
  target: PlanMetrics = { rows: [], bytes: [] },
): PlanMetrics {
  if (!value || typeof value !== 'object') return target;

  for (const [key, nested] of Object.entries(value as Payload)) {
    if (/^rows_(?:examined|produced)_per_(?:scan|join)$/u.test(key)) {
      const rows = Number(nested);
      if (Number.isFinite(rows)) target.rows.push(rows);
    } else if (key === 'data_read_per_join') {
      const bytes = bytesOf(nested);

      if (bytes !== null && Number.isFinite(bytes)) target.bytes.push(bytes);
    }
    explainMetrics(nested, target);
  }
  return target;
}

function withTimeoutHint(text: unknown, timeoutMs: unknown): string {
  const delay = Math.max(1, Math.floor(Number(timeoutMs) || 15_000));
  return String(text || '').replace(/^\s*SELECT\b/iu, (keyword) => (
    `${keyword} /*+ MAX_EXECUTION_TIME(${delay}) */`
  ));
}

async function close(handle: MysqlHandle | MysqlConnection | null): Promise<void> {
  const owner = handle as MysqlHandle | null;
  const connection = owner?.connection || handle as MysqlConnection | null;

  await Promise.allSettled([connection?.end?.(), owner?.control?.end?.()]);
}

/**
 * Отмена обязана прерывать сам ЗАПРОС, а не соединение: рабочий сокет занят ответом
 * сервера, поэтому KILL QUERY уходит по служебному соединению сессии. Разрыв остаётся
 * крайним средством и объявляется вызывающему честно — после него сессия непригодна.
 */
async function killQuery(
  handle: MysqlHandle | MysqlConnection | null,
): Promise<{ ok: true; method: string }> {
  const owner = handle as MysqlHandle | null;
  const connection = owner?.connection || handle as MysqlConnection | null;
  const control = owner?.control;
  const threadId = Number(owner?.threadId ?? connection?.threadId);
  if (control && Number.isInteger(threadId) && threadId > 0) {
    try {
      await control.query(`KILL QUERY ${threadId}`);
      return { ok: true, method: 'query' };
    } catch {
      // Служебное соединение могло не пережить туннель — падаем на разрыв.
    }
  }
  connection?.destroy?.();
  return { ok: true, method: 'connection' };
}

export default {
  id: 'mysql',
  label: 'MySQL',
  capabilities: { schema: true, readOnly: true, estimate: true, cancel: 'query' },

  async open({ profile, password, stream, openStream, driver = mysql }: {
    profile?: Payload;
    password?: unknown;
    stream?: unknown;
    openStream?: () => Promise<unknown>;
    driver?: typeof mysql;
  } = {}): Promise<MysqlHandle> {
    const base = {
      host: profile?.host,
      port: Number(profile?.port) || 3306,
      user: profile?.user,
      database: profile?.database || undefined,
      password: Buffer.isBuffer(password) ? password.toString('utf8') : String(password || ''),
      multipleStatements: false,
    };
    const connection = await driver.createConnection({
      ...base,
      ...(stream ? { stream } : {}),
    } as never) as unknown as MysqlConnection;
    let readOnlyActive = false;
    if (profile?.role === 'read') {
      await connection.query('SET SESSION TRANSACTION READ ONLY');
      readOnlyActive = true;
    }

    // Служебное соединение открывается вместе с сессией: пароль есть только здесь,
    // а позже взять его будет негде. Отказ туннеля не мешает открыть саму сессию.
    let control: MysqlConnection | null = null;

    try {
      const controlStream = stream && typeof openStream === 'function'
        ? await openStream()
        : null;

      if (!stream || controlStream) {
        control = await driver.createConnection({
          ...base,
          ...(controlStream ? { stream: controlStream } : {}),
        } as never) as unknown as MysqlConnection;
      }
    } catch {
      control = null;
    }

    const handle: MysqlHandle = {
      connection,
      control,
      threadId: connection.threadId,
      readOnlyActive,
    };

    handle.close = () => close(handle);

    return handle;
  },
  close,
  async schema(handle: MysqlHandle | MysqlConnection | null) {
    const connection = (handle as MysqlHandle)?.connection || handle as MysqlConnection;
    const [rows] = await connection.query('SHOW TABLES');

    return rows;
  },
  async analyze(text: unknown) {
    const parts = statements(text);
    const query = parts[0] || '';
    return {
      queryClass: parts.length === 1 ? queryClassOf(query) : 'unknown',
      single: parts.length === 1,
      text: query,
      tables: tablesOf(query),
      forbidden: FORBIDDEN.filter(([, pattern]) => pattern.test(query)).map(([name]) => name),
      tableFunctions: [],
      rowEstimate: insertedRows(query),
    };
  },
  async inspectRights(handle: MysqlHandle | MysqlConnection | null) {
    const connection = (handle as MysqlHandle)?.connection || handle as MysqlConnection;
    const [rows] = await connection.query('SHOW GRANTS');
    const grants = (Array.isArray(rows) ? rows as Payload[] : [])
      .flatMap((row) => Object.values(row || {}))
      .join(' ').toUpperCase();
    const writable = /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|ALL)\b/u.test(grants);
    return { confirmedReadOnly: /\bSELECT\b/u.test(grants) && !writable, writable };
  },
  async estimate(
    handle: MysqlHandle | MysqlConnection | null,
    analysis: Payload = {},
    limits: Payload = {},
  ) {
    const connection = (handle as MysqlHandle)?.connection || handle as MysqlConnection;
    let rows: number | null = Number.isFinite(analysis.rowEstimate)
      ? analysis.rowEstimate as number
      : null;
    let bytes: number | null = null;
    try {
      const explain = connection.execute || connection.query;
      const [result] = await explain.call(
        connection,
        `EXPLAIN FORMAT=JSON ${String(analysis.text || '')}`,
        (analysis.params as unknown[]) || [],
      );
      const first = (result as Payload[] | undefined)?.[0] || {};
      const raw = Object.values(first)[0];
      const plan: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const metrics = explainMetrics(plan);
      rows = metrics.rows.length ? Math.max(...metrics.rows) : rows;
      bytes = metrics.bytes.length ? Math.max(...metrics.bytes) : null;
    } catch {
      // Неизвестная оценка отключит auto-read, но не мешает ручному подтверждению.
    }
    return {
      rows,
      bytes,
      timeoutMs: Number(limits.timeoutMs) || 15_000,
    };
  },
  async execute(handle: MysqlHandle | MysqlConnection | null, request: Payload = {}) {
    const connection = (handle as MysqlHandle)?.connection || handle as MysqlConnection;
    const limits = (request.limits ?? {}) as Payload;
    const timeoutMs = Math.max(1, Number(limits.timeoutMs) || 15_000);
    const text = withTimeoutHint(request.text, timeoutMs);
    const execute = connection.execute as
      (text: string, params?: unknown[]) => Promise<unknown[]>;
    const running = execute.call(connection, text, (request.params as unknown[]) || []);

    running.catch?.(() => {});
    let timer: ReturnType<typeof setTimeout> | null = null;
    // MAX_EXECUTION_TIME ограничивает только SELECT, поэтому предел пишущего запроса
    // держит сторож, снимающий запрос настоящим KILL QUERY.
    const guard = new Promise<unknown[]>((_resolve, reject) => {
      timer = setTimeout(() => {
        void Promise.resolve(killQuery(handle)).catch(() => {});
        reject(Object.assign(
          new Error('Запрос БД превысил лимит времени'),
          { code: 'query_timeout' },
        ));
      }, timeoutMs);
    });

    try {
      const [rows] = await Promise.race([running, guard]);

      return Array.isArray(rows) ? rows as unknown[] : [rows];
    } finally {
      if (timer) clearTimeout(timer);
    }
  },
  async cancel(handle: MysqlHandle | MysqlConnection | null) {
    return killQuery(handle);
  },
};

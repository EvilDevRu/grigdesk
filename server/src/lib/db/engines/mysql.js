import mysql from 'mysql2/promise';

const FORBIDDEN = [
  ['LOAD_FILE', /\bLOAD_FILE\s*\(/iu],
  ['SLEEP', /\bSLEEP\s*\(/iu],
  ['BENCHMARK', /\bBENCHMARK\s*\(/iu],
  ['GET_LOCK', /\bGET_LOCK\s*\(/iu],
  ['INTO OUTFILE', /\bINTO\s+OUTFILE\b/iu],
  ['LOCK IN SHARE MODE', /\bLOCK\s+IN\s+SHARE\s+MODE\b/iu],
  ['FOR UPDATE', /\bFOR\s+UPDATE\b/iu],
];

function statements(text) {
  return String(text || '').split(';').map((part) => part.trim()).filter(Boolean);
}

function tablesOf(text) {
  const tables = [];
  const pattern = /\b(?:FROM|JOIN|UPDATE|INTO|TABLE)\s+`?([A-Za-z0-9_.-]+)`?/giu;
  for (const match of String(text).matchAll(pattern)) {
    if (!tables.includes(match[1])) tables.push(match[1]);
  }
  return tables;
}

function queryClassOf(text) {
  const first = String(text || '').trim().match(/^([A-Za-z]+)/u)?.[1]?.toUpperCase();
  if (['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN'].includes(first)) return 'read';
  if (['INSERT', 'UPDATE', 'DELETE', 'REPLACE'].includes(first)) return 'write';
  if (['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME'].includes(first)) return 'ddl';
  if (['GRANT', 'REVOKE', 'KILL', 'SET', 'FLUSH', 'OPTIMIZE'].includes(first)) return 'admin';
  return 'unknown';
}

function insertedRows(text) {
  const values = String(text || '').match(/\bVALUES\b([\s\S]*)$/iu)?.[1] || '';
  const rows = values.match(/\([^)]*\)/gu)?.length || 0;
  return rows || null;
}

function bytesOf(value) {
  if (Number.isFinite(Number(value))) return Number(value);
  const match = String(value || '').trim().match(/^([\d.]+)\s*([KMGT]?I?B?)$/iu);
  if (!match) return null;
  const unit = match[2].toUpperCase();
  const powers = { B: 1, K: 1_024, KB: 1_000, KIB: 1_024, M: 1_024 ** 2,
    MB: 1_000 ** 2, MIB: 1_024 ** 2, G: 1_024 ** 3, GB: 1_000 ** 3,
    GIB: 1_024 ** 3, T: 1_024 ** 4, TB: 1_000 ** 4, TIB: 1_024 ** 4 };
  return Number(match[1]) * (powers[unit] || 1);
}

/** Из JSON EXPLAIN берём оценки планировщика, а не пользовательские потолки результата. */
function explainMetrics(value, target = { rows: [], bytes: [] }) {
  if (!value || typeof value !== 'object') return target;
  for (const [key, nested] of Object.entries(value)) {
    if (/^rows_(?:examined|produced)_per_(?:scan|join)$/u.test(key)) {
      const rows = Number(nested);
      if (Number.isFinite(rows)) target.rows.push(rows);
    } else if (key === 'data_read_per_join') {
      const bytes = bytesOf(nested);
      if (Number.isFinite(bytes)) target.bytes.push(bytes);
    }
    explainMetrics(nested, target);
  }
  return target;
}

function withTimeoutHint(text, timeoutMs) {
  const delay = Math.max(1, Math.floor(Number(timeoutMs) || 15_000));
  return String(text || '').replace(/^\s*SELECT\b/iu, (keyword) => (
    `${keyword} /*+ MAX_EXECUTION_TIME(${delay}) */`
  ));
}

async function close(handle) {
  const connection = handle?.connection || handle;
  await Promise.allSettled([connection?.end?.(), handle?.control?.end?.()]);
}

/**
 * Отмена обязана прерывать сам ЗАПРОС, а не соединение: рабочий сокет занят ответом
 * сервера, поэтому KILL QUERY уходит по служебному соединению сессии. Разрыв остаётся
 * крайним средством и объявляется вызывающему честно — после него сессия непригодна.
 */
async function killQuery(handle) {
  const connection = handle?.connection || handle;
  const control = handle?.control;
  const threadId = Number(handle?.threadId ?? connection?.threadId);
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

  async open({ profile, password, stream, openStream, driver = mysql } = {}) {
    const base = {
      host: profile?.host,
      port: Number(profile?.port) || 3306,
      user: profile?.user,
      database: profile?.database || undefined,
      password: Buffer.isBuffer(password) ? password.toString('utf8') : String(password || ''),
      multipleStatements: false,
    };
    const connection = await driver.createConnection({ ...base, ...(stream ? { stream } : {}) });
    let readOnlyActive = false;
    if (profile?.role === 'read') {
      await connection.query('SET SESSION TRANSACTION READ ONLY');
      readOnlyActive = true;
    }

    // Служебное соединение открывается вместе с сессией: пароль есть только здесь,
    // а позже взять его будет негде. Отказ туннеля не мешает открыть саму сессию.
    let control = null;
    try {
      const controlStream = stream && typeof openStream === 'function' ? await openStream() : null;
      if (!stream || controlStream) {
        control = await driver.createConnection({
          ...base,
          ...(controlStream ? { stream: controlStream } : {}),
        });
      }
    } catch {
      control = null;
    }

    const handle = { connection, control, threadId: connection.threadId, readOnlyActive };
    handle.close = () => close(handle);
    return handle;
  },
  close,
  async schema(handle) {
    const connection = handle?.connection || handle;
    const [rows] = await connection.query('SHOW TABLES');
    return rows;
  },
  async analyze(text) {
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
  async inspectRights(handle) {
    const connection = handle?.connection || handle;
    const [rows] = await connection.query('SHOW GRANTS');
    const grants = (Array.isArray(rows) ? rows : []).flatMap((row) => Object.values(row || {}))
      .join(' ').toUpperCase();
    const writable = /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|ALL)\b/u.test(grants);
    return { confirmedReadOnly: /\bSELECT\b/u.test(grants) && !writable, writable };
  },
  async estimate(handle, analysis = {}, limits = {}) {
    const connection = handle?.connection || handle;
    let rows = Number.isFinite(analysis.rowEstimate) ? analysis.rowEstimate : null;
    let bytes = null;
    try {
      const explain = connection.execute || connection.query;
      const [result] = await explain.call(
        connection,
        `EXPLAIN FORMAT=JSON ${String(analysis.text || '')}`,
        analysis.params || [],
      );
      const raw = Object.values(result?.[0] || {})[0];
      const plan = typeof raw === 'string' ? JSON.parse(raw) : raw;
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
  async execute(handle, request = {}) {
    const connection = handle?.connection || handle;
    const timeoutMs = Math.max(1, Number(request.limits?.timeoutMs) || 15_000);
    const text = withTimeoutHint(request.text, timeoutMs);
    const running = connection.execute(text, request.params || []);
    running.catch?.(() => {});
    let timer = null;
    // MAX_EXECUTION_TIME ограничивает только SELECT, поэтому предел пишущего запроса
    // держит сторож, снимающий запрос настоящим KILL QUERY.
    const guard = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        Promise.resolve(killQuery(handle)).catch(() => {});
        const error = new Error('Запрос БД превысил лимит времени');
        error.code = 'query_timeout';
        reject(error);
      }, timeoutMs);
    });
    try {
      const [rows] = await Promise.race([running, guard]);
      return Array.isArray(rows) ? rows : [rows];
    } finally {
      clearTimeout(timer);
    }
  },
  async cancel(handle) {
    return killQuery(handle);
  },
};

const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/gu;
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;

// Ограниченный ответ базы. Показанное и настоящее разведены нарочно: при обрыве
// запроса полного счёта не существует, и подставлять вместо него показанное
// значило бы выдать кусок за весь результат.
export interface LimitedDbResult {
  rows: unknown[];
  shownRows: number;
  totalRows: number | null;
  shownBytes: number;
  totalBytes: number | null;
  truncated: boolean;
  untrusted: boolean;
  notice?: string;
}

export interface LimitOptions {
  maxRows?: number;
  maxBytes?: number;
  completed?: boolean;
}

/**
 * Управляющие последовательности снимаются с ключей и значений ответа базы.
 * Date преобразуется до обхода объектов, иначе дата превращается в пустой словарь.
 */
function sanitize(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(ANSI, '').replace(CONTROLS, '');
  }

  if (value instanceof Date) {
    return value.toJSON();
  }

  if (Array.isArray(value)) {
    return value.map(sanitize);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [sanitize(key), sanitize(item)]));
  }

  return value;
}

/**
 * Лимит оставляет непрерывное начало выборки из целых строк и не режет UTF-8.
 * После остановки показа обход продолжается только для честного полного объёма.
 */
export async function normalizeDbResult(
  input: unknown,
  options: LimitOptions = {},
): Promise<LimitedDbResult> {
  const carrier = (input ?? {}) as { rows?: unknown };
  const source = Array.isArray(input)
    ? input as unknown[]
    : (Array.isArray(carrier.rows) ? carrier.rows as unknown[] : []);
  const rows = source.map(sanitize);
  const maxRows = Math.max(0, Number(options.maxRows) || 0);
  const maxBytes = Math.max(0, Number(options.maxBytes) || 0);
  const shown = [];
  let shownBytes = 0;
  let totalBytes = 0;
  let accepting = true;

  for (const row of rows) {
    const bytes = Buffer.byteLength(JSON.stringify(row), 'utf8');

    totalBytes += bytes;

    if (!accepting || shown.length >= maxRows || shownBytes + bytes > maxBytes) {
      accepting = false;
      continue;
    }

    shown.push(row);
    shownBytes += bytes;
  }

  const completed = options.completed !== false;
  const truncated = shown.length < rows.length || !completed;
  const totalRows = completed ? rows.length : null;

  return {
    rows: shown,
    shownRows: shown.length,
    totalRows,
    shownBytes,
    totalBytes: completed ? totalBytes : null,
    truncated,
    untrusted: true,
    ...(truncated ? {
      notice: completed
        ? `показано ${shown.length} из ${rows.length}`
        : `получено ${shown.length} до прерывания`,
    } : {}),
  };
}

export const limitDbResult = normalizeDbResult;
export default normalizeDbResult;

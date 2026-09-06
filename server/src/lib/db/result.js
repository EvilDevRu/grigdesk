const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/gu;
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;

function sanitize(value) {
  if (typeof value === 'string') return value.replace(ANSI, '').replace(CONTROLS, '');
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [sanitize(key), sanitize(item)]));
  }
  return value;
}

/** Ограничение считает сериализованные полные строки и никогда не режет UTF-8 значение. */
export async function normalizeDbResult(input, options = {}) {
  const source = Array.isArray(input) ? input : (Array.isArray(input?.rows) ? input.rows : []);
  const rows = source.map(sanitize);
  const maxRows = Math.max(0, Number(options.maxRows) || 0);
  const maxBytes = Math.max(0, Number(options.maxBytes) || 0);
  const shown = [];
  let shownBytes = 0;
  let totalBytes = 0;
  for (const row of rows) {
    const bytes = Buffer.byteLength(JSON.stringify(row), 'utf8');
    totalBytes += bytes;
    if (shown.length >= maxRows || shownBytes + bytes > maxBytes) continue;
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

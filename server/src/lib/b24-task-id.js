// Разбор номера B24-задачи для серверных наборов id (избранное, просмотренное).
// Общий здесь только разбор: код ошибки принадлежит своему хранилищу, потому что
// контракт отказа виден клиенту и смешивать их нельзя.
const MAX_TASK_ID_DIGITS = 20;

/** @returns {string|null} канонический id либо null, если значение не номер задачи. */
export function parseB24TaskId(value) {
  let raw;
  if (typeof value === 'number') {
    raw = Number.isSafeInteger(value) ? String(value) : '';
  } else if (typeof value === 'string') {
    raw = value.trim();
  } else {
    raw = '';
  }

  if (!/^\d+$/.test(raw) || raw.length > MAX_TASK_ID_DIGITS) return null;
  const normalized = BigInt(raw);
  if (normalized <= 0n) return null;
  return normalized.toString();
}

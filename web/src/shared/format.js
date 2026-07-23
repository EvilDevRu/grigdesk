// Форматирование времени под доску B24.

/** Десятичные часы → «Xч Yмин» (или «Yмин», если часов нет). */
export function hoursToHM(h) {
  const totalMin = Math.round((Number(h) || 0) * 60);
  const H = Math.floor(totalMin / 60);
  const M = totalMin % 60;
  return H ? `${H}ч ${M}мин` : `${M}мин`;
}

/** Секунды → «H:MM:SS» (часы могут быть больше 99 — таймер задачи). */
export function secToHMS(s) {
  const sec = Math.max(0, Math.floor(Number(s) || 0));
  const H = Math.floor(sec / 3600);
  const M = Math.floor((sec % 3600) / 60);
  const S = sec % 60;
  const p = (n) => String(n).padStart(2, '0');
  return `${H}:${p(M)}:${p(S)}`;
}

/** Знаковая дельта для «vs вчера». */
export function signed(n, suffix = '') {
  const v = Number(n) || 0;
  const s = v > 0 ? '+' : '';
  return `${s}${v}${suffix}`;
}

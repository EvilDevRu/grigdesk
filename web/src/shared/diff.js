// Построчный дифф для правок агента (шаг Edit в ленте чата).
// Нужен, чтобы правка выглядела как в VS Code — «убрано / добавлено» с подсветкой,
// а не двумя простынями «было»/«стало». Алгоритм — LCS по строкам; на больших
// кусках вырождается в «всё убрали, всё добавили» (дешевле, чем считать O(n²) зря).
const MAX_LINES = 400;

/**
 * @returns {{ rows: Array<{t:'ctx'|'del'|'add', text:string}>, added:number, removed:number }}
 */
export function lineDiff(oldText, newText) {
  const a = String(oldText ?? '').split('\n');
  const b = String(newText ?? '').split('\n');
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return {
      rows: [...a.map((text) => ({ t: 'del', text })), ...b.map((text) => ({ t: 'add', text }))],
      removed: a.length, added: b.length,
    };
  }
  // Таблица длин LCS.
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const rows = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { rows.push({ t: 'ctx', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { rows.push({ t: 'del', text: a[i] }); removed++; i++; }
    else { rows.push({ t: 'add', text: b[j] }); added++; j++; }
  }
  while (i < n) { rows.push({ t: 'del', text: a[i++] }); removed++; }
  while (j < m) { rows.push({ t: 'add', text: b[j++] }); added++; }
  return { rows, added, removed };
}

/**
 * Те же строки, но парами для показа в две колонки: слева убранное, справа добавленное.
 * Идущие подряд del/add ставятся друг напротив друга (как в split-виде дифф-просмотрщиков),
 * лишние строки одной из сторон получают пустого соседа.
 * @returns {Array<{l: {t:string,text:string}|null, r: {t:string,text:string}|null}>}
 */
export function splitRows(rows) {
  const out = [];
  for (let i = 0; i < rows.length;) {
    const r = rows[i];
    if (r.t === 'ctx') { out.push({ l: r, r }); i++; continue; }
    // Собираем блок изменений целиком: сначала все убранные, потом все добавленные.
    const dels = [];
    const adds = [];
    while (i < rows.length && rows[i].t === 'del') dels.push(rows[i++]);
    while (i < rows.length && rows[i].t === 'add') adds.push(rows[i++]);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      out.push({ l: dels[k] || null, r: adds[k] || null });
    }
  }
  return out;
}

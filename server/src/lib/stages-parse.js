// Парсер человекочитаемого журнала оркестратора `logs/tNNNN.stages.log`.
// Строка: `YYYY-MM-DD HH:MM:SS [tNNNN] <событие>`.

const LINE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+\[t(\d+)\]\s+(.*)$/;

/**
 * Разбирает журнал этапов в массив событий (в порядке файла).
 * @param {string} text
 * @returns {Array<{ ts: string, task: string, event: string }>}
 */
export function parseStagesLog(text) {
  const out = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const m = LINE.exec(line);
    if (!m) continue;
    out.push({ ts: m[1], task: m[2], event: m[3] });
  }
  return out;
}

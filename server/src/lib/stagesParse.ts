// Парсер человекочитаемого журнала оркестратора `logs/tNNNN.stages.log`.
// Строка: `YYYY-MM-DD HH:MM:SS [tNNNN] <событие>`.

const LINE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+\[t(\d+)\]\s+(.*)$/;

// Одно событие журнала: когда, у какой задачи и что случилось.
export interface StageLogEvent {
  ts: string;
  task: string;
  event: string;
}

/** Разбирает журнал этапов в массив событий, сохраняя порядок файла. */
export function parseStagesLog(text: string): StageLogEvent[] {
  const out: StageLogEvent[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const m = LINE.exec(line);
    if (!m) continue;
    out.push({
      ts: m[1] ?? '',
      task: m[2] ?? '',
      event: m[3] ?? '',
    });
  }
  return out;
}

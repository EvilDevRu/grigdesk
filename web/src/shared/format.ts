// Форматирование времени под доску B24.

// Проекция времени работы узлов конвейера: сумма завершённого и, если узел идёт
// прямо сейчас, точка отсчёта незавершённого интервала.
interface PipelineTiming {
  workSec?: unknown;
  runningSinceMs?: unknown;
}

// Задача доски в тех полях, из которых считается живой таймер.
interface TimedTask {
  timerElapsed?: unknown;
  timerRunning?: unknown;
  timerStartedAt?: unknown;
}

/**
 * Десятичные часы → «Xч Yмин» (или «Yмин», если часов нет). Округление в минутах,
 * а не в часах: доска показывает отработанное, и «0.9ч» человек читает как 54 минуты.
 */
export function hoursToHM(h: unknown): string {
  const totalMin = Math.round((Number(h) || 0) * 60);
  const H = Math.floor(totalMin / 60);
  const M = totalMin % 60;

  return H ? `${H}ч ${M}мин` : `${M}мин`;
}

/**
 * Секунды → «H:MM:SS». Часы намеренно без ведущего нуля и без потолка: таймер задачи
 * живёт сутками, и «99:59:59» обрезало бы правду.
 */
export function secToHMS(s: unknown): string {
  const sec = Math.max(0, Math.floor(Number(s) || 0));
  const H = Math.floor(sec / 3600);
  const M = Math.floor((sec % 3600) / 60);
  const S = sec % 60;
  const p = (n: number) => String(n).padStart(2, '0');

  return `${H}:${p(M)}:${p(S)}`;
}

/**
 * Секунды → «MM:SS»: таймкод внутри записи, где часов почти не бывает.
 * Минуты не сворачиваются в часы — иначе таймкоды записи перестали бы сравниваться.
 */
export function mmss(s: unknown): string {
  const sec = Math.max(0, Math.floor(Number(s) || 0));
  const p = (n: number) => String(n).padStart(2, '0');

  return `${p(Math.floor(sec / 60))}:${p(sec % 60)}`;
}

/**
 * Чистое время работы узлов конвейера.
 *
 * workSec уже содержит все завершённые проходы и петли текущей попытки. Если сейчас
 * исполняется рабочий узел, сервер добавляет runningSinceMs — дотикиваем только этот
 * незавершённый интервал. Ожидание ворот лежит отдельно и сюда не входит.
 */
export function pipelineWorkSec(
  timing: PipelineTiming | null | undefined,
  nowMs: unknown,
): number | null {
  const stored = Number(timing?.workSec);

  if (!Number.isFinite(stored) || stored < 0) {
    return null;
  }

  const sinceMs = Number(timing?.runningSinceMs);
  const now = Number(nowMs);
  const live = Number.isFinite(sinceMs) && sinceMs > 0 && Number.isFinite(now)
    ? Math.max(0, Math.floor((now - sinceMs) / 1000))
    : 0;

  return Math.floor(stored) + live;
}

/**
 * Живое время таймера задачи, в секундах.
 *
 * B24 в getTodayData отдаёт `timer_elapsed = 0` даже у идущего таймера (проверено:
 * ноль у всех четырёх задач с `timer_running`), а настоящую точку отсчёта кладёт в
 * `timer_started_at` (Unix, СЕКУНДЫ). Раньше считали от момента загрузки доски —
 * на экране был возраст вкладки, а не время работы: задача, взятая в 13:50, после
 * F5 показывала «0:00:40». Поэтому у идущего таймера считаем от старта.
 *
 * Накопленное (`timerElapsed`) для идущего НЕ прибавляем: B24 его здесь не заполняет,
 * а если однажды начнёт — прибавка дала бы двойной счёт текущей сессии.
 */
export function liveTimerSec(task: TimedTask | null | undefined, nowMs: number): number {
  const stored = Number(task?.timerElapsed) || 0;

  if (!task?.timerRunning) {
    return stored;
  }

  const startedSec = Number(task.timerStartedAt) || 0;

  // Старта нет (старый кеш доски) — показываем хотя бы накопленное, а не ноль.
  if (!startedSec) {
    return stored;
  }

  return Math.max(0, nowMs / 1000 - startedSec);
}

/**
 * Размер в килобайтах или мегабайтах. Нечисло даёт пустую строку, а не «0 КБ»:
 * «неизвестно» и «пусто» — разные утверждения.
 */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n)) {
    return '';
  }

  if (n < 1024 * 1024) {
    return `${Math.round(n / 1024)} КБ`;
  }

  return `${(n / 1024 / 1024).toFixed(1)} МБ`;
}

/**
 * Знаковая дельта для «vs вчера»: плюс проставляется явно, минус приходит с числом.
 * Ноль остаётся без знака — рост и его отсутствие должны читаться по-разному.
 */
export function signed(n: unknown, suffix = ''): string {
  const v = Number(n) || 0;
  const s = v > 0 ? '+' : '';

  return `${s}${v}${suffix}`;
}

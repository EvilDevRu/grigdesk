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

/** Секунды → «MM:SS»: таймкод внутри записи, где часов почти не бывает. */
export function mmss(s) {
  const sec = Math.max(0, Math.floor(Number(s) || 0));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(sec / 60))}:${p(sec % 60)}`;
}

/**
 * Чистое время работы узлов конвейера.
 *
 * workSec уже содержит все завершённые проходы и петли текущей попытки. Если сейчас
 * исполняется рабочий узел, сервер добавляет runningSinceMs — дотикиваем только этот
 * незавершённый интервал. Ожидание ворот лежит отдельно и сюда не входит.
 */
export function pipelineWorkSec(timing, nowMs) {
  const stored = Number(timing?.workSec);
  if (!Number.isFinite(stored) || stored < 0) return null;
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
export function liveTimerSec(task, nowMs) {
  const stored = Number(task?.timerElapsed) || 0;
  if (!task?.timerRunning) return stored;
  const startedSec = Number(task.timerStartedAt) || 0;
  // Старта нет (старый кеш доски) — показываем хотя бы накопленное, а не ноль.
  if (!startedSec) return stored;
  return Math.max(0, nowMs / 1000 - startedSec);
}

/** Знаковая дельта для «vs вчера». */
export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} КБ`;
  return `${(n / 1024 / 1024).toFixed(1)} МБ`;
}

export function signed(n, suffix = '') {
  const v = Number(n) || 0;
  const s = v > 0 ? '+' : '';
  return `${s}${v}${suffix}`;
}

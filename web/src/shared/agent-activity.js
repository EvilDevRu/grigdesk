// Единый ответ на вопрос «что сейчас делает агент задачи».
// Спрашивают трое: плашка на странице конвейера, вотчер оповещений и чип в навигации.
// Правило одно на всех по той же причине, что и у pipeline-wait.js: разойдутся цифры —
// перестанут верить чипу.

/** Молчание в минутах, не меньше единицы: «0 мин» человеку ничего не говорит. */
function minutes(sec) { return Math.max(1, Math.floor(sec / 60)); }

/**
 * Граница «агент пишет»: свежее — активность, старше — уже молчание. Живёт здесь,
 * потому что спрашивают её с двух сторон: сервер (readActivity в factory-cli.js) и
 * карточки телеграм-пульта. Две копии этого числа разошлись бы так же, как разошлись
 * копии правила ожидания.
 */
export const JOURNAL_FRESH_SEC = 60;

/**
 * Замер молчания (`task.silence` из /api/tasks) → та же форма activity, которую
 * читает `agentActivityLabel`. Нужен там, где полного `readActivity` нет: список
 * задач его не отдаёт, а сказать «пишет или висит» карточка обязана.
 */
export function activityFromSilence(silence) {
  const sec = Number(silence?.sec);
  if (!Number.isFinite(sec) || sec < 0) return null;
  const age = Math.floor(sec);
  return { journalFresh: age < JOURNAL_FRESH_SEC, journalAgeSec: age, silentTool: silence?.tool || null };
}

export function agentActivityLabel(activity) {
  if (activity?.journalFresh) return 'агент пишет';
  if (!Number.isFinite(activity?.journalAgeSec)) return 'журнал не подключён';
  // Имя висящего вызова важнее цифры: десять минут `Bash` — это сборка, полчаса
  // playwright — мёртвый браузер. Такой инцидент должен читаться с одного взгляда.
  const tool = activity.silentTool ? ` (${activity.silentTool})` : '';
  return `нет событий ${minutes(activity.journalAgeSec)} мин${tool}`;
}

/**
 * Ход, который идёт, но молчит дольше порога. Это НЕ остановка конвейера (у той свой
 * detectStall на сервере): демон жив, этап работает, просто агент ничего не делает уже
 * очень долго — и без этой проверки такое видно только постфактум, по сгоревшему лимиту.
 *
 * @param {object} task сводка задачи (элемент /api/tasks)
 * @param {number} window порог в секундах (0 — не оповещать)
 * @returns {{stage: string, sec: number, tool: string|null, text: string}|null}
 */
export function silenceReason(task, window) {
  const s = task?.silence;
  if (!window || !s || !Number.isFinite(s.sec) || s.sec < window) return null;
  const stage = String(s.stage || '').toLowerCase();
  const tool = s.tool ? `, висит ${s.tool}` : '';
  return {
    stage: s.stage,
    sec: s.sec,
    tool: s.tool || null,
    text: `${stage}: молчит ${minutes(s.sec)} мин${tool}`,
  };
}

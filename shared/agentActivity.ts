// Единый ответ на вопрос «что сейчас делает агент задачи».
// Спрашивают четверо: плашка на странице конвейера, вотчер оповещений, чип в навигации
// и карточки телеграм-пульта. Правило одно на всех по той же причине, что и у
// pipelineWait.ts: разойдутся цифры — перестанут верить чипу.
//
// Модуль общий для сервера и браузера, поэтому не знает ни DOM, ни файловой системы:
// на входе только замеры, на выходе только текст и числа.

// Замер молчания из сводки задачи. Поля недоверенные: сводку собирает движок, и
// отсутствующий или отрицательный возраст означает «не измерено», а не ноль.
export interface AgentSilence {
  sec?: unknown;
  stage?: unknown;
  tool?: unknown;
}

// То, что читает подпись активности. `journalAgeSec` бывает нечислом ровно тогда,
// когда журнала нет вовсе, — это отдельное состояние, а не «ноль секунд».
export interface AgentActivity {
  journalFresh?: boolean;
  journalAgeSec?: number;
  silentTool?: string | null;
}

export interface AgentSilenceReason {
  stage: string;
  sec: number;
  tool: string | null;
  text: string;
}

/** Молчание в минутах, не меньше единицы: «0 мин» человеку ничего не говорит. */
function minutes(sec: number): number {
  return Math.max(1, Math.floor(sec / 60));
}

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
export function activityFromSilence(silence: AgentSilence | null | undefined): AgentActivity | null {
  const sec = Number(silence?.sec);

  if (!Number.isFinite(sec) || sec < 0) {
    return null;
  }

  const age = Math.floor(sec);

  return {
    journalFresh: age < JOURNAL_FRESH_SEC,
    journalAgeSec: age,
    silentTool: typeof silence?.tool === 'string' && silence.tool ? silence.tool : null,
  };
}

export function agentActivityLabel(activity: AgentActivity | null | undefined): string {
  if (activity?.journalFresh) {
    return 'агент пишет';
  }
  if (!Number.isFinite(activity?.journalAgeSec)) {
    return 'журнал не подключён';
  }

  // Имя висящего вызова важнее цифры: десять минут `Bash` — это сборка, полчаса
  // playwright — мёртвый браузер. Такой инцидент должен читаться с одного взгляда.
  const tool = activity?.silentTool ? ` (${activity.silentTool})` : '';

  return `нет событий ${minutes(Number(activity?.journalAgeSec))} мин${tool}`;
}

/**
 * Ход, который идёт, но молчит дольше порога. Это НЕ остановка конвейера (у той свой
 * detectStall на сервере): демон жив, этап работает, просто агент ничего не делает уже
 * очень долго — и без этой проверки такое видно только постфактум, по сгоревшему лимиту.
 */
export function silenceReason(
  task: { silence?: AgentSilence | null } | null | undefined,
  window: number,
): AgentSilenceReason | null {
  const silence = task?.silence;
  const sec = Number(silence?.sec);

  if (!window || !silence || !Number.isFinite(sec) || sec < window) {
    return null;
  }

  const stage = String(silence.stage || '').toLowerCase();
  const named = typeof silence.tool === 'string' && silence.tool ? silence.tool : null;
  const tool = named ? `, висит ${named}` : '';

  return {
    stage: String(silence.stage ?? ''),
    sec,
    tool: named,
    text: `${stage}: молчит ${minutes(sec)} мин${tool}`,
  };
}

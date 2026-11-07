// Граница доступа хука на чтение: какую ссылку вообще позволено разворачивать.
//
// Правило одно (docs/grigdesk/inbox.md, раздел «Telegram»): разворачивается
// только ссылка на чат, ПРИВЯЗАННЫЙ к проекту. Это allowlist — без правила отказ,
// и пустой список правил значит «закрыто везде». Иначе произвольная ссылка,
// вписанная в описание задачи, вытягивала бы содержимое любого чата, где бот
// случайно состоит.
//
// Проверка нужна в двух местах резолва, и это не дублирование:
//
//   • по форме ссылки (`targetOfLink`) — ДО обращения в сеть. Пересылать себе
//     сообщение из чужого чата нельзя даже ради того, чтобы узнать, чей он;
//   • по найденному сообщению (`targetOfMessage`) — и вот это решает. За формой
//     `t.me/<имя>/<N>` стоит и пост канала, и сообщение группы обсуждения: это
//     разные чаты, и совпадения по имени из ссылки мало.
//
// Первая проверка — фильтр, вторая — решение. Читать архив между ними безопасно:
// пока текст не показан человеку, ничего не раскрыто.
import { matchRule } from './rulesStore.ts';

// Правило привязки чата к проекту в том виде, в каком его читает граница доступа.
export interface TelegramScopeRule {
  project: string;
  chatId?: number | null;
  username?: string | null;
  threadId?: number | null;
}

export interface TelegramScopeTarget {
  chatId?: number | null;
  username?: string | null;
  threadId?: number | null;
}

export interface TelegramScopeVerdict {
  allowed: boolean;
  rule: TelegramScopeRule | null;
  reason: string | null;
  message: string;
}

const matchScopeRule = matchRule as (
  rules: unknown,
  target: TelegramScopeTarget,
) => TelegramScopeRule | null;

/** Единственная причина отказа этого слоя (остальные — у резолва). */
export const NOT_ALLOWED = 'not_allowed';

const ok = (rule: TelegramScopeRule): TelegramScopeVerdict => (
  { allowed: true, rule, reason: null, message: '' }
);
const no = (rule: TelegramScopeRule | null, message: string): TelegramScopeVerdict => (
  { allowed: false, rule, reason: NOT_ALLOWED, message }
);

/** Адрес, о котором спрашивает ссылка: что написано, то и берём. */
export function targetOfLink(link: TelegramScopeTarget = {}): TelegramScopeTarget {
  return {
    chatId: link.chatId ?? null,
    username: link.username ?? null,
    threadId: link.threadId ?? null,
  };
}

/**
 * Адрес найденного сообщения. Он знает обе стороны (id чата и его имя), поэтому
 * совпадает с правилом независимо от того, какой стороной его завели.
 */
export function targetOfMessage(msg: {
  chatId?: number | null;
  chatUsername?: string | null;
  threadId?: number | null;
} = {}): TelegramScopeTarget {
  return {
    chatId: msg.chatId ?? null,
    username: msg.chatUsername || null,
    // Тему берём у сообщения, а не у ссылки: её копируют и без номера темы.
    threadId: msg.threadId ?? null,
  };
}

/**
 * Можно ли трогать этот адрес и по чьему правилу.
 *
 * `project` — проект, в контексте которого спрашивают (профиль прогона, проект
 * связки). Он известен не всегда: задачу трекера открывают и до запуска, профиля
 * у неё тогда нет. В этом случае сверять не с чем, но граница остаётся — чат
 * обязан быть привязан хоть к чему-то.
 *
 * Решает ровно то правило, которое выбрал `matchRule`: тема сильнее чата. Если у
 * темы своё правило, тема принадлежит его проекту — общая привязка чата её больше
 * не покрывает. Второй логики совпадения здесь нет намеренно: разошлась бы с первой.
 *
 * @param {Array<object>} rules нормализованные правила
 * @param {{chatId?: number|null, username?: string|null, threadId?: number|null}} target
 * @param {{project?: string|null}} [opts]
 * @returns {{allowed: boolean, rule: object|null, reason: string|null, message: string}}
 */
export function checkScope(rules: unknown, target: TelegramScopeTarget, { project = null }: {
  project?: string | null;
} = {}): TelegramScopeVerdict {
  const rule = matchScopeRule(rules, target || {});
  if (!rule) {
    return no(null, 'Чат не привязан ни к одному проекту — разворачивать нечего. '
      + 'Привязка заводится в разделе «Телеграм», карточка «Разрешённые чаты».');
  }
  const want = project ? String(project).trim() : '';
  if (want && rule.project !== want) {
    return no(rule, `Чат привязан к проекту «${rule.project}», а речь идёт о «${want}».`);
  }
  return ok(rule);
}

/**
 * Вердикт на каждую ссылку из текста. Ссылка остаётся при своём вердикте: отказ
 * показывается человеку вместе с причиной, а не молча пропадает из задачи.
 */
export function scopeLinks(links: unknown, { rules = [], project = null }: {
  rules?: unknown;
  project?: string | null;
} = {}) {
  return (Array.isArray(links) ? links as TelegramScopeTarget[] : []).map((link) => ({
    link,
    ...checkScope(rules, targetOfLink(link), { project }),
  }));
}

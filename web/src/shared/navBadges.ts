import { type LocaleSource, localeTranslator } from '../../../shared/i18n/catalogs.ts';
import { translate as t } from '../../../shared/i18n/catalogs.ts';

interface Badge {
  n: number;
  kind: string | null;
  title: string;
}

interface ShelfRow {
  taskId: unknown;
  completed?: unknown;
  state?: string;
  needsHuman?: unknown;
  details?: { activities?: Array<{ tone?: string }> };
}

const PRIORITY: Record<string, number> = {
  info: 1,
  wait: 2,
  stall: 3,
};

/**
 * Счётчик общей очереди живёт на пункте Inbox, а не на странице канала.
 * Нулевая очередь не создаёт отдельную строку под иконкой.
 */
export function inboxNavBadge({ reviewCount = 0 }: { reviewCount?: unknown } = {},
  locale: LocaleSource = 'ru',
): Record<string, Badge> {
  const t = localeTranslator(locale);

  const count = Math.max(0, Number(reviewCount) || 0);

  return count ? {
    '/inbox': {
      n: count,
      kind: 'info',
      title: t("core.toReview", { count: count }),
    },
  } : {};
}

/**
 * Считаем объединение непрочитанных и ожидающих ответа чатов, включая архив.
 * Несколько вопросов одного чата и пересечение двух состояний не увеличивают итог.
 */
export function chatNavBadge({ sessions = [], archived = [], waitingChats = new Set() }: {
  sessions?: Array<{ id: string; unread?: unknown }>;
  archived?: Array<{ id: string; unread?: unknown }>;
  waitingChats?: Set<string>;
} = {},
  locale: LocaleSource = 'ru',
): Badge | null {
  const t = localeTranslator(locale);

  const unread = new Set([...sessions, ...archived].filter((chat) => chat.unread).map((chat) => chat.id));
  const attention = new Set([...unread, ...waitingChats]);

  if (!attention.size) {
    return null;
  }

  return {
    n: attention.size,
    kind: waitingChats.size ? 'wait' : 'info',
    title: t("core.needAttentionAwaitingResponse", {
        attentionSize: attention.size,
        waitingChatsSize: waitingChats.size,
      })
      + t("core.unread", { unreadSize: unread.size }),
  };
}

/**
 * Берём уже дедуплицированную сводку конвейера; обычная работа не требует внимания.
 * Проблемы определяют цвет раньше ожидания, а подсказка сохраняет обе причины.
 */
export function pipelineNavBadge({ errorCount = 0, waitingCount = 0 }: {
  errorCount?: number;
  waitingCount?: number;
} = {},
  locale: LocaleSource = 'ru',
): Badge | null {
  const t = localeTranslator(locale);

  const count = errorCount + waitingCount;


  return count ? {
    n: count,
    kind: errorCount ? 'stall' : 'wait',
    title: t("core.needInterventionIssuesAwaitingDecision", {
        count,
        errorCount,
        waitingCount,
      }),
  } : null;
}

/**
 * Повторяем состав группы «Требуют внимания» полки, не включая завершённые задачи.
 * Цвет берём из готовой проекции состояния; одно событие и ожидание дают одну задачу.
 */
export function shelfNavBadge(rows: ShelfRow[] = [],
  locale: LocaleSource = 'ru',
): Badge | null {
  const t = localeTranslator(locale);

  const attention = new Map<unknown, ShelfRow>();

  for (const row of rows) {
    if (!row.completed && (row.state === 'lit' || row.needsHuman)) {
      attention.set(row.taskId, row);
    }
  }

  if (!attention.size) {
    return null;
  }

  const counts = {
    stall: 0,
    wait: 0,
    info: 0,
  };

  for (const row of attention.values()) {
    const problem = row.details?.activities?.some((activity) => activity.tone === 'bad');
    const kind = problem ? 'stall' : row.needsHuman ? 'wait' : 'info';

    counts[kind] += 1;
  }

  return {
    n: attention.size,
    kind: counts.stall ? 'stall' : counts.wait ? 'wait' : 'info',
    title: t("core.needAttentionIssues", { attentionSize: attention.size, countsStall: counts.stall })
      + t("core.awaitingDecisionNewEvents", { countsWait: counts.wait, countsInfo: counts.info }),
  };
}

/**
 * Агрегат дочерних разделов сохраняет количество и наиболее срочный цвет.
 * Подсказка называет вклад каждого раздела, чтобы число не теряло причины.
 */
export function aggregateNavBadges(entries: Array<{
  label: string;
  badge?: Badge | null;
}> | null | undefined): Badge | null {
  const live = (entries || []).filter((entry) => Number(entry.badge?.n) > 0);

  if (!live.length) {
    return null;
  }

  const top = live.reduce<string | null>((best, entry) => {
    const kind = PRIORITY[entry.badge!.kind!] ? entry.badge!.kind! : 'info';

    return !best || PRIORITY[kind]! > PRIORITY[best]! ? kind : best;
  }, null);

  return {
    n: live.reduce((sum, entry) => sum + Number(entry.badge!.n || 0), 0),
    kind: top,
    title: live.map((entry) => `${entry.label}: ${entry.badge!.n}`).join(' · '),
  };
}

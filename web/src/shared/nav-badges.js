const PRIORITY = { info: 1, wait: 2, stall: 3 };

/**
 * Счётчик общей очереди живёт на пункте Inbox, а не на странице канала.
 * Нулевая очередь не создаёт отдельную строку под иконкой.
 */
export function inboxNavBadge({ reviewCount = 0 } = {}) {
  const count = Math.max(0, Number(reviewCount) || 0);
  return count ? {
    '/inbox': {
      n: count,
      kind: 'info',
      title: `к разбору: ${count}`,
    },
  } : {};
}

/**
 * Считаем объединение непрочитанных и ожидающих ответа чатов, включая архив.
 * Несколько вопросов одного чата и пересечение двух состояний не увеличивают итог.
 */
export function chatNavBadge({ sessions = [], archived = [], waitingChats = new Set() } = {}) {
  const unread = new Set([...sessions, ...archived].filter((chat) => chat.unread).map((chat) => chat.id));
  const attention = new Set([...unread, ...waitingChats]);

  if (!attention.size) {
    return null;
  }

  return {
    n: attention.size,
    kind: waitingChats.size ? 'wait' : 'info',
    title: `Требуют внимания: ${attention.size} · ждут ответа: ${waitingChats.size}`
      + ` · непрочитанные: ${unread.size}`,
  };
}

/**
 * Берём уже дедуплицированную сводку конвейера; обычная работа не требует внимания.
 * Проблемы определяют цвет раньше ожидания, а подсказка сохраняет обе причины.
 */
export function pipelineNavBadge({ errorCount = 0, waitingCount = 0 } = {}) {
  const count = errorCount + waitingCount;

  return count ? {
    n: count,
    kind: errorCount ? 'stall' : 'wait',
    title: `Требуют вмешательства: ${count} · проблемы: ${errorCount} · ждут решения: ${waitingCount}`,
  } : null;
}

/**
 * Повторяем состав группы «Требуют внимания» полки, не включая завершённые задачи.
 * Цвет берём из готовой проекции состояния; одно событие и ожидание дают одну задачу.
 */
export function shelfNavBadge(rows = []) {
  const attention = new Map();

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
    title: `Требуют внимания: ${attention.size} · проблемы: ${counts.stall}`
      + ` · ждут решения: ${counts.wait} · новые события: ${counts.info}`,
  };
}

/**
 * Агрегат дочерних разделов сохраняет количество и наиболее срочный цвет.
 * Подсказка называет вклад каждого раздела, чтобы число не теряло причины.
 */
export function aggregateNavBadges(entries) {
  const live = (entries || []).filter((entry) => Number(entry.badge?.n) > 0);

  if (!live.length) {
    return null;
  }
  const top = live.reduce((best, entry) => {
    const kind = PRIORITY[entry.badge.kind] ? entry.badge.kind : 'info';
    return !best || PRIORITY[kind] > PRIORITY[best] ? kind : best;
  }, null);
  return {
    n: live.reduce((sum, entry) => sum + Number(entry.badge.n || 0), 0),
    kind: top,
    title: live.map((entry) => `${entry.label}: ${entry.badge.n}`).join(' · '),
  };
}

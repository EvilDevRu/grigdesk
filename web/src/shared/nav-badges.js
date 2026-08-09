const PRIORITY = { info: 1, wait: 2, stall: 3 };

/** Бейдж общей очереди живёт на rail-пункте Inbox, а не на странице канала. */
export function inboxNavBadge({ newCount = 0 } = {}) {
  const count = Math.max(0, Number(newCount) || 0);
  return count ? {
    '/inbox': {
      n: count,
      kind: 'info',
      title: `новых обращений: ${count}`,
    },
  } : {};
}

/** Агрегат дочерних разделов: число не теряет причины, цвет — самый срочный. */
export function aggregateNavBadges(entries) {
  const live = (entries || []).filter((entry) => Number(entry.badge?.n) > 0);
  if (!live.length) return null;
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

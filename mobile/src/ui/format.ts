const DAY = 24 * 60 * 60 * 1000;

export const clock = (at: number) =>
  new Date(at).toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  });

/**
 * Время в строке списка — как в мессенджерах: сегодня только часы, вчера словом,
 * в этом году дата без года, старше — полная дата. Строка остаётся короткой и в узкой колонке.
 */
export function when(at: number, now = Date.now()) {
  const date = new Date(at);
  const today = new Date(now);
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();

  if (at >= start) {
    return clock(at);
  }

  if (at >= start - DAY) {
    return 'вчера';
  }

  if (date.getFullYear() === today.getFullYear()) {
    return date
      .toLocaleDateString('ru-RU', {
        day: 'numeric',
        month: 'short',
      })
      .replace('.', '');
  }

  return date.toLocaleDateString('ru-RU');
}

export const initial = (title: string) => (title.trim()[0] || '•').toUpperCase();

/**
 * Чат использует компактное относительное время веб-Кокпита, а не полную дату с годом.
 * Календарная подпись после недели оставляет место названию в портретной колонке.
 */
export function ago(at: number, now = Date.now()) {
  const elapsed = Math.max(0, now - at);

  if (elapsed < 60000) {
    return 'сейчас';
  }
  if (elapsed < 3600000) {
    return `${Math.floor(elapsed / 60000)}м`;
  }
  if (elapsed < DAY) {
    return `${Math.floor(elapsed / 3600000)}ч`;
  }
  if (elapsed < 7 * DAY) {
    return `${Math.floor(elapsed / DAY)}д`;
  }

  return new Date(at).toLocaleDateString('ru', {
    day: '2-digit',
    month: '2-digit',
  });
}

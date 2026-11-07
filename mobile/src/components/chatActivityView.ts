import type { ChatActivity, ChatActivityItem } from '../api/contract.ts';
import type { IconName } from '../ui/icons.ts';

/**
 * Значок описывает действие, а не исполнителя: неизвестный инструмент остаётся различимым.
 * Статус выполнения рисуется отдельно, чтобы галочка не заменяла смысл строки.
 */
export function activityIcon(item: ChatActivityItem): IconName {
  if (item.kind === 'think') {
    return 'think';
  }
  if (item.kind === 'text') {
    return 'chats';
  }
  if (/bash|exec|command|shell|terminal/i.test(item.title)) {
    return 'command';
  }
  if (/edit|write|patch/i.test(item.title)) {
    return 'edit';
  }
  if (/read|view|open/i.test(item.title)) {
    return 'read';
  }
  if (/search|find|glob|grep/i.test(item.title)) {
    return 'search';
  }

  return 'activity';
}

/**
 * Состояние опирается на незавершённое действие; старый выполненный шаг не становится текущим.
 * Когда сервер не дал деталей, нейтральная подпись не обещает конкретной работы.
 */
export function activityStatus(activity?: ChatActivity, waiting = false): string {
  if (waiting) {
    return 'Жду вашего ответа';
  }

  const current = activity?.items.findLast((item) => item.state === 'running');

  if (!current) {
    return 'Агент работает…';
  }

  const icon = activityIcon(current);
  const labels: Partial<Record<IconName, string>> = {
    command: 'Выполняю команду…',
    read: 'Читаю…',
    edit: 'Вношу изменения…',
    search: 'Ищу…',
    think: 'Размышляю…',
  };

  return labels[icon] || 'Выполняю действие…';
}

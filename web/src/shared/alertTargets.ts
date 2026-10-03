export const ALERT_CHAT_QUERY = 'openChat';
export const ALERT_TASK_QUERY = 'openTask';

export type AlertTarget = {
  kind: 'chat';
  chatId: string;
} | {
  kind: 'pipeline';
  taskId: string;
} | {
  kind: 'task';
  taskId: string;
};

/**
 * Формирует ссылку для системного уведомления с безопасным кодированием id.
 * Отдельные query-ключи не пересекаются с параметрами страницы «Диф».
 */
export function alertTargetHash(target: AlertTarget): string {
  if (target.kind === 'chat') {
    return `#/chats?${ALERT_CHAT_QUERY}=${encodeURIComponent(target.chatId)}`;
  }
  if (target.kind === 'task') {
    return `#/shelf?${ALERT_TASK_QUERY}=${encodeURIComponent(target.taskId)}`;
  }

  return '#/pipeline';
}

/**
 * Называет действие по виду цели одинаково для всех источников оповещений.
 * Подпись не зависит от текущего раздела приложения.
 */
export function alertTargetLabel(target: AlertTarget): string {
  if (target.kind === 'chat') {
    return 'Открыть чат';
  }

  return target.kind === 'task' ? 'Открыть задачу' : 'Открыть конвейер';
}

/**
 * Vue Router может отдать строку или массив значений одного query-ключа.
 * Посторонние значения не превращаются в случайный идентификатор чата или задачи.
 */
export function firstQueryValue(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }

  return Array.isArray(value) ? firstQueryValue(value.find((item) => typeof item === 'string')) : '';
}

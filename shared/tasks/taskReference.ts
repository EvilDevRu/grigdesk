export type TaskSourceId = 'grigdesk' | `${string}@${string}`;

export interface TaskReference {
  id: string;
  source?: TaskSourceId;
}

export type TaskPersonalSource = 'tracker' | 'grigdesk';

export interface TaskSourceOptions {
  source?: TaskPersonalSource;
  taskSource?: TaskSourceId;
}

/**
 * Проверяет серверный идентификатор источника без раскрытия адреса аккаунта.
 * Прежний vendor-маркер не даёт права сопоставлять запуски по номеру.
 */
export function isTaskSourceId(value: unknown): value is TaskSourceId {
  return typeof value === 'string' && (value === 'grigdesk'
    || /^[a-z0-9][a-z0-9._-]*@[a-f0-9]{64}$/.test(value));
}

/**
 * Ссылка сохраняет числовой номер отдельно от подтверждённого источника.
 * Неизвестный префикс никогда не превращается в прежнюю числовую ссылку.
 */
export function parseTaskReference(value: unknown): TaskReference | null {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }

  const raw = String(value).trim();
  const parts = raw.split(':');
  const id = parts.at(-1)!;

  if (!/^[1-9]\d{0,19}$/.test(id) || parts.length > 2
    || (typeof value === 'number' && !Number.isSafeInteger(value))) {
    return null;
  }
  if (parts.length === 1) {
    return { id };
  }
  if (!isTaskSourceId(parts[0]) || (parts[0] === 'grigdesk' && !/^[1-9]\d{11}$/.test(id))) {
    return null;
  }

  return { id, source: parts[0] };
}

/**
 * Формирует значение ссылки без изменения числового номера задачи.
 * Кодирование URL остаётся обязанностью транспорта вызывающей стороны.
 */
export function formatTaskReference(value: TaskReference): string {
  return value.source ? `${value.source}:${value.id}` : String(value.id);
}

/**
 * Сериализует пару источника и номера для кешей и проекций интерфейса.
 * Неизвестный источник остаётся отдельным значением и не совпадает с подтверждённым.
 */
export function taskReferenceKey(value: {
  id: string | number;
  source?: unknown;
  driverId?: unknown;
}): string {
  return JSON.stringify([isTaskSourceId(value.source) ? value.source
    : typeof value.driverId === 'string' ? `driver:${value.driverId}` : null, String(value.id)]);
}

/**
 * Выбирает разрешённое личное пространство по уже подтверждённому источнику.
 * Хеш внешней доски никогда не передаётся серверу как выбираемый scope.
 */
export function taskPersonalSource(source: unknown): TaskPersonalSource {
  return source === 'grigdesk' ? 'grigdesk' : 'tracker';
}

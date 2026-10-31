type TaskFields = Record<string, unknown>;

const PRIORITY_ALIASES: Record<string, number> = {
  низкий: 0,
  низкая: 0,
  low: 0,
  средний: 1,
  средняя: 1,
  обычный: 1,
  обычная: 1,
  normal: 1,
  average: 1,
  высокий: 2,
  высокая: 2,
  важная: 2,
  high: 2,
};
const TASK_UPDATE_FIELDS = new Set(['title', 'description', 'groupId', 'responsibleId', 'priority']);

export class B24ValidationError extends Error {
  readonly code = 'b24_bad_request';

  constructor(message: string) {
    super(message);
    this.name = 'B24ValidationError';
  }
}

/**
 * Приоритет сохраняет прежние числовые значения и словесные aliases HTTP/CLI.
 * Пустота отличается от неверного значения: вызывающий решает, допустимо ли отсутствие поля.
 */
export function normalizePriority(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const alias = PRIORITY_ALIASES[String(value).trim().toLowerCase()];
  const result = alias ?? Number(value);

  if (![0, 1, 2].includes(result)) {
    throw new Error(`Неверный приоритет «${value}»: жду 0 (низкий), 1 (средний) или 2 (высокий)`);
  }

  return result;
}

/**
 * Строковые route ids допустимы, но дроби, ноль и пробелы внутри номера отвергаются.
 * Публичная ошибка не содержит внутренних объектов клиента или транспортного исключения.
 */
function positiveId(value: unknown, label: string): number {
  const text = typeof value === 'string' ? value.trim() : value;
  const id = Number(text);

  if (!Number.isSafeInteger(id) || id <= 0 || (typeof text === 'string' && !/^\d+$/.test(text))) {
    throw new B24ValidationError(`${label}: нужно положительное целое число`);
  }

  return id;
}

/**
 * Редактирование остаётся частичным: отсутствующее поле не отправляется в трекер.
 * Валидация отделена от портального клиента и сохраняет прежний b24_bad_request.
 */
export function normalizeTaskUpdateFields(value: unknown): TaskFields {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new B24ValidationError('Поля задачи должны быть объектом');
  }

  const raw = value as TaskFields;
  const keys = Object.keys(raw);
  const unknown = keys.filter((key) => !TASK_UPDATE_FIELDS.has(key));

  if (unknown.length) {
    throw new B24ValidationError(`Неизвестные поля задачи: ${unknown.join(', ')}`);
  }

  if (!keys.length) {
    throw new B24ValidationError('Не передано ни одного изменения задачи');
  }

  const fields: TaskFields = {};

  if (Object.hasOwn(raw, 'title')) {
    if (typeof raw.title !== 'string' || !raw.title.trim()) {
      throw new B24ValidationError('Заголовок задачи не может быть пустым');
    }

    fields.title = raw.title.trim();
  }

  if (Object.hasOwn(raw, 'description')) {
    if (typeof raw.description !== 'string') {
      throw new B24ValidationError('Описание задачи должно быть строкой');
    }

    fields.description = raw.description;
  }

  if (Object.hasOwn(raw, 'groupId')) {
    fields.groupId = raw.groupId === null || raw.groupId === '' || Number(raw.groupId) === 0
      ? null : positiveId(raw.groupId, 'Проект');
  }

  if (Object.hasOwn(raw, 'responsibleId')) {
    fields.responsibleId = positiveId(raw.responsibleId, 'Исполнитель');
  }

  if (Object.hasOwn(raw, 'priority')) {
    let priority: number | null;

    try {
      priority = normalizePriority(raw.priority);
    } catch (error) {
      throw new B24ValidationError(String((error as { message?: unknown } | null)?.message || error));
    }

    if (priority === null) {
      throw new B24ValidationError('Приоритет задачи не может быть пустым');
    }

    fields.priority = priority;
  }

  return fields;
}

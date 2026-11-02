import { isRecord } from '../../../../shared/lib/objects.ts';
import type { ChecklistItemInput, ChecklistItemUpdate } from './contract.ts';

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
const TASK_UPDATE_FIELDS = new Set([
  'title', 'description', 'groupId', 'responsibleId', 'priority', 'deadline',
  'accomplices', 'auditors',
]);

export class TrackerValidationError extends Error {
  readonly code = 'b24_bad_request';

  constructor(message: string) {
    super(message);
    this.name = 'TrackerValidationError';
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
 * Числовые id сохраняют проверку положительного целого и нормализацию строк с цифрами.
 * Для пользователей допускается непрозрачная строка до 100 символов; проекты остаются числовыми.
 */
function positiveId(value: unknown, label: string, opaque = false): number | string {
  const text = typeof value === 'string' ? value.trim() : value;
  const id = Number(text);

  if (opaque && typeof text === 'string' && text.length > 0 && text.length <= 100
    && !/^\d+$/u.test(text)) {
    return text;
  }

  if ((typeof value !== 'number' && typeof value !== 'string')
    || (opaque && typeof text === 'string' && text.length > 100)
    || !Number.isSafeInteger(id) || id <= 0 || (typeof text === 'string' && !/^\d+$/.test(text))) {
    const expected = opaque ? 'положительное целое число или строка до 100 символов'
      : 'положительное целое число';

    throw new TrackerValidationError(`${label}: нужно ${expected}`);
  }

  return id;
}

/**
 * Редактирование остаётся частичным: отсутствующее поле не отправляется в трекер.
 * Валидация отделена от портального клиента и сохраняет прежний b24_bad_request.
 */
export function normalizeTaskUpdateFields(value: unknown): TaskFields {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TrackerValidationError('Поля задачи должны быть объектом');
  }

  const raw = value as TaskFields;
  const keys = Object.keys(raw);
  const unknown = keys.filter((key) => !TASK_UPDATE_FIELDS.has(key));

  if (unknown.length) {
    throw new TrackerValidationError(`Неизвестные поля задачи: ${unknown.join(', ')}`);
  }

  if (!keys.length) {
    throw new TrackerValidationError('Не передано ни одного изменения задачи');
  }

  const fields: TaskFields = {};

  if (Object.hasOwn(raw, 'title')) {
    if (typeof raw.title !== 'string' || !raw.title.trim()) {
      throw new TrackerValidationError('Заголовок задачи не может быть пустым');
    }

    fields.title = raw.title.trim();
  }

  if (Object.hasOwn(raw, 'description')) {
    if (typeof raw.description !== 'string') {
      throw new TrackerValidationError('Описание задачи должно быть строкой');
    }

    fields.description = raw.description;
  }

  if (Object.hasOwn(raw, 'deadline')) {
    if (raw.deadline !== null && (typeof raw.deadline !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}.*(?:Z|[+-]\d{2}:\d{2})$/u.test(raw.deadline)
      || !Number.isFinite(Date.parse(raw.deadline)))) {
      throw new TrackerValidationError('Срок задачи должен быть ISO-датой или null');
    }

    fields.deadline = raw.deadline;
  }

  if (Object.hasOwn(raw, 'groupId')) {
    fields.groupId = raw.groupId === null || raw.groupId === '' || Number(raw.groupId) === 0
      ? null : positiveId(raw.groupId, 'Проект');
  }

  if (Object.hasOwn(raw, 'responsibleId')) {
    fields.responsibleId = positiveId(raw.responsibleId, 'Исполнитель', true);
  }

  for (const key of ['accomplices', 'auditors']) {
    if (!Object.hasOwn(raw, key)) {
      continue;
    }

    const participants = raw[key];

    if (participants === '' || participants === null) {
      fields[key] = '';
    } else if (Array.isArray(participants)) {
      fields[key] = participants.map((id) => positiveId(id, 'Участник задачи', true));
    } else {
      throw new TrackerValidationError('Участники задачи: нужен массив id, пустая строка или null');
    }
  }

  if (Object.hasOwn(raw, 'priority')) {
    let priority: number | null;

    try {
      priority = normalizePriority(raw.priority);
    } catch (error) {
      throw new TrackerValidationError(String((error as { message?: unknown } | null)?.message || error));
    }

    if (priority === null) {
      throw new TrackerValidationError('Приоритет задачи не может быть пустым');
    }

    fields.priority = priority;
  }

  return fields;
}

/**
 * Идентификатор пункта не очищается от посторонних символов перед вызовом драйвера.
 * Та же проверка применяется к необязательному родителю нового пункта.
 */
export function checklistItemId(value: unknown): string {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;

  if (typeof id !== 'string' || !/^\d+$/u.test(id)) {
    throw new TrackerValidationError('Номер пункта должен состоять из цифр');
  }

  return id;
}

/**
 * Проверяет собственные поля тела мутации, чтобы опечатка не стала молчаливым успехом.
 * Проверка контейнера выполняется до доступа к заголовку или списку тегов.
 */
function mutationBody(value: unknown, allowed: string[]): TaskFields {
  if (!isRecord(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new TrackerValidationError('Некорректные поля изменения задачи');
  }

  return value;
}

/**
 * Заголовок пункта обрезается до проверки пустоты и портального ограничения длины.
 * Некорректное значение не отправляется во внешний драйвер.
 */
function checklistTitle(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 255) {
    throw new TrackerValidationError('Название пункта: нужна непустая строка до 255 символов');
  }

  return value.trim();
}

/**
 * Новый пункт всегда содержит заголовок, а родитель передаётся только явно.
 * Отсутствие parentId означает добавление в корень чек-листа.
 */
export function normalizeChecklistAdd(value: unknown): ChecklistItemInput {
  const raw = mutationBody(value, ['title', 'parentId']);

  return {
    title: checklistTitle(raw.title),
    ...(Object.hasOwn(raw, 'parentId') ? { parentId: checklistItemId(raw.parentId) } : {}),
  };
}

/**
 * Переименование и отметка допускают частичное обновление без пустых команд.
 * complete сохраняет булев тип: строка false не превращается в отметку выполнения.
 */
export function normalizeChecklistUpdate(value: unknown): ChecklistItemUpdate {
  const raw = mutationBody(value, ['title', 'complete']);
  const result: ChecklistItemUpdate = {};

  if (!Object.keys(raw).length) {
    throw new TrackerValidationError('Не передано изменение пункта');
  }

  if (Object.hasOwn(raw, 'title')) {
    result.title = checklistTitle(raw.title);
  }

  if (Object.hasOwn(raw, 'complete')) {
    if (typeof raw.complete !== 'boolean') {
      throw new TrackerValidationError('Отметка пункта должна быть boolean');
    }

    result.complete = raw.complete;
  }

  return result;
}

/**
 * Полная замена тегов допускает пустой список, но не пустые отдельные теги.
 * Ограничения применяются до драйвера; способ очистки REST остаётся внутри пакета.
 */
export function normalizeTaskTags(value: unknown): string[] {
  const raw = mutationBody(value, ['tags']);

  if (!Array.isArray(raw.tags) || raw.tags.length > 50) {
    throw new TrackerValidationError('Теги: нужен массив до 50 строк');
  }

  return raw.tags.map((tag) => {
    if (typeof tag !== 'string' || !tag.trim() || tag.trim().length > 100) {
      throw new TrackerValidationError('Тег: нужна непустая строка до 100 символов');
    }

    return tag.trim();
  });
}

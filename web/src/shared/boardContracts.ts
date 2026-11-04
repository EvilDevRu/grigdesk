import { isTaskSourceId } from '../../../shared/tasks/taskReference.ts';
import type { TaskSourceId } from '../../../shared/tasks/taskReference.ts';
import { isRecord } from '../../../shared/lib/objects.ts';
import { localeTranslator } from '../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from './uiLocalePort.ts';
import type { TrackerCapabilities, TrackerWidget } from '../../../shared/trackers/contracts.ts';
import { isTrackerWidget } from '../../../shared/trackers/validation.ts';

export interface BoardTask extends Record<string, unknown> {
  id: string | number;
  source?: TaskSourceId | 'b24';
  personalSource?: 'tracker' | 'grigdesk';
  createdAt?: string;
  title?: string;
  group?: string;
  responsible?: string;
  statusKind?: string;
  statusLabel?: string;
  timerRunning?: boolean;
  timerElapsed?: number;
  timerStartedAt?: number | string | null;
  overdue?: boolean;
  deadline?: string;
  responsibleId?: string | number;
}

export interface TaskDetail extends Record<string, unknown> {
  source?: 'grigdesk' | 'b24';
  projectId?: string;
  projectTitle?: string;
  id?: string | number;
  title?: string;
  description?: string;
  status?: string | number;
  statusText?: string;
  status_label?: string;
  priority?: number | string;
  priority_label?: string;
  group_id?: number | string;
  group_name?: string;
  deadline?: string | null;
  creator?: {
    name?: string;
    icon?: string;
  };
  responsible?: {
    id?: number | string;
    name?: string;
    icon?: string;
  };
  accomplicesData?: unknown;
  auditorsData?: unknown;
  checklist?: unknown;
  parentId?: number | string;
  replicate?: string;
  telegram?: { links?: TelegramLink[] };
}

interface TelegramLink {
  ok?: boolean;
  url?: string;
  message?: string;
  thread?: number | string;
  more?: number;
  chat?: { title?: string; username?: string };
  quotes?: Array<{
    messageId?: number | string;
    target?: boolean;
    author?: string;
    at?: number;
    text?: string;
    trimmed?: boolean;
    media?: string[];
  }>;
}

export interface BoardNamedItem {
  id: number | string;
  name: string;
}

export interface TaskComment {
  mid?: number | string;
  author?: string;
  time?: string;
  text?: string;
  attachments?: Array<{ attachedId?: number | string; name?: string }>;
}

export interface TaskSubtask {
  id: number | string;
  title: string;
  statusText?: string;
}

export interface TaskLaunchOptions {
  profile: string;
  defaultRoute: string | null;
  profiles?: string[];
  routes?: string[];
  runners?: string[];
  defaultRunner?: string;
  error?: string;
  message?: string;
  catalogHash?: string | null;
  profileContractError?: string | null;
  routeSuggestion?: {
    route?: string;
    reason?: string;
    depth?: string | null;
  } | null;
  scopeSuggestion?: { criteria?: string[]; skip?: string[] };
  instrumentationSuggestions?: string[];
  diagnosisSuggestion?: { kind?: string; signal?: string };
  routeOptions?: Record<string, {
    instrumentationRequired?: boolean;
    deliveryMode?: string | null;
    title?: string;
  }>;
  repositories?: Array<{ name: string; targetBranch?: string }>;
}

export interface TaskLaunchResult {
  outcome?: string;
  profile?: string;
  route?: string;
  attempt?: string;
  note?: string;
}

export interface BoardChart {
  labels?: string[];
  hours?: Array<number | string>;
  hours_dept?: Array<number | string>;
  tasks?: Array<number | string>;
  tasks_dept?: Array<number | string>;
  avg_time?: Array<number | string>;
  avg_time_dept?: Array<number | string>;
}

export interface BoardDashboard extends Record<string, unknown> {
  source?: TaskSourceId;
  trackerId?: string;
  capabilities?: TrackerCapabilities;
  widgets?: TrackerWidget[];
  generation?: number;
  charts?: Record<string, BoardChart>;
  tasks?: BoardTask[];
  toReview?: BoardTask[];
  created?: BoardTask[];
  accomplice?: BoardTask[];
  auditor?: BoardTask[];
  today?: {
    hours?: number;
    tasks_count?: number;
    avg_time?: number;
  };
  month?: {
    completedTasks?: number;
    hours?: number;
    norm?: number;
  };
  dynamics?: {
    hours?: number;
    tasks?: number;
    avg_time?: number;
  };
}

const t = localeTranslator(uiLocalePort);

/**
 * Проверяет отображаемые поля задачи, не проецируя неизвестные расширения портала.
 * Идентификаторы и Unix-старт таймера допускают числовой и строковый формат портала.
 */
function isBoardTask(value: unknown): value is BoardTask {
  if (!isRecord(value) || !['string', 'number'].includes(typeof value.id)) {
    return false;
  }

  const textFields = [
    'title', 'group', 'responsible', 'statusKind', 'statusLabel', 'deadline', 'createdAt',
  ];
  const textValid = textFields.every((key) => value[key] == null || typeof value[key] === 'string');
  const numbersValid = ['timerElapsed'].every((key) => value[key] == null || typeof value[key] === 'number');
  const flagsValid = ['timerRunning', 'overdue']
    .every((key) => value[key] == null || typeof value[key] === 'boolean');
  const timerStartValid = value.timerStartedAt == null || typeof value.timerStartedAt === 'string'
    || (typeof value.timerStartedAt === 'number' && Number.isFinite(value.timerStartedAt));

  return (value.source === undefined || value.source === 'b24' || isTaskSourceId(value.source))
    && textValid && numbersValid && flagsValid && timerStartValid && (value.responsibleId == null
    || typeof value.responsibleId === 'string' || typeof value.responsibleId === 'number');
}

/**
 * Частичный старый дашборд допустим, но переданный список обязан быть списком задач.
 * Отсутствующие блоки не заполняются: внешний снимок сохраняет собственные поля.
 */
export function isBoardDashboard(value: unknown): value is BoardDashboard {
  if (!isRecord(value)) {
    return false;
  }

  if ((value.source !== undefined && !isTaskSourceId(value.source))
    || (value.trackerId !== undefined && typeof value.trackerId !== 'string')
    || (value.capabilities !== undefined && (!isRecord(value.capabilities)
      || !Object.values(value.capabilities).every((item) => typeof item === 'boolean')))
    || (value.widgets !== undefined
      && (!Array.isArray(value.widgets) || !value.widgets.every(isTrackerWidget)))) {
    return false;
  }

  if (value.charts != null && (!isRecord(value.charts)
    || !Object.values(value.charts).every((chart) => isRecord(chart)
      && (chart.labels == null || (Array.isArray(chart.labels)
        && chart.labels.every((label) => typeof label === 'string')))
      && ['hours', 'hours_dept', 'tasks', 'tasks_dept', 'avg_time', 'avg_time_dept'].every((key) => (
        chart[key] == null || (Array.isArray(chart[key])
          && chart[key].every((item) => typeof item === 'number' || typeof item === 'string'))
      ))))) {
    return false;
  }

  for (const key of ['tasks', 'toReview', 'created', 'accomplice', 'auditor']) {
    const tasks = value[key];

    if (tasks != null && (!Array.isArray(tasks) || !tasks.every(isBoardTask))) {
      return false;
    }
  }
  for (const key of ['today', 'month', 'dynamics']) {
    const metrics = value[key];

    const fields = key === 'today' ? ['hours', 'tasks_count', 'avg_time']
      : key === 'month' ? ['hours', 'norm', 'completedTasks'] : ['hours', 'tasks', 'avg_time'];

    if (metrics != null && (!isRecord(metrics)
      || !fields.every((field) => metrics[field] == null || typeof metrics[field] === 'number'))) {
      return false;
    }
  }

  return true;
}

/**
 * Ответ HTTP проверяется до публикации и до установки базовой линии просмотра.
 * Неверный контейнер использует прежнюю ветку ошибки доски.
 */
export function decodeBoardDashboard(value: unknown): BoardDashboard {
  if (!isBoardDashboard(value)) {
    throw new Error(t('core.invalidBoardSnapshot'));
  }

  return value;
}

/**
 * Детали остаются исходным объектом, включая поля плагинов и портала.
 * Повреждённый заголовок и контейнеры не заменяют прежнюю запись кеша.
 */
export function decodeTaskDetail(value: unknown): TaskDetail {
  if (!isRecord(value)
    || (value.id != null && !['string', 'number'].includes(typeof value.id))
    || !['title', 'description', 'status_label', 'priority_label', 'group_name']
      .every((key) => value[key] == null || typeof value[key] === 'string')
    || !['priority', 'group_id'].every((key) => value[key] == null
      || typeof value[key] === 'string' || typeof value[key] === 'number')
    || (value.responsible != null && (!isRecord(value.responsible)
      || (value.responsible.name != null && typeof value.responsible.name !== 'string')
      || (value.responsible.id != null && typeof value.responsible.id !== 'string'
        && typeof value.responsible.id !== 'number')))
    || (value.telegram != null && (!isRecord(value.telegram)
      || (value.telegram.links != null && (!Array.isArray(value.telegram.links)
        || !value.telegram.links.every(isTelegramLink)))))
    || (value.source != null && !['grigdesk', 'b24'].includes(String(value.source)))
    || !['projectId', 'projectTitle'].every((key) => value[key] == null || typeof value[key] === 'string')
    || (value.status != null && !['string', 'number'].includes(typeof value.status))) {
    throw new Error(t('core.invalidTaskDetails'));
  }

  return value;
}

/**
 * Проверяется отображаемая проекция обсуждения без преобразования чужого текста.
 * Неверные вложенные контейнеры не могут попасть в обход цитат шаблона.
 */
function isTelegramLink(value: unknown): value is TelegramLink {
  if (!isRecord(value)
    || !['url', 'message'].every((key) => value[key] == null || typeof value[key] === 'string')
    || (value.ok != null && typeof value.ok !== 'boolean')
    || (value.thread != null && typeof value.thread !== 'number' && typeof value.thread !== 'string')
    || (value.more != null && typeof value.more !== 'number')
    || (value.chat != null && (!isRecord(value.chat)
      || !['title', 'username'].every((key) => isRecord(value.chat)
        && (value.chat[key] == null || typeof value.chat[key] === 'string'))))) {
    return false;
  }

  return value.quotes == null || (Array.isArray(value.quotes) && value.quotes.every((quote) => (
    isRecord(quote)
      && ['author', 'text'].every((key) => quote[key] == null || typeof quote[key] === 'string')
      && ['target', 'trimmed'].every((key) => quote[key] == null || typeof quote[key] === 'boolean')
      && (quote.at == null || typeof quote.at === 'number')
      && (quote.messageId == null || typeof quote.messageId === 'string'
        || typeof quote.messageId === 'number')
      && (quote.media == null || (Array.isArray(quote.media)
        && quote.media.every((item) => typeof item === 'string')))
  )));
}

/**
 * Справочники принимаются только как пары идентификатора и подписи.
 * Повреждённый ответ сохраняет прежний пустой fallback формы.
 */
export function decodeBoardNamedItems(value: unknown, key: string): BoardNamedItem[] {
  const items = isRecord(value) ? value[key] : undefined;

  if (!Array.isArray(items) || !items.every((item): item is BoardNamedItem => (
    isRecord(item) && (typeof item.id === 'string' || typeof item.id === 'number')
      && typeof item.name === 'string'
  ))) {
    return [];
  }

  return items;
}

/**
 * Комментарии проверяются до публикации списка в карточке.
 * Ошибка контейнера использует прежнюю ветку отказа загрузки.
 */
export function decodeTaskComments(value: unknown): TaskComment[] {
  const items = isRecord(value) ? value.comments : undefined;

  if (items == null) {
    return [];
  }

  if (!Array.isArray(items) || !items.every((item): item is TaskComment => (
    isRecord(item)
      && (item.mid == null || typeof item.mid === 'number' || typeof item.mid === 'string')
      && ['author', 'time', 'text'].every((key) => item[key] == null || typeof item[key] === 'string')
      && (item.attachments == null || (Array.isArray(item.attachments)
        && item.attachments.every((attachment) => isRecord(attachment)
          && (attachment.name == null || typeof attachment.name === 'string')
          && (attachment.attachedId == null || typeof attachment.attachedId === 'number'
            || typeof attachment.attachedId === 'string'))))
  ))) {
    throw new Error(t('core.invalidTaskDetails'));
  }

  return items;
}

/**
 * Теги остаются обычными строками драйвера, без интерпретации как ключей перевода.
 * Отсутствующее или повреждённое расширение не мешает читать прежние комментарии.
 */
export function decodeTaskTags(value: unknown): string[] {
  const tags = isRecord(value) ? value.tags : undefined;

  return Array.isArray(tags) && tags.every((tag) => typeof tag === 'string') ? tags : [];
}

/**
 * Подзадачи принимаются только с номером и заголовком для безопасного перехода.
 * Старые драйверы без расширения сохраняют пустой список и прежний контракт ответа.
 */
export function decodeTaskSubtasks(value: unknown): TaskSubtask[] {
  const subtasks = isRecord(value) ? value.subtasks : undefined;

  if (!Array.isArray(subtasks) || !subtasks.every((item): item is TaskSubtask => (
    isRecord(item) && ['string', 'number'].includes(typeof item.id)
      && /^\d+$/u.test(String(item.id)) && Number(item.id) > 0
      && typeof item.title === 'string'
      && (item.statusText == null || typeof item.statusText === 'string')
  ))) {
    return [];
  }

  return subtasks;
}

/**
 * Каталог запуска сохраняет дополнительные поля профиля без проекции.
 * До чтения проверяются строки, списки и используемые вложенные настройки.
 */
function isTaskLaunchOptions(value: unknown): value is TaskLaunchOptions {
  return isRecord(value)
    && typeof value.profile === 'string'
    && (value.defaultRoute === null || typeof value.defaultRoute === 'string')
    && ['error', 'message', 'catalogHash', 'profileContractError', 'defaultRunner']
      .every((key) => value[key] == null || typeof value[key] === 'string')
    && ['profiles', 'routes', 'instrumentationSuggestions'].every((key) => value[key] == null
      || (Array.isArray(value[key]) && value[key].every((item) => typeof item === 'string')))
    && (value.routeSuggestion == null || (isRecord(value.routeSuggestion)
      && ['route', 'reason', 'depth'].every((key) => isRecord(value.routeSuggestion)
        && (value.routeSuggestion[key] == null || typeof value.routeSuggestion[key] === 'string'))))
    && (value.scopeSuggestion == null || (isRecord(value.scopeSuggestion)
      && ['criteria', 'skip'].every((key) => isRecord(value.scopeSuggestion)
        && (value.scopeSuggestion[key] == null || (Array.isArray(value.scopeSuggestion[key])
          && value.scopeSuggestion[key].every((item) => typeof item === 'string'))))))
    && (value.diagnosisSuggestion == null || (isRecord(value.diagnosisSuggestion)
      && ['kind', 'signal'].every((key) => isRecord(value.diagnosisSuggestion)
        && (value.diagnosisSuggestion[key] == null || typeof value.diagnosisSuggestion[key] === 'string'))))
    && (value.routeOptions == null || (isRecord(value.routeOptions)
      && Object.values(value.routeOptions).every((option) => isRecord(option)
        && (option.deliveryMode == null || typeof option.deliveryMode === 'string')
        && (option.title == null || typeof option.title === 'string')
        && (option.instrumentationRequired == null || typeof option.instrumentationRequired === 'boolean'))))
    && (value.repositories == null || (Array.isArray(value.repositories)
      && value.repositories.every((repo) => isRecord(repo) && typeof repo.name === 'string'
        && (repo.targetBranch == null || typeof repo.targetBranch === 'string'))))
    && (value.runners == null || (Array.isArray(value.runners)
      && value.runners.every((runner) => typeof runner === 'string')));

}

/**
 * Проверенный каталог запуска возвращается с исходными расширениями.
 * Повреждённый ответ следует прежней ветке ошибки открытия формы.
 */
export function decodeTaskLaunchOptions(value: unknown): TaskLaunchOptions {
  if (!isTaskLaunchOptions(value)) {
    throw new Error(t('core.invalidTaskDetails'));
  }

  return value;
}

/**
 * Подтверждение запуска проверяется перед построением сообщения человеку.
 * Неверный ACK не вызывает повтор команды запуска.
 */
export function decodeTaskLaunchResult(value: unknown): TaskLaunchResult {
  if (!isRecord(value) || !['outcome', 'profile', 'route', 'attempt', 'note']
    .every((key) => value[key] == null || typeof value[key] === 'string')) {
    throw new Error(t('core.invalidTaskDetails'));
  }

  return value;
}

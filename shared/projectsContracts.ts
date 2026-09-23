// Контракт раздела «Проекты»: паспорт проекта, его репозитории и проверка ввода.
//
// Проект — одно имя для трёх вещей: профиля фабрики, каталога маршрутов и набора
// путей для плагина «Код». Паспорт отвечает на вопрос «где лежат репозитории» и
// правится человеком; источник путей виден в ответе, и править можно не всякий.
//
// Модуль общий с браузером: ни `node:path`, ни файловой системы здесь нет.
// Абсолютность пути проверяется по начальному слэшу — сервер host-native Linux.

import { contractDecoders } from './contractDecoders.ts';

// Границы полей паспорта: те же числа проверяет и форма, и сервер.
export const PROJECT_LIMITS = {
  title: 120,
  description: 2000,
  tags: 20,
  tag: 32,
  repos: 32,
  dir: 1024,
};

// Новый идентификатор проекта начинается с буквы — так требует движок фабрики.
// Существующие профили шире, поэтому проверка идентификатора профиля остаётся
// отдельной (PROFILE_RE на сервере).
export const PROJECT_ID_RE = /^[a-z][a-z0-9_-]{0,40}$/;
// Ключ репозитория — метка внутри проекта: короткая, строчная, без пробелов.
export const REPO_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,15}$/;

export class ProjectsContractError extends Error {
  constructor(path: string) {
    super(`Некорректный ответ раздела проектов: поле ${path}`);
    this.name = 'ProjectsContractError';
  }
}

const {
  boolean,
  listOf,
  nullable,
  objectOf,
  oneOf,
  optional,
  record,
  text,
  wholeNumber,
} = contractDecoders((path) => {
  throw new ProjectsContractError(path);
});

// Метка и путь — то, что приходит на сервер и уходит с него без служебных полей.
const repoRef = objectOf({ key: text, dir: text });

// Источник путей закрыт перечислением: по нему раздел решает, можно ли править
// репозитории. Незнакомое значение здесь опаснее отказа.
const pathsSource = oneOf('passport', 'profile');

const importStatus = oneOf('none', 'pending', 'imported', 'conflict', 'failed', 'manual');

const projectImport = objectOf({
  status: importStatus,
  fingerprint: nullable(text),
  at: nullable(text),
  error: nullable(text),
  // Кандидаты есть только у конфликта импорта: у остальных статусов это null.
  candidates: nullable(objectOf({ prefs: listOf(repoRef), profile: listOf(repoRef) })),
});

// Общие поля сводки и подробного паспорта описаны один раз: разойтись им нельзя.
const summaryFields = {
  id: text,
  title: text,
  tags: listOf(text),
  repos: listOf(objectOf({ key: text, dir: text, exists: boolean })),
  defaultRepoKey: nullable(text),
  archivedAt: nullable(text),
  revision: wholeNumber,
  updatedAt: nullable(text),
  profile: objectOf({ present: boolean, pathsSource }),
  importStatus,
  routes: listOf(text),
  warnings: listOf(text),
};

const projectSummary = objectOf(summaryFields);

const projectDetail = objectOf({
  ...summaryFields,
  description: text,
  createdAt: nullable(text),
  import: projectImport,
  profile: objectOf({
    present: boolean,
    pathsSource,
    // null — профиль ещё не читали: «не проверялось» и «не читается» — разные вещи.
    readable: nullable(boolean),
    repos: listOf(repoRef),
    capabilities: listOf(text),
    // Ключи паспорта, которым профиль не назначил источник путей.
    mismatch: listOf(repoRef),
  }),
});

const fieldError = objectOf({ path: text, message: text });

// Подробности ошибки необязательны: у отказа без формы их нет вовсе.
const projectsErrorBody = objectOf({
  error: text,
  message: text,
  fieldErrors: optional(listOf(fieldError)),
  currentRevision: optional(wholeNumber),
});

export const REPOSITORY_STATES = [
  'git',
  'worktree',
  'dir',
  'missing',
  'file',
  'denied',
  'timeout',
] as const;

const repositoryCheckBody = objectOf({
  results: listOf(objectOf({
    dir: text,
    state: oneOf(...REPOSITORY_STATES),
    message: text,
  })),
});

// Связь проекта с другими разделами: сколько записей и как их показать человеку.
// Список связей нужен и до архива, и до удаления: он объясняет, что именно мешает.
const projectDependency = objectOf({
  kind: text,
  label: text,
  count: wholeNumber,
  items: listOf(text),
});

const projectDependencies = objectOf({
  items: listOf(projectDependency),
  archivable: boolean,
  deletable: boolean,
  reasons: listOf(text),
});

export type ProjectDependency = ReturnType<typeof projectDependency>;
export type ProjectDependencies = ReturnType<typeof projectDependencies>;

export type ProjectRepo = ReturnType<typeof repoRef>;
export type ProjectSummary = ReturnType<typeof projectSummary>;
export type ProjectDetail = ReturnType<typeof projectDetail>;
export type ProjectRepositoryCheck = ReturnType<typeof repositoryCheckBody>;
export type ProjectRepositoryState = (typeof REPOSITORY_STATES)[number];

// Что уходит НА сервер: только метка и путь. `exists` считает сервер сам,
// и присланный клиентом он означал бы попытку назначить себе состояние диска.
export interface ProjectRepoInput {
  key: string;
  dir: string;
}

export interface ProjectInput {
  id?: string;
  title: string;
  description: string;
  tags: string[];
  repos: ProjectRepoInput[];
  defaultRepoKey: string | null;
  expectedRevision?: number;
}

// Код отказа нужен серверу: по нему он выбирает HTTP-код ответа. Наружу уходит
// только пара «путь и текст» — форму ошибки задаёт §1.2.
export type ProjectInputErrorCode =
  | 'bad_request'
  | 'bad_id'
  | 'unknown_field'
  | 'bad_key'
  | 'bad_dir'
  | 'dup_key'
  | 'bad_default_repo';

export interface ProjectFieldError {
  path: string;
  message: string;
  code?: ProjectInputErrorCode;
}

export type ProjectInputValidation =
  | { ok: true; value: ProjectInput }
  | { ok: false; fieldErrors: ProjectFieldError[] };

export interface ProjectsErrorBody {
  error: string;
  message: string;
  fieldErrors: Array<{ path: string; message: string }>;
  currentRevision: number | null;
}

export function parseProjectSummaries(value: unknown): ProjectSummary[] {
  const source = record(value, 'projects');
  const list = source.projects;

  if (!Array.isArray(list)) {
    throw new ProjectsContractError('projects');
  }

  // Путь поля внутри списка пишется через точку: так его называет форма отказа.
  return list.map((item, index) => projectSummary(item, `projects.${index}`));
}

export function parseProjectDetail(value: unknown): ProjectDetail {
  return projectDetail(value, 'project');
}

/**
 * Разбор тела ошибки: `fieldErrors` и `currentRevision` приходят не всегда, и
 * отсутствие каждого из них — не повод ронять показ отказа. Читаются они в
 * предсказуемой форме: пустой список и «ревизии нет», а не `null` вместо списка.
 */
export function parseProjectsError(value: unknown): ProjectsErrorBody {
  const parsed = projectsErrorBody(value, 'error');

  return {
    error: parsed.error,
    message: parsed.message,
    fieldErrors: parsed.fieldErrors ?? [],
    currentRevision: parsed.currentRevision ?? null,
  };
}

export function parseProjectDependencies(value: unknown): ProjectDependencies {
  return projectDependencies(value, 'dependencies');
}

export function parseRepositoryCheck(value: unknown): ProjectRepositoryCheck {
  return repositoryCheckBody(value, 'check');
}

// Поля тела паспорта. Всё остальное в теле — опечатка или чужое поле.
const KNOWN_INPUT_FIELDS = new Set([
  'id',
  'title',
  'description',
  'tags',
  'repos',
  'defaultRepoKey',
  'expectedRevision',
]);

/**
 * Проверка тела запроса на создание и изменение паспорта. Возвращает либо
 * нормализованное значение для записи, либо список отказов по путям формы.
 *
 * Ревизию здесь не проверяем: «не прислали» и «прислали не число» различает
 * сервис, и только он знает текущую ревизию для ответа 409.
 */
export function validateProjectInput(
  value: unknown,
  { creating }: { creating: boolean },
): ProjectInputValidation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {
      ok: false,
      fieldErrors: [{ path: 'body', message: 'Ожидался объект паспорта', code: 'bad_request' }],
    };
  }

  const source = value as Record<string, unknown>;
  const fieldErrors: ProjectFieldError[] = [];
  const fail = (path: string, message: string, code: ProjectInputErrorCode) => {
    fieldErrors.push({ path, message, code });
  };

  // Незнакомое поле — отказ, а не тихое отбрасывание: иначе опечатка в имени
  // поля сохранялась бы как «человек ничего не менял».
  for (const key of Object.keys(source)) {
    if (!KNOWN_INPUT_FIELDS.has(key)) {
      fail(key, 'Неизвестное поле', 'unknown_field');
    }
  }

  if (Object.hasOwn(source, 'id') && !creating) {
    fail('id', 'Идентификатор проекта не меняется', 'bad_id');
  }
  if (Object.hasOwn(source, 'expectedRevision') && creating) {
    fail('expectedRevision', 'Ревизия нужна только при изменении', 'bad_request');
  }

  const id = trimmedText(source.id);
  if (creating && !PROJECT_ID_RE.test(id)) {
    fail(
      'id',
      'Идентификатор: строчная латинская буква, дальше буквы, цифры, «-» или «_»',
      'bad_id',
    );
  }

  const title = trimmedText(source.title);
  if (!title || title.length > PROJECT_LIMITS.title) {
    fail('title', `Название: от 1 до ${PROJECT_LIMITS.title} символов`, 'bad_request');
  }

  const description = trimmedText(source.description);
  if (typeof source.description !== 'string' || description.length > PROJECT_LIMITS.description) {
    fail(
      'description',
      `Описание: не длиннее ${PROJECT_LIMITS.description} символов`,
      'bad_request',
    );
  }

  const tags = tagsOf(source.tags, fail);

  // Список репозиториев обязателен даже пустым: «не прислали» и «стёрли все
  // пути» — разные намерения, и второе не должно выглядеть как первое.
  const repos = reposOf(source.repos, fail);
  const defaultRepoKey = defaultRepoOf(source.defaultRepoKey, fail);

  // Пока список репозиториев не собрался, проверять выбор по умолчанию не по чему.
  if (repos && defaultRepoKey !== null && !repos.keys.has(defaultRepoKey)) {
    fail('defaultRepoKey', 'Репозиторий по умолчанию не из списка', 'bad_default_repo');
  }

  if (fieldErrors.length) {
    return { ok: false, fieldErrors };
  }

  const result: ProjectInput = {
    title,
    description,
    tags,
    repos: repos ? repos.items : [],
    defaultRepoKey,
  };

  if (creating) {
    result.id = id;
  }
  if (!creating && Object.hasOwn(source, 'expectedRevision')) {
    result.expectedRevision = source.expectedRevision as number;
  }

  return { ok: true, value: result };
}

function trimmedText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function tagsOf(
  value: unknown,
  fail: (path: string, message: string, code: ProjectInputErrorCode) => void,
): string[] {
  if (!Array.isArray(value)) {
    fail('tags', 'Метки — список строк', 'bad_request');

    return [];
  }

  const tags = value.map(trimmedText);
  if (tags.length > PROJECT_LIMITS.tags) {
    fail('tags', `Меток не больше ${PROJECT_LIMITS.tags}`, 'bad_request');

    return [];
  }
  if (tags.some((tag) => !tag || tag.length > PROJECT_LIMITS.tag)) {
    fail('tags', `Метка: от 1 до ${PROJECT_LIMITS.tag} символов`, 'bad_request');

    return [];
  }

  return tags;
}

/**
 * Разбор строк репозиториев. Возвращает собранный список и набор ключей —
 * по нему проверяется выбор по умолчанию. Любая ошибка строки обнуляет
 * результат: проверять выбор по умолчанию по неполному списку нельзя.
 */
function reposOf(
  value: unknown,
  fail: (path: string, message: string, code: ProjectInputErrorCode) => void,
): { items: ProjectRepoInput[]; keys: Set<string> } | null {
  if (!Array.isArray(value)) {
    fail('repos', 'Список репозиториев обязателен', 'bad_request');

    return null;
  }
  if (value.length > PROJECT_LIMITS.repos) {
    fail('repos', `Репозиториев не больше ${PROJECT_LIMITS.repos}`, 'bad_request');

    return null;
  }

  const items: ProjectRepoInput[] = [];
  const keys = new Set<string>();
  let ok = true;

  value.forEach((row, index) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      fail(`repos.${index}`, 'Строка репозитория — объект с ключом и путём', 'bad_request');
      ok = false;

      return;
    }

    const source = row as { key?: unknown; dir?: unknown };
    const key = trimmedText(source.key);
    const dir = trimmedText(source.dir);
    let rowOk = true;

    if (!REPO_KEY_RE.test(key)) {
      fail(
        `repos.${index}.key`,
        'Ключ: строчная латинская буква или цифра, дальше буквы, цифры, «-» или «_»',
        'bad_key',
      );
      rowOk = false;
    } else if (keys.has(key)) {
      fail(`repos.${index}.key`, 'Ключ уже занят другой строкой', 'dup_key');
      rowOk = false;
    }

    if (!dir.startsWith('/') || dir.length > PROJECT_LIMITS.dir || dir.includes('\u0000')) {
      fail(
        `repos.${index}.dir`,
        `Путь: абсолютный, без управляющих знаков, не длиннее ${PROJECT_LIMITS.dir} символов`,
        'bad_dir',
      );
      rowOk = false;
    }

    if (!rowOk) {
      ok = false;

      return;
    }

    keys.add(key);
    items.push({ key, dir });
  });

  return ok ? { items, keys } : null;
}

function defaultRepoOf(
  value: unknown,
  fail: (path: string, message: string, code: ProjectInputErrorCode) => void,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    fail('defaultRepoKey', 'Репозиторий по умолчанию — ключ или пусто', 'bad_default_repo');

    return null;
  }

  return value.trim() || null;
}

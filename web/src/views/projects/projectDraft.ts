// Черновик паспорта проекта: копия серверного снимка, которую правит форма.
//
// Все функции чистые: получают черновик и возвращают новый. Поэтому правку строк —
// переименование ключа, перенос выбора по умолчанию, порядок — можно проверить без
// компонента, а форма не держит вторую копию правил.

import type { ProjectDetail, ProjectInput } from '../../../../shared/projectsContracts';

export interface ProjectRepoDraft {
  key: string;
  dir: string;
}

export interface ProjectDraft {
  id: string;
  title: string;
  description: string;
  tags: string[];
  repos: ProjectRepoDraft[];
  defaultRepoKey: string | null;
  // Выбор по умолчанию потерян вместе с удалённой строкой: пока человек не выберет
  // заново, сохранять проект нельзя — иначе «репозиторий по умолчанию» исчезнет молча.
  defaultRepoRequired: boolean;
}

// Поля, которые уходят на сервер и сравниваются при правке. Порядок здесь — порядок
// показа в списке изменённых полей: заголовок, описание, метки, репозитории, выбор.
export const DRAFT_FIELDS = ['title', 'description', 'tags', 'repos', 'defaultRepoKey'] as const;

export type ProjectDraftField = (typeof DRAFT_FIELDS)[number];

/**
 * Черновик открытого паспорта: копия полей, которые правит форма.
 * Для нового проекта — пустой (`createDraft(null)`): идентификатор впишет человек.
 */
export function createDraft(detail: ProjectDetail | null): ProjectDraft {
  if (!detail) {
    return {
      id: '',
      title: '',
      description: '',
      tags: [],
      repos: [],
      defaultRepoKey: null,
      defaultRepoRequired: false,
    };
  }

  return {
    id: detail.id,
    title: detail.title,
    description: detail.description,
    tags: [...detail.tags],
    repos: detail.repos.map((repo) => ({ key: repo.key, dir: repo.dir })),
    defaultRepoKey: detail.defaultRepoKey,
    defaultRepoRequired: false,
  };
}

function sameList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function sameRepos(left: ProjectRepoDraft[], right: ProjectRepoDraft[]): boolean {
  return left.length === right.length
    && left.every((repo, index) => {
      const other = right[index];

      return Boolean(other) && repo.key === other?.key && repo.dir === other?.dir;
    });
}

/**
 * Сравнение одного поля паспорта: списки меток и строки репозиториев — по содержимому,
 * а не по ссылке, иначе форма считала бы правкой любую пересборку массива.
 */
function sameField(field: ProjectDraftField, left: ProjectDraft, right: ProjectDraft): boolean {
  if (field === 'tags') {
    return sameList(left.tags, right.tags);
  }
  if (field === 'repos') {
    return sameRepos(left.repos, right.repos);
  }

  return left[field] === right[field];
}

/**
 * Что именно человек изменил относительно снимка. Список нужен и кнопке «Сохранить»,
 * и диалогу конфликта: он показывает, чьи правки разошлись, не пересказывая весь паспорт.
 */
export function changedFields(left: ProjectDraft, right: ProjectDraft): ProjectDraftField[] {
  return DRAFT_FIELDS.filter((field) => !sameField(field, left, right));
}

/**
 * Есть ли правки относительно снимка: по этому ответу живёт кнопка «Сохранить»
 * и вопрос при уходе со страницы.
 */
export function isDirty(draft: ProjectDraft, snapshot: ProjectDraft): boolean {
  return changedFields(draft, snapshot).length > 0;
}

/**
 * Переименование ключа строки: выбранный по умолчанию едет вместе с ней,
 * иначе выбор указывал бы на ключ, которого больше нет.
 */
export function renameRepoKey(draft: ProjectDraft, index: number, key: string): ProjectDraft {
  const row = draft.repos[index];

  if (!row) {
    return draft;
  }

  const repos = draft.repos.map((repo, position) => (
    position === index ? { ...repo, key } : repo
  ));

  return {
    ...draft,
    repos,
    defaultRepoKey: row.key === draft.defaultRepoKey ? key : draft.defaultRepoKey,
  };
}

/**
 * Удаление строки. Ушедший выбранный репозиторий оставляет выбор пустым и помечает,
 * что его нужно сделать заново; если строк не осталось, выбирать не из чего.
 */
export function removeRepo(draft: ProjectDraft, index: number): ProjectDraft {
  const row = draft.repos[index];

  if (!row) {
    return draft;
  }

  const repos = draft.repos.filter((unused, position) => position !== index);

  if (row.key !== draft.defaultRepoKey) {
    return { ...draft, repos };
  }

  return {
    ...draft,
    repos,
    defaultRepoKey: null,
    defaultRepoRequired: repos.length > 0,
  };
}

/**
 * Сдвиг строки на `delta`. За границами списка порядок не меняется: кнопки
 * «Выше» и «Ниже» на краю списка не должны ничего ломать.
 */
export function moveRepo(draft: ProjectDraft, index: number, delta: number): ProjectDraft {
  const target = index + delta;

  if (!draft.repos[index] || !draft.repos[target]) {
    return draft;
  }

  const repos = [...draft.repos];
  const row = repos[index];

  if (!row) {
    return draft;
  }

  repos.splice(index, 1);
  repos.splice(target, 0, row);

  return { ...draft, repos };
}

/**
 * Тело запроса из черновика. `repos: []` уходит явно: пустой список — это «путей нет»,
 * а не «не прислали», и сервер различает эти намерения. Служебные поля (`id`,
 * `defaultRepoRequired`, ревизия) сюда не попадают: их место знает слой операций.
 */
export function toInput(draft: ProjectDraft): ProjectInput {
  return {
    title: draft.title,
    description: draft.description,
    tags: [...draft.tags],
    repos: draft.repos.map((repo) => ({ key: repo.key, dir: repo.dir })),
    defaultRepoKey: draft.defaultRepoKey,
  };
}

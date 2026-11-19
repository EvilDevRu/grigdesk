// Черновик паспорта проекта: копия серверного снимка, которую правит форма.
//
// Все функции чистые: получают черновик и возвращают новый. Поэтому правку строк —
// переименование ключа, перенос выбора по умолчанию, порядок — можно проверить без
// компонента, а форма не держит вторую копию правил.

import { PROJECT_LIMITS } from '../../../../shared/runtime/projectsContracts';
import type { ProjectDetail, ProjectInput } from '../../../../shared/runtime/projectsContracts';

export interface ProjectRepoDraft {
  key: string;
  dir: string;
  automaticKey?: boolean;
}

export interface ProjectDraft {
  id: string;
  title: string;
  description: string;
  icon?: string | null;
  tags: string[];
  repos: ProjectRepoDraft[];
  defaultRepoKey: string | null;
  // Выбор по умолчанию потерян вместе с удалённой строкой: пока человек не выберет
  // заново, сохранять проект нельзя — иначе «репозиторий по умолчанию» исчезнет молча.
  defaultRepoRequired: boolean;
}

// Поля, которые уходят на сервер и сравниваются при правке. Порядок здесь — порядок
// показа в списке изменённых полей: заголовок, описание, иконка, метки, репозитории, выбор.
export const DRAFT_FIELDS = ['title', 'description', 'icon', 'tags', 'repos', 'defaultRepoKey'] as const;

export type ProjectDraftField = (typeof DRAFT_FIELDS)[number];

const CYRILLIC_TO_LATIN: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'yo',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'kh',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'shch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
  є: 'ye',
  і: 'i',
  ї: 'yi',
  ґ: 'g',
  ў: 'u',
};

function slugFromTitle(title: string): string {
  return title.normalize('NFC').toLowerCase()
    .replace(/[а-яёєіїґў]/gu, (letter) => CYRILLIC_TO_LATIN[letter] ?? letter)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

/**
 * Превращает заголовок в ключ, совместимый с фабрикой и паспортом.
 * Числовые названия получают префикс, а для названий без латинского представления есть запасной ключ.
 */
export function projectIdFromTitle(title: string): string {
  if (!title.trim()) {
    return '';
  }

  const slug = slugFromTitle(title);
  const id = /^[a-z]/u.test(slug) ? slug : ['project', slug].filter(Boolean).join('-');

  return id.slice(0, PROJECT_LIMITS.id).replace(/-+$/u, '');
}

/**
 * Предлагает свободную метку по имени папки. У длинных имён сначала сохраняет
 * целые слова с конца, где обычно находится отличие от соседней рабочей копии.
 */
function suggestedRepoKey(repos: ProjectRepoDraft[], index: number, dir: string): string {
  if (!dir.trim()) {
    return '';
  }

  const name = dir.trim().replace(/\/+$/u, '').split('/').at(-1) ?? '';
  const slug = slugFromTitle(name) || 'repo';
  const limit = PROJECT_LIMITS.repoKey;
  const tail = slug.slice(-(limit + 1)).match(/-(.+)$/u)?.[1];
  const base = slug.length <= limit ? slug : tail || slug.slice(0, limit).replace(/-+$/u, '');
  const occupied = new Set(repos.filter((_, position) => position !== index).map(({ key }) => key.trim()));
  let key = base;

  for (let number = 2; occupied.has(key); number += 1) {
    const suffix = `-${number}`;

    key = base.slice(0, limit - suffix.length).replace(/-+$/u, '') + suffix;
  }

  return key;
}

/**
 * Черновик открытого паспорта: копия полей, которые правит форма.
 * Для нового проекта черновик пустой, идентификатор вычисляется из названия.
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
    ...(Object.hasOwn(detail, 'icon') ? { icon: detail.icon } : {}),
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
  if (field === 'icon') {
    return (left.icon ?? null) === (right.icon ?? null);
  }
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

  const automaticKey = !key.trim();
  const nextKey = automaticKey ? suggestedRepoKey(draft.repos, index, row.dir) || row.key : key;
  const next: ProjectRepoDraft = {
    key: nextKey,
    dir: row.dir,
    ...(automaticKey ? { automaticKey } : {}),
  };

  return replaceRepo(draft, index, next);
}

/**
 * Новый путь обновляет метку только в автоматическом режиме.
 * У сохранённых и вручную изменённых строк метка остаётся стабильной.
 */
export function setRepoDir(draft: ProjectDraft, index: number, dir: string): ProjectDraft {
  const row = draft.repos[index];

  if (!row) {
    return draft;
  }

  const key = row.automaticKey ? suggestedRepoKey(draft.repos, index, dir) || row.key : row.key;

  return replaceRepo(draft, index, {
    ...row,
    dir,
    key,
  });
}

/**
 * Меняет одну строку и переносит выбор по умолчанию на её новый ключ.
 * Автоподстановка и ручное переименование меняют ссылку по одному правилу.
 */
function replaceRepo(draft: ProjectDraft, index: number, next: ProjectRepoDraft): ProjectDraft {
  const repos = [...draft.repos];

  repos[index] = next;

  return {
    ...draft,
    repos,
    defaultRepoKey: draft.repos[index]?.key === draft.defaultRepoKey ? next.key : draft.defaultRepoKey,
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
    ...(Object.hasOwn(draft, 'icon') ? { icon: draft.icon } : {}),
    tags: [...draft.tags],
    repos: draft.repos.map((repo) => ({ key: repo.key, dir: repo.dir })),
    defaultRepoKey: draft.defaultRepoKey,
  };
}

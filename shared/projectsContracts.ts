// Контракт раздела «Проекты»: реестр проектов и пути их репозиториев на диске.
//
// Проект — одно имя для трёх вещей: профиля фабрики, каталога маршрутов и набора
// путей для плагина «Код». Откуда взяты пути, видно в самом ответе: `from` отличает
// профиль фабрики от настроек кокпита, и правится только второе.

import { contractDecoders } from './contractDecoders.ts';

export class ProjectsContractError extends Error {
  constructor(path: string) {
    super(`Некорректный ответ раздела проектов: поле ${path}`);
    this.name = 'ProjectsContractError';
  }
}

const {
  boolean,
  listOf,
  objectOf,
  oneOf,
  text,
} = contractDecoders((path) => {
  throw new ProjectsContractError(path);
});

// Источник пути закрыт перечислением: от него зависит, можно ли править запись.
// Незнакомое значение здесь опаснее отказа — оно открыло бы правку профиля фабрики.
const repoSource = oneOf('factory', 'cockpit');

const projectRepo = objectOf({
  key: text,
  dir: text,
  from: repoSource,
  // Каталога может не быть на диске: проект переехал, а запись осталась.
  exists: boolean,
});

const project = objectOf({
  id: text,
  factory: boolean,
  repos: listOf(projectRepo),
  routes: listOf(text),
});

const projectList = objectOf({ projects: listOf(project) });

export type ProjectRepoSource = ReturnType<typeof repoSource>;
export type ProjectRepo = ReturnType<typeof projectRepo>;
export type Project = ReturnType<typeof project>;

// Что уходит НА сервер: только метка и путь. `from` и `exists` считает сервер сам,
// и присланные клиентом они означали бы попытку назначить себе источник.
export interface ProjectRepoInput {
  key: string;
  dir: string;
}

export function parseProjectList(value: unknown): Project[] {
  return projectList(value, 'projects').projects;
}

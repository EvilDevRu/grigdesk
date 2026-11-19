// Проекты (профили): у каждого — свой конвейер; агенты — общая библиотека.
// Список — объединение корневых profiles/<name>/graph.json и проектов, заведённых
// в самом GrigDesk. Вторые живут реестром в prefs (там же их пути репозиториев для
// плагина «Код»): каталог-маркер под них держал legacy-стор маршрутов, а он выпилен
// вместе с v1 — проект без профиля фабрики не должен зависеть от мёртвой базы.
// Хардкода имён нет.
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { recordOrEmpty } from '../../../shared/lib/objects.ts';
import type { ProjectListScope } from '../../../shared/runtime/projectsContracts.ts';
import { deletedProjectIds } from './projects/deletion.ts';
import { archivedProjectIds } from './projects/archive.ts';

export const PROFILE_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;

export const projectScopeOptions = {
  schema: {
    querystring: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['active', 'archived', 'all'] satisfies ProjectListScope[] },
      },
    },
  },
};

export type ProjectScopeRoute = { Querystring: { scope?: ProjectListScope } };

/**
 * Готовность профиля к чему-либо он заявляет САМ — списком `capabilities` в graph.json
 * (тот же ключ читает движок: `profile_has_capability` в bin/factory). GrigDesk не
 * догадывается по косвенным признакам: поддержку route protocol решает профиль.
 */
export async function profileHasCapability(
  profilesDir: string,
  profile: string,
  capability: string,
): Promise<boolean> {
  if (!PROFILE_RE.test(String(profile || '')) || !/^[a-z][a-z0-9_-]*$/.test(capability)) {
    return false;
  }
  try {
    const graph = JSON.parse(await fs.readFile(path.join(profilesDir, profile, 'graph.json'), 'utf8'));
    return Array.isArray(graph.capabilities) && graph.capabilities.includes(capability);
  } catch {
    return false;
  }
}

/**
 * Профили фабрики определяются по наличию схемы и используются для автопосева.
 * При фиксации корней ошибки доступа запрещают выдавать неполный каталог.
 */
export async function listFactoryProfiles(
  profilesDir: string,
  { strict = false }: { strict?: boolean } = {},
): Promise<string[]> {
  try {
    const entries = await fs.readdir(profilesDir, { withFileTypes: true });
    const candidates = entries
      .filter((entry) => entry.isDirectory() && PROFILE_RE.test(entry.name))
      .map((entry) => entry.name);
    const present = await Promise.all(candidates.map(async (name) => (
      fs.access(path.join(profilesDir, name, 'graph.json'))
        .then(() => name)
        .catch((error: NodeJS.ErrnoException) => {
          if (strict && error.code !== 'ENOENT') {
            throw error;
          }

          return null;
        })
    )));
    return present.filter((name): name is string => Boolean(name));
  } catch (error) {
    if (strict && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }

    return [];
  }
}

// Ровно то, что нужно от ещё нетипизированного стора настроек: реестр проектов.
export interface ProjectsPrefsPort {
  read?: () => unknown;
}

/**
 * Каталог объединяет проекты фабрики и GrigDesk, удалённые регистрации исключаются.
 * Обычные списки активны, архив подключается явной областью запроса.
 */
export async function listProjects(
  { profilesDir }: { profilesDir: string },
  prefs: ProjectsPrefsPort | null = null,
  scope: ProjectListScope = 'active',
): Promise<string[]> {
  const factory = await listFactoryProfiles(profilesDir);
  let stored: unknown;

  try {
    stored = prefs?.read?.();
  } catch {
    stored = null;
  }

  const registered = Object.keys(recordOrEmpty(recordOrEmpty(stored).projects));
  const all = new Set([...factory, ...registered.filter((id) => PROFILE_RE.test(id))]);
  const snapshot = { read: () => stored };
  const deleted = deletedProjectIds(snapshot);

  for (const id of deleted) {
    all.delete(id);
  }

  if (scope === 'all') {
    return [...all].sort();
  }

  const archived = archivedProjectIds(snapshot);

  return [...all].filter((id) => archived.has(id) === (scope === 'archived')).sort();
}

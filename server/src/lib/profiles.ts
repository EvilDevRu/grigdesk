// Проекты (профили): у каждого — свой конвейер; агенты — общая библиотека.
// Список — объединение корневых profiles/<name>/graph.json и проектов, заведённых
// в самом кокпите. Вторые живут реестром в prefs (там же их пути репозиториев для
// плагина «Код»): каталог-маркер под них держал legacy-стор маршрутов, а он выпилен
// вместе с v1 — проект без профиля фабрики не должен зависеть от мёртвой базы.
// Хардкода имён нет.
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { archivedProjectIds } from './projects/archive.ts';

export const PROFILE_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;

/**
 * Готовность профиля к чему-либо он заявляет САМ — списком `capabilities` в graph.json
 * (тот же ключ читает движок: `profile_has_capability` в bin/factory). Кокпит не
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

/** Профили фабрики (по наличию схемы) — используются для автопосева. */
export async function listFactoryProfiles(profilesDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(profilesDir, { withFileTypes: true });
    const candidates = entries
      .filter((entry) => entry.isDirectory() && PROFILE_RE.test(entry.name))
      .map((entry) => entry.name);
    const present = await Promise.all(candidates.map(async (name) => (
      fs.access(path.join(profilesDir, name, 'graph.json'))
        .then(() => name)
        .catch(() => null)
    )));
    return present.filter((name): name is string => Boolean(name));
  } catch { return []; }
}

// Ровно то, что нужно от ещё нетипизированного стора настроек: реестр проектов.
export interface ProjectsPrefsPort {
  read?: () => { projects?: Record<string, unknown> } | null | undefined;
}

/** Проекты, заведённые в кокпите: ключи реестра prefs.projects. */
function listCockpitProjects(prefs: ProjectsPrefsPort | null): string[] {
  try {
    return Object.keys(prefs?.read?.()?.projects || {}).filter((name) => PROFILE_RE.test(name));
  } catch { return []; }
}

/**
 * Все проекты: фабрика + заведённые в кокпите (объединение, отсортировано).
 * По умолчанию список полный — архив ничего не рвёт, и уже созданное продолжает
 * открываться. `includeArchived: false` просят там, где начинают НОВОЕ: форма
 * запуска, подъём песочницы, выбор проекта в новом правиле.
 */
export async function listProjects(
  { profilesDir }: { profilesDir: string },
  prefs: ProjectsPrefsPort | null = null,
  { includeArchived = true }: { includeArchived?: boolean } = {},
): Promise<string[]> {
  const all = new Set([
    ...(await listFactoryProfiles(profilesDir)),
    ...listCockpitProjects(prefs),
  ]);

  if (includeArchived) {
    return [...all].sort();
  }

  const archived = archivedProjectIds(prefs);

  return [...all].filter((id) => !archived.has(id)).sort();
}

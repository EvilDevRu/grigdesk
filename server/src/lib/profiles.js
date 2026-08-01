// Проекты (профили): у каждого — свой конвейер; агенты — общая библиотека.
// Список — объединение корневых profiles/<name>/graph.json и проектов, заведённых
// в самом кокпите. Вторые живут реестром в prefs (там же их пути репозиториев для
// плагина «Код»): каталог-маркер под них держал legacy-стор маршрутов, а он выпилен
// вместе с v1 — проект без профиля фабрики не должен зависеть от мёртвой базы.
// Хардкода имён нет.
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const PROFILE_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;

/** Профили фабрики (по наличию схемы) — используются для автопосева. */
export async function listFactoryProfiles(profilesDir) {
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
    return present.filter(Boolean);
  } catch { return []; }
}

/** Проекты, заведённые в кокпите: ключи реестра prefs.projects. */
function listCockpitProjects(prefs) {
  try {
    return Object.keys(prefs?.read?.()?.projects || {}).filter((name) => PROFILE_RE.test(name));
  } catch { return []; }
}

/** Все проекты: фабрика + заведённые в кокпите (объединение, отсортировано). */
export async function listProjects({ profilesDir }, prefs = null) {
  const all = new Set([
    ...(await listFactoryProfiles(profilesDir)),
    ...listCockpitProjects(prefs),
  ]);
  return [...all].sort();
}

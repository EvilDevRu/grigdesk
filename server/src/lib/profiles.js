// Проекты (профили): у каждого — свой набор маршрутов; агенты — общая библиотека.
// Список — объединение корневых profiles/<name>/graph.json и проектов,
// заведённых в кокпите (подпапки routes/). Хардкода имён нет.
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

/** Подпапки-проекты внутри базы маршрутов. */
async function listBaseDirs(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && PROFILE_RE.test(e.name)).map((e) => e.name);
  } catch { return []; }
}

/** Все проекты: фабрика + заведённые в кокпите (объединение, отсортировано). */
export async function listProjects({ profilesDir, routesDir }) {
  const all = new Set([
    ...(await listFactoryProfiles(profilesDir)),
    ...(await listBaseDirs(routesDir)),
  ]);
  return [...all].sort();
}

// Проекты (профили): у каждого — свой набор маршрутов; агенты — общая библиотека.
// Список — объединение профилей фабрики (factory/profiles/*.graph.json) и проектов,
// заведённых в кокпите (подпапки routes/). Хардкода имён нет.
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const PROFILE_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;

/** Профили фабрики (по наличию схемы) — используются для автопосева. */
export async function listFactoryProfiles(factoryHome) {
  try {
    const files = await fs.readdir(path.join(factoryHome, 'profiles'));
    return files.filter((f) => f.endsWith('.graph.json')).map((f) => f.replace('.graph.json', ''));
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
export async function listProjects({ factoryHome, routesDir }) {
  const all = new Set([
    ...(await listFactoryProfiles(factoryHome)),
    ...(await listBaseDirs(routesDir)),
  ]);
  return [...all].sort();
}

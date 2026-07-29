// Паспорта проектов: откуда кокпит знает пути репозиториев проекта на диске.
// Источник №1 — профиль фабрики (PROFILE_TRIAGE_REPOS, читается через loadTriageProfile):
// для проектов фабрики пути живут ТОЛЬКО там — второй источник тут же разъехался бы с первым.
// Источник №2 — prefs кокпита (projects.<id>.repos): для проектов, заведённых в кокпите,
// у которых bash-профиля нет. Сам список проектов — как и раньше, lib/profiles.js.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { listFactoryProfiles, listProjects } from './profiles.js';
import { loadTriageProfile } from './analysis/profile.js';

// Чтение профиля — это source bash-файла (см. analysis/profile.js), не дёшево.
// Короткого кэша хватает: профили правятся руками и редко.
const TTL = 15_000;
const cache = new Map(); // имя → { at, repos }

async function factoryRepos(config, name) {
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < TTL) return hit.repos;
  const { repos } = await loadTriageProfile(config, name);
  cache.set(name, { at: Date.now(), repos });
  return repos;
}

/**
 * Репозитории проекта: [{key, dir, from: 'factory'|'cockpit'}]. Может быть пусто —
 * профиль без PROFILE_TRIAGE_REPOS или кокпитный проект, где пути ещё не заданы
 * (тогда кокпитные пути работают и для фабричного проекта — как фолбэк, не перекрытие).
 * @param {{config: object, prefs: object, id: string, isFactory?: boolean|null}} p
 */
export async function projectRepos({ config, prefs, id, isFactory = null }) {
  const factory = isFactory ?? (await listFactoryProfiles(config.profilesDir)).includes(id);
  if (factory) {
    const repos = await factoryRepos(config, id);
    if (repos.length) return repos.map((r) => ({ ...r, from: 'factory' }));
  }
  const saved = (prefs.read().projects || {})[id]?.repos || [];
  return saved
    .filter((r) => r && r.key && r.dir)
    .map((r) => ({ key: String(r.key), dir: String(r.dir), from: 'cockpit' }));
}

/**
 * Сводка всех проектов для раздела «Проекты» и плагина «Код»:
 * [{id, factory, repos: [{key, dir, from, exists}], routes: [id схем]}].
 */
export async function projectsOverview({ config, prefs }) {
  const factorySet = new Set(await listFactoryProfiles(config.profilesDir));
  const ids = await listProjects(config);
  return Promise.all(ids.map(async (id) => {
    const repos = await projectRepos({ config, prefs, id, isFactory: factorySet.has(id) });
    const withExists = await Promise.all(repos.map(async (r) => ({
      ...r,
      exists: await fs.access(r.dir).then(() => true).catch(() => false),
    })));
    let routes = [];
    try {
      routes = (await fs.readdir(path.join(config.routesDir, id)))
        .filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
    } catch { /* базы маршрутов ещё нет — проект только из фабрики */ }
    return { id, factory: factorySet.has(id), repos: withExists, routes };
  }));
}

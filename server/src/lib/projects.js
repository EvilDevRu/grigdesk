// Паспорта проектов: откуда кокпит знает пути репозиториев проекта на диске.
// Источник №1 — профиль фабрики (PROFILE_TRIAGE_REPOS, читается через loadTriageProfile):
// для проектов фабрики пути живут ТОЛЬКО там — второй источник тут же разъехался бы с первым.
// Источник №2 — prefs кокпита (projects.<id>.repos): для проектов, заведённых в кокпите,
// у которых bash-профиля нет. Сам список проектов — как и раньше, lib/profiles.js.
import { promises as fs } from 'node:fs';
import { listFactoryProfiles, listProjects } from './profiles.js';
import { loadTriageProfile } from './analysis/profile.js';
import { RoutesV2Store } from '../modules/routes/store-v2.js';

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
  const ids = await listProjects(config, prefs);
  const store = new RoutesV2Store({ baseDir: config.routesV2Dir });
  return Promise.all(ids.map(async (id) => {
    const repos = await projectRepos({ config, prefs, id, isFactory: factorySet.has(id) });
    const withExists = await Promise.all(repos.map(async (r) => ({
      ...r,
      exists: await fs.access(r.dir).then(() => true).catch(() => false),
    })));
    // Маршруты проекта — это состав ОПУБЛИКОВАННОГО каталога v2, а не файлы на диске:
    // здесь показывается ровно то, по чему пойдут новые попытки. Нет бандла (проект ещё
    // не переехал на v2) — пустой список, а не ошибка на весь раздел.
    let routes = [];
    try {
      const current = await store.readCurrent(id);
      routes = current ? Object.keys(current.catalog.routes).sort() : [];
    } catch { /* каталога нет или он битый — «Маршруты» покажут это подробно */ }
    return { id, factory: factorySet.has(id), repos: withExists, routes };
  }));
}

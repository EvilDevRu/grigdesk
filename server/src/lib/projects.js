// Паспорта проектов: откуда кокпит знает пути репозиториев проекта на диске.
// Источник №1 — профиль фабрики (PROFILE_TRIAGE_REPOS, читается через loadTriageProfile):
// для проектов фабрики пути живут ТОЛЬКО там — второй источник тут же разъехался бы с первым.
// Источник №2 — prefs кокпита (projects.<id>.repos): для проектов, заведённых в кокпите,
// у которых bash-профиля нет. Сам список проектов — как и раньше, lib/profiles.js.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PROFILE_RE, listFactoryProfiles, listProjects } from './profiles.js';
import { loadTriageProfile } from './analysis/profile.ts';
import { RoutesStore } from '../modules/routes/store.js';

// Чтение профиля — это source bash-файла (см. analysis/profile.ts), не дёшево.
// Короткого кэша хватает: профили правятся руками и редко.
const TTL = 15_000;
const cache = new Map(); // имя → { at, profile }

// Один монорепозиторий иногда объявляют несколькими техническими алиасами (например,
// BE/FE для совместимости профиля фабрики). Для раздела «Проекты» и плагина «Код» это
// всё равно одна физическая рабочая копия: схлопываем одинаковые корни и, если корень
// единственный, даём ему понятный ключ проекта.
function normalizeProjectRepos(repos, id, from) {
  const valid = (Array.isArray(repos) ? repos : [])
    .filter((repo) => repo && repo.key && repo.dir)
    .map((repo) => ({ key: String(repo.key), dir: String(repo.dir), from }));
  const seen = new Set();
  const unique = valid.filter((repo) => {
    const canonicalDir = path.resolve(repo.dir);
    if (seen.has(canonicalDir)) return false;
    seen.add(canonicalDir);
    return true;
  });
  if (unique.length === 1 && valid.length > 1) unique[0].key = String(id);
  return unique;
}

async function factoryProfile(config, name) {
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < TTL) return hit.profile;
  const profile = await loadTriageProfile(config, name);
  cache.set(name, { at: Date.now(), profile });
  return profile;
}

async function factoryRepos(config, name) {
  return (await factoryProfile(config, name)).repos;
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
    if (repos.length) return normalizeProjectRepos(repos, id, 'factory');
  }
  const saved = (prefs.read().projects || {})[id]?.repos || [];
  return normalizeProjectRepos(saved, id, 'cockpit');
}

/**
 * Корень, в котором лежат карты знаний проекта. Источник — рабочий каталог агента из
 * профиля фабрики: агент проекта стартует именно там, поэтому до карт дотягивается его
 * собственный @-каскад, а не каскад кокпита. Кокпитный проект без bash-профиля отдаёт
 * единственный репозиторий реестра. Несколько корней без явного выбора и полное
 * отсутствие путей дают null: карта, положенная наугад, хуже внятного отказа.
 * @param {{config: object, prefs: object, id: string, isFactory?: boolean|null}} p
 * @returns {Promise<string|null>} абсолютный путь или null
 */
export async function projectMapsRoot({ config, prefs, id, isFactory = null }) {
  if (!PROFILE_RE.test(String(id || ''))) {
    return null;
  }
  const factory = isFactory ?? (await listFactoryProfiles(config.profilesDir)).includes(id);
  if (factory) {
    const { cwd } = await factoryProfile(config, id);
    if (cwd && path.isAbsolute(cwd)) {
      return path.resolve(cwd);
    }
  }
  const repos = normalizeProjectRepos(
    (prefs.read().projects || {})[id]?.repos || [],
    id,
    'cockpit',
  );
  return repos.length === 1 ? path.resolve(repos[0].dir) : null;
}

/**
 * Сводка всех проектов для раздела «Проекты» и плагина «Код»:
 * [{id, factory, repos: [{key, dir, from, exists}], routes: [id схем]}].
 */
export async function projectsOverview({ config, prefs }) {
  const factorySet = new Set(await listFactoryProfiles(config.profilesDir));
  const ids = await listProjects(config, prefs);
  const store = new RoutesStore({ baseDir: config.routesDir });
  return Promise.all(ids.map(async (id) => {
    const repos = await projectRepos({ config, prefs, id, isFactory: factorySet.has(id) });
    const withExists = await Promise.all(repos.map(async (r) => ({
      ...r,
      exists: await fs.access(r.dir).then(() => true).catch(() => false),
    })));
    // Маршруты проекта — это состав ОПУБЛИКОВАННОГО каталога, а не файлы на диске:
    // здесь показывается ровно то, по чему пойдут новые попытки. Нет бандла — пустой
    // список, а не ошибка на весь раздел.
    let routes = [];
    try {
      const current = await store.readCurrent(id);
      routes = current ? Object.keys(current.catalog.routes).sort() : [];
    } catch { /* каталога нет или он битый — «Маршруты» покажут это подробно */ }
    return { id, factory: factorySet.has(id), repos: withExists, routes };
  }));
}

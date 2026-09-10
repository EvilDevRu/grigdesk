// Паспорта проектов: откуда кокпит знает пути репозиториев проекта на диске.
// Источник №1 — профиль фабрики (PROFILE_TRIAGE_REPOS, читается через loadTriageProfile):
// для проектов фабрики пути живут ТОЛЬКО там — второй источник тут же разъехался бы с первым.
// Источник №2 — prefs кокпита (projects.<id>.repos): для проектов, заведённых в кокпите,
// у которых bash-профиля нет. Сам список проектов — как и раньше, lib/profiles.js.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PROFILE_RE, listFactoryProfiles, listProjects } from './profiles.ts';
import { loadTriageProfile } from './analysis/profile.ts';
import { RoutesStore } from '../modules/routes/store.ts';
import type { ProjectsPrefsPort } from './profiles.ts';
import type { TriageProfilePaths } from './analysis/profile.ts';

// Паспорту проекта нужен каталог профилей и пути чтения bash-профиля; каталог
// маршрутов читает только сводка раздела. Полная форма config — в config.ts.
type ProjectPathsConfig = TriageProfilePaths & {
  profilesDir: string;
};

type ProjectsConfig = ProjectPathsConfig & {
  routesDir: string;
};

// Prefs как источник кокпитных путей. Содержимое недоверенное: форму каждой записи
// проверяет нормализация, поэтому порт объявляет только сам факт чтения.
export interface ProjectsPrefsReader {
  read?: () => unknown;
}

// Репозиторий проекта: метка, путь и то, кто этот путь назвал.
export interface ProjectRepo {
  key: string;
  dir: string;
  from: string;
}

// Чтение профиля — это source bash-файла (см. analysis/profile.ts), не дёшево.
// Короткого кэша хватает: профили правятся руками и редко.
const TTL = 15_000;
// имя профиля → его последнее прочтение, чтобы не пересорсить bash на каждый запрос.
const cache = new Map<string, { at: number; profile: Awaited<ReturnType<typeof loadTriageProfile>> }>();

// Один монорепозиторий иногда объявляют несколькими техническими алиасами (например,
// BE/FE для совместимости профиля фабрики). Для раздела «Проекты» и плагина «Код» это
// всё равно одна физическая рабочая копия: схлопываем одинаковые корни и, если корень
// единственный, даём ему понятный ключ проекта.
function normalizeProjectRepos(repos: unknown, id: string, from: string): ProjectRepo[] {
  const valid = ((Array.isArray(repos) ? repos : []) as Array<{ key?: unknown; dir?: unknown }>)
    .filter((repo) => repo && repo.key && repo.dir)
    .map((repo) => ({ key: String(repo.key), dir: String(repo.dir), from }));
  const seen = new Set();
  const unique = valid.filter((repo) => {
    const canonicalDir = path.resolve(repo.dir);
    if (seen.has(canonicalDir)) return false;
    seen.add(canonicalDir);
    return true;
  });
  const only = unique[0];
  if (only && unique.length === 1 && valid.length > 1) only.key = String(id);
  return unique;
}

async function factoryProfile(config: ProjectPathsConfig, name: string) {
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < TTL) return hit.profile;
  const profile = await loadTriageProfile(config, name);
  cache.set(name, { at: Date.now(), profile });
  return profile;
}

async function factoryRepos(config: ProjectPathsConfig, name: string) {
  return (await factoryProfile(config, name)).repos;
}

/**
 * Репозитории проекта: [{key, dir, from: 'factory'|'cockpit'}]. Может быть пусто —
 * профиль без PROFILE_TRIAGE_REPOS или кокпитный проект, где пути ещё не заданы
 * (тогда кокпитные пути работают и для фабричного проекта — как фолбэк, не перекрытие).
 */
export async function projectRepos({ config, prefs, id, isFactory = null }: {
  config: ProjectPathsConfig;
  prefs: ProjectsPrefsReader;
  id: string;
  isFactory?: boolean | null;
}): Promise<ProjectRepo[]> {
  const factory = isFactory ?? (await listFactoryProfiles(config.profilesDir)).includes(id);
  if (factory) {
    const repos = await factoryRepos(config, id);
    if (repos.length) return normalizeProjectRepos(repos, id, 'factory');
  }
  const saved = savedRepos(prefs, id);
  return normalizeProjectRepos(saved, id, 'cockpit');
}

// Пути, заведённые в кокпите. Реестр prefs недоверенный: наружу отдаём его как есть,
// а форму каждой записи проверяет нормализация.
function savedRepos(prefs: ProjectsPrefsReader, id: string): unknown {
  const stored = prefs.read?.() as { projects?: unknown } | null | undefined;
  const projects = (stored?.projects || {}) as Record<string, { repos?: unknown }>;
  return projects[id]?.repos || [];
}

/**
 * Корень, в котором лежат карты знаний проекта. Источник — рабочий каталог агента из
 * профиля фабрики: агент проекта стартует именно там, поэтому до карт дотягивается его
 * собственный @-каскад, а не каскад кокпита. Кокпитный проект без bash-профиля отдаёт
 * единственный репозиторий реестра. Несколько корней без явного выбора и полное
 * отсутствие путей дают null: карта, положенная наугад, хуже внятного отказа.
 * @returns абсолютный путь или null
 */
export async function projectMapsRoot({ config, prefs, id, isFactory = null }: {
  config: ProjectPathsConfig;
  prefs: ProjectsPrefsReader;
  id: string;
  isFactory?: boolean | null;
}): Promise<string | null> {
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
  const repos = normalizeProjectRepos(savedRepos(prefs, id), id, 'cockpit');
  const only = repos[0];
  return repos.length === 1 && only ? path.resolve(only.dir) : null;
}

/**
 * Сводка всех проектов для раздела «Проекты» и плагина «Код»:
 * [{id, factory, repos: [{key, dir, from, exists}], routes: [id схем]}].
 */
export async function projectsOverview({ config, prefs }: {
  config: ProjectsConfig;
  prefs: ProjectsPrefsPort;
}) {
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
    let routes: string[] = [];
    try {
      const current = await store.readCurrent(id);
      routes = current ? Object.keys(current.catalog.routes).sort() : [];
    } catch { /* каталога нет или он битый — «Маршруты» покажут это подробно */ }
    return { id, factory: factorySet.has(id), repos: withExists, routes };
  }));
}

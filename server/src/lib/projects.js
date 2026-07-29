// Паспорта проектов: откуда кокпит знает пути репозиториев проекта на диске.
// Источник №1 — профиль фабрики (PROFILE_TRIAGE_REPOS, читается через loadTriageProfile):
// для проектов фабрики пути живут ТОЛЬКО там — второй источник тут же разъехался бы с первым.
// Источник №2 — prefs кокпита (projects.<id>.repos): для проектов, заведённых в кокпите,
// у которых bash-профиля нет. Сам список проектов — как и раньше, lib/profiles.js.
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { listFactoryProfiles, listProjects } from './profiles.js';
import { loadTriageProfile } from './analysis/profile.js';

const exec = promisify(execFile);

// Чтение профиля — это source bash-файла (см. analysis/profile.js), не дёшево.
// Короткого кэша хватает: профили правятся руками и редко.
const TTL = 15_000;
const cache = new Map(); // имя → { at, repos }

const GITHUB_SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Привести GitHub slug к сохраняемому виду, не меняя регистр владельца и репозитория. */
export function normalizeGitHubSlug(value) {
  const slug = String(value || '').trim().replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  return GITHUB_SLUG_RE.test(slug) ? slug : '';
}

/**
 * Извлечь owner/repo только из github.com remote. Userinfo намеренно не возвращается:
 * в HTTPS remote иногда лежит токен, его нельзя засветить в API «Проектов».
 */
export function githubSlugFromRemote(value) {
  const remote = String(value || '').trim();
  if (!remote) return '';
  const scp = remote.match(/^(?:[^@/:]+@)?github\.com:([^/]+\/[^/]+)$/i);
  if (scp) return normalizeGitHubSlug(scp[1]);
  try {
    const url = new URL(remote);
    if (url.hostname.toLowerCase() !== 'github.com') return '';
    return normalizeGitHubSlug(url.pathname);
  } catch {
    return '';
  }
}

/** Публичное и безопасное представление сохранённой GitHub-привязки репозитория. */
export function normalizeReviewBinding(value = {}) {
  const slug = normalizeGitHubSlug(value.slug);
  const detectedSlug = normalizeGitHubSlug(value.detectedSlug);
  const requestedConfirmation = !!value.confirmed && !!slug;
  const remoteChecked = value.remoteChecked === true;
  const mismatch = !!(requestedConfirmation && remoteChecked
    && (!detectedSlug || slug.toLowerCase() !== detectedSlug.toLowerCase()));
  const active = requestedConfirmation && !mismatch;
  const verifyCommands = [...new Set((Array.isArray(value.verifyCommands) ? value.verifyCommands : [])
    .map((cmd) => String(cmd || '').trim())
    .filter(Boolean))]
    .slice(0, 20);
  return {
    slug,
    detectedSlug,
    confirmed: active,
    ...(mismatch && { mismatch: true }),
    autoSync: active && value.autoSync !== false,
    autoAnalyze: active && value.autoAnalyze !== false,
    verifyCommands,
    verifyCoversCriteria: active
      && verifyCommands.length > 0
      && value.verifyCoversCriteria === true,
  };
}

/**
 * Найти другую подтверждённую привязку того же GitHub repository.
 * Сравнение case-insensitive: GitHub owner/repo регистронезависимы.
 */
export function reviewBindingConflict(projects, { projectId, repoKey, slug }) {
  const wanted = normalizeGitHubSlug(slug).toLowerCase();
  if (!wanted) return null;
  for (const [pid, project] of Object.entries(projects || {})) {
    const repositories = project?.review?.repositories || {};
    for (const [key, raw] of Object.entries(repositories)) {
      if (pid === projectId && key === repoKey) continue;
      const binding = normalizeReviewBinding(raw);
      if (binding.confirmed && binding.slug.toLowerCase() === wanted) {
        return { projectId: pid, repoKey: key };
      }
    }
  }
  return null;
}

async function detectedGitHubSlug(dir) {
  try {
    const { stdout } = await exec('git', ['-C', dir, 'remote', 'get-url', 'origin'], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    return githubSlugFromRemote(stdout);
  } catch {
    return '';
  }
}

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
  const savedProjects = prefs.read().projects || {};
  return Promise.all(ids.map(async (id) => {
    const repos = await projectRepos({ config, prefs, id, isFactory: factorySet.has(id) });
    const withExists = await Promise.all(repos.map(async (r) => {
      const exists = await fs.access(r.dir).then(() => true).catch(() => false);
      const detectedSlug = exists ? await detectedGitHubSlug(r.dir) : '';
      const stored = savedProjects[id]?.review?.repositories?.[r.key] || {};
      return {
        ...r,
        exists,
        github: normalizeReviewBinding({ ...stored, detectedSlug, remoteChecked: exists }),
      };
    }));
    let routes = [];
    try {
      routes = (await fs.readdir(path.join(config.routesDir, id)))
        .filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
    } catch { /* базы маршрутов ещё нет — проект только из фабрики */ }
    return {
      id,
      factory: factorySet.has(id),
      repos: withExists,
      routes,
      reviewReady: withExists.some((repo) => repo.github.confirmed),
    };
  }));
}

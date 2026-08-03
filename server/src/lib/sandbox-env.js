// Каноническое чтение репозиториев из t<TASK>.env песочницы.
//
// Generic route contract задаёт произвольный список через REPO_COUNT и
// REPO_<i>_{NAME,SOURCE,WT,BRANCH}. Появление ЛЮБОГО REPO_* означает, что файл заявил
// новый формат: неполный или расширенный набор нельзя тихо трактовать как legacy,
// иначе повреждённый generic env внезапно откроет агенту пути из BE_WT/FE_WT.
// Старый двухрепозиторный формат читается только при полном отсутствии REPO_*.
import path from 'node:path';

const REPO_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SOURCE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/;
const GENERIC_KEY = /^REPO_(?:COUNT|[0-9]+_(?:NAME|SOURCE|WT|BRANCH))$/;

function validWorktree(value, { generic = false } = {}) {
  if (typeof value !== 'string' || !value || !path.isAbsolute(value)) return false;
  if (value === path.parse(value).root || path.normalize(value) !== value) return false;
  if (/[\x00\r\n\t]/.test(value)) return false;
  // Typed context разделяет поля двоеточием, поэтому generic hook его запрещает.
  return !generic || !value.includes(':');
}

function validBranch(value) {
  return typeof value === 'string'
    && SOURCE_BRANCH.test(value)
    && !value.includes('..');
}

function invalid(reason) {
  return { kind: 'invalid', repos: [], workspaceMode: null, error: reason };
}

function workspaceMode(env, { historical = false } = {}) {
  const value = env.WORKSPACE_MODE || (historical ? 'isolated' : '');
  return ['isolated', 'shared'].includes(value) ? value : null;
}

function parseGeneric(env, repoKeys) {
  const rawCount = env.REPO_COUNT;
  if (!/^(?:[1-9]|1[0-6])$/.test(String(rawCount ?? ''))) {
    return invalid('REPO_COUNT обязан быть целым числом от 1 до 16');
  }
  const count = Number(rawCount);
  const expected = new Set(['REPO_COUNT']);
  const repos = [];
  const names = new Set();
  const sources = new Set();
  const worktrees = new Set();

  for (let index = 0; index < count; index += 1) {
    const prefix = 'REPO_' + index + '_';
    for (const field of ['NAME', 'SOURCE', 'WT', 'BRANCH']) expected.add(prefix + field);
    const name = env[prefix + 'NAME'];
    const source = env[prefix + 'SOURCE'];
    const worktree = env[prefix + 'WT'];
    const branch = env[prefix + 'BRANCH'];
    if (!REPO_NAME.test(String(name ?? ''))) {
      return invalid(prefix + 'NAME имеет недопустимую форму');
    }
    if (!validWorktree(source, { generic: true })) {
      return invalid(prefix + 'SOURCE обязан быть нормализованным абсолютным путём');
    }
    if (!validWorktree(worktree, { generic: true })) {
      return invalid(prefix + 'WT обязан быть нормализованным абсолютным путём');
    }
    if (!validBranch(branch)) {
      return invalid(prefix + 'BRANCH имеет недопустимую форму');
    }
    if (names.has(name) || sources.has(source) || worktrees.has(worktree)) {
      return invalid('имена, source и workspace generic-репозиториев обязаны быть уникальными');
    }
    names.add(name);
    sources.add(source);
    worktrees.add(worktree);
    repos.push({ name, source, path: worktree, branch });
  }

  if (repoKeys.some((key) => !GENERIC_KEY.test(key) || !expected.has(key))
      || [...expected].some((key) => !repoKeys.includes(key))) {
    return invalid('набор REPO_* не совпадает с REPO_COUNT');
  }
  const mode = workspaceMode(env);
  if (!mode) return invalid('WORKSPACE_MODE обязан быть явно задан как isolated или shared');
  if (repos.some((repo) => (mode === 'shared') !== (repo.source === repo.path))) {
    return invalid('shared требует SOURCE=WT, isolated — различные source и workspace');
  }
  return { kind: 'generic', repos, workspaceMode: mode, error: null };
}

function parseLegacy(env, { allowLegacy = false } = {}) {
  const hasLegacy = ['BE_WT', 'FE_WT', 'BE_BRANCH', 'FE_BRANCH'].some((key) => env[key]);
  if (hasLegacy && !allowLegacy) {
    return invalid('BE_WT/FE_WT принадлежат read-only legacy env; текущему прогону нужен REPO_*');
  }
  const repos = [];
  const seen = new Set();
  for (const [name, worktreeKey, branchKey] of [
    ['be', 'BE_WT', 'BE_BRANCH'],
    ['fe', 'FE_WT', 'FE_BRANCH'],
  ]) {
    const worktree = env[worktreeKey];
    if (!worktree) continue;
    if (!validWorktree(worktree)) return invalid(worktreeKey + ' имеет недопустимую форму');
    if (seen.has(worktree)) continue;
    seen.add(worktree);
    const rawBranch = env[branchKey] || '';
    repos.push({ name, path: worktree, branch: validBranch(rawBranch) ? rawBranch : '' });
  }
  const mode = workspaceMode(env, { historical: allowLegacy });
  if (!mode) return invalid('WORKSPACE_MODE обязан быть явно задан как isolated или shared');
  return { kind: repos.length ? 'legacy' : 'none', repos, workspaceMode: mode, error: null };
}

/**
 * Безопасно разбирает worktree-репозитории песочницы.
 * @param {Record<string, string>} rawEnv результат parsePipeline(t<TASK>.env)
 * Legacy BE_WT/FE_WT читается только явным read-only opt-in. Actionable пути (чат,
 * lifecycle, запуск) обязаны использовать generic REPO_* и fail closed.
 * @returns {{kind:'generic'|'legacy'|'none'|'invalid', repos:Array<{name:string,source?:string,path:string,branch:string}>, workspaceMode:'isolated'|'shared'|null, error:string|null}}
 */
export function parseSandboxRepositories(rawEnv, { allowLegacy = false } = {}) {
  const env = rawEnv && typeof rawEnv === 'object' && !Array.isArray(rawEnv) ? rawEnv : {};
  const repoKeys = Object.keys(env).filter((key) => key.startsWith('REPO_'));
  return repoKeys.length ? parseGeneric(env, repoKeys) : parseLegacy(env, { allowLegacy });
}

// Контракт запуска из Cockpit. Движок по-прежнему получает только явные CLI-аргументы:
// этот модуль читает trusted profile topology, валидирует редактируемый ввод браузера
// и строит безопасные immutable-параметры из профиля и локального триажа задачи.
import { execFile } from 'node:child_process';
import path from 'node:path';

import { PROFILE_RE } from './profiles.js';

const RECORD_SEPARATOR = '\x1e';
const TASK_RE = /^[1-9][0-9]{0,18}$/;
const REPOSITORY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
const DIAGNOSIS_KINDS = new Set(['functional', 'performance', 'data', 'integration']);
// Дополнительные действия доставки, которые профиль может разрешить прогону. Словарь
// принадлежит движку (factory-context DELIVERY_ACTIONS минус обязательная для publish
// тройка commit/push/pull-request); здесь он продублирован fail-closed, чтобы профиль
// не смог закрепить в immutable contract попытки действие, которого движок не знает.
const OPTIONAL_DELIVERY_ACTIONS = new Set(['task-comment']);

// profile.sh — trusted executable configuration, которую всё равно source-ит factory.
// Аргументы идут позиционно, а не интерполируются в shell source.
const READ_PROFILE_SCRIPT = String.raw`
PROFILE_TRIAGE_REPOS=""
source "$1" >/dev/null 2>&1 || exit 1
declare -F profile_repositories >/dev/null || exit 2
repositories=$(profile_repositories "$2") || exit 3
delivery=""
if declare -F profile_delivery_targets >/dev/null; then
  delivery=$(profile_delivery_targets "$2") || exit 4
fi
delivery_actions=""
if declare -F profile_delivery_actions >/dev/null; then
  delivery_actions=$(profile_delivery_actions "$2") || exit 5
fi
printf '%s\036%s\036%s\036%s' "$repositories" "$delivery" "$PROFILE_TRIAGE_REPOS" "$delivery_actions"
`;

export class FactoryLaunchContractError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FactoryLaunchContractError';
  }
}

function fail(message) {
  throw new FactoryLaunchContractError(message);
}

function outputLines(raw, label) {
  if (!raw) return [];
  if (raw.includes('\r') || raw.includes('\0')) fail(`${label}: недопустимые управляющие символы`);
  const lines = raw.split('\n');
  if (lines.some((line) => !line)) fail(`${label}: пустая строка`);
  return lines;
}

function validBranch(branch) {
  return BRANCH_RE.test(branch)
    && !branch.includes('..')
    && !branch.includes('//')
    && !branch.includes('@{')
    && !branch.endsWith('/')
    && !branch.endsWith('.')
    && !branch.endsWith('.lock');
}

/**
 * Читает generic repository topology и целевые ветки Cockpit из профиля.
 * `profile_delivery_targets` не ослабляет engine contract: сервер передаёт каждую
 * настроенную ветку движку явным `--delivery-target`, но браузер их не выбирает.
 * Опциональный `profile_delivery_actions` (по строке на действие) решает, какие
 * дополнительные действия доставки разрешены publish-прогону; без хука разрешена
 * только обязательная тройка commit/push/pull-request.
 */
export async function loadFactoryLaunchProfile(config, profile, task) {
  profile = String(profile || '');
  task = String(task || '');
  if (!PROFILE_RE.test(profile) || !TASK_RE.test(task)) {
    fail('профиль или номер задачи имеют неверный формат');
  }
  const profileFile = path.join(config.profilesDir, profile, 'profile.sh');
  const stdout = await new Promise((resolve, reject) => {
    execFile('bash', ['--noprofile', '--norc', '-c', READ_PROFILE_SCRIPT,
      'factory-launch-profile', profileFile, task], {
      env: {
        ...process.env,
        FACTORY_HOME: config.factoryHome,
        FACTORY_PROFILES_DIR: config.profilesDir,
      },
      timeout: 10_000,
      maxBuffer: 256 * 1024,
      encoding: 'utf8',
    }, (error, output) => {
      if (error) reject(new FactoryLaunchContractError(
        `profile.sh не отдал topology запуска (код ${typeof error.code === 'number' ? error.code : 1})`,
      ));
      else resolve(String(output || ''));
    });
  });

  const sections = stdout.split(RECORD_SEPARATOR);
  if (sections.length !== 4) fail('profile.sh вернул неоднозначный launch contract');
  const [repositoriesRaw, targetsRaw, triageRaw, deliveryActionsRaw] = sections;
  const deliveryActions = [];
  for (const action of outputLines(deliveryActionsRaw, 'profile_delivery_actions')) {
    if (!OPTIONAL_DELIVERY_ACTIONS.has(action) || deliveryActions.includes(action)) {
      fail(`profile_delivery_actions: неизвестное или повторное действие ${action}`);
    }
    deliveryActions.push(action);
  }
  deliveryActions.sort();
  const repositories = [];
  const names = new Set();
  for (const line of outputLines(repositoriesRaw, 'profile_repositories')) {
    const fields = line.split('\t');
    if (fields.length !== 3) fail('profile_repositories: ожидалось имя<TAB>source<TAB>workspace');
    const [name, source, workspace] = fields;
    if (!REPOSITORY_RE.test(name) || names.has(name)
        || !path.isAbsolute(source) || !path.isAbsolute(workspace)
        || /[\n\t]/.test(source) || /[\n\t]/.test(workspace)) {
      fail('profile_repositories: небезопасная или повторная запись');
    }
    names.add(name);
    repositories.push({ name, source, workspace, triageKey: null, targetBranch: '' });
  }
  if (repositories.length < 1 || repositories.length > 16) {
    fail('profile_repositories: требуется от 1 до 16 репозиториев');
  }

  const targets = new Map();
  for (const line of outputLines(targetsRaw, 'profile_delivery_targets')) {
    const fields = line.split('\t');
    if (fields.length !== 2) fail('profile_delivery_targets: ожидалось имя<TAB>ветка');
    const [name, branch] = fields;
    if (!names.has(name) || targets.has(name) || !validBranch(branch)) {
      fail('profile_delivery_targets: неизвестный repo, повтор или неверная ветка');
    }
    targets.set(name, branch);
  }

  const triageBySource = new Map();
  for (const pair of String(triageRaw || '').split(/\s+/).filter(Boolean)) {
    const separator = pair.indexOf(':');
    if (separator < 1) continue;
    const key = pair.slice(0, separator);
    const source = pair.slice(separator + 1);
    if (REPOSITORY_RE.test(key) && path.isAbsolute(source) && !triageBySource.has(source)) {
      triageBySource.set(source, key);
    }
  }

  return {
    repositories: repositories.map((repo) => ({
      ...repo,
      triageKey: triageBySource.get(repo.source) || null,
      targetBranch: targets.get(repo.name) || '',
    })),
    deliveryActions,
  };
}

function parseDeliveryTargets(values, repositoryNames) {
  if (!Array.isArray(values) || values.length > 16) {
    fail('deliveryTargets должен быть массивом не более чем из 16 строк repo=branch');
  }
  const parsed = new Map();
  for (const value of values) {
    if (typeof value !== 'string' || value.split('=').length !== 2
        || /[\n\t]/.test(value)) {
      fail('delivery target: ожидалось repo=branch');
    }
    const separator = value.indexOf('=');
    const name = value.slice(0, separator);
    const branch = value.slice(separator + 1);
    if (!repositoryNames.has(name) || parsed.has(name) || !validBranch(branch)) {
      fail('delivery target: неизвестный repo, повтор или неверная ветка');
    }
    parsed.set(name, branch);
  }
  return parsed;
}

function parseInstrumentationFile(value, repositoryNames) {
  if (typeof value !== 'string' || value.length > 4096
      || !value.includes(':') || /[\n\t\\]/.test(value)) {
    fail('instrumentation file: ожидалось repo:relative/path');
  }
  const separator = value.indexOf(':');
  const name = value.slice(0, separator);
  const relative = value.slice(separator + 1);
  const parts = relative.split('/');
  if (!repositoryNames.has(name) || !relative || relative.startsWith('/')
      || relative.endsWith('/') || parts.some((part) => !part || part === '.' || part === '..')
      || parts.some((part) => part === '.git' || part === '.slot'
        || part === '.env' || part.startsWith('.env.'))) {
    fail('instrumentation file: путь вне разрешённого repository scope');
  }
  return `${name}:${relative}`;
}

/**
 * Scope-контракт выводится из опубликованной машины, а не из route id.
 * `instrument` держит одну явную транзакцию до `proof`; прочие исторические
 * transactional-write узлы используют scope, полученный движком из текущего diff.
 */
export function routeInstrumentationMode(route) {
  if (!route || !Array.isArray(route.nodes)) fail('route instrumentation topology недоступна');
  const transactional = route.nodes.filter(
    (node) => node?.policy?.filesystem === 'transactional-write',
  );
  if (transactional.some((node) => node.id === 'instrument')) return 'explicit';
  return transactional.length ? 'derived' : 'disabled';
}

/** Проверка request body до ticket, git refresh, slot reservation и provisioning. */
export function normalizeFactoryLaunchInputs({
  deliveryMode,
  instrumentationMode,
  repositories,
  deliveryTargets = [],
  instrumentationFiles = [],
  diagnosisKind = '',
  diagnosisSignal = '',
  profileDeliveryActions = [],
}) {
  if (!['publish', 'disabled'].includes(deliveryMode)) fail('маршрут не объявил delivery mode');
  if (!['explicit', 'derived', 'disabled'].includes(instrumentationMode)) {
    fail('маршрут не объявил instrumentation mode');
  }
  const repoList = Array.isArray(repositories) ? repositories : [];
  const repositoryNames = new Set(repoList.map((repo) => repo?.name));
  if (repositoryNames.has(undefined) || repositoryNames.size !== repoList.length || !repoList.length) {
    fail('profile repository topology недоступна');
  }

  const requestedTargets = parseDeliveryTargets(deliveryTargets, repositoryNames);
  const configuredTargets = new Map(repoList
    .filter((repo) => repo.targetBranch)
    .map((repo) => [repo.name, repo.targetBranch]));
  if (deliveryMode === 'publish') {
    const missing = repoList.map((repo) => repo.name).filter((name) => !configuredTargets.has(name));
    if (missing.length) {
      fail(`profile_delivery_targets: не заданы ветки для ${missing.join(', ')}`);
    }
    // Старые клиенты могли присылать targets явно. Принимаем только exact-повтор
    // trusted profile contract; пустой список означает «взять из профиля».
    if (requestedTargets.size && (
      requestedTargets.size !== configuredTargets.size
      || repoList.some((repo) => requestedTargets.get(repo.name) !== configuredTargets.get(repo.name))
    )) {
      fail('delivery targets должны точно совпадать с конфигурацией профиля');
    }
  } else if (requestedTargets.size) {
    fail('маршрут без ship не принимает delivery targets');
  }

  if (!Array.isArray(instrumentationFiles) || instrumentationFiles.length > 64) {
    fail('instrumentationFiles должен быть массивом не более чем из 64 путей');
  }
  const instrumentation = instrumentationFiles.map(
    (value) => parseInstrumentationFile(value, repositoryNames),
  );
  if (new Set(instrumentation).size !== instrumentation.length) {
    fail('instrumentation file: повтор пути');
  }
  if (instrumentationMode === 'explicit' && !instrumentation.length) {
    fail('маршрут требует хотя бы один instrumentation file');
  }
  if (instrumentationMode !== 'explicit' && instrumentation.length) {
    fail('маршрут не принимает явные instrumentation files');
  }

  diagnosisKind = String(diagnosisKind || '');
  diagnosisSignal = String(diagnosisSignal || '').trim();
  if (diagnosisKind && !DIAGNOSIS_KINDS.has(diagnosisKind)) {
    fail('diagnosis kind: functional, performance, data или integration');
  }
  if (diagnosisSignal.length > 200 || /[\n\t\0]/.test(diagnosisSignal)) {
    fail('diagnosis signal: до 200 символов одной строкой');
  }

  return {
    deliveryTargets: deliveryMode === 'publish'
      ? repoList.map((repo) => `${repo.name}=${configuredTargets.get(repo.name)}`)
      : [],
    // Дополнительные действия доставки — решение профиля (`profile_delivery_actions`),
    // а не кокпита: движок выдаёт `task-comment` только по явному флагу.
    taskComment: deliveryMode === 'publish' && profileDeliveryActions.includes('task-comment'),
    instrumentationFiles: [...instrumentation].sort(),
    diagnosisKind,
    diagnosisSignal,
  };
}

/**
 * Каталоги репозиториев, которые триаж ЭТОЙ задачи фактически читал: он пишет их в
 * `analysis.repos.<alias>.dir` из `PROFILE_TRIAGE_REPOS` профиля прогона, а
 * `loadFactoryLaunchProfile` тем же путём (`source`) связывает repo с `triageKey`.
 * Поэтому сравнение буквальное — обе стороны берут путь из одной переменной профиля.
 */
function triageRepositoryDirs(analysis) {
  const repos = analysis?.repos;
  if (!repos || typeof repos !== 'object' || Array.isArray(repos)) return [];
  const dirs = [];
  for (const entry of Object.values(repos)) {
    const dir = entry?.dir;
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) continue;
    const normalized = path.resolve(dir);
    if (!dirs.includes(normalized)) dirs.push(normalized);
  }
  return dirs;
}

/**
 * Профиль по умолчанию для формы запуска: тот, чьи репозитории читал триаж задачи.
 * Иначе форма открывается на профиле случайного активного прогона (`primaryProfile`
 * берёт первый незакрытый реестр по номеру задачи), и у задачи чужого проекта поле
 * инструментации пустое: алиасы триажа (`fe:`) не сопоставляются с репозиториями
 * профиля, а explicit-маршрут без единого файла запускать нечем.
 *
 * Совпадение — по фактическим путям, а не по имени профиля, проекта или группы
 * трекера: имя придумывает человек, а путь объявляет сам профиль. Неоднозначность
 * (два профиля на одни репозитории — законная схема) выбор не делает: решает человек
 * селектором, дефолт остаётся прежним. Нечитаемый контракт профиля кандидатом не
 * является и запуск остальных не ломает.
 */
export async function profileMatchingTriage(config, task, analysis, candidates) {
  const dirs = triageRepositoryDirs(analysis);
  if (!dirs.length || !Array.isArray(candidates) || !candidates.length) return null;
  const matched = [];
  await Promise.all(candidates.map(async (name) => {
    let profile;
    try { profile = await loadFactoryLaunchProfile(config, name, task); }
    catch { return; }
    const sources = new Set(profile.repositories.map((repo) => path.resolve(repo.source)));
    if (dirs.every((dir) => sources.has(dir))) matched.push(name);
  }));
  return matched.length === 1 ? matched[0] : null;
}

/** Триаж использует короткие alias (`be:`), движок — canonical repo name (`backend:`). */
export function instrumentationSuggestions(analysis, repositories) {
  if (!analysis || !Array.isArray(analysis.files) || !Array.isArray(repositories)) return [];
  const aliases = new Map(repositories
    .filter((repo) => repo.triageKey)
    .map((repo) => [repo.triageKey, repo.name]));
  const names = new Set(repositories.map((repo) => repo.name));
  const suggestions = [];
  for (const file of analysis.files) {
    if (typeof file !== 'string' || !file.includes(':')) continue;
    const separator = file.indexOf(':');
    const alias = file.slice(0, separator);
    const canonical = aliases.get(alias) || (names.has(alias) ? alias : null);
    if (!canonical) continue;
    try {
      const value = parseInstrumentationFile(`${canonical}:${file.slice(separator + 1)}`, names);
      if (!suggestions.includes(value)) suggestions.push(value);
    } catch { /* триажная подсказка не должна ломать launch-options */ }
  }
  return suggestions.slice(0, 64);
}

export function diagnosisSuggestion(analysis) {
  const areas = Array.isArray(analysis?.areas) ? analysis.areas.join(' ').toLowerCase() : '';
  let kind = 'functional';
  if (/(performance|latency|slow|perf)/.test(areas)) kind = 'performance';
  else if (/(migration|database|clickhouse|mysql|user_db|\bdata\b)/.test(areas)) kind = 'data';
  else if (/(integration|external|webhook)/.test(areas)) kind = 'integration';
  const rawSignal = typeof analysis?.title === 'string' ? analysis.title
    : (typeof analysis?.summary === 'string' ? analysis.summary : '');
  return { kind, signal: rawSignal.replace(/[\n\t]/g, ' ').trim().slice(0, 200) };
}

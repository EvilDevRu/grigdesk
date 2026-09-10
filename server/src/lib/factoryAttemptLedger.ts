import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Dirent, Stats } from 'node:fs';

// Записи журнала читаются по объявленным схемой полям: набор ключей сверяет exactKeys,
// а типы ниже описывают ровно то, что после этого разбирается.
interface AttemptRecord {
  schema?: number;
  protocolVersion?: number;
  attemptId?: string;
  taskId?: string;
  profile?: string;
  createdAt?: string;
  routesDir?: string;
  catalogHash?: string;
  origin?: string;
  previousAttemptId?: string | null;
  recoveryReason?: string | null;
  queueDispatchId?: string | null;
  runnerPrimaryOverride?: string | null;
}

interface PinsRecord {
  schema?: number;
  protocolVersion?: number;
  attemptId?: string;
  taskId?: string;
  profile?: string;
  catalogHash?: string;
  bootstrap?: { id?: string; catalogHash?: string };
}

interface RoutePinRecord {
  schema?: number;
  protocolVersion?: number;
  attemptId?: string;
  taskId?: string;
  profile?: string;
  catalogHash?: string;
  routeId?: string;
  routeHash?: string;
  selectedAt?: string;
}

interface TerminalRecord {
  schema?: number;
  protocolVersion?: number;
  attemptId?: string;
  taskId?: string;
  state?: string;
  closedAt?: string;
  reason?: string | null;
}

// Репозиторий из immutable-манифеста профиля: source и workspace всегда абсолютны.
export interface ContractRepository {
  name: string;
  source: string;
  workspace: string;
  branch: string | null;
}

// Контракт профиля попытки: что за стенд, чья ветка и какие репозитории закреплены.
export interface TrustedProfileContract {
  workspaceMode: string;
  standOwnership: string;
  sourceBranch: string;
  container: string;
  serviceHost: string;
  frontendPort: string | null;
  apiPort: string | null;
  repositories: ContractRepository[];
  resources: string[];
}

// Курсор журнала этапов: где маршрут реально стоит и почему.
export interface StageCursor {
  node: string | null;
  state: string;
  stop: string | null;
  pauseReason: string | null;
}

const ATTEMPT_RE = /^a_[a-f0-9]{32}$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const PROFILE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ROUTE_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const TASK_RE = /^[1-9][0-9]{0,18}$/;
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const DISPATCH_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RUNNER_RE = /^[a-z][a-z0-9_-]{0,63}$/;

export class FactoryLedgerIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FactoryLedgerIntegrityError';
  }
}

function fail(message: string): never {
  throw new FactoryLedgerIntegrityError(message);
}

function exactKeys(value: unknown, keys: readonly string[], label: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
    fail(`${label}: unexpected schema`);
  }
}

function exactTimestamp(value: unknown, label: string): void {
  const parsed = typeof value === 'string' && TIME_RE.test(value) ? new Date(value) : null;
  if (!parsed || Number.isNaN(parsed.valueOf())
      || parsed.toISOString().replace('.000Z', 'Z') !== value) {
    fail(`${label}: invalid timestamp`);
  }
}

async function regularBytes(file: string, label: string, { singleLink = false } = {}) {
  let stat: Stats;
  try { stat = await fs.lstat(file); } catch { fail(`${label}: missing`); }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0
      || (singleLink && stat.nlink !== 1)) {
    fail(`${label}: protected regular file required`);
  }
  return fs.readFile(file);
}

async function regularJson<Value = unknown>(
  file: string,
  label: string,
): Promise<{ bytes: Buffer; value: Value }> {
  const bytes = await regularBytes(file, label);
  try { return { bytes, value: JSON.parse(bytes.toString('utf8')) as Value }; }
  catch { return fail(`${label}: invalid JSON`); }
}

async function trustedDirectory(dir: string, label: string): Promise<void> {
  let stat: Stats;
  try { stat = await fs.lstat(dir); } catch { fail(`${label}: missing`); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) {
    fail(`${label}: protected directory required`);
  }
}

async function checkedJson<Value = unknown>(
  file: string,
  checksumFile: string,
  label: string,
): Promise<Value> {
  const [{ bytes, value }, checksumBytes] = await Promise.all([
    regularJson<Value>(file, label),
    regularBytes(checksumFile, `${label} checksum`),
  ]);
  const expected = checksumBytes.toString('utf8');
  if (!/^[a-f0-9]{64}\n$/.test(expected)) fail(`${label}: invalid checksum`);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected.trim()) fail(`${label}: checksum mismatch`);
  return value;
}

async function contentAddressedJson<Value = unknown>(
  dir: string,
  prefix: string,
  { required = true } = {},
): Promise<Value | null> {
  let entries: Dirent[];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch { fail(`${prefix}: attempt directory unavailable`); }
  const re = new RegExp(`^${prefix}\\.([a-f0-9]{64})\\.json$`);
  const matches = entries.filter((entry) => entry.name.startsWith(`${prefix}.`)
    && entry.name.endsWith('.json'));
  if (matches.length === 0 && !required) return null;
  const entry = matches.length === 1 ? matches[0] : null;
  if (!entry) fail(`${prefix}: expected exactly one content-addressed file`);
  if (!entry.isFile() || entry.isSymbolicLink()) fail(`${prefix}: regular file required`);
  const parsedName = re.exec(entry.name);
  if (!parsedName) fail(`${prefix}: invalid content-addressed filename`);
  const expected = parsedName[1];
  const { bytes, value } = await regularJson<Value>(path.join(dir, entry.name), prefix);
  if (createHash('sha256').update(bytes).digest('hex') !== expected) {
    fail(`${prefix}: content hash mismatch`);
  }
  return value;
}

function validateAttempt(value: AttemptRecord, task: string, attempt: string) {
  const baseKeys = [
    'schema', 'protocolVersion', 'attemptId', 'taskId', 'profile', 'createdAt',
    'routesDir', 'catalogHash', 'origin', 'previousAttemptId', 'recoveryReason',
  ];
  if (value?.schema === 1) exactKeys(value, baseKeys, 'attempt');
  else if (value?.schema === 2) {
    exactKeys(value, [...baseKeys, 'queueDispatchId', 'runnerPrimaryOverride'], 'attempt');
  } else fail('attempt: unexpected schema');
  if (value.protocolVersion !== 2
      || value.taskId !== task || value.attemptId !== attempt
      || !PROFILE_RE.test(value.profile || '') || !HASH_RE.test(value.catalogHash || '')
      || typeof value.routesDir !== 'string' || !path.isAbsolute(value.routesDir)
      || /[\n\t]/.test(value.routesDir)) {
    fail('attempt: identity mismatch');
  }
  exactTimestamp(value.createdAt, 'attempt');
  if (value.origin === 'fresh') {
    if (value.previousAttemptId !== null || value.recoveryReason !== null) {
      fail('attempt: invalid fresh origin');
    }
  } else if (value.origin === 'recovery') {
    if (!ATTEMPT_RE.test(value.previousAttemptId || '') || value.previousAttemptId === attempt
        || typeof value.recoveryReason !== 'string' || value.recoveryReason.length < 1
        || value.recoveryReason.length > 500 || /[\u0000-\u001f\u007f]/.test(value.recoveryReason)) {
      fail('attempt: invalid recovery origin');
    }
    if (value.schema === 2 && value.queueDispatchId !== null) {
      fail('attempt: recovery cannot inherit queue dispatch');
    }
  } else {
    fail('attempt: invalid origin');
  }
  if (value.schema === 2
      && (value.queueDispatchId !== null && !DISPATCH_ID_RE.test(value.queueDispatchId || '')
        || typeof value.runnerPrimaryOverride !== 'string'
        || (value.runnerPrimaryOverride !== '' && !RUNNER_RE.test(value.runnerPrimaryOverride)))) {
    fail('attempt: invalid launch provenance');
  }
  return {
    schema: value.schema,
    queueDispatchId: value.schema === 2 ? value.queueDispatchId : null,
    runnerPrimaryOverride: value.schema === 2 ? value.runnerPrimaryOverride : null,
  };
}

function validatePins(value: PinsRecord, attemptState: AttemptRecord): void {
  exactKeys(value, [
    'schema', 'protocolVersion', 'attemptId', 'taskId', 'profile', 'catalogHash', 'bootstrap',
  ], 'pins');
  exactKeys(value.bootstrap, ['id', 'catalogHash'], 'pins bootstrap');
  if (value.schema !== 1 || value.protocolVersion !== 2
      || value.attemptId !== attemptState.attemptId || value.taskId !== attemptState.taskId
      || value.profile !== attemptState.profile || value.catalogHash !== attemptState.catalogHash
      || value.bootstrap?.id !== 'scout'
      || value.bootstrap?.catalogHash !== attemptState.catalogHash) {
    fail('pins: identity mismatch');
  }
}

function validateRoutePin(value: RoutePinRecord | null, attemptState: AttemptRecord): RoutePinRecord {
  exactKeys(value, [
    'schema', 'protocolVersion', 'attemptId', 'taskId', 'profile',
    'catalogHash', 'routeId', 'routeHash', 'selectedAt',
  ], 'route pin');
  if (value?.schema !== 1 || value.protocolVersion !== 2
      || value.attemptId !== attemptState.attemptId || value.taskId !== attemptState.taskId
      || value.profile !== attemptState.profile || value.catalogHash !== attemptState.catalogHash
      || !ROUTE_RE.test(value.routeId || '') || value.routeId === 'catalog'
      || !HASH_RE.test(value.routeHash || '')) {
    fail('route pin: identity mismatch');
  }
  exactTimestamp(value?.selectedAt, 'route pin');

  return value ?? {};
}

// Границы terminal-причины ОБЯЗАНЫ совпадать с движком (`reason()` в
// engine/lib/attempt-state.sh): до 20 000 символов, перевод строки разрешён, прочие
// управляющие запрещены. Здесь стояло 500 без переносов — ридер не догнали, когда
// движку ослабили лимит ради многострочных замечаний человека. Расхождение не даёт
// ошибку при записи: `factory abandon` принимает длинную причину и отвечает успехом,
// а потом кокпит не может прочитать СВОЮ ЖЕ попытку — `attempt_integrity_failed`,
// карточка не закрывается кнопкой и висит на экране навсегда. Ловится только живым
// прогоном: тесты писали короткие причины.
const TERMINAL_REASON_LIMIT = 20000;

function validateTerminal(value: TerminalRecord, task: string, attempt: string): void {
  exactKeys(value, [
    'schema', 'protocolVersion', 'attemptId', 'taskId', 'state', 'closedAt', 'reason',
  ], 'terminal');
  if (value.schema !== 1 || value.protocolVersion !== 2
      || value.attemptId !== attempt || value.taskId !== task
      || !['finished', 'abandoned'].includes(String(value.state))) {
    fail('terminal: identity mismatch');
  }
  exactTimestamp(value.closedAt, 'terminal');
  if (value.state === 'finished') {
    if (value.reason !== null) fail('terminal: finished reason must be null');
  } else if (typeof value.reason !== 'string' || value.reason.length < 1
      || value.reason.length > TERMINAL_REASON_LIMIT
      || /[\u0000-\u0009\u000b-\u001f\u007f]/.test(value.reason)) {
    fail('terminal: invalid abandon reason');
  }
}

function parseProfileContract(text: string): TrustedProfileContract {
  const singleton = new Map<string, string>();
  const repositories: ContractRepository[] = [];
  const resources: string[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const fields = line.split('\t');
    const key = fields.shift() ?? '';
    if (key === 'repo') {
      // Три поля — манифест, записанный до пина ветки на репозиторий: ветка там
      // общая и лежит в singleton source-branch. Такие попытки уже завершены, но
      // журнал читается и по ним, поэтому форма остаётся допустимой.
      if (fields.length !== 3 && fields.length !== 4) fail('profile contract: invalid repo');
      repositories.push({
        name: fields[0] ?? '',
        source: fields[1] ?? '',
        workspace: fields[2] ?? '',
        branch: fields[3] ?? null,
      });
    } else if (key === 'exclusive-resource') {
      const resource = fields.length === 1 ? fields[0] : '';
      if (!resource) fail('profile contract: invalid resource');
      resources.push(resource);
    } else {
      const single = fields.length === 1 ? fields[0] : undefined;
      if (single === undefined || singleton.has(key)) fail('profile contract: duplicate field');
      singleton.set(key, single);
    }
  }
  const required = [
    'schema', 'repos-mode', 'workspace-mode', 'stand-ownership', 'source-branch',
    'container', 'service-host',
  ];
  const workspaceMode = singleton.get('workspace-mode') ?? '';
  if (workspaceMode === 'shared') required.push('frontend-port', 'api-port');
  if ([...singleton.keys()].sort().join('\0') !== required.sort().join('\0')
      || singleton.get('schema') !== '1' || singleton.get('repos-mode') !== 'generic'
      || repositories.length === 0) {
    fail('profile contract: unexpected schema');
  }
  const standOwnership = singleton.get('stand-ownership') ?? '';
  const sourceBranch = singleton.get('source-branch') ?? '';
  const frontendPort = singleton.get('frontend-port') || null;
  const apiPort = singleton.get('api-port') || null;
  if (!['isolated', 'shared'].includes(workspaceMode)
      || (workspaceMode === 'shared' ? standOwnership !== 'external' : standOwnership !== 'task')
      || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/.test(sourceBranch || '')
      || sourceBranch.includes('..')
      || (workspaceMode === 'shared' && (
        !/^[1-9][0-9]{3,4}$/.test(frontendPort || '') || Number(frontendPort) > 65535
        || !/^[1-9][0-9]{3,4}$/.test(apiPort || '') || Number(apiPort) > 65535
      ))) {
    fail('profile contract: invalid lifecycle ownership');
  }
  const names = new Set();
  for (const repo of repositories) {
    // У манифеста старой формы своей ветки нет — там она общая, из source-branch.
    if (repo.branch === null) repo.branch = sourceBranch;
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(repo.name) || names.has(repo.name)
        || !path.isAbsolute(repo.source) || !path.isAbsolute(repo.workspace)
        || /[\n\t]/.test(repo.source) || /[\n\t]/.test(repo.workspace)
        || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/.test(repo.branch)
        || repo.branch.includes('..')) {
      fail('profile contract: invalid repository topology');
    }
    if (workspaceMode === 'shared' && repo.source !== repo.workspace) {
      fail('profile contract: shared source/workspace mismatch');
    }
    // В isolated ветка — имя вновь создаваемой ветки задачи, одной на всю попытку.
    if (workspaceMode !== 'shared' && repo.branch !== sourceBranch) {
      fail('profile contract: isolated attempt pins more than one branch');
    }
    names.add(repo.name);
  }
  return {
    workspaceMode,
    standOwnership,
    sourceBranch,
    container: singleton.get('container') ?? '',
    serviceHost: singleton.get('service-host') ?? '',
    frontendPort,
    apiPort,
    repositories,
    resources,
  };
}

function projectionTerminal(result: unknown): 'completed' | 'abandoned' | null {
  if (result === 'completed' || result === 'abandoned') return result;
  return null;
}

// Каноническая форма runtime-проекции журнала этапов: json.dumps(sort_keys,
// separators=(",",":"), ensure_ascii=False) + "\n" — байт в байт как digest_value
// движка (engine/lib/attempt-stage-state.sh). Чисел с плавающей точкой в схеме нет,
// поэтому JSON.stringify за терминал достаточно.
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const record = value as Record<string, unknown>;

  return `{${Object.keys(record).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

// Конверт runtime.json: контрольная сумма отдельно от самого курсора.
interface StageRuntimeCursorRecord {
  currentNode?: string | null;
  lastCommit?: unknown;
  pauseReason?: string | null;
  state?: string;
  stop?: string | null;
}

interface StageRuntimeRecord {
  schema?: number;
  protocolVersion?: number;
  taskId?: string;
  attemptId?: string;
  profile?: string;
  catalogHash?: string;
  route?: string;
  routeHash?: string;
  entry?: string;
  sequence?: number;
  headEventHash?: string;
  cursor?: StageRuntimeCursorRecord;
}

interface StageRuntimeEnvelope {
  checksum?: string;
  runtime?: StageRuntimeRecord;
}

const NODE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const CURSOR_STOP_TARGETS = new Set(['human', 'failed', 'done', 'rewind-limit', 'no-progress']);

function validCursorReason(value: unknown): boolean {
  return typeof value === 'string' && value.length >= 1 && value.length <= 500
    && ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}

/**
 * Курсор журнала этапов (stage-results/runtime.json): где маршрут реально стоит.
 * Это единственный проверяемый источник «ждут ли ворота решения»: реестровая
 * проекция может опережать журнал (статус узла записан, а коммит ещё не лёг).
 * Отсутствие файла — норма для молодой попытки до инициализации курсора (null);
 * битый конверт/контрольная сумма — порча trusted ledger и fail-closed.
 */
function validateStageRuntime(
  envelope: StageRuntimeEnvelope,
  task: string,
  attempt: string,
): StageCursor {
  exactKeys(envelope, ['checksum', 'runtime'], 'stage runtime');
  if (!HASH_RE.test(envelope.checksum || '')) fail('stage runtime: invalid checksum');
  const actual = createHash('sha256')
    .update(`${canonicalJson(envelope.runtime)}\n`, 'utf8')
    .digest('hex');
  if (actual !== envelope.checksum) fail('stage runtime: checksum mismatch');
  const runtime = envelope.runtime ?? {};
  exactKeys(runtime, [
    'schema', 'protocolVersion', 'taskId', 'attemptId', 'profile', 'catalogHash',
    'route', 'routeHash', 'entry', 'sequence', 'headEventHash', 'cursor',
  ], 'stage runtime');
  if (runtime.schema !== 1 || runtime.protocolVersion !== 2
      || runtime.taskId !== task || runtime.attemptId !== attempt
      || !PROFILE_RE.test(runtime.profile || '') || !HASH_RE.test(runtime.catalogHash || '')
      || !ROUTE_RE.test(runtime.route || '') || !HASH_RE.test(runtime.routeHash || '')
      || !NODE_ID_RE.test(runtime.entry || '')
      || !Number.isSafeInteger(runtime.sequence) || (runtime.sequence ?? -1) < 0
      || !HASH_RE.test(runtime.headEventHash || '')) {
    fail('stage runtime: identity mismatch');
  }
  const cursor = runtime.cursor ?? {};
  exactKeys(cursor, ['currentNode', 'lastCommit', 'pauseReason', 'state', 'stop'], 'stage runtime cursor');
  const executableNode = NODE_ID_RE.test(cursor.currentNode || '');
  const validState = cursor.state === 'ready'
    ? executableNode && cursor.stop === null && cursor.pauseReason === null
    : cursor.state === 'paused'
      ? executableNode && cursor.stop === null && validCursorReason(cursor.pauseReason)
      : cursor.state === 'stopped'
        ? cursor.currentNode === null && cursor.pauseReason === null
          && CURSOR_STOP_TARGETS.has(String(cursor.stop))
        : false;
  if (!validState) {
    fail('stage runtime cursor: identity mismatch');
  }
  return {
    node: cursor.currentNode ?? null,
    state: cursor.state ?? '',
    stop: cursor.stop ?? null,
    pauseReason: cursor.pauseReason ?? null,
  };
}

/**
 * Read and verify the engine-owned attempt ledger. Provider-writable `.pipeline`
 * is accepted only as a projection whose pinned identity and terminal class match.
 */
export async function readFactoryAttemptLedger({ controlDir, stateDir, task, registry }: {
  controlDir?: string;
  stateDir?: string;
  task: string | number;
  registry?: Record<string, string | undefined> | null;
}) {
  task = String(task);
  if (!TASK_RE.test(task) || !controlDir || !path.isAbsolute(controlDir)) {
    fail('trusted ledger is not configured');
  }
  if (!registry || registry.CATALOG_PROTOCOL !== 'route-v2'
      || !ATTEMPT_RE.test(registry.ATTEMPT_ID || '')
      || !PROFILE_RE.test(registry.PROFILE || '')
      || !ROUTE_RE.test(registry.ROUTE || '') || registry.ROUTE === 'catalog'
      || !HASH_RE.test(registry.ROUTE_HASH || '')) {
    fail('pipeline projection has no pinned route identity');
  }

  const attempt = registry.ATTEMPT_ID ?? '';
  const canonicalControl = await fs.realpath(controlDir).catch(() => fail('control root: missing'));
  if (canonicalControl !== path.resolve(controlDir)) fail('control root: non-canonical path');
  if (stateDir) {
    const canonicalState = await fs.realpath(stateDir).catch(() => fail('state root: missing'));
    const nested = (parent: string, child: string) => (
      child === parent || child.startsWith(`${parent}${path.sep}`)
    );
    if (nested(canonicalControl, canonicalState) || nested(canonicalState, canonicalControl)) {
      fail('trusted control and provider-writable state overlap');
    }
  }
  const taskRoot = path.join(controlDir, 'protocol-v2', 'tasks', `t${task}`);
  const attemptDir = path.join(taskRoot, 'attempts', attempt);
  for (const [dir, label] of [
    [controlDir, 'control root'],
    [path.join(controlDir, 'protocol-v2'), 'protocol root'],
    [path.join(controlDir, 'protocol-v2', 'tasks'), 'tasks root'],
    [taskRoot, 'task ledger'],
    [path.join(taskRoot, 'attempts'), 'attempts root'],
    [attemptDir, 'attempt ledger'],
    [path.join(attemptDir, 'artifacts'), 'attempt artifacts'],
  ] as const) await trustedDirectory(dir, label);

  const { value: protocol } = await regularJson<{ schema?: number; protocolVersion?: number }>(
    path.join(taskRoot, 'protocol.json'),
    'protocol',
  );
  exactKeys(protocol, ['schema', 'protocolVersion'], 'protocol');
  if (protocol.schema !== 1 || protocol.protocolVersion !== 2) fail('protocol: incompatible');

  const attemptState = await checkedJson<AttemptRecord>(
    path.join(attemptDir, 'attempt.json'),
    path.join(attemptDir, 'attempt.sha256'),
    'attempt',
  );
  const launchProvenance = validateAttempt(attemptState, task, attempt);
  const pins = await checkedJson<PinsRecord>(
    path.join(attemptDir, 'pins.json'),
    path.join(attemptDir, 'pins.sha256'),
    'pins',
  );
  validatePins(pins, attemptState);

  const routePin = validateRoutePin(
    await contentAddressedJson<RoutePinRecord>(attemptDir, 'route-pin'),
    attemptState,
  );
  const terminalRecord = await contentAddressedJson<TerminalRecord>(
    attemptDir,
    'terminal',
    { required: false },
  );
  if (terminalRecord) validateTerminal(terminalRecord, task, attempt);
  const terminal = terminalRecord?.state === 'finished'
    ? 'completed'
    : (terminalRecord?.state === 'abandoned' ? 'abandoned' : null);

  let active: string | null = null;
  try {
    const { value } = await regularJson<{
      schema?: number;
      protocolVersion?: number;
      taskId?: string;
      attemptId?: string;
    }>(path.join(taskRoot, 'active-attempt.json'), 'active attempt');
    exactKeys(value, ['schema', 'protocolVersion', 'taskId', 'attemptId'], 'active attempt');
    if (value.schema !== 1 || value.protocolVersion !== 2 || value.taskId !== task
        || !ATTEMPT_RE.test(value.attemptId || '')) fail('active attempt: identity mismatch');
    active = value.attemptId ?? null;
  } catch (err) {
    if (!(err instanceof FactoryLedgerIntegrityError) || err.message !== 'active attempt: missing') throw err;
  }
  if ((active && active !== attempt) || (!terminal && active !== attempt)) {
    fail('pipeline projection does not name the active exact attempt');
  }

  const contractBytes = await regularBytes(
    path.join(attemptDir, 'artifacts', 'profile-contract.tsv'),
    'profile contract',
    { singleLink: true },
  );
  const contract = parseProfileContract(contractBytes.toString('utf8'));

  // Курсор — проекция журнала этапов. Молодая попытка до инициализации курсора
  // файла ещё не имеет: null, а не отказ — иначе вновь запущенная задача на
  // минуты стала бы read-only.
  let cursor: StageCursor | null = null;
  const stageResultsDir = path.join(attemptDir, 'stage-results');
  if (await fs.lstat(stageResultsDir).then(
    (stat) => stat.isDirectory() && !stat.isSymbolicLink(),
    () => false,
  )) {
    await trustedDirectory(stageResultsDir, 'stage results');
    const runtimeFile = path.join(stageResultsDir, 'runtime.json');
    if (await fs.lstat(runtimeFile).then(() => true, () => false)) {
      const { value } = await regularJson<StageRuntimeEnvelope>(runtimeFile, 'stage runtime');
      cursor = validateStageRuntime(value, task, attempt);
    }
  }

  const projectedTerminal = projectionTerminal(registry.RESULT);
  // terminal.*.json — надёжный источник истины; он фиксируется раньше доступной
  // провайдеру для записи проекции реестра. Сбой в этом окне может оставить RESULT
  // нетерминальным. Обратный случай всегда небезопасен: без доверенной терминальной
  // записи терминальная проекция не доказана, а конфликтующая проекция обязана дать отказ.
  const terminalProjectionDisagrees = terminal === null
    ? projectedTerminal !== null
    : projectedTerminal !== null && projectedTerminal !== terminal;
  if (registry.PROFILE !== attemptState.profile || registry.ROUTE !== routePin.routeId
      || registry.ROUTE_HASH !== routePin.routeHash || terminalProjectionDisagrees) {
    fail('pipeline projection disagrees with trusted attempt ledger');
  }
  if (launchProvenance.schema === 2
      && (registry.CATALOG_HASH !== attemptState.catalogHash
        || (registry.QUEUE_DISPATCH_ID || null) !== launchProvenance.queueDispatchId
        || (registry.RUNNER_OVERRIDE_PRIMARY || '') !== launchProvenance.runnerPrimaryOverride)) {
    fail('pipeline projection disagrees with trusted launch provenance');
  }

  return {
    task,
    attempt,
    createdAt: attemptState.createdAt,
    profile: attemptState.profile,
    catalogHash: attemptState.catalogHash,
    origin: attemptState.origin,
    previousAttemptId: attemptState.previousAttemptId,
    queueDispatchId: launchProvenance.queueDispatchId,
    runnerPrimaryOverride: launchProvenance.runnerPrimaryOverride,
    route: routePin.routeId,
    routeHash: routePin.routeHash,
    terminal,
    terminalRecord,
    cursor,
    ...contract,
  };
}

/** Exact mutable env projection check against the immutable profile contract. */
export function verifyFactoryAttemptEnvironment(
  trusted: TrustedProfileContract | null | undefined,
  env: Record<string, string | undefined> | null | undefined,
): boolean {
  if (!trusted || !env || env.WORKSPACE_MODE !== trusted.workspaceMode
      || env.STAND_OWNERSHIP !== trusted.standOwnership
      || env.SOURCE_BRANCH !== trusted.sourceBranch
      || env.REPO_COUNT !== String(trusted.repositories.length)
      || (trusted.workspaceMode === 'shared' && (
        env.FE_PORT !== trusted.frontendPort || env.API_PORT !== trusted.apiPort
      ))) {
    fail('sandbox env disagrees with trusted profile contract');
  }
  const expectedRepoKeys = new Set(['REPO_COUNT']);
  for (let index = 0; index < trusted.repositories.length; index += 1) {
    const repo = trusted.repositories[index];
    for (const field of ['NAME', 'SOURCE', 'WT', 'BRANCH']) {
      expectedRepoKeys.add(`REPO_${index}_${field}`);
    }
    if (env[`REPO_${index}_NAME`] !== repo?.name
        || env[`REPO_${index}_SOURCE`] !== repo?.source
        || env[`REPO_${index}_WT`] !== repo?.workspace
        || env[`REPO_${index}_BRANCH`] !== repo?.branch) {
      fail('sandbox env repository topology disagrees with trusted profile contract');
    }
  }
  for (const key of Object.keys(env)) {
    if (key.startsWith('REPO_') && !expectedRepoKeys.has(key)) {
      fail('sandbox env contains an untrusted repository entry');
    }
  }
  return true;
}

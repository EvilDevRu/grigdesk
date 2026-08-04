import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const ATTEMPT_RE = /^a_[a-f0-9]{32}$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const PROFILE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ROUTE_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const TASK_RE = /^[1-9][0-9]{0,18}$/;
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export class FactoryLedgerIntegrityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FactoryLedgerIntegrityError';
  }
}

function fail(message) {
  throw new FactoryLedgerIntegrityError(message);
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
    fail(`${label}: unexpected schema`);
  }
}

function exactTimestamp(value, label) {
  const parsed = typeof value === 'string' && TIME_RE.test(value) ? new Date(value) : null;
  if (!parsed || Number.isNaN(parsed.valueOf())
      || parsed.toISOString().replace('.000Z', 'Z') !== value) {
    fail(`${label}: invalid timestamp`);
  }
}

async function regularBytes(file, label, { singleLink = false } = {}) {
  let stat;
  try { stat = await fs.lstat(file); } catch { fail(`${label}: missing`); }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0
      || (singleLink && stat.nlink !== 1)) {
    fail(`${label}: protected regular file required`);
  }
  return fs.readFile(file);
}

async function regularJson(file, label) {
  const bytes = await regularBytes(file, label);
  try { return { bytes, value: JSON.parse(bytes.toString('utf8')) }; }
  catch { return fail(`${label}: invalid JSON`); }
}

async function trustedDirectory(dir, label) {
  let stat;
  try { stat = await fs.lstat(dir); } catch { fail(`${label}: missing`); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) {
    fail(`${label}: protected directory required`);
  }
}

async function checkedJson(file, checksumFile, label) {
  const [{ bytes, value }, checksumBytes] = await Promise.all([
    regularJson(file, label),
    regularBytes(checksumFile, `${label} checksum`),
  ]);
  const expected = checksumBytes.toString('utf8');
  if (!/^[a-f0-9]{64}\n$/.test(expected)) fail(`${label}: invalid checksum`);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected.trim()) fail(`${label}: checksum mismatch`);
  return value;
}

async function contentAddressedJson(dir, prefix, { required = true } = {}) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch { fail(`${prefix}: attempt directory unavailable`); }
  const re = new RegExp(`^${prefix}\\.([a-f0-9]{64})\\.json$`);
  const matches = entries.filter((entry) => entry.name.startsWith(`${prefix}.`)
    && entry.name.endsWith('.json'));
  if (matches.length === 0 && !required) return null;
  if (matches.length !== 1) fail(`${prefix}: expected exactly one content-addressed file`);
  const entry = matches[0];
  if (!entry.isFile() || entry.isSymbolicLink()) fail(`${prefix}: regular file required`);
  const parsedName = re.exec(entry.name);
  if (!parsedName) fail(`${prefix}: invalid content-addressed filename`);
  const expected = parsedName[1];
  const { bytes, value } = await regularJson(path.join(dir, entry.name), prefix);
  if (createHash('sha256').update(bytes).digest('hex') !== expected) {
    fail(`${prefix}: content hash mismatch`);
  }
  return value;
}

function validateAttempt(value, task, attempt) {
  exactKeys(value, [
    'schema', 'protocolVersion', 'attemptId', 'taskId', 'profile', 'createdAt',
    'routesDir', 'catalogHash', 'origin', 'previousAttemptId', 'recoveryReason',
  ], 'attempt');
  if (value.schema !== 1 || value.protocolVersion !== 2
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
  } else {
    fail('attempt: invalid origin');
  }
}

function validatePins(value, attemptState) {
  exactKeys(value, [
    'schema', 'protocolVersion', 'attemptId', 'taskId', 'profile', 'catalogHash', 'bootstrap',
  ], 'pins');
  exactKeys(value.bootstrap, ['id', 'catalogHash'], 'pins bootstrap');
  if (value.schema !== 1 || value.protocolVersion !== 2
      || value.attemptId !== attemptState.attemptId || value.taskId !== attemptState.taskId
      || value.profile !== attemptState.profile || value.catalogHash !== attemptState.catalogHash
      || value.bootstrap.id !== 'scout' || value.bootstrap.catalogHash !== attemptState.catalogHash) {
    fail('pins: identity mismatch');
  }
}

function validateRoutePin(value, attemptState) {
  exactKeys(value, [
    'schema', 'protocolVersion', 'attemptId', 'taskId', 'profile',
    'catalogHash', 'routeId', 'routeHash', 'selectedAt',
  ], 'route pin');
  if (value.schema !== 1 || value.protocolVersion !== 2
      || value.attemptId !== attemptState.attemptId || value.taskId !== attemptState.taskId
      || value.profile !== attemptState.profile || value.catalogHash !== attemptState.catalogHash
      || !ROUTE_RE.test(value.routeId || '') || value.routeId === 'catalog'
      || !HASH_RE.test(value.routeHash || '')) {
    fail('route pin: identity mismatch');
  }
  exactTimestamp(value.selectedAt, 'route pin');
}

function validateTerminal(value, task, attempt) {
  exactKeys(value, [
    'schema', 'protocolVersion', 'attemptId', 'taskId', 'state', 'closedAt', 'reason',
  ], 'terminal');
  if (value.schema !== 1 || value.protocolVersion !== 2
      || value.attemptId !== attempt || value.taskId !== task
      || !['finished', 'abandoned'].includes(value.state)) {
    fail('terminal: identity mismatch');
  }
  exactTimestamp(value.closedAt, 'terminal');
  if (value.state === 'finished') {
    if (value.reason !== null) fail('terminal: finished reason must be null');
  } else if (typeof value.reason !== 'string' || value.reason.length < 1
      || value.reason.length > 500 || /[\u0000-\u001f\u007f]/.test(value.reason)) {
    fail('terminal: invalid abandon reason');
  }
}

function parseProfileContract(text) {
  const singleton = new Map();
  const repositories = [];
  const resources = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const fields = line.split('\t');
    const key = fields.shift();
    if (key === 'repo') {
      // Три поля — манифест, записанный до пина ветки на репозиторий: ветка там
      // общая и лежит в singleton source-branch. Такие попытки уже завершены, но
      // журнал читается и по ним, поэтому форма остаётся допустимой.
      if (fields.length !== 3 && fields.length !== 4) fail('profile contract: invalid repo');
      repositories.push({
        name: fields[0], source: fields[1], workspace: fields[2], branch: fields[3] ?? null,
      });
    } else if (key === 'exclusive-resource') {
      if (fields.length !== 1 || !fields[0]) fail('profile contract: invalid resource');
      resources.push(fields[0]);
    } else {
      if (fields.length !== 1 || singleton.has(key)) fail('profile contract: duplicate field');
      singleton.set(key, fields[0]);
    }
  }
  const required = [
    'schema', 'repos-mode', 'workspace-mode', 'stand-ownership', 'source-branch',
    'container', 'service-host',
  ];
  const workspaceMode = singleton.get('workspace-mode');
  if (workspaceMode === 'shared') required.push('frontend-port', 'api-port');
  if ([...singleton.keys()].sort().join('\0') !== required.sort().join('\0')
      || singleton.get('schema') !== '1' || singleton.get('repos-mode') !== 'generic'
      || repositories.length === 0) {
    fail('profile contract: unexpected schema');
  }
  const standOwnership = singleton.get('stand-ownership');
  const sourceBranch = singleton.get('source-branch');
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
    container: singleton.get('container'),
    serviceHost: singleton.get('service-host'),
    frontendPort,
    apiPort,
    repositories,
    resources,
  };
}

function projectionTerminal(result) {
  if (result === 'completed' || result === 'abandoned') return result;
  return null;
}

/**
 * Read and verify the engine-owned attempt ledger. Provider-writable `.pipeline`
 * is accepted only as a projection whose pinned identity and terminal class match.
 */
export async function readFactoryAttemptLedger({ controlDir, stateDir, task, registry }) {
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

  const attempt = registry.ATTEMPT_ID;
  const canonicalControl = await fs.realpath(controlDir).catch(() => fail('control root: missing'));
  if (canonicalControl !== path.resolve(controlDir)) fail('control root: non-canonical path');
  if (stateDir) {
    const canonicalState = await fs.realpath(stateDir).catch(() => fail('state root: missing'));
    const nested = (parent, child) => child === parent || child.startsWith(`${parent}${path.sep}`);
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
  ]) await trustedDirectory(dir, label);

  const { value: protocol } = await regularJson(path.join(taskRoot, 'protocol.json'), 'protocol');
  exactKeys(protocol, ['schema', 'protocolVersion'], 'protocol');
  if (protocol.schema !== 1 || protocol.protocolVersion !== 2) fail('protocol: incompatible');

  const attemptState = await checkedJson(
    path.join(attemptDir, 'attempt.json'),
    path.join(attemptDir, 'attempt.sha256'),
    'attempt',
  );
  validateAttempt(attemptState, task, attempt);
  const pins = await checkedJson(
    path.join(attemptDir, 'pins.json'),
    path.join(attemptDir, 'pins.sha256'),
    'pins',
  );
  validatePins(pins, attemptState);

  const routePin = await contentAddressedJson(attemptDir, 'route-pin');
  validateRoutePin(routePin, attemptState);
  const terminalRecord = await contentAddressedJson(attemptDir, 'terminal', { required: false });
  if (terminalRecord) validateTerminal(terminalRecord, task, attempt);
  const terminal = terminalRecord?.state === 'finished'
    ? 'completed'
    : (terminalRecord?.state === 'abandoned' ? 'abandoned' : null);

  let active = null;
  try {
    const { value } = await regularJson(path.join(taskRoot, 'active-attempt.json'), 'active attempt');
    exactKeys(value, ['schema', 'protocolVersion', 'taskId', 'attemptId'], 'active attempt');
    if (value.schema !== 1 || value.protocolVersion !== 2 || value.taskId !== task
        || !ATTEMPT_RE.test(value.attemptId || '')) fail('active attempt: identity mismatch');
    active = value.attemptId;
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

  if (registry.PROFILE !== attemptState.profile || registry.ROUTE !== routePin.routeId
      || registry.ROUTE_HASH !== routePin.routeHash
      || projectionTerminal(registry.RESULT) !== terminal) {
    fail('pipeline projection disagrees with trusted attempt ledger');
  }

  return {
    task,
    attempt,
    profile: attemptState.profile,
    catalogHash: attemptState.catalogHash,
    route: routePin.routeId,
    routeHash: routePin.routeHash,
    terminal,
    terminalRecord,
    ...contract,
  };
}

/** Exact mutable env projection check against the immutable profile contract. */
export function verifyFactoryAttemptEnvironment(trusted, env) {
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
    if (env[`REPO_${index}_NAME`] !== repo.name
        || env[`REPO_${index}_SOURCE`] !== repo.source
        || env[`REPO_${index}_WT`] !== repo.workspace
        || env[`REPO_${index}_BRANCH`] !== repo.branch) {
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

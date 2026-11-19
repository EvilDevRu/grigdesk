import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { canonicalJson } from '../../../shared/lib/canonicalJson.ts';
import { readDarwinBootId, readDarwinFactoryOwnerState } from '../../../shared/node/processIdentity.ts';
import {
  FACTORY_TASK_ID, type FactoryCleanupAction, type FactoryOwnershipRow, type FactoryOwnershipSnapshot,
} from '../../../shared/runtime/factoryOwnership.ts';

import { readDarwinLaunchRecords, type DarwinLaunchRecord } from './factoryDarwinLaunch.ts';
import { hasPendingDarwinProfileChannel } from './factoryDarwinChannelState.ts';
import { verifyDarwinOwnershipRoots, type OwnershipPaths } from './factoryDarwinOwnershipRoots.ts';
import { readDarwinRunnerBinding, readDarwinControlText, hasDarwinRunnerMarker, matchesDarwinRunnerScope }
  from './factoryDarwinRunnerState.ts';
import type { DarwinRunnerBinding } from './factoryDarwinRunnerState.ts';
import { inspectDarwinSession } from './factoryDarwinSessions.ts';
import { parsePipeline } from './pipelineParse.ts';
import { darwinProviderFile, readDarwinExternalProviders } from './providerInstall/darwinExternalProvider.ts';

export interface FactoryAdmissionSnapshot {
  generation: number;
  tasks: string[];
}

interface TaskInventory {
  registries: [string, string][];
  archives: [string, string][];
  launches: DarwinLaunchRecord[];
  runners: [string, string][];
  providers: [string, string][];
  finalizations: [string, string][];
  transactions: [string, string][];
  channels: [string, string][];
  admission: FactoryAdmissionSnapshot;
}

const taskNames = {
  registry: /^t([1-9][0-9]{0,18})\.pipeline$/u,
  runner: /^t([1-9][0-9]{0,18})\.active(?:\.(?:pending|scope))?$/u,
  finalization: /^t([1-9][0-9]{0,18})\.json$/u,
  transaction: /^t([1-9][0-9]{0,18})$/u,
  channel: /^t([1-9][0-9]{0,18})$/u,
  provider: darwinProviderFile,
};
const transactionName = 'v2-[a-f0-9]{32}-s(?:0|[1-9][0-9]{0,17})';
const transactionProof = new RegExp(
  `^(${transactionName})\\.(begin-intent|begin-committed|not-started|retirement-confirmed)\\.json$`, 'u');
const txidPattern = new RegExp(`^${transactionName}$`, 'u');
const transactionPointer = new RegExp(`^SCHEMA=1\\nTRANSACTION_ID=(${transactionName})\\n$`, 'u');
const digestPattern = /^[a-f0-9]{64}$/u;

/**
 * Ошибка обхода не превращается в пустой список.
 * В выделенном каталоге ownership любой неожиданный элемент делает снимок неполным.
 */
async function inventoryFileIds(directory: string, kind: keyof typeof taskNames) {
  const ids: [string, string][] = [];
  const directoryEntry = kind === 'transaction' || kind === 'channel';

  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const id = taskNames[kind].exec(entry.name)?.[1];

    if (kind === 'provider' && /^\.write-[a-f0-9-]{36}$/u.test(entry.name) && entry.isFile()) {
      continue;
    }

    if (!id && kind === 'registry' && !/^t[0-9]+\.pipeline$/u.test(entry.name)) {
      continue;
    }

    if (!id || (directoryEntry ? !entry.isDirectory() : !entry.isFile())) {
      throw new Error('factory_ownership_entry_invalid');
    }

    const stat = await fs.lstat(path.join(directory, entry.name), { bigint: true });

    const validType = directoryEntry
      ? stat.isDirectory() && (stat.mode & 0o022n) === 0n : stat.isFile() && stat.nlink === 1n;

    if (!validType || stat.uid !== BigInt(process.getuid!())) {
      throw new Error('factory_ownership_entry_invalid');
    }

    const generation = [entry.name, stat.dev, stat.ino, stat.ctimeNs, stat.mtimeNs, stat.size].join(':');

    ids.push([id, generation]);
  }

  return ids.sort(([a, left], [b, right]) => a.localeCompare(b) || left.localeCompare(right));
}

/**
 * Читает физические проекции, записи launch и состояние допусков одной инкарнации.
 * Перед следующим обходом уже увиденные ID остаются в памяти инвентаризации.
 */
async function taskInventory(paths: OwnershipPaths, admission: () => FactoryAdmissionSnapshot)
  : Promise<TaskInventory> {
  await verifyDarwinOwnershipRoots(paths);

  const [registries, archives, launches, runners, providers, finalizations, transactions, channels] = await Promise.all([
    inventoryFileIds(paths.stateDir, 'registry'),
    inventoryFileIds(path.join(paths.stateDir, 'archive'), 'registry'),
    readDarwinLaunchRecords(paths.factoryControlDir),
    inventoryFileIds(path.join(paths.factoryControlDir, 'runner-processes'), 'runner'),
    inventoryFileIds(path.join(paths.factoryControlDir, 'external-provider-processes'), 'provider'),
    inventoryFileIds(path.join(paths.factoryControlDir, 'transaction-finalization'), 'finalization'),
    inventoryFileIds(path.join(paths.factoryControlDir, 'transactions'), 'transaction'),
    inventoryFileIds(path.join(paths.factoryControlDir, 'profile-channels'), 'channel'),
  ]);
  const pending = admission();

  if (pending.tasks.some((id) => !FACTORY_TASK_ID.test(id))) {
    throw new Error('factory_ownership_admission_invalid');
  }

  return {
    registries,
    archives,
    launches,
    runners,
    providers,
    finalizations,
    transactions,
    channels,
    admission: pending,
  };
}

/**
 * Проверяет отсутствие имени по проверенному родителю, не открывая отсутствующий
 * TX. Любая другая ошибка чтения не является доказательством завершения.
 */
async function activeTransaction(control: string, task: string, attempt: string): Promise<boolean> {
  let directory = control;

  for (const name of ['transactions', `t${task}`]) {
    directory = path.join(directory, name);

    const stat = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }

      return null;
    });

    if (!stat) {
      return false;
    }

    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0
      || await fs.realpath(directory) !== directory) {
      throw new Error('factory_transaction_root_invalid');
    }
  }

  const active = await readProjection(path.join(directory, 'active.env'), 16384);

  if (active !== null) {
    const id = transactionPointer.exec(active)?.[1];

    if (!id || `a_${id.slice(3, 35)}` !== attempt
      || await readProjection(path.join(directory, `${id}.begin-intent.json`), 16384) === null) {
      throw new Error('factory_transaction_pointer_invalid');
    }

    return true;
  }

  return hasPendingBegin(directory, task);
}

export interface DarwinTaskRuntime extends FactoryOwnershipRow {
  launch: DarwinLaunchRecord | null;
  binding: DarwinRunnerBinding | null;
  identity: { attempt: string; profile: string } | null;
}

type TrustedRegistry = (registry: Record<string, string>) => Promise<{
  terminal: string | null;
  attempt: string;
  profile: string;
} | null>;

/**
 * ENOENT в проверенной папке позволяет проверить архив. Все другие
 * ошибки содержимого оставляют ownership неизвестным.
 */
async function readProjection(file: string, limit: number): Promise<string | null> {
  try {
    return await readDarwinControlText(file, limit);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

/**
 * Читает причинную цепочку begin до active.env. Один not_started сохраняет
 * pending. Закрытие включает тот же SHA, состояние TX и отсутствие указателя.
 */
async function hasPendingBegin(directory: string, task: string): Promise<boolean> {
  const names = await fs.readdir(directory);
  const entries = new Set(names);

  for (const name of names) {
    const proof = transactionProof.exec(name);
    const txid = proof?.[1] ?? name;

    if (name.startsWith('v2-') && !entries.has(`${txid}.begin-intent.json`)) {
      throw new Error('factory_transaction_orphaned_proof');
    }
  }

  for (const name of names.filter((value) => value.endsWith('.begin-intent.json'))) {
    const txid = transactionProof.exec(name)?.[1];

    if (!txid) {
      throw new Error('factory_transaction_begin_invalid');
    }

    const intentText = await readDarwinControlText(path.join(directory, name));
    const intent = JSON.parse(intentText) as Record<string, unknown> | null;
    const hash = createHash('sha256').update(intentText).digest('hex');
    const proof = {
      format: 1,
      task,
      txid,
      intentSHA256: hash,
    };

    if (!intent || Object.keys(intent).sort().join(',')
      !== 'attempt,dispatch,format,identity,immutable,initialState,task,temporary,txid'
      || intent.format !== 1 || intent.task !== task || intent.txid !== txid
      || `a_${txid.slice(3, 35)}` !== intent.attempt || intent.dispatch !== 'not-released'
      || typeof intent.immutable !== 'string' || !digestPattern.test(intent.immutable)
      || typeof intent.initialState !== 'string' || !digestPattern.test(intent.initialState)
      || typeof intent.temporary !== 'string' || !/^\.tx\.[a-zA-Z0-9]{6}$/u.test(intent.temporary)
      || !Array.isArray(intent.identity) || intent.identity.length !== 2
      || !intent.identity.every((part) => Number.isInteger(part) && part > 0)) {
      throw new Error('factory_transaction_begin_invalid');
    }

    const commitName = txid + '.begin-committed.json';
    const retirementName = txid + '.retirement-confirmed.json';
    const [commit, retire] = await Promise.all([
      readProjection(path.join(directory, commitName), 16384),
      readProjection(path.join(directory, retirementName), 16384),
    ]);

    if (commit !== null) {
      if (retire !== null || entries.has(`${txid}.not-started.json`)
        || canonicalJson(JSON.parse(commit)) !== canonicalJson(proof)) {
        throw new Error('factory_transaction_begin_invalid');
      }

      const stat = await fs.lstat(path.join(directory, txid), { bigint: true });

      if (!stat.isDirectory() || stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o022n) !== 0n
        || Number(stat.dev) !== intent.identity[0] || Number(stat.ino) !== intent.identity[1]
        || !await isTransactionCompleted(path.join(directory, txid))) {
        return true;
      }

      continue;
    }

    if (retire === null) {
      return true;
    }

    const stopped = await readDarwinControlText(path.join(directory, txid + '.not-started.json'));
    const retired = {
      ...proof,
      notStartedSHA256: createHash('sha256').update(stopped).digest('hex'),
    };
    const tx = await fs.lstat(path.join(directory, txid)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }

      return null;
    });

    if (tx || canonicalJson(JSON.parse(stopped)) !== canonicalJson({ ...proof, state: 'not_started' })
      || canonicalJson(JSON.parse(retire)) !== canonicalJson(retired)) {
      throw new Error('factory_transaction_begin_invalid');
    }
  }

  return false;
}

/**
 * Terminal state считается точной записью только с каноническими полями
 * и номером checkpoint, который выпустил штатный writer.
 */
async function isTransactionCompleted(directory: string): Promise<boolean> {
  const state = await readDarwinControlText(path.join(directory, 'state.env'));
  const header = /^SCHEMA=1\nISOLATION=exclusive-(?:worktree|shared-checkout)-v1\n/u;
  const completed = /^STATE=completed\nCHECKPOINT=(?:0|[1-9][0-9]{0,17})\n/u;
  const digest = /^(?:INITIAL_EXPECTED_SHA256|CHECKPOINT_SHA256)=[a-f0-9]{64}\n$/u;
  const body = state.replace(header, '');

  return header.test(state) && completed.test(body) && digest.test(body.replace(completed, ''));
}

/**
 * Хеширует через один закреплённый FD, чтобы прочитать snapshot любого размера.
 * Замена имени или изменение данных в ходе чтения запрещают вывод о завершении.
 */
async function hashTransactionInput(directory: string, name: string): Promise<string> {
  if (await fs.realpath(directory) !== directory) {
    throw new Error('factory_transaction_root_invalid');
  }

  const file = path.join(directory, name);
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

  try {
    const before = await handle.stat({ bigint: true });

    if (!before.isFile() || before.uid !== BigInt(process.getuid!()) || before.nlink !== 1n
      || (before.mode & 0o022n) !== 0n) {
      throw new Error('factory_transaction_input_invalid');
    }

    const hash = createHash('sha256');

    for await (const bytes of handle.createReadStream({ autoClose: false })) {
      hash.update(bytes);
    }

    const current = await fs.lstat(file, { bigint: true });

    if (before.dev !== current.dev || before.ino !== current.ino || before.size !== current.size
      || before.ctimeNs !== current.ctimeNs || before.mtimeNs !== current.mtimeNs) {
      throw new Error('factory_transaction_input_changed');
    }

    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

/**
 * Подтверждает фазу по точной TX. Закрытая запись может относиться к
 * предыдущей попытке, pending-очистка обязана принадлежать текущей.
 */
async function hasPendingFinalization(control: string, task: string, attempt: string): Promise<boolean> {
  const file = path.join(control, 'transaction-finalization', `t${task}.json`);
  const text = await readProjection(file, 16384);

  if (text === null) {
    return false;
  }

  const record = JSON.parse(text) as Record<string, unknown> | null;

  if (!record || Object.keys(record).sort().join(',') !== 'attempt,baseline,format,phase,scope,task,txid'
    || record.format !== 1 || record.task !== task
    || typeof record.txid !== 'string' || !txidPattern.test(record.txid)
    || record.attempt !== `a_${record.txid.slice(3, 35)}`
    || typeof record.baseline !== 'string' || !digestPattern.test(record.baseline)
    || typeof record.scope !== 'string' || !digestPattern.test(record.scope)) {
    throw new Error('factory_finalization_invalid');
  }

  const directory = path.join(control, 'transactions', `t${task}`, record.txid);
  const [baseline, scope] = await Promise.all([
    hashTransactionInput(directory, 'baseline.tsv'), hashTransactionInput(directory, 'scope.list'),
  ]);

  if (baseline !== record.baseline || scope !== record.scope) {
    throw new Error('factory_finalization_changed');
  }

  if (record.phase === 'synced' && await isTransactionCompleted(directory)) {
    return await pendingManualStop(directory, task, String(record.attempt)) !== null;
  }

  if (record.attempt === attempt && (record.phase === 'pending' || record.phase === 'restored')) {
    return true;
  }

  throw new Error('factory_finalization_invalid');
}

function action(mode: FactoryCleanupAction['mode'], task: string, attempt: string, bytes: string) {
  const identity = createHash('sha256').update(`${task}\n${attempt}\n${bytes}`).digest('hex');

  return { mode, identity };
}

/** Читает обе immutable квитанции ручного Stop и связывает их исходным SHA. */
async function pendingManualStop(directory: string, task: string, attempt: string): Promise<string | null> {
  const required = await readProjection(path.join(directory, 'manual-stop-required.json'), 16384);

  if (required === null) {
    return null;
  }

  const record = JSON.parse(required) as Record<string, unknown>;
  const txid = path.basename(directory);

  if (record.format !== 1 || record.task !== task || record.txid !== txid || record.attempt !== attempt) {
    throw new Error('factory_finalization_invalid');
  }

  const confirmed = await readProjection(path.join(directory, 'manual-stop-confirmed.json'), 16384);

  if (confirmed === null) {
    return required;
  }

  const closed = await readDarwinControlText(path.join(directory, 'manual-stop-proof.json'));
  const requiredSHA256 = createHash('sha256').update(required).digest('hex');
  const proofSHA256 = createHash('sha256').update(closed).digest('hex');
  const common = { format: 1, task, attempt, txid, baselineSHA256: record.baselineSHA256,
    checkpoint: record.checkpoint };

  if (canonicalJson(JSON.parse(closed)) !== canonicalJson({ ...common, requiredSHA256 })
    || canonicalJson(JSON.parse(confirmed)) !== canonicalJson({ ...common, proofSHA256 })
    || !await isTransactionCompleted(directory)) {
    throw new Error('factory_finalization_invalid');
  }

  return null;
}

/**
 * Возвращает действие только для найденного exact record открытой попытки.
 * Само наличие устаревшей строки журнала или PID операцию не разрешает.
 */
export async function describeDarwinCleanup(control: string, task: string,
  attempt: string): Promise<FactoryCleanupAction | null> {
  if (!FACTORY_TASK_ID.test(task) || !/^a_[a-f0-9]{32}$/u.test(attempt)) {
    throw new Error('factory_cleanup_identity_invalid');
  }

  const root = path.join(control, 'transactions', `t${task}`);
  const receipt = await readProjection(path.join(control, 'transaction-finalization', `t${task}.json`), 16384);
  const pointer = await readProjection(path.join(root, 'active.env'), 16384);
  const selected = receipt === null ? null
    : JSON.parse(receipt) as { attempt: string; txid: string; phase: string } | null;
  const txid = pointer === null ? selected?.txid : transactionPointer.exec(pointer)?.[1];

  if (txid && txidPattern.test(txid) && `a_${txid.slice(3, 35)}` === attempt) {
    const directory = path.join(root, txid);
    const state = await readDarwinControlText(path.join(directory, 'state.env'));
    const manual = await pendingManualStop(directory, task, attempt);

    if (manual !== null || state.includes('\nSTATE=stalled\n')) {
      return action('stop', task, attempt, `${txid}\n${manual ?? state}`);
    }

    if (selected?.attempt === attempt && selected.txid === txid && receipt !== null
      && await hasPendingFinalization(control, task, attempt)) {
      return action('stop_or_resume', task, attempt, receipt);
    }

    if (pointer !== null && await activeTransaction(control, task, attempt)) {
      return action('stop_or_resume', task, attempt, `${txid}\n${state}`);
    }
  }

  if (await hasPendingDarwinProfileChannel(control, task, attempt)) {
    const channel = await readProjection(path.join(control, 'profile-channels', `t${task}`, 'active.json'), 16384);

    return channel === null ? null : action('stop_or_resume', task, attempt, channel);
  }

  return null;
}

/**
 * Выводит orchestrator только из exact сессии launch record.
 * Реестр подтверждает привязку к попытке, а его PID сам по себе права не даёт.
 */
async function inspectOrchestrator(records: DarwinLaunchRecord[], projectedPid: string | null) {
  if (records.length !== 1) {
    return records.length === 0 && projectedPid === '' ? 'dead' : 'unknown';
  }

  const record = records[0]!;

  if (record.phase !== 'registered' || !record.process
    || projectedPid && projectedPid !== String(record.process.pid)) {
    return 'unknown';
  }

  const { state } = await inspectDarwinSession(record.process);

  if (state === 'alive') {
    return readDarwinFactoryOwnerState(record.process.pid, record.task) === 'alive' ? 'alive' : 'unknown';
  }

  return state;
}

/**
 * Защитный снимок задачи перед будущим Stop и drain. При наличии живого
 * runner связывает его с protected run/epoch, отдельно от ORCH_PID.
 */
export async function inspectDarwinTaskRuntime(paths: OwnershipPaths, task: string,
  trustedRegistry: TrustedRegistry, inventory?: TaskInventory): Promise<DarwinTaskRuntime> {
  const unknown: DarwinTaskRuntime = {
    task,
    orchestrator: 'unknown',
    runner: 'unknown',
    finalization: 'unknown',
    launch: null,
    binding: null,
    identity: null,
  };

  if (!FACTORY_TASK_ID.test(task)) {
    return unknown;
  }

  try {
    await verifyDarwinOwnershipRoots(paths);

    const name = `t${task}.pipeline`;
    const registryLimit = 1024 * 1024;
    const active = await readProjection(path.join(paths.stateDir, name), registryLimit);
    const archive = active === null ? await readProjection(path.join(paths.stateDir, 'archive', name),
      registryLimit) : null;
    const projection = active ?? archive;
    const registry = projection === null ? null : parsePipeline(projection);
    const proof = registry === null ? null : await trustedRegistry(registry);
    const trusted = proof !== null && (active !== null || proof.terminal !== null);
    const records = inventory?.launches.filter((record) => record.task === task)
      ?? await readDarwinLaunchRecords(paths.factoryControlDir, task);
    const bootId = records.length > 0 ? await readDarwinBootId() : null;
    const current = records.filter((record) => record.bootId === bootId);
    const launch = current.length === 1 ? current[0]! : null;
    const conflicting = trusted && launch?.attempt && launch.attempt !== proof?.attempt;
    const orchestrator = conflicting ? 'unknown'
      : await inspectOrchestrator(current, trusted ? registry?.ORCH_PID ?? '' : null);
    const beforeFork = await hasDarwinRunnerMarker(paths.factoryControlDir, task, 'pending');
    const binding = await readDarwinRunnerBinding(paths.factoryControlDir, task);
    const scoped = binding && trusted && !conflicting && launch?.phase === 'registered'
      && await matchesDarwinRunnerScope(paths.factoryControlDir, task, binding, launch);
    const boundRunner = scoped ? binding : null;
    const orphanScope = !binding && await hasDarwinRunnerMarker(paths.factoryControlDir, task, 'scope');
    let runner = beforeFork ? 'unknown'
      : binding ? (await inspectDarwinSession(binding, undefined, [], boundRunner !== null)).state
      : trusted && orchestrator !== 'unknown' && !orphanScope ? 'dead' : 'unknown';
    const providers = await readDarwinExternalProviders(paths.factoryControlDir, task, boundRunner);

    for (const { row } of providers) {
      const provider = row.child && row.boot === bootId && boundRunner
        ? (await inspectDarwinSession(row.child, undefined, [], true)).state : 'unknown';

      if (provider === 'unknown') {
        runner = 'unknown';
      } else if (provider === 'alive' && runner !== 'unknown') {
        runner = 'alive';
      }
    }
    const pending = trusted && proof !== null && (
      await hasPendingDarwinProfileChannel(paths.factoryControlDir, task, proof.attempt)
      || await hasPendingFinalization(paths.factoryControlDir, task, proof.attempt)
      || await activeTransaction(paths.factoryControlDir, task, proof.attempt));

    await verifyDarwinOwnershipRoots(paths);

    return {
      task,
      orchestrator,
      runner,
      finalization: trusted && !beforeFork && orchestrator !== 'unknown'
        ? pending ? 'pending' : 'done' : 'unknown',
      launch,
      binding: boundRunner,
      identity: trusted && proof ? { attempt: proof.attempt, profile: proof.profile } : null,
    };
  } catch {
    return unknown;
  }
}

/**
 * Только read-only. Два полных обхода сравнивают состав файлов и поколение
 * обработчиков. Уже увиденная незакрытая задача сохраняется при пропаже её файлов.
 */
export async function readDarwinTaskOwnership(paths: OwnershipPaths, known: Set<string>,
  admission: () => FactoryAdmissionSnapshot,
  verify: (task: string, registry: Record<string, string>) => ReturnType<TrustedRegistry>,
): Promise<FactoryOwnershipSnapshot> {
  const snapshot: FactoryOwnershipSnapshot = {
    daemonOwnershipVersion: 1,
    complete: false,
    ownership: [],
  };

  try {
    const first = await taskInventory(paths, admission);
    const files = [...first.registries, ...first.archives, ...first.runners, ...first.providers,
      ...first.finalizations, ...first.transactions, ...first.channels];
    const before = new Set([
      ...known,
      ...files.map(([task]) => task),
      ...first.admission.tasks,
      ...first.launches.map((row) => row.task),
    ]);

    for (const task of before) {
      known.add(task);
    }

    for (const task of [...before].sort((a, b) => (a.length - b.length) || a.localeCompare(b))) {
      const runtime = await inspectDarwinTaskRuntime(paths, task,
        (registry) => verify(task, registry), first);
      const { launch: _launch, binding: _binding, identity: _identity, ...row } = runtime;

      snapshot.ownership.push(row);
    }

    const second = await taskInventory(paths, admission);

    snapshot.complete = canonicalJson(first) === canonicalJson(second) && second.admission.tasks.length === 0
      && snapshot.ownership.every((row) =>
        row.orchestrator !== 'unknown' && row.runner !== 'unknown' && row.finalization !== 'unknown');
    await verifyDarwinOwnershipRoots(paths);

    if (snapshot.complete) {
      for (const row of snapshot.ownership) {
        if (row.orchestrator === 'dead' && row.runner === 'dead' && row.finalization === 'done') {
          known.delete(row.task);
        }
      }
    }
  } catch {
    snapshot.complete = false;
  }

  return snapshot;
}

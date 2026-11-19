import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { FACTORY_TASK_ID } from '../../../shared/runtime/factoryOwnership.ts';
import { quiesceDarwinRunnerFile } from '../../../shared/node/processIdentity.ts';
import { privateRuntimeDirectory } from '../binary/leases.ts';
import { quiesceDarwinExternalProviders } from './providerInstall/darwinExternalProvider.ts';

export interface DarwinRunnerBinding {
  stage: string;
  runId: string;
  epoch: string;
  runner: string;
  pid: number;
  sid: number;
  pgid: number;
  starttime: string;
  generation: string;
}

const bindingKeys = ['SCHEMA', 'TASK', 'STAGE', 'RUN_ID', 'EPOCH', 'RUNNER',
  'PID', 'PGID', 'SESSION', 'STARTTIME', 'STATE'];
const activeKeys = ['SCHEMA', 'RUN_ID', 'EPOCH', 'TOKEN_HASH', 'STATE'];
const scopeKeys = 'bindingSHA256,bootId,format,launchId,task';

/**
 * Intent существует до fork и до полной записи runner. Имя в доверенном
 * каталоге запрещает вывод о пустой сессии даже при повреждённых байтах.
 */
export async function hasDarwinRunnerMarker(control: string, task: string,
  kind: 'pending' | 'scope'): Promise<boolean> {
  if (!FACTORY_TASK_ID.test(task)) {
    throw new Error('factory_task_id_invalid');
  }

  const directory = path.join(control, 'runner-processes');

  await privateRuntimeDirectory(directory, false);

  try {
    await fs.lstat(path.join(directory, `t${task}.active.${kind}`));

    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

/**
 * Разрешает orphan SID только для сохранённого hash active из того же boot
 * и того же зарегистрированного запуска. Строки реестра scope не подменяют.
 */
export async function matchesDarwinRunnerScope(control: string, task: string,
  binding: DarwinRunnerBinding, launch: { launchId: string; bootId: string }): Promise<boolean> {
  try {
    const file = path.join(control, 'runner-processes', `t${task}.active.scope`);
    const record = JSON.parse(await readDarwinControlText(file)) as Record<string, unknown> | null;
    const digest = createHash('sha256').update(binding.generation).digest('hex');

    return record !== null && Object.keys(record).sort().join(',') === scopeKeys
      && record.format === 1 && record.task === task && record.launchId === launch.launchId
      && record.bootId === launch.bootId && record.bindingSHA256 === digest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

/**
 * Читает небольшой файл протокола с одним открытым дескриптором.
 * Неизвестный inode, hardlink или посторонний владелец запрещают доверие.
 */
export async function readDarwinControlText(file: string, limit = 16384): Promise<string> {
  const directory = path.dirname(file);

  if (await fs.realpath(directory) !== directory) {
    throw new Error('factory_control_path_invalid');
  }

  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

  try {
    const before = await handle.stat({ bigint: true });

    if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.getuid!())
      || (before.mode & 0o7777n) !== 0o600n || before.size > BigInt(limit)) {
      throw new Error('factory_control_file_invalid');
    }

    const bytes = Buffer.alloc(Number(before.size) + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const stat = await fs.lstat(file, { bigint: true });

    if (BigInt(bytesRead) !== before.size || before.dev !== stat.dev || before.ino !== stat.ino
      || before.ctimeNs !== stat.ctimeNs || before.mtimeNs !== stat.mtimeNs
      || before.size !== stat.size || await fs.realpath(directory) !== directory) {
      throw new Error('factory_control_file_changed');
    }

    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

/**
 * Закрывает неоднозначное чтение полей Bash env.
 * Для committed capability допускаются только поля результата штатного publisher.
 */
function decodeControlEnv(text: string, required: readonly string[], optional: string[] = []) {
  const fields = new Map<string, string>();
  const allowed = new Set([...required, ...optional]);

  for (const line of text.replace(/\n$/u, '').split('\n')) {
    const separator = line.indexOf('=');
    const key = line.slice(0, separator);

    if (separator < 1 || /[\0\r]/u.test(line) || fields.has(key)
      || !allowed.has(key)) {
      throw new Error('factory_control_file_invalid');
    }

    fields.set(key, line.slice(separator + 1));
  }

  if (required.some((key) => !fields.has(key))) {
    throw new Error('factory_control_file_invalid');
  }

  return Object.fromEntries(fields);
}

/**
 * Сверяет исполнительную запись раннера с protected capability того же визита.
 * Отсутствие .active фиксирует лишь отсутствие записи, а не завершение сессии.
 */
export async function readDarwinRunnerBinding(control: string,
  task: string): Promise<DarwinRunnerBinding | null> {
  if (!FACTORY_TASK_ID.test(task)) {
    throw new Error('factory_task_id_invalid');
  }

  const file = path.join(control, 'runner-processes', `t${task}.active`);
  const generation = await readDarwinControlText(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return null;
    }

    throw error;
  });

  if (generation === null) {
    return null;
  }

  const binding = decodeControlEnv(generation, bindingKeys);
  const stage = binding.STAGE ?? '';
  const runId = binding.RUN_ID ?? '';
  const epoch = binding.EPOCH ?? '';
  const runner = binding.RUNNER ?? '';
  const starttime = binding.STARTTIME ?? '';
  const pid = Number(binding.PID);

  if (binding.SCHEMA !== '1' || binding.TASK !== task || binding.STATE !== 'active'
    || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(stage) || !/^[A-Za-z0-9._-]{1,160}$/u.test(runId)
    || runId === '.' || runId === '..' || !/^(?:0|[1-9][0-9]{0,19})$/u.test(epoch)
    || !/^[a-z][a-z0-9_-]*$/u.test(runner) || !/^\d{7,26}$/u.test(starttime)
    || !Number.isSafeInteger(pid) || pid <= 1 || String(pid) !== binding.PID
    || binding.PGID !== binding.PID || binding.SESSION !== binding.PID) {
    throw new Error('factory_runner_binding_invalid');
  }

  const activeFile = path.join(control, 'runs', `t${task}`, `${stage}.active`);
  const activeText = await readDarwinControlText(activeFile);
  const active = decodeControlEnv(activeText, activeKeys, ['RESULT', 'COMMENT', 'VERDICT_B64']);

  if (active.SCHEMA !== '1' || active.RUN_ID !== runId || active.EPOCH !== epoch
    || (active.STATE !== 'active' && active.STATE !== 'committed')
    || !/^[a-f0-9]{64}$/u.test(active.TOKEN_HASH ?? '') || await readDarwinControlText(file) !== generation
    || await readDarwinControlText(activeFile) !== activeText) {
    throw new Error('factory_runner_binding_changed');
  }

  return {
    stage,
    runId,
    epoch,
    runner,
    pid,
    sid: pid,
    pgid: pid,
    starttime,
    generation,
  };
}

/**
 * Повторно читает принятое поколение под task lock, затем передаёт native
 * quiescer файловый дескриптор той записи, которую он будет перепроверять.
 */
export async function quiesceDarwinRunner(control: string, task: string,
  binding: DarwinRunnerBinding, launch: { launchId: string; bootId: string },
  signal: AbortSignal): Promise<void> {
  const directory = path.join(control, 'runner-processes');
  const lockDirectory = path.join(control, 'protocol-v2', 'orchestrators');
  const runnerFile = path.join(directory, `t${task}.active`);
  const current = await readDarwinRunnerBinding(control, task);

  if (current?.generation !== binding.generation || await hasDarwinRunnerMarker(control, task, 'pending')
    || !await matchesDarwinRunnerScope(control, task, current, launch)
    || await fs.realpath(lockDirectory) !== lockDirectory) {
    throw new Error('release_activity_unknown');
  }

  try {
    await fs.lstat(path.join(control, 'browser-runs', `t${task}`, `${binding.runId}.json`));

    throw new Error('release_task_cleanup_required');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  const handles: FileHandle[] = [];
  const fileFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

  try {
    handles.push(await fs.open(runnerFile, fileFlags));
    handles.push(await fs.open(directory, directoryFlags));
    handles.push(await fs.open(path.join(lockDirectory, `t${task}.lock`), fileFlags));
    handles.push(await fs.open(lockDirectory, directoryFlags));

    const [file, parent, lock, lockParent] = handles;
    const bytes = Buffer.alloc(2048);
    const { bytesRead } = await file!.read(bytes, 0, bytes.length, 0);
    const value = bytes.subarray(0, bytesRead).toString('utf8');

    if (bytesRead === bytes.length || value !== binding.generation) {
      throw new Error('release_activity_unknown');
    }

    await quiesceDarwinRunnerFile({
      file: file!.fd,
      directory: parent!.fd,
      lock: lock!.fd,
      lockDirectory: lockParent!.fd,
    }, signal);

    await quiesceDarwinExternalProviders(control, task, binding, signal);

    const after = await readDarwinRunnerBinding(control, task);
    const held = await file!.stat({ bigint: true });
    const named = await fs.lstat(runnerFile, { bigint: true });

    if (after?.generation !== binding.generation || held.dev !== named.dev || held.ino !== named.ino
      || !await matchesDarwinRunnerScope(control, task, after, launch)) {
      throw new Error('release_activity_unknown');
    }

    await fs.unlink(runnerFile + '.scope');
    await fs.unlink(runnerFile);
    await parent!.sync();
  } finally {
    await Promise.all(handles.map((handle) => handle.close()));
  }
}

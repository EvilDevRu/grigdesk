import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify, parseEnv } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';

import { resolveRuntimeSettings } from '../runtime/runtimeSettings.ts';
import { readInstallation, readInstalledPointer, readInstallationJson,
  writeInstallationJson } from './installedLayout.ts';
import type { InstallationReceipt } from './installedLayout.ts';
import type { InstalledUpdateJob } from './installedUpdateState.ts';
import { readUpdateProcess } from './updateProcessOwner.ts';
import { launchInstalledProcess } from './installedProcess.ts';
import { acquireInstallLock } from './binaryInstall.ts';
import { verifyInstalledGeneration } from './installedUpdateApply.ts';

const execute = promisify(execFile);

export const INSTALLED_SERVER_UNIT = 'grigdesk-server.service';

export type UpdateProcess = Awaited<ReturnType<typeof readUpdateProcess>>;

export interface InstalledServerOwner {
  kind: 'service' | 'manual' | 'desktop' | 'stopped';
  running: boolean;
  instanceId: string | null;
  process: UpdateProcess | null;
}

interface ServerIdentity {
  installationId: string;
  productVersion: string;
  packageId: string;
  instanceId: string;
  pid: number;
  binary: string;
  owner: string;
}

/**
 * Читает только настройки указанной установки, не подхватывая адрес выбранной remote-машины.
 * Секретный CLI-токен остаётся локальным заголовком и не попадает в журнал задания.
 */
async function serverSettings(receipt: InstallationReceipt) {
  let file: NodeJS.ProcessEnv = {};

  try {
    file = parseEnv(await fs.readFile(path.join(receipt.dataHome, '.env'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  return resolveRuntimeSettings({
    env: { GRIGDESK_HOME: receipt.dataHome },
    file,
    home: os.homedir(),
  });
}

/**
 * HTTP всегда ограничен loopback и общим бюджетом запроса.
 * Отказ авторизации или плохой JSON не превращается в stopped.
 */
export async function installedServerRequest(
  receipt: InstallationReceipt, route: string, body?: unknown, signal?: AbortSignal,
): Promise<unknown> {
  const settings = await serverSettings(receipt);
  const token = (await fs.readFile(settings.cliTokenPath, 'utf8')).trim();
  const response = await fetch(settings.origin + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-GrigDesk-Token': token, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    throw new Error('release_server_request_failed');
  }

  const text = await response.text();

  if (text.length > 1024 * 1024) {
    throw new Error('release_server_response_invalid');
  }

  return JSON.parse(text);
}

/**
 * Проверяется весь зарегистрированный unit, а не только его имя или открытый порт.
 * Недоступный user-systemd допускает manual; чужой unit запрещает управление.
 */
export async function installedServerUnit(receipt: InstallationReceipt) {
  let stdout: string;

  try {
    const properties = 'LoadState,ActiveState,ExecStart,WorkingDirectory,MainPID,Result,'
      + 'ExecMainStatus,FragmentPath';

    ({ stdout } = await execute('systemctl', ['--user', 'show', INSTALLED_SERVER_UNIT,
      `--property=${properties}`],
    { timeout: 5000, maxBuffer: 65536 }));
  } catch {
    return null;
  }

  const fields = Object.fromEntries(stdout.trim().split('\n').map((line) => {
    const index = line.indexOf('=');

    return [line.slice(0, index), line.slice(index + 1)];
  }));

  if (fields.LoadState === 'not-found') {
    return null;
  }

  const expected = path.join(receipt.root, 'bin/grigdesk-server');

  if (fields.LoadState !== 'loaded' || fields.WorkingDirectory !== receipt.root
    || !fields.ExecStart?.includes(`path=${expected} ; argv[]=${expected} ;`)) {
    throw new Error('release_foreign_service');
  }

  const unitFile = await fs.lstat(fields.FragmentPath ?? '');
  const unitText = await fs.readFile(fields.FragmentPath!, 'utf8');

  if (!unitFile.isFile() || unitFile.isSymbolicLink() || unitFile.uid !== receipt.uid
    || unitFile.mode & 0o022 || !unitText.includes(`# GrigDesk installationId=${receipt.installationId}\n`)) {
    throw new Error('release_foreign_service');
  }

  return fields;
}

/**
 * Время старта защищает от повторного PID; ENOENT и ESRCH означают завершение при чтении proc.
 * EPERM и другие ошибки доступа сохраняют неопределённость вместо разрешения на замену.
 */
export async function updateProcessAlive(expected: UpdateProcess): Promise<boolean> {
  try {
    const actual = await readUpdateProcess(expected.pid);

    return actual.starttime === expected.starttime && actual.executable === expected.executable;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code === 'ENOENT' || code === 'ESRCH') {
      return false;
    }

    // Зомби уже не исполняет программу, но ещё может ждать reap у родителя.
    const stat = await fs.readFile(`/proc/${expected.pid}/stat`, 'utf8').catch(() => '');

    if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ')) {
      return false;
    }

    throw error;
  }
}

/**
 * Живой ответ привязывается к uid, boot instance и бинарнику current этой установки.
 * Manual-процесс допускается только с lease канонического launcher, desktop — с явным owner.
 */
export async function inspectInstalledServer(receipt: InstallationReceipt): Promise<InstalledServerOwner> {
  const unit = await installedServerUnit(receipt);
  const settings = await serverSettings(receipt);
  let identity: ServerIdentity;

  try {
    identity = await installedServerRequest(receipt, '/api/system/runtime-identity') as ServerIdentity;
  } catch (error) {
    try {
      await fetch(settings.origin + '/api/health', { signal: AbortSignal.timeout(1500) });
    } catch (network) {
      const cause = (network as { cause?: { code?: string } }).cause?.code;

      if (cause === 'ECONNREFUSED' && (!unit || ['inactive', 'failed'].includes(unit.ActiveState!))) {
        return {
          kind: unit ? 'service' : 'stopped',
          running: false,
          instanceId: null,
          process: null,
        };
      }
    }

    throw error;
  }

  const current = await readInstalledPointer(receipt);
  const binary = current.server && path.join(receipt.root, current.server, 'bin/grigdesk-server');

  if (identity.installationId !== receipt.installationId || identity.binary !== binary
    || typeof identity.instanceId !== 'string' || identity.instanceId.length !== 36) {
    throw new Error('release_server_owner_invalid');
  }

  const processIdentity = await readUpdateProcess(identity.pid);
  let kind: InstalledServerOwner['kind'];

  if (unit?.ActiveState === 'active') {
    if (Number(unit.MainPID) !== identity.pid) {
      // SEA launcher может держать родительский процесс: membership cgroup остаётся обязательным.
      const cgroup = await fs.readFile(`/proc/${identity.pid}/cgroup`, 'utf8');

      if (!cgroup.split(/[\n/]/u).some((part) => part === INSTALLED_SERVER_UNIT)) {
        throw new Error('release_server_owner_invalid');
      }
    }

    kind = 'service';
  } else if (identity.owner === 'desktop') {
    kind = 'desktop';
  } else {
    const lease = await readInstallationJson(receipt.root, 'update/server-process.json') as {
      process: UpdateProcess;
    };

    if (!lease?.process
      || (await readUpdateProcess(lease.process.pid)).starttime !== lease.process.starttime) {
      throw new Error('release_manual_owner_unknown');
    }

    const ancestry = await fs.readFile(`/proc/${identity.pid}/stat`, 'utf8');
    const parent = Number(ancestry.slice(ancestry.lastIndexOf(')') + 2).split(' ')[1]);

    if (identity.pid !== lease.process.pid && parent !== lease.process.pid) {
      throw new Error('release_manual_owner_unknown');
    }

    kind = 'manual';
  }

  return {
    kind,
    running: true,
    instanceId: identity.instanceId,
    process: processIdentity,
  };
}

export interface UpdateActivity {
  active: number;
  queued: number;
  tasks: string[];
}

/**
 * Активность читается свежо с bound local-сервера; неизвестный ответ блокирует update.
 * Чтение названий чатов не нужно для подтверждения количества прерываемых ходов.
 */
export async function inspectUpdateActivity(receipt: InstallationReceipt): Promise<UpdateActivity> {
  const [chats, tasks] = await Promise.all([
    installedServerRequest(receipt, '/api/chat/active'),
    installedServerRequest(receipt, '/api/tasks'),
  ]) as [{ active?: unknown[]; queued?: unknown[] }, { tasks?: Record<string, unknown>[] }];

  if (!Array.isArray(chats.active) || !Array.isArray(chats.queued) || !Array.isArray(tasks.tasks)
    || tasks.tasks.some((row) => typeof row !== 'object' || row === null)) {
    throw new Error('release_activity_unknown');
  }

  const running = tasks.tasks.filter((row) => row.daemonAlive === true && !row.readOnly)
    .map((row) => String(row.task));

  if (running.some((task) => !/^\d+$/u.test(task))) {
    throw new Error('release_activity_unknown');
  }

  return {
    active: chats.active.length,
    queued: chats.queued.length,
    tasks: running,
  };
}

/**
 * Каждая pipeline получает штатный Stop, затем общий двадцатисекундный срок ждёт daemonAlive=false.
 * Прерывание или неизвестный исход не разрешает останавливать сервер и переключать current.
 */
export async function stopUpdatePipelines(receipt: InstallationReceipt): Promise<void> {
  const signal = AbortSignal.timeout(20000);
  const activity = await inspectUpdateActivity(receipt);

  await Promise.all(activity.tasks.map(async (task) => {
    const response = await installedServerRequest(receipt, `/api/tasks/${task}/stop`, {}, signal) as {
      outcome?: string;
    };

    if (!['stopped', 'not_running', 'stop_sent'].includes(response.outcome ?? '')) {
      throw new Error('release_pipeline_stop_failed');
    }
  }));

  while (activity.tasks.length) {
    signal.throwIfAborted();

    const response = await installedServerRequest(receipt, '/api/tasks', undefined, signal) as {
      tasks?: { task: unknown; daemonAlive?: boolean }[];
    };

    if (!Array.isArray(response.tasks)) {
      throw new Error('release_activity_unknown');
    }

    if (activity.tasks.every((task) => response.tasks!.some((row) => String(row.task) === task
      && row.daemonAlive === false))) {
      return;
    }

    await pause(300, undefined, { signal });
  }
}

/**
 * Слив выполняется через проверенного владельца; SIGKILL не используется для продвижения update.
 * Перед возвратом требуются exit старого PID и закрытый loopback-порт.
 */
export async function stopInstalledServer(
  receipt: InstallationReceipt, owner: InstalledServerOwner, job?: InstalledUpdateJob,
): Promise<void> {
  if (!owner.running) {
    return;
  }

  const current = await inspectInstalledServer(receipt);

  if (current.instanceId !== owner.instanceId || current.process?.starttime !== owner.process?.starttime) {
    throw new Error('release_server_owner_changed');
  }

  if (owner.kind === 'service') {
    await execute('systemctl', ['--user', 'stop', INSTALLED_SERVER_UNIT], { timeout: 65000 });

    const unit = await installedServerUnit(receipt);

    if (!unit || unit.ActiveState !== 'inactive' || unit.Result !== 'success') {
      throw new Error('release_server_drain_failed');
    }
  } else if (job) {
    await installedServerRequest(receipt, '/api/system/update-drain', {
      jobId: job.id,
      installationId: job.installationId,
      manifestDigest: job.manifestDigest,
    });
  } else {
    if (!owner.process || !await updateProcessAlive(owner.process)) {
      throw new Error('release_server_owner_changed');
    }

    process.kill(owner.process.pid, 'SIGTERM');
  }

  const deadline = Date.now() + 55000;

  while (owner.process && await updateProcessAlive(owner.process)) {
    if (Date.now() >= deadline) {
      throw new Error('release_server_drain_timeout');
    }

    await pause(200);
  }

  if (job) {
    const proof = await readInstallationJson(receipt.root, 'update/server-drain.json') as {
      jobId: string;
      nonce: string;
      instanceId: string;
      success: boolean;
    };

    if (proof.jobId !== job.id || proof.nonce !== job.intent?.nonce
      || proof.instanceId !== owner.instanceId || proof.success !== true) {
      throw new Error('release_server_drain_proof_missing');
    }
  }

  const stopped = await inspectInstalledServer(receipt);

  if (stopped.running) {
    throw new Error('release_server_still_running');
  }
}

/**
 * Запускается только канонический launcher своей установки; существующий unit имеет приоритет.
 * Само скачивание этот метод не вызывает, а lease ручного процесса переживает завершение ctl.
 */
export async function startInstalledServer(receipt: InstallationReceipt): Promise<void> {
  const lock = await acquireInstallLock(path.join(receipt.root, 'update/server-launch'), { waitMs: 1000 });

  try {
    await startServerLocked(receipt);
  } finally {
    await lock.release();
  }
}

/**
 * Отдельный launch-lock сериализует два ctl без конфликта с удерживаемым apply-lock.
 * Живой процесс либо запускающийся unit исключают повторный spawn.
 */
async function startServerLocked(receipt: InstallationReceipt): Promise<void> {
  const unit = await installedServerUnit(receipt);

  if (unit && ['active', 'activating', 'reloading'].includes(unit.ActiveState!)) {
    return;
  }

  const state = await inspectInstalledServer(receipt);

  if (state.running) {
    return;
  }

  if (unit) {
    await execute('systemctl', ['--user', 'start', '--no-block', INSTALLED_SERVER_UNIT], { timeout: 15000 });

    return;
  }

  await launchInstalledProcess(receipt, ['launch', 'server'],
    `manual-${receipt.installationId}-${randomUUID()}`);

  const deadline = Date.now() + 90000;

  while (Date.now() < deadline) {
    if ((await inspectInstalledServer(receipt)).running) {
      return;
    }

    await pause(300);
  }

  throw new Error('release_server_start_timeout');
}

/**
 * Успех требует новой boot identity, packageId и версии реального процесса.
 * Отложенный stopped-выпуск проверяется только после отдельного явного запуска.
 */
export async function proveInstalledServer(
  receipt: InstallationReceipt, job: InstalledUpdateJob, rollback: boolean,
): Promise<void> {
  const pointer = rollback ? job.previous : job.target;
  const version = pointer.server?.split('/')[1];
  const envelope = await verifyInstalledGeneration(receipt, pointer.server!, 'server');
  const deadline = Date.now() + 90000;

  while (Date.now() < deadline) {
    try {
      const owner = await inspectInstalledServer(receipt);
      const identity = await installedServerRequest(receipt,
        '/api/system/runtime-identity') as ServerIdentity;

      if (owner.running && identity.productVersion === version
        && identity.packageId === envelope.payload.artifacts.server.packageId) {
        return;
      }
    } catch {
      // Readiness ограничен общим сроком; чужой процесс не получает сигнал даже при неудаче.
    }

    await pause(300);
  }

  throw new Error('release_server_boot_proof_missing');
}

/**
 * Lease записывает сам maintenance launcher до exec готового SEA с тем же PID.
 * Desktop-child обозначается отдельно и не притворяется ручным ctl-запуском.
 */
export async function registerInstalledServerLaunch(root: string): Promise<void> {
  await readInstallation(root);
  await writeInstallationJson(root, 'update/server-process.json', {
    process: await readUpdateProcess(process.pid),
  });
}

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify, parseEnv } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';

import { resolveRuntimeSettings } from '../runtime/runtimeSettings.ts';
import { FACTORY_TASK_ID, decodeCompleteFactoryOwnership } from '../runtime/factoryOwnership.ts';
import { readInstallation, readInstalledPointer, readInstallationJson,
  writeInstallationJson } from './installedLayout.ts';
import type { InstallationReceipt } from './installedLayout.ts';
import type { InstalledUpdateJob } from './installedUpdateState.ts';
import { readUpdateProcess } from './updateProcessOwner.ts';
import { launchInstalledProcess } from './installedProcess.ts';
import { acquireInstallLock } from './binaryInstall.ts';
import { verifyInstalledGeneration } from './installedUpdateApply.ts';
import { darwinProcessOwnerState, readDarwinProcessIdentity } from './processIdentity.ts';
import {
  darwinServerPaths, identifyDarwinServerOwner, liveDarwinServerLease, registerDarwinServerLaunch,
} from './darwinInstalledOwner.ts';
import {
  darwinInstalledService, startDarwinInstalledService, stopDarwinInstalledService,
} from './launchdInstalledService.ts';

const execute = promisify(execFile);

export const INSTALLED_SERVER_UNIT = 'grigdesk-server.service';

export type UpdateProcess = Awaited<ReturnType<typeof readUpdateProcess>>;

export interface InstalledServerOwner {
  kind: 'service' | 'manual' | 'desktop' | 'stopped';
  running: boolean;
  instanceId: string | null;
  process: UpdateProcess | null;
  launcher?: UpdateProcess;
}

/**
 * Main получает токен слива только у проверенного сервера своей установки.
 * Отсутствующий или чужой instance закрывает операцию до штатного Stop.
 */
export async function acquireInstalledDesktopDrain(receipt: InstallationReceipt, signal: AbortSignal,
  expectsOwnedServer: boolean) {
  const owner = await inspectInstalledServer(receipt);

  if (!owner.running || !owner.instanceId || (owner.kind === 'desktop') !== expectsOwnedServer
    || owner.kind === 'stopped' || !owner.process || !owner.launcher) {
    throw new Error('release_activity_unknown');
  }

  const admission = await acquireDarwinOwnerAdmission(receipt, owner, 'desktop-quit', signal);

  return {
    ...admission,
    /**
     * Supervisor ждёт свой launcher. Для завершения окна дополнительно нужен
     * выход именно обоих процессов первоначально подтверждённого сервера.
     */
    async proveOwnedServerStopped(expires: AbortSignal): Promise<void> {
      if (owner.kind !== 'desktop' || !owner.process || !owner.launcher) {
        throw new Error('release_activity_unknown');
      }

      const deadline = AbortSignal.any([expires, AbortSignal.timeout(6000)]);
      const maintenance = path.join(receipt.root, 'update/maintenance');
      const probe = (pid: number) => readDarwinProcessIdentity(pid, maintenance);

      for (;;) {
        deadline.throwIfAborted();

        const [worker, launcher] = await Promise.all([
          darwinProcessOwnerState(owner.process, probe), darwinProcessOwnerState(owner.launcher, probe),
        ]);

        deadline.throwIfAborted();

        if (worker === 'unknown' || launcher === 'unknown') {
          throw new Error('release_activity_unknown');
        }
        if (worker === 'dead' && launcher === 'dead') {
          return;
        }

        await pause(100, undefined, { signal: deadline });
      }
    },
  };
}

/**
 * Stop использует общий admission со своей identity и целью.
 * Только подтверждённый работающий сервер принимает запрос CLI.
 */
export async function acquireInstalledServerStop(receipt: InstallationReceipt, owner: InstalledServerOwner) {
  if (!owner.running || !owner.instanceId) {
    throw new Error('release_activity_unknown');
  }

  return acquireDarwinOwnerAdmission(receipt, owner, 'server-stop', AbortSignal.timeout(6000));
}

/**
 * Квитанция acquire/confirm/release относится к одной инкарнации HTTP.
 * Сервер различает источник обычного выхода и установленного CLI Stop.
 */
async function acquireDarwinOwnerAdmission(receipt: InstallationReceipt, owner: InstalledServerOwner,
  purpose: 'desktop-quit' | 'server-stop', signal: AbortSignal) {
  signal.throwIfAborted();

  const route = '/api/system/factory-quit-admission';
  const identity = {
    installationId: receipt.installationId,
    instanceId: owner.instanceId,
    pid: process.pid,
    purpose,
  };
  const acquired = await installedServerRequest(receipt, route, { action: 'acquire', ...identity }, signal,
    'admission') as { admissionId?: unknown };
  const id = acquired?.admissionId;

  if (!acquired || Object.keys(acquired).join(',') !== 'admissionId' || typeof id !== 'string'
    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(id)) {
    throw new Error('release_activity_unknown');
  }

  /** Точный ACK подтверждает тот же instance и прежний одноразовый токен. */
  async function action(name: 'confirm' | 'release', expires?: AbortSignal) {
    const value = await installedServerRequest(receipt, route, {
      action: name,
      ...identity,
      admissionId: id,
    }, expires, 'admission') as { ok?: unknown };

    if (!value || Object.keys(value).join(',') !== 'ok' || value.ok !== true) {
      throw new Error('release_activity_unknown');
    }
  }

  return {
    confirm: (expires: AbortSignal) => action('confirm', expires),
    release: () => action('release'),
  };
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
export async function serverSettings(receipt: InstallationReceipt) {
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

type FactoryRequest = 'ownership' | 'stop' | 'admission';

const factoryErrors = {
  ownership: ['release_activity_unknown'],
  stop: ['release_activity_unknown', 'release_drain_busy', 'release_task_cleanup_required'],
  admission: ['release_activity_unknown', 'release_drain_busy', 'release_task_cleanup_required'],
} satisfies Record<FactoryRequest, string[]>;

/**
 * Читает ограниченный ответ до JSON.parse, тем же запросом и deadline.
 * Только ожидаемый 409 и точный код конкретного маршрута сохраняют причину отказа.
 */
async function strictFactoryResponse(response: Response, kind: FactoryRequest): Promise<unknown> {
  const limit = response.ok ? 1024 * 1024 : 16384;
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let value: unknown;

  try {
    if (!reader || !/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '')) {
      throw new Error('json_expected');
    }

    for (;;) {
      const chunk = await reader.read();

      if (chunk.done) {
        break;
      }

      length += chunk.value.byteLength;

      if (length > limit) {
        throw new Error('response_limit');
      }

      chunks.push(chunk.value);
    }

    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length)));
  } catch {
    await reader?.cancel().catch(() => {});

    throw new Error('release_server_request_failed');
  } finally {
    reader?.releaseLock();
  }

  if (response.ok) {
    return value;
  }

  const failure = value as { error?: unknown } | null;

  if (response.status === 409 && failure && typeof failure === 'object'
    && Object.keys(failure).join(',') === 'error' && typeof failure.error === 'string'
    && factoryErrors[kind].includes(failure.error)) {
    throw new Error(failure.error);
  }

  throw new Error('release_server_request_failed');
}

/**
 * HTTP всегда ограничен loopback и общим бюджетом запроса.
 * Отказ авторизации или плохой JSON не превращается в stopped.
 */
export async function installedServerRequest(
  receipt: InstallationReceipt, route: string, body?: unknown, signal?: AbortSignal,
  strictFactory?: FactoryRequest,
): Promise<unknown> {
  const settings = await serverSettings(receipt);
  const token = (await fs.readFile(settings.cliTokenPath, 'utf8')).trim();
  const response = await fetch(settings.origin + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-GrigDesk-Token': token, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
  }).catch((error) => {
    if (strictFactory) {
      throw new Error('release_server_request_failed', { cause: error });
    }

    throw error;
  });

  if (strictFactory) {
    return strictFactoryResponse(response, strictFactory);
  }

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
  if (process.platform === 'darwin') {
    if (receipt.mode === 'remote') {
      return null;
    }

    const service = await darwinInstalledService(receipt);

    return service.state === 'no-domain' ? null : {
      ActiveState: service.pid ? 'active' : service.startScheduled ? 'activating' : 'inactive',
      MainPID: service.pid ? String(service.pid) : '0',
      Result: '',
    };
  }

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

    if (process.platform === 'darwin') {
      throw error;
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
  if (process.platform === 'darwin') {
    return inspectDarwinServer(receipt);
  }

  const unit = await installedServerUnit(receipt);
  const settings = await serverSettings(receipt);

  /**
   * Сервер установки может быть не запущен или поднят откуда угодно с другой папкой
   * данных: отказ порта по ECONNREFUSED означает stopped ещё до чтения CLI-токена,
   * поэтому незапущенный сервер не требует токена и не роняет осмотр.
   */
  const refused = await fetch(settings.origin + '/api/health',
    { redirect: 'error', signal: AbortSignal.timeout(1500) })
    .then(() => false,
      (network: unknown) => (network as { cause?: { code?: string } }).cause?.code === 'ECONNREFUSED');

  if (refused && (!unit || ['inactive', 'failed'].includes(unit.ActiveState!))) {
    return {
      kind: unit ? 'service' : 'stopped',
      running: false,
      instanceId: null,
      process: null,
    };
  }

  let identity: ServerIdentity;

  try {
    identity = await installedServerRequest(receipt, '/api/system/runtime-identity') as ServerIdentity;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';

    // Живой порт без читаемого токена этой установки даёт диагностический код вместо сырого ENOENT.
    if (message.includes('cli-token')) {
      throw new Error('release_server_token_unreadable');
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

/**
 * Связывает health и authenticated HTTP identity с конкретным нативным
 * процессом. Отсутствие порта при ещё живом запуске означает starting.
 */
async function inspectDarwinServer(receipt: InstallationReceipt): Promise<InstalledServerOwner> {
  const stopped = {
    kind: 'stopped' as const,
    running: false,
    instanceId: null,
    process: null,
  };

  if (receipt.mode === 'remote') {
    return stopped;
  }

  const paths = await darwinServerPaths(receipt);
  const unit = await darwinInstalledService(receipt);
  const lease = await liveDarwinServerLease(receipt, paths.binary);
  const { origin } = await serverSettings(receipt);
  const refused = await fetch(origin + '/api/health', {
    redirect: 'error',
    signal: AbortSignal.timeout(1500),
  }).then(async (response) => {
    await response.body?.cancel();

    return false;
  }, (error: unknown) => {
    if ((error as { cause?: { code?: string } }).cause?.code !== 'ECONNREFUSED') {
      throw new Error('release_activity_unknown');
    }

    return true;
  });

  if (refused) {
    if (unit.pid || unit.startScheduled || lease) {
      throw new Error('release_server_starting');
    }

    return { ...stopped, kind: unit.state === 'loaded' ? 'service' : 'stopped' };
  }

  const identity = await installedServerRequest(receipt, '/api/system/runtime-identity') as ServerIdentity;

  if (identity.installationId !== receipt.installationId || identity.binary !== paths.binary
    || identity.productVersion !== paths.version || identity.packageId !== paths.packageId
    || !/^[a-f0-9-]{36}$/u.test(identity.instanceId)
    || !Number.isSafeInteger(identity.pid) || identity.pid <= 1) {
    throw new Error('release_server_owner_invalid');
  }

  const owner = await identifyDarwinServerOwner(receipt, paths, identity.pid, identity.owner, unit.pid);

  return {
    kind: owner.kind,
    running: true,
    instanceId: identity.instanceId,
    process: owner.serving,
    launcher: owner.launcher,
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
  if (process.platform === 'darwin') {
    const [chats, ownership] = await Promise.all([
      installedServerRequest(receipt, '/api/chat/active') as Promise<{ active?: unknown; queued?: unknown }>,
      installedServerRequest(receipt, '/api/tasks?updateOwnership=1', undefined, undefined, 'ownership'),
    ]);
    const rows = decodeCompleteFactoryOwnership(ownership);

    if (!Array.isArray(chats.active) || !Array.isArray(chats.queued)) {
      throw new Error('release_activity_unknown');
    }

    return {
      active: chats.active.length,
      queued: chats.queued.length,
      tasks: rows.filter((row) => row.orchestrator === 'alive' || row.runner === 'alive'
        || row.finalization === 'pending').map((row) => row.task),
    };
  }

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
  const darwin = process.platform === 'darwin';

  await Promise.all(activity.tasks.map(async (task) => {
    if (darwin && !FACTORY_TASK_ID.test(task)) {
      throw new Error('release_activity_unknown');
    }

    const response = await installedServerRequest(receipt, `/api/tasks/${task}/stop`, {}, signal,
      darwin ? 'stop' : undefined) as {
      outcome?: string;
    };

    if (!['stopped', 'not_running', 'stop_sent'].includes(response.outcome ?? '')) {
      throw new Error('release_pipeline_stop_failed');
    }
  }));

  if (darwin) {
    for (;;) {
      signal.throwIfAborted();

      const snapshot = await installedServerRequest(receipt, '/api/tasks?updateOwnership=1', undefined,
        signal, 'ownership');
      const rows = decodeCompleteFactoryOwnership(snapshot);
      const stopped = new Set(rows.filter((row) => row.orchestrator === 'dead' && row.runner === 'dead'
        && row.finalization === 'done').map((row) => row.task));

      if (rows.length === stopped.size && activity.tasks.every((task) => stopped.has(task))) {
        return;
      }

      await pause(300, undefined, { signal });
    }
  }

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
  factoryAdmissionId?: string, markStopDispatched?: () => void,
): Promise<void> {
  if (!owner.running) {
    return;
  }

  const current = await inspectInstalledServer(receipt);

  if (current.instanceId !== owner.instanceId || current.process?.starttime !== owner.process?.starttime
    || current.process?.pid !== owner.process?.pid || current.kind !== owner.kind
    || current.launcher?.starttime !== owner.launcher?.starttime
    || current.launcher?.pid !== owner.launcher?.pid) {
    throw new Error('release_server_owner_changed');
  }

  const darwinService = process.platform === 'darwin' && owner.kind === 'service';

  if (darwinService && !job) {
    if (!current.launcher) {
      throw new Error('release_server_owner_changed');
    }

    await stopDarwinInstalledService(receipt, current.launcher);
  } else if (owner.kind === 'service' && !darwinService) {
    await execute('systemctl', ['--user', 'stop', INSTALLED_SERVER_UNIT], { timeout: 65000 });

    const unit = await installedServerUnit(receipt);

    if (!unit || unit.ActiveState !== 'inactive' || unit.Result !== 'success') {
      throw new Error('release_server_drain_failed');
    }
  } else if (job) {
    if (process.platform === 'darwin' && !factoryAdmissionId) {
      throw new Error('release_activity_unknown');
    }

    markStopDispatched?.();
    await installedServerRequest(receipt, '/api/system/update-drain', {
      jobId: job.id,
      installationId: job.installationId,
      manifestDigest: job.manifestDigest,
      ...(factoryAdmissionId ? { factoryAdmissionId } : {}),
    }, undefined, process.platform === 'darwin' ? 'admission' : undefined);
  } else {
    if (!owner.process || !await updateProcessAlive(owner.process)) {
      throw new Error('release_server_owner_changed');
    }

    process.kill(owner.process.pid, 'SIGTERM');
  }

  const deadline = Date.now() + 55000;

  while (owner.process && await updateProcessAlive(owner.process)
    || owner.launcher && await updateProcessAlive(owner.launcher)) {
    if (Date.now() >= deadline) {
      throw new Error('release_server_drain_timeout');
    }

    await pause(200);
  }

  if (darwinService && job) {
    await stopDarwinInstalledService(receipt, null);
  }

  if (job) {
    const proof = await readInstallationJson(receipt.root, 'update/server-drain.json').catch((error) => {
      if (process.platform === 'darwin') {
        throw new Error('release_server_drain_proof_missing', { cause: error });
      }

      throw error;
    }) as {
      jobId: string;
      nonce: string;
      instanceId: string;
      success: boolean;
    };

    if (!proof || proof.jobId !== job.id || proof.nonce !== job.intent?.nonce
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
 * Штатный CLI Stop подтверждает нулевую активность под своим допуском.
 * Если остановка началась, токен остаётся до завершения сервера или владельца.
 */
export async function stopInstalledServerFromCli(
  receipt: InstallationReceipt, owner: InstalledServerOwner,
): Promise<void> {
  if (!owner.running || process.platform !== 'darwin') {
    await stopInstalledServer(receipt, owner);

    return;
  }

  const admission = await acquireInstalledServerStop(receipt, owner);
  let dispatched = false;

  try {
    await stopUpdatePipelines(receipt);
    await admission.confirm(AbortSignal.timeout(6000));
    dispatched = true;
    await stopInstalledServer(receipt, owner);
  } finally {
    if (!dispatched) {
      await admission.release().catch(() => {});
    }
  }
}

/**
 * Запускается только канонический launcher своей установки; существующий unit имеет приоритет.
 * Само скачивание этот метод не вызывает, а lease ручного процесса переживает завершение ctl.
 */
export async function startInstalledServer(receipt: InstallationReceipt): Promise<void> {
  const lock = await acquireInstallLock(path.join(receipt.root, 'update/server-launch'), {
    waitMs: 1000,
    darwinMaintenance: path.join(receipt.root, 'update/maintenance'),
  });

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
  if (process.platform === 'darwin') {
    await startDarwinServer(receipt);

    return;
  }

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
 * Известное отсутствие GUI разрешает отдельный manual launcher. В обоих
 * случаях возврат следует после совпавшей HTTP identity текущего поколения.
 */
async function startDarwinServer(receipt: InstallationReceipt): Promise<void> {
  if (receipt.mode === 'remote') {
    throw new Error('installation_component_missing');
  }

  const existing = await inspectDarwinServer(receipt).catch((error: Error) => {
    if (error.message !== 'release_server_starting') {
      throw error;
    }

    return null;
  });

  if (existing?.running) {
    return;
  }

  if (existing && !await startDarwinInstalledService(receipt)) {
    await launchInstalledProcess(receipt, ['launch', 'server'],
      `manual-${receipt.installationId}-${randomUUID()}`);
  }

  const deadline = Date.now() + 90000;

  while (Date.now() < deadline) {
    try {
      if ((await inspectDarwinServer(receipt)).running) {
        return;
      }
    } catch (error) {
      if ((error as Error).message !== 'release_server_starting') {
        throw error;
      }
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
export async function registerInstalledServerLaunch(
  root: string, binary?: string, kind: 'service' | 'manual' = 'manual',
): Promise<void> {
  const receipt = await readInstallation(root);

  if (process.platform === 'darwin') {
    await registerDarwinServerLaunch(receipt, binary ?? '', kind);

    return;
  }

  await writeInstallationJson(root, 'update/server-process.json', {
    process: await readUpdateProcess(process.pid),
  });
}

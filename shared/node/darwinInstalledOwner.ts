import fs from 'node:fs/promises';
import path from 'node:path';

import { dataPath } from '../runtime/dataHome.ts';
import type { ReleaseEnvelope } from '../runtime/installedUpdateContracts.ts';
import { installedExecutableSuffix, installationCandidate } from './bundleLayout.ts';
import {
  assertInstallationPath, readInstallationJson, readInstalledPointer, writeInstallationJson,
} from './installedLayout.ts';
import type { InstallationReceipt } from './installedLayout.ts';
import { readDarwinProcessIdentity } from './processIdentity.ts';
import type { DarwinProcessIdentity } from './processIdentity.ts';
import { verifyReleaseEnvelope } from './releaseTrust.ts';

const leasePath = 'update/server-process.json';
const startToken = /^[0-9]{7,26}$/u;
const packageIdPattern = /^[a-f0-9]{64}$/u;
const maintenance = (receipt: InstallationReceipt) => path.join(receipt.root, 'update/maintenance');

interface ServerLease {
  format: 1;
  installationId: string;
  kind: 'service' | 'manual';
  pid: number;
  starttime: string;
  executable: string;
}

const probe = (receipt: InstallationReceipt, pid: number) =>
  readDarwinProcessIdentity(pid, maintenance(receipt));

/**
 * Подтверждает бинарник из текущего подписанного выпуска и его worker.
 * Каталог worker с обычным Node выводится из D и signed packageId.
 */
export async function darwinServerPaths(receipt: InstallationReceipt) {
  const pointer = await readInstalledPointer(receipt);

  if (!pointer.server) {
    throw new Error('installation_component_missing');
  }

  const envelope = await readInstallationJson(receipt.root,
    path.posix.dirname(pointer.server) + '/release.json') as ReleaseEnvelope;
  const packageId = envelope.payload.artifacts.server.packageId;
  const version = pointer.server.split('/')[1];

  verifyReleaseEnvelope(envelope);

  if (envelope.payload.platform.os !== 'darwin' || envelope.payload.version !== version
    || !packageId || !packageIdPattern.test(packageId)) {
    throw new Error('release_server_owner_invalid');
  }

  const binary = await assertInstallationPath(receipt.root,
    pointer.server + '/' + installedExecutableSuffix('server'));
  const worker = path.join(dataPath(receipt.dataHome, 'serverRuntime'),
    'packages', packageId, 'runtime/node/bin/node');
  const desktop = pointer.desktop ? await assertInstallationPath(receipt.root,
    pointer.desktop + '/' + installedExecutableSuffix('desktop', 'darwin')) : null;

  return {
    binary,
    worker,
    desktop,
    packageId,
    version,
  };
}

/**
 * Лаунчер фиксирует incarnation до execve. После execve PID и starttime
 * сохраняются, а текущий executable обязан совпасть с указанным signed SEA.
 */
export async function registerDarwinServerLaunch(
  receipt: InstallationReceipt, binary: string, kind: ServerLease['kind'],
): Promise<void> {
  const owner = await probe(receipt, process.pid);

  if (owner.state !== 'alive' || owner.identity.executable !== maintenance(receipt)
    || binary !== (await darwinServerPaths(receipt)).binary) {
    throw new Error('release_server_owner_invalid');
  }

  const lease: ServerLease = {
    format: 1,
    installationId: receipt.installationId,
    kind,
    pid: process.pid,
    starttime: owner.identity.starttime,
    executable: binary,
  };

  await writeInstallationJson(receipt.root, leasePath, lease);
}

/**
 * Missing/dead PID и живая проверяемая запись различаются до чтения HTTP.
 * Живой unfamiliar процесс или неопределённость запрещают эффекты.
 */
export async function liveDarwinServerLease(receipt: InstallationReceipt, binary: string) {
  const lease = await readInstallationJson(receipt.root, leasePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return null;
    }

    throw error;
  }) as ServerLease | null;

  if (!lease) {
    return null;
  }

  if (Object.keys(lease).sort().join(',') !== 'executable,format,installationId,kind,pid,starttime'
    || lease.format !== 1 || lease.installationId !== receipt.installationId
    || !['manual', 'service'].includes(lease.kind) || !Number.isSafeInteger(lease.pid)
    || lease.pid <= 1 || !startToken.test(lease.starttime) || !path.isAbsolute(lease.executable)) {
    throw new Error('release_manual_owner_unknown');
  }

  const observed = await probe(receipt, lease.pid);

  if (observed.state === 'dead'
    || observed.state === 'alive' && observed.identity.starttime !== lease.starttime) {
    return null;
  }

  if (observed.state !== 'alive' || lease.executable !== binary
    || ![binary, maintenance(receipt)].includes(observed.identity.executable)) {
    throw new Error('release_manual_owner_unknown');
  }

  return { record: lease, identity: observed.identity };
}

/**
 * Актуальная цепочка проверяется по времени старта на каждом шаге.
 * Граница launchd PID 1 не требует чтения процесса другого пользователя.
 */
async function ancestors(receipt: InstallationReceipt, first: DarwinProcessIdentity) {
  const ancestry: DarwinProcessIdentity[] = [];
  let child = first;

  while (child.ppid > 1 && ancestry.length < 64) {
    const parent = await probe(receipt, child.ppid);

    if (parent.state !== 'alive' || BigInt(parent.identity.starttime) > BigInt(child.starttime)
      || ancestry.some((item) => item.pid === parent.identity.pid) || first.pid === parent.identity.pid) {
      throw new Error('release_activity_unknown');
    }

    ancestry.push(parent.identity);
    child = parent.identity;
  }

  if (child.ppid !== 1) {
    throw new Error('release_activity_unknown');
  }

  return ancestry;
}

/**
 * Installed CLI из окна, сервера или их потомков не может остановить
 * собственный origin. Все ancestor executable проверяются без /proc.
 */
export async function assertOutsideDarwinOwner(receipt: InstallationReceipt): Promise<void> {
  const self = await probe(receipt, process.pid);

  if (self.state !== 'alive') {
    throw new Error('release_activity_unknown');
  }

  const workerRoot = path.join(dataPath(receipt.dataHome, 'serverRuntime'), 'packages') + '/';

  for (const parent of await ancestors(receipt, self.identity)) {
    if (installationCandidate(parent.executable, 'darwin') === receipt.root
      || parent.executable.startsWith(workerRoot) && parent.executable.endsWith('/runtime/node/bin/node')) {
      throw new Error('release_command_inside_owner');
    }
  }
}

/**
 * HTTP PID может быть worker. Отдельный SEA parent и затем desktop
 * подтверждаются точными executable, PID и инкарнацией.
 */
export async function identifyDarwinServerOwner(
  receipt: InstallationReceipt,
  paths: Awaited<ReturnType<typeof darwinServerPaths>>,
  pid: number,
  owner: string,
  launchdPid: number | null,
) {
  const serving = await probe(receipt, pid);

  if (serving.state !== 'alive' || ![paths.binary, paths.worker].includes(serving.identity.executable)
    || await fs.realpath(serving.identity.executable) !== serving.identity.executable) {
    throw new Error('release_server_owner_invalid');
  }

  const { identity } = serving;
  const parents = await ancestors(receipt, identity);
  const launcher = identity.executable === paths.binary ? identity
    : parents.find((entry) => entry.executable === paths.binary);

  if (!launcher) {
    throw new Error('release_server_owner_invalid');
  }

  if (launchdPid !== null) {
    if (launchdPid !== launcher.pid) {
      throw new Error('release_server_owner_invalid');
    }

    return {
      kind: 'service' as const,
      serving: identity,
      launcher,
    };
  }

  if (owner === 'desktop' && paths.desktop) {
    if (!parents.some((entry) => entry.executable === paths.desktop && entry.pid === launcher.ppid)) {
      throw new Error('release_server_owner_invalid');
    }

    return {
      kind: 'desktop' as const,
      serving: identity,
      launcher,
    };
  }

  const lease = await liveDarwinServerLease(receipt, paths.binary);

  if (!lease || lease.record.kind !== 'manual' || lease.identity.pid !== launcher.pid
    || lease.record.starttime !== launcher.starttime) {
    throw new Error('release_manual_owner_unknown');
  }

  return {
    kind: 'manual' as const,
    serving: identity,
    launcher,
  };
}

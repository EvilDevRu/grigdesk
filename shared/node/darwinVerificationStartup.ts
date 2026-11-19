import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';

import { canonicalJson } from '../lib/canonicalJson.ts';
import { acquireInstallLock } from './binaryInstall.ts';
import { darwinServerPaths, liveDarwinServerLease } from './darwinInstalledOwner.ts';
import type { DarwinServiceReceipt } from './darwinServiceRegistration.ts';
import { inspectInstalledServer, serverSettings, stopInstalledServerFromCli } from './installedServer.ts';
import type { InstalledServerOwner } from './installedServer.ts';
import type { InstallationReceipt } from './installedLayout.ts';
import { darwinInstalledService, stopDarwinInstalledService } from './launchdInstalledService.ts';
import type { DarwinServiceState } from './launchdInstalledService.ts';
import {
  findDarwinDesktopProcesses, readDarwinProcessCensus, readDarwinProcessIdentity, signalDarwinBuildMember,
  type DarwinProcessIdentity,
} from './processIdentity.ts';

export interface DarwinVerificationBinding {
  installationId: string;
  port: number;
  registration: DarwinServiceReceipt;
}

/**
 * Очищает один запуск под тем же lock, которым пользуется Start.
 * Живой API требует штатный Stop и прежнюю инкарнацию, если её уже подтвердил Start.
 */
export async function stopDarwinVerificationServer(receipt: InstallationReceipt,
  binding: DarwinVerificationBinding, expected: InstalledServerOwner | null): Promise<void> {
  const { root, installationId } = receipt;

  if (process.platform !== 'darwin' || receipt.mode === 'remote' || !binding
    || Object.keys(binding).sort().join(',') !== 'installationId,port,registration'
    || binding.installationId !== installationId || !Number.isSafeInteger(binding.port)
    || binding.port <= 0 || binding.port > 65535 || [8140, 8144].includes(binding.port)
    || (await serverSettings(receipt)).port !== binding.port) {
    throw new Error('dist_verification_service_scope_invalid');
  }

  const maintenance = path.join(root, 'update/maintenance');
  const launch = await acquireInstallLock(path.join(root, 'update/server-launch'), {
    waitMs: 5_000,
    darwinMaintenance: maintenance,
  });

  try {
    const { binary, worker } = await darwinServerPaths(receipt);
    const service = await darwinInstalledService(receipt);

    if (canonicalJson(service.registration.receipt) !== canonicalJson(binding.registration)) {
      throw new Error('dist_verification_service_scope_invalid');
    }

    const live = await inspectInstalledServer(receipt).catch((error: Error) => {
      if (expected === null && error.message === 'release_server_starting') {
        return null;
      }

      throw error;
    });

    if (expected !== null && (expected.running !== true || canonicalJson(live) !== canonicalJson(expected))
      || live?.running && (live.kind !== 'service' && live.kind !== 'manual')) {
      throw new Error('dist_verification_startup_owner_unknown');
    }

    if (live?.running) {
      await stopInstalledServerFromCli(receipt, live);
    } else {
      await stopBeforeApi(receipt, service, {
        binary,
        worker,
        maintenance,
      });
    }

    const remaining = await darwinInstalledService(receipt);
    const matches = await Promise.all([binary, worker, maintenance].map(findDarwinDesktopProcesses));
    const processes = matches.flat();

    if (remaining.state === 'loaded' || processes.some((pid) => pid !== process.pid)
      || (await inspectInstalledServer(receipt)).running) {
      throw new Error('dist_verification_startup_owner_unknown');
    }
  } finally {
    await launch.release();
  }
}

/**
 * До появления API использует сохранённый lease и проверенную регистрацию.
 * Manual-сессия подтверждается целиком, служба снимается по своему Label.
 */
async function stopBeforeApi(receipt: InstallationReceipt, service: DarwinServiceState,
  paths: {
    binary: string;
    worker: string;
    maintenance: string;
  }): Promise<void> {
  const lease = await liveDarwinServerLease(receipt, paths.binary);
  const owner = lease?.identity;
  const exclusiveSession = service.state !== 'loaded';
  const signal = AbortSignal.timeout(15_000);

  if (service.state === 'loaded' && (service.startScheduled || service.pid !== (owner?.pid ?? null)
    || lease && lease.record.kind !== 'service')
    || exclusiveSession && lease && (lease.record.kind !== 'manual' || owner?.sid !== owner?.pid)) {
    throw new Error('dist_verification_startup_owner_unknown');
  }

  const members = owner
    ? await startupMembers(owner, paths.worker, paths.maintenance, exclusiveSession, signal) : [];

  if (service.state === 'loaded') {
    await stopDarwinInstalledService(receipt, owner ?? null, service.registration.receipt);
  } else if (owner) {
    for (const child of members) {
      await signalDarwinBuildMember(child, 'TERM', signal);
    }

    await signalDarwinBuildMember(owner, 'TERM', signal);
  }

  const witnessed = owner ? [...members, owner] : members;

  while (witnessed.length > 0) {
    signal.throwIfAborted();

    const expected = witnessed.at(-1)!;
    const actual = await readDarwinProcessIdentity(expected.pid, paths.maintenance);

    if (actual.state === 'unknown') {
      throw new Error('dist_verification_startup_owner_unknown');
    }
    if (actual.state === 'dead'
      || actual.state === 'alive' && actual.identity.starttime !== expected.starttime) {
      witnessed.pop();
    } else {
      await pause(100, undefined, { signal });
    }
  }

  if (owner && exclusiveSession
    && (await readDarwinProcessCensus(signal)).some((entry) => entry.sid === owner.sid)) {
    throw new Error('dist_verification_startup_owner_unknown');
  }
}

/**
 * Known startup children must belong to the exact launcher PID incarnation.
 * An unrecognized member closes the cleanup before any signal is sent.
 */
async function startupMembers(owner: DarwinProcessIdentity, worker: string, maintenance: string,
  exclusiveSession: boolean, signal: AbortSignal): Promise<DarwinProcessIdentity[]> {
  const result: DarwinProcessIdentity[] = [];

  for (const candidate of await readDarwinProcessCensus(signal)) {
    if (candidate.sid !== owner.sid || candidate.pid === owner.pid
      || !exclusiveSession && candidate.ppid !== owner.pid) {
      continue;
    }

    const live = await readDarwinProcessIdentity(candidate.pid, maintenance);

    if (live.state === 'dead') {
      continue;
    }
    if (live.state !== 'alive' || live.identity.starttime !== candidate.starttime
      || live.identity.ppid !== owner.pid || live.identity.sid !== owner.sid
      || live.identity.executable !== worker) {
      throw new Error('dist_verification_startup_owner_unknown');
    }

    result.push(live.identity);
  }

  return result;
}

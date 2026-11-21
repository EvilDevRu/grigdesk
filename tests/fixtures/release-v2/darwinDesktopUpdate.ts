import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';

import { canonicalJson } from '../../../shared/lib/canonicalJson.ts';
import { assertInstallationReleaseTrust, MAC_APP_EXECUTABLE } from '../../../shared/node/bundleLayout.ts';
import { rollbackAttemptPattern } from '../../../shared/node/darwinRollbackAttempt.ts';
import type { InstallationReceipt } from '../../../shared/node/installedLayout.ts';
import {
  assertInstallationPath, readInstallationJson, readInstalledPointer, writeInstallationJson,
} from '../../../shared/node/installedLayout.ts';
import { launchInstalledProcess } from '../../../shared/node/installedProcess.ts';
import { verifyReleaseEnvelope } from '../../../shared/node/releaseTrust.ts';
import { findDarwinDesktopProcesses, readDarwinProcessIdentity }
  from '../../../shared/node/processIdentity.ts';
import { readUpdateProcess } from '../../../shared/node/updateProcessOwner.ts';
import type { InstalledUpdateJob } from '../../../shared/node/installedUpdateState.ts';
import { readInstalledUpdate } from '../../../shared/node/installedUpdateState.ts';

const intentFile = 'update/desktop-launch-intent.json';
const processFile = 'update/desktop-launch-process.json';

type Owner = Awaited<ReturnType<typeof readUpdateProcess>>;

interface DesktopLaunch {
  format: 1;
  installationId: string;
  jobId: string;
  nonce: string;
  attempt: string;
  relative: string;
  executable: string;
  worker: Owner;
}

const maintenance = (receipt: InstallationReceipt) => path.join(receipt.root, 'update/maintenance');

/**
 * Чужая или повреждённая запись не выглядит как потерянный запуск.
 * Лишь отсутствие файла возвращает null для незавершённого handoff.
 */
async function optionalLaunchFile(root: string, file: string): Promise<unknown> {
  return readInstallationJson(root, file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return null;
    }

    throw error;
  });
}

/**
 * Intent закрепляет точный generation path и executable независимо от команды shell.
 * Только допустимый relative из исходной пары разрешает запуск.
 */
function decodeLaunch(receipt: InstallationReceipt, job: InstalledUpdateJob, value: unknown) {
  const bound = value as DesktopLaunch;

  const fields = 'attempt,executable,format,installationId,jobId,nonce,relative,worker';

  if (!bound || Object.keys(bound).sort().join(',') !== fields
    || bound.format !== 1 || bound.installationId !== receipt.installationId
    || bound.jobId !== job.id || !job.intent || bound.nonce !== job.intent.nonce
    || !rollbackAttemptPattern.test(bound.attempt)
    || ![job.target.desktop, job.previous.desktop].includes(bound.relative)
    || !bound.worker || bound.worker.executable !== maintenance(receipt)
    || !Number.isSafeInteger(bound.worker.pid) || bound.worker.pid <= 1
    || !/^[0-9]{7,26}$/u.test(bound.worker.starttime)
    || bound.executable !== path.join(receipt.root, bound.relative, MAC_APP_EXECUTABLE)) {
    throw new Error('release_desktop_launch_invalid');
  }

  return bound;
}

/**
 * PID в записи принадлежит дочернему maintenance до execve. Старый launch
 * record другого attempt не даёт ему новое разрешение на запуск.
 */
async function readLaunchProcess(receipt: InstallationReceipt, launch: DesktopLaunch): Promise<Owner | null> {
  const report = await optionalLaunchFile(receipt.root, processFile) as {
    intent: DesktopLaunch;
    process: Owner;
  } | null;

  if (!report || report.intent?.attempt !== launch.attempt) {
    return null;
  }

  const owner = report.process;

  if (canonicalJson(launch) !== canonicalJson(report.intent) || !owner
    || !Number.isSafeInteger(owner.pid) || owner.pid <= 1 || !/^[0-9]{7,26}$/u.test(owner.starttime)
    || owner.executable !== maintenance(receipt)) {
    throw new Error('release_desktop_launch_invalid');
  }

  return owner;
}

/**
 * До spawn записывает разрешённое поколение, затем ждёт запись ребёнка
 * и live native identity. Только после fsync dispatch выдаёт permit.
 */
export async function launchDarwinUpdatedDesktop(
  receipt: InstallationReceipt, job: InstalledUpdateJob, rollback: boolean,
): Promise<void> {
  const relative = (rollback ? job.previous : job.target).desktop;

  if (!relative || !job.intent || (await readInstalledPointer(receipt)).desktop !== relative) {
    throw new Error('release_desktop_launch_invalid');
  }

  const executable = await assertInstallationPath(receipt.root, relative + '/' + MAC_APP_EXECUTABLE);
  const attempt = randomUUID();
  const launch: DesktopLaunch = {
    format: 1,
    installationId: receipt.installationId,
    jobId: job.id,
    nonce: job.intent.nonce,
    attempt,
    relative,
    executable,
    worker: await readUpdateProcess(process.pid, maintenance(receipt)),
  };

  await writeInstallationJson(receipt.root, intentFile, launch);
  await launchInstalledProcess(receipt, ['launch-update-desktop', job.id, attempt], 'desktop-' + attempt,
    async (child) => {
      const deadline = Date.now() + 10_000;

      while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
        const record = await readLaunchProcess(receipt, launch);

        if (record) {
          const actual = await readUpdateProcess(record.pid, maintenance(receipt));

          if (child.pid !== record.pid || canonicalJson(actual) !== canonicalJson(record) || !child.stdin) {
            throw new Error('release_desktop_launch_invalid');
          }

          const flushed = once(child.stdin, 'finish');

          child.stdin.end(Buffer.from([1]));
          await flushed;

          return;
        }

        await pause(75);
      }

      throw new Error('release_desktop_launch_unconfirmed');
    });
}

/**
 * Child публикует PID до чтения stdin. EOF, лишние байты или смена current
 * завершают его до execve окна, в том числе после гибели worker.
 */
export async function acceptDarwinDesktopLaunch(
  receipt: InstallationReceipt, jobId: string, attempt: string,
): Promise<void> {
  assertInstallationReleaseTrust(receipt);

  const job = await readInstalledUpdate(receipt);

  if (!job?.intent || job.id !== jobId || job.scope === 'server'
    || !['applying', 'starting', 'stopping'].includes(job.stage)
    || verifyReleaseEnvelope(job.envelope) !== job.manifestDigest) {
    throw new Error('release_desktop_launch_invalid');
  }

  const launch = decodeLaunch(receipt, job, await optionalLaunchFile(receipt.root, intentFile));
  const current = await readInstalledPointer(receipt);
  const self = await readDarwinProcessIdentity(process.pid);
  const worker = await readUpdateProcess(launch.worker.pid, maintenance(receipt));

  if (launch.attempt !== attempt || launch.relative !== current.desktop
    || self.state !== 'alive' || self.identity.ppid !== worker.pid
    || self.identity.executable !== maintenance(receipt)
    || canonicalJson(worker) !== canonicalJson(launch.worker)) {
    throw new Error('release_desktop_launch_invalid');
  }

  await writeInstallationJson(receipt.root, processFile, {
    intent: launch,
    process: {
      pid: self.identity.pid,
      starttime: self.identity.starttime,
      executable: self.identity.executable,
    },
  });

  let permitted = false;

  for await (const chunk of process.stdin) {
    if (permitted || chunk.length !== 1 || chunk[0] !== 1) {
      throw new Error('release_desktop_launch_unconfirmed');
    }

    permitted = true;
  }

  if (!permitted || canonicalJson(await readInstalledPointer(receipt)) !== canonicalJson(current)) {
    throw new Error('release_desktop_launch_unconfirmed');
  }
}

/**
 * Boot ACK можно засчитать только для заранее зарегистрированного child,
 * чей PID после execve принадлежит тому же экземпляру выбранного окна.
 */
export async function matchesDarwinDesktopBoot(
  receipt: InstallationReceipt, job: InstalledUpdateJob, boot: Owner,
): Promise<boolean> {
  const raw = await optionalLaunchFile(receipt.root, intentFile) as DesktopLaunch | null;

  if (!raw || raw.jobId !== job.id) {
    return false;
  }

  const launch = decodeLaunch(receipt, job, raw);
  const owner = await readLaunchProcess(receipt, launch);

  return owner?.pid === boot.pid && owner.starttime === boot.starttime
    && launch.executable === boot.executable;
}

/**
 * Rollback останавливает лишь заранее зарегистрированный новый executable.
 * Любое другое живое окно данного поколения закрывает recovery до сигнала.
 */
export async function stopDarwinUpdatedDesktop(receipt: InstallationReceipt, job: InstalledUpdateJob) {
  const relative = (await readInstalledPointer(receipt)).desktop;

  if (!relative) {
    return;
  }

  const executable = await assertInstallationPath(receipt.root, relative + '/' + MAC_APP_EXECUTABLE);
  const raw = await optionalLaunchFile(receipt.root, intentFile) as DesktopLaunch | null;
  const launch = raw?.jobId === job.id ? decodeLaunch(receipt, job, raw) : null;
  const owner = launch?.relative === relative ? await readLaunchProcess(receipt, launch) : null;
  const live = await findDarwinDesktopProcesses(executable);

  if (live.some((pid) => pid !== owner?.pid)) {
    throw new Error('release_desktop_owner_unknown');
  }

  if (!owner) {
    return;
  }

  const identity = async () => readUpdateProcess(owner.pid, maintenance(receipt))
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ESRCH') {
        return null;
      }

      throw error;
    });
  const actual = await identity();

  if (!actual || actual.starttime !== owner.starttime) {
    return;
  }

  if (actual.executable !== executable || !live.includes(owner.pid)) {
    throw new Error('release_desktop_owner_unknown');
  }

  process.kill(owner.pid, 'SIGTERM');

  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    const current = await identity();

    if (!current || current.starttime !== owner.starttime) {
      return;
    }

    if (current.executable !== executable) {
      throw new Error('release_desktop_owner_unknown');
    }

    await pause(150);
  }

  throw new Error('release_desktop_exit_timeout');
}

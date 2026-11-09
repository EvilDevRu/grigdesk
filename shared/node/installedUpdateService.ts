import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { ReleaseEnvelope } from '../runtime/installedUpdateContracts.ts';
import { compareProductVersions, type ReleaseChannel } from '../runtime/productReleaseVersion.ts';
import { ReleaseChannelService } from './releaseChannel.ts';
import { verifyReleaseEnvelope } from './releaseTrust.ts';
import { readInstallation, readInstalledPointer, writeInstallationJson,
  readInstallationJson } from './installedLayout.ts';
import { readInstalledUpdate, PENDING_UPDATE_STAGES } from './installedUpdateState.ts';
import type { InstalledUpdateJob } from './installedUpdateState.ts';
import { InstalledUpdateManager } from './installedUpdate.ts';
import { acquireInstallLock } from './binaryInstall.ts';
import { readUpdateProcess } from './updateProcessOwner.ts';

const execute = promisify(execFile);

export interface InstalledUpdateCheck {
  state: 'unknown' | 'checking' | 'current' | 'available' | 'error';
  checkedAt: string | null;
  error: string | null;
  envelope: ReleaseEnvelope | null;
  manifestDigest: string | null;
}

/**
 * Пробы запускают только проверенные байты в отдельной HOME и папке данных.
 * Ответ должен подтвердить identity компонента, а не просто успешный exit code.
 * Шум запуска в stderr (например, ERROR dbus/bus.cc у Electron без DBUS-адреса)
 * не свидетельствует о подмене: он логируется рядом с заданием, но не проваливает проверку.
 */
export async function probeInstalledComponent(
  component: 'desktop' | 'server',
  directory: string,
  job: InstalledUpdateJob,
): Promise<void> {
  const work = path.join(path.dirname(directory), `probe-${component}`);
  const logFile = path.join(path.dirname(directory), `probe-${component}.log`);

  await fs.mkdir(work, { recursive: true, mode: 0o700 });

  const binary = path.join(directory, component === 'server' ? 'bin/grigdesk-server' : 'GrigDesk');
  const args = component === 'server' ? ['--version', '--json'] : ['--grigdesk-release-probe'];

  /**
   * Вывод пробы сохраняется рядом с заданием до любого отказа: в job.error остаётся
   * только код, а разбор сбоя без фактических байтов вывода невозможен.
   */
  const saveLog = async (result: { stdout: string; stderr: string } | null,
    failure: string | null): Promise<void> => {
    await fs.writeFile(logFile, JSON.stringify({
      component,
      binary,
      args,
      failure,
      stdout: result?.stdout ?? null,
      stderr: result?.stderr ?? null,
    }, null, 2) + '\n', { mode: 0o600 });
  };

  let result;

  try {
    result = await execute(binary, args, {
      cwd: work,
      timeout: 30_000,
      maxBuffer: 65536,
      env: {
        HOME: work,
        GRIGDESK_HOME: work,
        PATH: '/usr/bin:/bin',
        LANG: 'C.UTF-8',
      },
    });
  } catch (error) {
    await saveLog(null, error instanceof Error ? error.message : 'probe_launch_failed')
      .catch(() => {});

    throw error;
  }

  await saveLog(result, null).catch(() => {});

  let identity: {
    version?: string;
    packageId?: string;
    releaseId?: string;
  };

  try {
    identity = JSON.parse(result.stdout) as typeof identity;
  } catch {
    throw new Error('release_component_probe_invalid');
  }

  const payload = job.envelope.payload;

  if (identity.version !== payload.version
    || component === 'server' && identity.packageId !== payload.artifacts.server.packageId
    || component === 'desktop' && identity.releaseId !== payload.releaseId) {
    throw new Error('release_component_probe_invalid');
  }
}

/**
 * Desktop и CLI используют один канал, trust и менеджер подготовки.
 * Локальный status не обращается к сети и остаётся доступен при выключенном сервере.
 */
export class InstalledUpdateService {
  private readonly root: string;

  private readonly publicKeyPem: string | undefined;

  private readonly channels = new Map<ReleaseChannel, ReleaseChannelService>();

  private check: InstalledUpdateCheck = {
    state: 'unknown',
    checkedAt: null,
    error: null,
    envelope: null,
    manifestDigest: null,
  };

  private checkedChannel: ReleaseChannel | null = null;

  constructor(root: string, publicKeyPem?: string) {
    this.root = root;
    this.publicKeyPem = publicKeyPem;
  }

  /**
   * Локальный снимок не подменяет реально запущенную версию установленным указателем.
   * Current здесь намеренно называется installed; boot identity добавляет сам desktop.
   */
  async status() {
    const receipt = await readInstallation(this.root);
    const pointer = await readInstalledPointer(receipt);
    const job = await readInstalledUpdate(receipt);
    let workerActive = false;

    if (job && ['queued', 'verifying', 'downloading', 'preparing', 'stopping', 'applying', 'starting']
      .includes(job.stage)) {
      const marker = ['queued', 'verifying', 'downloading', 'preparing'].includes(job.stage)
        ? 'prepare-process.json' : 'worker-process.json';

      try {
        const saved = await readInstallationJson(this.root, `update/${marker}`) as {
          jobId: string;
          process: {
            pid: number;
            starttime: string;
            executable: string;
          };
        };
        const actual = await readUpdateProcess(saved.process.pid);

        workerActive = saved.jobId === job.id && actual.starttime === saved.process.starttime
          && actual.executable === saved.process.executable;
      } catch {
        // Это только подсказка кнопке resume: mutation всё равно требует installation lock.
      }
    }

    if (this.check.state !== 'checking') {
      try {
        const cache = await readInstallationJson(this.root, 'update/check.json') as {
          channel: ReleaseChannel; check: InstalledUpdateCheck;
        };

        if (cache.channel === receipt.channel
          && ['current', 'available', 'error'].includes(cache.check.state)) {
          if (cache.check.envelope) {
            verifyReleaseEnvelope(cache.check.envelope, this.publicKeyPem);

            if (cache.check.envelope.payload.channel !== cache.channel) {
              throw new Error('release_channel_mismatch');
            }
          }

          this.check = cache.check;
          this.checkedChannel = cache.channel;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          this.check = {
            ...this.check,
            state: 'error',
            error: 'release_cache_invalid',
          };
        }
      }
    }

    if (this.checkedChannel && this.checkedChannel !== receipt.channel) {
      this.check = {
        state: 'unknown',
        checkedAt: null,
        error: null,
        envelope: null,
        manifestDigest: null,
      };
    }

    const versions = (receipt.mode === 'local' ? [pointer.desktop, pointer.server]
      : [receipt.mode === 'server' ? pointer.server : pointer.desktop])
      .filter((part): part is string => part !== null).map((part) => part.split('/')[1]!);

    if (['current', 'available'].includes(this.check.state)) {
      const version = this.check.envelope?.payload.version;

      this.check.state = version && versions.every((part) => compareProductVersions(version, part) >= 0)
        && versions.some((part) => compareProductVersions(version, part) > 0) ? 'available' : 'current';
    }

    return {
      channel: receipt.channel,
      mode: receipt.mode,
      installed: {
        desktop: pointer.desktop?.split('/')[1] ?? null,
        server: pointer.server?.split('/')[1] ?? null,
      },
      check: this.check,
      job,
      workerActive,
    };
  }

  /**
   * Ошибка проверки сохраняет последний успешный envelope с отдельным состоянием error.
   * Вызывающий UI не должен выдавать этот устаревший envelope за свежую доступную цель.
   */
  async checkUpdates(force = true): Promise<void> {
    const receipt = await readInstallation(this.root);
    let channel = this.channels.get(receipt.channel);

    this.checkedChannel = receipt.channel;

    if (!channel) {
      channel = new ReleaseChannelService({ channel: receipt.channel, publicKeyPem: this.publicKeyPem });
      this.channels.set(receipt.channel, channel);
    }

    this.check = {
      ...this.check,
      state: 'checking',
      error: null,
    };

    try {
      const envelope = await channel.latest(force);
      const pointer = await readInstalledPointer(receipt);
      const current = (receipt.mode === 'server' ? pointer.server : pointer.desktop)?.split('/')[1];

      this.check = {
        state: envelope && current && compareProductVersions(envelope.payload.version, current) > 0
          ? 'available' : 'current',
        checkedAt: new Date().toISOString(),
        error: null,
        envelope,
        manifestDigest: envelope ? verifyReleaseEnvelope(envelope, this.publicKeyPem) : null,
      };
    } catch (error) {
      this.check = {
        ...this.check,
        state: 'error',
        error: error instanceof Error ? error.message : 'release_channel_unavailable',
      };
    }

    await writeInstallationJson(this.root, 'update/check.json', {
      channel: receipt.channel, check: this.check,
    });
  }

  manager(): InstalledUpdateManager {
    return new InstalledUpdateManager({
      root: this.root,
      publicKeyPem: this.publicKeyPem,
      probe: probeInstalledComponent,
    });
  }

  /**
   * Явная смена канала не ретаргетит сохранённое задание и не разрешает downgrade.
   * Проверка и обновление receipt сериализуются тем же installation lock.
   */
  async setChannel(channel: ReleaseChannel): Promise<void> {
    const receipt = await readInstallation(this.root);
    const lock = await acquireInstallLock(path.join(this.root, 'update/installation'), { waitMs: 0 });

    try {
      const job = await readInstalledUpdate(receipt);

      if (!['release', 'dev'].includes(channel) || job && PENDING_UPDATE_STAGES.includes(job.stage)) {
        throw new Error('release_update_in_progress');
      }

      await writeInstallationJson(this.root, 'installation.json', { ...receipt, channel });
      this.check = {
        state: 'unknown',
        checkedAt: null,
        error: null,
        envelope: null,
        manifestDigest: null,
      };
    } finally {
      await lock.release();
    }
  }
}

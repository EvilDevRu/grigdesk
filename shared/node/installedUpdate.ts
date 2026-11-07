import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { canonicalJson } from '../lib/canonicalJson.ts';
import { compareProductVersions } from '../runtime/productReleaseVersion.ts';
import type { ReleaseChannel } from '../runtime/productReleaseVersion.ts';
import type { ReleaseEnvelope } from '../runtime/installedUpdateContracts.ts';
import { checkReleaseCompatibility } from '../runtime/releaseCompatibility.ts';
import { acquireInstallLock } from './binaryInstall.ts';
import { sha256File } from './hash.ts';
import { ReleaseChannelService } from './releaseChannel.ts';
import { verifyReleaseEnvelope } from './releaseTrust.ts';
import { downloadReleaseArtifact, extractReleaseArtifact } from './releaseArchive.ts';
import { readInstallation, readInstalledPointer, assertInstallationPath } from './installedLayout.ts';
import type { InstallationReceipt } from './installedLayout.ts';
import { readInstalledUpdate, saveInstalledUpdate, PENDING_UPDATE_STAGES } from './installedUpdateState.ts';
import type { InstalledUpdateJob, UpdateScope } from './installedUpdateState.ts';

export interface InstalledUpdateOptions {
  root: string;
  channel?: { latest(force?: boolean): Promise<ReleaseEnvelope | null> };
  publicKeyPem?: string;
  fetcher?: typeof fetch;
  probe(component: 'desktop' | 'server', directory: string, job: InstalledUpdateJob): Promise<void>;
}

/**
 * До подготовки и перед применением резервируется место для архивов, распаковки и журнала.
 * Ошибка statfs не считается достаточностью ресурсов и не разрешает остановку программы.
 */
export async function assertUpdateSpace(root: string, job: InstalledUpdateJob): Promise<void> {
  const space = await fs.statfs(root);
  const bytes = updateComponents(job.scope).reduce((sum, component) => {
    const artifact = job.envelope.payload.artifacts[component];

    return sum + artifact.size + artifact.unpackedSize;
  }, 64 * 1024 * 1024);

  if (space.bavail * space.bsize < bytes) {
    throw new Error('release_disk_space_insufficient');
  }
}

function updateComponents(scope: UpdateScope): ('desktop' | 'server')[] {
  return scope === 'pair' ? ['desktop', 'server'] : [scope];
}

/**
 * Установка имеет один journal и один lock для приложения, CLI и внешнего worker.
 * Подготовка оставляет current и работающие процессы неизменными до отдельного согласия.
 */
export class InstalledUpdateManager {
  private readonly options: InstalledUpdateOptions;

  constructor(options: InstalledUpdateOptions) {
    this.options = options;
  }

  /**
   * Повтор с requestId возвращает прежнюю цель, даже если сайт уже опубликовал следующую.
   * Новое задание сверяет свежий подписанный digest под общим installation lock.
   */
  async createJob(request: {
    requestId: string;
    manifestDigest: string;
    scope: UpdateScope;
  }): Promise<InstalledUpdateJob> {
    const receipt = await readInstallation(this.options.root);

    await fs.mkdir(path.join(receipt.root, 'update'), { recursive: true, mode: 0o700 });
    await assertInstallationPath(receipt.root, 'update');

    const lock = await acquireInstallLock(path.join(receipt.root, 'update/installation'), { waitMs: 0 });

    try {
      const previousJob = await readInstalledUpdate(receipt);

      if (previousJob?.requestId === request.requestId) {
        return previousJob;
      }

      if (previousJob && PENDING_UPDATE_STAGES.includes(previousJob.stage)) {
        throw new Error('release_update_in_progress');
      }

      if (!request.requestId || request.requestId.length > 128
        || !['pair', 'desktop', 'server'].includes(request.scope)
        || receipt.mode === 'remote' && request.scope !== 'desktop'
        || receipt.mode === 'server' && request.scope !== 'server'
        || receipt.mode === 'local' && request.scope === 'server') {
        throw new Error('pair_update_required');
      }

      const channel = this.options.channel ?? new ReleaseChannelService({
        channel: receipt.channel, publicKeyPem: this.options.publicKeyPem,
      });
      const envelope = await channel.latest(true);

      if (!envelope || envelope.payload.channel !== receipt.channel
        || verifyReleaseEnvelope(envelope, this.options.publicKeyPem) !== request.manifestDigest) {
        throw new Error('release_target_changed');
      }

      const previous = await readInstalledPointer(receipt);
      const components = updateComponents(request.scope);

      let newer = false;

      for (const component of components) {
        const installed = previous[component]?.split('/')[1];

        if (!installed || compareProductVersions(envelope.payload.version, installed) < 0) {
          throw new Error('release_not_newer');
        }

        newer ||= compareProductVersions(envelope.payload.version, installed) > 0;
      }

      if (!newer) {
        throw new Error('release_not_newer');
      }

      const target = { ...previous };

      for (const component of components) {
        target[component] = `generations/${envelope.payload.version}/${component}`;
      }

      const now = new Date().toISOString();
      const job: InstalledUpdateJob = {
        format: 1,
        id: randomUUID(),
        requestId: request.requestId,
        installationId: receipt.installationId,
        manifestDigest: request.manifestDigest,
        envelope,
        scope: request.scope,
        previous,
        target,
        stage: 'queued',
        createdAt: now,
        updatedAt: now,
        progress: null,
        error: null,
        intent: null,
      };

      await assertUpdateSpace(receipt.root, job);
      await saveInstalledUpdate(receipt, job);

      return job;
    } finally {
      await lock.release();
    }
  }

  /**
   * Worker использует сохранённый envelope и продолжает только своё installation-bound задание.
   * После ready повторная команда не скачивает и не устанавливает те же компоненты.
   */
  async prepare(jobId: string): Promise<InstalledUpdateJob> {
    const receipt = await readInstallation(this.options.root);
    const lock = await acquireInstallLock(path.join(receipt.root, 'update/installation'), { waitMs: 0 });
    let job: InstalledUpdateJob | null = null;

    try {
      job = await readInstalledUpdate(receipt);

      if (!job || job.id !== jobId) {
        throw new Error('release_job_mismatch');
      }

      if (job.stage === 'ready') {
        return job;
      }

      if (!['queued', 'verifying', 'downloading', 'preparing', 'failed'].includes(job.stage) || job.intent) {
        throw new Error('release_job_stage_invalid');
      }

      job.error = null;
      job.stage = 'verifying';
      await saveInstalledUpdate(receipt, job);

      if (verifyReleaseEnvelope(job.envelope, this.options.publicKeyPem) !== job.manifestDigest
        || canonicalJson(await readInstalledPointer(receipt)) !== canonicalJson(job.previous)) {
        throw new Error('release_target_changed');
      }

      const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } };
      const glibc = report.header?.glibcVersionRuntime;
      const minimum = job.envelope.payload.platform.glibc;
      const compare = (version: string) => version.split('.').map(Number);
      const [major = 0, minor = 0] = compare(glibc ?? '0.0');
      const [minMajor = 0, minMinor = 0] = compare(minimum);

      if (process.platform !== 'linux' || process.arch !== 'x64' || !glibc
        || major < minMajor || major === minMajor && minor < minMinor) {
        throw new Error('release_platform_incompatible');
      }

      const compatibility = checkReleaseCompatibility({
        candidate: job.envelope.payload,
        scope: job.scope === 'desktop' ? 'pair' : job.scope,
      });

      if (!compatibility.compatible) {
        throw new Error(compatibility.reason!);
      }

      await assertUpdateSpace(receipt.root, job);

      const work = path.join(receipt.root, 'update', job.id);

      await fs.mkdir(work, { recursive: true, mode: 0o700 });
      await assertInstallationPath(receipt.root, `update/${job.id}`);

      const components = updateComponents(job.scope);
      const totalBytes = components.reduce(
        (sum, part) => sum + job!.envelope.payload.artifacts[part].size, 0,
      );
      let downloadedBytes = 0;

      for (const component of components) {
        const artifact = job.envelope.payload.artifacts[component];
        const archive = path.join(work, `${component}.tar.gz`);

        job.stage = 'downloading';
        job.progress = { downloadedBytes, totalBytes };
        await saveInstalledUpdate(receipt, job);

        if (await sha256File(archive).catch(() => '') !== artifact.sha256) {
          await fs.rm(archive, { force: true });

          let savedAt = 0;

          await downloadReleaseArtifact({
            artifact,
            destination: archive,
            fetcher: this.options.fetcher,
            progress: async (bytes) => {
              job!.progress = { downloadedBytes: downloadedBytes + bytes, totalBytes };

              if (Date.now() - savedAt >= 250 || bytes === artifact.size) {
                savedAt = Date.now();
                await saveInstalledUpdate(receipt, job!);
              }
            },
          });
        }

        downloadedBytes += artifact.size;
        job.stage = 'preparing';
        await saveInstalledUpdate(receipt, job);

        const directory = path.join(work, component);

        await fs.rm(directory, { recursive: true, force: true });
        await extractReleaseArtifact(archive, directory, artifact);
        await this.options.probe(component, directory, job);
      }

      job.stage = 'ready';
      await saveInstalledUpdate(receipt, job);

      return job;
    } catch (error) {
      if (job && ['queued', 'verifying', 'downloading', 'preparing'].includes(job.stage)) {
        job.stage = 'failed';
        job.error = {
          code: error instanceof Error ? error.message : 'release_prepare_failed',
          nextAction: 'resume-update',
        };
        await saveInstalledUpdate(receipt, job);
      }

      throw error;
    } finally {
      await lock.release();
    }
  }
}

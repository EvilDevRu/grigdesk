import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { canonicalJson } from '../../../shared/lib/canonicalJson.ts';
import { compareProductVersions } from '../../../shared/runtime/productReleaseVersion.ts';
import type { ReleaseChannel } from '../../../shared/runtime/productReleaseVersion.ts';
import type { ReleaseArtifact, ReleaseEnvelope } from '../../../shared/runtime/installedUpdateContracts.ts';
import { checkReleaseCompatibility } from '../../../shared/runtime/releaseCompatibility.ts';
import { sha256File } from '../../../shared/node/hash.ts';
import { assertReleasePlatform, ReleaseChannelService } from '../../../shared/node/releaseChannel.ts';
import { verifyReleaseEnvelope } from '../../../shared/node/releaseTrust.ts';
import { downloadReleaseArtifact, extractReleaseArtifact, releaseArtifactDiskBytes }
  from '../../../shared/node/releaseArchive.ts';
import { materializeMacDesktop } from '../../../shared/node/macosAppArchive.ts';
import {
  acquireInstalledUpdateLock, readInstallation, readInstalledPointer, assertInstallationPath,
  readInstallationJson,
} from '../../../shared/node/installedLayout.ts';
import type { InstallationReceipt } from '../../../shared/node/installedLayout.ts';
import { assertInstallationReleaseTrust } from '../../../shared/node/bundleLayout.ts';
import { copyInstallFile, lstatOrNull } from '../../../shared/node/binaryInstall.ts';
import { syncDirectory } from '../../../shared/node/files.ts';
import { verifyInstalledGeneration } from './installedUpdateApply.ts';
import { readUpdateProcess } from '../../../shared/node/updateProcessOwner.ts';
import { readInstalledUpdate, saveInstalledUpdate, PENDING_UPDATE_STAGES }
  from '../../../shared/node/installedUpdateState.ts';
import type { InstalledUpdateJob, UpdateScope } from '../../../shared/node/installedUpdateState.ts';

export interface InstalledUpdateOptions {
  root: string;
  channel?: { latest(force?: boolean): Promise<ReleaseEnvelope | null> };
  publicKeyPem?: string;
  fetcher?: typeof fetch;
  probe(component: 'desktop' | 'server', directory: string, job: InstalledUpdateJob): Promise<void>;
}

type Component = 'desktop' | 'server';
type ArchiveSource = (component: Component) => Promise<string>;
type UpdateRequest = {
  requestId: string;
  manifestDigest: string;
  scope: UpdateScope;
};

const prepareStages = ['queued', 'verifying', 'downloading', 'preparing', 'failed'];

/**
 * До подготовки и перед применением резервируется место для архивов, распаковки и журнала.
 * Ошибка statfs не считается достаточностью ресурсов и не разрешает остановку программы.
 */
export async function assertUpdateSpace(root: string, job: InstalledUpdateJob): Promise<void> {
  const space = await fs.statfs(root);
  const bytes = updateComponents(job.scope).reduce((sum, component) => {
    const artifact = job.envelope.payload.artifacts[component];

    return sum + releaseArtifactDiskBytes(artifact);
  }, 64 * 1024 * 1024);

  if (space.bavail * space.bsize < bytes) {
    throw new Error('release_disk_space_insufficient');
  }
}

function updateComponents(scope: UpdateScope): Component[] {
  return scope === 'pair' ? ['desktop', 'server'] : [scope];
}

/**
 * Архив проверяется заново при повторе. Символическая ссылка или чужой
 * inode останавливают подготовку до удаления или записи.
 */
async function matchArchive(file: string, artifact: ReleaseArtifact): Promise<boolean> {
  const observed = await lstatOrNull(file);

  if (!observed) {
    return false;
  }

  if (!observed.isFile() || observed.uid !== process.getuid!() || observed.mode & 0o022) {
    throw new Error('release_archive_owner_invalid');
  }

  return observed.size === artifact.size && await sha256File(file) === artifact.sha256;
}

/**
 * Под lock публикуются только полностью проверенные локальные байты.
 * Crash на копировании оставляет лишь частный временный файл этого job.
 */
async function copyCandidateArchive(source: string, archive: string, artifact: ReleaseArtifact) {
  const temporary = archive + '.' + randomUUID() + '.part';

  try {
    await copyInstallFile(source, temporary);

    if (!await matchArchive(temporary, artifact)) {
      throw new Error('install_online_source_invalid');
    }

    await fs.rename(temporary, archive);
    await syncDirectory(path.dirname(archive));
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/**
 * Live prepare worker не может пересекаться с повтором installer.
 * Неподтверждённая identity не выдаётся за завершение процесса.
 */
async function assertPrepareWorkerInactive(receipt: InstallationReceipt, jobId: string) {
  const marker = await readInstallationJson(receipt.root, 'update/prepare-process.json')
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return null;
      }

      throw error;
    }) as { jobId: string; process: Awaited<ReturnType<typeof readUpdateProcess>> } | null;

  if (!marker || marker.jobId !== jobId) {
    return;
  }

  const saved = marker.process;
  const maintenance = path.join(receipt.root, 'update/maintenance');
  const current = await readUpdateProcess(saved.pid, maintenance).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ESRCH' || error.code === 'ENOENT') {
      return null;
    }

    throw error;
  });

  if (current && current.starttime === saved.starttime) {
    throw new Error('release_worker_active');
  }
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
  async createJob(request: UpdateRequest): Promise<InstalledUpdateJob> {
    const lock = await acquireInstalledUpdateLock(this.options.root);

    try {
      const receipt = await readInstallation(this.options.root);

      assertInstallationReleaseTrust(receipt, this.options.publicKeyPem);

      if (receipt.format === 2) {
        throw new Error(receipt.source === 'local-test'
          ? 'installation_release_trust_mismatch' : 'candidate_source_required');
      }

      return await this.createJobLocked(receipt, request, async () => {
        const channel = this.options.channel ?? new ReleaseChannelService({
          channel: receipt.channel,
          publicKeyPem: this.options.publicKeyPem,
        });

        return channel.latest(true);
      });
    } finally {
      await lock.release();
    }
  }

  /**
   * Installer сверяет происхождение и все установленные части A до раннего
   * возврата по requestId. Same-version использует те же подписанные байты.
   */
  async admitInstaller(input: Pick<InstallationReceipt, 'mode' | 'dataHome' | 'userData'>,
    envelope: ReleaseEnvelope, manifestDigest: string) {
    const lock = await acquireInstalledUpdateLock(this.options.root);

    try {
      const receipt = await readInstallation(this.options.root);

      assertInstallationReleaseTrust(receipt, this.options.publicKeyPem);

      if (receipt.mode !== input.mode || receipt.dataHome !== input.dataHome
        || receipt.userData !== input.userData || receipt.channel !== envelope.payload.channel) {
        throw new Error('installation_collision_use_update_status');
      }

      const pointer = await readInstalledPointer(receipt);
      const scope = receipt.mode === 'local' ? 'pair' : receipt.mode === 'remote' ? 'desktop' : 'server';
      const installed = [];

      for (const component of updateComponents(scope)) {
        try {
          const current = await verifyInstalledGeneration(receipt, pointer[component]!, component,
            this.options.publicKeyPem);

          if (canonicalJson(current.payload.platform) !== canonicalJson(envelope.payload.platform)) {
            throw new Error('installation_release_trust_mismatch');
          }

          installed.push(current);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'release_signature_invalid') {
            throw new Error('installation_release_trust_mismatch', { cause: error });
          }

          throw error;
        }
      }

      if (installed.every((current) => current.payload.version === envelope.payload.version)) {
        const digests = installed.map((current) => verifyReleaseEnvelope(current, this.options.publicKeyPem));

        if (digests.some((digest) => digest !== manifestDigest)) {
          throw new Error('release_generation_identity_invalid');
        }

        return { receipt, job: null };
      }

      if (receipt.format === 2 && receipt.source === 'local-test') {
        throw new Error('installation_release_trust_mismatch');
      }

      const job = await this.createJobLocked(receipt, {
        requestId: 'installer-' + manifestDigest,
        manifestDigest,
        scope,
      }, async () => envelope);

      return { receipt, job };
    } finally {
      await lock.release();
    }
  }

  /**
   * Общая публикация queued job вызывается при удерживаемом update lock.
   * Source и установленная trust policy уже сверены вызывающим входом.
   */
  private async createJobLocked(receipt: InstallationReceipt, request: UpdateRequest,
    latest: () => Promise<ReleaseEnvelope | null>): Promise<InstalledUpdateJob> {
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

    const envelope = await latest();

    if (!envelope || envelope.payload.channel !== receipt.channel
      || verifyReleaseEnvelope(envelope, this.options.publicKeyPem) !== request.manifestDigest) {
      throw new Error('release_target_changed');
    }

    await assertReleasePlatform(envelope.payload.platform);

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
  }

  /**
   * Worker использует сохранённый envelope и продолжает только своё installation-bound задание.
   * После ready повторная команда не скачивает и не устанавливает те же компоненты.
   */
  async prepare(jobId: string): Promise<InstalledUpdateJob> {
    const lock = await acquireInstalledUpdateLock(this.options.root);

    try {
      const receipt = await readInstallation(this.options.root);

      assertInstallationReleaseTrust(receipt, this.options.publicKeyPem);

      if (receipt.format === 2) {
        throw new Error('candidate_source_required');
      }

      return await this.prepareLocked(receipt, jobId);
    } finally {
      await lock.release();
    }
  }

  /**
   * Только вызов скачанного installer может довести неполный offline job
   * до ready. С момента проверки owner до распаковки удерживается один lock.
   */
  async prepareFromCandidate(jobId: string, digest: string, source: ArchiveSource) {
    const lock = await acquireInstalledUpdateLock(this.options.root);

    try {
      const receipt = await readInstallation(this.options.root);

      assertInstallationReleaseTrust(receipt, this.options.publicKeyPem);
      await assertPrepareWorkerInactive(receipt, jobId);

      return await this.prepareLocked(receipt, jobId, { digest, source });
    } finally {
      await lock.release();
    }
  }

  /**
   * Подготавливает уже закреплённую пару либо компонент под общим lock.
   * Скачанный installer получает отдельный порт архивов с запретом fetch.
   */
  private async prepareLocked(receipt: InstallationReceipt, jobId: string,
    local?: { digest: string; source: ArchiveSource }): Promise<InstalledUpdateJob> {
    let job: InstalledUpdateJob | null = null;
    let preparationStarted = false;

    try {
      job = await readInstalledUpdate(receipt);

      if (!job || job.id !== jobId) {
        throw new Error('release_job_mismatch');
      }

      if (verifyReleaseEnvelope(job.envelope, this.options.publicKeyPem) !== job.manifestDigest
        || local && local.digest !== job.manifestDigest
        || canonicalJson(await readInstalledPointer(receipt)) !== canonicalJson(job.previous)) {
        throw new Error('release_target_changed');
      }

      await assertReleasePlatform(job.envelope.payload.platform);

      if (job.stage === 'ready') {
        return job;
      }

      if (!prepareStages.includes(job.stage) || job.intent) {
        throw new Error('release_job_stage_invalid');
      }

      job.error = null;
      job.stage = 'verifying';
      await saveInstalledUpdate(receipt, job);
      preparationStarted = true;

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

        const valid = await matchArchive(archive, artifact);

        if (!valid && local) {
          await copyCandidateArchive(await local.source(component), archive, artifact);
        } else if (!valid && receipt.format === 2) {
          throw new Error('candidate_source_required');
        } else if (!valid) {
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
        const previous = await lstatOrNull(directory);

        if (previous && (!previous.isDirectory() || previous.uid !== receipt.uid
          || (previous.mode & 0o7777) !== 0o700)) {
          throw new Error('release_staged_ownership_invalid');
        }

        await fs.rm(directory, { recursive: true, force: true });
        await extractReleaseArtifact(archive, directory, artifact);

        if (component === 'desktop' && job.envelope.payload.platform.os === 'darwin') {
          await materializeMacDesktop(directory, artifact);
        }

        await this.options.probe(component, directory, job);
      }

      job.stage = 'ready';
      await saveInstalledUpdate(receipt, job);

      return job;
    } catch (error) {
      if (preparationStarted && job && prepareStages.includes(job.stage)) {
        job.stage = 'failed';
        job.error = {
          code: error instanceof Error ? error.message : 'release_prepare_failed',
          nextAction: 'resume-update',
        };
        await saveInstalledUpdate(receipt, job);
      }

      throw error;
    }
  }
}

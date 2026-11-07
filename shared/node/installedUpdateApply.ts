import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { canonicalJson } from '../lib/canonicalJson.ts';
import { acquireInstallLock } from './binaryInstall.ts';
import { verifyReleaseEnvelope } from './releaseTrust.ts';
import { sha256File } from './hash.ts';
import { syncDirectory } from './files.ts';
import { assertUpdateSpace } from './installedUpdate.ts';
import { readInstallation, readInstalledPointer, assertInstallationPath,
  writeInstallationJson, readInstallationJson } from './installedLayout.ts';
import type { InstallationReceipt } from './installedLayout.ts';
import { readInstalledUpdate, saveInstalledUpdate } from './installedUpdateState.ts';
import type { InstalledUpdateJob } from './installedUpdateState.ts';
import type { ReleaseEnvelope, ReleaseArtifact } from '../runtime/installedUpdateContracts.ts';

/**
 * Полная опись проверяется до исполнения: обычные файлы, права, размеры, SHA и отсутствие лишних записей.
 * Проверка годится как для staging, так и для удержанного поколения перед rollback.
 */
async function verifyComponent(receipt: InstallationReceipt, relative: string, artifact: ReleaseArtifact) {
  const expected = new Map(artifact.files.map((file) => [file.path, file]));
  const directories = [''];

  while (directories.length) {
    const directory = directories.pop()!;
    const full = await assertInstallationPath(receipt.root, relative + (directory ? '/' + directory : ''));

    for (const entry of await fs.readdir(full, { withFileTypes: true })) {
      const name = directory ? `${directory}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        directories.push(name);
        continue;
      }

      const file = expected.get(name);
      const absolute = await assertInstallationPath(receipt.root, `${relative}/${name}`);
      const stat = await fs.lstat(absolute);

      if (!file || !stat.isFile() || stat.size !== file.size || await sha256File(absolute) !== file.sha256
        || (stat.mode & 0o777) !== (file.mode & 0o111 ? 0o555 : 0o444)) {
        throw new Error('release_staged_file_changed');
      }

      expected.delete(name);
    }
  }

  if (expected.size) {
    throw new Error('release_staged_file_missing');
  }
}

/**
 * Возврат к предыдущему выпуску использует его собственный подписанный manifest и опись.
 * Совпадение имени каталога не разрешает запускать повреждённый retained component.
 */
export async function verifyInstalledGeneration(
  receipt: InstallationReceipt, relative: string, component: 'desktop' | 'server', key?: string,
): Promise<ReleaseEnvelope> {
  const envelope = await readInstallationJson(receipt.root,
    `${path.posix.dirname(relative)}/release.json`) as ReleaseEnvelope;

  verifyReleaseEnvelope(envelope, key);

  if (relative !== `generations/${envelope.payload.version}/${component}`) {
    throw new Error('release_generation_identity_invalid');
  }

  await verifyComponent(receipt, relative, envelope.payload.artifacts[component]);

  return envelope;
}

export interface UpdateApplyPorts {
  publicKeyPem?: string;
  recheck(job: InstalledUpdateJob): Promise<void>;
  stop(job: InstalledUpdateJob): Promise<void>;
  start(job: InstalledUpdateJob, rollback: boolean): Promise<void>;
  prove(job: InstalledUpdateJob, rollback: boolean): Promise<'running' | 'stopped'>;
}

/**
 * Согласие записывается отдельно от ready и привязано к digest, установке и заданию.
 * Обычное закрытие программы не вызывает этот метод и не разрешает последующий switch.
 */
export async function confirmInstalledUpdate(root: string, jobId: string): Promise<InstalledUpdateJob> {
  const receipt = await readInstallation(root);
  const lock = await acquireInstallLock(path.join(root, 'update/installation'), { waitMs: 0 });

  try {
    const job = await readInstalledUpdate(receipt);

    if (!job || job.id !== jobId || job.stage !== 'ready') {
      throw new Error('release_job_not_ready');
    }

    job.intent = { nonce: randomUUID(), confirmedAt: new Date().toISOString() };
    await saveInstalledUpdate(receipt, job);

    return job;
  } finally {
    await lock.release();
  }
}

/**
 * Перед эффектом заново проверяются подпись и каждый staged файл без следования ссылкам.
 * Версия на диске и version-probe сами по себе не подтверждают запущенное приложение.
 */
async function verifyPrepared(receipt: InstallationReceipt, job: InstalledUpdateJob, key?: string) {
  if (verifyReleaseEnvelope(job.envelope, key) !== job.manifestDigest) {
    throw new Error('release_manifest_digest_invalid');
  }

  const components = job.scope === 'pair' ? ['desktop', 'server'] as const : [job.scope];

  for (const component of components) {
    const artifact = job.envelope.payload.artifacts[component];
    const staged = `update/${job.id}/${component}`;
    const relative = await fs.lstat(path.join(receipt.root, staged)).then(() => staged, (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }

      return job.target[component]!;
    });

    await verifyComponent(receipt, relative, artifact);
  }
}

/**
 * Handoff подтверждается только после повторной проверки готовых байтов и свободного места.
 * Этот шаг не меняет journal, указатель или процессы установки.
 */
export async function preflightInstalledUpdate(root: string, jobId: string): Promise<InstalledUpdateJob> {
  const receipt = await readInstallation(root);
  const job = await readInstalledUpdate(receipt);

  if (!job || job.id !== jobId || job.stage !== 'ready') {
    throw new Error('release_job_not_ready');
  }

  await verifyPrepared(receipt, job);
  await assertUpdateSpace(root, job);

  if (canonicalJson(await readInstalledPointer(receipt)) !== canonicalJson(job.previous)) {
    throw new Error('release_current_changed');
  }

  return job;
}

/**
 * Только подтверждённый worker публикует одну запись current с обеими ссылками пары.
 * Успех требует живых proofs; при сбое возвращается целый previous, поколения сохраняются.
 */
export async function applyInstalledUpdate(
  root: string,
  jobId: string,
  ports: UpdateApplyPorts,
): Promise<InstalledUpdateJob> {
  const receipt = await readInstallation(root);
  const lock = await acquireInstallLock(path.join(root, 'update/installation'), { waitMs: 0 });
  let switched = false;
  let stopped = false;
  let job: InstalledUpdateJob | null = null;

  try {
    job = await readInstalledUpdate(receipt);

    if (!job || job.id !== jobId || !job.intent || job.stage !== 'ready') {
      throw new Error('release_apply_consent_required');
    }

    await verifyPrepared(receipt, job, ports.publicKeyPem);
    await assertUpdateSpace(root, job);
    await ports.recheck(job);

    if (canonicalJson(await readInstalledPointer(receipt)) !== canonicalJson(job.previous)) {
      throw new Error('release_current_changed');
    }

    job.stage = 'stopping';
    await saveInstalledUpdate(receipt, job);
    await ports.stop(job);
    stopped = true;
    await ports.recheck(job);

    const generation = path.join(root, 'generations', job.envelope.payload.version);

    await fs.mkdir(generation, { recursive: true, mode: 0o700 });
    await assertInstallationPath(root, `generations/${job.envelope.payload.version}`);

    const components = job.scope === 'pair' ? ['desktop', 'server'] as const : [job.scope];

    job.stage = 'applying';
    await saveInstalledUpdate(receipt, job);

    for (const component of components) {
      const target = path.join(generation, component);
      const exists = await fs.lstat(target).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }

        return null;
      });

      if (exists) {
        await verifyComponent(receipt, job.target[component]!, job.envelope.payload.artifacts[component]);
      } else {
        await fs.rename(path.join(root, 'update', job.id, component), target);
      }
    }

    await syncDirectory(generation);
    await syncDirectory(path.dirname(generation));
    await writeInstallationJson(root,
      `generations/${job.envelope.payload.version}/release.json`, job.envelope);
    await writeInstallationJson(root, 'current.json', job.target);
    switched = true;
    job.stage = 'starting';
    await saveInstalledUpdate(receipt, job);
    await ports.start(job, false);

    const proof = await ports.prove(job, false);

    job.stage = proof === 'stopped' ? 'applied_not_started' : 'completed';
    job.error = null;
    await saveInstalledUpdate(receipt, job);

    return job;
  } catch (error) {
    if (job && stopped) {
      try {
        if (switched) {
          await ports.stop(job);
          await writeInstallationJson(root, 'current.json', job.previous);
        }

        await ports.start(job, true);
        await ports.prove(job, true);
        job.stage = 'rolled_back';
      } catch {
        job.stage = 'manual_recovery_required';
      }
    } else if (job && ['ready', 'stopping'].includes(job.stage)) {
      job.stage = 'ready';
      job.intent = null;
    }

    if (job) {
      job.error = {
        code: error instanceof Error ? error.message : 'release_apply_failed',
        nextAction: 'resume-update',
      };
      await saveInstalledUpdate(receipt, job);
    }

    throw error;
  } finally {
    await lock.release();
  }
}

/**
 * Прерванный apply не подтверждается диском: целый previous возвращается до нового запуска.
 * После applied_not_started явный start только подтверждает runtime, повторного switch нет.
 * rollback=true — явное согласие человека вернуть applied_not_started к previous:
 * штатный путь оставляет эту стадию без выхода, если новое поколение не запускается.
 */
export async function recoverInstalledUpdate(root: string, ports: UpdateApplyPorts,
  options: { rollback?: boolean } = {}): Promise<void> {
  const receipt = await readInstallation(root);
  const lock = await acquireInstallLock(path.join(root, 'update/installation'), { waitMs: 0 });

  try {
    const job = await readInstalledUpdate(receipt);

    if (!job || !['stopping', 'applying', 'starting', 'applied_not_started',
      'manual_recovery_required'].includes(job.stage)) {
      return;
    }

    if (!job.intent || verifyReleaseEnvelope(job.envelope, ports.publicKeyPem) !== job.manifestDigest) {
      throw new Error('release_recovery_intent_invalid');
    }

    if (job.stage === 'applied_not_started' && !options.rollback) {
      if (await ports.prove(job, false) === 'running') {
        job.stage = 'completed';
        await saveInstalledUpdate(receipt, job);
      }

      return;
    }

    await ports.recheck(job);

    const current = canonicalJson(await readInstalledPointer(receipt));

    if (![canonicalJson(job.previous), canonicalJson(job.target)].includes(current)) {
      throw new Error('release_current_changed');
    }

    try {
      job.stage = 'stopping';
      await saveInstalledUpdate(receipt, job);
      await ports.stop(job);
      await writeInstallationJson(root, 'current.json', job.previous);
      await ports.start(job, true);
      await ports.prove(job, true);
      job.stage = 'rolled_back';
      job.error = { code: 'release_apply_interrupted', nextAction: 'check-updates' };
    } catch {
      job.stage = 'manual_recovery_required';
      job.error = { code: 'release_recovery_failed', nextAction: 'resume-update' };
    }

    await saveInstalledUpdate(receipt, job);
  } finally {
    await lock.release();
  }
}

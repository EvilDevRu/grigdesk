import type { ReleaseEnvelope } from '../runtime/installedUpdateContracts.ts';
import { decodeReleaseChannelIndex } from '../runtime/installedUpdateContracts.ts';
import { verifyReleaseEnvelope } from './releaseTrust.ts';
import type { InstalledPointer, InstallationReceipt } from './installedLayout.ts';
import { decodeInstalledPointer, readInstallationJson, writeInstallationJson } from './installedLayout.ts';

export type UpdateScope = 'pair' | 'desktop' | 'server';
export type InstalledUpdateStage = 'queued' | 'verifying' | 'downloading' | 'preparing' | 'ready'
  | 'stopping' | 'applying' | 'starting' | 'completed' | 'applied_not_started' | 'rolled_back'
  | 'failed' | 'manual_recovery_required';

export interface InstalledUpdateJob {
  format: 1 | 2;
  id: string;
  requestId: string;
  installationId: string;
  manifestDigest: string;
  envelope: ReleaseEnvelope;
  scope: UpdateScope;
  previous: InstalledPointer;
  target: InstalledPointer;
  stage: InstalledUpdateStage;
  createdAt: string;
  updatedAt: string;
  progress: { downloadedBytes: number; totalBytes: number } | null;
  error: { code: string; nextAction: string } | null;
  intent: { nonce: string; confirmedAt: string } | null;
}

export const PENDING_UPDATE_STAGES = ['queued', 'verifying', 'downloading', 'preparing', 'ready',
  'stopping', 'applying', 'starting', 'applied_not_started', 'manual_recovery_required'];

/**
 * Неполный либо повреждённый журнал не принимается за отсутствие задания.
 * Полный envelope повторно декодируется, его доверие проверяется перед любым эффектом.
 */
export async function readInstalledUpdate(receipt: InstallationReceipt): Promise<InstalledUpdateJob | null> {
  let job: InstalledUpdateJob;

  try {
    job = await readInstallationJson(receipt.root, 'update/job.json') as InstalledUpdateJob;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw error;
  }

  if (!job || ![1, 2].includes(job.format) || job.installationId !== receipt.installationId
    || !/^[a-f0-9-]{36}$/u.test(job.id) || typeof job.requestId !== 'string'
    || job.requestId.length > 128 || !/^[a-f0-9]{64}$/u.test(job.manifestDigest)
    || !['pair', 'desktop', 'server'].includes(job.scope)
    || ![...PENDING_UPDATE_STAGES, 'completed', 'rolled_back', 'failed'].includes(job.stage)) {
    throw new Error('update_journal_invalid');
  }

  const components = job.scope === 'pair' ? ['desktop', 'server'] as const : [job.scope];

  for (const pointer of [job.previous, job.target]) {
    decodeInstalledPointer(receipt, pointer);

    if (pointer.format !== job.format) {
      throw new Error('update_journal_invalid');
    }
  }

  if (job.format === 2 && (job.target.floor !== job.previous.floor
    || job.target.control !== `generations/${job.envelope?.payload?.version}`
    || job.stage === 'rolled_back'
    || verifyReleaseEnvelope(job.envelope) !== job.manifestDigest
    || job.intent !== null && (!/^[a-f0-9-]{36}$/u.test(job.intent.nonce) || !job.intent.confirmedAt))) {
    throw new Error('update_journal_invalid');
  }

  for (const component of ['desktop', 'server'] as const) {
    const expected = components.includes(component)
      ? `generations/${job.envelope?.payload?.version}/${component}` : job.previous[component];

    if (job.target[component] !== expected) {
      throw new Error('update_journal_invalid');
    }
  }

  decodeReleaseChannelIndex({
    format: job.format === 2 ? 3 : 2,
    channel: job.envelope?.payload?.channel,
    publishedAt: job.envelope?.payload?.publishedAt,
    latest: job.envelope,
  });

  return job;
}

/**
 * Этап публикуется только вместе с полным заданием и новой меткой времени.
 * Проценты существуют исключительно на этапе скачивания измеримых байтов.
 */
export async function saveInstalledUpdate(
  receipt: InstallationReceipt,
  job: InstalledUpdateJob,
): Promise<void> {
  job.updatedAt = new Date().toISOString();

  if (job.stage !== 'downloading') {
    job.progress = null;
  }

  await writeInstallationJson(receipt.root, 'update/job.json', job);
}

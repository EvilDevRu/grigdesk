import { randomUUID } from 'node:crypto';

import { emptyInstallState } from '../../../server/src/lib/pluginInstall/stateStore.ts';

/**
 * Полный synthetic record используется storage и transaction сценариями.
 * Все digest/SHA и адреса принадлежат fixture, а не состоянию разработчика.
 */
export function installedRecord(version = '1.0.0', revision = 1) {
  return {
    source: { kind: 'git', url: 'file:///fixture-plugin.git' },
    version,
    tag: `v${version}`,
    sha: 'a'.repeat(40),
    installedAt: '2026-01-01T00:00:00.000Z',
    payloadDigest: 'b'.repeat(64),
    gitConfigDigest: 'c'.repeat(64),
    npmDirs: [],
    revision,
    previous: null,
    latest: null,
    checkedAt: null,
    checkError: null,
  };
}

/**
 * Job содержит все публичные поля и безопасный preview для transaction.
 * ID генерируется заново, чтобы разные сценарии не разделяли outcome.
 */
export function installJob(status = 'running', kind = 'install') {
  const record = installedRecord();

  return {
    id: randomUUID(),
    kind,
    pluginId: 'demo',
    source: record.source,
    target: {
      version: record.version,
      tag: record.tag,
      sha: record.sha,
    },
    replaceModified: false,
    status,
    stage: status === 'running' ? 'fetching' : null,
    percent: status === 'running' ? 0 : null,
    preview: {
      source: record.source,
      target: {
        version: record.version,
        tag: record.tag,
        sha: record.sha,
      },
      id: 'demo',
      name: 'Демо',
      version: record.version,
      description: '',
      hasServer: true,
      hasWeb: false,
      replaces: { kind: 'none' },
      changes: null,
      warnings: [],
    },
    error: null,
    createdAt: record.installedAt,
    updatedAt: record.installedAt,
    finishedAt: ['done', 'failed', 'cancelled', 'interrupted'].includes(status) ? record.installedAt : null,
    revision: 1,
    reviewToken: ['ready', 'applying', 'done'].includes(status) ? 'd'.repeat(64) : null,
    backupRef: null,
  };
}

/**
 * Связанный intent задаёт факты без произвольных filesystem paths.
 * Current и candidate различаются inode даже при одинаковом fixture digest.
 */
export function applyingState(kind = 'update', destination = 'previous') {
  const state = emptyInstallState();
  const baseRecord = installedRecord();
  const targetRecord = installedRecord('1.1.0', 2);
  const job = installJob('applying', kind);

  job.target = {
    version: targetRecord.version,
    tag: targetRecord.tag,
    sha: targetRecord.sha,
  };
  job.preview.target = job.target;
  job.preview.version = targetRecord.version;
  state.plugins.demo = baseRecord;
  state.job = job;
  state.nextRevision = 3;
  state.apply = {
    transactionId: randomUUID(),
    pluginId: 'demo',
    jobId: job.id,
    kind,
    baseRecord,
    targetRecord,
    destination,
    current: {
      dev: 1,
      ino: 101,
      payloadDigest: baseRecord.payloadDigest,
    },
    candidate: {
      dev: 1,
      ino: 102,
      payloadDigest: targetRecord.payloadDigest,
    },
    previous: null,
    reviewToken: job.reviewToken,
    phase: 'prepared',
    rollbackReceiptInput: kind === 'rollback' ? {
      requestId: randomUUID(),
      inputHash: 'e'.repeat(64),
      baseRevision: baseRecord.revision,
    } : null,
    archiveKey: null,
  };

  return state;
}

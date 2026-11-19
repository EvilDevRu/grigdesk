export type FactoryProcessState = 'alive' | 'dead' | 'unknown';
export type FactoryFinalization = 'done' | 'pending' | 'unknown';

export interface FactoryCleanupAction {
  mode: 'stop' | 'stop_or_resume';
  identity: string;
}

export interface FactoryOwnershipRow {
  task: string;
  orchestrator: FactoryProcessState;
  runner: FactoryProcessState;
  finalization: FactoryFinalization;
}

export interface FactoryOwnershipSnapshot {
  daemonOwnershipVersion: 1;
  complete: boolean;
  ownership: FactoryOwnershipRow[];
}

export const FACTORY_TASK_ID = /^[1-9][0-9]{0,18}$/u;

const rowKeys = 'finalization,orchestrator,runner,task';
const snapshotKeys = 'complete,daemonOwnershipVersion,ownership';
const processStates = new Set<unknown>(['alive', 'dead']);
const finalizationStates = new Set<unknown>(['done', 'pending']);

/**
 * Установка принимает только полный версионированный снимок с уникальными ID.
 * Неизвестный процесс или незавершённое чтение прерывают действие до Stop.
 */
export function decodeCompleteFactoryOwnership(input: unknown): FactoryOwnershipRow[] {
  const snapshot = input as Partial<FactoryOwnershipSnapshot> | null;

  if (typeof snapshot !== 'object' || snapshot === null
    || Object.keys(snapshot).sort().join(',') !== snapshotKeys || snapshot.daemonOwnershipVersion !== 1
    || snapshot.complete !== true || !Array.isArray(snapshot.ownership)) {
    throw new Error('release_activity_unknown');
  }

  const seen = new Set<string>();

  for (const row of snapshot.ownership) {
    if (row === null || typeof row !== 'object' || Object.keys(row).sort().join(',') !== rowKeys
      || typeof row.task !== 'string' || !FACTORY_TASK_ID.test(row.task) || seen.has(row.task)
      || !processStates.has(row.orchestrator) || !processStates.has(row.runner)
      || !finalizationStates.has(row.finalization)) {
      throw new Error('release_activity_unknown');
    }

    seen.add(row.task);
  }

  return snapshot.ownership;
}

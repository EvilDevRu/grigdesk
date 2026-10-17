import type { StudioRunRequest } from './studio3dApi.ts';
import type { Studio3dBatchSnapshot } from '../../../../shared/studio3d/studio3dContracts.ts';

export interface StudioRetryRequest {
  expectedPrice: number;
  libraryId: string;
  idempotencyKey: string;
}

export interface StudioBatchRunRequest {
  snapshot: Studio3dBatchSnapshot;
  snapshotHash: string;
  libraryId: string;
  idempotencyKey: string;
}

// Общие поля сохраняют прежний JSON нажатия, включая исходный fingerprint.
// Вид запроса связывает request с обязательными адресными полями retry.
interface PendingStudioBase {
  key: string;
  owner: string;
  libraryId: string;
  fingerprint: string;
  blocked?: string;
  at: number;
}

export type PendingStudioIntent = PendingStudioBase & (
  | {
    kind: 'run';
    request: StudioRunRequest;
  }
  | {
    kind: 'retry';
    modelId: string;
    versionId: string;
    request: StudioRetryRequest;
  }
  | {
    kind: 'batch';
    request: StudioBatchRunRequest;
  }
);

export interface PendingStudioStorage {
  list(owner: string): Promise<PendingStudioIntent[]>;
  put(record: PendingStudioIntent): Promise<void>;
  remove(key: string): Promise<void>;
}


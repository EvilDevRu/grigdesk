import type { PendingStudioIntent } from '../../web/src/features/studio3d/pendingIntentTypes.ts';
import type { StudioRunRequest } from '../../web/src/features/studio3d/studio3dApi.ts';
import type { Studio3dBatchSnapshot } from '../../shared/studio3d/studio3dContracts.ts';

type IsUnchecked<Value> = 0 extends (1 & Value) ? true : false;
type Checked<Value extends false> = Value;

export type PendingIsChecked = Checked<IsUnchecked<PendingStudioIntent>>;

/**
 * Примеры выполняет компилятор: каждый kind сохраняет обязательные поля запроса.
 * Ошибка адреса retry или потеря snapshotHash не проходит как пригодное к отправке нажатие.
 */
function checkPending(run: StudioRunRequest, snapshot: Studio3dBatchSnapshot): void {
  const common = {
    key: 'fixture-key',
    owner: 'fixture-owner',
    libraryId: 'fixture-library',
    fingerprint: 'fixture-fingerprint',
    at: 1,
  };
  const retryRequest = {
    expectedPrice: 20,
    libraryId: common.libraryId,
    idempotencyKey: common.key,
  };
  const runRecord: PendingStudioIntent = {
    ...common,
    kind: 'run',
    request: run,
  };
  const retryRecord: PendingStudioIntent = {
    ...common,
    kind: 'retry',
    modelId: 'fixture-model',
    versionId: 'fixture-version',
    request: retryRequest,
  };
  const batchRecord: PendingStudioIntent = {
    ...common,
    kind: 'batch',
    request: {
      snapshot,
      snapshotHash: 'fixture-hash',
      libraryId: common.libraryId,
      idempotencyKey: common.key,
    },
  };

  // @ts-expect-error Retry обязан сохранять versionId для прежнего адреса POST.
  const noVersion: Extract<PendingStudioIntent, { kind: 'retry' }> = {
    ...common,
    kind: 'retry',
    modelId: 'fixture-model',
    request: retryRequest,
  };
  // @ts-expect-error Batch без snapshotHash не подтверждает сохранённый серверный снимок.
  const noHash: Extract<PendingStudioIntent, { kind: 'batch' }>['request'] = {
    snapshot,
    libraryId: common.libraryId,
    idempotencyKey: common.key,
  };
  const { provider, ...withoutProvider } = run;

  // @ts-expect-error Run без provider не выбирает платного исполнителя.
  const noProvider: Extract<PendingStudioIntent, { kind: 'run' }>['request'] = withoutProvider;

  void [runRecord, retryRecord, batchRecord, noVersion, noHash, noProvider, provider];
}

void checkPending;

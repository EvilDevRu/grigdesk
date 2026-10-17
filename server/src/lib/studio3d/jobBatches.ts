import { createHash } from 'node:crypto';

import { ACTIVE_STATUSES, parseStudio3d } from '../../../../shared/studio3d/studio3dContracts.ts';
import type { Studio3dBatchSnapshot } from '../../../../shared/studio3d/studio3dContracts.ts';
import { operationSpec } from '../../../../shared/studio3d/studio3dOperations.ts';
import { START_CONTEXT } from './provider.ts';
import type { AccountSnapshot, Studio3dProvider } from './provider.ts';
import { requestFingerprint } from './intents.ts';
import type { IntentChild, IntentRecord, RunRequest, StudioIntents } from './intents.ts';
import type { StudioLibrary } from './library.ts';
import type { AdmissionToken, StudioAdmission } from './admission.ts';
import { discardInputs } from './jobInputs.ts';
import type { JobInputSelection } from './jobInputs.ts';
import { validateRunRequest, requirePrice } from './jobRequest.ts';
import { JobError } from './jobErrors.ts';

export interface JobBatchesPorts {
  library: StudioLibrary;
  intents: StudioIntents;
  admission: StudioAdmission;
  lookupProvider(id: string): Studio3dProvider | undefined;
  at(): string;
  buildIntent(request: RunRequest, fingerprint: string, token: AdmissionToken,
    provider: Studio3dProvider, captured: AccountSnapshot | undefined,
    selection: JobInputSelection, batchParent: string): Promise<IntentRecord>;
  materialize(record: IntentRecord): Promise<void>;
  change(intentId: string, childId: string, patch: Partial<IntentChild>): Promise<IntentRecord>;
  injectFault(boundary: string, record: IntentRecord, child?: IntentChild): Promise<void>;
  wake(): void;
}

/**
 * Пачки сохраняют полный родительский снимок до materialize дочерних намерений.
 * Общие library/intents/admission передаются по ссылке, registry и платный dispatch остаются в Jobs.
 */
export function createJobBatches(ports: JobBatchesPorts) {
  /**
   * Все строки считаются и проверяются до подготовки batch. Сумма имеет одну
   * единицу; смешанные валюты не превращаются в общий итог подтверждения.
   */
  const quoteBatch = async (input: {
    libraryId: string;
    rows: Studio3dBatchSnapshot['rows'];
  }) => {
    ports.admission.capture(input.libraryId);

    if (!Array.isArray(input.rows) || !input.rows.length || input.rows.length > 50) {
      throw new JobError('invalid_batch');
    }

    const rows: Studio3dBatchSnapshot['rows'] = [];
    const catalogs = [];
    let unit = null;
    let unitSet = false;

    for (const row of input.rows) {
      if (Object.keys(row).some((key) => ![
        'provider', 'operation', 'values', 'name', 'project', 'category', 'expectedPrice',
      ].includes(key))) {
        throw new JobError('invalid_batch');
      }

      const provider = ports.lookupProvider(row.provider);
      const captured = provider?.snapshot?.();
      const spec = operationSpec(row.operation);

      if (!provider || !spec?.inputs.includes('text') || !await provider.available()
        || (captured && !provider.isCurrent?.(captured))) {
        throw new JobError('invalid_batch');
      }

      const validation = provider.validate(row.operation, row.values, START_CONTEXT);

      if (validation.errors.length) {
        throw new JobError('validation_failed', { validation });
      }

      const quote = provider.quote(row.operation, validation.values, START_CONTEXT);
      const price = requirePrice(quote, quote.total!);

      if (unitSet && requestFingerprint(unit) !== requestFingerprint(quote.unit)) {
        throw new JobError('mixed_units');
      }

      unit = quote.unit;
      unitSet = true;

      const request = validateRunRequest({
        ...row,
        values: validation.values,
        expectedPrice: price,
        libraryId: input.libraryId,
        idempotencyKey: '00000000-0000-4000-8000-000000000001'
      });

      rows.push({
        provider: request.provider,
        operation: request.operation,
        values: request.values,
        name: request.name!,
        project: request.project ?? null,
        category: request.category ?? null,
        expectedPrice: price
      });
      catalogs.push({
        provider: provider.id,
        fields: provider.operations(START_CONTEXT),
        unit: quote.unit
      });
    }

    const totalEstimated = rows.reduce((sum, row) => sum + row.expectedPrice, 0);
    const snapshot = {
      libraryId: input.libraryId,
      rows,
      catalogVersion: requestFingerprint(catalogs),
      totalEstimated,
      unit
    };

    return parseStudio3d.batchQuote({
      libraryId: input.libraryId,
      snapshot,
      snapshotHash: requestFingerprint(snapshot),
      totalEstimated,
      unit
    });
  };

  /**
   * UUID строки детерминирован от пользовательского UUID пачки и её позиции.
   * Parent сохраняет полный execution template каждого child до его проекции.
   */
  const rowId = (batchId: string, index: number): string => {
    const hash = createHash('sha256').update(`${batchId}:row:${index}`).digest('hex');
    const uuid = `${hash.slice(0, 12)}4${hash.slice(13, 16)}8${hash.slice(17, 32)}`;

    return `${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-${uuid.slice(12, 16)}-${uuid.slice(16,
      20)}-${uuid.slice(20)}`;
  };

  /**
   * Dispatch не открывается до всех row intents и проекций. Existing строки
   * получают своё прежнее состояние вместо замены template при восстановлении.
   */
  const materializeBatch = async (record: IntentRecord): Promise<void> => {
    if (!record.batch || record.preparation === 'complete') {
      return;
    }

    for (const row of record.batch.rows) {
      const { record: current } = await ports.intents.reserve(row.template);

      if (current.batchParent !== record.intentId) {
        throw new JobError('idempotency_conflict');
      }

      await ports.materialize(current);
      await ports.injectFault('after-batch-row', record);
    }

    await ports.intents.update(record.intentId, (current) => {
      current.preparation = 'complete';
      current.updatedAt = ports.at();
    });
  };

  /**
   * Неизвестный исход или изменение цены одной строки приостанавливает только
   * неотправленные строки пачки; принятые задачи продолжают наблюдение/скачивание.
   */
  const batchBlocked = async (record: IntentRecord): Promise<boolean> => {
    if (!record.batchParent) {
      return false;
    }

    const parent = await ports.intents.get(record.batchParent);

    if (parent?.preparation !== 'complete') {
      return true;
    }

    for (const row of parent.batch?.rows ?? []) {
      const sibling = await ports.intents.get(row.intentId);

      if (sibling?.children.some((child) => ['unknown', 'unresolved'].includes(child.stage)
        || child.confirmationExpired)) {
        await ports.change(record.intentId, record.children[0]!.childId,
          { waitReason: 'Пачка приостановлена — разберите исход или подтвердите новую цену.' });

        return true;
      }
    }

    return false;
  };

  /**
   * Статус каждой строки берётся с сервера; родительский снимок не теряется
   * при reload, а успешно оплаченная строка никогда не отправляется снова.
   */
  const batch = async (intentId: string, libraryId = ports.library.libraryId) => {
    ports.admission.capture(libraryId);

    const parent = await ports.intents.get(intentId, libraryId);

    if (!parent?.batch) {
      throw new JobError('intent_not_found');
    }

    const children = [];

    for (const row of parent.batch.rows) {
      const record = await ports.intents.get(row.intentId);
      const statuses = record?.children.map((child) => child.status) ?? ['waiting'];
      const status = statuses.includes('unknown') ? 'unknown'
        : statuses.every((item) => item === 'ready') ? 'ready'
          : statuses.includes('waiting') ? 'waiting' : statuses[0]!;

      children.push({
        childId: row.childId,
        intentId: row.intentId,
        modelId: record?.modelId ?? null,
        status,
        estimated: record?.confirmedPrice ?? row.template.confirmedPrice
      });
    }

    const status = children.some((child) => child.status === 'unknown') ? 'unknown'
      : children.every((child) => child.status === 'ready') ? 'ready'
        : children.every((child) => !ACTIVE_STATUSES.includes(child.status)) ? 'failed' : 'waiting';

    return parseStudio3d.batchRun({
      intentId,
      libraryId,
      children,
      totalEstimated: parent.confirmedPrice,
      unit: parent.unit,
      status
    });
  };

  /**
   * Все цены/строки валидируются до allocation, все IDs фиксируются parent fsync.
   * Сбой после parent восстанавливается по templates, не по новому plan каталога.
   */
  const acceptBatch = async (input: {
    libraryId: string;
    idempotencyKey: string;
    snapshot: Studio3dBatchSnapshot;
    snapshotHash: string;
  }, fingerprint: string) => {
    const { library, intents } = ports;
    const previous = await intents.get(input.idempotencyKey, input.libraryId);

    if (previous) {
      if (previous.kind !== 'batch' || previous.requestFingerprint !== fingerprint) {
        throw new JobError('idempotency_conflict');
      }

      await materializeBatch(previous);

      return batch(previous.intentId, input.libraryId);
    }

    const token = ports.admission.capture(input.libraryId);
    const decoded = parseStudio3d.batchQuote({
      libraryId: input.libraryId,
      snapshot: input.snapshot,
      snapshotHash: input.snapshotHash,
      totalEstimated: input.snapshot.totalEstimated,
      unit: input.snapshot.unit
    });

    if (decoded.snapshot.libraryId !== input.libraryId
      || input.snapshotHash !== requestFingerprint(input.snapshot)) {
      throw new JobError('invalid_batch');
    }

    const quote = await quoteBatch({ libraryId: input.libraryId, rows: input.snapshot.rows });

    if (quote.snapshotHash !== input.snapshotHash) {
      throw new JobError('price_changed', { quote });
    }

    const templates: IntentRecord[] = [];
    const capturedAccounts: { provider: Studio3dProvider; captured: AccountSnapshot }[] = [];
    let saved = false;

    try {
      for (const [index, row] of quote.snapshot.rows.entries()) {
        const request = validateRunRequest({
          ...row,
          libraryId: input.libraryId,
          idempotencyKey: rowId(input.idempotencyKey, index)
        });
        const provider = ports.lookupProvider(row.provider)!;
        const captured = provider.snapshot?.();

        if (captured) {
          capturedAccounts.push({ provider, captured });
        }

        const selection: JobInputSelection = {
          context: structuredClone(START_CONTEXT),
          version: null,
          inputs: [],
          release: () => {}
        };

        templates.push(await ports.buildIntent(request, requestFingerprint(request), token,
          provider, captured, selection, input.idempotencyKey));
      }

      const at = ports.at();
      const record: IntentRecord = {
        schema: 1,
        kind: 'batch',
        intentId: input.idempotencyKey,
        libraryId: input.libraryId,
        request: structuredClone(input),
        requestFingerprint: fingerprint,
        executionFingerprint: input.snapshotHash,
        accountKey: null,
        provider: 'batch',
        operation: 'batch',
        values: {},
        confirmedPrice: quote.totalEstimated,
        unit: quote.unit,
        catalogVersion: quote.snapshot.catalogVersion,
        context: structuredClone(START_CONTEXT),
        model: null,
        modelId: null,
        parentVersionId: null,
        inputs: [],
        children: [],
        projectionReady: true,
        preparation: 'pending',
        batch: {
          snapshot: quote.snapshot,
          snapshotHash: quote.snapshotHash,
          rows: templates.map((template, index) => ({
            childId: `row-${index + 1}`,
            intentId: template.intentId,
            template
          }))
        },
        batchParent: null,
        createdAt: at,
        updatedAt: at,
        revision: 0,
      };

      await ports.admission.locked(async () => {
        if (!ports.admission.current(token) || capturedAccounts.some(({ provider, captured }) =>
          !provider.isCurrent?.(captured))) {
          throw new JobError('admission_changed');
        }

        await intents.reserve(record);
      });

      saved = true;

      await ports.injectFault('after-batch-intent', record);
      await materializeBatch(record);
      ports.wake();

      return batch(record.intentId, input.libraryId);
    } finally {
      if (!saved && !await intents.get(input.idempotencyKey)) {
        for (const record of templates) {
          library.releasePlans(record.modelId!, record.children.flatMap((child) =>
            child.version ? [child.version] : []), true);
          await discardInputs(library, intents, record.intentId);
        }
      }
    }
  };

  return {
    quoteBatch,
    rowId,
    materializeBatch,
    batchBlocked,
    batch,
    acceptBatch,
  };
}

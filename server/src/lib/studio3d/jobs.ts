import { createJobBatches } from './jobBatches.ts';
import { validateRunRequest, requirePrice } from './jobRequest.ts';
import { createJobDownloads } from './jobDownloads.ts';
import { JobError, InjectedCrash, fallbackError } from './jobErrors.ts';
import { createJobDownloadQueue } from './jobDownloadQueue.ts';
import { unreflectedReservationAmount } from './jobReservations.ts';
// Очередь принимает durable намерение до проекций и любых платных эффектов.
// Unknown никогда не отправляется снова; последняя сверка допуска предшествует POST без await.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { ACTIVE_STATUSES, parseStudio3d } from '../../../../shared/studio3d/studio3dContracts.ts';
import type { Studio3dBatchSnapshot } from '../../../../shared/studio3d/studio3dContracts.ts';
import {
  MISSING_TASK_WAIT_REASON,
  operationSpec,
  refineKind
} from '../../../../shared/studio3d/studio3dOperations.ts';
import type { FieldValues } from '../../../../shared/studio3d/studio3dOperations.ts';
import { withPathLock } from '../pathLock.ts';
import { createAdmission } from './admission.ts';
import type { AdmissionToken, StudioAdmission } from './admission.ts';
import { inspectGlbFile } from './analysisProcess.ts';
import { downloadToFile } from './download.ts';
import type { DownloadOptions } from './download.ts';
import { canonicalJson, requestFingerprint } from './intents.ts';
import type { IntentChild, IntentRecord, RunRequest, StudioIntents } from './intents.ts';
import { discardInputs, pinSnapshots, retainedInputs, selectJobInputs, snapshotInputs } from './jobInputs.ts';
import type { JobInputSelection } from './jobInputs.ts';
import { jobProjection, publicJobError, retryInfo, runProjection, taskProjection } from './jobProjections.ts';
import type { JobFileUrl } from './jobProjections.ts';
import { LIBRARY_UUID_RE } from './library.ts';
import type { DiskModel, DiskVersion, StudioLibrary } from './library.ts';
import { ProviderFailure } from './provider.ts';
import { START_CONTEXT } from './provider.ts';
import type {
  AccountSnapshot,
  Balance,
  InputContext,
  PlannedTask,
  RemoteTask,
  UsageRecord,
  Studio3dProvider,
  SubmittedTask,
} from './provider.ts';
import { ensureDirectory, isSafeName, pinDirectory, safeCopy } from './safePath.ts';
import { spendingFor } from './search.ts';

export { JobError } from './jobErrors.ts';
export { validateRunRequest } from './jobRequest.ts';

export interface JobsOptions {
  library: StudioLibrary;
  intents: StudioIntents;
  providers: Studio3dProvider[];
  admission?: StudioAdmission;
  broadcast?: (name: string, data: Record<string, unknown>) => void;
  download?: (options: DownloadOptions) => Promise<{ size: number; sha256: string }>;
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  fileUrl?: JobFileUrl;
  selectInputs?: typeof selectJobInputs;
  fault?: (boundary: string, record: IntentRecord, child?: IntentChild) => Promise<void>;
}

interface Reservation {
  account: string;
  amount: number;
  pool: string;
  limit: number | null;
  accepted: boolean;
  balanceBefore: number | null;
}

interface InflightRun {
  fingerprint: string;
  promise: Promise<ReturnType<typeof runProjection> extends Promise<infer T> ? T : never>;
}

const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,100}$/;

class Jobs {
  readonly admission: StudioAdmission;
  private readonly options: JobsOptions;
  private readonly providers: Map<string, Studio3dProvider>;
  private readonly inflight = new Map<string, InflightRun>();
  private readonly reservations = new Map<string, Reservation>();
  private readonly balances = new Map<string, { at: number; value: Promise<Balance | null> }>();
  private readonly leases = new Map<string, () => void>();
  private readonly downloadQueue: ReturnType<typeof createJobDownloadQueue>;
  private readonly downloads: ReturnType<typeof createJobDownloads>;
  private readonly batches: ReturnType<typeof createJobBatches>;
  private readonly snapshotLeases = new Map<string, number>();
  private readonly inflightBatches = new Map<string, { fingerprint: string; promise: Promise<unknown> }>();
  private timer: unknown = null;
  private ticking: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private stopped = false;
  private localActive = false;
  private readonly stopController = new AbortController();

  constructor(options: JobsOptions) {
    this.options = options;
    this.providers = new Map(options.providers.map((provider) => [provider.id, provider]));
    this.admission = options.admission ?? createAdmission(options.library.libraryId);
    this.downloadQueue = createJobDownloadQueue({
      run: (intentId, childId) => this.downloadResult(intentId, childId),
      isStopped: () => this.stopped,
    });
    this.downloads = createJobDownloads({
      library: this.options.library,
      intents: this.options.intents,
      signal: this.stopController.signal,
      at: () => this.at(),
      isStopped: () => this.stopped,
      lookupProvider: (id) => this.providers.get(id),
      download: (options) => (this.options.download ?? downloadToFile)(options),
      change: (intentId, childId, patch) => this.change(intentId, childId, patch),
      notify: (intentId, childId) => this.notify(intentId, childId),
      broadcast: (name, data) => this.broadcast(name, data),
      injectFault: (boundary, record, child) => this.injectFault(boundary, record, child),
      refreshLease: (record, child) => this.refreshLease(record, child),
    });
    this.batches = createJobBatches({
      library: this.options.library,
      intents: this.options.intents,
      admission: this.admission,
      lookupProvider: (id) => this.providers.get(id),
      at: () => this.at(),
      buildIntent: (...args) => this.buildIntent(...args),
      materialize: (record) => this.materialize(record),
      change: (intentId, childId, patch) => this.change(intentId, childId, patch),
      injectFault: (boundary, record, child) => this.injectFault(boundary, record, child),
      wake: () => this.wake(),
    });
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private at(): string {
    return new Date(this.now()).toISOString();
  }

  private key(intentId: string, childId: string): string {
    return `${intentId}:${childId}`;
  }

  private accountScope(record: IntentRecord): string {
    return JSON.stringify([record.provider, record.accountKey, record.unit]);
  }

  /**
   * State соединяет баланс поставщика и ещё не отражённые локальные резервы текущего аккаунта.
   * Frozen уже исключён из upstream available; повторно вычитать его нельзя.
   */
  async balanceView(provider: Studio3dProvider, captured: AccountSnapshot | undefined,
    balance: Balance | null): Promise<Balance | null> {
    if (!balance || !Number.isFinite(balance.available) || !Number.isFinite(balance.reserved)
      || balance.available < 0 || balance.reserved < 0) {
        return null;
      }
    if (!captured) {
      return balance;
    }
    
    const scope = JSON.stringify([provider.id, captured.accountKey, provider.unit]);
    const holds = new Map([...this.reservations.entries()].filter(([, item]) => item.account === scope));
    
    for (const record of await this.options.intents.list()) {
      if (record.provider !== provider.id || record.accountKey !== captured.accountKey) {
        continue;
      }
      
      for (const child of record.children) {
        const key = this.key(record.intentId, child.childId);
        
        if (['submitting', 'unknown', 'accepted'].includes(child.stage) &&
          child.remote?.state !== 'success') {
          holds.set(key, {
            account: scope,
            amount: child.actual ?? child.estimated,
            pool: child.pool?.key ?? record.operation,
            limit: child.pool?.limit ?? null,
            accepted: child.stage === 'accepted',
            balanceBefore: child.balanceBefore
          });
        } else if (child.stage !== 'prepared') {
          holds.delete(key);
        }
      }
    }
    
    const unreflected = unreflectedReservationAmount([...holds.values()], balance.available);
    
    return { available: Math.max(0, balance.available - unreflected),
      reserved: balance.reserved + unreflected };
  }

  private fileUrl(): JobFileUrl {
    return this.options.fileUrl ?? ((model, version, name) =>
      `/api/studio3d/files/${encodeURIComponent(model)}/${encodeURIComponent(version)}`
        + `/${encodeURIComponent(name)}`);
  }

  /**
   * Fault injection изображает падение процесса, а не сетевой отказ поставщика.
   * Путь recovery сохраняет последнее fsync состояние без переписывания на failed.
   */
  private async injectFault(boundary: string, record: IntentRecord, child?: IntentChild): Promise<void> {
    try {
      await this.options.fault?.(boundary, record, child);
    } catch (error) {
      throw new InjectedCrash(error);
    }
  }

  /**
   * Один in-flight promise объединяет нажатия до fsync, пока intent ещё нет.
   * Конфликт проверяется по исходному JSON и не ждёт copy чужого payload.
   */
  async run(value: unknown) {
    return this.runSelected(value);
  }

  /**
   * Selector принадлежит конкретному нажатию, не изменяет общий worker.
   * In-flight UUID объединяет обычные run и retry до первой durable записи.
   */
  private async runSelected(value: unknown, selector = this.options.selectInputs ?? selectJobInputs) {
    if (this.stopped) {
      throw new JobError('worker_stopped');
    }

    const request = validateRunRequest(value);
    const token = this.admission.capture(request.libraryId);
    const fingerprint = requestFingerprint(request);
    const active = this.inflight.get(request.idempotencyKey);

    if (this.inflightBatches.has(request.idempotencyKey)) {
      throw new JobError('idempotency_conflict');
    }

    if (active) {
      if (active.fingerprint !== fingerprint) {
        return Promise.reject(new JobError('idempotency_conflict'));
      }

      return active.promise;
    }

    const release = this.admission.lease();
    const promise = this.accept(request, fingerprint, token, selector).finally(() => {
      this.inflight.delete(request.idempotencyKey);
      release();
    });

    this.inflight.set(request.idempotencyKey, { fingerprint, promise });

    return promise;
  }

  /**
   * Сначала replay, затем capture account, проверка, snapshots и durable reserve.
   * Проекции materialize-ятся после journal; HTTP возвращает waiting без сети POST.
   */
  private async accept(request: RunRequest, fingerprint: string, token: AdmissionToken,
    selector: typeof selectJobInputs) {
    const { library, intents } = this.options;
    const previous = await intents.get(request.idempotencyKey, request.libraryId);

    if (previous) {
      if (previous.requestFingerprint !== fingerprint) {
        throw new JobError('idempotency_conflict');
      }

      await this.materialize(previous);

      return runProjection(previous, library, intents, this.fileUrl());
    }

    const provider = this.providers.get(request.provider);
    const captured = provider?.snapshot?.();

    if (!provider || !await provider.available()) {
      throw new JobError('provider_unavailable');
    }

    const selection = await selector(library, request, provider, captured);
    let model: DiskModel | null = null;
    const versions: DiskVersion[] = [];
    let saved = false;

    try {
      const record = await this.buildIntent(request, fingerprint, token, provider, captured, selection);

      model = record.model;
      versions.push(...record.children.flatMap((child) => child.version ? [child.version] : []));

      await this.admission.locked(async () => {
        if (!this.admission.current(token) || (captured && !provider.isCurrent?.(captured))) {
          throw new JobError('admission_changed');
        }

        if (record.operation === 'rig-check' && (await intents.list()).some((item) =>
          item.operation === 'rig-check' && item.modelId === record.modelId
          && item.parentVersionId === record.parentVersionId
          && item.children.some((child) => ACTIVE_STATUSES.includes(child.status)))) {
          throw new JobError('check_active');
        }

        await intents.reserve(record);
      });

      saved = true;

      await this.injectFault('after-intent', record);
      await this.materialize(record);
      this.wake();

      return runProjection((await intents.get(record.intentId))!, library, intents, this.fileUrl());
    } catch (error) {
      if (!saved && !await intents.get(request.idempotencyKey)) {
        if (model) {
          library.releasePlans(model.id, versions, !request.modelId);
        }

        await discardInputs(library, intents, request.idempotencyKey);
      }

      throw error;
    } finally {
      selection.release();
    }
  }

  /**
   * Подготовка строит полный воспроизводимый шаблон без проекций и POST.
   * Batch сохраняет все шаблоны сразу, чтобы recovery не пересоздавал каталог/IDs.
   */
  private async buildIntent(request: RunRequest, fingerprint: string, token: AdmissionToken,
    provider: Studio3dProvider, captured: AccountSnapshot | undefined,
    selection: JobInputSelection, batchParent: string | null = null): Promise<IntentRecord> {
    const { library, intents } = this.options;
    let model: DiskModel | null = null;
    const versions: DiskVersion[] = [];

    try {
      const spec = operationSpec(request.operation);
      const validation = provider.validate(request.operation, request.values, selection.context);

      const offered = provider.operations(selection.context)
        .some((item) => item.operation === request.operation);

      if (!spec || !offered
        || validation.errors.length || (selection.context.kind !== null
          && !spec.inputs.includes(selection.context.kind as typeof spec.inputs[number]))) {
        throw new JobError('validation_failed', { validation });
      }

      if (!spec.inputs.includes('text') && !selection.inputs.length) {
        throw new JobError('validation_failed', { message: 'Нужен сохранённый вход действия.' });
      }

      const values = validation.values;
      const quote = provider.quote(request.operation, values, selection.context);
      const price = requirePrice(quote, request.expectedPrice);

      if (!this.admission.current(token) || (captured && !provider.isCurrent?.(captured))) {
        throw new JobError('admission_changed');
      }

      if (request.operation === 'rig-check' && selection.version?.rigCheck?.status === 'pending') {
        throw new JobError('check_active');
      }

      const copied = await snapshotInputs(library, intents, request.idempotencyKey, selection.inputs);
      const planned = provider.local ? [{
        childId: 'child-1',
        label: spec.label,
        values,
        taskType: 'local',
        payload: null
      }] : provider.plan?.({
        operation: request.operation,
        values,
        inputs: copied.inputs,
        context: selection.context
      });

      if (!planned?.length || planned.length > 50
        || new Set(planned.map((child) => child.childId)).size !== planned.length
        || planned.some((child) => !isSafeName(child.childId))) {
        throw new JobError('invalid_plan');
      }

      const children: IntentChild[] = [];
      const at = this.at();

      model = request.modelId ? (await library.readModel(request.modelId)).model
        : await library.planModel({
          name: request.name ?? spec.label,
          project: request.project ?? null,
          category: request.category ?? null
        });

      for (const [index, plan] of planned.entries()) {
        const childPrice = requirePrice(provider.quote(request.operation, plan.values, selection.context),
          planned.length === 1 ? price : provider.quote(request.operation, plan.values,
            selection.context).total!);
        const version = spec.output === 'check' ? null : await library.planVersion(
          request.modelId ?? model, {
            kind: spec.output === 'same' ? selection.version?.kind ?? 'model' : spec.output,
            operation: request.operation,
            provider: provider.id,
            label: plan.label,
            parent: request.versionId ?? null,
            params: plan.values,
            status: 'waiting',
            intentId: request.idempotencyKey,
            childId: plan.childId,
            idempotencyKey: request.idempotencyKey,
            accountKey: captured?.accountKey ?? null,
            planIndex: index,
            cost: {
              estimated: childPrice,
              actual: provider.local ? 0 : null,
              free: provider.local,
              unit: quote.unit,
              state: provider.local ? 'free' : 'unpaid'
            }
          });

        if (version) {
          versions.push(version);
        }

        children.push({
          childId: plan.childId,
          operation: request.operation,
          values: plan.values,
          plan,
          version,
          stage: 'prepared',
          status: 'waiting',
          progress: 0,
          etaSeconds: null,
          estimated: childPrice,
          actual: provider.local ? 0 : null,
          paymentState: provider.local ? 'free' : 'unpaid',
          balanceBefore: null,
          taskId: null,
          taskType: plan.taskType,
          pool: provider.pool?.(request.operation, plan.values) ?? null,
          retryAt: null,
          submittedAt: null,
          updatedAt: at,
          completedAt: null,
          waitReason: null,
          error: null,
          remote: null,
          candidates: [],
          missedPolls: 0,
          notified: false,
          confirmationExpired: false,
        });
      }

      if (Math.round(children.reduce((sum, child) => sum + child.estimated, 0) * 100)
        !== Math.round(price * 100)) {
        throw new JobError('invalid_plan_price');
      }

      const record: IntentRecord = {
        schema: 1,
        kind: 'run',
        intentId: request.idempotencyKey,
        libraryId: library.libraryId,
        request,
        requestFingerprint: fingerprint,
        executionFingerprint: requestFingerprint({
          values,
          inputs: copied.snapshots,
          context: selection.context,
          parent: request.versionId ?? null
        }),
        accountKey: captured?.accountKey ?? null,
        provider: provider.id,
        operation: request.operation,
        values,
        confirmedPrice: price,
        unit: quote.unit,
        catalogVersion: requestFingerprint({ fields: provider.operations(selection.context),
          unit: quote.unit }),
        context: selection.context,
        model,
        modelId: model.id,
        parentVersionId: request.versionId ?? null,
        inputs: copied.snapshots,
        children,
        projectionReady: false,
        preparation: 'complete',
        batch: null,
        batchParent,
        createdAt: at,
        updatedAt: at,
        revision: 0,
      };

      return record;
    } catch (error) {
      if (model) {
        library.releasePlans(model.id, versions, !request.modelId);
      }

      await discardInputs(library, intents, request.idempotencyKey);

      throw error;
    }
  }

  /**
   * Только незавершённая initial проекция восстанавливается из шаблонов.
   * Удалённая после завершения модель остаётся tombstone, не воскресает при restart.
   */
  private async materialize(record: IntentRecord): Promise<void> {
    if (record.projectionReady || !record.model || !record.modelId) {
      return;
    }

    await this.options.library.materializeModel(record.model);

    for (const child of record.children) {
      if (child.version) {
        await this.options.library.materializeVersion(record.modelId, child.version);
      }

      await this.injectFault('after-projection', record, child);
    }

    await this.options.intents.update(record.intentId, (current) => {
      current.projectionReady = true;
    });
    await this.project(record.intentId);

    for (const child of record.children) {
      this.refreshLease(record, child);
    }
  }

  /**
   * Journal читается заново под projection lock, чтобы поздний poll не откатил
   * более свежую запись. Files/stats/user metadata сохраняются updater-ом.
   */
  private async project(intentId: string): Promise<void> {
    await withPathLock(`studio3d:projection:${this.options.library.dir}:${intentId}`, async () => {
      const record = await this.options.intents.get(intentId);

      if (!record?.modelId || !record.projectionReady) {
        return;
      }

      for (const child of record.children) {
        try {
          if (child.version) {
            await this.options.library.updateVersion(record.modelId, child.version.id, {
              status: child.status,
              progress: child.progress,
              etaSeconds: child.etaSeconds,
              task: child.taskId ? {
                provider: record.provider,
                id: child.taskId,
                type: child.taskType!
              } : null,
              cost: {
                estimated: child.estimated,
                actual: child.actual,
                free: child.paymentState === 'free',
                unit: record.unit,
                state: child.paymentState
              },
              error: publicJobError(child),
              waitReason: child.waitReason,
              retryAt: child.retryAt === null ? null : new Date(child.retryAt).toISOString(),
              submittedAt: child.submittedAt,
              missedPolls: child.missedPolls,
            });
          } else if (record.operation === 'rig-check' && record.parentVersionId) {
            const common = {
              jobId: record.intentId,
              childId: child.childId,
              at: child.updatedAt
            };
            const riggable = child.remote?.extra.riggable;
            const check = child.status === 'ready' && typeof riggable === 'boolean' ? {
              ...common,
              status: 'ready' as const,
              riggable,
              rigType: typeof child.remote?.extra.rigType === 'string' ? child.remote.extra.rigType : null
            } : child.status === 'failed' ? {
              ...common,
              status: 'failed' as const,
              error: publicJobError(child) ?? {
                kind: 'unknown',
                message: 'Проверка не завершилась.',
                detail: null
              }
            } : ['unknown', 'unresolved'].includes(child.status) ? {
              ...common,
              status: child.status as 'unknown' | 'unresolved',
              error: publicJobError(child)
            } : { ...common, status: 'pending' as const };

            await this.options.library.updateVersion(record.modelId, record.parentVersionId,
              { rigCheck: check });
          }
        } catch (error) {
          if (!['ENOENT', 'version_not_found'].includes((error as NodeJS.ErrnoException).code ?? '')) {
            throw error;
          }
        }
      }
    });
  }

  /**
   * Каждое изменение сначала fsync журнала, затем отдельная файловая проекция.
   * Снимок child из вызывающего poll не заменяет более свежие поля соседнего worker.
   */
  private async change(intentId: string, childId: string,
    patch: Partial<IntentChild>, guard?: (child: IntentChild) => boolean): Promise<IntentRecord> {
    const updated = await this.options.intents.update(intentId, (record) => {
      const child = record.children.find((item) => item.childId === childId);

      if (!child) {
        throw new JobError('child_not_found');
      }

      if (guard && !guard(child)) {
        return;
      }

      const changes = { ...patch };

      if (Object.hasOwn(patch, 'actual') && patch.actualSource !== 'usage') {
        if (child.actualSource === 'usage' || (patch.actual === null && child.actual !== null)) {
          changes.actual = child.actual;
          changes.actualSource = child.actualSource;
          changes.chargedAt = child.chargedAt;

          if (patch.paymentState !== 'refunded') {
            changes.paymentState = child.paymentState;
          }
        } else if (patch.actual !== null && patch.actual !== undefined) {
          changes.actualSource = 'task';
          changes.chargedAt = child.chargedAt ?? this.at();
        }
      }

      if (patch.actualSource === 'usage' && child.paymentState === 'refunded') {
        changes.paymentState = 'refunded';
      }

      if (Object.entries(changes).every(([key, value]) =>
        isDeepStrictEqual(child[key as keyof IntentChild], value))) {
        return;
      }

      Object.assign(child, changes, { updatedAt: this.at() });
      record.updatedAt = this.at();
    });

    await this.project(intentId);

    for (const child of updated.children) {
      this.refreshLease(updated, child);
    }

    return updated;
  }

  /**
   * Lease защищает parent проверок и версии заданий до терминального исхода.
   * Unknown активен бессрочно; close-unknown освобождает лишь локальную защиту.
   */
  private refreshLease(record: IntentRecord, child: IntentChild): void {
    const key = this.key(record.intentId, child.childId);
    const versionId = child.version?.id ?? record.parentVersionId;

    if (ACTIVE_STATUSES.includes(child.status) && record.modelId && versionId) {
      if (!this.leases.has(key)) {
        this.leases.set(key, this.options.library.leaseVersion(record.modelId, versionId, key));
      }
    } else {
      this.leases.get(key)?.();
      this.leases.delete(key);
    }
  }

  /**
   * Резервы восстанавливаются по accountKey и child, не по текущему ключу доступа.
   * Accepted занимает pool, unknown также держит расчётные деньги до решения.
   */
  private rebuildReservations(records: IntentRecord[]): void {
    for (const record of records) {
      for (const child of record.children) {
        this.refreshLease(record, child);

        const key = this.key(record.intentId, child.childId);

        if (['submitting', 'unknown', 'accepted'].includes(child.stage) && record.accountKey
          && child.remote?.state !== 'success') {
          this.reservations.set(key, {
            account: this.accountScope(record),
            amount: child.actual ?? child.estimated,
            pool: child.pool?.key ?? record.operation,
            limit: child.pool?.limit ?? null,
            accepted: child.stage === 'accepted',
            balanceBefore: child.balanceBefore
          });
        } else if (!this.localActive) {
          this.reservations.delete(key);
        }
      }
    }
  }

  /**
   * Timer принадлежит серверу и живёт без вкладки. Ошибка одного такта не
   * удаляет durable состояние; следующий читает его заново с обычной задержкой.
   */
  private wake(delay = 0): void {
    if (this.stopped || this.timer !== null) {
      return;
    }

    const callback = () => {
      this.timer = null;
      void this.tick().catch(() => {
        this.wake(15_000);
      });
    };

    this.timer = this.options.setTimer ? this.options.setTimer(callback, delay)
      : setTimeout(callback, delay);
    (this.timer as { unref?: () => void })?.unref?.();
  }

  /**
   * Одновременные ticks разделяют одно обещание. Downloads идут отдельно и
   * не задерживают пакетный poll остальных задач при медленном CDN.
   */
  tick(): Promise<void> {
    if (this.stopped) {
      return Promise.resolve();
    }

    this.ticking ??= this.performTick().finally(() => {
      this.ticking = null;
    });

    return this.ticking;
  }

  /**
   * Ошибка отдельной записи оставляет её журнал для следующего такта и не держит соседей.
   * Инъекция аварии остаётся исключением, чтобы проверки восстановления видели точку сбоя.
   */
  private async isolate(work: () => Promise<unknown>): Promise<boolean> {
    try {
      await work();

      return true;
    } catch (error) {
      if (error instanceof InjectedCrash) {
        throw error;
      }

      return false;
    }
  }

  /**
   * Сначала читаются принятые задачи, потом допускаются prepared дети.
   * Сбой одного provider/child не препятствует наблюдению остальных.
   */
  private async performTick(): Promise<void> {
    let records = await this.options.intents.list();

    for (const record of records) {
      if (record.kind === 'batch' && record.preparation === 'pending') {
        await this.isolate(() => this.batches.materializeBatch(record));
      }

      for (const child of record.children) {
        if (child.stage === 'submitting' && !child.taskId) {
          await this.isolate(() => this.change(record.intentId, child.childId, {
            stage: 'unknown',
            status: 'unknown',
            paymentState: 'unknown',
            waitReason: 'Ответ на отправку не сохранён; повторная оплата запрещена.'
          }, (current) => current.stage === 'submitting' && !current.taskId));
        }
      }
    }

    records = await this.options.intents.list();

    this.rebuildReservations(records);
    await this.pollRecords(records);
    await this.findUnknown(records);

    records = await this.options.intents.list();

    this.rebuildReservations(records);

    const groups = new Map(records.map((record) => [record.intentId, record]));
    const rows = new Map(records.flatMap((record) => record.batch?.rows
      .map((row, index) => [row.intentId, index] as const) ?? []));

    records.sort((a, b) => {
      const aGroup = a.batchParent ?? a.intentId;
      const bGroup = b.batchParent ?? b.intentId;
      const aTime = groups.get(aGroup)?.createdAt ?? a.createdAt;
      const bTime = groups.get(bGroup)?.createdAt ?? b.createdAt;

      return aTime.localeCompare(bTime) || aGroup.localeCompare(bGroup)
        || (rows.get(a.intentId) ?? -1) - (rows.get(b.intentId) ?? -1);
    });

    for (const record of records) {
      if (!record.projectionReady && record.kind === 'run') {
        if (!await this.isolate(() => this.materialize(record))) {
          continue;
        }
      }

      for (const child of record.children) {
        if (child.stage === 'prepared' && child.waitingSince
          && this.now() - Date.parse(child.waitingSince) >= 86_400_000) {
          await this.isolate(() => this.closeFundsWait(record, child));
          continue;
        }

        if (child.stage === 'prepared' && !child.confirmationExpired
          && (child.retryAt === null || child.retryAt <= this.now())
          && !await this.batches.batchBlocked(record)) {
          await this.isolate(() => this.dispatch(record, child));
        }

        if (child.stage === 'accepted' && child.remote?.state === 'success' && child.status !== 'failed') {
          this.enqueueDownload(record.intentId, child.childId);
        }

        if (child.stage === 'done') {
          await this.isolate(() => this.notify(record.intentId, child.childId));
        }
      }
    }

    this.pumpDownloads();

    if ((await this.options.intents.list()).some((record) => record.children
      .some((child) => ACTIVE_STATUSES.includes(child.status)))) {
      this.wake(3000);
    }
  }

  /**
   * Сутки без денег — решение человека не появится само. Позиция закрывается
   * без оплаты: POST не уходил, резерв у исполнителя не создавался.
   */
  private async closeFundsWait(record: IntentRecord, child: IntentChild): Promise<void> {
    const updated = await this.change(record.intentId, child.childId, {
      stage: 'rejected',
      status: 'failed',
      paymentState: 'unpaid',
      retryAt: null,
      waitingSince: null,
      completedAt: this.at(),
      waitReason: 'Не хватило средств в течение суток'
    });

    this.reservations.delete(this.key(record.intentId, child.childId));
    this.refreshLease(updated, updated.children.find((item) => item.childId === child.childId)!);
  }

  /**
   * Все позиции одного аккаунта разделяют бесплатное чтение баланса на 30 секунд.
   * Обещание кешируется до ответа, а отсутствие и отказ не создают шквал повторов за такт.
   */
  private readBalance(provider: Studio3dProvider, captured: AccountSnapshot): Promise<Balance | null> {
    const key = JSON.stringify([provider.id, captured.accountKey]);
    const cached = this.balances.get(key);

    if (cached && this.now() - cached.at < 30_000) {
      return cached.value;
    }

    const value = Promise.resolve().then(() => provider.balance?.(captured)).then((balance) => {
      if (!balance || !Number.isFinite(balance.available) || balance.available < 0
        || !Number.isFinite(balance.reserved) || balance.reserved < 0) {
        return null;
      }

      return balance;
    }).catch(() => null);

    this.balances.set(key, { at: this.now(), value });

    return value;
  }

  /**
   * Баланс и бесплатная prepare находятся вне lifecycle lock. Локальный reserve
   * учитывается до upload, а последний допуск/цена повторяются после каждого await.
   */
  private async dispatch(record: IntentRecord, child: IntentChild): Promise<void> {
    const provider = this.providers.get(record.provider);
    const captured = provider?.snapshot?.();

    if (!provider || !this.admission.canAccept() || this.stopped) {
      return;
    }

    if (!provider.local && (!captured || captured.accountKey !== record.accountKey
      || !provider.isCurrent?.(captured))) {
      await this.change(record.intentId, child.childId, { waitReason: 'Верните доступ исходного аккаунта.' });

      return;
    }

    const token = this.admission.capture(record.libraryId);
    const key = this.key(record.intentId, child.childId);

    if (!await retainedInputs(this.options.library, this.options.intents, record.intentId, record.inputs)) {
      await this.change(record.intentId, child.childId, {
        stage: 'rejected',
        status: 'failed',
        error: fallbackError('input', 'Сохранённые входы недоступны — загрузите их заново.'),
        paymentState: provider.local ? 'free' : 'unpaid',
        completedAt: this.at()
      });

      return;
    }

    if (provider.local) {
      await this.runLocal(record, child, provider);

      return;
    }

    let balance = null;

    try {
      balance = await this.readBalance(provider, captured!);

      if (balance && (!Number.isFinite(balance.available) || balance.available < 0
        || !Number.isFinite(balance.reserved) || balance.reserved < 0)) {
        balance = null;
      }
    } catch {
      await this.change(record.intentId, child.childId, { waitReason: 'Не удалось проверить баланс.' });

      return;
    }

    const allowed = await this.admission.locked(async () => {
      if (!this.admission.current(token) || !provider.isCurrent?.(captured!)) {
        return false;
      }

      const latest = (await this.options.intents.get(record.intentId))!;
      const current = latest.children.find((item) => item.childId === child.childId)!;

      if (current.stage !== 'prepared' || current.confirmationExpired
        || !await this.priceCurrent(latest, current, provider)) {
        return false;
      }

      const held = [...this.reservations.entries()].filter(([id, item]) => id !== key
        && item.account === this.accountScope(record));
      const pool = current.pool;
      const busy = pool?.limit !== null && pool?.limit !== undefined
        && held.filter(([, item]) => item.pool === pool.key).length >= pool.limit;
      const reserved = unreflectedReservationAmount(held.map(([, item]) => item), balance?.available ?? null);

      if (busy || balance === null || balance === undefined ||
        balance.available < reserved + child.estimated) {
        // Ожидание денег фиксируется отдельным сроком: такты обновляют waitReason
        // каждые 15 секунд, и скользящее updatedAt не годится для суток ожидания.
        await this.change(record.intentId, child.childId, {
          waitReason: busy ? 'Ждёт свободного слота.'
            : balance ? balance.available >= child.estimated && reserved > 0
              ? 'Ждёт подтверждения предыдущих списаний.' : 'Недостаточно доступных средств.'
              : 'Баланс неизвестен.',
          ...(busy ? {} : { waitingSince: current.waitingSince ?? this.at() })
        });

        return false;
      }

      this.reservations.set(key, {
        account: this.accountScope(record),
        amount: child.estimated,
        pool: pool?.key ?? child.operation,
        limit: pool?.limit ?? null,
        accepted: false,
        balanceBefore: balance.available
      });
      await this.change(record.intentId, child.childId, { balanceBefore: balance.available });

      return true;
    });

    if (!allowed) {
      return;
    }

    let snapshots: Awaited<ReturnType<typeof pinSnapshots>>;

    try {
      snapshots = await pinSnapshots(this.options.library, this.options.intents, record);
    } catch {
      this.reservations.delete(key);
      await this.change(record.intentId, child.childId, {
        stage: 'rejected',
        status: 'failed',
        paymentState: 'unpaid',
        completedAt: this.at(),
        error: fallbackError('input', 'Сохранённый снимок недоступен — отправка не оплачена.')
      });

      return;
    }

    try {
      let prepared: PlannedTask;

      try {
        prepared = await provider.prepare!(child.plan!, captured!);
      } catch (error) {
        this.reservations.delete(key);

        if (!this.admission.current(token) || !provider.isCurrent?.(captured!)) {
          await this.change(record.intentId, child.childId,
            { waitReason: 'Допуск изменился во время подготовки.' });

          return;
        }

        const failure = error instanceof ProviderFailure ? error.error
          : fallbackError('input', 'Не удалось подготовить сохранённый вход.');

        await this.change(record.intentId, child.childId, {
          stage: 'rejected',
          status: 'failed',
          error: failure,
          paymentState: 'unpaid',
          completedAt: this.at()
        });

        return;
      }

      const sending = await this.admission.locked(async () => {
        if (!this.admission.current(token) || !provider.isCurrent?.(captured!) || this.stopped) {
          this.reservations.delete(key);
          await this.change(record.intentId, child.childId,
            { waitReason: 'Допуск изменился во время подготовки.' });

          return null;
        }

        const latest = (await this.options.intents.get(record.intentId))!;
        const current = latest.children.find((item) => item.childId === child.childId)!;

        if (current.stage !== 'prepared' || current.confirmationExpired
          || !await this.priceCurrent(latest, current, provider) || await this.batches.batchBlocked(latest)) {
          this.reservations.delete(key);

          return null;
        }

        await this.change(record.intentId, child.childId, {
          stage: 'submitting',
          status: 'waiting',
          paymentState: 'reserved',
          submittedAt: this.at(),
          waitReason: null
        });
        await this.injectFault('before-send', latest, current);

        if (!this.admission.current(token) || !provider.isCurrent?.(captured!) || this.stopped) {
          this.reservations.delete(key);
          await this.change(record.intentId, child.childId, {
            stage: 'prepared',
            status: 'waiting',
            paymentState: 'unpaid',
            submittedAt: null,
            waitReason: 'Допуск изменился перед отправкой.'
          });

          return null;
        }

        if (!this.priceMatches(latest, current, provider)) {
          this.reservations.delete(key);
          await this.change(record.intentId, child.childId, {
            stage: 'prepared',
            status: 'waiting',
            paymentState: 'unpaid',
            submittedAt: null,
            confirmationExpired: true,
            waitReason: 'price_changed'
          });

          return null;
        }

        try {
          snapshots.verifyNow();
        } catch (error) {
          this.reservations.delete(key);
          await this.change(record.intentId, child.childId, {
            stage: 'rejected',
            status: 'failed',
            paymentState: 'unpaid',
            submittedAt: null,
            completedAt: this.at(),
            error: fallbackError('input', 'Исходный снимок изменился — отправка не оплачена.')
          });

          return null;
        }

        // Никакого await между этой сверкой и началом POST. Обёртка не даёт
        // withPathLock удерживать lock до ответа сети.
        try {
          return { response: provider.send!(prepared, captured!) };
        } catch (error) {
          return { response: Promise.reject(error) as Promise<SubmittedTask> };
        }
      });

      if (!sending) {
        return;
      }

      let submitted: SubmittedTask;

      try {
        submitted = await sending.response;

        if (!TASK_ID_RE.test(submitted.taskId) || submitted.taskType !== child.taskType) {
          throw new ProviderFailure(fallbackError('unknown', 'Ответ не подтвердил номер заказа.'), null);
        }
      } catch (error) {
        const failure = error instanceof ProviderFailure ? error
          : new ProviderFailure(fallbackError('network', 'Исход отправки неизвестен.'), null);

        if (failure.submitted !== false) {
          await this.change(record.intentId, child.childId, {
            stage: 'unknown',
            status: 'unknown',
            paymentState: 'unknown',
            error: failure.error,
            waitReason: 'Заказ мог быть принят и оплачен.'
          });
        } else {
          this.reservations.delete(key);

          const waiting = ['busy', 'rate', 'credits'].includes(failure.error.kind);

          await this.change(record.intentId, child.childId, {
            stage: waiting ? 'prepared' : 'rejected',
            status: waiting ? 'waiting' : 'failed',
            paymentState: 'unpaid',
            error: failure.error,
            retryAt: waiting ? this.now() + (failure.error.retryAfterMs ?? 15_000) : null,
            completedAt: waiting ? null : this.at(),
            waitReason: waiting ? failure.error.message : null,
            ...(failure.error.kind === 'credits'
              ? { waitingSince: child.waitingSince ?? this.at() } : {})
          });
        }

        return;
      }

      await this.injectFault('after-send', record, child);
      await this.options.intents.update(record.intentId, (latest) => {
        const current = latest.children.find((item) => item.childId === child.childId)!;

        Object.assign(current, {
          stage: 'accepted',
          status: 'queued',
          taskId: submitted.taskId,
          taskType: submitted.taskType,
          error: null,
          retryAt: null,
          updatedAt: this.at()
        });
        latest.updatedAt = this.at();
      });
      await this.injectFault('after-task-id', record, child);
      await this.project(record.intentId);

      const held = this.reservations.get(key);

      if (held) {
        held.accepted = true;
      }

      this.broadcast('studio-changed', { intentId: record.intentId, modelId: record.modelId });
    } finally {
      await snapshots.close();
    }
  }

  /**
   * Цена waiting пересчитывается целиком для исходного списка children.
   * После изменения требуется новое нажатие даже если старая цена вернулась.
   */
  private async priceCurrent(record: IntentRecord, child: IntentChild,
    provider: Studio3dProvider): Promise<boolean> {
    if (!this.priceMatches(record, child, provider)) {
      await this.change(record.intentId, child.childId, {
        confirmationExpired: true,
        waitReason: 'price_changed',
        error: fallbackError('params', 'Цена изменилась — подтвердите новый расчёт.')
      });

      return false;
    }

    return true;
  }

  /**
   * Последняя цена/нормализация проверяются синхронно после fsync submitting.
   * Новая версия каталога требует нового подтверждения, сохраняя replay старого UUID.
   */
  private priceMatches(record: IntentRecord, child: IntentChild, provider: Studio3dProvider): boolean {
    try {
      const quote = provider.quote(record.operation, record.values, record.context);
      const current = provider.quote(child.operation, child.values, record.context);
      const validation = provider.validate(child.operation, child.values, record.context);

      return quote.total !== null && current.total !== null && Number.isFinite(quote.total)
        && Number.isFinite(current.total) && current.total >= 0 && quote.total >= 0
        && Math.round(quote.total * 100) === Math.round(record.confirmedPrice * 100)
        && Math.round(current.total * 100) === Math.round(child.estimated * 100)
        && requestFingerprint(quote.unit) === requestFingerprint(record.unit)
        && validation.errors.length === 0 && canonicalJson(validation.values) === canonicalJson(child.values)
        && record.catalogVersion === requestFingerprint({
          fields: provider.operations(record.context),
          unit: quote.unit
        });
    } catch {
      return false;
    }
  }

  /**
   * Poll разделён по provider/account, выдаёт не более 100 ID за вызов.
   * Смена доступа после ответа запрещает запись чужих результатов в старый intent.
   */
  private async pollRecords(records: IntentRecord[]): Promise<void> {
    for (const provider of this.providers.values()) {
      const captured = provider.snapshot?.();

      for (const record of records.filter((item) => item.provider === provider.id
        && item.accountKey !== captured?.accountKey)) {
        for (const child of record.children.filter((item) => item.stage === 'accepted'
          || item.stage === 'unknown')) {
          if (child.waitReason !== 'Верните доступ исходного аккаунта.') {
            await this.isolate(() => this.change(record.intentId, child.childId, {
              waitReason: 'Верните доступ исходного аккаунта.'
            }));
          }
        }
      }

      const pairs = records.filter((record) => record.provider === provider.id
        && record.accountKey === captured?.accountKey).flatMap((record) => record.children
        .filter((child) => child.stage === 'accepted' && child.taskId && child.remote?.state !== 'success'
          && (child.retryAt === null || child.retryAt <= this.now())).map((child) => ({ record, child })));

      if (!captured || !provider.poll || !provider.isCurrent?.(captured)) {
        continue;
      }

      for (let offset = 0; offset < pairs.length; offset += 100) {
        const group = pairs.slice(offset, offset + 100);
        let response;

        try {
          response = await provider.poll(group.map(({ child }) => child.taskId!), captured);
        } catch (error) {
          if (!provider.isCurrent?.(captured)) {
            continue;
          }

          const retry = error instanceof ProviderFailure ? error.error.retryAfterMs ?? 15_000 : 15_000;

          for (const { record, child } of group) {
            await this.isolate(() => this.change(record.intentId, child.childId, {
              retryAt: this.now() + retry,
              waitReason: 'Нет связи — наблюдение продолжится.'
            }));
          }

          continue;
        }

        if (!provider.isCurrent?.(captured) || this.stopped) {
          continue;
        }

        for (const { record, child } of group) {
          const remote = response.tasks.find((item) => item.id === child.taskId);

          if (!remote || remote.type !== child.taskType) {
            await this.isolate(() => this.change(record.intentId, child.childId, {
              missedPolls: child.missedPolls + 1,
              retryAt: child.missedPolls >= 2 ? this.now() + 60_000 : null,
              waitReason: child.missedPolls >= 2 ? MISSING_TASK_WAIT_REASON
                : 'Заказ пока не найден; проверьте доступ.'
            }));

            continue;
          }

          await this.isolate(() => this.observe(record, child, remote));
        }
      }
    }
  }

  /**
   * Success фиксирует списание до CDN, fail/refund только подтверждённый ответ.
   * Missing result у проверки не выдаёт ready без достоверного riggable.
   */
  private async observe(record: IntentRecord, child: IntentChild, remote: RemoteTask): Promise<void> {
    const common = {
      remote,
      progress: remote.progress,
      etaSeconds: remote.etaSeconds,
      missedPolls: 0,
      retryAt: null,
      waitReason: null,
      error: null
    };

    if (remote.state === 'success') {
      const check = record.operation === 'rig-check';
      const valid = !check || typeof remote.extra.riggable === 'boolean';
      const updated = await this.change(record.intentId, child.childId, {
        ...common,
        stage: check ? 'done' : 'accepted',
        status: check ? valid ? 'ready' : 'failed' : 'downloading',
        actual: remote.cost,
        paymentState: child.estimated === 0 && !(remote.cost! > 0) ? 'free' : 'charged',
        completedAt: check ? this.at() : null,
        error: valid ? null : fallbackError('unknown', 'Поставщик не вернул результат проверки.')
      });

      this.reservations.delete(this.key(record.intentId, child.childId));
      this.refreshLease(updated, updated.children.find((item) => item.childId === child.childId)!);

      if (check) {
        await this.notify(record.intentId, child.childId);
      } else {
        this.enqueueDownload(record.intentId, child.childId);
      }
    } else if (['failed', 'cancelled', 'banned', 'expired'].includes(remote.state)) {
      const refunded = remote.error?.message.includes('Кредиты вернулись') === true;
      const updated = await this.change(record.intentId, child.childId, {
        ...common,
        stage: 'done',
        status: 'failed',
        completedAt: this.at(),
        actual: remote.cost,
        paymentState: refunded ? 'refunded' : child.estimated === 0 && !(remote.cost! > 0) ? 'free'
          : remote.cost !== null ? 'charged' : 'unknown',
        error: remote.error ?? fallbackError('unknown', 'Поставщик сообщил об отказе задачи.')
      });

      this.reservations.delete(this.key(record.intentId, child.childId));
      this.refreshLease(updated, updated.children.find((item) => item.childId === child.childId)!);
      await this.notify(record.intentId, child.childId);
    } else {
      await this.change(record.intentId, child.childId, { ...common,
        status: remote.state === 'running' ? 'running' : 'queued' });
      this.broadcast('studio-progress', {
        intentId: record.intentId,
        childId: child.childId,
        modelId: record.modelId,
        versionId: child.version?.id ?? null,
        status: remote.state === 'running' ? 'running' : 'queued',
        progress: remote.progress,
        etaSeconds: remote.etaSeconds
      });
    }
  }

  /**
   * History лишь предлагает кандидатов того же аккаунта/времени/типа.
   * Даже единственное совпадение не доказывает корреляцию с Cockpit POST.
   */
  private async findUnknown(records: IntentRecord[]): Promise<void> {
    for (const provider of this.providers.values()) {
      const captured = provider.snapshot?.();
      const targets = records.filter((record) => record.provider === provider.id
        && record.accountKey === captured?.accountKey &&
          record.children.some((child) => child.stage === 'unknown'
          && (child.retryAt === null || child.retryAt <= this.now())));

      if (!targets.length || !captured || !provider.history || !provider.isCurrent?.(captured)) {
        continue;
      }

      let history;

      try {
        history = await provider.history(captured);
      } catch {
        continue;
      }

      if (!provider.isCurrent?.(captured) || this.stopped) {
        continue;
      }

      for (const record of targets) {
        for (const child of record.children.filter((item) => item.stage === 'unknown')) {
          const start = Date.parse(child.submittedAt ?? record.createdAt) - 60_000;
          const candidates = history.filter((item) => item.type === child.taskType && item.createdAt !== null
            && Date.parse(item.createdAt) >= start && Date.parse(item.createdAt) <= start + 16 * 60_000)
            .slice(0, 100).map((item) => ({ ...item }));

          await this.isolate(() => this.change(record.intentId, child.childId, {
            candidates,
            retryAt: this.now() + (this.now() - start > 10 * 60_000 ? 60_000 : 15_000)
          }));
        }
      }
    }
  }

  private broadcast(name: string, data: Record<string, unknown>): void {
    this.options.broadcast?.(name, { libraryId: this.options.library.libraryId, ...data });
  }

  /**
   * Флаг уведомления фиксируется до SSE: restart не повторяет terminal toast.
   * При разрыве доставки browser перечитает журнал через общую reconnect подписку.
   */
  private async notify(intentId: string, childId: string): Promise<void> {
    const record = await this.options.intents.get(intentId);
    const child = record?.children.find((item) => item.childId === childId);

    if (!record || !child || child.notified || child.stage !== 'done') {
      return;
    }

    await this.injectFault('after-done', record, child);
    await this.options.intents.update(intentId, (latest) => {
      latest.children.find((item) => item.childId === childId)!.notified = true;
    });
    await this.injectFault('after-notified', record, child);
    this.broadcast('studio-changed', {
      intentId,
      childId,
      modelId: record.modelId,
      versionId: child.version?.id ?? null,
      status: child.status,
      terminal: true
    });
  }

  /**
   * Очередь CDN дедуплицируется по intent/child и ограничена двумя потоками.
   * Tick продолжает poll, даже когда загрузка другой модели занимает минуты.
   */
  private enqueueDownload(intentId: string, childId: string): void {
    this.downloadQueue.enqueue(intentId, childId);
  }

  private pumpDownloads(): void {
    this.downloadQueue.pump();
  }

  /**
   * Публикуются только полные required roles после подтверждения fd/SHA.
   * Remote success остаётся charged при ошибке CDN и разрешает free redownload.
   */
  private downloadResult(intentId: string, childId: string): Promise<void> {
    return this.downloads.downloadResult(intentId, childId);
  }

  /**
   * Протухший CDN URL обновляется только бесплатным poll того же account/task.
   * Смена доступа не подменяет результаты и не вызывает нового POST.
   */
  private refreshOutput(record: IntentRecord, child: IntentChild, outputId: string): Promise<string> {
    return this.downloads.refreshOutput(record, child, outputId);
  }

  /**
   * Повтор публикации после сбоя JSON принимает лишь тот же SHA destination.
   * Orphan файл не обслуживается API до явной durable записи его manifest.
   */
  private publishFile(record: IntentRecord, child: IntentChild, source: string,
    name: string, role: string, id?: string): Promise<void> {
    return this.downloads.publishFile(record, child, source, name, role, id);
  }

  /**
   * Локальное действие публикует результат из своей temporary папки и не
   * использует cloud submitting. Crash можно пересчитать без списания денег.
   */
  private async runLocal(record: IntentRecord, child: IntentChild,
    provider: Studio3dProvider): Promise<void> {
    if (this.localActive || !child.version || !record.inputs[0]?.name) {
      return;
    }

    this.localActive = true;

    const outputDir = path.join(this.options.intents.directory(record.intentId), 'local', child.childId);

    try {
      await this.change(record.intentId, child.childId, { status: 'running' });
      await ensureDirectory(this.options.library.dir, outputDir);
      await fs.rm(path.join(outputDir, 'model.glb'), { force: true });

      const result = await provider.run!({
        operation: child.operation,
        values: child.values,
        inputPath: this.options.intents.inputPath(record.intentId, record.inputs[0].name),
        context: record.context,
        outputDir,
        root: this.options.library.dir,
        signal: this.stopController.signal
      });

      if (this.stopped) {
        return;
      }

      for (const file of result.files) {
        await this.publishFile(record, child, path.join(outputDir, file.name), file.name, file.role);
      }

      const main = result.files.find((file) => file.role === 'model');
      const stats = main ? await inspectGlbFile(path.join(outputDir, main.name), {
        root: this.options.library.dir,
        signal: this.stopController.signal
      }) : null;

      await this.options.library.updateVersion(record.modelId!, child.version.id, {
        stats,
        label: result.label,
        kind: refineKind(child.version.kind, stats)
      });

      const updated = await this.change(record.intentId, child.childId, {
        stage: 'done',
        status: 'ready',
        progress: 100,
        completedAt: this.at(),
        actual: 0,
        paymentState: 'free'
      });

      this.refreshLease(updated, updated.children.find((item) => item.childId === child.childId)!);
      await this.notify(record.intentId, child.childId);
    } catch (error) {
      if (error instanceof InjectedCrash) {
        throw error;
      }

      if (!this.stopped) {
        await this.change(record.intentId, child.childId, {
          stage: 'done',
          status: 'failed',
          error: fallbackError('input', 'Не удалось обработать GLB; исходная версия сохранена.'),
          paymentState: 'free',
          completedAt: this.at()
        });
      }
    } finally {
      this.localActive = false;
    }
  }

  /**
   * Recovery завершает initial проекции до допуска POST и консервативно
   * превращает durable submitting без ID в unknown без повторной отправки.
   */
  async resume(): Promise<void> {
    await this.options.intents.load();

    const records = await this.options.intents.list();

    for (const record of records) {
      if (record.kind === 'batch') {
        await this.batches.materializeBatch(record);
      }

      await this.materialize(record);

      for (const child of record.children) {
        if (child.stage === 'submitting' && !child.taskId) {
          await this.change(record.intentId, child.childId, {
            stage: 'unknown',
            status: 'unknown',
            paymentState: 'unknown',
            waitReason: 'Заказ мог быть принят до перезапуска.'
          }, (current) => current.stage === 'submitting' && !current.taskId);
        }
      }

      await this.project(record.intentId);
    }

    this.rebuildReservations(await this.options.intents.list());
    this.wake();
  }

  /**
   * Получение UUID не разрешает inputs заново и не проверяет текущую цену.
   * Library admission проверяется прежде чтения независимого durable журнала.
   */
  async job(id: string, libraryId = this.options.library.libraryId) {
    this.admission.capture(libraryId);

    const record = await this.options.intents.get(id, libraryId);

    if (!record) {
      throw new JobError('intent_not_found');
    }

    return jobProjection(record, this.options.library, this.options.intents);
  }

  /**
   * Разбор unknown связывает выбранный человеком ID под общим lock аккаунта.
   * Бесплатный poll подтверждает тип и доступ; второй child не присваивает тот же ID.
   */
  async reconcile(intentId: string, childId: string, input: { libraryId: string; taskId: string }) {
    const token = this.admission.capture(input.libraryId);
    const record = await this.options.intents.get(intentId, input.libraryId);
    const child = record?.children.find((item) => item.childId === childId);
    const provider = record ? this.providers.get(record.provider) : null;
    const captured = provider?.snapshot?.();

    if (!record) {
      throw new JobError('intent_not_found');
    }
    if (!child) {
      throw new JobError('child_not_found');
    }

    if (!record || !child || !['unknown', 'unresolved'].includes(child.stage)
      || !TASK_ID_RE.test(input.taskId) || !captured || captured.accountKey !== record.accountKey) {
      throw new JobError('reconcile_unavailable');
    }

    const response = await provider!.poll!([input.taskId], captured);
    const remote = response.tasks.find((item) => item.id === input.taskId);

    if (!remote || remote.type !== child.taskType || !provider!.isCurrent?.(captured)) {
      throw new JobError('reconcile_unavailable');
    }

    await this.admission.locked(async () => {
      if (!this.admission.current(token) || !provider!.isCurrent?.(captured)) {
        throw new JobError('admission_changed');
      }

      const records = await this.options.intents.list();
      const latest = records.find((item) => item.intentId === intentId)!;
      const current = latest.children.find((item) => item.childId === childId)!;

      if (current.taskId === input.taskId && ['accepted', 'done'].includes(current.stage)) {
        return;
      }

      if (!['unknown', 'unresolved'].includes(current.stage)) {
        throw new JobError('reconcile_unavailable');
      }

      if (records.some((item) => item.provider === record.provider && item.accountKey === record.accountKey
        && item.children.some((candidate) => candidate.taskId === input.taskId
          && (item.intentId !== intentId || candidate.childId !== childId)))) {
        throw new JobError('task_already_linked');
      }

      await this.change(intentId, childId, {
        stage: 'accepted',
        status: 'queued',
        taskId: input.taskId,
        retryAt: null,
        waitReason: null,
        error: null,
        remote: null,
        completedAt: null,
        notified: false,
        paymentState: 'reserved'
      });
    });

    this.wake();

    return this.job(intentId, input.libraryId);
  }

  /**
   * Close не отменяет задачу у provider и не обещает refund. Tombstone и unknown
   * расход сохраняются; поздний явный reconcile ещё может уточнить исход.
   */
  async closeUnknown(intentId: string, childId: string, libraryId: string) {
    const token = this.admission.capture(libraryId);

    await this.admission.locked(async () => {
      if (!this.admission.current(token)) {
        throw new JobError('admission_changed');
      }

      const record = await this.options.intents.get(intentId, libraryId);
      const child = record?.children.find((item) => item.childId === childId);

      if (!record) {
        throw new JobError('intent_not_found');
      }
      if (!child) {
        throw new JobError('child_not_found');
      }

      const missingAccepted = child.stage === 'accepted' && child.missedPolls >= 3;

      if (child.stage !== 'unknown' && child.stage !== 'prepared' && !missingAccepted) {
        throw new JobError('close_unknown_unavailable');
      }

      if (child.stage === 'prepared') {
        // Отмена до отправки: оплаты не было и задача поставщику не уходила.
        const cancelled = await this.change(intentId, childId, {
          stage: 'rejected',
          status: 'failed',
          paymentState: 'unpaid',
          retryAt: null,
          waitingSince: null,
          completedAt: this.at(),
          waitReason: 'Отменено до отправки: оплаты не было.'
        });

        this.reservations.delete(this.key(intentId, childId));
        this.refreshLease(cancelled, cancelled.children.find((item) => item.childId === childId)!);
      } else {
        const updated = await this.change(intentId, childId, {
          stage: 'unresolved',
          status: 'unresolved',
          paymentState: 'unknown',
          retryAt: null,
          completedAt: this.at(),
          waitReason: 'Ожидание прекращено. Заказ мог быть принят и оплачен; это не отмена у поставщика.'
        });

        this.reservations.delete(this.key(intentId, childId));
        this.refreshLease(updated, updated.children.find((item) => item.childId === childId)!);

        if (record.batchParent) {
          const parent = await this.options.intents.get(record.batchParent);

          for (const row of parent?.batch?.rows ?? []) {
            const sibling = await this.options.intents.get(row.intentId);

            for (const pending of sibling?.children ?? []) {
              if (pending.stage === 'prepared') {
                await this.change(sibling!.intentId, pending.childId, {
                  stage: 'rejected',
                  status: 'failed',
                  paymentState: 'unpaid',
                  waitReason: 'Неотправленная строка закрыта при прекращении ожидания пачки.',
                  completedAt: this.at(),
                });
              }
            }
          }
        }
      }
    });

    return this.job(intentId, libraryId);
  }

  /**
   * Retry создаёт новое durable намерение и сестру только для доказанного отказа.
   * Исходные snapshots копируются в новый UUID, новый quote подтверждается отдельно.
   */
  async retry(intentId: string, childId: string,
    input: {
      libraryId: string;
      idempotencyKey: string;
      expectedPrice: number
    }) {
    this.admission.capture(input.libraryId);

    const record = await this.options.intents.get(intentId, input.libraryId);
    const child = record?.children.find((item) => item.childId === childId);

    if (!record || !child) {
      throw new JobError('retry_unavailable');
    }

    const source = record.request as RunRequest;
    const request: RunRequest = {
      ...source,
      libraryId: input.libraryId,
      idempotencyKey: input.idempotencyKey,
      expectedPrice: input.expectedPrice,
      values: child.values,
      uploads: undefined,
      modelId: record.modelId!,
      versionId: record.parentVersionId ?? undefined
    };
    // Replay нового UUID выполняется до этой проверки: TTL входов и исчезнувший
    // parent не меняют исход уже принятого повторного нажатия.
    const retrySelector: typeof selectJobInputs = async () => {
      await withPathLock(`studio3d:gc:${this.options.library.dir}:${record.intentId}`, async () => {
        if (!(await retryInfo(record, child, this.options.library, this.options.intents)).available) {
          throw new JobError('retry_unavailable');
        }

        this.snapshotLeases.set(record.intentId, (this.snapshotLeases.get(record.intentId) ?? 0) + 1);
      });

      return {
        context: record.context,
        version: child.version,
        inputs: record.inputs.map((snapshot) => ({
          role: snapshot.role,
          native: snapshot.native,
          file: snapshot.name ? {
            path: this.options.intents.inputPath(intentId, snapshot.name),
            name: snapshot.name,
            root: this.options.library.dir
          } : null
        })),
        release: () => {
          const count = (this.snapshotLeases.get(record.intentId) ?? 1) - 1;

          if (count > 0) {
            this.snapshotLeases.set(record.intentId, count);
          } else {
            this.snapshotLeases.delete(record.intentId);
          }
        }
      };
    };

    const result = await this.runSelected(request, retrySelector);

    if (child.stage === 'prepared' && child.confirmationExpired) {
      await this.admission.locked(async () => {
        const latest = await this.options.intents.get(intentId);
        const current = latest?.children.find((item) => item.childId === childId);

        if (current?.stage === 'prepared') {
          await this.change(intentId, childId, {
            stage: 'rejected',
            status: 'failed',
            paymentState: 'unpaid',
            completedAt: this.at(),
            waitReason: 'Новая цена подтверждена отдельным заказом; эта позиция не отправлена.'
          });
        }
      });
    }

    return result;
  }

  /**
   * Free redownload сохраняет task ID/расход и повторяет только CDN GET.
   * Обычный paid retry для этого состояния недоступен.
   */
  async redownload(intentId: string, childId: string, libraryId: string) {
    this.admission.capture(libraryId);

    const record = await this.options.intents.get(intentId, libraryId);
    const child = record?.children.find((item) => item.childId === childId);

    if (!record || !child || child.remote?.state !== 'success' || child.status !== 'failed') {
      throw new JobError('redownload_unavailable');
    }

    await this.change(intentId, childId, {
      status: 'downloading',
      completedAt: null,
      error: null
    });
    this.enqueueDownload(intentId, childId);
    this.pumpDownloads();

    return this.job(intentId, libraryId);
  }

  /**
   * Расходы вычисляются по постоянному журналу, не по существующим моделям.
   * Дата фильтрует время принятия; estimated/refund/unknown остаются отдельными.
   */
  async spending(from = -Infinity, to = Infinity) {
    const records = await this.options.intents.list();

    return spendingFor(records.filter((record) => Date.parse(record.createdAt) >= from
      && Date.parse(record.createdAt) <= to).flatMap((record) => record.children.map((child) => ({
        provider: record.provider,
        cost: {
          estimated: child.estimated,
          actual: child.actual,
          unit: record.unit,
          free: child.paymentState === 'free',
          state: child.paymentState
        }
      }))));
  }

  /**
   * Строки задач читаются из постоянного журнала и адресуются childId.
   * Удаление model projection не стирает финансовый или неизвестный исход.
   */
  async tasks() {
    const records = await this.options.intents.list();
    const rows = [];

    for (const record of records) {
      for (const child of record.children) {
        rows.push(await taskProjection(record, child, this.options.library, this.options.intents));
      }
    }

    return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /**
   * История списаний связывается только по exact task/provider/captured account.
   * Durable actual предшествует проекции; unknown без taskId не получает догадку.
   */
  async observeUsage(providerId: string, captured: AccountSnapshot, usages: UsageRecord[]): Promise<void> {
    const provider = this.providers.get(providerId);

    if (this.stopped || !provider?.isCurrent?.(captured)) {
      return;
    }

    const known = new Map(usages.filter((usage) => usage.credits !== null && Number.isFinite(usage.credits)
      && usage.credits >= 0).map((usage) => [usage.taskId, usage]));

    for (const record of await this.options.intents.list()) {
      if (record.kind !== 'run' || record.provider !== providerId ||
        record.accountKey !== captured.accountKey) {
        continue;
      }

      for (const child of record.children) {
        const usage = child.taskId ? known.get(child.taskId) : null;

        if (!usage || usage.type !== child.taskType || this.stopped || !provider.isCurrent?.(captured)) {
          continue;
        }

        if (child.actual === usage.credits && child.actualSource === 'usage' && child.chargedAt) {
          continue;
        }

        await this.change(record.intentId, child.childId, {
          actual: usage.credits,
          actualSource: 'usage',
          chargedAt: usage.createdAt ?? child.chargedAt ?? this.at(),
          paymentState: child.paymentState === 'refunded' ? 'refunded'
            : child.estimated === 0 && usage.credits === 0 ? 'free' : 'charged'
        });
      }
    }
  }

  /**
   * Все строки считаются и проверяются до подготовки batch. Сумма имеет одну
   * единицу; смешанные валюты не превращаются в общий итог подтверждения.
   */
  quoteBatch(input: { libraryId: string; rows: Studio3dBatchSnapshot['rows'] }) {
    return this.batches.quoteBatch(input);
  }

  /**
   * Batch replay проверяет исходный fingerprint до текущего каталога. Новый
   * batch проверяет весь snapshot и сохраняет parent перед всеми row intents.
   */
  async runBatch(input: {
    libraryId: string;
    idempotencyKey: string;
    snapshot: Studio3dBatchSnapshot;
    snapshotHash: string;
  }) {
    this.admission.capture(input.libraryId);

    if (Object.keys(input).some((key) => ![
      'libraryId', 'idempotencyKey', 'snapshot', 'snapshotHash',
    ].includes(key)) || !LIBRARY_UUID_RE.test(input.idempotencyKey)) {
      throw new JobError('invalid_batch');
    }

    const fingerprint = requestFingerprint(input);
    const active = this.inflightBatches.get(input.idempotencyKey);

    if (this.inflight.has(input.idempotencyKey)) {
      throw new JobError('idempotency_conflict');
    }

    if (active) {
      if (active.fingerprint !== fingerprint) {
        throw new JobError('idempotency_conflict');
      }

      return active.promise as ReturnType<typeof this.batch>;
    }

    const release = this.admission.lease();
    const promise = this.batches.acceptBatch(input, fingerprint).finally(() => {
      this.inflightBatches.delete(input.idempotencyKey);
      release();
    });

    this.inflightBatches.set(input.idempotencyKey, { fingerprint, promise });

    return promise;
  }

  /**
   * Статус каждой строки берётся с сервера; родительский снимок не теряется
   * при reload, а успешно оплаченная строка никогда не отправляется снова.
   */
  batch(intentId: string, libraryId = this.options.library.libraryId) {
    return this.batches.batch(intentId, libraryId);
  }

  /**
   * GC удаляет лишь terminal snapshots после семи суток и uploads после суток.
   * Активные/unknown заказы и lease повторного copy сохраняют свои входы.
   */
  async cleanup(): Promise<void> {
    const { library, intents } = this.options;
    const records = await intents.list();

    for (const record of records) {
      if (!record.children.length || this.snapshotLeases.has(record.intentId)
        || record.children.some((child) => ACTIVE_STATUSES.includes(child.status))
        || record.children.some((child) => !child.completedAt
          || this.now() - Date.parse(child.completedAt) < 7 * 86_400_000)) {
        continue;
      }

      await withPathLock(`studio3d:gc:${library.dir}:${record.intentId}`, async () => {
        if (this.snapshotLeases.has(record.intentId)) {
          return;
        }

        const current = await intents.get(record.intentId);

        if (current?.children.some((child) => ACTIVE_STATUSES.includes(child.status))) {
          return;
        }

        const pinned = await pinDirectory(library.dir, intents.directory(record.intentId));

        try {
          for (const name of ['inputs', 'downloads', 'local']) {
            await pinned.verify();
            await fs.rm(pinned.child(name), { recursive: true, force: true });
          }

          await pinned.verify();
          await pinned.handle.sync();
        } finally {
          await pinned.close();
        }
      });
    }

    await library.cleanUploads(86_400_000);
  }

  /**
   * Проверка busy включает отсутствие версий у rig-check и отдельные downloads.
   * Pending lease допуска защищает библиотеку во время acceptance copy.
   */
  async busy(): Promise<boolean> {
    return this.admission.pendingCount() > 0 || this.localActive || this.downloadQueue.activeCount() > 0
      || (await this.options.intents.list()).some((record) => record.children
        .some((child) => ACTIVE_STATUSES.includes(child.status)));
  }

  /**
   * Тесты/закрытие могут дождаться своей download очереди без удержания poll lock.
   * Сетевой tick не вызывает это ожидание и остаётся независимым от CDN.
   */
  settle(): Promise<void> {
    return this.downloadQueue.settle();
  }

  /**
   * Stop прекращает новые sends и таймер, затем ждёт только собственную работу.
   * Durable записи остаются для resume; library owner закрывает lifecycle позже.
   */
  stop(): Promise<void> {
    this.stopping ??= this.performStop();

    return this.stopping;
  }

  /**
   * Один barrier разделяется повторными stop, чтобы старый экземпляр не
   * отменял чтения нового worker через общий capability после закрытия.
   */
  private async performStop(): Promise<void> {
    this.stopped = true;
    this.stopController.abort();

    for (const provider of this.providers.values()) {
      provider.cancelReads?.();
    }

    if (this.timer !== null) {
      if (this.options.clearTimer) {
        this.options.clearTimer(this.timer);
      } else {
        clearTimeout(this.timer as ReturnType<typeof setTimeout>);
      }
    }

    this.timer = null;
    this.downloadQueue.clearWaiting();

    await this.ticking;
    await this.downloadQueue.waitActive();

    for (const release of this.leases.values()) {
      release();
    }

    this.leases.clear();
  }
}

/**
 * Фабрика не запускает сеть или таймер до run/resume. Все внешние эффекты
 * инъецируются, чтобы offline проверки использовали только fake и отдельный /tmp.
 */
export function createJobs(options: JobsOptions): Jobs {
  return new Jobs(options);
}

export type StudioJobs = ReturnType<typeof createJobs>;

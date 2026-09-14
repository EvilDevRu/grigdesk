import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
} from 'node:fs';
import path from 'node:path';

import { ingestRecording, readIngestJob, startIngestJob } from '../media/ingest.ts';
import { preflightAsync } from '../media/preflight.ts';
import {
  CUDA_STATES,
  SPEECH_LANGUAGES,
  probeSpeechModelCache,
  residentUnavailable,
  runCudaCanary,
} from './capabilities.ts';
import type { CudaState, SpeechModelStatus } from './capabilities.ts';
import { SPEECH_MODEL_CATALOG } from './catalog.ts';
import {
  isCudaRuntimeFailure,
  speechModelMissing,
  speechStreamBusy,
  speechUnavailable,
  speechWarmupBusy,
} from './errors.ts';
import { normalizeSpeechOptions, resolveSpeechOptions } from './options.ts';
import type { SpeechOptions } from './options.ts';
import { pythonEnv } from './transport.ts';
import { createSpeechStreamSession } from './stream.ts';
import type { SpeechStreamSession, StreamEvent } from './stream.ts';
import {
  createWarmupProcess,
  speechOptionsRevision,
} from './warmup.ts';
import type { WarmupController } from './warmup.ts';
import type { ModelJobManager } from './modelJobs.ts';

// Готовность окружения: проверки media runtime и состояние кэша моделей.
export interface SpeechReadiness {
  environmentReady: boolean;
  environmentChecks: readonly { name: string; ok: boolean; fix?: string }[];
  models: readonly SpeechModelStatus[];
  venvPython: string;
}

// Что показывает раздел «Речь»: готовность локального пути и его проверки.
export interface LocalCapability {
  ready: boolean;
  reason: string | null;
  checks: readonly { name: string; ok: boolean; fix?: string }[];
}

// Запись живого прогрева: процесс, его параметры и срок годности.
interface WarmupRecord {
  warmupId: string;
  state: string;
  expiresAt: number;
  optionsRevision: string;
  requestedSpeech: SpeechOptions;
  executionSpeech: SpeechOptions;
  identity: unknown;
  controller: WarmupController;
  timer: { unref?: () => void } | null;
}

// Запись живого потока диктовки: слот, его сессия и буфер событий до подписки.
interface StreamRecord {
  streamId: string;
  clientSessionId: string | null;
  state: string;
  optionsRevision: string;
  onEvent: ((event: unknown) => void) | null;
  signal: AbortSignal | null;
  abortHandler: (() => void) | null;
  workDir: string | null;
  session: SpeechStreamSession | null;
  sessionListener: ((event: StreamEvent) => void) | null;
  bufferedEvents: StreamEvent[];
  bufferingEvents: boolean;
  execution: Record<string, unknown> | null;
  cancelPromise: Promise<boolean> | null;
  deathPromise: Promise<boolean> | null;
  released: boolean;
}

// Подменяемые в тестах зависимости runtime.
type RuntimeDeps = Record<string, any>;

function abortError(): Error {
  const error = new Error('Распознавание отменено');
  error.name = 'AbortError';
  return error;
}

function awaitWithSignal<Value>(
  promise: Promise<Value> | Value,
  signal: AbortSignal | null | undefined,
): Promise<Value> {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<Value>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function isResolvedOptions(value: unknown): boolean {
  const source = value as Record<string, unknown> | null;
  return Boolean(source
    && typeof source === 'object'
    && source.model
    && (source.language || source.lang)
    && source.device
    && source.computeType
    && Number.isInteger(source.beamSize));
}

function localCapability(
  { environmentReady, environmentChecks, models }: SpeechReadiness,
  modelId: string,
): LocalCapability {
  const selectedModel = models.find((model) => model.modelId === modelId);
  const modelReady = Boolean(selectedModel?.cached);
  const failed = environmentChecks.find((check) => !check.ok);
  const modelCheck = Object.freeze({
    name: `модель ${modelId} в локальном кэше`,
    ok: modelReady,
    fix: `скачать модель ${modelId} в настройках речи`,
  });
  return Object.freeze({
    ready: Boolean(environmentReady) && modelReady,
    reason: failed ? failed.name : (modelReady ? null : modelCheck.name),
    checks: Object.freeze([...environmentChecks, modelCheck]),
  });
}

function assertLocalReady(readiness: SpeechReadiness, modelId: string): void {
  if (!readiness.environmentReady) {
    const failed = readiness.environmentChecks.find((check) => !check.ok);
    throw speechUnavailable(
      `Локальное распознавание недоступно: ${failed?.name || 'media runtime не готов'}`,
    );
  }
  const selected = readiness.models.find((model) => model.modelId === modelId);
  if (!selected?.cached) {
    throw speechModelMissing(`Локальная модель ${modelId} не найдена в кэше`);
  }
}

function fallbackModels(): SpeechModelStatus[] {
  return Object.values(SPEECH_MODEL_CATALOG).map((model) => Object.freeze({
    modelId: model.modelId,
    repo: model.repo,
    revision: model.revision,
    cached: false,
    sizeMb: 0,
  }));
}

function normalizeCuda(
  value: { state?: unknown; reason?: unknown; device?: unknown } | null,
): CudaState {
  if (!value || !CUDA_STATES.includes(String(value.state))) {
    return Object.freeze({ state: 'probe_failed', reason: 'CUDA probe вернул некорректный ответ' });
  }
  return Object.freeze({
    state: String(value.state),
    reason: value.reason ? String(value.reason) : null,
    ...(value.device != null ? { device: value.device } : {}),
  });
}

const EMPTY_LOCAL = Object.freeze({
  ready: false,
  reason: 'Диагностика локальной речи ещё не завершена',
  checks: Object.freeze([]),
});

/** Единый runtime для локальной диктовки и detached video jobs. */
export class SpeechRuntime {
  readonly mediaDir: string;

  readonly jobsDir: string;

  readonly mediaHfDir: string;

  readonly pythonPath: string;

  readonly transcribePath: string | undefined;

  readonly baseEnv: NodeJS.ProcessEnv;

  settings: Record<string, unknown>;

  lastDictionaryMeasure: Record<string, unknown> | null;

  readonly warmupTtlMs: number;

  readonly maxWarmups: number;

  readonly maxStreams: number;

  readonly autoCudaProbeTimeoutMs: number;

  readonly deps: RuntimeDeps;

  private pendingWarmups: number;

  private diagnosticGeneration: number;

  private readinessCache: { generation: number; value: SpeechReadiness } | null;

  private readinessSnapshot: SpeechReadiness | null;

  private readinessInflight: { generation: number; promise: Promise<SpeechReadiness> } | null;

  private capabilitiesCache: { generation: number; value: Record<string, unknown> } | null;

  private capabilitiesSnapshot: Record<string, unknown> | null;

  private capabilitiesInflight:
  { generation: number; promise: Promise<Record<string, unknown>> } | null;

  private cudaDecisionCache: { generation: number; value: CudaState } | null;

  private cudaDecisionInflight: { generation: number; promise: Promise<CudaState> } | null;

  private warmups: Map<string, WarmupRecord>;

  private streams: Map<string, StreamRecord>;

  modelJobs: ModelJobManager | null;

  private closed: boolean;

  constructor({
    mediaDir,
    jobsDir = path.join(mediaDir, 'jobs'),
    mediaHfDir = process.env.COCKPIT_MEDIA_HF_DIR || path.join(path.dirname(mediaDir), 'hf'),
    pythonPath = process.env.COCKPIT_MEDIA_PYTHON || '',
    transcribePath = process.env.COCKPIT_TRANSCRIBE_PY || undefined,
    baseEnv = process.env,
    settings = {},
    lastDictionaryMeasure = null,
    warmupTtlMs = 120_000,
    maxWarmups = 4,
    maxStreams = 2,
    autoCudaProbeTimeoutMs = 5_000,
    deps = {},
  }: {
    mediaDir: string;
    jobsDir?: string;
    mediaHfDir?: string;
    pythonPath?: string;
    transcribePath?: string;
    baseEnv?: NodeJS.ProcessEnv;
    settings?: Record<string, unknown>;
    lastDictionaryMeasure?: Record<string, unknown> | null;
    warmupTtlMs?: number;
    maxWarmups?: number;
    maxStreams?: number;
    autoCudaProbeTimeoutMs?: number;
    deps?: RuntimeDeps;
  }) {
    if (!mediaDir) throw new TypeError('SpeechRuntime требует mediaDir');
    if (!Number.isInteger(maxWarmups) || maxWarmups < 1) {
      throw new TypeError('SpeechRuntime maxWarmups должен быть положительным целым');
    }
    if (!Number.isInteger(maxStreams) || maxStreams < 1) {
      throw new TypeError('SpeechRuntime maxStreams должен быть положительным целым');
    }
    if (!Number.isFinite(warmupTtlMs) || warmupTtlMs <= 0) {
      throw new TypeError('SpeechRuntime warmupTtlMs должен быть положительным');
    }
    this.mediaDir = mediaDir;
    this.jobsDir = jobsDir;
    this.mediaHfDir = mediaHfDir;
    this.pythonPath = pythonPath;
    this.transcribePath = transcribePath;
    this.baseEnv = baseEnv;
    this.settings = (settings?.speech && typeof settings.speech === 'object'
      ? settings.speech
      : settings) as Record<string, unknown>;
    this.lastDictionaryMeasure = lastDictionaryMeasure;
    this.warmupTtlMs = warmupTtlMs;
    this.maxWarmups = maxWarmups;
    this.maxStreams = maxStreams;
    this.pendingWarmups = 0;
    this.autoCudaProbeTimeoutMs = autoCudaProbeTimeoutMs;
    this.diagnosticGeneration = 0;
    this.readinessCache = null;
    this.readinessSnapshot = null;
    this.readinessInflight = null;
    this.capabilitiesCache = null;
    this.capabilitiesSnapshot = null;
    this.capabilitiesInflight = null;
    this.cudaDecisionCache = null;
    this.cudaDecisionInflight = null;
    this.warmups = new Map();
    this.streams = new Map();
    this.modelJobs = null;
    this.closed = false;
    this.deps = {
      ingestRecording,
      startIngestJob,
      readIngestJob,
      preflight: preflightAsync,
      probeSpeechModelCache,
      runCudaCanary,
      createWarmupProcess,
      createSpeechStreamSession,
      mkdirSync,
      mkdtempSync,
      rmSync,
      statSync,
      randomUUID,
      now: Date.now,
      setTimeout,
      clearTimeout,
      ...deps,
    };
    if (deps.inspectSpeechModelCache && !deps.probeSpeechModelCache) {
      this.deps.probeSpeechModelCache = deps.inspectSpeechModelCache;
    }
  }

  attachModelJobs(modelJobs: ModelJobManager | null): ModelJobManager | null {
    if (!modelJobs || typeof modelJobs !== 'object') {
      throw new TypeError('SpeechRuntime требует ModelJobManager');
    }
    if (this.modelJobs && this.modelJobs !== modelJobs) {
      throw new Error('ModelJobManager уже прикреплён к SpeechRuntime');
    }
    this.modelJobs = modelJobs;
    return modelJobs;
  }

  reconcileModelJobs(): Promise<number> | number {
    return this.modelJobs?.reconcileCompleted?.() ?? 0;
  }

  startModelDownload(modelId: string) {
    return this.modelJobs?.startDownload(modelId);
  }

  startModelCopy(modelId: string) {
    return this.modelJobs?.startCopy(modelId);
  }

  startModelBenchmark(options: unknown) {
    return this.modelJobs?.startBenchmark(options);
  }

  readModelJob(jobId: string) {
    return this.modelJobs?.readJob(jobId);
  }

  cancelModelJob(jobId: string) {
    return this.modelJobs?.cancelJob(jobId);
  }

  #options(settings: unknown, options: unknown, scenario: string): SpeechOptions {
    if (isResolvedOptions(options)) return normalizeSpeechOptions(options, scenario);
    return resolveSpeechOptions(options ?? settings ?? this.settings, scenario);
  }

  #pythonEnv(): NodeJS.ProcessEnv {
    return pythonEnv({
      mediaHfDir: this.mediaHfDir,
      pythonPath: this.pythonPath,
      baseEnv: this.baseEnv,
    });
  }

  #invalidateDiagnostics(): void {
    this.diagnosticGeneration += 1;
    this.readinessCache = null;
    this.capabilitiesCache = null;
    this.cudaDecisionCache = null;
  }

  async #probeReadiness(generation: number): Promise<SpeechReadiness> {
    const env = this.#pythonEnv();
    const [preflightResult, modelsResult] = await Promise.allSettled([
      this.deps.preflight({ pythonPath: this.pythonPath, env }),
      this.deps.probeSpeechModelCache({
        pythonPath: this.pythonPath,
        mediaHfDir: this.mediaHfDir,
        env,
      }),
    ]);
    const report = preflightResult.status === 'fulfilled'
      ? preflightResult.value
      : {
          ok: false,
          checks: [{
            name: 'диагностика media runtime',
            ok: false,
            fix: preflightResult.reason?.message || 'повторить проверку',
          }],
          venvPython: this.pythonPath,
        };
    const models = modelsResult.status === 'fulfilled' ? modelsResult.value : fallbackModels();
    const modelCacheCheck = modelsResult.status === 'rejected'
      ? Object.freeze({
          name: 'диагностика кэша моделей',
          ok: false,
          fix: modelsResult.reason?.message || 'повторить проверку',
        })
      : null;
    const readiness = Object.freeze({
      environmentReady: Boolean(report.ok) && !modelCacheCheck,
      environmentChecks: Object.freeze([
        ...(report.checks || []),
        ...(modelCacheCheck ? [modelCacheCheck] : []),
      ]),
      models: Object.freeze(models),
      venvPython: report.venvPython ?? this.pythonPath,
    });
    if (generation === this.diagnosticGeneration) {
      this.readinessCache = { generation, value: readiness };
      this.readinessSnapshot = readiness;
    }
    return readiness;
  }

  #readinessForGeneration(generation: number): Promise<SpeechReadiness> {
    if (this.readinessCache?.generation === generation) {
      return Promise.resolve(this.readinessCache.value);
    }
    if (this.readinessInflight?.generation === generation) return this.readinessInflight.promise;
    const promise = this.#probeReadiness(generation);
    const entry = { generation, promise };
    this.readinessInflight = entry;
    promise.finally(() => {
      if (this.readinessInflight === entry) this.readinessInflight = null;
    }).catch(() => {});
    return promise;
  }

  #readiness(): Promise<SpeechReadiness> {
    return this.#readinessForGeneration(this.diagnosticGeneration);
  }

  async #probeCapabilities(generation: number): Promise<Record<string, unknown>> {
    const readiness = await this.#readinessForGeneration(generation);
    const dictation = resolveSpeechOptions(this.settings, 'dictation');
    const local = localCapability(readiness, dictation.model);
    const canaryModel = readiness.models.find((model) => model.cached) || null;
    let cuda: CudaState;
    try {
      cuda = normalizeCuda(await this.deps.runCudaCanary({
        pythonPath: this.pythonPath,
        env: this.#pythonEnv(),
        model: canaryModel,
      }));
    } catch (error) {
      cuda = normalizeCuda({ state: 'probe_failed', reason: (error as Error).message });
    }
    const snapshot: Record<string, unknown> = Object.freeze({
      ok: local.ready,
      ready: local.ready,
      checks: readiness.environmentChecks,
      ...readiness,
      venvPython: readiness.venvPython,
      local,
      cuda,
      languages: SPEECH_LANGUAGES,
      lastDictionaryMeasure: this.lastDictionaryMeasure,
      resident: residentUnavailable(),
    });
    if (generation === this.diagnosticGeneration) {
      this.capabilitiesCache = { generation, value: snapshot };
      this.capabilitiesSnapshot = snapshot;
      this.cudaDecisionCache = { generation, value: cuda };
    }
    return snapshot;
  }

  #capabilitiesForGeneration(generation: number): Promise<Record<string, unknown>> {
    if (this.capabilitiesCache?.generation === generation) {
      return Promise.resolve(this.capabilitiesCache.value);
    }
    if (this.capabilitiesInflight?.generation === generation) return this.capabilitiesInflight.promise;
    const promise = this.#probeCapabilities(generation);
    const entry = { generation, promise };
    this.capabilitiesInflight = entry;
    promise.finally(() => {
      if (this.capabilitiesInflight === entry) this.capabilitiesInflight = null;
    }).catch(() => {});
    return promise;
  }

  async capabilities({ refresh = false } = {}): Promise<Record<string, unknown>> {
    if (refresh) this.#invalidateDiagnostics();
    // Model worker detached: завершение возможно без открытого polling. Reconcile
    // принадлежит runtime, чтобы settings и media/doctor не видели разные кэши.
    await this.reconcileModelJobs();
    return this.#capabilitiesForGeneration(this.diagnosticGeneration);
  }

  invalidateCapabilities(): void {
    this.#invalidateDiagnostics();
  }

  refreshCapabilities(): Promise<Record<string, unknown>> {
    return this.capabilities({ refresh: true });
  }

  publicSnapshot(settings: Record<string, unknown> = this.settings) {
    const source = (settings?.speech && typeof settings.speech === 'object'
      ? settings.speech
      : settings) as Record<string, unknown> | null;
    const readiness = this.readinessCache?.value || this.readinessSnapshot;
    const local = readiness
      ? localCapability(readiness, resolveSpeechOptions(source, 'dictation').model)
      : EMPTY_LOCAL;
    return {
      engine: source?.engine ?? 'browser',
      browserProcessing: source?.browserProcessing ?? 'auto',
      browserAutoConsent: source?.browserAutoConsent ?? false,
      language: source?.language ?? 'ru',
      dictionary: source?.dictionary ?? '',
      local,
      resident: this.capabilitiesSnapshot?.resident || residentUnavailable(),
    };
  }

  async publicSnapshotAsync(settings: Record<string, unknown> = this.settings) {
    const source = (settings?.speech && typeof settings.speech === 'object'
      ? settings.speech
      : settings) as Record<string, unknown> | null;
    const readiness = await this.#readiness();
    return {
      engine: source?.engine ?? 'browser',
      browserProcessing: source?.browserProcessing ?? 'auto',
      browserAutoConsent: source?.browserAutoConsent ?? false,
      language: source?.language ?? 'ru',
      dictionary: source?.dictionary ?? '',
      local: localCapability(readiness, resolveSpeechOptions(source, 'dictation').model),
      resident: this.capabilitiesSnapshot?.resident || residentUnavailable(),
    };
  }

  applyRuntimeSettings(settings: Record<string, unknown> = {}) {
    this.settings = (settings?.speech && typeof settings.speech === 'object'
      ? settings.speech
      : settings) as Record<string, unknown>;
    this.#invalidateDiagnostics();
    // Startup/save прогревает только readiness. CUDA-canary нужен settings GET, но не
    // browser-default startup и не синхронный publicSnapshot.
    void this.#readiness().catch(() => {});
    return this.publicSnapshot(this.settings);
  }

  #knownCuda(): CudaState | null {
    const current = this.capabilitiesCache?.generation === this.diagnosticGeneration
      ? this.capabilitiesCache.value
      : this.capabilitiesSnapshot;
    return (current?.cuda as CudaState | undefined)
      || (this.cudaDecisionCache?.generation === this.diagnosticGeneration
        ? this.cudaDecisionCache.value
        : null);
  }

  #probeAutoCuda(): Promise<CudaState> {
    const generation = this.diagnosticGeneration;
    if (this.cudaDecisionCache?.generation === generation) {
      return Promise.resolve(this.cudaDecisionCache.value);
    }
    if (this.cudaDecisionInflight?.generation === generation) {
      return this.cudaDecisionInflight.promise;
    }
    const probe = Promise.resolve().then(() => this.deps.runCudaCanary({
      pythonPath: this.pythonPath,
      env: this.#pythonEnv(),
      model: null,
      timeoutMs: this.autoCudaProbeTimeoutMs,
    })).then(normalizeCuda, (error: unknown) => normalizeCuda({
      state: 'probe_failed',
      reason: (error as Error).message,
    }));
    let timer: { unref?: () => void } | null = null;
    const timeout = new Promise<CudaState>((resolve) => {
      timer = this.deps.setTimeout(() => resolve(normalizeCuda({
        state: 'probe_failed',
        reason: `CUDA probe превысил ${this.autoCudaProbeTimeoutMs} мс`,
      })), this.autoCudaProbeTimeoutMs);
      timer?.unref?.();
    });
    const promise = Promise.race([probe, timeout]).then((cuda) => {
      this.deps.clearTimeout(timer);
      if (generation === this.diagnosticGeneration) {
        this.cudaDecisionCache = { generation, value: cuda };
      }
      return cuda;
    });
    const entry = { generation, promise };
    this.cudaDecisionInflight = entry;
    promise.finally(() => {
      if (this.cudaDecisionInflight === entry) this.cudaDecisionInflight = null;
    }).catch(() => {});
    return promise;
  }

  async #executionSpeech(speech: SpeechOptions): Promise<SpeechOptions> {
    if (speech.device === 'cpu') {
      return Object.freeze({
        ...speech,
        device: 'cpu',
        computeType: speech.computeType === 'auto' ? 'int8' : speech.computeType,
      });
    }
    if (speech.device === 'auto') {
      const cuda = this.#knownCuda() || await this.#probeAutoCuda();
      if (cuda?.state === 'ready') {
        return Object.freeze({
          ...speech,
          device: 'cuda',
          computeType: speech.computeType === 'auto' ? 'float16' : speech.computeType,
        });
      }
      return Object.freeze({ ...speech, device: 'cpu', computeType: 'int8' });
    }

    let cuda = this.#knownCuda();
    if (!cuda) cuda = (await this.capabilities()).cuda as CudaState;
    if (cuda?.state !== 'ready') {
      throw speechUnavailable(`CUDA недоступна: ${cuda?.reason || cuda?.state}`);
    }
    return Object.freeze({
      ...speech,
      device: 'cuda',
      computeType: speech.computeType === 'auto' ? 'float16' : speech.computeType,
    });
  }

  #cpuFallback(speech: SpeechOptions): SpeechOptions {
    return Object.freeze({ ...speech, device: 'cpu', computeType: 'int8' });
  }

  #recordDictionaryMeasure(result: Record<string, unknown> | null): void {
    const measure = (result?.transcript || result) as Record<string, unknown> | null;
    if (!Number.isInteger(measure?.hotwordsTokens)) return;
    this.lastDictionaryMeasure = Object.freeze({
      tokens: measure?.hotwordsTokens,
      truncated: Boolean(measure?.hotwordsTruncated),
      measuredAt: this.deps.now(),
    });
    if (this.capabilitiesCache?.value) {
      const updated = Object.freeze({
        ...this.capabilitiesCache.value,
        lastDictionaryMeasure: this.lastDictionaryMeasure,
      });
      this.capabilitiesCache = { ...this.capabilitiesCache, value: updated };
      this.capabilitiesSnapshot = updated;
    } else if (this.capabilitiesSnapshot) {
      this.capabilitiesSnapshot = Object.freeze({
        ...this.capabilitiesSnapshot,
        lastDictionaryMeasure: this.lastDictionaryMeasure,
      });
    }
  }

  async #oneShot({ filePath, workDir, signal, requestedSpeech, forceCpu = false }: {
    filePath: string;
    workDir: string;
    signal?: AbortSignal | null;
    requestedSpeech: SpeechOptions;
    forceCpu?: boolean;
  }): Promise<Record<string, unknown>> {
    if (signal?.aborted) throw abortError();
    let speech = forceCpu
      ? this.#cpuFallback(requestedSpeech)
      : await awaitWithSignal(this.#executionSpeech(requestedSpeech), signal);
    let fallback: string | null = forceCpu ? 'warmup_cuda_failed' : null;
    let result: Record<string, unknown>;
    try {
      result = await this.deps.ingestRecording({
        filePath,
        workDir,
        speech,
        frames: 0,
        pythonPath: this.pythonPath,
        transcribePath: this.transcribePath,
        mediaHfDir: this.mediaHfDir,
        baseEnv: this.baseEnv,
        // Runner процесса принимает отсутствие сигнала, но не null: вызов без
        // отмены (самопроверка речи раздела презентаций) иначе падал на проверке типа.
        signal: signal ?? undefined,
      });
    } catch (error) {
      if (requestedSpeech.device !== 'auto' || speech.device !== 'cuda' || !isCudaRuntimeFailure(error)) {
        throw error;
      }
      speech = this.#cpuFallback(requestedSpeech);
      fallback = 'cuda_failed';
      result = await this.deps.ingestRecording({
        filePath,
        workDir,
        speech,
        frames: 0,
        pythonPath: this.pythonPath,
        transcribePath: this.transcribePath,
        mediaHfDir: this.mediaHfDir,
        baseEnv: this.baseEnv,
        // Runner процесса принимает отсутствие сигнала, но не null: вызов без
        // отмены (самопроверка речи раздела презентаций) иначе падал на проверке типа.
        signal: signal ?? undefined,
      });
    }
    const value = {
      ...result,
      execution: {
        engine: 'whisper',
        mode: 'one-shot',
        device: speech.device,
        ...(fallback ? { fallback } : {}),
      },
    };
    this.#recordDictionaryMeasure(value);
    return value;
  }

  #claimWarmup(warmupId: string | null): WarmupRecord | null {
    const record = warmupId ? this.warmups.get(warmupId) : null;
    if (!record || record.state !== 'available') return null;
    if (this.deps.now() >= record.expiresAt) {
      record.state = 'expired';
      this.warmups.delete(String(warmupId));
      this.deps.clearTimeout(record.timer);
      void record.controller.cancel().catch(() => {});
      return null;
    }
    // Map mutation происходит до первого await — claim атомарен для конкурирующих uploads.
    record.state = 'claimed';
    this.deps.clearTimeout(record.timer);
    return record;
  }

  async #finishWarmup(record: WarmupRecord | null): Promise<void> {
    if (!record) return;
    this.warmups.delete(record.warmupId);
    try { await record.controller.cancel(); } catch { /* процесс уже мог выйти после result */ }
  }

  #reserveWarmupSlot(): void {
    const now = this.deps.now();
    for (const [warmupId, record] of this.warmups) {
      if (record.state !== 'available' || now < record.expiresAt) continue;
      record.state = 'expired';
      this.warmups.delete(warmupId);
      this.deps.clearTimeout(record.timer);
      void record.controller.cancel().catch(() => {});
    }
    if (this.warmups.size + this.pendingWarmups >= this.maxWarmups) {
      throw speechWarmupBusy();
    }
    this.pendingWarmups += 1;
  }

  async warmup({ settings = null, options = null, optionsRevision = null }: {
    settings?: Record<string, unknown> | null;
    options?: unknown;
    optionsRevision?: string | null;
  } = {}): Promise<{ warmupId: string; expiresAt: number; optionsRevision: string }> {
    if (this.closed) throw speechUnavailable('SpeechRuntime уже остановлен');
    // Detached download может закончиться без polling/settings GET. Подбираем его
    // до cached readiness, иначе реально появившаяся модель останется missing.
    await this.reconcileModelJobs();
    if (this.closed) throw speechUnavailable('SpeechRuntime уже остановлен');
    this.#reserveWarmupSlot();
    let controller: WarmupController | null = null;
    let registered = false;
    try {
      const requestedSpeech = this.#options(settings, options, 'dictation');
      const readiness = await this.#readiness();
      assertLocalReady(readiness, requestedSpeech.model);
      const executionSpeech = await this.#executionSpeech(requestedSpeech);
      const warmupId = this.deps.randomUUID();
      const nonce = this.deps.randomUUID();
      const expiresAt = this.deps.now() + this.warmupTtlMs;
      const revision = speechOptionsRevision(
        requestedSpeech,
        (optionsRevision ?? settings?._revision ?? settings?.revision ?? null) as string | null,
      );
      controller = await this.deps.createWarmupProcess({
        pythonPath: this.pythonPath,
        env: this.#pythonEnv(),
        options: executionSpeech,
        nonce,
        expiresAt,
      });
      const identity = controller?.identity;
      if (!Number.isInteger(identity?.pid)
        || Number(identity?.pid) <= 0
        || typeof identity?.starttime !== 'string'
        || identity.starttime.length === 0
        || !Array.isArray(identity.cmdline)
        || !identity.cmdline.includes(nonce)
        || identity.nonce !== nonce) {
        throw new Error('Warmup process не предоставил полную process identity');
      }
      if (this.closed) {
        throw speechUnavailable('SpeechRuntime уже остановлен');
      }
      const record: WarmupRecord = {
        warmupId,
        state: 'available',
        expiresAt,
        optionsRevision: revision,
        requestedSpeech,
        executionSpeech,
        identity,
        controller: controller as WarmupController,
        timer: null,
      };
      record.timer = this.deps.setTimeout(() => {
        if (record.state !== 'available') return;
        record.state = 'expired';
        this.warmups.delete(warmupId);
        void record.controller.cancel().catch(() => {});
      }, this.warmupTtlMs);
      record.timer?.unref?.();
      this.warmups.set(warmupId, record);
      registered = true;
      return { warmupId, expiresAt, optionsRevision: revision };
    } catch (error) {
      if (controller && !registered) {
        try { await controller.cancel(); } catch { /* не оставляем частично созданный процесс */ }
      }
      throw error;
    } finally {
      this.pendingWarmups -= 1;
    }
  }

  async cancelWarmup(warmupId: string): Promise<boolean> {
    const record = this.warmups.get(warmupId);
    if (!record || record.state !== 'available') return false;
    record.state = 'cancelled';
    this.warmups.delete(warmupId);
    this.deps.clearTimeout(record.timer);
    await record.controller.cancel();
    return true;
  }

  #reserveStreamSlot({ optionsRevision, clientSessionId, onEvent, signal }: {
    optionsRevision: string;
    clientSessionId: string | null;
    onEvent: ((event: unknown) => void) | null;
    signal: AbortSignal | null;
  }): StreamRecord {
    if (this.closed) throw speechUnavailable('SpeechRuntime уже остановлен');
    if (this.streams.size >= this.maxStreams) throw speechStreamBusy();
    if (clientSessionId && [...this.streams.values()].some(
      (record) => !record.released && record.clientSessionId === clientSessionId,
    )) {
      throw speechStreamBusy('Speech stream с таким client session id уже существует');
    }
    const streamId = this.deps.randomUUID();
    if (this.streams.has(streamId)) {
      throw speechUnavailable('Не удалось выделить уникальный speech stream id');
    }
    const record: StreamRecord = {
      streamId,
      clientSessionId,
      state: 'pending',
      optionsRevision,
      onEvent,
      signal,
      abortHandler: null,
      workDir: null,
      session: null,
      sessionListener: null,
      bufferedEvents: [],
      bufferingEvents: true,
      execution: null,
      cancelPromise: null,
      deathPromise: null,
      released: false,
    };
    this.streams.set(streamId, record);
    return record;
  }

  #releaseStream(record: StreamRecord | null): boolean {
    if (!record || record.released) return false;
    record.released = true;
    if (record.abortHandler) record.signal?.removeEventListener('abort', record.abortHandler);
    if (record.sessionListener) {
      record.session?.off?.('event', record.sessionListener);
      record.sessionListener = null;
    }
    if (this.streams.get(record.streamId) === record) this.streams.delete(record.streamId);
    if (record.workDir) {
      try { this.deps.rmSync(record.workDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      record.workDir = null;
    }
    return true;
  }

  #forwardStreamEvent(record: StreamRecord, event: StreamEvent): void {
    const enriched = Object.freeze({
      ...event,
      sessionId: record.streamId,
      optionsRevision: record.optionsRevision,
      ...(record.execution ? { execution: record.execution } : {}),
    });
    try { record.onEvent?.(enriched); } catch { /* UI transport не управляет lifecycle worker */ }
    if (event.type === 'done' || event.type === 'error') {
      void this.#releaseStreamAfterDeath(record).catch(() => {});
    }
  }

  #releaseStreamAfterDeath(record: StreamRecord | null): Promise<boolean> {
    if (!record || record.released) return Promise.resolve(true);
    const session = record.session;
    // Старые/fake sessions не объявляют новый barrier API; для них сохраняем прежний
    // контракт: terminal event уже означает завершённый cleanup.
    if (!session || typeof session.waitForDeath !== 'function') {
      this.#releaseStream(record);
      return Promise.resolve(true);
    }
    if (session.deathConfirmed === true) {
      this.#releaseStream(record);
      return Promise.resolve(true);
    }
    record.state = 'quarantined';
    if (!record.deathPromise) {
      record.deathPromise = Promise.resolve(session.waitForDeath()).then(() => {
        this.#releaseStream(record);
        return true;
      });
      // Ошибка barrier не означает смерть процесса и поэтому не выпускает slot.
      // Отдельный catch нужен лишь против unhandled rejection при ушедшем transport.
      record.deathPromise.catch(() => {});
    }
    return record.deathPromise;
  }

  #attachStreamSession(record: StreamRecord, session: SpeechStreamSession): void {
    record.session = session;
    record.bufferedEvents = [];
    record.bufferingEvents = true;
    record.sessionListener = (event) => {
      if (record.bufferingEvents) record.bufferedEvents.push(event);
      else this.#forwardStreamEvent(record, event);
    };
    session.on('event', record.sessionListener);
  }

  #flushStreamEvents(record: StreamRecord): void {
    const events = record.bufferedEvents.splice(0);
    record.bufferingEvents = false;
    for (const event of events) this.#forwardStreamEvent(record, event);
  }

  async #discardStreamAttempt(record: StreamRecord): Promise<void> {
    const session = record.session;
    if (!session) return;
    if (record.sessionListener) session.off?.('event', record.sessionListener);
    record.sessionListener = null;
    record.bufferedEvents = [];
    await session.cancel();
    if (typeof session.waitForDeath === 'function' && session.deathConfirmed !== true) {
      await session.waitForDeath();
    }
    if (record.session === session) record.session = null;
  }

  #cancelStream(record: StreamRecord | null): Promise<boolean> {
    if (!record || record.released) return Promise.resolve(false);
    if (record.cancelPromise) return record.cancelPromise;
    record.state = 'cancelling';
    record.cancelPromise = (async () => {
      try {
        if (!record.session) {
          this.#releaseStream(record);
          return false;
        }
        const result = await record.session.cancel();
        await this.#releaseStreamAfterDeath(record);
        return result;
      } catch (error) {
        // Bounded TERM/KILL исчерпан, но child close не подтверждён. Не выдаём slot
        // и не удаляем workDir: asynchronous quarantine watcher подберёт реальный exit.
        this.#releaseStreamAfterDeath(record);
        throw error;
      }
    })();
    return record.cancelPromise;
  }

  async #waitForCancellingStreams(signal: AbortSignal | null | undefined): Promise<void> {
    const barriers = [...this.streams.values()]
      .filter((record) => record.state === 'cancelling' && record.cancelPromise)
      .map((record) => record.cancelPromise);
    if (barriers.length) {
      // Batch fallback может прийти сразу после закрытия WebSocket. Ждём только
      // уже отменяемые sessions (не чужие активные диктовки), чтобы новая one-shot
      // модель не пересеклась с process death barrier старого worker.
      await awaitWithSignal(Promise.allSettled(barriers), signal);
    }
    if ([...this.streams.values()].some((record) => (
      !record.released && record.state === 'quarantined'
    ))) {
      // Без correlation id нельзя доказать, какой quarantine относится к upload.
      // Fail-closed безопаснее второй копии модели рядом с неподтверждённым child.
      throw speechStreamBusy('Предыдущий speech stream ещё завершает worker');
    }
  }

  async #cancelCorrelatedStream(
    clientSessionId: unknown,
    signal: AbortSignal | null | undefined,
  ): Promise<boolean> {
    if (typeof clientSessionId !== 'string' || !clientSessionId) return false;
    const record = [...this.streams.values()].find(
      (candidate) => !candidate.released && candidate.clientSessionId === clientSessionId,
    );
    if (!record) return false;
    try {
      await awaitWithSignal(this.#cancelStream(record), signal);
    } catch (error) {
      // cancel() имеет bounded TERM/KILL и вправе вернуть ошибку, пока child ещё жив.
      // One-shot ждёт именно его quarantine barrier, а HTTP AbortSignal ограничивает
      // это ожидание снаружи; запускать вторую модель до close запрещено.
      if (!record.deathPromise) throw error;
      await awaitWithSignal(record.deathPromise, signal);
    }
    return true;
  }

  /**
   * Запускает session worker для PCM16/16k mono. Слот резервируется синхронно
   * до первого await; callback подключается до session.start(), поэтому ready
   * и terminal error не теряются даже у мгновенного fake/worker.
   */
  async startStream({
    settings = null,
    options = null,
    optionsRevision = null,
    clientSessionId = null,
    signal = null,
    onEvent = null,
  }: {
    settings?: Record<string, unknown> | null;
    options?: unknown;
    optionsRevision?: string | null;
    clientSessionId?: string | null;
    signal?: AbortSignal | null;
    onEvent?: ((event: unknown) => void) | null;
  } = {}) {
    if (signal?.aborted) throw abortError();
    if (onEvent != null && typeof onEvent !== 'function') {
      throw new TypeError('Speech stream onEvent должен быть функцией');
    }
    const requestedSpeech = this.#options(settings, options, 'dictation');
    const revision = speechOptionsRevision(
      requestedSpeech,
      (optionsRevision ?? settings?._revision ?? settings?.revision ?? null) as string | null,
    );
    const correlation = typeof clientSessionId === 'string' && clientSessionId
      ? clientSessionId : null;
    const record = this.#reserveStreamSlot({
      optionsRevision: revision,
      clientSessionId: correlation,
      onEvent,
      signal,
    });
    record.abortHandler = () => {
      if (record.session) void this.#cancelStream(record).catch(() => {});
      else this.#releaseStream(record);
    };
    signal?.addEventListener('abort', record.abortHandler, { once: true });

    const assertOpen = () => {
      if (signal?.aborted) throw abortError();
      if (this.closed) throw speechUnavailable('SpeechRuntime уже остановлен');
      if (record.released) throw abortError();
    };
    const launch = async (executionSpeech: SpeechOptions) => {
      assertOpen();
      const session = this.deps.createSpeechStreamSession({
        pythonPath: this.pythonPath,
        env: this.#pythonEnv(),
        options: executionSpeech,
        filePath: path.join(String(record.workDir), 'audio.pcm'),
      });
      if (!session || typeof session.on !== 'function' || typeof session.start !== 'function') {
        try { await session?.cancel?.(); } catch { /* некорректный factory всё равно надо погасить */ }
        throw new TypeError('Speech stream factory вернул некорректную session');
      }
      record.execution = Object.freeze({
        engine: 'whisper',
        mode: 'stream',
        device: executionSpeech.device,
      });
      this.#attachStreamSession(record, session);
      await awaitWithSignal(session.start(), signal);
      assertOpen();
      return session;
    };

    try {
      await awaitWithSignal(Promise.resolve(this.reconcileModelJobs()), signal);
      assertOpen();
      const readiness = await awaitWithSignal(this.#readiness(), signal);
      assertOpen();
      assertLocalReady(readiness, requestedSpeech.model);
      let executionSpeech = await awaitWithSignal(this.#executionSpeech(requestedSpeech), signal);
      assertOpen();
      this.deps.mkdirSync(this.mediaDir, { recursive: true });
      record.workDir = this.deps.mkdtempSync(path.join(this.mediaDir, 'speech-stream-'));

      try {
        await launch(executionSpeech);
      } catch (error) {
        const canFallback = requestedSpeech.device === 'auto'
          && executionSpeech.device === 'cuda'
          && !signal?.aborted
          && !this.closed
          && isCudaRuntimeFailure(error);
        if (!canFallback) throw error;
        await this.#discardStreamAttempt(record);
        assertOpen();
        executionSpeech = this.#cpuFallback(requestedSpeech);
        await launch(executionSpeech);
        record.execution = Object.freeze({
          ...record.execution,
          fallback: 'cuda_failed',
        });
      }

      record.state = 'active';
      this.#flushStreamEvents(record);
      assertOpen();
      const session = record.session as SpeechStreamSession;
      const handle = {
        streamId: record.streamId,
        optionsRevision: revision,
        execution: record.execution,
        pushFrame: (seq: number, pcm: unknown) => session.pushFrame(seq, pcm),
        stop: (optionsValue?: { drainTimeoutMs?: number }) => session.stop(optionsValue),
        cancel: () => this.#cancelStream(record),
        snapshot: () => session.snapshot(),
      };
      Object.defineProperty(handle, 'state', {
        enumerable: true,
        get: () => session.snapshot().state,
      });
      return Object.freeze(handle);
    } catch (error) {
      if (record.bufferingEvents) {
        if (signal?.aborted || this.closed || record.state === 'cancelling' || record.released) {
          record.bufferedEvents = [];
        } else {
          this.#flushStreamEvents(record);
        }
      }
      await this.#cancelStream(record).catch(() => {});
      throw error;
    }
  }

  async transcribe({
    filePath,
    workDir = null,
    settings = null,
    options = null,
    warmupId = null,
    streamSessionId = null,
    signal = null,
  }: {
    filePath: string;
    workDir?: string | null;
    settings?: Record<string, unknown> | null;
    options?: unknown;
    warmupId?: string | null;
    streamSessionId?: string | null;
    signal?: AbortSignal | null;
  }): Promise<Record<string, unknown>> {
    if (this.closed) throw speechUnavailable('SpeechRuntime уже остановлен');
    if (signal?.aborted) throw abortError();
    await this.#cancelCorrelatedStream(streamSessionId, signal);
    await this.#waitForCancellingStreams(signal);
    if (this.closed) throw speechUnavailable('SpeechRuntime уже остановлен');
    const currentSpeech = this.#options(settings, options, 'dictation');
    await awaitWithSignal(Promise.resolve(this.reconcileModelJobs()), signal);
    if (this.closed) throw speechUnavailable('SpeechRuntime уже остановлен');
    const warmup = this.#claimWarmup(warmupId);
    const requestedSpeech = warmup?.requestedSpeech || currentSpeech;
    let readiness: SpeechReadiness;
    try {
      readiness = await awaitWithSignal(this.#readiness(), signal);
    } catch (error) {
      await this.#finishWarmup(warmup);
      throw error;
    }
    try {
      assertLocalReady(readiness, requestedSpeech.model);
    } catch (error) {
      await this.#finishWarmup(warmup);
      throw error;
    }
    let ownedWorkDir = false;
    if (!workDir) {
      this.deps.mkdirSync(this.mediaDir, { recursive: true });
      workDir = String(this.deps.mkdtempSync(path.join(this.mediaDir, 'speech-')));
      ownedWorkDir = true;
    }
    const jobDir: string = workDir;
    try {
      if (warmup) {
        try {
          const transcript = await warmup.controller.transcribe({
            filePath,
            progressFile: path.join(jobDir, 'progress.json'),
            wordTimestamps: requestedSpeech.wordTimestamps,
            signal,
          });
          const result = {
            sizeBytes: this.deps.statSync(filePath).size,
            duration: transcript.duration || 0,
            transcript,
            frameFiles: [],
            execution: {
              engine: 'whisper',
              mode: 'warmup',
              device: warmup.executionSpeech.device,
              warmupId,
              optionsRevision: warmup.optionsRevision,
            },
          };
          this.#recordDictionaryMeasure(result);
          return result;
        } catch (error) {
          if (signal?.aborted || (error as Error)?.name === 'AbortError') throw error;
          return await this.#oneShot({
            filePath,
            workDir: jobDir,
            signal,
            requestedSpeech,
            forceCpu: requestedSpeech.device === 'auto'
              && warmup.executionSpeech.device === 'cuda'
              && isCudaRuntimeFailure(error),
          });
        }
      }
      // Именно `return await`: без await блок finally срабатывает до конца разбора и
      // сносит свой рабочий каталог, пока ffmpeg ещё пишет в него wav, — так пропадала
      // самопроверка речи презентаций («audio.wav: No such file or directory»).
      return await this.#oneShot({
        filePath, workDir: jobDir, signal, requestedSpeech,
      });
    } finally {
      await this.#finishWarmup(warmup);
      if (ownedWorkDir) {
        try { this.deps.rmSync(jobDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  }

  startVideoJob({ filePath, frames = 0, workDir = null, settings = null, options = null }: {
    filePath: string;
    frames?: number;
    workDir?: string | null;
    settings?: Record<string, unknown> | null;
    options?: unknown;
  }): { jobId: string } {
    const speech = this.#options(settings, options, 'video');
    if (!workDir) {
      this.deps.mkdirSync(this.mediaDir, { recursive: true });
      workDir = this.deps.mkdtempSync(path.join(this.mediaDir, 'ingest-'));
    }
    return this.deps.startIngestJob({
      filePath,
      workDir,
      jobsDir: this.jobsDir,
      frames,
      speech,
      pythonPath: this.pythonPath,
      transcribePath: this.transcribePath,
      mediaHfDir: this.mediaHfDir,
      baseEnv: this.baseEnv,
    });
  }

  readVideoJob(jobId: string) {
    return this.deps.readIngestJob(jobId, this.jobsDir);
  }

  residentStatus() {
    return residentUnavailable();
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const streams = [...this.streams.values()];
    const records = [...this.warmups.values()];
    this.warmups.clear();
    await Promise.all([
      ...streams.map(async (record) => {
        try { await this.#cancelStream(record); } catch { /* best-effort shutdown */ }
      }),
      ...records.map(async (record) => {
        this.deps.clearTimeout(record.timer);
        record.state = 'shutdown';
        try { await record.controller.cancel(); } catch { /* best-effort shutdown */ }
      }),
    ]);
  }
}

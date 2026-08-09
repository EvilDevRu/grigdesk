import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
} from 'node:fs';
import path from 'node:path';

import { ingestRecording, readIngestJob, startIngestJob } from '../media/ingest.js';
import { preflightAsync } from '../media/preflight.js';
import {
  CUDA_STATES,
  SPEECH_LANGUAGES,
  probeSpeechModelCache,
  residentUnavailable,
  runCudaCanary,
} from './capabilities.js';
import { SPEECH_MODEL_CATALOG } from './catalog.js';
import {
  isCudaRuntimeFailure,
  speechModelMissing,
  speechStreamBusy,
  speechUnavailable,
  speechWarmupBusy,
} from './errors.js';
import { normalizeSpeechOptions, resolveSpeechOptions } from './options.js';
import { pythonEnv } from './transport.js';
import { createSpeechStreamSession } from './stream.js';
import {
  createWarmupProcess,
  speechOptionsRevision,
} from './warmup.js';

function abortError() {
  const error = new Error('Распознавание отменено');
  error.name = 'AbortError';
  return error;
}

function awaitWithSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
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

function isResolvedOptions(value) {
  return Boolean(value
    && typeof value === 'object'
    && value.model
    && (value.language || value.lang)
    && value.device
    && value.computeType
    && Number.isInteger(value.beamSize));
}

function localCapability({ environmentReady, environmentChecks, models }, modelId) {
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

function assertLocalReady(readiness, modelId) {
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

function fallbackModels() {
  return Object.values(SPEECH_MODEL_CATALOG).map((model) => Object.freeze({
    modelId: model.modelId,
    repo: model.repo,
    revision: model.revision,
    cached: false,
    sizeMb: 0,
  }));
}

function normalizeCuda(value) {
  if (!value || !CUDA_STATES.includes(value.state)) {
    return Object.freeze({ state: 'probe_failed', reason: 'CUDA probe вернул некорректный ответ' });
  }
  return Object.freeze({
    state: value.state,
    reason: value.reason || null,
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
    this.settings = settings?.speech && typeof settings.speech === 'object' ? settings.speech : settings;
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

  attachModelJobs(modelJobs) {
    if (!modelJobs || typeof modelJobs !== 'object') {
      throw new TypeError('SpeechRuntime требует ModelJobManager');
    }
    if (this.modelJobs && this.modelJobs !== modelJobs) {
      throw new Error('ModelJobManager уже прикреплён к SpeechRuntime');
    }
    this.modelJobs = modelJobs;
    return modelJobs;
  }

  reconcileModelJobs() {
    return this.modelJobs?.reconcileCompleted?.() ?? 0;
  }

  startModelDownload(modelId) {
    return this.modelJobs?.startDownload(modelId);
  }

  startModelCopy(modelId) {
    return this.modelJobs?.startCopy(modelId);
  }

  startModelBenchmark(options) {
    return this.modelJobs?.startBenchmark(options);
  }

  readModelJob(jobId) {
    return this.modelJobs?.readJob(jobId);
  }

  cancelModelJob(jobId) {
    return this.modelJobs?.cancelJob(jobId);
  }

  #options(settings, options, scenario) {
    if (isResolvedOptions(options)) return normalizeSpeechOptions(options, scenario);
    return resolveSpeechOptions(options ?? settings ?? this.settings, scenario);
  }

  #pythonEnv() {
    return pythonEnv({
      mediaHfDir: this.mediaHfDir,
      pythonPath: this.pythonPath,
      baseEnv: this.baseEnv,
    });
  }

  #invalidateDiagnostics() {
    this.diagnosticGeneration += 1;
    this.readinessCache = null;
    this.capabilitiesCache = null;
    this.cudaDecisionCache = null;
  }

  async #probeReadiness(generation) {
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

  #readinessForGeneration(generation) {
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

  #readiness() {
    return this.#readinessForGeneration(this.diagnosticGeneration);
  }

  async #probeCapabilities(generation) {
    const readiness = await this.#readinessForGeneration(generation);
    const dictation = resolveSpeechOptions(this.settings, 'dictation');
    const local = localCapability(readiness, dictation.model);
    const canaryModel = readiness.models.find((model) => model.cached) || null;
    let cuda;
    try {
      cuda = normalizeCuda(await this.deps.runCudaCanary({
        pythonPath: this.pythonPath,
        env: this.#pythonEnv(),
        model: canaryModel,
      }));
    } catch (error) {
      cuda = normalizeCuda({ state: 'probe_failed', reason: error.message });
    }
    const snapshot = Object.freeze({
      ok: local.ready,
      ready: local.ready,
      venvPython: readiness.venvPython,
      checks: readiness.environmentChecks,
      ...readiness,
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

  #capabilitiesForGeneration(generation) {
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

  async capabilities({ refresh = false } = {}) {
    if (refresh) this.#invalidateDiagnostics();
    // Model worker detached: завершение возможно без открытого polling. Reconcile
    // принадлежит runtime, чтобы settings и media/doctor не видели разные кэши.
    await this.reconcileModelJobs();
    return this.#capabilitiesForGeneration(this.diagnosticGeneration);
  }

  invalidateCapabilities() {
    this.#invalidateDiagnostics();
  }

  refreshCapabilities() {
    return this.capabilities({ refresh: true });
  }

  publicSnapshot(settings = this.settings) {
    const source = settings?.speech && typeof settings.speech === 'object' ? settings.speech : settings;
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

  async publicSnapshotAsync(settings = this.settings) {
    const source = settings?.speech && typeof settings.speech === 'object' ? settings.speech : settings;
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

  applyRuntimeSettings(settings = {}) {
    this.settings = settings?.speech && typeof settings.speech === 'object' ? settings.speech : settings;
    this.#invalidateDiagnostics();
    // Startup/save прогревает только readiness. CUDA-canary нужен settings GET, но не
    // browser-default startup и не синхронный publicSnapshot.
    void this.#readiness().catch(() => {});
    return this.publicSnapshot(this.settings);
  }

  #knownCuda() {
    const current = this.capabilitiesCache?.generation === this.diagnosticGeneration
      ? this.capabilitiesCache.value
      : this.capabilitiesSnapshot;
    return current?.cuda
      || (this.cudaDecisionCache?.generation === this.diagnosticGeneration
        ? this.cudaDecisionCache.value
        : null);
  }

  #probeAutoCuda() {
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
    })).then(normalizeCuda, (error) => normalizeCuda({
      state: 'probe_failed',
      reason: error.message,
    }));
    let timer;
    const timeout = new Promise((resolve) => {
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

  async #executionSpeech(speech) {
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
    if (!cuda) cuda = (await this.capabilities()).cuda;
    if (cuda.state !== 'ready') {
      throw speechUnavailable(`CUDA недоступна: ${cuda.reason || cuda.state}`);
    }
    return Object.freeze({
      ...speech,
      device: 'cuda',
      computeType: speech.computeType === 'auto' ? 'float16' : speech.computeType,
    });
  }

  #cpuFallback(speech) {
    return Object.freeze({ ...speech, device: 'cpu', computeType: 'int8' });
  }

  #recordDictionaryMeasure(result) {
    const measure = result?.transcript || result;
    if (!Number.isInteger(measure?.hotwordsTokens)) return;
    this.lastDictionaryMeasure = Object.freeze({
      tokens: measure.hotwordsTokens,
      truncated: Boolean(measure.hotwordsTruncated),
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

  async #oneShot({ filePath, workDir, signal, requestedSpeech, forceCpu = false }) {
    if (signal?.aborted) throw abortError();
    let speech = forceCpu
      ? this.#cpuFallback(requestedSpeech)
      : await awaitWithSignal(this.#executionSpeech(requestedSpeech), signal);
    let fallback = forceCpu ? 'warmup_cuda_failed' : null;
    let result;
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
        signal,
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
        signal,
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

  #claimWarmup(warmupId) {
    const record = warmupId ? this.warmups.get(warmupId) : null;
    if (!record || record.state !== 'available') return null;
    if (this.deps.now() >= record.expiresAt) {
      record.state = 'expired';
      this.warmups.delete(warmupId);
      this.deps.clearTimeout(record.timer);
      void record.controller.cancel().catch(() => {});
      return null;
    }
    // Map mutation происходит до первого await — claim атомарен для конкурирующих uploads.
    record.state = 'claimed';
    this.deps.clearTimeout(record.timer);
    return record;
  }

  async #finishWarmup(record) {
    if (!record) return;
    this.warmups.delete(record.warmupId);
    try { await record.controller.cancel(); } catch { /* процесс уже мог выйти после result */ }
  }

  #reserveWarmupSlot() {
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

  async warmup({ settings = null, options = null, optionsRevision = null } = {}) {
    if (this.closed) throw speechUnavailable('SpeechRuntime уже остановлен');
    // Detached download может закончиться без polling/settings GET. Подбираем его
    // до cached readiness, иначе реально появившаяся модель останется missing.
    await this.reconcileModelJobs();
    if (this.closed) throw speechUnavailable('SpeechRuntime уже остановлен');
    this.#reserveWarmupSlot();
    let controller = null;
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
        optionsRevision ?? settings?._revision ?? settings?.revision ?? null,
      );
      controller = await this.deps.createWarmupProcess({
        pythonPath: this.pythonPath,
        env: this.#pythonEnv(),
        options: executionSpeech,
        nonce,
        expiresAt,
      });
      if (!Number.isInteger(controller?.identity?.pid)
        || controller.identity.pid <= 0
        || typeof controller.identity.starttime !== 'string'
        || controller.identity.starttime.length === 0
        || !Array.isArray(controller.identity.cmdline)
        || !controller.identity.cmdline.includes(nonce)
        || controller.identity.nonce !== nonce) {
        throw new Error('Warmup process не предоставил полную process identity');
      }
      if (this.closed) {
        throw speechUnavailable('SpeechRuntime уже остановлен');
      }
      const record = {
        warmupId,
        state: 'available',
        expiresAt,
        optionsRevision: revision,
        requestedSpeech,
        executionSpeech,
        identity: controller.identity,
        controller,
        timer: null,
      };
      record.timer = this.deps.setTimeout(() => {
        if (record.state !== 'available') return;
        record.state = 'expired';
        this.warmups.delete(warmupId);
        void controller.cancel().catch(() => {});
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

  async cancelWarmup(warmupId) {
    const record = this.warmups.get(warmupId);
    if (!record || record.state !== 'available') return false;
    record.state = 'cancelled';
    this.warmups.delete(warmupId);
    this.deps.clearTimeout(record.timer);
    await record.controller.cancel();
    return true;
  }

  #reserveStreamSlot({ optionsRevision, clientSessionId, onEvent, signal }) {
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
    const record = {
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

  #releaseStream(record) {
    if (!record || record.released) return false;
    record.released = true;
    record.signal?.removeEventListener('abort', record.abortHandler);
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

  #forwardStreamEvent(record, event) {
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

  #releaseStreamAfterDeath(record) {
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

  #attachStreamSession(record, session) {
    record.session = session;
    record.bufferedEvents = [];
    record.bufferingEvents = true;
    record.sessionListener = (event) => {
      if (record.bufferingEvents) record.bufferedEvents.push(event);
      else this.#forwardStreamEvent(record, event);
    };
    session.on('event', record.sessionListener);
  }

  #flushStreamEvents(record) {
    const events = record.bufferedEvents.splice(0);
    record.bufferingEvents = false;
    for (const event of events) this.#forwardStreamEvent(record, event);
  }

  async #discardStreamAttempt(record) {
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

  #cancelStream(record) {
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

  async #waitForCancellingStreams(signal) {
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

  async #cancelCorrelatedStream(clientSessionId, signal) {
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
  } = {}) {
    if (signal?.aborted) throw abortError();
    if (onEvent != null && typeof onEvent !== 'function') {
      throw new TypeError('Speech stream onEvent должен быть функцией');
    }
    const requestedSpeech = this.#options(settings, options, 'dictation');
    const revision = speechOptionsRevision(
      requestedSpeech,
      optionsRevision ?? settings?._revision ?? settings?.revision ?? null,
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
    const launch = async (executionSpeech) => {
      assertOpen();
      const session = this.deps.createSpeechStreamSession({
        pythonPath: this.pythonPath,
        env: this.#pythonEnv(),
        options: executionSpeech,
        filePath: path.join(record.workDir, 'audio.pcm'),
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
      const session = record.session;
      const handle = {
        streamId: record.streamId,
        optionsRevision: revision,
        execution: record.execution,
        pushFrame: (seq, pcm) => session.pushFrame(seq, pcm),
        stop: (optionsValue) => session.stop(optionsValue),
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
  }) {
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
    let readiness;
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
      workDir = this.deps.mkdtempSync(path.join(this.mediaDir, 'speech-'));
      ownedWorkDir = true;
    }
    try {
      if (warmup) {
        try {
          const transcript = await warmup.controller.transcribe({
            filePath,
            progressFile: path.join(workDir, 'progress.json'),
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
          if (signal?.aborted || error?.name === 'AbortError') throw error;
          return this.#oneShot({
            filePath,
            workDir,
            signal,
            requestedSpeech,
            forceCpu: requestedSpeech.device === 'auto'
              && warmup.executionSpeech.device === 'cuda'
              && isCudaRuntimeFailure(error),
          });
        }
      }
      return this.#oneShot({ filePath, workDir, signal, requestedSpeech });
    } finally {
      await this.#finishWarmup(warmup);
      if (ownedWorkDir) {
        try { this.deps.rmSync(workDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  }

  startVideoJob({ filePath, frames = 0, workDir = null, settings = null, options = null }) {
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

  readVideoJob(jobId) {
    return this.deps.readIngestJob(jobId, this.jobsDir);
  }

  residentStatus() {
    return residentUnavailable();
  }

  async shutdown() {
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

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { SPEECH_MODEL_CATALOG, speechModel } from './catalog.js';
import { pythonEnv } from './transport.js';
import {
  ACTIVE_MODEL_JOB_STATUSES,
  TERMINAL_MODEL_JOB_STATUSES,
  assertModelJobId,
  publicModelJob,
  readModelJobFile,
  writeModelJobFile,
} from './model-jobs-contract.js';
import {
  captureProcessIdentity,
  processIdentityMatches,
  signalOwnedProcess,
} from './model-jobs-process.js';

const DEFAULT_WORKER = fileURLToPath(new URL('./model-jobs-worker.py', import.meta.url));
const SOURCE_CACHE_ENV = [
  'HOME', 'XDG_CACHE_HOME', 'HF_HOME', 'HF_HUB_CACHE', 'HUGGINGFACE_HUB_CACHE',
];
const BENCHMARK_KEYS = new Set(['modelId', 'language', 'device', 'computeType']);
const LANGUAGES = new Set(['ru', 'en', 'auto']);
const DEVICES = new Set(['cpu', 'cuda', 'auto']);
const COMPUTE_TYPES = new Set(['int8', 'int8_float16', 'float16', 'float32']);
const RECOVERY_POLL_MS = 25;
const RECOVERY_TERM_GRACE_MS = 300;
const RECOVERY_KILL_GRACE_MS = 1_000;

export class ModelJobError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'ModelJobError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function modelOrThrow(modelId) {
  const selected = speechModel(modelId);
  if (!selected) {
    throw new ModelJobError('unknown_speech_model', `Модель «${String(modelId)}» не входит в speech allowlist.`);
  }
  return selected;
}

function sourceCacheEnvironment(baseEnv) {
  const out = {};
  for (const key of SOURCE_CACHE_ENV) {
    if (typeof baseEnv?.[key] === 'string' && baseEnv[key]) out[key] = baseEnv[key];
  }
  return out;
}

function activeKey(kind, modelId) {
  // Download и copy одной модели взаимоисключающие: оба пишут один target cache.
  return kind === 'benchmark' ? `benchmark:${modelId}` : `model:${modelId}`;
}

function publicStart(job, deduplicated = false) {
  return { jobId: job.jobId, status: 'queued', ...(deduplicated ? { deduplicated: true } : {}) };
}

function validateBenchmark(value) {
  const source = value ?? {};
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new ModelJobError('bad_benchmark_setting', 'Параметры benchmark должны быть объектом.');
  }
  for (const key of Object.keys(source)) {
    if (!BENCHMARK_KEYS.has(key)) {
      throw new ModelJobError('bad_benchmark_setting', `Неизвестный параметр benchmark.${key}.`);
    }
  }
  const modelId = source.modelId ?? 'medium';
  modelOrThrow(modelId);
  const language = source.language ?? 'ru';
  const device = source.device ?? 'cpu';
  const computeType = source.computeType ?? (device === 'cuda' ? 'float16' : 'int8');
  if (!LANGUAGES.has(language) || !DEVICES.has(device) || !COMPUTE_TYPES.has(computeType)) {
    throw new ModelJobError('bad_benchmark_setting', 'Некорректные language/device/computeType benchmark.');
  }
  return { modelId, language, device, computeType };
}

/**
 * Дисковый coordinator model jobs. Worker пишет тот же status-файл; prefs для
 * фонового прогресса не используются. Все внешние зависимости инъецируются в тестах.
 */
export class ModelJobManager {
  constructor({
    jobsDir,
    mediaHfDir,
    pythonPath,
    workerPath = DEFAULT_WORKER,
    benchmarkAudioPath = null,
    baseEnv = process.env,
    catalog = SPEECH_MODEL_CATALOG,
    onModelReady = null,
    deps = {},
  }) {
    if (!jobsDir || !mediaHfDir) throw new TypeError('ModelJobManager требует jobsDir и mediaHfDir.');
    this.jobsDir = jobsDir;
    this.mediaHfDir = mediaHfDir;
    this.pythonPath = pythonPath || '';
    this.workerPath = workerPath;
    this.benchmarkAudioPath = benchmarkAudioPath;
    this.baseEnv = baseEnv;
    this.catalog = catalog;
    this.onModelReady = onModelReady;
    this.active = new Map();
    this.launching = new Set();
    this.launchBlocked = new Map();
    this.notified = new Set();
    this.recoveryBlocked = new Map();
    this.deps = {
      now: Date.now,
      createJobId: randomUUID,
      createNonce: randomUUID,
      mkdirSync: fs.mkdirSync,
      chmodSync: fs.chmodSync,
      readdirSync: fs.readdirSync,
      accessSync: fs.accessSync,
      statSync: fs.statSync,
      spawn,
      captureProcessIdentity,
      processIdentityMatches,
      signalOwnedProcess,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      ...deps,
    };
    // mode задаём в самом mkdir: chmod после обычного создания оставлял бы окно,
    // в котором status-файлы видны другим пользователям машины.
    this.deps.mkdirSync(this.jobsDir, { recursive: true, mode: 0o700 });
    this.deps.chmodSync(this.jobsDir, 0o700);
    this.recovery = this.#recoverInterrupted();
  }

  #read(jobId) {
    return readModelJobFile(this.jobsDir, jobId);
  }

  #write(job) {
    const written = writeModelJobFile(this.jobsDir, job);
    const key = activeKey(written.kind, written.modelId);
    if (ACTIVE_MODEL_JOB_STATUSES.has(written.status)) this.active.set(key, written.jobId);
    else if (this.active.get(key) === written.jobId) this.active.delete(key);
    return written;
  }

  async #waitUntilProcessGone(identity, timeoutMs) {
    const attempts = Math.max(1, Math.ceil(timeoutMs / RECOVERY_POLL_MS));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (!this.deps.processIdentityMatches(identity)) return true;
      await this.deps.sleep(RECOVERY_POLL_MS);
    }
    return !this.deps.processIdentityMatches(identity);
  }

  #finishRecovery(job) {
    const key = activeKey(job.kind, job.modelId);
    if (this.recoveryBlocked.get(key)?.jobId === job.jobId) this.recoveryBlocked.delete(key);
    const latest = this.#read(job.jobId) || job;
    if (TERMINAL_MODEL_JOB_STATUSES.has(latest.status)) {
      // Worker мог успеть атомарно записать done/cancelled перед выходом. После
      // подтверждённой смерти достаточно синхронизировать active index.
      this.#write(latest);
      return;
    }
    this.#write({
      ...latest,
      status: 'interrupted',
      finishedAt: this.deps.now(),
      error: { code: 'model_job_interrupted', message: 'Сервер был перезапущен во время задачи.' },
    });
  }

  async #terminateOwnedProcess(job) {
    const identity = job.process;
    if (!identity || !this.deps.processIdentityMatches(identity)) return true;

    const key = activeKey(job.kind, job.modelId);
    this.recoveryBlocked.set(key, { jobId: job.jobId, identity });
    this.deps.signalOwnedProcess(identity, 'SIGTERM');
    let gone = await this.#waitUntilProcessGone(identity, RECOVERY_TERM_GRACE_MS);
    if (!gone) {
      this.deps.signalOwnedProcess(identity, 'SIGKILL');
      gone = await this.#waitUntilProcessGone(identity, RECOVERY_KILL_GRACE_MS);
    }
    if (gone && this.recoveryBlocked.get(key)?.jobId === job.jobId) {
      this.recoveryBlocked.delete(key);
    }
    return gone;
  }

  async #recoverOne(job) {
    if (!await this.#terminateOwnedProcess(job)) {
      // Не освобождаем dedupe, пока тот же pid+starttime+argv+nonce жив.
      // Следующий start снова увидит этот active job, а readJob подберёт его
      // после фактического завершения процесса.
      return;
    }
    this.#finishRecovery(job);
  }

  #recoverInterrupted() {
    let entries = [];
    try { entries = this.deps.readdirSync(this.jobsDir, { withFileTypes: true }); } catch { return; }
    const pending = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const jobId = entry.name.slice(0, -5);
      let job;
      try { job = this.#read(jobId); } catch { continue; }
      if (!job) continue;
      const active = ACTIVE_MODEL_JOB_STATUSES.has(job.status);
      const cancelledButPossiblyAlive = (job.status === 'cancelled' || job.status === 'interrupted')
        && job.process;
      if (!active && !cancelledButPossiblyAlive) continue;
      if (active) this.active.set(activeKey(job.kind, job.modelId), job.jobId);
      pending.push(this.#recoverOne(job));
    }
    return pending.length > 0 ? Promise.allSettled(pending) : null;
  }

  async #notifyModelReady(job) {
    if (job?.status !== 'done'
      || (job.kind !== 'download' && job.kind !== 'copy')
      || this.notified.has(job.jobId)) return false;
    this.notified.add(job.jobId);
    try {
      await this.onModelReady?.(job.modelId);
    } catch {
      // Worker уже закончил атомарную запись snapshot. Инвалидация diagnostics —
      // best effort и не должна превращать успешную загрузку в failed job.
    }
    return true;
  }

  /**
   * Detached worker может закончить после закрытия вкладки, когда job никто больше
   * не poll'ит. Перед чтением capabilities подбираем такие terminal status-файлы,
   * чтобы бессрочный runtime cache не скрывал уже появившуюся модель.
   */
  async reconcileCompleted() {
    let entries = [];
    try { entries = this.deps.readdirSync(this.jobsDir, { withFileTypes: true }); } catch { return 0; }
    let reconciled = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const jobId = entry.name.slice(0, -5);
      let job;
      try { job = this.#read(jobId); } catch { continue; }
      if (await this.#notifyModelReady(job)) reconciled += 1;
    }
    return reconciled;
  }

  #activeJob(kind, modelId) {
    const key = activeKey(kind, modelId);
    const launchBlocked = this.launchBlocked.get(key);
    if (launchBlocked) {
      try { return this.#read(launchBlocked.jobId) || { jobId: launchBlocked.jobId }; } catch {
        // Потерянный status не доказывает, что поздний launcher не вернёт worker.
        return { jobId: launchBlocked.jobId };
      }
    }
    const blocked = this.recoveryBlocked.get(key);
    if (blocked) {
      if (this.deps.processIdentityMatches(blocked.identity)) {
        // Даже terminal status недостаточно: worker мог записать его перед тем,
        // как реально завершился. До исчезновения exact identity второй writer закрыт.
        return this.#read(blocked.jobId) || { jobId: blocked.jobId };
      }
      this.recoveryBlocked.delete(key);
    }
    const jobId = this.active.get(key);
    if (!jobId) return null;
    let job = null;
    try { job = this.#read(jobId); } catch { /* битый status не дедуплицирует */ }
    if (job && ACTIVE_MODEL_JOB_STATUSES.has(job.status)) {
      if (this.launching.has(job.jobId)) return job;
      const alive = job.status === 'running'
        && job.process
        && this.deps.processIdentityMatches(job.process);
      if (alive) return job;
      job = this.#write({
        ...job,
        status: 'interrupted',
        finishedAt: this.deps.now(),
        error: { code: 'model_job_interrupted', message: 'Model-job worker больше не работает.' },
      });
    }
    this.active.delete(key);
    return null;
  }

  async #defaultLaunch(job) {
    try { this.deps.accessSync(this.pythonPath, fs.constants.X_OK); } catch {
      throw new ModelJobError(
        'speech_python_missing',
        'Python-окружение речи не настроено; model job запустить нельзя.',
        503,
      );
    }
    const env = pythonEnv({
      mediaHfDir: this.mediaHfDir,
      pythonPath: this.pythonPath,
      baseEnv: this.baseEnv,
    });
    const child = this.deps.spawn(
      this.pythonPath,
      [this.workerPath, path.join(this.jobsDir, `${job.jobId}.json`), job.task.nonce],
      { detached: true, stdio: 'ignore', env },
    );
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
    let identity = null;
    for (let attempt = 0; attempt < 50 && !identity; attempt += 1) {
      identity = this.deps.captureProcessIdentity(child.pid, {
        script: this.workerPath,
        nonce: job.task.nonce,
      });
      if (!identity) await this.deps.sleep(10);
    }
    if (!identity) {
      // Без exact identity нельзя сигналить по raw PID из ChildProcess:
      // номер уже мог перейти чужому процессу. Job перейдёт в failed,
      // а завершать worker можно только через signalOwnedProcess с
      // заново проверенной полной identity.
      throw new Error('Не удалось закрепить process identity model-job worker.');
    }
    return identity;
  }

  async #start(kind, modelId, extraTask = {}) {
    const model = this.catalog[modelId] || modelOrThrow(modelId);
    if (this.recovery) await this.recovery;
    const duplicate = this.#activeJob(kind, modelId);
    if (duplicate) return publicStart(duplicate, true);

    const jobId = assertModelJobId(this.deps.createJobId());
    const nonce = String(this.deps.createNonce());
    const now = this.deps.now();
    let job = this.#write({
      jobId,
      kind,
      modelId,
      status: 'queued',
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      progress: null,
      result: null,
      error: null,
      process: null,
      task: {
        nonce,
        model,
        mediaHfDir: this.mediaHfDir,
        sourceCacheEnv: sourceCacheEnvironment(this.baseEnv),
        benchmarkAudioPath: this.benchmarkAudioPath,
        ...extraTask,
      },
    });
    this.launching.add(jobId);
    try {
      const identity = await (this.deps.launcher
        ? this.deps.launcher({ job, jobsDir: this.jobsDir, manager: this })
        : this.#defaultLaunch(job));
      let latest = this.#read(jobId) || job;
      if (TERMINAL_MODEL_JOB_STATUSES.has(latest.status)) {
        if (this.launchBlocked.get(activeKey(kind, modelId))?.jobId === jobId) {
          // DELETE мог прийти, пока launcher ещё не вернул identity. Закрепляем
          // поздний worker в status до ожидания смерти, чтобы рестарт сервера тоже
          // смог безопасно подобрать его.
          latest = this.#write({ ...latest, process: identity });
          await this.#terminateOwnedProcess(latest);
        }
        return publicStart(latest);
      }
      job = this.#write({
        ...latest,
        status: 'running',
        startedAt: this.deps.now(),
        process: identity,
      });
    } catch (err) {
      const latest = this.#read(jobId) || job;
      if (TERMINAL_MODEL_JOB_STATUSES.has(latest.status)) return publicStart(latest);
      job = this.#write({
        ...latest,
        status: 'failed',
        finishedAt: this.deps.now(),
        error: {
          code: err?.code || 'model_job_launch_failed',
          message: String(err?.message || err),
        },
      });
    } finally {
      this.launching.delete(jobId);
      const key = activeKey(kind, modelId);
      if (this.launchBlocked.get(key)?.jobId === jobId) this.launchBlocked.delete(key);
    }
    // Контракт start не зависит от того, успел ли локальный spawn перейти в running.
    return { jobId, status: 'queued' };
  }

  startDownload(modelId) {
    modelOrThrow(modelId);
    return this.#start('download', modelId);
  }

  startCopy(modelId) {
    modelOrThrow(modelId);
    return this.#start('copy', modelId);
  }

  benchmarkStatus() {
    if (typeof this.benchmarkAudioPath !== 'string' || !this.benchmarkAudioPath) {
      return {
        available: false,
        reason: 'Эталонная запись benchmark не настроена оператором.',
      };
    }
    if (!path.isAbsolute(this.benchmarkAudioPath)) {
      return {
        available: false,
        reason: 'Путь к эталонной записи benchmark должен быть абсолютным.',
      };
    }
    try {
      this.deps.accessSync(this.benchmarkAudioPath, fs.constants.R_OK);
      if (!this.deps.statSync(this.benchmarkAudioPath).isFile()) throw new Error('not a file');
      return { available: true, reason: null };
    } catch {
      return {
        available: false,
        reason: 'Эталонная запись benchmark не найдена или недоступна для чтения.',
      };
    }
  }

  startBenchmark(options = {}) {
    const normalized = validateBenchmark(options);
    const availability = this.benchmarkStatus();
    if (!availability.available) {
      throw new ModelJobError('speech_benchmark_unavailable', availability.reason, 409);
    }
    return this.#start('benchmark', normalized.modelId, { benchmark: normalized });
  }

  readJob(jobId) {
    assertModelJobId(jobId);
    let job = this.#read(jobId);
    if (!job) return null;
    if (ACTIVE_MODEL_JOB_STATUSES.has(job.status) && !this.launching.has(job.jobId)) {
      const alive = job.status === 'running'
        && job.process
        && this.deps.processIdentityMatches(job.process);
      if (!alive) {
        job = this.#write({
          ...job,
          status: 'interrupted',
          finishedAt: this.deps.now(),
          error: { code: 'model_job_interrupted', message: 'Model-job worker больше не работает.' },
        });
      }
    }
    void this.#notifyModelReady(job);
    return publicModelJob(job);
  }

  async cancelJob(jobId) {
    assertModelJobId(jobId);
    let job = this.#read(jobId);
    if (!job) return null;
    if (TERMINAL_MODEL_JOB_STATUSES.has(job.status)) {
      if ((job.status === 'cancelled' || job.status === 'interrupted') && job.process) {
        await this.#terminateOwnedProcess(job);
      }
      return publicModelJob(job);
    }

    if (this.launching.has(job.jobId)) {
      // Пока launcher не settled, process identity ещё неизвестна. Terminal status
      // нужен UI сразу, но key остаётся закрытым до позднего resolve/reject.
      this.launchBlocked.set(activeKey(job.kind, job.modelId), { jobId: job.jobId });
      job = this.#write({
        ...job,
        status: 'cancelled',
        finishedAt: this.deps.now(),
        error: null,
      });
      return publicModelJob(job);
    }

    await this.#terminateOwnedProcess(job);
    job = this.#read(jobId) || job;
    if (TERMINAL_MODEL_JOB_STATUSES.has(job.status)) return publicModelJob(job);
    job = this.#write({
      ...job,
      status: 'cancelled',
      finishedAt: this.deps.now(),
      error: null,
    });
    return publicModelJob(job);
  }
}

export {
  ACTIVE_MODEL_JOB_STATUSES,
  MODEL_JOB_KINDS,
  MODEL_JOB_STATUSES,
  TERMINAL_MODEL_JOB_STATUSES,
  decodeModelJob,
  encodeModelJob,
  publicModelJob,
  readModelJobFile,
  writeModelJobFile,
} from './model-jobs-contract.js';

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const MODEL_JOB_SCHEMA_VERSION = 1;
export const MODEL_JOB_KINDS = Object.freeze(['download', 'copy', 'benchmark']);
export const MODEL_JOB_STATUSES = Object.freeze([
  'queued', 'running', 'done', 'failed', 'cancelled', 'interrupted',
]);
export const ACTIVE_MODEL_JOB_STATUSES = new Set(['queued', 'running']);
export const TERMINAL_MODEL_JOB_STATUSES = new Set([
  'done', 'failed', 'cancelled', 'interrupted',
]);

const JOB_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/;

export function assertModelJobId(value) {
  if (typeof value !== 'string' || !JOB_ID_RE.test(value)) {
    throw new TypeError('Некорректный model job id.');
  }
  return value;
}

function parse(value) {
  if (Buffer.isBuffer(value)) return JSON.parse(value.toString('utf8'));
  if (typeof value === 'string') return JSON.parse(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Model job должен быть объектом или JSON-строкой.');
  }
  return value;
}

function string(value, field, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`В model job отсутствует ${field}.`);
  }
  return value;
}

function progress(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const done = Number(value.done);
  const total = Number(value.total);
  if (!Number.isFinite(done) || done < 0 || !Number.isFinite(total) || total < 0) return null;
  return {
    done,
    total,
    file: typeof value.file === 'string' ? value.file : '',
  };
}

function error(value) {
  if (value == null) return null;
  if (typeof value === 'string') return { code: 'model_job_failed', message: value };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    code: typeof value.code === 'string' && value.code ? value.code : 'model_job_failed',
    message: typeof value.message === 'string' ? value.message : String(value.message || ''),
  };
}

export function encodeModelJob(value) {
  const source = parse(value);
  const kind = string(source.kind, 'kind');
  const status = string(source.status, 'status');
  if (!MODEL_JOB_KINDS.includes(kind)) throw new TypeError(`Неизвестный kind model job: ${kind}`);
  if (!MODEL_JOB_STATUSES.includes(status)) throw new TypeError(`Неизвестный status model job: ${status}`);
  const job = {
    schemaVersion: MODEL_JOB_SCHEMA_VERSION,
    jobId: assertModelJobId(source.jobId),
    kind,
    modelId: string(source.modelId, 'modelId'),
    status,
    createdAt: Number(source.createdAt) || Date.now(),
    startedAt: source.startedAt == null ? null : Number(source.startedAt),
    finishedAt: source.finishedAt == null ? null : Number(source.finishedAt),
    progress: progress(source.progress),
    result: source.result ?? null,
    error: error(source.error),
    process: source.process ?? null,
    task: source.task ?? null,
  };
  return job;
}

export function decodeModelJob(value) {
  return encodeModelJob(parse(value));
}

/** Только публичный status contract: task и process identity наружу не уходят. */
export function publicModelJob(value) {
  const job = decodeModelJob(value);
  return {
    jobId: job.jobId,
    kind: job.kind,
    modelId: job.modelId,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    progress: job.progress,
    result: job.result,
    error: job.error,
  };
}

export function modelJobPath(jobsDir, jobId) {
  return path.join(jobsDir, `${assertModelJobId(jobId)}.json`);
}

export function readModelJobFile(jobsDir, jobId, deps = {}) {
  const readFileSync = deps.readFileSync || fs.readFileSync;
  try {
    return decodeModelJob(readFileSync(modelJobPath(jobsDir, jobId), 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

export function writeModelJobFile(jobsDir, value, deps = {}) {
  const mkdirSync = deps.mkdirSync || fs.mkdirSync;
  const writeFileSync = deps.writeFileSync || fs.writeFileSync;
  const renameSync = deps.renameSync || fs.renameSync;
  const unlinkSync = deps.unlinkSync || fs.unlinkSync;
  const job = encodeModelJob(value);
  mkdirSync(jobsDir, { recursive: true });
  const target = modelJobPath(jobsDir, job.jobId);
  const temp = `${target}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temp, JSON.stringify(job, null, 2), { mode: 0o600 });
    renameSync(temp, target);
  } catch (err) {
    try { unlinkSync(temp); } catch { /* temp мог не появиться */ }
    throw err;
  }
  return job;
}

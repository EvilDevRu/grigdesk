import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { OwnedProcessIdentity } from './modelJobsProcess.ts';

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

// Прогресс задачи: сколько байт из скольких и какой файл сейчас идёт.
export interface ModelJobProgress {
  done: number;
  total: number;
  file: string;
}

// Ошибка задачи в форме, которую видит человек.
export interface ModelJobFailure {
  code: string;
  message: string;
}

// Запись задачи модели на диске. `task` и `process` наружу не уходят.
export interface ModelJob {
  schemaVersion: number;
  jobId: string;
  kind: string;
  modelId: string;
  status: string;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  progress: ModelJobProgress | null;
  result: unknown;
  error: ModelJobFailure | null;
  process: OwnedProcessIdentity | null;
  task: Record<string, unknown> | null;
}

// Публичный status contract задачи.
export type PublicModelJob = Omit<ModelJob, 'schemaVersion' | 'process' | 'task'>;

// Подменяемые в тестах файловые операции.
export interface ModelJobFileDeps {
  readFileSync?: (path: string, encoding: 'utf8') => string;
  mkdirSync?: (path: string, options: { recursive: boolean }) => unknown;
  writeFileSync?: (path: string, data: string, options: { mode: number }) => void;
  renameSync?: (from: string, to: string) => void;
  unlinkSync?: (path: string) => void;
}

export function assertModelJobId(value: unknown): string {
  if (typeof value !== 'string' || !JOB_ID_RE.test(value)) {
    throw new TypeError('Некорректный model job id.');
  }
  return value;
}

function parse(value: unknown): Record<string, unknown> {
  if (Buffer.isBuffer(value)) return JSON.parse(value.toString('utf8'));
  if (typeof value === 'string') return JSON.parse(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Model job должен быть объектом или JSON-строкой.');
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`В model job отсутствует ${field}.`);
  }
  return value;
}

function progress(value: unknown): ModelJobProgress | null {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as { done?: unknown; total?: unknown; file?: unknown };
  const done = Number(source.done);
  const total = Number(source.total);
  if (!Number.isFinite(done) || done < 0 || !Number.isFinite(total) || total < 0) return null;
  return {
    done,
    total,
    file: typeof source.file === 'string' ? source.file : '',
  };
}

function error(value: unknown): ModelJobFailure | null {
  if (value == null) return null;
  if (typeof value === 'string') return { code: 'model_job_failed', message: value };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as { code?: unknown; message?: unknown };
  return {
    code: typeof source.code === 'string' && source.code ? source.code : 'model_job_failed',
    message: typeof source.message === 'string' ? source.message : String(source.message || ''),
  };
}

export function encodeModelJob(value: unknown): ModelJob {
  const source = parse(value);
  const kind = string(source.kind, 'kind');
  const status = string(source.status, 'status');
  if (!MODEL_JOB_KINDS.includes(kind)) throw new TypeError(`Неизвестный kind model job: ${kind}`);
  if (!MODEL_JOB_STATUSES.includes(status)) throw new TypeError(`Неизвестный status model job: ${status}`);
  const job: ModelJob = {
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
    process: (source.process ?? null) as OwnedProcessIdentity | null,
    task: (source.task ?? null) as Record<string, unknown> | null,
  };
  return job;
}

export function decodeModelJob(value: unknown): ModelJob {
  return encodeModelJob(parse(value));
}

/** Только публичный status contract: task и process identity наружу не уходят. */
export function publicModelJob(value: unknown): PublicModelJob {
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

export function modelJobPath(jobsDir: string, jobId: unknown): string {
  return path.join(jobsDir, `${assertModelJobId(jobId)}.json`);
}

export function readModelJobFile(
  jobsDir: string,
  jobId: unknown,
  deps: ModelJobFileDeps = {},
): ModelJob | null {
  const readFileSync = deps.readFileSync || fs.readFileSync;
  try {
    return decodeModelJob(readFileSync(modelJobPath(jobsDir, jobId), 'utf8'));
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === 'ENOENT') return null;
    throw err;
  }
}

export function writeModelJobFile(
  jobsDir: string,
  value: unknown,
  deps: ModelJobFileDeps = {},
): ModelJob {
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

import path from 'node:path';
import { existsSync, readdirSync } from 'node:fs';

import { normalizeSpeechOptions } from './options.js';
import { speechModel } from './catalog.js';

export const INGEST_JOB_SCHEMA_VERSION = 2;

/** Собирает argv Python строго из разрешённых transport-полей. */
export function buildTranscribeArgv({ scriptPath, audioPath, options, progressFile = null }) {
  if (!scriptPath || !audioPath) {
    throw new TypeError('Для транскрипции обязательны scriptPath и audioPath');
  }
  const speech = normalizeSpeechOptions(options, options?.scenario || 'dictation');
  const catalogModel = speechModel(speech.model);
  if (!catalogModel) throw new TypeError(`Модель ${speech.model} отсутствует в catalog`);
  const argv = [
    scriptPath,
    audioPath,
    '--model', speech.model,
    '--model-repo', catalogModel.repo,
    '--model-revision', catalogModel.revision,
  ];
  for (const alias of catalogModel.aliases) argv.push('--model-alias', alias);
  argv.push(
    '--lang', speech.language,
    '--device', speech.device,
    '--compute-type', speech.computeType,
    '--beam-size', String(speech.beamSize),
  );
  if (speech.hotwords) argv.push('--hotwords', speech.hotwords);
  if (!speech.conditionOnPreviousText) argv.push('--no-condition-previous');
  if (speech.initialPrompt) argv.push('--initial-prompt', speech.initialPrompt);
  argv.push('--vad-silence-ms', String(speech.vadSilenceMs));
  if (progressFile) argv.push('--progress-file', progressFile);
  return argv;
}

/**
 * Изолирует HuggingFace-кэш каждого Python spawn внутри каталога кокпита.
 * Сигнатура с объектом не позволяет случайно перепутать base env и путь.
 */
function sitePackagesDir(pythonPath) {
  if (!pythonPath || path.basename(path.dirname(pythonPath)) !== 'bin') return null;
  const venvDir = path.dirname(path.dirname(pythonPath));
  const libDir = path.join(venvDir, 'lib');
  try {
    const pythonDir = readdirSync(libDir)
      .filter((name) => /^python\d+\.\d+$/.test(name))
      .sort()
      .find((name) => existsSync(path.join(libDir, name, 'site-packages')));
    if (pythonDir) return path.join(libDir, pythonDir, 'site-packages');
  } catch {
    // Для ещё не созданного venv оставляем детерминированный fallback ниже.
  }
  return path.join(venvDir, 'site-packages');
}

export function pythonEnv({ mediaHfDir, pythonPath = '', baseEnv = process.env } = {}) {
  if (typeof mediaHfDir !== 'string' || mediaHfDir.length === 0) {
    throw new TypeError('mediaHfDir обязателен для Python spawn');
  }
  const env = { ...baseEnv };
  delete env.HF_HUB_CACHE;
  delete env.HUGGINGFACE_HUB_CACHE;
  env.HF_HOME = mediaHfDir;
  env.HF_XET_CACHE = path.join(mediaHfDir, 'xet');
  const sitePackages = sitePackagesDir(pythonPath);
  if (sitePackages) {
    const cublasLib = path.join(sitePackages, 'nvidia', 'cublas', 'lib');
    const current = (env.LD_LIBRARY_PATH || '').split(path.delimiter).filter(Boolean);
    env.LD_LIBRARY_PATH = [cublasLib, ...current.filter((entry) => entry !== cublasLib)]
      .join(path.delimiter);
  }
  return env;
}

function runtimeFields(value = {}) {
  const runtime = {};
  for (const field of ['pythonPath', 'transcribePath', 'mediaHfDir']) {
    if (typeof value[field] === 'string' && value[field]) runtime[field] = value[field];
  }
  return runtime;
}

function parseJob(value) {
  if (Buffer.isBuffer(value)) return JSON.parse(value.toString('utf8'));
  if (typeof value === 'string') return JSON.parse(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Job должен быть объектом или JSON-строкой');
  }
  return value;
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`В ingest job отсутствует ${field}`);
  }
  return value;
}

/** Кодирует job в сериализуемую схему v2 с единым вложенным speech-контрактом. */
export function encodeIngestJob(value) {
  const job = parseJob(value);
  const speech = normalizeSpeechOptions(job.speech ?? job.options ?? {
    scenario: 'video',
    model: job.model,
    language: job.language ?? job.lang,
    device: job.device,
    computeType: job.computeType,
    beamSize: job.beamSize,
    hotwords: job.hotwords,
    vadSilenceMs: job.vadSilenceMs,
    conditionOnPreviousText: job.conditionOnPreviousText,
    initialPrompt: job.initialPrompt,
  }, 'video');
  const frames = job.frames ?? 0;
  if (!Number.isInteger(frames) || frames < 0) {
    throw new TypeError('frames должен быть неотрицательным целым');
  }

  const encoded = {
    schemaVersion: INGEST_JOB_SCHEMA_VERSION,
    jobId: requiredString(job.jobId, 'jobId'),
    status: job.status || 'running',
    filePath: requiredString(job.filePath, 'filePath'),
    workDir: requiredString(job.workDir, 'workDir'),
    frames,
    speech,
    runtime: runtimeFields(job.runtime ?? job),
    startedAt: job.startedAt ?? Date.now(),
    finishedAt: job.finishedAt ?? null,
    result: job.result ?? null,
    error: job.error ?? null,
  };
  if (job.progress != null) encoded.progress = job.progress;
  return encoded;
}

/** Читает v2 и старые плоские jobs, не теряя поля состояния. */
export function decodeIngestJob(value) {
  const job = parseJob(value);
  requiredString(job.jobId, 'jobId');
  requiredString(job.filePath, 'filePath');
  requiredString(job.workDir, 'workDir');
  const speech = normalizeSpeechOptions(job.speech ?? {
    scenario: 'video',
    model: job.model,
    language: job.language ?? job.lang,
    device: job.device,
    computeType: job.computeType,
    beamSize: job.beamSize,
    hotwords: job.hotwords,
    vadSilenceMs: job.vadSilenceMs,
    conditionOnPreviousText: job.conditionOnPreviousText,
    initialPrompt: job.initialPrompt,
  }, 'video');
  return {
    ...job,
    schemaVersion: job.schemaVersion ?? 1,
    frames: job.frames ?? 0,
    speech,
    runtime: runtimeFields(job.runtime ?? job),
  };
}

// Тонкий CLI-вход detached-задачи. Вся сериализация job и параметры Python живут
// в общих transport-контрактах, поэтому этот файл можно импортировать в unit-тесте.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ingestRecording, writeIngestJobFile } from './ingest.js';
import { isCudaRuntimeFailure } from '../speech/errors.js';
import { decodeIngestJob, encodeIngestJob } from '../speech/transport.js';

function writeJob(statusPath, job, deps) {
  if (!statusPath) return;
  writeIngestJobFile(statusPath, job, deps);
}

/**
 * Выполняет одну задачу. При строковом первом аргументе читает job из status-файла;
 * объект можно передать напрямую в transport-тесте вместе с deps.statusPath.
 */
export async function runIngestWorker(jobOrStatusPath, deps = {}) {
  const read = deps.readFileSync || readFileSync;
  const exists = deps.existsSync || existsSync;
  const ingest = deps.ingestRecording || ingestRecording;
  const setTimer = deps.setInterval || setInterval;
  const clearTimer = deps.clearInterval || clearInterval;
  const now = deps.now || Date.now;
  const intervalMs = deps.progressIntervalMs ?? 5000;
  const statusPath = typeof jobOrStatusPath === 'string'
    ? jobOrStatusPath
    : deps.statusPath || null;
  const source = typeof jobOrStatusPath === 'string'
    ? read(jobOrStatusPath, 'utf8')
    : jobOrStatusPath;
  const job = decodeIngestJob(source);

  // Progress — best-effort: повреждённый промежуточный JSON не влияет на результат.
  const progressFile = join(job.workDir, 'progress.json');
  const timer = statusPath && intervalMs > 0 ? setTimer(() => {
    try {
      if (!exists(progressFile)) return;
      job.progress = JSON.parse(read(progressFile, 'utf8'));
      writeJob(statusPath, job, deps);
    } catch {
      // Следующий тик прочитает уже полностью переименованный progress-файл.
    }
  }, intervalMs) : null;

  try {
    const ingestWithSpeech = (speech) => ingest({
      filePath: job.filePath,
      workDir: job.workDir,
      frames: job.frames,
      speech,
      pythonPath: job.runtime.pythonPath || process.env.COCKPIT_MEDIA_PYTHON,
      transcribePath: job.runtime.transcribePath || process.env.COCKPIT_TRANSCRIBE_PY,
      mediaHfDir: job.runtime.mediaHfDir || process.env.COCKPIT_MEDIA_HF_DIR,
    });
    try {
      job.result = await ingestWithSpeech(job.speech);
    } catch (error) {
      if (job.speech.device !== 'auto' || !isCudaRuntimeFailure(error)) throw error;
      const fallbackSpeech = Object.freeze({
        ...job.speech,
        device: 'cpu',
        computeType: 'int8',
      });
      const result = await ingestWithSpeech(fallbackSpeech);
      job.result = {
        ...result,
        execution: {
          engine: 'whisper',
          mode: 'detached',
          device: 'cpu',
          fallback: 'cuda_failed',
        },
      };
    }
    job.status = 'done';
    job.error = null;
  } catch (error) {
    job.status = 'failed';
    job.error = String(error?.message || error);
  } finally {
    if (timer) clearTimer(timer);
  }
  job.finishedAt = now();
  writeJob(statusPath, job, deps);
  return encodeIngestJob(job);
}

const invokedAsCli = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedAsCli) {
  const statusPath = process.argv[2];
  if (!statusPath) {
    process.exitCode = 2;
  } else {
    await runIngestWorker(statusPath);
  }
}

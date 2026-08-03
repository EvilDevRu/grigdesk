// MediaAdapter — локальное распознавание речи из видео/аудио.
// Node-обвязка + Python whisper (venv через COCKPIT_MEDIA_PYTHON). Async job-модель:
// ingest сразу возвращает jobId, статус читается поллингом (файлы в mediaDir/jobs).
import path from 'node:path';
import { preflight } from '../lib/media/preflight.js';
import { startIngestJob, readIngestJob, extractFramesAt } from '../lib/media/ingest.js';

export class MediaAdapter {
  /** @param {{ mediaDir: string }} opts */
  constructor({ mediaDir }) {
    this.mediaDir = mediaDir;
    this.jobsDir = path.join(mediaDir, 'jobs');
  }

  /** Предполётная проверка окружения (ffmpeg/ffprobe/venv/faster-whisper). */
  doctor() { return preflight(); }

  /** Запуск распознавания в фоне → { jobId }. */
  ingest({ filePath, model = 'medium', lang = 'ru', frames = 0 }) {
    const workDir = path.join(this.mediaDir, `ingest-${Date.now()}`);
    const jobId = startIngestJob({ filePath, workDir, model, lang, frames, jobsDir: this.jobsDir });
    return { jobId };
  }

  /** Статус/результат job по jobId. */
  status(jobId) { return readIngestJob(jobId, this.jobsDir); }

  /** Извлечь кадры в указанные секунды. */
  extractFrames({ filePath, seconds, name }) {
    const destDir = path.join(this.mediaDir, `frames-${name || Date.now()}`);
    return extractFramesAt({ filePath, seconds, destDir });
  }
}

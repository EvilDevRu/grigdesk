// MediaAdapter — локальное распознавание речи из видео/аудио.
// Node-обвязка + Python whisper (venv через COCKPIT_MEDIA_PYTHON). Async job-модель:
// ingest сразу возвращает jobId, статус читается поллингом (файлы в mediaDir/jobs).
import path from 'node:path';
import { cutClipAt, extractFramesAt } from '../lib/media/ingest.ts';
import { SpeechRuntime } from '../lib/speech/runtime.js';

export class MediaAdapter {
  /** @param {{ mediaDir?: string, speechRuntime?: SpeechRuntime, speech?: SpeechRuntime }} opts */
  constructor({
    mediaDir,
    speechRuntime = null,
    speech = null,
    mediaHfDir = undefined,
    pythonPath = undefined,
    transcribePath = undefined,
  }) {
    this.speechRuntime = speechRuntime || speech || new SpeechRuntime({
      mediaDir,
      mediaHfDir,
      pythonPath,
      transcribePath,
    });
    this.mediaDir = mediaDir || this.speechRuntime.mediaDir;
    this.jobsDir = this.speechRuntime.jobsDir || path.join(this.mediaDir, 'jobs');
  }

  /** Предполётная проверка окружения (ffmpeg/ffprobe/venv/faster-whisper). */
  doctor() { return this.speechRuntime.capabilities(); }

  capabilities(options) { return this.speechRuntime.capabilities(options); }

  /** Короткий one-shot путь диктовки через тот же runtime. */
  transcribe(options) { return this.speechRuntime.transcribe(options); }

  /** Запуск распознавания в фоне → { jobId }. */
  ingest({
    filePath,
    model = null,
    videoModel = null,
    lang = null,
    language = null,
    frames = 0,
    settings = null,
    speechSettings = null,
    options = null,
  }) {
    const source = settings?.speech || settings || speechSettings || {};
    const mergedSettings = {
      ...source,
      ...(model || videoModel ? { videoModel: videoModel || model } : {}),
      ...(language || lang ? { language: language || lang } : {}),
    };
    const { jobId } = this.speechRuntime.startVideoJob({
      filePath,
      frames,
      settings: mergedSettings,
      options,
    });
    return { jobId };
  }

  /** Статус/результат job по jobId. */
  status(jobId) { return this.speechRuntime.readVideoJob(jobId); }

  /** Извлечь кадры в указанные секунды. */
  extractFrames({ filePath, seconds, name }) {
    const destDir = path.join(this.mediaDir, `frames-${name || Date.now()}`);
    return extractFramesAt({ filePath, seconds, destDir });
  }

  /** Куда ложатся сами записи. Одно имя каталога на загрузку, уборку и подсчёт места. */
  get uploadsDir() { return path.join(this.mediaDir, 'uploads'); }

  /** Корень кадров встреч. Наружу отдаётся имя внутри него, а не путь. */
  get framesRoot() { return path.join(this.mediaDir, 'meeting-frames'); }

  /**
   * Кадры одного разбора встречи. Все части пишут в общий каталог разбора, поэтому
   * имя несёт номер части: у частей секунды локальные и совпадают между собой.
   */
  meetingFrames({ filePath, seconds, run, part = 0 }) {
    return extractFramesAt({
      filePath,
      seconds,
      destDir: path.join(this.framesRoot, run),
      prefix: `p${part}-`,
    });
  }

  /** Корень фрагментов записи. Наружу, как и у кадров, отдаётся имя внутри него. */
  get clipsRoot() { return path.join(this.mediaDir, 'meeting-clips'); }

  /**
   * Кусок записи вокруг места задачи. Номер части в имени обязателен по той же причине,
   * что и у кадров: секунды у частей локальные и совпадают между собой.
   */
  meetingClip({ filePath, from, seconds, run, part = 0 }) {
    return cutClipAt({
      filePath,
      from,
      seconds,
      destDir: path.join(this.clipsRoot, run),
      prefix: `p${part}-`,
    });
  }
}

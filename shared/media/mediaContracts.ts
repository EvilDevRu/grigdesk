// Контракт плагина «Видео → задачи». Разбор встречи идёт на сервере, а раздел живёт
// поллингом: до проверки формы ответ — недоверенный JSON, а не состояние разбора.
//
// Контракт описывает ровно то, что нужно разделу. Всё остальное — пути файлов на диске
// мозга, настройки распознавания, размеры промежуточных файлов — в браузер не едет и
// здесь не объявлено: их место на сервере.

import { contractDecoders } from '../lib/contractDecoders.ts';

export class MediaContractError extends Error {
  constructor(path: string) {
    super(`Некорректный ответ раздела «Видео»: поле ${path}`);
    this.name = 'MediaContractError';
  }
}

const {
  boolean,
  listOf,
  nullable,
  numeric,
  objectOf,
  oneOf,
  text,
  wholeNumber,
} = contractDecoders((path) => {
  throw new MediaContractError(path);
});

// Реплика расшифровки. Таймкоды секундами: их же показывает лента и по ним режется
// фрагмент записи.
const transcriptSegment = objectOf({
  start: numeric,
  end: numeric,
  text,
});

const jobResult = objectOf({
  duration: numeric,
  transcript: objectOf({ segments: listOf(transcriptSegment) }),
});

// Прогресс распознавания в секундах записи, а не в процентах: его пишет сам whisper.
const jobProgress = objectOf({
  done: numeric,
  total: numeric,
});

const job = objectOf({
  status: oneOf('running', 'done', 'failed'),
  progress: nullable(jobProgress),
  result: nullable(jobResult),
  error: nullable(text),
});

const uploadResponse = objectOf({ jobId: text });

const storageUsage = objectOf({
  files: wholeNumber,
  bytes: wholeNumber,
  ttlMs: wholeNumber,
});

const doctorReport = objectOf({
  ok: boolean,
  storage: nullable(storageUsage),
});

// Кадр и фрагмент раздел получает ИМЕНЕМ внутри своего каталога: путь на диске мозга
// наружу не выходит вовсе, а байты отдаёт отдельная ручка по этому имени.
const frame = objectOf({
  name: text,
  at: numeric,
});

const clip = objectOf({
  name: text,
  at: numeric,
  from: numeric,
  to: numeric,
  bytes: wholeNumber,
});

const planTask = objectOf({
  title: text,
  description: text,
  confidence: numeric,
  reason: text,
  at: nullable(numeric),
  frame: nullable(frame),
});

const planResponse = objectOf({
  model: text,
  truncated: boolean,
  count: wholeNumber,
  tasks: listOf(planTask),
});

const clipResponse = objectOf({ clip: nullable(clip) });

export type MediaTranscriptSegment = ReturnType<typeof transcriptSegment>;
export type MediaJobResult = ReturnType<typeof jobResult>;
export type MediaJobProgress = ReturnType<typeof jobProgress>;
export type MediaJob = ReturnType<typeof job>;
export type MediaJobStatus = MediaJob['status'];
export type MediaStorageUsage = ReturnType<typeof storageUsage>;
export type MediaDoctorReport = ReturnType<typeof doctorReport>;
export type MediaFrame = ReturnType<typeof frame>;
export type MediaClip = ReturnType<typeof clip>;
export type MediaPlanTask = ReturnType<typeof planTask>;
export type MediaPlanResponse = ReturnType<typeof planResponse>;
export type MediaClipResponse = ReturnType<typeof clipResponse>;
export type MediaUploadResponse = ReturnType<typeof uploadResponse>;

// Тело запроса нарезки и разбора: части встречи всегда едут списком, потому что запись
// законно лежит в нескольких файлах и склеивать их обязан сервер.
export interface MediaPlanRequest {
  jobIds: string[];
  hint: string;
}

export interface MediaClipRequest {
  jobIds: string[];
  at: number;
  window: number;
}

export function parseMediaJob(value: unknown): MediaJob {
  return job(value, 'job');
}

export function parseMediaUpload(value: unknown): MediaUploadResponse {
  return uploadResponse(value, 'upload');
}

export function parseMediaDoctor(value: unknown): MediaDoctorReport {
  return doctorReport(value, 'doctor');
}

export function parseMediaPlan(value: unknown): MediaPlanResponse {
  return planResponse(value, 'plan');
}

export function parseMediaClip(value: unknown): MediaClipResponse {
  return clipResponse(value, 'clip');
}

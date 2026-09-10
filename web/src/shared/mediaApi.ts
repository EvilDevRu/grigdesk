import { api } from './apiClient.ts';
import {
  parseMediaClip,
  parseMediaDoctor,
  parseMediaJob,
  parseMediaPlan,
  parseMediaUpload,
} from '../../../shared/mediaContracts.ts';
import type { MediaClipRequest, MediaPlanRequest } from '../../../shared/mediaContracts.ts';

/**
 * Загрузка записи идёт СВОИМ fetch, а не общим клиентом: тело — multipart на сотни
 * мегабайт, и заголовкам общего клиента здесь делать нечего. Авторизация — сессионной
 * cookie: заголовок `X-Cockpit-Token` принадлежит локальным CLI и из браузера уехал бы
 * в публичный бандл.
 */
async function uploadPart(file: File): Promise<unknown> {
  const form = new FormData();

  form.append('file', file);

  const response = await fetch(api.url('/api/media/upload'), {
    method: 'POST',
    body: form,
    credentials: 'include',
  });
  const data: unknown = await response.json();

  if (!response.ok) {
    const failure = data !== null && typeof data === 'object'
      ? data as { message?: unknown; error?: unknown }
      : {};

    throw new Error(String(failure.message || failure.error || `HTTP ${response.status}`));
  }

  return data;
}

/**
 * Единственная граница сети раздела «Видео». Разбор идёт на сервере, раздел читает его
 * поллингом, и каждый ответ подтверждается контрактом до попадания в сеанс: черновик
 * задачи собирается по чужой речи, и показывать по нему непроверенную форму нельзя.
 */
export const mediaApi = {
  async doctor() {
    const value: unknown = await api.get('/api/media/doctor');

    return parseMediaDoctor(value);
  },

  async job(jobId: string) {
    const value: unknown = await api.get(`/api/media/ingest/${encodeURIComponent(jobId)}`);

    return parseMediaJob(value);
  },

  async upload(file: File) {
    return parseMediaUpload(await uploadPart(file));
  },

  async planTasks(request: MediaPlanRequest) {
    const value: unknown = await api.post('/api/media/plan-tasks', request);

    return parseMediaPlan(value);
  },

  async clip(request: MediaClipRequest) {
    const value: unknown = await api.post('/api/media/clip', request);

    return parseMediaClip(value);
  },

  // Байты кадра и фрагмента: имя собрал сервер, путь на диске наружу не выходит вовсе.
  frameUrl(name: string): string {
    return api.url(`/api/media/frame/${name}`);
  },

  clipUrl(name: string): string {
    return api.url(`/api/media/clip/${name}`);
  },
};

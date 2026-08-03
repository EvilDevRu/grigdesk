// Модуль media — серверная часть плагина «Видео → задачи»: распознавание речи,
// кадры, статусы job'ов. Диктовка чата сюда НЕ входит (/api/chat/transcribe зовёт
// ingestRecording напрямую) — выключение плагина её не трогает.
import fp from 'fastify-plugin';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

async function mediaModule(fastify, opts) {
  const { media } = opts;
  const fail = (reply, err) => reply.code(500).send({ error: 'media_error', message: err.message });
  // Гейт плагина «video»: выключен — раздела нет. Проверка живая (по prefs),
  // тумблер в настройках действует без рестарта.
  const gate = (reply) => (fastify.pluginEnabled('video') ? null
    : reply.code(404).send({ error: 'plugin_disabled', message: 'Плагин «Видео → задачи» выключен.' }));

  // Проверка окружения (ffmpeg/venv/whisper).
  fastify.get('/api/media/doctor', async (request, reply) => (gate(reply) ? reply : media.doctor()));

  // Загрузка видео/аудио (multipart) → сохраняем на диск → запускаем распознавание → { jobId }.
  fastify.post('/api/media/upload', async (request, reply) => {
    if (gate(reply)) return reply;
    const data = await request.file();
    if (!data) return reply.code(400).send({ error: 'no_file' });
    const dir = path.join(media.mediaDir, 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    const safe = (data.filename || 'upload').replace(/[^\w.\-а-яё]+/gi, '_');
    const filePath = path.join(dir, `${Date.now()}-${safe}`);
    try {
      await pipeline(data.file, fs.createWriteStream(filePath));
      const { jobId } = media.ingest({ filePath });
      return { jobId, filename: data.filename };
    } catch (err) { return fail(reply, err); }
  });

  // Запуск распознавания → { jobId }. filePath — путь к видео/аудио на диске.
  fastify.post('/api/media/ingest', async (request, reply) => {
    if (gate(reply)) return reply;
    const { filePath, model, lang, frames } = request.body || {};
    if (!filePath) return reply.code(400).send({ error: 'bad_input', message: 'filePath обязателен' });
    // Модель по умолчанию — из настроек плагина (Настройки → Плагины → Видео).
    try { return media.ingest({ filePath, model: model || fastify.pluginSettings('video').whisperModel, lang, frames }); }
    catch (err) { return fail(reply, err); }
  });

  // Статус/результат job.
  fastify.get('/api/media/ingest/:jobId', async (request, reply) => {
    if (gate(reply)) return reply;
    try {
      const job = media.status(request.params.jobId);
      if (!job) return reply.code(404).send({ error: 'not_found' });
      return job;
    } catch (err) { return fail(reply, err); }
  });

  // Извлечь кадры по секундам.
  fastify.post('/api/media/extract-frame', async (request, reply) => {
    if (gate(reply)) return reply;
    const { filePath, seconds, name } = request.body || {};
    if (!filePath || !Array.isArray(seconds)) return reply.code(400).send({ error: 'bad_input' });
    try { return await media.extractFrames({ filePath, seconds, name }); }
    catch (err) { return fail(reply, err); }
  });
}

export default fp(mediaModule, { name: 'module-media' });

// Модуль media — эндпоинты распознавания речи (замена медиа-инструментов b24-mcp).
import fp from 'fastify-plugin';

async function mediaModule(fastify, opts) {
  const { media } = opts;
  const fail = (reply, err) => reply.code(500).send({ error: 'media_error', message: err.message });

  // Проверка окружения (ffmpeg/venv/whisper).
  fastify.get('/api/media/doctor', async () => media.doctor());

  // Запуск распознавания → { jobId }. filePath — путь к видео/аудио на диске.
  fastify.post('/api/media/ingest', async (request, reply) => {
    const { filePath, model, lang, frames } = request.body || {};
    if (!filePath) return reply.code(400).send({ error: 'bad_input', message: 'filePath обязателен' });
    try { return media.ingest({ filePath, model, lang, frames }); }
    catch (err) { return fail(reply, err); }
  });

  // Статус/результат job.
  fastify.get('/api/media/ingest/:jobId', async (request, reply) => {
    try {
      const job = media.status(request.params.jobId);
      if (!job) return reply.code(404).send({ error: 'not_found' });
      return job;
    } catch (err) { return fail(reply, err); }
  });

  // Извлечь кадры по секундам.
  fastify.post('/api/media/extract-frame', async (request, reply) => {
    const { filePath, seconds, name } = request.body || {};
    if (!filePath || !Array.isArray(seconds)) return reply.code(400).send({ error: 'bad_input' });
    try { return await media.extractFrames({ filePath, seconds, name }); }
    catch (err) { return fail(reply, err); }
  });
}

export default fp(mediaModule, { name: 'module-media' });

// Модуль media — серверная часть плагина «Видео → задачи»: распознавание речи,
// кадры, статусы job'ов. Диктовка чата сюда НЕ входит — выключение плагина её не трогает.
import fp from 'fastify-plugin';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';

import { runMeetingPlan } from '../../lib/media/meeting-plan.js';
import {
  buildMeetingFrames,
  meetingFramePath,
  sweepMeetingFrames,
} from '../../lib/media/meeting-frames.js';

// Потолок частей одной встречи. Не про безопасность (каждый id всё равно проверяется
// как свой job), а про здравый смысл: запись режут на единицы файлов, а не на сотни,
// и потолок держит стоимость склейки предсказуемой.
const MAX_MEETING_PARTS = 12;

async function mediaModule(fastify, opts) {
  const {
    media,
    speechSettings = null,
    config = {},
    meetingModelRef = null,
    providerSettings = null,
    // Резолвер модели подменяем только в тестах: живой реестр исполнителей и
    // capability-проверки к контракту самой ручки отношения не имеют.
    resolveMeetingTarget = null,
  } = opts;
  const currentSpeechSettings = () => {
    const value = typeof speechSettings === 'function' ? speechSettings() : speechSettings;
    return value?.speech || value || {};
  };
  const currentMeetingModel = () => (typeof meetingModelRef === 'function'
    ? meetingModelRef()
    : meetingModelRef);
  const currentProviderSettings = () => (typeof providerSettings === 'function'
    ? providerSettings() || {}
    : providerSettings || {});
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
      // multipart при упоре в `limits.fileSize` обрывает поток МОЛЧА: на диск ложится
      // обрезанный файл, он даже воспроизводится — просто кончается раньше. Дальше
      // распознавание честно разбирает огрызок, и со стороны это неотличимо от
      // «кокпит потерял половину встречи». Поэтому отказ, а не короткая расшифровка.
      if (data.file.truncated) {
        fs.rmSync(filePath, { force: true });
        return reply.code(413).send({ error: 'file_too_large' });
      }
      const { jobId } = media.ingest({ filePath, settings: currentSpeechSettings() });
      return { jobId, filename: data.filename };
    } catch (err) { return fail(reply, err); }
  });

  // Запуск распознавания → { jobId }. filePath — путь к видео/аудио на диске.
  fastify.post('/api/media/ingest', async (request, reply) => {
    if (gate(reply)) return reply;
    const { filePath, model, lang, frames } = request.body || {};
    if (!filePath) return reply.code(400).send({ error: 'bad_input', message: 'filePath обязателен' });
    const settings = currentSpeechSettings();
    try {
      return media.ingest({
        filePath,
        model,
        lang,
        frames,
        settings,
      });
    }
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

  // Разбор готовой расшифровки на черновики задач.
  //
  // Сегменты берём из СВОЕГО job'а по его id, а не из тела запроса: расшифровка уже
  // лежит на сервере, и гонять её через браузер обратно значило бы и платить трафиком,
  // и принимать на веру текст, который затем уедет в prompt.
  fastify.post('/api/media/plan-tasks', async (request, reply) => {
    if (gate(reply)) return reply;
    const { jobId, jobIds, hint } = request.body || {};
    // Встреча законно лежит в НЕСКОЛЬКИХ файлах: инструменты записи режут длинный
    // созвон на части (живой случай — 17:04 и 1:18 подряд, разрыв девять секунд).
    // Разбирать их по отдельности значит терять поводы, начатые в одной части и
    // договорённые в другой, поэтому части склеиваются до обращения к модели.
    const ids = Array.isArray(jobIds) && jobIds.length ? jobIds : (jobId ? [jobId] : []);
    if (!ids.length) return reply.code(400).send({ error: 'bad_input', message: 'jobId обязателен' });
    if (ids.length > MAX_MEETING_PARTS) {
      return reply.code(400).send({ error: 'too_many_parts', message: `Частей не больше ${MAX_MEETING_PARTS}.` });
    }

    // Таймкоды сквозные: у каждой части своё нулевое время, и без сдвига «04:31»
    // второй части указывало бы на начало первой — проверить формулировку нечем.
    const segments = [];
    const parts = [];
    let offset = 0;
    for (const raw of ids) {
      let job;
      try { job = media.status(String(raw)); } catch (err) { return fail(reply, err); }
      if (!job) return reply.code(404).send({ error: 'not_found' });
      if (job.status !== 'done') {
        return reply.code(409).send({ error: 'not_ready', message: 'Расшифровка ещё не готова.' });
      }
      // Путь исходника берём из СВОЕГО job'а: кадр снимается с той же записи, что
      // разобрана, и принимать путь от клиента ради этого нечего.
      parts.push({ filePath: job.filePath, offset, duration: Number(job.result?.duration) });
      for (const segment of job.result?.transcript?.segments || []) {
        segments.push({
          ...segment,
          start: Number(segment.start || 0) + offset,
          end: Number(segment.end ?? segment.start ?? 0) + offset,
        });
      }
      // Сдвиг берём по ДЛИТЕЛЬНОСТИ ЗАПИСИ, а не по концу последней реплики: молчание
      // в хвосте части — обычное дело, и по речи следующая часть наехала бы на неё.
      const duration = Number(job.result?.duration);
      offset += Number.isFinite(duration) && duration > 0
        ? duration
        : Number(job.result?.transcript?.segments?.at(-1)?.end || 0);
    }
    const result = await runMeetingPlan({
      segments,
      modelRef: currentMeetingModel(),
      hint: typeof hint === 'string' ? hint.slice(0, 2000) : '',
      config,
      providerSettings: currentProviderSettings(),
      log: fastify.log,
      ...(resolveMeetingTarget ? { resolveTarget: resolveMeetingTarget } : {}),
    });
    if (result.ok) {
      // Кадр к каждой задаче — то же место записи, на которое ссылается описание.
      // Снимается ПОСЛЕ разбора и молча: запись без видеодорожки задачи не отменяет,
      // а отказ ffmpeg не имеет права стоить человеку уже готового плана.
      const run = randomBytes(8).toString('hex');
      try { sweepMeetingFrames(media.framesRoot); } catch { /* уборка не мешает разбору */ }
      const frames = await buildMeetingFrames({
        tasks: result.tasks,
        segments,
        parts,
        run,
        extract: (options) => media.meetingFrames(options),
        log: fastify.log,
      });
      return { ...result, tasks: result.tasks.map((task, i) => ({ ...task, frame: frames[i] })) };
    }
    // Машинный код отдаём как есть, фразу собирает клиент: у «модель не выбрана» и
    // «модель ответила не по контракту» разные выходы для человека, и подменять их
    // общим «не удалось» — значит прятать от него, что делать дальше.
    const status = result.error === 'no_model' ? 409 : 502;
    return reply.code(status).send({ error: result.error });
  });

  // Байты кадра для превью. Имя проверяется буквально, путь снаружи не принимается.
  fastify.get('/api/media/frame/:run/:file', async (request, reply) => {
    if (gate(reply)) return reply;
    const full = meetingFramePath(media.framesRoot, `${request.params.run}/${request.params.file}`);
    if (!full) return reply.code(404).send({ error: 'not_found' });
    return reply
      .header('Content-Type', 'image/jpeg')
      .header('Cache-Control', 'no-store')
      .send(fs.createReadStream(full));
  });

  // Чужим модулям кадр отдаётся ИМЕНЕМ через декоратор, как разворот ссылок у telegram:
  // гейт плагина, корень каталога и проверка имени живут здесь и не расползаются по
  // модулю B24. Выключенный плагин даёт `null` — прикладывать нечего.
  fastify.decorate('mediaFramePath', (name) => (
    fastify.pluginEnabled('video') ? meetingFramePath(media.framesRoot, name) : null
  ));

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

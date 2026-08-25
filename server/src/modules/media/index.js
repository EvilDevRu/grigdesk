// Модуль media — серверная часть плагина «Видео → задачи»: распознавание речи,
// кадры, статусы job'ов. Диктовка чата сюда НЕ входит — выключение плагина её не трогает.
import fp from 'fastify-plugin';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { runMeetingPlan } from '../../lib/media/meeting-plan.js';
import {
  buildMeetingFrames,
  frameSecond,
  meetingFramePath,
  sweepMeetingFrames,
} from '../../lib/media/meeting-frames.js';
import {
  MEETING_CLIP_LIMITS,
  buildMeetingClip,
  clipWindow,
  meetingClipPath,
  meetingClipRun,
  sweepMeetingClips,
} from '../../lib/media/meeting-clips.js';
import {
  storeUpload,
  sweepMediaStorage,
  uploadsUsage,
} from '../../lib/media/storage.js';

// Потолок частей одной встречи. Не про безопасность (каждый id всё равно проверяется
// как свой job), а про здравый смысл: запись режут на единицы файлов, а не на сотни,
// и потолок держит стоимость склейки предсказуемой.
const MAX_MEETING_PARTS = 12;

/**
 * Разбор заголовка `Range` для отдачи фрагмента: `null` — заголовка нет (отдаём файл
 * целиком), `'invalid'` — диапазон вне файла (по RFC это 416, а не тихая отдача всего).
 *
 * Поддерживаются обе формы, которыми пользуется плеер: `bytes=НАЧАЛО-[КОНЕЦ]` при
 * перемотке и `bytes=-ХВОСТ` — им браузер добирает индекс в конце контейнера.
 * Составные диапазоны не поддерживаются намеренно: `multipart/byteranges` плееру
 * не нужен, а отвечать на него абы чем хуже, чем честно отдать файл целиком.
 */
export function parseByteRange(header, size) {
  if (typeof header !== 'string' || !size) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return null;

  let start;
  let end;

  if (!rawStart) {
    const suffix = Number(rawEnd);
    if (!suffix) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Number(rawEnd) : size - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'invalid';
  if (start > end || start >= size) return 'invalid';

  return { start, end: Math.min(end, size - 1) };
}

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

  /** Каталоги раздела одним объектом: и уборка, и подсчёт занятого места берут их отсюда. */
  const storagePaths = () => ({
    mediaDir: media.mediaDir,
    uploadsDir: media.uploadsDir,
    jobsDir: media.jobsDir,
  });

  // Уборка по возрасту. Своего момента «встреча разобрана» у раздела нет (черновики
  // живут в браузере), поэтому подметаем в двух дешёвых точках: при открытии раздела
  // и перед новой загрузкой. Обход десятков файлов стоит доли миллисекунды.
  const sweepStorage = () => {
    try {
      return sweepMediaStorage(storagePaths());
    } catch (err) {
      fastify.log.warn({ err }, 'media: уборка хранилища не удалась');
      return null;
    }
  };

  // Проверка окружения (ffmpeg/venv/whisper) плюс занятое записями место: сколько их
  // лежит и сколько они живут, человек иначе не узнает никак.
  fastify.get('/api/media/doctor', async (request, reply) => {
    if (gate(reply)) return reply;

    sweepStorage();
    const report = await media.doctor();

    return { ...report, storage: uploadsUsage(media.uploadsDir) };
  });

  // Загрузка видео/аудио (multipart) → сохраняем на диск → запускаем распознавание → { jobId }.
  fastify.post('/api/media/upload', async (request, reply) => {
    if (gate(reply)) return reply;
    const data = await request.file();
    if (!data) return reply.code(400).send({ error: 'no_file' });
    sweepStorage();
    try {
      // Запись ложится ПО СОДЕРЖИМОМУ: повторная загрузка того же файла (обычное дело
      // при переразборе) переиспользует уже лежащий и не плодит вторую копию на
      // сотни мегабайт. Обрезанную загрузку `storeUpload` не оставляет на диске:
      // multipart при упоре в лимит рвёт поток молча, и огрызок распознался бы как
      // короткая встреча — со стороны это неотличимо от «кокпит потерял половину».
      const stored = await storeUpload({
        dir: media.uploadsDir,
        filename: data.filename,
        source: data.file,
        truncated: () => data.file.truncated,
      });
      if (stored.truncated) return reply.code(413).send({ error: 'file_too_large' });

      const { jobId } = media.ingest({ filePath: stored.filePath, settings: currentSpeechSettings() });
      return { jobId, filename: data.filename, reused: stored.reused };
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
  /**
   * Части встречи по списку job'ов: путь исходника, сдвиг сквозного времени и
   * длительность. Общая для разбора и для нарезки фрагмента — иначе кусок резался бы
   * по одной шкале времени, а таймкод в описании считался бы по другой.
   *
   * Путь исходника берётся из СВОЕГО job'а по его id: принимать его от клиента здесь
   * нельзя, это ручка, которая читает и режет файлы сервера.
   *
   * @returns {{parts:Array, segments:Array}|{error:string, status:number}}
   */
  function collectMeetingParts(ids) {
    const segments = [];
    const parts = [];
    let offset = 0;

    for (const raw of ids) {
      const job = media.status(String(raw));
      if (!job) return { error: 'not_found', status: 404 };
      if (job.status !== 'done') {
        return { error: 'not_ready', status: 409, message: 'Расшифровка ещё не готова.' };
      }

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

    return { parts, segments };
  }

  /** Список частей из тела запроса: те же правила у разбора и у фрагмента. */
  function meetingIds(body = {}) {
    const { jobId, jobIds } = body;
    return Array.isArray(jobIds) && jobIds.length ? jobIds : (jobId ? [jobId] : []);
  }

  fastify.post('/api/media/plan-tasks', async (request, reply) => {
    if (gate(reply)) return reply;
    const { hint } = request.body || {};
    // Встреча законно лежит в НЕСКОЛЬКИХ файлах: инструменты записи режут длинный
    // созвон на части (живой случай — 17:04 и 1:18 подряд, разрыв девять секунд).
    // Разбирать их по отдельности значит терять поводы, начатые в одной части и
    // договорённые в другой, поэтому части склеиваются до обращения к модели.
    const ids = meetingIds(request.body || {});
    if (!ids.length) return reply.code(400).send({ error: 'bad_input', message: 'jobId обязателен' });
    if (ids.length > MAX_MEETING_PARTS) {
      return reply.code(400).send({ error: 'too_many_parts', message: `Частей не больше ${MAX_MEETING_PARTS}.` });
    }

    // Таймкоды сквозные: у каждой части своё нулевое время, и без сдвига «04:31»
    // второй части указывало бы на начало первой — проверить формулировку нечем.
    let collected;
    try { collected = collectMeetingParts(ids); } catch (err) { return fail(reply, err); }
    if (collected.error) {
      return reply.code(collected.status).send({ error: collected.error, message: collected.message });
    }
    const { parts, segments } = collected;
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
      // `at` едет отдельно от кадра: фрагмент режется вокруг той же секунды, а кадра
      // может не быть (отказ ffmpeg на конкретном месте) — тогда куску записи неоткуда
      // было бы узнать своё место.
      return {
        ...result,
        tasks: result.tasks.map((task, i) => ({
          ...task,
          at: frameSecond(task, segments),
          frame: frames[i],
        })),
      };
    }
    // Машинный код отдаём как есть, фразу собирает клиент: у «модель не выбрана» и
    // «модель ответила не по контракту» разные выходы для человека, и подменять их
    // общим «не удалось» — значит прятать от него, что делать дальше.
    const status = result.error === 'no_model' ? 409 : 502;
    return reply.code(status).send({ error: result.error });
  });

  // Фрагмент записи вокруг места задачи: превью в разделе и вложение к задаче.
  //
  // Режем ЛЕНИВО, по запросу на конкретную задачу, а не сразу для всего плана: у
  // разбора бывает полтора десятка поводов, каждый кусок стоит секунды ffmpeg, а
  // человек ставит не все задачи. Имя каталога считается от самих частей встречи,
  // поэтому повторный просмотр того же места попадает в готовый файл.
  fastify.post('/api/media/clip', async (request, reply) => {
    if (gate(reply)) return reply;

    const body = request.body || {};
    const ids = meetingIds(body);
    if (!ids.length) return reply.code(400).send({ error: 'bad_input', message: 'jobId обязателен' });
    if (ids.length > MAX_MEETING_PARTS) {
      return reply.code(400).send({ error: 'too_many_parts', message: `Частей не больше ${MAX_MEETING_PARTS}.` });
    }

    const at = Number(body.at);
    if (!Number.isFinite(at) || at < 0) {
      return reply.code(400).send({ error: 'bad_input', message: 'at обязателен' });
    }

    let collected;
    try { collected = collectMeetingParts(ids); } catch (err) { return fail(reply, err); }
    if (collected.error) {
      return reply.code(collected.status).send({ error: collected.error, message: collected.message });
    }

    try { sweepMeetingClips(media.clipsRoot); } catch { /* уборка не мешает нарезке */ }

    const clip = await buildMeetingClip({
      at,
      parts: collected.parts,
      run: meetingClipRun(ids),
      window: clipWindow(body.window),
      cut: (options) => media.meetingClip(options),
      log: fastify.log,
    });

    // Пустой ответ вместо ошибки: запись без видеодорожки и отказ ffmpeg для раздела
    // одинаковы — задача уже разобрана, и терять её из-за куска записи нельзя.
    if (!clip) return reply.code(200).send({ clip: null });
    return { clip };
  });

  // Байты фрагмента для плеера. Range обязателен: без него браузер не даёт перемотку
  // внутри куска, а Safari вовсе не начинает воспроизведение.
  fastify.get('/api/media/clip/:run/:file', async (request, reply) => {
    if (gate(reply)) return reply;

    const full = meetingClipPath(media.clipsRoot, `${request.params.run}/${request.params.file}`);
    if (!full) return reply.code(404).send({ error: 'not_found' });

    const size = fs.statSync(full).size;
    const range = parseByteRange(request.headers.range, size);

    reply
      .header('Content-Type', 'video/mp4')
      .header('Accept-Ranges', 'bytes')
      .header('Cache-Control', 'no-store');

    if (range === 'invalid') {
      return reply.code(416).header('Content-Range', `bytes */${size}`).send();
    }
    if (range) {
      return reply
        .code(206)
        .header('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
        .header('Content-Length', range.end - range.start + 1)
        .send(fs.createReadStream(full, { start: range.start, end: range.end }));
    }
    return reply.header('Content-Length', size).send(fs.createReadStream(full));
  });

  // Чужим модулям фрагмент отдаётся ИМЕНЕМ, как и кадр: гейт плагина и корень каталога
  // живут здесь, а не расползаются по модулю B24.
  fastify.decorate('mediaClipPath', (name) => (
    fastify.pluginEnabled('video') ? meetingClipPath(media.clipsRoot, name) : null
  ));

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

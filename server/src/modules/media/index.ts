// Модуль media — серверная часть плагина «Видео → задачи»: распознавание речи,
// кадры, статусы job'ов. Диктовка чата сюда НЕ входит — выключение плагина её не трогает.
//
// Статус разбора уезжает в браузер ПРОЕКЦИЕЙ: сам job хранит путь исходника, рабочий
// каталог, настройки распознавания и имена промежуточных файлов — разделу они не нужны,
// а публиковать пути машины в окно браузера незачем.
import fp from 'fastify-plugin';
import { objectOrEmpty } from '../../../../shared/lib/objects.ts';

import { parseByteRange } from '../../lib/httpRange.ts';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { MediaClip, MediaFrame, MediaJob } from '../../../../shared/media/mediaContracts.ts';
import '@fastify/multipart';

import { runMeetingPlan } from '../../lib/media/meetingPlan.ts';
import {
  buildMeetingFrames,
  frameSecond,
  meetingFramePath,
  sweepMeetingFrames,
} from '../../lib/media/meetingFrames.ts';
import {
  MEETING_CLIP_LIMITS,
  buildMeetingClip,
  clipWindow,
  meetingClipPath,
  meetingClipRun,
  sweepMeetingClips,
} from '../../lib/media/meetingClips.ts';
import {
  storeUpload,
  sweepMediaStorage,
  uploadsUsage,
} from '../../lib/media/storage.ts';

// Потолок частей одной встречи. Не про безопасность (каждый id всё равно проверяется
// как свой job), а про здравый смысл: запись режут на единицы файлов, а не на сотни,
// и потолок держит стоимость склейки предсказуемой.
const MAX_MEETING_PARTS = 12;

// Разбор, кадры и фрагменты живут в lib/media на JavaScript. Модуль объявляет ровно ту
// форму, которую от них ждёт: вывод типов из соседнего JS проверенным знанием не был бы.
interface MeetingPlanTask {
  title: string;
  description: string;
  confidence: number;
  reason: string;
  segments: number[];
}

type MeetingPlanResult =
  | { ok: false; error: string }
  | {
    ok: true;
    model: string;
    effort: string | null;
    truncated: boolean;
    count: number;
    tasks: MeetingPlanTask[];
  };

const planMeeting = runMeetingPlan as unknown as (
  options: Record<string, unknown>,
) => Promise<MeetingPlanResult>;
const framesForMeeting = buildMeetingFrames as unknown as (
  options: Record<string, unknown>,
) => Promise<(MediaFrame | null)[]>;
const clipForMeeting = buildMeetingClip as unknown as (
  options: Record<string, unknown>,
) => Promise<MediaClip | null>;
const secondOfTask = frameSecond as unknown as (
  task: MeetingPlanTask,
  segments: unknown[],
) => number | null;

// Джоб распознавания на диске: раздел видит из него только ход и результат.
interface MediaJobRecord {
  status?: unknown;
  filePath?: string;
  progress?: unknown;
  result?: {
    duration?: unknown;
    transcript?: { segments?: unknown[] } | null;
  } | null;
  error?: unknown;
}

export interface MediaAdapterLike {
  mediaDir: string;
  uploadsDir: string;
  jobsDir: string;
  framesRoot: string;
  clipsRoot: string;
  doctor(): Promise<Record<string, unknown>>;
  ingest(options: Record<string, unknown>): { jobId: string };
  status(jobId: string): MediaJobRecord | null;
  extractFrames(options: { filePath: string; seconds: unknown[]; name?: unknown }): Promise<unknown>;
  meetingFrames(options: Record<string, unknown>): Promise<unknown>;
  meetingClip(options: Record<string, unknown>): Promise<unknown>;
}

export interface MediaModuleOptions {
  media: MediaAdapterLike;
  speechSettings?: unknown;
  config?: Record<string, unknown>;
  meetingModelRef?: unknown;
  providerSettings?: unknown;
  resolveMeetingTarget?: unknown;
}

interface MediaJobRoute {
  Params: {
    jobId: string;
  };
}

interface MediaFileRoute {
  Params: {
    run: string;
    file: string;
  };
}

interface MeetingPart {
  filePath: string | undefined;
  offset: number;
  duration: number;
}

interface MeetingSegment {
  start: number;
  end: number;
  text?: unknown;
}

interface CollectedFailure {
  error: string;
  status: number;
  message?: string;
}

interface CollectedMeeting {
  parts: MeetingPart[];
  segments: MeetingSegment[];
}

type CollectedParts = CollectedMeeting | CollectedFailure;

function collectFailed(value: CollectedParts): value is CollectedFailure {
  return 'error' in value;
}

function numberOr(value: unknown, fallback: number | null): number | null {
  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Проекция джоба для браузера: ход, результат и причина отказа. Пути исходника и
 * рабочего каталога остаются на сервере — разделу они не нужны ни для чего.
 */
export function toMediaJob(job: MediaJobRecord): MediaJob {
  const status = job.status === 'done' || job.status === 'failed' ? job.status : 'running';
  const progress = objectOrEmpty(job.progress);
  const done = numberOr(progress.done, null);
  const total = numberOr(progress.total, null);
  const result = job.result ? objectOrEmpty(job.result) : null;
  const transcript = result ? objectOrEmpty(result.transcript) : null;
  const segments = Array.isArray(transcript?.segments) ? transcript.segments : null;

  return {
    status,
    progress: done === null || total === null ? null : { done, total },
    result: result && segments
      ? {
        duration: numberOr(result.duration, 0) ?? 0,
        transcript: {
          segments: segments.map((raw) => {
            const segment = objectOrEmpty(raw);
            const start = numberOr(segment.start, 0) ?? 0;

            return {
              start,
              end: numberOr(segment.end, start) ?? start,
              text: typeof segment.text === 'string' ? segment.text : '',
            };
          }),
        },
      }
      : null,
    error: typeof job.error === 'string' ? job.error : null,
  };
}

/**
 * Разбор заголовка `Range` для отдачи фрагмента: `null` — заголовка нет (отдаём файл
 * целиком), `'invalid'` — диапазон вне файла (по RFC это 416, а не тихая отдача всего).
 *
 * Поддерживаются обе формы, которыми пользуется плеер: `bytes=НАЧАЛО-[КОНЕЦ]` при
 * перемотке и `bytes=-ХВОСТ` — им браузер добирает индекс в конце контейнера.
 * Составные диапазоны не поддерживаются намеренно: `multipart/byteranges` плееру
 * не нужен, а отвечать на него абы чем хуже, чем честно отдать файл целиком.
 */
export { parseByteRange } from '../../lib/httpRange.ts';

async function mediaModule(fastify: FastifyInstance, opts: MediaModuleOptions): Promise<void> {
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
  const currentSpeechSettings = (): unknown => {
    const value = typeof speechSettings === 'function' ? speechSettings() : speechSettings;
    return objectOrEmpty(value).speech || value || {};
  };
  const currentMeetingModel = () => (typeof meetingModelRef === 'function'
    ? meetingModelRef()
    : meetingModelRef);
  const currentProviderSettings = (): unknown => (typeof providerSettings === 'function'
    ? providerSettings() || {}
    : providerSettings || {});
  const fail = (reply: FastifyReply, err: unknown) => reply.code(500).send({
    error: 'media_error',
    message: String(objectOrEmpty(err).message ?? ''),
  });
  // Гейт плагина «video»: выключен — раздела нет. Проверка живая (по prefs),
  // тумблер в настройках действует без рестарта.
  const gate = (reply: FastifyReply) => (fastify.pluginEnabled('video') ? null
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
  const sweepStorage = (): unknown => {
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
      // короткая встреча — со стороны это неотличимо от «GrigDesk потерял половину».
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
    const { filePath, model, lang, frames } = objectOrEmpty(request.body);
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
  fastify.get<MediaJobRoute>('/api/media/ingest/:jobId', async (request, reply) => {
    if (gate(reply)) return reply;
    try {
      const job = media.status(String(request.params.jobId));
      if (!job) return reply.code(404).send({ error: 'not_found' });
      return toMediaJob(job);
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
  function collectMeetingParts(ids: unknown[]): CollectedParts {
    const segments: MeetingSegment[] = [];
    const parts: MeetingPart[] = [];
    let offset = 0;

    for (const raw of ids) {
      const job = media.status(String(raw));
      if (!job) return { error: 'not_found', status: 404 };
      if (job.status !== 'done') {
        return { error: 'not_ready', status: 409, message: 'Расшифровка ещё не готова.' };
      }

      parts.push({ filePath: job.filePath, offset, duration: Number(job.result?.duration) });
      for (const raw of job.result?.transcript?.segments || []) {
        const segment = objectOrEmpty(raw);
        segments.push({
          ...segment,
          start: Number(segment.start || 0) + offset,
          end: Number(segment.end ?? segment.start ?? 0) + offset,
        } as MeetingSegment);
      }

      // Сдвиг берём по ДЛИТЕЛЬНОСТИ ЗАПИСИ, а не по концу последней реплики: молчание
      // в хвосте части — обычное дело, и по речи следующая часть наехала бы на неё.
      const duration = Number(job.result?.duration);
      offset += Number.isFinite(duration) && duration > 0
        ? duration
        : Number(objectOrEmpty(job.result?.transcript?.segments?.at(-1)).end || 0);
    }

    return { parts, segments };
  }

  /** Список частей из тела запроса: те же правила у разбора и у фрагмента. */
  function meetingIds(body: unknown = {}): unknown[] {
    const { jobId, jobIds } = objectOrEmpty(body);
    return Array.isArray(jobIds) && jobIds.length ? jobIds : (jobId ? [jobId] : []);
  }

  fastify.post('/api/media/plan-tasks', async (request, reply) => {
    if (gate(reply)) return reply;
    const { hint } = objectOrEmpty(request.body);
    // Встреча законно лежит в НЕСКОЛЬКИХ файлах: инструменты записи режут длинный
    // созвон на части (живой случай — 17:04 и 1:18 подряд, разрыв девять секунд).
    // Разбирать их по отдельности значит терять поводы, начатые в одной части и
    // договорённые в другой, поэтому части склеиваются до обращения к модели.
    const ids = meetingIds(request.body);
    if (!ids.length) return reply.code(400).send({ error: 'bad_input', message: 'jobId обязателен' });
    if (ids.length > MAX_MEETING_PARTS) {
      return reply.code(400).send({ error: 'too_many_parts', message: `Частей не больше ${MAX_MEETING_PARTS}.` });
    }

    // Таймкоды сквозные: у каждой части своё нулевое время, и без сдвига «04:31»
    // второй части указывало бы на начало первой — проверить формулировку нечем.
    let collected: CollectedParts;
    try { collected = collectMeetingParts(ids); } catch (err) { return fail(reply, err); }
    if (collectFailed(collected)) {
      return reply.code(collected.status).send({ error: collected.error, message: collected.message });
    }
    const { parts, segments } = collected;
    const result = await planMeeting({
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
      const frames = await framesForMeeting({
        tasks: result.tasks,
        segments,
        parts,
        run,
        extract: (options: Record<string, unknown>) => media.meetingFrames(options),
        log: fastify.log,
      });
      // `at` едет отдельно от кадра: фрагмент режется вокруг той же секунды, а кадра
      // может не быть (отказ ffmpeg на конкретном месте) — тогда куску записи неоткуда
      // было бы узнать своё место.
      return {
        ...result,
        tasks: result.tasks.map((task, i) => ({
          ...task,
          at: secondOfTask(task, segments),
          frame: frames[i] ?? null,
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

    const body = objectOrEmpty(request.body);
    const ids = meetingIds(body);
    if (!ids.length) return reply.code(400).send({ error: 'bad_input', message: 'jobId обязателен' });
    if (ids.length > MAX_MEETING_PARTS) {
      return reply.code(400).send({ error: 'too_many_parts', message: `Частей не больше ${MAX_MEETING_PARTS}.` });
    }

    const at = Number(body.at);
    if (!Number.isFinite(at) || at < 0) {
      return reply.code(400).send({ error: 'bad_input', message: 'at обязателен' });
    }

    let collected: CollectedParts;
    try { collected = collectMeetingParts(ids); } catch (err) { return fail(reply, err); }
    if (collectFailed(collected)) {
      return reply.code(collected.status).send({ error: collected.error, message: collected.message });
    }

    try { sweepMeetingClips(media.clipsRoot); } catch { /* уборка не мешает нарезке */ }

    const clip = await clipForMeeting({
      at,
      parts: collected.parts,
      run: meetingClipRun(ids),
      window: clipWindow(body.window),
      cut: (options: Record<string, unknown>) => media.meetingClip(options),
      log: fastify.log,
    });

    // Пустой ответ вместо ошибки: запись без видеодорожки и отказ ffmpeg для раздела
    // одинаковы — задача уже разобрана, и терять её из-за куска записи нельзя.
    if (!clip) return reply.code(200).send({ clip: null });
    return { clip };
  });

  // Байты фрагмента для плеера. Range обязателен: без него браузер не даёт перемотку
  // внутри куска, а Safari вовсе не начинает воспроизведение.
  fastify.get<MediaFileRoute>('/api/media/clip/:run/:file', async (request, reply) => {
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
  fastify.get<MediaFileRoute>('/api/media/frame/:run/:file', async (request, reply) => {
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
    const { filePath, seconds, name } = objectOrEmpty(request.body);
    if (!filePath || !Array.isArray(seconds)) return reply.code(400).send({ error: 'bad_input' });
    try { return await media.extractFrames({ filePath: String(filePath), seconds, name }); }
    catch (err) { return fail(reply, err); }
  });
}

export default fp(mediaModule, { name: 'module-media' });

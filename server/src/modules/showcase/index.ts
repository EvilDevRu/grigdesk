// Модуль «Презентации»: ручки раздела и выдача артефактов.
//
// Доступ: общий auth guard закрывает весь /api, а здесь добавлены ещё два условия —
// включённый плагин и СЕССИЯ человека. CLI-токен агента сюда не пускается намеренно:
// раздел запускает браузер по адресу стенда, синтезирует речь у внешнего поставщика
// и отправляет готовый файл — это решения человека, а не фоновая работа агента.
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';

import fp from 'fastify-plugin';
import type { FastifyReply } from 'fastify';
// Приём файла даёт плагин multipart; тип подключается ссылкой, потому что он
// расширяет сам запрос, а не приходит отдельным значением.
import type {} from '@fastify/multipart';

import { SHOWCASE_ID_RE } from '../../../../shared/showcaseContracts.ts';
import type { ShowcaseAction, ShowcaseTargetRef } from '../../../../shared/showcaseContracts.ts';
import { mediaTypeOf } from '../../lib/showcase/artifacts.ts';
import { PROFILE_RE } from '../../lib/profiles.ts';
import { toPublicJob } from '../../lib/showcase/jobs.ts';
import type { ShowcaseService } from '../../lib/showcase/service.ts';

declare module 'fastify' {
  interface FastifyInstance {
    pluginEnabled(id: string): boolean;
  }

  interface FastifyRequest {
    authKind?: 'session' | 'internal' | 'cli' | null;
  }
}

interface ShowcaseModuleOptions {
  service: ShowcaseService;
}

interface ProjectRoute {
  Params: {
    id: string;
  };
}

interface CreateRoute {
  Body: {
    kind?: unknown;
    id?: unknown;
    profile?: unknown;
    title?: unknown;
  };
}

interface RenameRoute extends ProjectRoute {
  Body: {
    title?: unknown;
    expectedRevision?: unknown;
  };
}

interface VoiceInstallRoute {
  Body: {
    voiceId?: unknown;
  };
}

interface SceneRoute extends ProjectRoute {
  Params: {
    id: string;
    sceneId: string;
  };
  Body: Record<string, unknown>;
}

interface ArtifactRoute {
  Params: {
    id: string;
    artifactId: string;
  };
}

interface TargetQuery {
  Querystring: {
    kind?: unknown;
    id?: unknown;
    profile?: unknown;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Объявленный отказ службы несёт свой код, статус и текст для человека. Исключение
 * без кода — чужое: оно получает общий ответ, и его текст наружу не уходит, потому
 * что в нём бывает путь файла или содержимое настроек.
 */
function sendError(reply: FastifyReply, error: unknown) {
  const source = isRecord(error) ? error : {};
  const code = typeof source.code === 'string' && source.code ? source.code : '';
  const message = typeof source.message === 'string' ? source.message : '';

  if (!code) {
    return reply.code(500).send({ error: 'showcase_error' });
  }

  return reply.code(Number(source.status) || 500).send({ error: code, message });
}

/**
 * Ссылка на цель приходит от клиента, поэтому проверяется по форме до любых
 * обращений к файлам: вид цели закрыт перечислением, а её идентификатор —
 * номером стенда или именем профиля, но не произвольной строкой из тела запроса.
 */
function readTargetRef(kind: unknown, id: unknown): ShowcaseTargetRef | null {
  const targetKind = String(kind ?? '');
  const targetId = String(id ?? '');

  if (targetKind !== 'project' && targetKind !== 'sandbox' && targetKind !== 'task') {
    return null;
  }

  if (targetKind === 'project') {
    return PROFILE_RE.test(targetId) ? { kind: targetKind, id: targetId } : null;
  }

  return /^[1-9][0-9]{0,18}$/.test(targetId) ? { kind: targetKind, id: targetId } : null;
}

const ACTION_KINDS = new Set(['goto', 'click', 'hover', 'highlight', 'waitVisible', 'scroll', 'wait']);

/**
 * Действия сцены приходят от клиента и разбираются по видам: неизвестный вид не
 * «пропускается на всякий случай», а закрывает всю правку. Селекторов здесь нет —
 * цель называется идентификатором элемента из карты профиля.
 */
function readActions(value: unknown): ShowcaseAction[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const actions: ShowcaseAction[] = [];

  for (const item of value) {
    if (!isRecord(item) || typeof item.kind !== 'string' || !ACTION_KINDS.has(item.kind)) {
      return null;
    }

    if (item.kind === 'wait') {
      const ms = Number(item.ms);

      if (!Number.isSafeInteger(ms) || ms < 0) {
        return null;
      }

      actions.push({ kind: 'wait', ms });

      continue;
    }

    if (item.kind === 'scroll') {
      const delta = Number(item.delta);

      if (!Number.isFinite(delta)) {
        return null;
      }

      actions.push({
        kind: 'scroll',
        targetId: typeof item.targetId === 'string' ? item.targetId : null,
        delta,
      });

      continue;
    }

    if (typeof item.targetId !== 'string' || !item.targetId) {
      return null;
    }

    actions.push({
      kind: item.kind as 'goto' | 'click' | 'hover' | 'highlight' | 'waitVisible',
      targetId: item.targetId,
    });
  }

  return actions;
}

function readText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export default fp<ShowcaseModuleOptions>(async function showcaseModule(fastify, { service }) {
  fastify.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/showcase')) {
      return;
    }

    if (!fastify.pluginEnabled('showcase')) {
      return reply.code(403).send({ error: 'plugin_disabled' });
    }

    if (request.authKind !== 'session') {
      return reply.code(403).send({ error: 'session_required' });
    }

    // Идентификатор из пути проверяется здесь, а не в каждой ручке: он попадает в
    // имена каталогов раздела, и забыть проверку в новой ручке нельзя. Порядок
    // важен — сначала доступ, потом форма запроса.
    const id = (request.params as { id?: unknown } | null)?.id;

    if (typeof id === 'string' && !SHOWCASE_ID_RE.test(id)) {
      return reply.code(400).send({ error: 'bad_id' });
    }
  });

  fastify.get('/api/showcase', async (request, reply) => {
    try {
      return await service.overview();
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.get<TargetQuery>('/api/showcase/target', async (request, reply) => {
    const ref = readTargetRef(request.query.kind, request.query.id);
    const profile = String(request.query.profile ?? '');

    if (!ref) {
      return reply.code(400).send({ error: 'bad_target' });
    }

    if (!PROFILE_RE.test(profile)) {
      return reply.code(400).send({ error: 'bad_profile' });
    }

    try {
      return await service.targets.resolve(ref, profile);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.get<TargetQuery>('/api/showcase/doctor', async (request, reply) => {
    const ref = readTargetRef(request.query.kind, request.query.id);
    const profile = String(request.query.profile ?? '');

    try {
      return await service.doctor(
        ref ?? undefined,
        PROFILE_RE.test(profile) ? profile : undefined,
      );
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.post<CreateRoute>('/api/showcase', async (request, reply) => {
    const ref = readTargetRef(request.body?.kind, request.body?.id);
    const profile = String(request.body?.profile ?? '');

    if (!ref) {
      return reply.code(400).send({ error: 'bad_target' });
    }

    if (!PROFILE_RE.test(profile)) {
      return reply.code(400).send({ error: 'bad_profile' });
    }

    try {
      const project = await service.createProject({
        ref,
        profile,
        title: typeof request.body?.title === 'string' ? request.body.title : undefined,
      });

      return reply.code(201).send(project);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.get<ProjectRoute>('/api/showcase/:id', async (request, reply) => {

    try {
      return await service.readProject(request.params.id);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // Правка приходит со своей ожидаемой редакцией: конфликт отвечает 409, и чужая
  // правка не теряется. Клиент после конфликта перечитывает запись, а не досылает
  // своё состояние поверх.
  fastify.put<RenameRoute>('/api/showcase/:id', async (request, reply) => {
    const expectedRevision = Number(request.body?.expectedRevision);
    const title = typeof request.body?.title === 'string' ? request.body.title : '';


    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      return reply.code(400).send({ error: 'bad_revision' });
    }

    try {
      return await service.renameProject(request.params.id, expectedRevision, title);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.delete<ProjectRoute>('/api/showcase/:id', async (request, reply) => {

    try {
      await service.deleteProject(request.params.id);

      return { ok: true };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.post<SceneRoute>('/api/showcase/:id/scenes', async (request, reply) => {
    const expectedRevision = Number(request.body?.expectedRevision);
    const actions = readActions(request.body?.actions ?? []);
    const screenId = readText(request.body?.screenId);


    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      return reply.code(400).send({ error: 'bad_revision' });
    }

    if (!screenId || !actions) {
      return reply.code(400).send({ error: 'bad_scene' });
    }

    try {
      return await service.addScene(request.params.id, expectedRevision, {
        title: readText(request.body?.title),
        screenId,
        narration: readText(request.body?.narration),
        caption: readText(request.body?.caption),
        subtitleText: readText(request.body?.subtitleText),
        startState: request.body?.startState === undefined
          ? null
          : readText(request.body?.startState) || null,
        readyCondition: request.body?.readyCondition === undefined
          ? null
          : readText(request.body?.readyCondition) || null,
        actions,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.put<SceneRoute>('/api/showcase/:id/scenes/:sceneId', async (request, reply) => {
    const expectedRevision = Number(request.body?.expectedRevision);
    const actions = request.body?.actions === undefined ? undefined : readActions(request.body.actions);


    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      return reply.code(400).send({ error: 'bad_revision' });
    }

    if (actions === null) {
      return reply.code(400).send({ error: 'bad_scene' });
    }

    try {
      return await service.updateScene(
        request.params.id,
        expectedRevision,
        request.params.sceneId,
        {
          ...(request.body?.title === undefined ? {} : { title: readText(request.body.title) }),
          ...(request.body?.screenId === undefined ? {} : { screenId: readText(request.body.screenId) }),
          ...(request.body?.narration === undefined ? {} : { narration: readText(request.body.narration) }),
          ...(request.body?.caption === undefined ? {} : { caption: readText(request.body.caption) }),
          ...(request.body?.subtitleText === undefined
            ? {}
            : { subtitleText: readText(request.body.subtitleText) }),
          ...(actions === undefined ? {} : { actions }),
        },
      );
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.delete<SceneRoute>('/api/showcase/:id/scenes/:sceneId', async (request, reply) => {
    const expectedRevision = Number(request.body?.expectedRevision);

    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      return reply.code(400).send({ error: 'bad_revision' });
    }

    try {
      return await service.deleteScene(
        request.params.id,
        expectedRevision,
        request.params.sceneId,
      );
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // Порядок приходит полным списком: частичный пришлось бы домысливать, а домысел
  // здесь означает ролик, собранный не в том порядке.
  fastify.put<SceneRoute>('/api/showcase/:id/order', async (request, reply) => {
    const expectedRevision = Number(request.body?.expectedRevision);
    const order = request.body?.order;

    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      return reply.code(400).send({ error: 'bad_revision' });
    }

    if (!Array.isArray(order) || order.some((item) => typeof item !== 'string')) {
      return reply.code(400).send({ error: 'bad_order' });
    }

    try {
      return await service.reorder(request.params.id, expectedRevision, order as string[]);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /**
   * Загрузка готового звука сцены. Файл принимается во временный каталог и только
   * потом уходит в службу: она приводит его к общему профилю, проверяет длительность
   * и лишь после этого делает артефактом.
   *
   * Оборванная загрузка не должна стать «короткой сценой», поэтому обрезанный поток
   * отвергается явно: multipart рвёт его на лимите молча.
   */
  fastify.post<SceneRoute>('/api/showcase/:id/scenes/:sceneId/audio', async (request, reply) => {

    const data = await request.file();

    if (!data) {
      return reply.code(400).send({ error: 'no_file' });
    }

    const revisionField = data.fields?.expectedRevision;
    const revisionValue = Array.isArray(revisionField) ? revisionField[0] : revisionField;
    const expectedRevision = Number(
      revisionValue && 'value' in revisionValue ? revisionValue.value : NaN,
    );

    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      return reply.code(400).send({ error: 'bad_revision' });
    }

    const directory = await mkdtemp(path.join(os.tmpdir(), 'showcase-upload-'));
    const file = path.join(directory, 'audio.upload');

    try {
      await pipeline(data.file, createWriteStream(file));

      if (data.file.truncated) {
        return reply.code(413).send({ error: 'file_too_large' });
      }

      return await service.importSceneAudio(
        request.params.id,
        expectedRevision,
        request.params.sceneId,
        file,
      );
    } catch (error) {
      return sendError(reply, error);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  // Текст задачи приходит от человека и остаётся ДАННЫМИ: он попадает в промпт
  // отделённым блоком и не может задать ни адрес, ни селектор, ни команду.
  fastify.post<SceneRoute>('/api/showcase/:id/brief', async (request, reply) => {

    try {
      return await service.generateBrief(request.params.id, readText(request.body?.taskText));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.post<SceneRoute>('/api/showcase/:id/script', async (request, reply) => {

    try {
      return await service.generateScript(request.params.id, readText(request.body?.taskText));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.get('/api/showcase/delivery/channels', async (request, reply) => {
    try {
      return service.deliveryChannels();
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // План отправки готовится ДО подтверждения: человек видит канал, получателя и
  // точные файлы, а решение потом проверяется по отпечатку этого плана.
  fastify.post<SceneRoute>('/api/showcase/:id/delivery/plan', async (request, reply) => {
    const channel = readText(request.body?.channel);


    if (channel !== 'b24' && channel !== 'telegram') {
      return reply.code(400).send({ error: 'bad_channel' });
    }

    try {
      return await service.planDelivery(request.params.id, {
        channel,
        recipient: readText(request.body?.recipient),
        recipientLabel: readText(request.body?.recipientLabel),
        includeSubtitles: request.body?.includeSubtitles === true,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.post<SceneRoute>('/api/showcase/:id/delivery', async (request, reply) => {
    const channel = readText(request.body?.channel);
    const decisionFingerprint = readText(request.body?.decisionFingerprint);


    if (channel !== 'b24' && channel !== 'telegram') {
      return reply.code(400).send({ error: 'bad_channel' });
    }

    if (!/^[a-f0-9]{32}$/.test(decisionFingerprint)) {
      return reply.code(400).send({ error: 'bad_decision' });
    }

    try {
      return await service.deliver(request.params.id, {
        channel,
        recipient: readText(request.body?.recipient),
        recipientLabel: readText(request.body?.recipientLabel),
        includeSubtitles: request.body?.includeSubtitles === true,
        decisionFingerprint,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.get<ProjectRoute>('/api/showcase/:id/seed', async (request, reply) => {

    try {
      return await service.seedStatus(request.params.id);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // Подготовка данных подтверждается ОТПЕЧАТКОМ рецепта: человек соглашается на
  // конкретный скрипт на конкретном стенде, и подтверждение «вообще» тут не годится.
  fastify.post<SceneRoute>('/api/showcase/:id/seed', async (request, reply) => {
    const recipeFingerprint = readText(request.body?.recipeFingerprint);


    if (!/^[a-f0-9]{32}$/.test(recipeFingerprint)) {
      return reply.code(400).send({ error: 'bad_decision' });
    }

    try {
      return await service.prepareData(request.params.id, recipeFingerprint);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // Отметка «данные обновлены» — решение человека о том, что снаружи изменилось.
  // Раздел не обещает заметить это сам и не притворяется, что заметил.
  fastify.post<ProjectRoute>('/api/showcase/:id/data-updated', async (request, reply) => {

    try {
      const project = await service.readProject(request.params.id);

      return { dataRevision: await service.markDataUpdated(project.ref) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.get('/api/showcase/voices', async (request, reply) => {
    try {
      return await service.voiceCatalog();
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // Установка локального голоса: движок и модель скачиваются один раз по решению
  // человека. Раздел не начинает её сам — ни при первом открытии, ни перед первой
  // озвучкой.
  fastify.post<VoiceInstallRoute>('/api/showcase/voices/install', async (request, reply) => {
    const voiceId = typeof request.body?.voiceId === 'string' ? request.body.voiceId : '';

    if (!voiceId) {
      return reply.code(400).send({ error: 'bad_voice' });
    }

    try {
      return reply.code(202).send(await service.installVoice(voiceId));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.post('/api/showcase/voices/install/cancel', async (request, reply) => {
    try {
      return await service.cancelVoiceInstall();
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.post<ProjectRoute>('/api/showcase/:id/voice', async (request, reply) => {

    try {
      return reply.code(202).send(await service.synthesizeScenes(request.params.id));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.post<ProjectRoute>('/api/showcase/:id/record', async (request, reply) => {

    try {
      return reply.code(202).send(await service.startRecording(request.params.id));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.post<ProjectRoute>('/api/showcase/:id/assemble', async (request, reply) => {

    try {
      return reply.code(202).send(await service.assemble(request.params.id));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /**
   * Отдача артефакта. Range нужен плееру: без него браузер тянет весь ролик, чтобы
   * показать одну секунду. Диапазон разбирается сервером, а имя файла в путь не
   * попадает — он собран из идентификатора и вида артефакта.
   */
  fastify.get<ArtifactRoute>('/api/showcase/:id/artifacts/:artifactId', async (request, reply) => {

    try {
      const { file } = await service.artifactPath(request.params.id, request.params.artifactId);
      const info = await stat(file);
      const mediaType = mediaTypeOf(file);
      const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range ?? ''));

      if (!range) {
        return reply
          .header('content-type', mediaType)
          .header('content-length', String(info.size))
          .header('accept-ranges', 'bytes')
          .send(createReadStream(file));
      }

      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;

      if (!Number.isFinite(start) || start > end || start >= info.size) {
        return reply
          .code(416)
          .header('content-range', `bytes */${info.size}`)
          .send({ error: 'bad_range' });
      }

      return reply
        .code(206)
        .header('content-type', mediaType)
        .header('content-length', String(end - start + 1))
        .header('content-range', `bytes ${start}-${end}/${info.size}`)
        .header('accept-ranges', 'bytes')
        .send(createReadStream(file, { start, end }));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.get<ProjectRoute>('/api/showcase/jobs/:id', async (request, reply) => {
    try {
      return toPublicJob(service.jobs.read(request.params.id));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.post<ProjectRoute>('/api/showcase/jobs/:id/cancel', async (request, reply) => {
    try {
      return await service.cancelJob(request.params.id);
    } catch (error) {
      return sendError(reply, error);
    }
  });
});

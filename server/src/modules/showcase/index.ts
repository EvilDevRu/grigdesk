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

import { textOr } from '../../../../shared/lib/text.ts';
import { isRecord } from '../../../../shared/lib/objects.ts';

import {
  SHOWCASE_BUILD_REQUEST_ID_RE,
  SHOWCASE_ID_RE,
  SHOWCASE_PACES,
  parseShowcaseDirection,
  parseShowcaseStorySource,
} from '../../../../shared/plugins/showcase/showcaseContracts.ts';
import { SHOWCASE_SYNC_CUE_KINDS } from '../../../../shared/plugins/showcase/showcaseSync.ts';
import { SHOWCASE_MANIFEST_ID_RE } from '../../../../shared/plugins/showcase/showcaseTimeline.ts';
import type {
  ShowcaseAction,
  ShowcasePace,
  ShowcaseStorySource,
  ShowcaseTargetRef,
} from '../../../../shared/plugins/showcase/showcaseContracts.ts';
import { mediaTypeOf } from '../../lib/showcase/artifacts.ts';
import { PROFILE_RE } from '../../lib/profiles.ts';
import { toPublicJob } from '../../lib/showcase/jobs.ts';
import type { ShowcaseService } from '../../lib/showcase/service.ts';
import type { SceneSyncCueInput } from '../../lib/showcase/sceneOps.ts';
import type { PronunciationOverrideInput } from '../../lib/showcase/voice/preparation.ts';

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
    title?: unknown;
  };
}

interface RenameRoute extends ProjectRoute {
  Body: {
    title?: unknown;
    expectedRevision?: unknown;
  };
}

interface SourceRoute extends ProjectRoute {
  Body: {
    expectedRevision?: unknown;
    source?: unknown;
  };
}

interface SetupRoute {
  Params: { id: string };
}

interface VoiceInstallRoute {
  Body: {
    voiceId?: unknown;
  };
}

interface VoicePreviewRoute {
  Querystring: {
    voiceRef?: unknown;
  };
}

interface VoiceNarrationPreviewRoute {
  Body: {
    voiceRef?: unknown;
    narration?: unknown;
    direction?: unknown;
    pronunciationOverrides?: unknown;
  };
}

interface VoiceDictionaryRoute {
  Body: {
    text?: unknown;
  };
}

interface VoiceChoiceRoute extends ProjectRoute {
  Body: {
    expectedRevision?: unknown;
    voiceRef?: unknown;
    pace?: unknown;
  };
}

const PACES = new Set<string>(SHOWCASE_PACES);

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

interface ManifestRoute {
  Params: {
    id: string;
    manifestId: string;
  };
}

interface BuildStartRoute extends ProjectRoute {
  Body: {
    revision?: unknown;
    requestId?: unknown;
  };
}

interface TargetQuery {
  Querystring: {
    kind?: unknown;
    id?: unknown;
  };
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

/** Новая форма создаёт ролик только из опубликованной цели, а не абстрактной задачи. */
function readCreateTargetRef(kind: unknown, id: unknown): ShowcaseTargetRef | null {
  const ref = readTargetRef(kind, id);

  return ref?.kind === 'task' ? null : ref;
}

const ACTION_KINDS = new Set(['goto', 'click', 'hover', 'highlight', 'waitVisible', 'scroll', 'wait']);
const SYNC_CUE_KINDS = new Set<string>(SHOWCASE_SYNC_CUE_KINDS);

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

/** Ручной cue не принимает origin, хеш, selector или придуманный новый ID. */
function readSyncCues(value: unknown): SceneSyncCueInput[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const cues: SceneSyncCueInput[] = [];

  for (const item of value) {
    if (!isRecord(item)) {
      return null;
    }

    const keys = Object.keys(item);
    const required = ['actionIndex', 'from', 'kind', 'to'];
    const allowed = new Set([...required, 'id', 'manual']);

    if (
      !required.every((key) => Object.prototype.hasOwnProperty.call(item, key))
      || keys.some((key) => !allowed.has(key))
    ) {
      return null;
    }

    if (
      !Number.isSafeInteger(item.actionIndex)
      || Number(item.actionIndex) < 0
      || !Number.isSafeInteger(item.from)
      || Number(item.from) < 0
      || !Number.isSafeInteger(item.to)
      || Number(item.to) < 0
      || typeof item.kind !== 'string'
      || !SYNC_CUE_KINDS.has(item.kind)
    ) {
      return null;
    }

    if (item.id !== undefined && item.id !== null && (typeof item.id !== 'string' || !item.id)) {
      return null;
    }

    if (item.manual !== undefined && item.manual !== true) {
      return null;
    }

    cues.push({
      ...(typeof item.id === 'string' ? { id: item.id } : {}),
      actionIndex: Number(item.actionIndex),
      from: Number(item.from),
      to: Number(item.to),
      kind: item.kind as SceneSyncCueInput['kind'],
      ...(item.manual === true ? { manual: true as const } : {}),
    });
  }

  return cues;
}

/** Клиент не задаёт textHash: текущую редакцию реплики подписывает сервер. */
function readPronunciationOverrides(value: unknown): PronunciationOverrideInput[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const replacements: PronunciationOverrideInput[] = [];

  for (const item of value) {
    if (!isRecord(item)) {
      return null;
    }

    const keys = Object.keys(item);
    const required = ['from', 'to', 'pronunciation', 'voiceRef'];
    const allowed = new Set([...required, 'refresh']);

    if (
      keys.some((key) => !allowed.has(key))
      || !required.every((key) => Object.prototype.hasOwnProperty.call(item, key))
      || !Number.isSafeInteger(item.from)
      || !Number.isSafeInteger(item.to)
      || typeof item.pronunciation !== 'string'
      || typeof item.voiceRef !== 'string'
      || item.refresh !== undefined && item.refresh !== true
    ) {
      return null;
    }

    replacements.push({
      from: Number(item.from),
      to: Number(item.to),
      pronunciation: item.pronunciation,
      voiceRef: item.voiceRef,
      ...(item.refresh === true ? { refresh: true as const } : {}),
    });
  }

  return replacements;
}

/**
 * Выбор «О чём ролик» из тела запроса: null — умолчание цели, иначе строгая форма
 * контракта. undefined значит «не по форме»: имена и коммиты проверит служба.
 */
function readStorySource(value: unknown): ShowcaseStorySource | null | undefined {
  if (value === null) {
    return null;
  }

  try {
    return parseShowcaseStorySource(value);
  } catch {
    return undefined;
  }
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

    if (!ref) {
      return reply.code(400).send({ error: 'bad_target' });
    }

    try {
      return await service.targets.resolveSelected(ref);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.get<TargetQuery>('/api/showcase/doctor', async (request, reply) => {
    const ref = readTargetRef(request.query.kind, request.query.id);

    try {
      return await service.doctor(ref ?? undefined);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.post<CreateRoute>('/api/showcase', async (request, reply) => {
    const ref = readCreateTargetRef(request.body?.kind, request.body?.id);

    if (!ref) {
      return reply.code(400).send({ error: 'bad_target' });
    }

    try {
      const project = await service.createProject({
        ref,
        title: typeof request.body?.title === 'string' ? request.body.title : undefined,
      });

      return reply.code(201).send(project);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.get<ProjectRoute>('/api/showcase/:id', async (request, reply) => {

    try {
      return await service.openProject(request.params.id);
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
    const screenId = textOr(request.body?.screenId);

    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      return reply.code(400).send({ error: 'bad_revision' });
    }

    if (!screenId || !actions) {
      return reply.code(400).send({ error: 'bad_scene' });
    }

    try {
      return await service.addScene(request.params.id, expectedRevision, {
        title: textOr(request.body?.title),
        screenId,
        narration: textOr(request.body?.narration),
        caption: textOr(request.body?.caption),
        subtitleText: textOr(request.body?.subtitleText),
        startState: request.body?.startState === undefined
          ? null
          : textOr(request.body?.startState) || null,
        readyCondition: request.body?.readyCondition === undefined
          ? null
          : textOr(request.body?.readyCondition) || null,
        // Продолжение — только явное `true`: строка «true» или число из чужого
        // клиента не должны молча превращать сцену в продолжение.
        continuesPrevious: request.body?.continuesPrevious === true,
        actions,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.put<SceneRoute>('/api/showcase/:id/scenes/:sceneId', async (request, reply) => {
    const expectedRevision = Number(request.body?.expectedRevision);
    const actions = request.body?.actions === undefined ? undefined : readActions(request.body.actions);
    const syncCues = request.body?.syncCues === undefined
      ? undefined
      : readSyncCues(request.body.syncCues);
    const pronunciationOverrides = request.body?.pronunciationOverrides === undefined
      ? undefined
      : readPronunciationOverrides(request.body.pronunciationOverrides);

    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      return reply.code(400).send({ error: 'bad_revision' });
    }

    if (actions === null || syncCues === null || pronunciationOverrides === null) {
      return reply.code(400).send({ error: 'bad_scene' });
    }

    try {
      return await service.updateScene(
        request.params.id,
        expectedRevision,
        request.params.sceneId,
        {
          ...(request.body?.title === undefined ? {} : { title: textOr(request.body.title) }),
          ...(request.body?.screenId === undefined ? {} : { screenId: textOr(request.body.screenId) }),
          ...(request.body?.narration === undefined ? {} : { narration: textOr(request.body.narration) }),
          ...(request.body?.caption === undefined ? {} : { caption: textOr(request.body.caption) }),
          ...(request.body?.subtitleText === undefined
            ? {}
            : { subtitleText: textOr(request.body.subtitleText) }),
          ...(typeof request.body?.continuesPrevious === 'boolean'
            ? { continuesPrevious: request.body.continuesPrevious }
            : {}),
          ...(actions === undefined ? {} : { actions }),
          ...(syncCues === undefined ? {} : { syncCues }),
          ...(pronunciationOverrides === undefined ? {} : { pronunciationOverrides }),
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
      return await service.generateBrief(request.params.id, textOr(request.body?.taskText));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // Источник рассказа: из чего выбирать и что выбрано. Выбор — данные человека, но
  // форму проверяет ручка, а имена репозиториев и коммиты — служба по живой истории:
  // браузер называет только имя репозитория, путь к нему знает сервер.
  fastify.get<ProjectRoute>('/api/showcase/:id/source', async (request, reply) => {
    try {
      return await service.sourceOptions(request.params.id);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.put<SourceRoute>('/api/showcase/:id/source', async (request, reply) => {
    const expectedRevision = request.body?.expectedRevision;
    const source = readStorySource(request.body?.source);

    // Редакция — счёт, а не строка: Number() пропустил бы "2" и true.
    const revisionValid = typeof expectedRevision === 'number'
      && Number.isSafeInteger(expectedRevision)
      && expectedRevision >= 1;

    if (!revisionValid) {
      return reply.code(400).send({ error: 'bad_revision' });
    }

    if (source === undefined) {
      return reply.code(400).send({ error: 'bad_source', message: 'Выбор «О чём ролик» не по форме.' });
    }

    try {
      return await service.saveSource(request.params.id, expectedRevision, source);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // Разбор мастера: текст связанной задачи сервер берёт сам по номеру стенда, а
  // человек на этом шаге ничего не заполняет. Ручные бриф и сценарий остаются
  // рядом — они нужны, когда план правят точечно.
  fastify.post<ProjectRoute>('/api/showcase/:id/analyze', async (request, reply) => {
    try {
      return await service.analyze(request.params.id);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.post<SceneRoute>('/api/showcase/:id/script', async (request, reply) => {

    try {
      return await service.generateScript(request.params.id, textOr(request.body?.taskText));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // Принятый сценарий остаётся неизменным: модель предлагает только связи речи
  // с уже разрешёнными действиями, а ручные cue сервер сохраняет отдельно.
  fastify.post<ProjectRoute>('/api/showcase/:id/bindings', async (request, reply) => {
    try {
      return await service.generateBindings(request.params.id);
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
    const channel = textOr(request.body?.channel);

    if (channel !== 'b24' && channel !== 'telegram') {
      return reply.code(400).send({ error: 'bad_channel' });
    }

    try {
      return await service.planDelivery(request.params.id, {
        channel,
        recipient: textOr(request.body?.recipient),
        recipientLabel: textOr(request.body?.recipientLabel),
        includeSubtitles: request.body?.includeSubtitles === true,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.post<SceneRoute>('/api/showcase/:id/delivery', async (request, reply) => {
    const channel = textOr(request.body?.channel);
    const decisionFingerprint = textOr(request.body?.decisionFingerprint);

    if (channel !== 'b24' && channel !== 'telegram') {
      return reply.code(400).send({ error: 'bad_channel' });
    }

    if (!/^[a-f0-9]{32}$/.test(decisionFingerprint)) {
      return reply.code(400).send({ error: 'bad_decision' });
    }

    try {
      return await service.deliver(request.params.id, {
        channel,
        recipient: textOr(request.body?.recipient),
        recipientLabel: textOr(request.body?.recipientLabel),
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
    const recipeFingerprint = textOr(request.body?.recipeFingerprint);

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

  // Словарь ударений установки: одно слово со знаком «+» на строку. Текст
  // сохраняется целиком, негодные строки возвращаются с причиной, а не теряются.
  fastify.get('/api/showcase/voices/dictionary', async (request, reply) => {
    try {
      return await service.readDictionary();
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.put<VoiceDictionaryRoute>('/api/showcase/voices/dictionary', async (request, reply) => {
    if (typeof request.body?.text !== 'string') {
      return reply.code(400).send({ error: 'bad_dictionary' });
    }

    try {
      return await service.saveDictionary(request.body.text);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // Готовность для настроек плагина: что нужно разделу и что он ставит сам.
  // Установка идёт только по нажатию человека — раздел не начинает её сам.
  fastify.get('/api/showcase/setup', async (request, reply) => {
    try {
      return await service.setupStatus();
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.post<SetupRoute>('/api/showcase/setup/:id', async (request, reply) => {
    try {
      return reply.code(202).send(await service.runSetup(String(request.params.id)));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.post<SetupRoute>('/api/showcase/setup/:id/cancel', async (request, reply) => {
    try {
      return await service.cancelSetup(String(request.params.id));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // Образец голоса: короткая фраза, синтезированная один раз и отданная файлом.
  // Человек выбирает голос ушами, и без образца список имён ни о чём не говорит.
  fastify.get<VoicePreviewRoute>('/api/showcase/voices/preview', async (request, reply) => {
    const voiceRef = typeof request.query.voiceRef === 'string' ? request.query.voiceRef : '';

    if (!voiceRef) {
      return reply.code(400).send({ error: 'bad_voice_ref' });
    }

    try {
      const file = await service.previewVoice(voiceRef);
      const info = await stat(file);

      return reply
        .header('content-type', 'audio/wav')
        .header('content-length', String(info.size))
        .header('cache-control', 'no-store')
        .send(createReadStream(file));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // Своя реплика уходит POST-ом: текст не попадает в URL/журналы доступа. Обрыв
  // вкладки отменяет синтез, а полный job использует тот же preparer службы.
  fastify.post<VoiceNarrationPreviewRoute>(
    '/api/showcase/voices/preview',
    async (request, reply) => {
      const voiceRef = typeof request.body?.voiceRef === 'string' ? request.body.voiceRef : '';
      const narration = typeof request.body?.narration === 'string' ? request.body.narration : '';
      const pronunciationOverrides = readPronunciationOverrides(
        request.body?.pronunciationOverrides ?? [],
      );
      let direction;

      try {
        direction = parseShowcaseDirection(request.body?.direction);
      } catch {
        return reply.code(400).send({ error: 'bad_voice_preview' });
      }

      if (!voiceRef || !narration || pronunciationOverrides === null) {
        return reply.code(400).send({ error: 'bad_voice_preview' });
      }

      const controller = new AbortController();
      const abort = () => controller.abort();

      request.raw.once('aborted', abort);
      reply.raw.once('close', abort);

      try {
        const file = await service.previewNarration({
          voiceRef,
          narration,
          direction,
          pronunciationOverrides,
          signal: controller.signal,
        });
        const info = await stat(file);

        return reply
          .header('content-type', 'audio/wav')
          .header('content-length', String(info.size))
          .header('cache-control', 'no-store')
          .send(createReadStream(file));
      } catch (error) {
        return sendError(reply, error);
      } finally {
        request.raw.removeListener('aborted', abort);
        reply.raw.removeListener('close', abort);
      }
    },
  );

  fastify.post<ProjectRoute>('/api/showcase/:id/voice', async (request, reply) => {

    try {
      return reply.code(202).send(await service.synthesizeScenes(request.params.id));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // Выбор голоса и темпа для ролика целиком. Уходит со своей редакцией, как и
  // любая правка: чужая правка сцен в этот момент не должна затираться.
  fastify.put<VoiceChoiceRoute>('/api/showcase/:id/voice', async (request, reply) => {
    const expectedRevision = Number(request.body?.expectedRevision);
    const voiceRef = request.body?.voiceRef ?? null;
    const pace = request.body?.pace ?? null;

    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      return reply.code(400).send({ error: 'bad_revision' });
    }

    if (voiceRef !== null && (typeof voiceRef !== 'string' || !voiceRef)) {
      return reply.code(400).send({ error: 'bad_voice_ref' });
    }

    if (pace !== null && (typeof pace !== 'string' || !PACES.has(pace))) {
      return reply.code(400).send({ error: 'bad_pace' });
    }

    try {
      return await service.setVoice(request.params.id, expectedRevision, {
        voiceRef: voiceRef as string | null,
        pace: pace as ShowcasePace | null,
      });
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

  // Один запрос сохраняет серверный запуск до ответа. Дальнейшие этапы не
  // зависят от вкладки и не вызываются браузером по одному.
  fastify.post<BuildStartRoute>('/api/showcase/:id/build', async (request, reply) => {
    const revision = Number(request.body?.revision);
    const requestId = typeof request.body?.requestId === 'string' ? request.body.requestId : '';

    if (!Number.isSafeInteger(revision) || revision < 1) {
      return reply.code(400).send({ error: 'bad_revision' });
    }

    if (!SHOWCASE_BUILD_REQUEST_ID_RE.test(requestId)) {
      return reply.code(400).send({ error: 'bad_request_id' });
    }

    try {
      const run = await service.startBuild(request.params.id, revision, requestId);

      return reply.code(202).send({ run });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.get<ManifestRoute>(
    '/api/showcase/:id/manifests/:manifestId',
    async (request, reply) => {
      try {
        if (!SHOWCASE_MANIFEST_ID_RE.test(request.params.manifestId)) {
          return reply.code(400).send({
            error: 'bad_manifest_id',
            message: 'Идентификатор manifest имеет недопустимую форму.',
          });
        }

        return await service.finalManifest(request.params.id, request.params.manifestId);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

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

  fastify.get<ProjectRoute>('/api/showcase/builds/:id', async (request, reply) => {
    try {
      return { run: service.readBuild(request.params.id) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.post<ProjectRoute>('/api/showcase/builds/:id/cancel', async (request, reply) => {
    try {
      return { run: await service.cancelBuild(request.params.id) };
    } catch (error) {
      return sendError(reply, error);
    }
  });
});

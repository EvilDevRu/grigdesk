// API 3D живёт за общим auth guard; свой onRequest проверяет текущий плагин.
// Captured context, admission lease и закрытые schema предшествуют файловым эффектам.
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest, HTTPMethods } from 'fastify';
import { randomUUID } from 'node:crypto';

import { parseStudio3d, ACTIVE_STATUSES } from '../../../../shared/studio3d/studio3dContracts.ts';
import type { FieldValues } from '../../../../shared/studio3d/studio3dOperations.ts';
import type { RunRequest } from '../../lib/studio3d/intents.ts';
import { selectJobInputs } from '../../lib/studio3d/jobInputs.ts';
import { offersFor } from '../../lib/studio3d/providers.ts';
import type { SearchQuery } from '../../lib/studio3d/search.ts';
import { isSafeName } from '../../lib/studio3d/safePath.ts';
import { createStudioRuntime } from './runtime.ts';
import type { StudioRuntimeOptions, StudioContext } from './runtime.ts';
import { StudioHttpError, publicStudioError } from './errors.ts';
import { createLibraryOperations } from './libraryOperations.ts';
import type { ImportFileRequest, SaveRequest } from './libraryOperations.ts';
import { sendStudioFile } from './files.ts';
import { receiveUpload } from './uploads.ts';
import * as schema from './schemas.ts';

export type StudioModuleOptions = Omit<StudioRuntimeOptions, 'enabled' | 'settings'>;
type Request = FastifyRequest<{
  Params: Record<string, string>;
  Querystring: Record<string, unknown>;
  Body: Record<string, unknown>;
}>;
type Handler = (context: StudioContext, request: Request, reply: FastifyReply,
  operations: ReturnType<typeof createLibraryOperations>,
    check: (libraryId?: string) => void) => Promise<unknown>;

/**
 * Schema гарантирует параметр нужной ручке, helper проверяет это и для типов.
 * Отсутствующее значение не превращается в строку undefined или путь на диске.
 */
function param(request: Request, key: string): string {
  const value = request.params[key];

  if (typeof value !== 'string') {
    throw new StudioHttpError(400, 'invalid_request', 'Отсутствует параметр адреса.');
  }

  return value;
}

/**
 * Registration выключенного плагина не открывает библиотеку и не создаёт сеть.
 * Inner scope удерживает validators/hooks внутри /api/studio3d, не меняя соседние API.
 */
async function studio3dModule(fastify: FastifyInstance, options: StudioModuleOptions): Promise<void> {
  const broadcast = options.broadcast ?? ((name: string, data: Record<string, unknown>) => {
    fastify.sse?.broadcast?.(name, data);
  });
  const runtime = createStudioRuntime({
    ...options,
    broadcast,
    enabled: () => fastify.pluginEnabled('studio3d'),
    settings: () => fastify.pluginSettings?.('studio3d') ?? {}
  });

  fastify.decorate('studio3d', runtime);
  // Открытие библиотеки уходит в фон: диск и журнал заказов не должны удерживать
  // общий лимит Fastify на onReady. Ошибка старта видна в state как unavailable.
  fastify.addHook('onReady', () => {
    void runtime.start();
  });
  fastify.addHook('onClose', () => runtime.close());

  await fastify.register(async (server) => {
    schema.installStudioValidation(server);
    server.addContentTypeParser(['image/png', 'image/webp'], { parseAs: 'buffer',
      bodyLimit: 5 * 1024 * 1024 },
      (_request, body, done) => done(null, body));
    server.setErrorHandler((error, _request, reply) => {
      if ((error as { validation?: unknown }).validation) {
        return reply.code(400).send({ error: 'invalid_request', message: 'Проверьте поля запроса.' });
      }

      const result = publicStudioError(error);

      return reply.code(result.status).send(result.body);
    });
    server.addHook('onRequest', async (request, reply) => {
      if (!fastify.pluginEnabled('studio3d')) {
        return reply.code(404).send({ error: 'plugin_disabled', message: 'Плагин «3D» выключен.' });
      }

      // Роутер Fastify декодирует %XX до сопоставления, поэтому сырой request.url
      // обходит проверку: /ru%6E доходит до ручки /run. Матченный роут — шаблон
      // без кодирования, как в общем auth guard.
      const routeUrl = request.routeOptions?.url || '';
      const paid = /\/(?:run|retry|reconcile|close-unknown)(?:\?|$)/.test(routeUrl);

      if (paid && request.authKind !== 'session') {
        return reply.code(403).send({ error: 'human_session_required',
          message: 'Нужно действие человека в окне.' });
      }
    });

    /**
     * Lease препятствует смене root во время эффекта, disable остаётся доступен.
     * Поздний ответ сверяет поколение и не выдаёт DTO прежней библиотеки как текущий.
     */
    const route = (method: HTTPMethods, url: string, parts: Record<string, schema.InputSchema>,
      handler: Handler, libraryRequired = method !== 'GET') => {
      server.route({
        method,
        url,
        bodyLimit: url.startsWith('/batches/') ? 16 * 1024 * 1024
          : url.endsWith('/preview') ? 5 * 1024 * 1024 : 1024 * 1024,
        schema: {
          querystring: schema.object(),
          params: schema.object(),
          ...parts
        },
        handler: async (raw, reply) => {
          const request = raw as Request;
          const captured = runtime.snapshot();
          const { context, generation } = captured;
          const libraryId = request.body?.libraryId ?? request.query?.libraryId;

          /**
           * Проверка повторяется перед публикацией каждого файла или DTO.
           * Multipart передаёт свой libraryId после чтения первого field.
           */
          const check = (explicitId?: string) => {
            if (explicitId !== undefined || libraryRequired) {
              runtime.admission.capture(String(explicitId ?? libraryId ?? ''));
            }

            if (!runtime.current(context, generation)) {
              throw new StudioHttpError(409, 'stale_library', 'Контекст библиотеки изменился.');
            }
          };

          if (url !== '/uploads') {
            check();
          }

          const release = libraryRequired || method !== 'GET' ? await runtime.admission.locked(async () => {
            if (url !== '/uploads') {
              check();
            }

            return runtime.admission.lease();
          }) : () => {};
          const operations = createLibraryOperations(context, {
            check,
            projects: options.projects,
            broadcast
          });

          try {
            const result = await handler(context, request, reply, operations, check);

            if (!reply.sent) {
              check(url === '/uploads' ? context.library.libraryId : undefined);
            }

            return result;
          } finally {
            release();
          }
        }
      });
    };

    server.get('/state', { schema: { querystring: schema.object(), params: schema.object() } },
      async () => runtime.state());

    route('GET', '/models', { querystring: schema.object({
      q: schema.text(1024),
      project: schema.id,
      category: schema.text(32),
      has: schema.text(128),
      origin: schema.text(32),
      provider: schema.id,
      from: schema.text(32),
      to: schema.text(32),
      sort: { type: 'string', enum: ['updated', 'created', 'name', 'spent'] },
      offset: {
        type: 'integer',
        minimum: 0,
        maximum: 1e6
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 200
      }
    }) }, async (_context, request, _reply, operations) => operations.list(request.query as SearchQuery));

    const modelParams = schema.object({ id: schema.id }, ['id']);
    const versionParams = schema.object({ id: schema.id, vid: schema.id }, ['id', 'vid']);

    route('GET', '/models/:id', { params: modelParams },
      async (_context, request, _reply, operations) => operations.detail(param(request, 'id')));
    route('POST', '/models', { body: schema.withLibrary({
      name: schema.text(200, 1),
      project: schema.project,
      category: schema.category,
      uploadId: schema.uuid,
      path: schema.text(4096, 1),
      scope: schema.text(256)
    }) }, async (_context, request, _reply,
      operations) => operations.createModel(request.body as ImportFileRequest));
    route('PATCH', '/models/:id', { params: modelParams, body: schema.withLibrary({
      name: schema.text(200, 1),
      project: schema.project,
      category: schema.category,
      tags: {
        type: 'array',
        maxItems: 32,
        items: schema.text(64, 1)
      },
      notes: schema.text(16384),
      mainVersion: { anyOf: [schema.id, { type: 'null' }] }
    }) }, async (context, request, _reply, operations) => {
      const { libraryId: _libraryId, ...patch } = request.body;

      await context.library.updateModel(param(request, 'id'),
        patch as Partial<Parameters<typeof context.library.updateModel>[1]>);
      operations.changed(param(request, 'id'));

      return operations.detail(param(request, 'id'));
    });
    route('DELETE', '/models/:id', { params: modelParams, querystring: schema.withLibrary() },
      async (context, request, _reply, operations) => {
        await context.library.deleteModel(param(request, 'id'));
        operations.changed(param(request, 'id'), null, 'deleted');

        return { libraryId: context.library.libraryId, ok: true };
      });
    route('DELETE', '/models/:id/versions/:vid', { params: versionParams, querystring: schema.withLibrary() },
      async (context, request, _reply, operations) => {
        await context.library.deleteVersion(param(request, 'id'), param(request, 'vid'));
        operations.changed(param(request, 'id'), param(request, 'vid'), 'deleted');

        return { libraryId: context.library.libraryId, ok: true };
      });
    route('POST', '/models/:id/versions/:vid/lighten', {
      params: versionParams, body: schema.withLibrary({ force: schema.flag }),
    }, async (context, request, _reply, operations) => {
      const freed = await context.library.lighten(param(request, 'id'), param(request, 'vid'),
        { force: request.body.force as boolean | undefined });

      operations.changed(param(request, 'id'), param(request, 'vid'), 'lightened');

      return parseStudio3d.lighten({ libraryId: context.library.libraryId, freed });
    });
    route('POST', '/models/:id/versions/from-file', {
      params: modelParams, body: schema.withLibrary({
        incoming: schema.externalFileName,
        uploadId: schema.uuid,
        parentVersionId: schema.id,
        label: schema.text(200)
      }),
    }, async (_context, request, _reply, operations) => operations.fromFile(param(request, 'id'),
      request.body));
    route('POST', '/models/:id/versions/:vid/save', {
      params: versionParams, body: schema.withLibrary({
        projectId: schema.id,
        repoKey: schema.id,
        folder: schema.text(2048),
        fileName: schema.externalFileName,
        overwrite: schema.flag,
        expectedSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' }
      }, ['projectId', 'repoKey', 'folder', 'fileName']),
    }, async (_context, request, _reply, operations) => operations.save(param(request, 'id'),
      param(request, 'vid'),
      request.body as unknown as SaveRequest));
    route('POST', '/models/:id/versions/:vid/preview', {
      params: versionParams, querystring: schema.withLibrary(),
    }, async (_context, request, _reply, operations) => operations.preview(param(request, 'id'),
      param(request, 'vid'),
      request.body as unknown as Buffer, String(request.headers['content-type']).split(';')[0] ?? ''));

    route('POST', '/models/:id/versions/:vid/retry', {
      params: versionParams, body: schema.withLibrary({ idempotencyKey: schema.uuid,
        expectedPrice: schema.amount },
        ['idempotencyKey', 'expectedPrice']),
    }, async (context, request, reply, operations) => {
      const item = await operations.version(param(request, 'id'), param(request, 'vid'));

      if (!item.intentId || !item.childId) {
        throw new StudioHttpError(409, 'retry_unavailable', 'У версии нет заказа для повторения.');
      }

      const result = await context.jobs.retry(item.intentId, item.childId,
        request.body as Parameters<typeof context.jobs.retry>[2]);

      return reply.code(202).send(result);
    });
    route('POST', '/models/:id/versions/:vid/redownload', { params: versionParams,
      body: schema.withLibrary() },
      async (context, request, _reply, operations) => {
        const item = await operations.version(param(request, 'id'), param(request, 'vid'));

        if (item.intentId && item.childId) {
          await context.jobs.redownload(item.intentId, item.childId, context.library.libraryId);
        } else if (item.task) {
          await context.importer.importTask(item.task.provider, item.task.id);
        } else {
          throw new StudioHttpError(409, 'redownload_unavailable', 'Удалённый файл не найден.');
        }

        return operations.projection(param(request, 'id'), await operations.version(param(request,
          'id'), param(request, 'vid')));
      });

    route('GET', '/files/:modelId/:versionId/:name', { params: schema.object({
      modelId: schema.id,
      versionId: schema.id,
      name: schema.fileName
    }, ['modelId', 'versionId', 'name']) }, async (context, request, reply) => {
      if (!isSafeName(param(request, 'name'))) {
        throw new StudioHttpError(400, 'invalid_file', 'Некорректное имя файла.');
      }

      const opened = await context.library.openVersionFile(param(request, 'modelId'),
        param(request, 'versionId'),
        param(request, 'name'));

      return sendStudioFile(request, reply, opened, opened.file.sha256);
    });

    route('POST', '/offers', { body: schema.withLibrary(schema.input) },
      async (context, request) => {
        const provider = context.providers[0]!;
        const selected = await selectJobInputs(context.library, {
          ...request.body,
          idempotencyKey: randomUUID(),
          operation: 'offers'
        } as RunRequest, provider, provider.snapshot?.());

        try {
          return parseStudio3d.offers({ libraryId: context.library.libraryId,
            offers: await offersFor({
              providers: context.providers,
              version: selected.version,
              context: selected.context
            }),
          });
        } finally {
          selected.release();
        }
      });
    route('POST', '/quote', { body: schema.withLibrary({
      ...schema.input,
      provider: schema.id,
      operation: schema.id,
      values: schema.values
    }, ['provider', 'operation', 'values']) }, async (context, request) => {
      const provider = context.providers.find((item) => item.id === request.body.provider);

      if (!provider || !await provider.available()) {
        throw new StudioHttpError(409, 'provider_unavailable', 'Исполнитель недоступен.');
      }

      const selected = await selectJobInputs(context.library,
        { ...request.body, idempotencyKey: randomUUID() } as RunRequest, provider, provider.snapshot?.());

      try {
        const validation = provider.validate(String(request.body.operation),
          request.body.values as FieldValues,
          selected.context);
        const quote = provider.quote(String(request.body.operation), validation.values, selected.context);

        return parseStudio3d.quote({
          libraryId: context.library.libraryId,
          quote,
          validation
        });
      } finally {
        selected.release();
      }
    });
    route('POST', '/run', { body: schema.object(schema.runProperties,
      ['libraryId', 'idempotencyKey', 'provider', 'operation', 'values', 'expectedPrice']) },
    async (context, request, reply) => reply.code(202).send(await context.jobs.run(request.body)));
    route('GET', '/jobs/:id', { params: modelParams, querystring: schema.withLibrary() },
      async (context, request) => context.jobs.job(param(request, 'id'),
        String(request.query.libraryId)), true);
    
    const childParams = schema.object({ id: schema.uuid, childId: schema.id }, ['id', 'childId']);

    route('POST', '/jobs/:id/children/:childId/reconcile', {
      params: childParams, body: schema.withLibrary({ taskId: schema.id }, ['taskId']),
    }, async (context, request) => context.jobs.reconcile(param(request, 'id'), param(request, 'childId'),
      request.body as Parameters<typeof context.jobs.reconcile>[2]));
    route('POST', '/jobs/:id/children/:childId/close-unknown', {
      params: childParams, body: schema.withLibrary(),
    }, async (context, request) => context.jobs.closeUnknown(param(request, 'id'), param(request, 'childId'),
      String(request.body.libraryId)));
    route('POST', '/batches/quote', { body: schema.withLibrary({ rows: schema.rows }, ['rows']) },
      async (context, request) => context.jobs.quoteBatch(
        request.body as Parameters<typeof context.jobs.quoteBatch>[0]));
    route('POST', '/batches/run', { body: schema.withLibrary({
      idempotencyKey: schema.uuid,
      snapshot: schema.snapshot,
      snapshotHash: { type: 'string', pattern: '^[a-f0-9]{64}$' }
    }, ['idempotencyKey', 'snapshot', 'snapshotHash']) }, async (context, request, reply) =>
      reply.code(202).send(await context.jobs.runBatch(
        request.body as Parameters<typeof context.jobs.runBatch>[0])));
    route('POST', '/uploads', {}, async (context, request, _reply, _operations, check) =>
      receiveUpload(request, context.library, check), false);
    route('GET', '/tasks', { querystring: schema.object({ refresh: { type: 'integer', enum: [1] } }) },
      async (context, request) => {
        if (request.query.refresh === 1) {
          await context.importer.syncHistory({ autoImport: !!(fastify.pluginSettings?.('studio3d') as
            { autoImport?: boolean })?.autoImport });
        }

        const tasks = await context.jobs.tasks();
        const week = await context.importer.week();
        const cutoff = Date.now() - 86_400_000;

        return parseStudio3d.tasks({
          libraryId: context.library.libraryId,
          active: tasks.filter((row) => ACTIVE_STATUSES.includes(row.status)),
          recent: tasks.filter((row) => !ACTIVE_STATUSES.includes(row.status) &&
            Date.parse(row.updatedAt) >= cutoff),
          external: await context.importer.externalTasks(),
          week: { partial: week.partial, groups: week.groups },
          historyPartial: week.partial,
          historyError: week.historyError
        });
      });
    route('POST', '/tasks/:provider/:taskId/import', { params: schema.object({
      provider: schema.id, taskId: schema.id,
    }, ['provider', 'taskId']), body: schema.withLibrary() }, async (context, request) =>
      parseStudio3d.imported(await context.importer.importTask(param(request, 'provider'),
        param(request, 'taskId'))));
    route('POST', '/scan', { body: schema.withLibrary() }, async (context) =>
      parseStudio3d.scan(await context.importer.scan()));
    route('POST', '/viewer/resolve', { body: schema.withLibrary({
      path: schema.text(4096, 1), scope: schema.text(256),
    }, ['path']) }, async (context, request) => parseStudio3d.viewer(
      await context.files.resolve(String(request.body.path), String(request.body.scope ?? ''))));
    route('GET', '/viewer/file/:token/*', { params: schema.object({
      token: { type: 'string', pattern: '^[a-f0-9]{48}$' }, '*': schema.text(4096, 1),
    }, ['token', '*']) }, async (context, request, reply) => {
      const file = await context.files.viewerFile(param(request, 'token'), param(request, '*'));

      return sendStudioFile(request, reply, file.opened, file.sha256);
    });
  }, { prefix: '/api/studio3d' });
}

export default fp(studio3dModule, { name: 'module-studio3d' });

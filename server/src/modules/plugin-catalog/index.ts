import type { FastifyInstance } from 'fastify';
import { Ajv } from 'ajv';
import type { AnySchema } from 'ajv';

import { CatalogReadError, type PluginCatalogService } from '../../lib/pluginCatalog.ts';

/**
 * Каталог — отдельный read-only модуль под общим /api auth guard приложения.
 * Строгая локальная validation не меняет defaults соседних модулей Fastify.
 */
export default async function pluginCatalogModule(
  app: FastifyInstance,
  options: { catalog: PluginCatalogService },
): Promise<void> {
  const ajv = new Ajv({ removeAdditional: false, coerceTypes: false });

  app.setValidatorCompiler(({ schema }) => ajv.compile(schema as AnySchema));
  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof CatalogReadError ? error.statusCode
      : error instanceof Error && 'validation' in error ? 400 : 502;

    return reply.code(status).send({
      error: status === 400 ? 'invalid_request' : 'catalog_unavailable',
      message: 'Не удалось прочитать каталог плагинов. Обновите каталог.',
    });
  });

  app.get<{ Querystring: { refresh?: '1'; api?: '2' } }>('/api/plugin-catalog', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          refresh: { type: 'string', enum: ['1'] },
          api: { type: 'string', enum: ['2'] },
        },
        additionalProperties: false,
      },
    },
  }, async (request) => options.catalog.index(request.query.refresh === '1', request.query.api === '2'));
  app.get<{ Params: { id: string }; Querystring: { api?: '2' } }>('/api/plugin-catalog/:id', {
    schema: {
      params: {
        type: 'object',
        properties: { id: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,40}$' } },
        required: ['id'],
        additionalProperties: false,
      },
      querystring: {
        type: 'object',
        properties: { api: { type: 'string', enum: ['2'] } },
        additionalProperties: false,
      },
    },
  }, async (request) => options.catalog.detail(request.params.id, request.query.api === '2'));
}

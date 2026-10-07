// Core-модуль просмотра документов. Это не отключаемый plugin и не часть чата:
// чат лишь строит ссылку на этот API/route, другие экраны могут использовать его так же.
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { DocumentReader } from '../../lib/documents/reader.ts';

export interface DocumentsModuleOptions {
  reader: DocumentReader;
}

// Ссылку на документ несёт запрос: bridge — телом, чтение — строкой запроса.
interface DocumentResolveRoute {
  Body: { path?: unknown; scope?: unknown };
}

interface DocumentFileRoute {
  Querystring: { source?: unknown; path?: unknown };
}

async function documentsModule(
  fastify: FastifyInstance,
  opts: DocumentsModuleOptions,
): Promise<void> {
  const { reader } = opts;
  if (!reader || typeof reader.read !== 'function') {
    throw new TypeError('module-documents requires reader');
  }

  async function answer(
    reply: FastifyReply,
    request: FastifyRequest,
    operation: () => Promise<unknown>,
  ) {
    reply.header('Cache-Control', 'private, no-store');
    try {
      return await operation();
    } catch (thrown) {
      // Отказ читателя уже назван кодом и статусом: показываем ровно его, а не 500.
      const error = thrown as { statusCode?: number; code?: string; message?: string } | null;
      if (error?.statusCode && error?.code) {
        return reply.code(error.statusCode).send({ error: error.code, message: error.message });
      }
      request.log.error({ err: error?.message }, 'предпросмотр документа не удался');
      return reply.code(500).send({
        error: 'document_read_failed',
        message: 'Не удалось прочитать документ',
      });
    }
  }

  // Bridge для уже существующих ответов агентов: абсолютный путь только разрешается
  // в source/path и не является адресом файлового API. Клиент тут же заменяет URL.
  // POST не оставляет абсолютный host path в access-log query. Сам путь до replace()
  // живёт только во fragment браузера, который HTTP-серверу вообще не отправляется.
  // `scope` называет владельца ссылки (`chat:<id>`) — его папки тоже становятся корнями.
  fastify.post<DocumentResolveRoute>('/api/documents/resolve', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const filePath = String(request.body?.path || '');
    if (!filePath) {
      return reply.code(400).send({ error: 'document_path_required', message: 'Не указан путь к документу' });
    }

    const scope = String(request.body?.scope || '');

    return answer(reply, request, () => reader.resolveAbsolute(filePath, scope));
  });

  fastify.get<DocumentFileRoute>('/api/documents/file', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const source = String(request.query?.source || '');
    const filePath = String(request.query?.path || '');
    if (!source || !filePath) {
      return reply.code(400).send({
        error: 'document_ref_required',
        message: 'Не указана ссылка на документ',
      });
    }
    return answer(reply, request, () => reader.read({ source, path: filePath }));
  });

  fastify.get<DocumentFileRoute>('/api/documents/asset', async (request, reply) => {
    const source = String(request.query?.source || '');
    const filePath = String(request.query?.path || '');
    if (!source || !filePath) {
      reply.header('Cache-Control', 'private, no-store');
      return reply.code(400).send({
        error: 'document_ref_required',
        message: 'Не указана ссылка на изображение',
      });
    }
    return answer(reply, request, async () => {
      const asset = await reader.readAsset({ source, path: filePath });
      reply.type(asset.contentType);
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Cross-Origin-Resource-Policy', 'same-origin');
      return reply.send(asset.content);
    });
  });
}

export default fp(documentsModule, { name: 'module-documents' });

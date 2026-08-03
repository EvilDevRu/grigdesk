// Core-модуль просмотра документов. Это не отключаемый plugin и не часть чата:
// чат лишь строит ссылку на этот API/route, другие экраны могут использовать его так же.
import fp from 'fastify-plugin';

async function documentsModule(fastify, opts) {
  const { reader } = opts;
  if (!reader || typeof reader.read !== 'function') {
    throw new TypeError('module-documents requires reader');
  }

  async function answer(reply, request, operation) {
    reply.header('Cache-Control', 'private, no-store');
    try {
      return await operation();
    } catch (error) {
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
  fastify.post('/api/documents/resolve', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const filePath = String(request.body?.path || '');
    if (!filePath) {
      return reply.code(400).send({ error: 'document_path_required', message: 'Не указан путь к документу' });
    }
    return answer(reply, request, () => reader.resolveAbsolute(filePath));
  });

  fastify.get('/api/documents/file', async (request, reply) => {
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

  fastify.get('/api/documents/asset', async (request, reply) => {
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

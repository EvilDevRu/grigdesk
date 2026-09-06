function tags(value) {
  if (Array.isArray(value)) {
    return value.map(String).filter(Boolean);
  }
  return value == null || value === '' ? [] : [String(value)];
}

function filters(query = {}, { search = false } = {}) {
  const result = {};
  if (search) {
    result.query = String(query.q || '');
  }
  if (query.project) {
    result.project = String(query.project);
  }
  if (query.repository) {
    result.repository = String(query.repository);
  }
  const selectedTags = tags(query.tag);
  if (selectedTags.length) {
    result.tags = selectedTags;
  }
  if (query.limit !== undefined) {
    result.limit = Number(query.limit);
  }
  return result;
}

function bodyFields(body = {}, { revision = false } = {}) {
  const allowed = ['project', 'repository', 'kind', 'title', 'body', 'tags'];
  const result = {};
  for (const key of allowed) {
    if (body[key] !== undefined) {
      result[key] = body[key];
    }
  }
  if (revision && body.expectedRevision !== undefined) {
    result.expectedRevision = body.expectedRevision;
  }
  return result;
}

function importApplyFields(body = {}) {
  return {
    snapshotHash: String(body.snapshotHash || ''),
    resolutions: Array.isArray(body.resolutions) ? body.resolutions.map((item) => ({
      id: String(item?.id || ''),
      decision: String(item?.decision || ''),
      expectedCurrentRevision: item?.expectedCurrentRevision,
    })) : [],
  };
}

const BACKUP_FILE_LIMIT = 64 * 1024 ** 2;

function backupUploadError(message, { tooLarge = false } = {}) {
  return Object.assign(new Error(message), {
    code: tooLarge ? 'KNOWLEDGE_BACKUP_TOO_LARGE' : 'KNOWLEDGE_INVALID_ARGUMENTS',
  });
}

/** Читает ровно один backup-файл и разрешённые строковые поля независимо от их порядка. */
async function backupUpload(request, fastify, { apply = false } = {}) {
  if (request.isMultipart?.() !== true) {
    throw backupUploadError('Импорт требует multipart-файл резервной копии.');
  }

  const acceptedFields = apply ? new Set(['snapshotHash', 'resolutions']) : new Set();
  const fields = {};
  const files = [];
  try {
    const parts = request.parts({
      limits: {
        fileSize: BACKUP_FILE_LIMIT,
        files: 2,
        fields: acceptedFields.size,
        parts: acceptedFields.size + 2,
      },
    });
    for await (const part of parts) {
      if (part.type === 'file') {
        const bytes = await part.toBuffer();
        if (part.file.truncated) {
          throw backupUploadError('Файл резервной копии превышает 64 МиБ.', { tooLarge: true });
        }
        files.push({ fieldname: part.fieldname, bytes });
        continue;
      }
      if (!acceptedFields.has(part.fieldname) || Object.hasOwn(fields, part.fieldname)
        || typeof part.value !== 'string') {
        throw backupUploadError('Поля импорта заполнены некорректно.');
      }
      fields[part.fieldname] = part.value;
    }
  } catch (error) {
    const FileTooLarge = fastify.multipartErrors?.RequestFileTooLargeError;
    if ((FileTooLarge && error instanceof FileTooLarge)
      || error?.code === 'FST_REQ_FILE_TOO_LARGE') {
      throw backupUploadError('Файл резервной копии превышает 64 МиБ.', { tooLarge: true });
    }
    if (error?.code?.startsWith?.('KNOWLEDGE_')) {
      throw error;
    }
    throw backupUploadError('Multipart-загрузка резервной копии повреждена.');
  }

  if (files.length !== 1 || files[0].fieldname !== 'file') {
    throw backupUploadError('Нужен ровно один файл резервной копии.');
  }
  return { bytes: files[0].bytes, fields };
}

function parsedApplyFields(fields) {
  let resolutions;
  try {
    resolutions = JSON.parse(fields.resolutions);
  } catch {
    throw backupUploadError('Решения импорта должны быть JSON-массивом.');
  }
  if (!Array.isArray(resolutions)) {
    throw backupUploadError('Решения импорта должны быть JSON-массивом.');
  }
  return importApplyFields({ snapshotHash: fields.snapshotHash, resolutions });
}

function sendError(reply, error, log) {
  if (error?.code === 'KNOWLEDGE_NOT_FOUND') {
    return reply.code(404).send({ error: 'not_found', message: 'Запись не найдена.' });
  }
  if (error?.code === 'KNOWLEDGE_CONFLICT') {
    return reply.code(409).send({
      error: 'knowledge_conflict',
      message: 'Запись уже изменена в другом окне.',
      currentRevision: error.currentRevision,
    });
  }
  if (error?.code === 'KNOWLEDGE_INVALID_ARGUMENTS') {
    return reply.code(400).send({ error: 'invalid_arguments', message: error.message });
  }
  if (error?.code === 'KNOWLEDGE_BACKUP_TOO_LARGE') {
    return reply.code(413).send({ error: 'backup_too_large', message: error.message });
  }
  if (error?.code === 'KNOWLEDGE_IMPORT_STALE') {
    return reply.code(409).send({
      error: 'knowledge_import_stale',
      message: 'Экспорт или база изменились. Проверьте новый план импорта.',
      preview: error.preview,
    });
  }
  log?.error?.({ err: error }, 'API знаний: хранилище недоступно');
  return reply.code(503).send({
    error: 'knowledge_unavailable',
    reason: error?.reasonCode || 'storage',
    message: 'Хранилище знаний сейчас недоступно.',
  });
}

/** HTTP-модуль оставляет весь CRUD за общим auth guard приложения. */
export default async function knowledgeModule(fastify, { knowledge, transfer } = {}) {
  fastify.addHook('onRequest', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (fastify.pluginEnabled?.('knowledge') !== true) {
      return reply.code(404).send({
        error: 'plugin_disabled',
        message: 'Плагин «Знания» выключен.',
      });
    }
  });

  fastify.get('/api/knowledge', async (request, reply) => {
    try {
      return await knowledge.list(filters(request.query));
    } catch (error) {
      return sendError(reply, error, fastify.log);
    }
  });

  fastify.get('/api/knowledge/search', async (request, reply) => {
    try {
      return await knowledge.search(filters(request.query, { search: true }));
    } catch (error) {
      return sendError(reply, error, fastify.log);
    }
  });

  fastify.post('/api/knowledge/backup/export', async (_request, reply) => {
    try {
      const bytes = await transfer.exportKnowledge();
      const date = new Date().toISOString().slice(0, 10);
      return reply
        .type('application/json; charset=utf-8')
        .header(
          'Content-Disposition',
          `attachment; filename="cockpit-knowledge-${date}.json"`,
        )
        .send(bytes);
    } catch (error) {
      return sendError(reply, error, fastify.log);
    }
  });

  fastify.post('/api/knowledge/backup/import/preview', async (request, reply) => {
    try {
      const upload = await backupUpload(request, fastify);
      return await transfer.previewImport(upload.bytes);
    } catch (error) {
      return sendError(reply, error, fastify.log);
    }
  });

  fastify.post('/api/knowledge/backup/import/apply', async (request, reply) => {
    try {
      const upload = await backupUpload(request, fastify, { apply: true });
      return await transfer.applyImport(upload.bytes, parsedApplyFields(upload.fields));
    } catch (error) {
      return sendError(reply, error, fastify.log);
    }
  });

  fastify.post('/api/knowledge/maps/refresh', async (_request, reply) => {
    try {
      return await transfer.updateMaps();
    } catch (error) {
      return sendError(reply, error, fastify.log);
    }
  });

  fastify.get('/api/knowledge/:id', async (request, reply) => {
    try {
      const record = await knowledge.read(String(request.params.id));
      if (!record) {
        return reply.code(404).send({ error: 'not_found', message: 'Запись не найдена.' });
      }
      return { record };
    } catch (error) {
      return sendError(reply, error, fastify.log);
    }
  });

  fastify.post('/api/knowledge', async (request, reply) => {
    try {
      const record = await knowledge.create(bodyFields(request.body));
      return reply.code(201).send({ record });
    } catch (error) {
      return sendError(reply, error, fastify.log);
    }
  });

  fastify.put('/api/knowledge/:id', async (request, reply) => {
    try {
      const record = await knowledge.update(
        String(request.params.id),
        bodyFields(request.body, { revision: true }),
      );
      return { record };
    } catch (error) {
      return sendError(reply, error, fastify.log);
    }
  });

  fastify.delete('/api/knowledge/:id', async (request, reply) => {
    try {
      return await knowledge.delete(String(request.params.id), {
        expectedRevision: request.body?.expectedRevision,
      });
    } catch (error) {
      return sendError(reply, error, fastify.log);
    }
  });
}

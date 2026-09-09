// Модуль knowledge — HTTP-граница базы знаний. Сама база живёт в отдельном worker-е
// SQLite, а этот слой отвечает за разбор запроса, коды отказов и multipart резервной
// копии. Формы ответов объявлены общим контрактом: их читает и раздел, и агент.
//
// Доступ: весь CRUD остаётся за общим auth guard приложения, а выключенный плагин
// отвечает 404 ещё до обращения к базе.
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Multipart } from '@fastify/multipart';
import type {
  KnowledgeImportPreview,
  KnowledgeImportResult,
  KnowledgeListResponse,
  KnowledgeMapsResult,
  KnowledgeRecord,
  KnowledgeRemovalResponse,
  KnowledgeSearchResponse,
} from '../../../../shared/knowledgeContracts.ts';

declare module 'fastify' {
  interface FastifyInstance {
    pluginEnabled(id: string): boolean;
  }
}

export interface KnowledgeQueryFilters {
  query?: string;
  project?: string;
  repository?: string;
  tags?: string[];
  limit?: number;
}

// Поля записи приходят от человека и проверяются хранилищем: HTTP-слой только
// отбирает разрешённые ключи и не решает, годится ли значение.
export interface KnowledgeWriteFields {
  project?: unknown;
  repository?: unknown;
  kind?: unknown;
  title?: unknown;
  body?: unknown;
  tags?: unknown;
  expectedRevision?: unknown;
}

export interface KnowledgeApplyResolution {
  id: string;
  decision: string;
  expectedCurrentRevision: unknown;
}

export interface KnowledgeApplyInput {
  snapshotHash: string;
  resolutions: KnowledgeApplyResolution[];
}

export interface KnowledgeStore {
  list(filters: KnowledgeQueryFilters): Promise<KnowledgeListResponse>;
  search(filters: KnowledgeQueryFilters): Promise<KnowledgeSearchResponse>;
  read(id: string): Promise<KnowledgeRecord | null>;
  create(input: KnowledgeWriteFields): Promise<KnowledgeRecord>;
  update(id: string, input: KnowledgeWriteFields): Promise<KnowledgeRecord>;
  delete(id: string, options: { expectedRevision?: unknown }): Promise<KnowledgeRemovalResponse>;
}

export interface KnowledgeTransfer {
  exportKnowledge(): Promise<Buffer>;
  previewImport(bytes: Buffer): Promise<KnowledgeImportPreview>;
  applyImport(bytes: Buffer, input: KnowledgeApplyInput): Promise<KnowledgeImportResult>;
  updateMaps(): Promise<KnowledgeMapsResult>;
}

export interface KnowledgeModuleOptions {
  knowledge: KnowledgeStore;
  transfer: KnowledgeTransfer;
}

interface KnowledgeQueryString {
  q?: unknown;
  project?: unknown;
  repository?: unknown;
  tag?: unknown;
  limit?: unknown;
}

interface KnowledgeIdParams {
  id: string;
}

// Отказ хранилища доезжает сюда обычной ошибкой: её поля читаются осторожно, потому
// что до HTTP-слоя она проходит через worker и структурное клонирование.
interface KnowledgeFailure {
  code?: unknown;
  reasonCode?: unknown;
  currentRevision?: unknown;
  preview?: unknown;
  message?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function failure(error: unknown): KnowledgeFailure {
  return asRecord(error) as KnowledgeFailure;
}

function failureCode(error: unknown): string {
  const code = failure(error).code;

  return typeof code === 'string' ? code : '';
}

function tags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(String).filter(Boolean);
  }
  return value == null || value === '' ? [] : [String(value)];
}

function filters(query: KnowledgeQueryString = {}, { search = false } = {}): KnowledgeQueryFilters {
  const result: KnowledgeQueryFilters = {};
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

function bodyFields(body: unknown, { revision = false } = {}): KnowledgeWriteFields {
  const source = asRecord(body);
  const allowed = ['project', 'repository', 'kind', 'title', 'body', 'tags'] as const;
  const result: KnowledgeWriteFields = {};
  for (const key of allowed) {
    if (source[key] !== undefined) {
      result[key] = source[key];
    }
  }
  if (revision && source.expectedRevision !== undefined) {
    result.expectedRevision = source.expectedRevision;
  }
  return result;
}

function importApplyFields(body: Record<string, unknown>): KnowledgeApplyInput {
  const resolutions = Array.isArray(body.resolutions) ? body.resolutions : [];
  return {
    snapshotHash: String(body.snapshotHash || ''),
    resolutions: resolutions.map((item: unknown) => {
      const source = asRecord(item);
      return {
        id: String(source.id || ''),
        decision: String(source.decision || ''),
        expectedCurrentRevision: source.expectedCurrentRevision,
      };
    }),
  };
}

const BACKUP_FILE_LIMIT = 64 * 1024 ** 2;

function backupUploadError(message: string, { tooLarge = false } = {}): Error {
  return Object.assign(new Error(message), {
    code: tooLarge ? 'KNOWLEDGE_BACKUP_TOO_LARGE' : 'KNOWLEDGE_INVALID_ARGUMENTS',
  });
}

interface BackupUpload {
  bytes: Buffer;
  fields: Record<string, string>;
}

/** Читает ровно один backup-файл и разрешённые строковые поля независимо от их порядка. */
async function backupUpload(
  request: FastifyRequest,
  fastify: FastifyInstance,
  { apply = false } = {},
): Promise<BackupUpload> {
  if (request.isMultipart?.() !== true) {
    throw backupUploadError('Импорт требует multipart-файл резервной копии.');
  }

  const acceptedFields = apply ? new Set(['snapshotHash', 'resolutions']) : new Set<string>();
  const fields: Record<string, string> = {};
  const files: { fieldname: string; bytes: Buffer }[] = [];
  try {
    const parts = request.parts({
      limits: {
        fileSize: BACKUP_FILE_LIMIT,
        files: 2,
        fields: acceptedFields.size,
        parts: acceptedFields.size + 2,
      },
    });
    for await (const part of parts as AsyncIterableIterator<Multipart>) {
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
      || failureCode(error) === 'FST_REQ_FILE_TOO_LARGE') {
      throw backupUploadError('Файл резервной копии превышает 64 МиБ.', { tooLarge: true });
    }
    if (failureCode(error).startsWith('KNOWLEDGE_')) {
      throw error;
    }
    throw backupUploadError('Multipart-загрузка резервной копии повреждена.');
  }

  const single = files[0];
  if (files.length !== 1 || !single || single.fieldname !== 'file') {
    throw backupUploadError('Нужен ровно один файл резервной копии.');
  }
  return { bytes: single.bytes, fields };
}

function parsedApplyFields(fields: Record<string, string>): KnowledgeApplyInput {
  let resolutions: unknown;
  try {
    resolutions = JSON.parse(String(fields.resolutions));
  } catch {
    throw backupUploadError('Решения импорта должны быть JSON-массивом.');
  }
  if (!Array.isArray(resolutions)) {
    throw backupUploadError('Решения импорта должны быть JSON-массивом.');
  }
  return importApplyFields({ snapshotHash: fields.snapshotHash, resolutions });
}

function sendError(reply: FastifyReply, error: unknown, log?: FastifyBaseLogger): FastifyReply {
  const code = failureCode(error);
  if (code === 'KNOWLEDGE_NOT_FOUND') {
    return reply.code(404).send({ error: 'not_found', message: 'Запись не найдена.' });
  }
  if (code === 'KNOWLEDGE_CONFLICT') {
    return reply.code(409).send({
      error: 'knowledge_conflict',
      message: 'Запись уже изменена в другом окне.',
      currentRevision: failure(error).currentRevision,
    });
  }
  if (code === 'KNOWLEDGE_INVALID_ARGUMENTS') {
    return reply.code(400).send({
      error: 'invalid_arguments',
      message: String(failure(error).message ?? ''),
    });
  }
  if (code === 'KNOWLEDGE_BACKUP_TOO_LARGE') {
    return reply.code(413).send({
      error: 'backup_too_large',
      message: String(failure(error).message ?? ''),
    });
  }
  if (code === 'KNOWLEDGE_IMPORT_STALE') {
    return reply.code(409).send({
      error: 'knowledge_import_stale',
      message: 'Экспорт или база изменились. Проверьте новый план импорта.',
      preview: failure(error).preview,
    });
  }
  log?.error?.({ err: error }, 'API знаний: хранилище недоступно');
  return reply.code(503).send({
    error: 'knowledge_unavailable',
    reason: failure(error).reasonCode || 'storage',
    message: 'Хранилище знаний сейчас недоступно.',
  });
}

/** HTTP-модуль оставляет весь CRUD за общим auth guard приложения. */
export default async function knowledgeModule(
  fastify: FastifyInstance,
  { knowledge, transfer }: KnowledgeModuleOptions,
): Promise<void> {
  fastify.addHook('onRequest', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (fastify.pluginEnabled?.('knowledge') !== true) {
      return reply.code(404).send({
        error: 'plugin_disabled',
        message: 'Плагин «Знания» выключен.',
      });
    }
  });

  fastify.get<{ Querystring: KnowledgeQueryString }>('/api/knowledge', async (request, reply) => {
    try {
      return await knowledge.list(filters(request.query));
    } catch (error) {
      return sendError(reply, error, fastify.log);
    }
  });

  fastify.get<{ Querystring: KnowledgeQueryString }>(
    '/api/knowledge/search',
    async (request, reply) => {
      try {
        return await knowledge.search(filters(request.query, { search: true }));
      } catch (error) {
        return sendError(reply, error, fastify.log);
      }
    },
  );

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

  fastify.get<{ Params: KnowledgeIdParams }>('/api/knowledge/:id', async (request, reply) => {
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

  fastify.post<{ Body: unknown }>('/api/knowledge', async (request, reply) => {
    try {
      const record = await knowledge.create(bodyFields(request.body));
      return reply.code(201).send({ record });
    } catch (error) {
      return sendError(reply, error, fastify.log);
    }
  });

  fastify.put<{ Params: KnowledgeIdParams; Body: unknown }>(
    '/api/knowledge/:id',
    async (request, reply) => {
      try {
        const record = await knowledge.update(
          String(request.params.id),
          bodyFields(request.body, { revision: true }),
        );
        return { record };
      } catch (error) {
        return sendError(reply, error, fastify.log);
      }
    },
  );

  fastify.delete<{ Params: KnowledgeIdParams; Body: unknown }>(
    '/api/knowledge/:id',
    async (request, reply) => {
      try {
        return await knowledge.delete(String(request.params.id), {
          expectedRevision: asRecord(request.body).expectedRevision,
        });
      } catch (error) {
        return sendError(reply, error, fastify.log);
      }
    },
  );
}

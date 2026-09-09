// Рабочий tool «Знания» для агента: поиск, чтение и правка проверенных фактов.
// Область (проект, чат, режим прав) агент не выбирает — её задаёт доверенный сервер,
// а результат чистится до объявленной формы, чтобы в ленту не попало лишнее поле.

export interface WorkToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface KnowledgeToolRecord {
  repository: string;
  kind: string;
  title: string;
  body: string;
  tags: string[];
}

export interface KnowledgeToolSearchInput {
  action: 'search';
  query: string;
  repository?: string;
  tags?: string[];
  limit?: number;
}

export interface KnowledgeToolReadInput {
  action: 'read';
  id: string;
}

export interface KnowledgeToolWriteInput {
  action: 'write';
  id?: string;
  revision?: number;
  record: KnowledgeToolRecord;
}

export type KnowledgeToolInput =
  | KnowledgeToolSearchInput
  | KnowledgeToolReadInput
  | KnowledgeToolWriteInput;

export interface KnowledgeToolScope {
  projectId: string | null;
  chatKey?: string;
  permissionMode?: string;
}

export interface KnowledgeToolOptions {
  knowledgeInvoke?: (scope: KnowledgeToolScope, input: KnowledgeToolInput) => Promise<unknown>;
  knowledgeProjectId?: unknown;
  projectId?: unknown;
  chatKey?: unknown;
  permissionMode?: unknown;
}

interface KnowledgeToolProvenance {
  actor: string;
  channel: string;
  ref: string;
}

interface KnowledgeToolSafeRecord {
  id: string;
  project: string;
  repository: string;
  kind: string;
  title: string;
  body: string;
  tags: string[];
  updatedAt: string;
  revision: number;
  provenance?: KnowledgeToolProvenance | null;
}

interface KnowledgeToolFailure extends Record<string, unknown> {
  ok: false;
  error: string;
}

interface KnowledgeToolSearchResult {
  ok: true;
  items: {
    id: string;
    title: string;
    tags: string[];
    fragment: string;
  }[];
}

interface KnowledgeToolRecordResult {
  ok: true;
  record: KnowledgeToolSafeRecord;
}

export type KnowledgeToolResult =
  | KnowledgeToolFailure
  | KnowledgeToolSearchResult
  | KnowledgeToolRecordResult;

const descriptor: WorkToolDescriptor = {
  name: 'knowledge_search',
  description: 'Искать, читать и править проверенные знания.',
  inputSchema: {
    type: 'object',
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'query'],
        properties: {
          action: { const: 'search' },
          query: { type: 'string', description: 'Текст поиска' },
          repository: { type: 'string', description: 'Фильтр логического репозитория' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Точные теги' },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'id'],
        properties: {
          action: { const: 'read' },
          id: { type: 'string', description: 'UUID записи для чтения' },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'record'],
        properties: {
          action: { const: 'write' },
          record: {
            type: 'object',
            additionalProperties: false,
            required: ['repository', 'kind', 'title', 'body', 'tags'],
            properties: {
              repository: { type: 'string' },
              kind: { type: 'string' },
              title: { type: 'string' },
              body: { type: 'string' },
              tags: { type: 'array', minItems: 1, items: { type: 'string' } },
            },
          },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'id', 'revision', 'record'],
        properties: {
          action: { const: 'write' },
          id: { type: 'string', minLength: 1, description: 'UUID изменяемой записи' },
          revision: { type: 'integer', minimum: 1 },
          record: {
            type: 'object',
            additionalProperties: false,
            required: ['repository', 'kind', 'title', 'body', 'tags'],
            properties: {
              repository: { type: 'string' },
              kind: { type: 'string' },
              title: { type: 'string' },
              body: { type: 'string' },
              tags: { type: 'array', minItems: 1, items: { type: 'string' } },
            },
          },
        },
      },
    ],
  },
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

/**
 * Ответ брокера обрезается до объявленной формы: агент видит только те поля, которые
 * ему обещаны, а числа и флаги приводятся к своему типу, а не к тому, что пришло.
 */
function safeResult(value: unknown, action: string): KnowledgeToolResult {
  const source = asRecord(value);

  if (source.ok !== true) {
    const result: KnowledgeToolFailure = {
      ok: false,
      error: String(source.error || 'knowledge_unavailable'),
    };
    for (const key of ['reason', 'comment', 'currentRevision', 'committed', 'id', 'revision']) {
      if (source[key] !== undefined) {
        result[key] = ['currentRevision', 'revision'].includes(key)
          ? Number(source[key])
          : (key === 'committed' ? Boolean(source[key]) : String(source[key]));
      }
    }
    return result;
  }

  if (action === 'search') {
    return {
      ok: true,
      items: (Array.isArray(source.items) ? source.items : []).map((item: unknown) => {
        const entry = asRecord(item);
        return {
          id: String(entry.id || ''),
          title: String(entry.title || ''),
          tags: Array.isArray(entry.tags) ? entry.tags.map(String) : [],
          fragment: String(entry.fragment || ''),
        };
      }),
    };
  }

  const record = asRecord(source.record);
  const safeRecord: KnowledgeToolSafeRecord = {
    id: String(record.id || ''),
    project: String(record.project || ''),
    repository: String(record.repository || ''),
    kind: String(record.kind || ''),
    title: String(record.title || ''),
    body: String(record.body || ''),
    tags: Array.isArray(record.tags) ? record.tags.map(String) : [],
    updatedAt: String(record.updatedAt || ''),
    revision: Number(record.revision) || 0,
  };
  if (record.provenance === null) {
    safeRecord.provenance = null;
  } else if (record.provenance && typeof record.provenance === 'object') {
    const provenance = asRecord(record.provenance);
    safeRecord.provenance = {
      actor: String(provenance.actor || ''),
      channel: String(provenance.channel || ''),
      ref: String(provenance.ref || ''),
    };
  }
  return { ok: true, record: safeRecord };
}

/**
 * Приводит запрос агента к одной из четырёх объявленных форм. Всё, что не сходится с
 * формой, отбрасывается целиком: догадываться о намерении по половине полей нельзя.
 */
function normalize(input: unknown): KnowledgeToolInput | null {
  const source = asRecord(input);
  const action = typeof source.action === 'string' ? source.action : '';

  if (action === 'read') {
    return source.id ? { action, id: String(source.id) } : null;
  }

  if (action === 'write') {
    const draft = asRecord(source.record);
    if (!source.record || typeof source.record !== 'object' || Array.isArray(source.record)
      || typeof draft.repository !== 'string' || !draft.repository.trim()
      || typeof draft.kind !== 'string' || !draft.kind.trim()
      || typeof draft.title !== 'string' || !draft.title.trim()
      || typeof draft.body !== 'string' || !Array.isArray(draft.tags) || !draft.tags.length) {
      return null;
    }
    const record: KnowledgeToolRecord = {
      repository: draft.repository,
      kind: draft.kind,
      title: draft.title,
      body: draft.body,
      tags: draft.tags.map(String),
    };
    if (Object.hasOwn(source, 'id')) {
      const id = typeof source.id === 'string' ? source.id.trim() : '';
      const revision = Number(source.revision);
      return id && Number.isInteger(revision) && revision > 0
        ? { action, id, revision, record }
        : null;
    }
    return source.revision === undefined ? { action, record } : null;
  }

  if (action !== 'search') {
    return null;
  }

  const search: KnowledgeToolSearchInput = { action, query: String(source.query || '') };
  if (source.repository) {
    search.repository = String(source.repository);
  }
  if (Array.isArray(source.tags)) {
    search.tags = source.tags.map(String);
  }
  if (source.limit !== undefined) {
    search.limit = Number(source.limit);
  }
  return search;
}

/** Поиск знаний также получает область только от доверенного сервера. */
async function invoke(options: KnowledgeToolOptions, input: unknown = {}): Promise<KnowledgeToolResult> {
  const safeInput = normalize(input);
  if (!safeInput || typeof options.knowledgeInvoke !== 'function') {
    return safeInput
      ? { ok: false, error: 'knowledge_unavailable' }
      : { ok: false, error: 'invalid_arguments' };
  }
  const projectId = options.knowledgeProjectId === undefined
    ? options.projectId
    : options.knowledgeProjectId;
  const scope: KnowledgeToolScope = {
    projectId: projectId ? String(projectId) : null,
  };
  if (options.chatKey) {
    scope.chatKey = String(options.chatKey);
  }
  if (options.permissionMode) {
    scope.permissionMode = String(options.permissionMode);
  }
  return safeResult(await options.knowledgeInvoke(scope, safeInput), safeInput.action);
}

export default { descriptor, implicit: ['kimi'], invoke };

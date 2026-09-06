const descriptor = {
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

function safeResult(value, action) {
  if (value?.ok !== true) {
    const result = { ok: false, error: String(value?.error || 'knowledge_unavailable') };
    for (const key of ['reason', 'comment', 'currentRevision', 'committed', 'id', 'revision']) {
      if (value?.[key] !== undefined) {
        result[key] = ['currentRevision', 'revision'].includes(key)
          ? Number(value[key])
          : (key === 'committed' ? Boolean(value[key]) : String(value[key]));
      }
    }
    return result;
  }
  if (action === 'search') {
    return {
      ok: true,
      items: (Array.isArray(value.items) ? value.items : []).map((item) => ({
        id: String(item?.id || ''),
        title: String(item?.title || ''),
        tags: Array.isArray(item?.tags) ? item.tags.map(String) : [],
        fragment: String(item?.fragment || ''),
      })),
    };
  }
  const record = value.record || {};
  const safeRecord = {
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
    safeRecord.provenance = {
      actor: String(record.provenance.actor || ''),
      channel: String(record.provenance.channel || ''),
      ref: String(record.provenance.ref || ''),
    };
  }
  return { ok: true, record: safeRecord };
}

function normalize(input = {}) {
  const action = ['search', 'read', 'write'].includes(input.action) ? input.action : '';
  if (!action) {
    return null;
  }
  if (action === 'read') {
    return input.id ? { action, id: String(input.id) } : null;
  }
  if (action === 'write') {
    const source = input.record;
    if (!source || typeof source !== 'object' || Array.isArray(source)
      || typeof source.repository !== 'string' || !source.repository.trim()
      || typeof source.kind !== 'string' || !source.kind.trim()
      || typeof source.title !== 'string' || !source.title.trim()
      || typeof source.body !== 'string' || !Array.isArray(source.tags) || !source.tags.length) {
      return null;
    }
    const record = {
      repository: source.repository,
      kind: source.kind,
      title: source.title,
      body: source.body,
      tags: source.tags.map(String),
    };
    if (Object.hasOwn(input, 'id')) {
      const id = typeof input.id === 'string' ? input.id.trim() : '';
      const revision = Number(input.revision);
      return id && Number.isInteger(revision) && revision > 0
        ? { action, id, revision, record }
        : null;
    }
    return input.revision === undefined ? { action, record } : null;
  }
  return {
    action,
    query: String(input.query || ''),
    ...(input.repository ? { repository: String(input.repository) } : {}),
    ...(Array.isArray(input.tags) ? { tags: input.tags.map(String) } : {}),
    ...(input.limit !== undefined ? { limit: Number(input.limit) } : {}),
  };
}

/** Поиск знаний также получает область только от доверенного сервера. */
async function invoke(options, input = {}) {
  const safeInput = normalize(input);
  if (!safeInput || typeof options.knowledgeInvoke !== 'function') {
    return safeInput
      ? { ok: false, error: 'knowledge_unavailable' }
      : { ok: false, error: 'invalid_arguments' };
  }
  const projectId = options.knowledgeProjectId === undefined
    ? options.projectId
    : options.knowledgeProjectId;
  const scope = {
    projectId: projectId ? String(projectId) : null,
    ...(options.chatKey ? { chatKey: String(options.chatKey) } : {}),
    ...(options.permissionMode ? { permissionMode: String(options.permissionMode) } : {}),
  };
  return safeResult(await options.knowledgeInvoke(scope, safeInput), safeInput.action);
}

export default { descriptor, implicit: ['kimi'], invoke };

const SOURCE_DOCUMENT_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function safeFailure(error) {
  if (error?.code === 'KNOWLEDGE_NOT_FOUND') {
    return { ok: false, error: 'not_found' };
  }
  if (error?.code === 'KNOWLEDGE_INVALID_ARGUMENTS') {
    return { ok: false, error: 'invalid_arguments' };
  }
  if (error?.code === 'KNOWLEDGE_CONFLICT') {
    return {
      ok: false,
      error: 'knowledge_conflict',
      currentRevision: error.currentRevision,
    };
  }
  return {
    ok: false,
    error: 'knowledge_unavailable',
    reason: error?.reasonCode || 'storage',
  };
}

function writeRecord(input) {
  const record = input && typeof input === 'object' && !Array.isArray(input)
    ? {
      repository: String(input.repository || '').trim(),
      kind: String(input.kind || '').trim(),
      title: String(input.title || '').trim(),
      body: typeof input.body === 'string' ? input.body : '',
      tags: Array.isArray(input.tags) ? input.tags.map((tag) => String(tag).trim()) : [],
    }
    : null;
  if (!record || typeof input.body !== 'string' || !record.repository || !record.kind
    || !record.title || !record.tags.length
    || record.tags.some((tag) => !tag)
    || !SOURCE_DOCUMENT_RE.test(record.tags[0])) {
    return null;
  }
  return record;
}

function sourceDocument(record) {
  const value = String(record?.tags?.[0] || '');
  return SOURCE_DOCUMENT_RE.test(value) ? value : '';
}

/**
 * Правка знания подчиняется режиму файловых прав. Общий callback показывает
 * человеку точное содержимое; отсутствие канала подтверждения закрывает запись.
 * Пустой режим также требует спроса: sandbox исполнителя не разрешает сам по себе
 * запись в серверную БД и карты за пределами его рабочего каталога.
 */
async function authorizeWrite(scope, context, previous, value) {
  if (context.signal?.aborted || context.isCurrent?.() === false) {
    return { ok: false, error: 'permission_denied', reason: 'turn_inactive' };
  }
  const mode = scope.permissionMode || 'default';
  if (mode === 'plan') {
    return { ok: false, error: 'permission_denied', reason: 'plan_read_only' };
  }
  if (['acceptEdits', 'dontAsk', 'bypassPermissions', 'yolo'].includes(mode)) {
    return { ok: true, prompted: false };
  }
  if (typeof context.onPermission !== 'function') {
    return { ok: false, error: 'permission_denied', reason: 'approval_unavailable' };
  }
  const answer = await context.onPermission({
    tool: previous ? 'изменение знания' : 'создание знания',
    input: {
      description: value.title,
      project: previous?.project || scope.projectId,
      repository: value.repository,
      recordKind: value.kind,
      tags: [...value.tags],
      ...(previous ? { id: previous.id, revision: previous.revision } : {}),
      diff: { old: previous?.body || '', new: value.body },
    },
    acceptsComment: true,
    canRemember: false,
    signal: context.signal,
    raw: { toolCall: { kind: 'edit', title: value.title } },
  });
  if (answer?.allow !== true) {
    return {
      ok: false,
      error: 'permission_denied',
      reason: 'user_denied',
      ...(answer?.comment ? { comment: String(answer.comment) } : {}),
    };
  }
  return { ok: true, prompted: true };
}

/**
 * Broker проверяет живой plugin gate перед каждой операцией и навязывает
 * server-owned project scope. Ошибки SQLite и пути остаются только в журнале.
 */
export function createKnowledgeBroker({ pluginEnabled, knowledge, transfer, log } = {}) {
  return {
    async invoke(scope = {}, input = {}, context = {}) {
      if (pluginEnabled?.('knowledge') !== true) {
        return { ok: false, error: 'plugin_disabled' };
      }
      try {
        if (input.action === 'search') {
          const result = await knowledge.search({
            query: String(input.query || ''),
            ...(scope.projectId ? { project: String(scope.projectId) } : {}),
            ...(input.repository ? { repository: String(input.repository) } : {}),
            ...(Array.isArray(input.tags) ? { tags: input.tags } : {}),
            ...(input.limit !== undefined ? { limit: Number(input.limit) } : {}),
          });
          return { ok: true, items: result.items };
        }
        if (input.action === 'read') {
          const record = await knowledge.read(String(input.id || ''));
          if (!record || (scope.projectId && record.project !== scope.projectId)) {
            return { ok: false, error: 'not_found' };
          }
          return { ok: true, record };
        }
        if (input.action === 'write') {
          if (scope.permissionMode === 'plan') {
            return { ok: false, error: 'permission_denied', reason: 'plan_read_only' };
          }
          if (!scope.chatKey) {
            return { ok: false, error: 'chat_scope_unavailable' };
          }
          const value = writeRecord(input.record);
          if (!value) {
            return { ok: false, error: 'invalid_arguments' };
          }
          const hasId = Object.hasOwn(input, 'id');
          const id = typeof input.id === 'string' ? input.id.trim() : '';
          const revision = Number(input.revision);
          if ((hasId && (!id || !Number.isInteger(revision) || revision < 1))
            || (!hasId && input.revision !== undefined)) {
            return { ok: false, error: 'invalid_arguments' };
          }
          const provenance = {
            actor: 'executor',
            channel: 'chat',
            ref: String(scope.chatKey),
          };
          let previous = null;
          if (hasId) {
            previous = await knowledge.read(id);
            if (!previous || (scope.projectId && previous.project !== String(scope.projectId))) {
              return { ok: false, error: 'not_found' };
            }
            if (!sourceDocument(previous)) {
              return { ok: false, error: 'invalid_arguments' };
            }
            if (!String(previous.project || '')) {
              return { ok: false, error: 'invalid_arguments' };
            }
            if (previous.revision !== revision) {
              return { ok: false, error: 'knowledge_conflict', currentRevision: previous.revision };
            }
          } else if (!scope.projectId) {
            return { ok: false, error: 'project_scope_unavailable' };
          }
          const permission = await authorizeWrite(scope, context, previous, value);
          if (!permission.ok) {
            return permission;
          }
          if (hasId && permission.prompted) {
            const current = await knowledge.read(id);
            if (!current || current.project !== previous.project) {
              return { ok: false, error: 'not_found' };
            }
            if (current.revision !== revision) {
              return { ok: false, error: 'knowledge_conflict', currentRevision: current.revision };
            }
          }
          if (pluginEnabled?.('knowledge') !== true) {
            return { ok: false, error: 'plugin_disabled' };
          }
          if (context.signal?.aborted || context.isCurrent?.() === false) {
            return { ok: false, error: 'permission_denied', reason: 'turn_inactive' };
          }
          const project = String(previous?.project || scope.projectId);
          const record = hasId
            ? await knowledge.update(id, { ...value, project, expectedRevision: revision, provenance })
            : await knowledge.create({ ...value, project, provenance });
          const sourceDocuments = [...new Set([
            sourceDocument(previous),
            sourceDocument(record),
          ].filter(Boolean))];
          try {
            await transfer.updateMaps({ project: record.project, sourceDocuments });
          } catch (error) {
            log?.error?.({ err: error }, 'broker знаний: запись сохранена, карта недоступна');
            return {
              ok: false,
              error: 'maps_refresh_failed',
              committed: true,
              id: record.id,
              revision: record.revision,
            };
          }
          return { ok: true, record };
        }
        return { ok: false, error: 'invalid_arguments' };
      } catch (error) {
        log?.error?.({ err: error }, 'broker знаний: операция завершилась ошибкой');
        return safeFailure(error);
      }
    },
  };
}

export default createKnowledgeBroker;

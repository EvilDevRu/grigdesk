const descriptor = {
  name: 'supervised_db',
  description: 'Показать доступные БД, схему или выполнить запрос под надзором человека.',
  inputSchema: {
    type: 'object',
    required: ['action'],
    properties: {
      action: { type: 'string', enum: ['list', 'schema', 'query'] },
      label: { type: 'string', description: 'Метка соединения' },
      role: { type: 'string', description: 'Роль соединения' },
      text: { type: 'string', description: 'Текст запроса' },
      params: { type: 'array', description: 'Параметры запроса' },
    },
  },
};

function safeResult(value) {
  if (Array.isArray(value)) {
    return value.map((item) => ({
      label: String(item?.label || ''),
      role: String(item?.role || ''),
      engine: String(item?.engine || ''),
    }));
  }
  const fields = [
    'ok', 'error', 'comment', 'rows', 'shownRows', 'totalRows', 'shownBytes',
    'totalBytes', 'truncated', 'notice', 'untrusted', 'schema',
  ];
  return Object.fromEntries(fields
    .filter((key) => value?.[key] !== undefined)
    .map((key) => [key, value[key]]));
}

/** DB-tool присутствует только в новом snapshot включённого системного плагина. */
async function invoke(options, input = {}) {
  if (!options.projectId) {
    return input.action === 'list'
      ? []
      : { ok: false, error: 'project_scope_unavailable' };
  }
  const scope = {
    projectId: String(options.projectId),
    ...(options.chatKey ? { chatKey: String(options.chatKey) } : {}),
  };
  const value = typeof options.dbInvoke === 'function'
    ? await options.dbInvoke(scope, input)
    : { ok: false, error: 'not_available' };
  return safeResult(value);
}

export default {
  descriptor,
  enabled: (options) => options.pluginEnabled?.('db') === true,
  invoke,
};

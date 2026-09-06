const descriptor = {
  name: 'supervised_ssh',
  description: 'Показать разрешённые живые сессии или запросить выполнение команды под надзором.',
  inputSchema: {
    type: 'object',
    required: ['action'],
    properties: {
      action: { type: 'string', enum: ['list', 'exec'] },
      label: { type: 'string', description: 'Метка нужной сессии' },
      role: { type: 'string', description: 'Роль нужной сессии' },
      command: { type: 'string', description: 'Команда целиком; человек подтвердит её отдельно' },
    },
  },
};

function safeResult(value) {
  if (Array.isArray(value)) {
    return value.map((item) => ({
      label: String(item?.label || ''),
      role: String(item?.role || ''),
    }));
  }
  const keys = [
    'ok', 'error', 'comment', 'output', 'shownBytes', 'totalBytes', 'truncated',
    'notice', 'exitCode', 'signal',
  ];
  const result = {};
  for (const key of keys) {
    if (value?.[key] !== undefined) {
      result[key] = value[key];
    }
  }
  return result;
}

/** Надзорный SSH навязывает модели server-owned проект и чат. */
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
  const value = typeof options.invoke === 'function'
    ? await options.invoke(scope, input)
    : { ok: false, error: 'not_available' };
  return safeResult(value);
}

export default { descriptor, implicit: ['claude', 'kimi'], invoke };

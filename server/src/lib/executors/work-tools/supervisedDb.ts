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

type Payload = Record<string, unknown>;

// Что кокпит даёт инструменту на запуск: проект и чат навязывает сервер, а сам
// вызов уходит в надзорный рубеж, который спросит человека.
interface SupervisedDbOptions {
  projectId?: string;
  chatKey?: string;
  pluginEnabled?: (id: string) => boolean;
  dbInvoke?: (scope: Payload, input: Payload) => Promise<unknown>;
}

/**
 * Модель получает только объявленные поля. Всё остальное отбрасывается здесь, а не
 * у вызывающего: через этот результат проходит ответ чужой базы, и добавить в него
 * лишнее поле должно быть невозможно случайно.
 */
function safeResult(value: unknown): unknown {
  if (Array.isArray(value)) {
    return (value as Payload[]).map((item) => ({
      label: String(item?.label || ''),
      role: String(item?.role || ''),
      engine: String(item?.engine || ''),
    }));
  }
  const fields = [
    'ok', 'error', 'comment', 'rows', 'shownRows', 'totalRows', 'shownBytes',
    'totalBytes', 'truncated', 'notice', 'untrusted', 'schema',
  ];
  const source = (value ?? {}) as Payload;

  return Object.fromEntries(fields
    .filter((key) => source[key] !== undefined)
    .map((key) => [key, source[key]]));
}

/** DB-tool присутствует только в новом snapshot включённого системного плагина. */
async function invoke(options: SupervisedDbOptions, input: Payload = {}): Promise<unknown> {
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
  enabled: (options: SupervisedDbOptions) => options.pluginEnabled?.('db') === true,
  invoke,
};

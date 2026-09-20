import type {
  AgentSessionView,
  BrokerInput,
  BrokerResult,
} from '../../ssh/broker.ts';

// Что кокпит даёт инструменту на запуск. Проект и чат навязывает сервер: агент
// называет только сессию, а область работы выбрать не может.
interface SupervisedSshOptions {
  projectId?: string;
  chatKey?: string;
  invoke?: (
    scope: { projectId: string; chatKey?: string },
    input: BrokerInput,
  ) => Promise<BrokerResult | AgentSessionView[]>;
}

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

/**
 * Модель получает только объявленные поля. Всё остальное отбрасывается здесь, а не
 * у вызывающего: через этот результат проходит вывод чужой машины, и добавить в
 * него лишнее поле должно быть невозможно случайно.
 */
function safeResult(value: BrokerResult | AgentSessionView[]): BrokerResult | AgentSessionView[] {
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
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (source?.[key] !== undefined) {
      result[key] = source[key];
    }
  }

  return result as BrokerResult;
}

/** Надзорный SSH навязывает модели server-owned проект и чат. */
async function invoke(
  options: SupervisedSshOptions,
  input: BrokerInput = {},
): Promise<BrokerResult | AgentSessionView[]> {
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

export default { descriptor, implicit: ['claude', 'kimi', 'deepseek'], invoke };

import type {
  AgentSessionView,
  BrokerInput,
  BrokerResult,
  BrokerScope,
} from '../../ssh/broker.ts';

// Чат для подтверждений навязывает сервер. Агент выбирает одну из живых сессий,
// которым человек разрешил команды; рабочая папка на этот допуск не влияет.
interface SupervisedSshOptions {
  chatKey?: string;
  invoke?: (
    scope: BrokerScope,
    input: BrokerInput,
  ) => Promise<BrokerResult | AgentSessionView[]>;
}

const descriptor = {
  name: 'supervised_ssh',
  description: 'Показать разрешённые SSH-сессии всех проектов или запросить команду под надзором. '
    + 'Выбирай sessionId из list; метка и роль подходят только при единственном совпадении.',
  inputSchema: {
    type: 'object',
    required: ['action'],
    properties: {
      action: { type: 'string', enum: ['list', 'exec'] },
      sessionId: { type: 'string', description: 'Идентификатор нужной сессии из list' },
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
      sessionId: String(item?.sessionId || ''),
      projectId: String(item?.projectId || ''),
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

/**
 * SSH доступен независимо от выбранного проекта или папки разговора.
 * Сервер сохраняет только адрес доставки подтверждения, а допуск проверяет broker.
 */
async function invoke(
  options: SupervisedSshOptions,
  input: BrokerInput = {},
): Promise<BrokerResult | AgentSessionView[]> {
  const scope = {
    ...(options.chatKey ? { chatKey: String(options.chatKey) } : {}),
  };
  const value = typeof options.invoke === 'function'
    ? await options.invoke(scope, input)
    : { ok: false, error: 'not_available' };
  return safeResult(value);
}

export default { descriptor, implicit: ['claude', 'kimi', 'deepseek'], invoke };

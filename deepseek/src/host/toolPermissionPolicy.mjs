/**
 * Решение по одному вызову не исполняет инструмент и не читает файловую систему.
 * Проверенные факты о путях и служебных операциях поставляет владелец запуска.
 * @param {{mode: string, name: string, args: Record<string, unknown>, trusted: boolean,
 * pathFacts?: {inside: boolean, sensitive: boolean, uncertain: boolean},
 * workActions?: Record<string, Record<string, string>>}} input
 */
export function decideToolPermission({ mode, name, args, pathFacts = undefined, trusted, workActions = {} }) {
  if (!['default', 'auto', 'read-only'].includes(mode)) {
    return { kind: 'deny', reason: 'Неизвестный режим разрешений' };
  }

  const readonly = mode === 'read-only';

  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { kind: 'deny', reason: 'Некорректные аргументы инструмента' };
  }

  if (trusted && Object.hasOwn(workActions, name)) {
    const action = workActions[name]?.[args.action];

    if (action === 'read' || (action === 'broker' && !readonly)) {
      return { kind: 'allow' };
    }

    return { kind: 'deny', reason: 'Рабочая операция недоступна в этом режиме' };
  }

  if (trusted && INTERNAL_TOOLS.has(name)) {
    return { kind: 'allow' };
  }

  if (readonly) {
    return { kind: 'deny', reason: 'Режим «Только чтение» запрещает это действие' };
  }

  if (trusted && MUTATING_TOOLS.has(name)
    && (Object.hasOwn(args, 'sandbox_permissions') || Object.hasOwn(args, 'justification'))) {
    if (args.sandbox_permissions !== 'danger-full-access'
      || typeof args.justification !== 'string' || !args.justification.trim()) {
      return { kind: 'deny', reason: 'Некорректный запрос расширения песочницы' };
    }

    return { kind: 'native', reason: 'Расширение песочницы подтверждает человек' };
  }

  if (trusted && mode === 'auto' && name === 'bash') {
    // Штатный bash передаёт обычную команду в workspace-write sandbox.
    // Явное расширение проверяет approveEscalation внутри инструмента до запуска.
    return { kind: 'native' };
  }

  if (trusted && mode === 'auto' && ['write', 'edit'].includes(name)
    && pathFacts?.inside === true && pathFacts.sensitive === false && pathFacts.uncertain === false) {
    return { kind: 'allow' };
  }

  return { kind: 'ask', reason: 'Действие требует разрешения пользователя' };
}

const INTERNAL_TOOLS = new Set([
  'read', 'grep', 'glob', 'read_image', 'skill', 'todo_write',
  'web_search', 'web_fetch',
  'get_goal', 'create_goal', 'update_goal', 'ask_user_question', 'exit_plan_mode',
]);
const MUTATING_TOOLS = new Set(['bash', 'write', 'edit']);


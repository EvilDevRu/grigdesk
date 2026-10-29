/**
 * Нормализация вызывается до общей очистки неизвестного режима чата.
 * Отдельный контракт не позволяет молча заменить ошибочный выбор более широкими правами.
 */
export function normalizeDeepSeekPermissionMode(value: unknown) {
  if (value === undefined || value === '') {
    return { ok: true as const, mode: 'default' };
  }

  if (typeof value === 'string' && ['default', 'auto', 'read-only'].includes(value)) {
    return { ok: true as const, mode: value };
  }

  return { ok: false as const, message: 'Неизвестный режим разрешений DeepSeek' };
}

export type DeepSeekWorkActions = Record<string, Record<string, 'read' | 'broker'>>;

const WORK_ACTIONS: DeepSeekWorkActions = {
  supervised_ssh: { list: 'read', exec: 'broker' },
  supervised_db: {
    list: 'read',
    schema: 'read',
    query: 'broker',
  },
};

/**
 * Только descriptors этого запуска дают имя служебному MCP и таблицу его действий.
 * Проектный сервер с похожим префиксом не получает доверия по модельным annotations.
 */
export function deepSeekWorkActions(workTools: unknown): DeepSeekWorkActions {
  const descriptors = (workTools as { descriptors?: unknown } | null)?.descriptors;
  const actions: DeepSeekWorkActions = {};

  if (!Array.isArray(descriptors)) {
    return actions;
  }

  for (const descriptor of descriptors) {
    const name = String(descriptor?.name || descriptor?.function?.name || '');

    if (Object.hasOwn(WORK_ACTIONS, name)) {
      actions[`mcp__grigdesk-work__${name}`] = { ...WORK_ACTIONS[name] };
    }
  }

  return actions;
}

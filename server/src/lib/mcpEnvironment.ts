export type McpEnvironment = Record<string, string> | readonly { name: string; value: string }[];

/**
 * Переводит типизированное окружение MCP из ACP-пар в объект; готовый объект сохраняет.
 * Пустой массив даёт {}, повтор имени берёт последнее значение. Валидация остаётся у входа.
 */
export function mcpEnvironmentRecord(env: McpEnvironment): Record<string, string> {
  if (Array.isArray(env)) {
    return Object.fromEntries(env.map((entry) => [entry.name, entry.value]));
  }

  return env as Record<string, string>;
}

import { parse, stringify } from 'smol-toml';

export const COMMAND_MCP = 'grigdesk-command';
export const COMMAND_TOOL = 'run_command';
export const COMMAND_NAME = `mcp__${COMMAND_MCP}__${COMMAND_TOOL}`;

export interface CommandProfile {
  content: string;
  commandsAllowed: boolean;
  blockedReason: string;
}

/**
 * Проверяет форму таблицы без приведения ошибочных значений к пустой политике.
 * Пропущенная таблица разрешена только как штатное отсутствие настройки.
 */
function table(value: unknown): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Некорректная таблица конфигурации Kimi');
  }

  return value as Record<string, unknown>;
}

/**
 * Строковые списки сохраняются целиком, включая неизвестные будущие имена tools.
 * Повреждённый список не должен расширить доступ агента.
 */
function names(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error('Некорректный список инструментов Kimi');
  }

  return value as string[];
}

/**
 * Консервативно обнаруживает правила, которые требуют нативного Bash.
 * Их выполнение не подменяется приблизительной собственной интерпретацией.
 */
export function hasUserShellPolicy(value: unknown): boolean {
  const document = table(value);
  const permission = table(document.permission);
  const rules = permission.rules;

  if (rules !== undefined && (!Array.isArray(rules) || rules.length > 0)) {
    return true;
  }
  if (permission.deny !== undefined || permission.allow !== undefined || permission.ask !== undefined) {
    return true;
  }
  if (document.hooks === undefined) {
    return false;
  }
  if (!Array.isArray(document.hooks)) {
    throw new Error('Некорректные hooks Kimi');
  }

  return document.hooks.some((raw) => {
    const hook = table(raw);

    if (hook.event !== 'PreToolUse') {
      return false;
    }

    try {
      return hook.matcher === undefined || new RegExp(String(hook.matcher)).test('Bash');
    } catch {
      return true;
    }
  });
}

/**
 * Строит только копию конфигурации: native Bash закрывается независимо от режима.
 * Пользовательские ограничения остаются сильнее доступности controlled tool.
 */
export function buildCommandProfile(source: string): CommandProfile {
  const document = parse(source) as unknown as Record<string, unknown>;
  const tools = table(document.tools);
  const enabled = names(tools.enabled);
  const disabled = names(tools.disabled);
  const commandsAllowed = !disabled.includes('Bash')
    && (enabled.length === 0 || enabled.includes('Bash'))
    && !hasUserShellPolicy(document);

  document.tools = {
    ...tools,
    ...(enabled.length && commandsAllowed
      ? { enabled: [...new Set([...enabled, COMMAND_NAME])] } : {}),
    disabled: [...new Set([...disabled, 'Bash'])],
  };

  return {
    content: stringify(document as Parameters<typeof stringify>[0]),
    commandsAllowed,
    blockedReason: commandsAllowed ? '' : 'Пользовательские ограничения Bash требуют отдельной адаптации.',
  };
}

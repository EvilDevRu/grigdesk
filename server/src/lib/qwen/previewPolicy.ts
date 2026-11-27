import path from 'node:path';

import { isRecord } from '../../../../shared/lib/objects.ts';

import { qwenToolAllowed } from './policy.ts';
import { QWEN_SKILLS_MOUNT } from './skills.ts';

const toolNames = new Map([
  ['Agent', 'agent'],
  ['Bash', 'run_shell_command'],
  ['Edit', 'edit'],
  ['Glob', 'glob'],
  ['Grep', 'grep_search'],
  ['Read', 'read_file'],
  ['Skill', 'skill'],
  ['WebFetch', 'web_fetch'],
  ['Write', 'write_file'],
]);

export const qwenPreviewNativeTools = [...toolNames.keys()];

type ToolPolicy = Parameters<typeof qwenToolAllowed>[1] & { skillDirectory?: string };

/**
 * Read/Glob/Grep получают путь к bundle из native описания навыка. Перед проверкой
 * физического корня переводим путь из фиксированной точки монтирования на стороне CLI.
 */
function resolveSkillInput(name: string, input: Record<string, unknown>, directory?: string) {
  const field = name === 'Read' ? 'file_path' : 'path';
  const file = input[field];

  if (!directory || !['Read', 'Glob', 'Grep'].includes(name)
    || typeof file !== 'string' || !path.isAbsolute(file)) {
    return input;
  }

  const relative = path.relative(QWEN_SKILLS_MOUNT, file);

  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return input;
  }

  return { ...input, [field]: path.resolve(directory, relative) };
}

/**
 * Preview передаёт инструмент в `_meta.qwen`, а аргументы в `rawInput`.
 * Решение применяется к вызову активной ACP-сессии по тем же правилам файлов и shell.
 */
export async function qwenPreviewToolAllowed(value: unknown, context: ToolPolicy): Promise<boolean> {
  if (!isRecord(value) || value.sessionId !== context.sessionId || !isRecord(value.toolCall)) {
    return false;
  }

  const tool = value.toolCall;
  const qwen = isRecord(tool._meta) && tool._meta.qwen;

  if (!isRecord(qwen) || typeof qwen.toolName !== 'string' || !isRecord(tool.rawInput)
    || typeof tool.toolCallId !== 'string' || !tool.toolCallId || context.signal?.aborted) {
    return false;
  }

  const name = qwen.toolName;
  const arguments_ = tool.rawInput;
  const mappedName = toolNames.get(name);

  if (!mappedName && !context.mcpServers.some((server) => name.startsWith(`mcp__${server.name}__`))) {
    return false;
  }

  // Рабочие каталоги выдаёт GrigDesk. Запрос агента не может сам выбрать другой корень,
  // рабочее дерево или фоновую сессию с отдельным временем жизни.
  if (name === 'Agent' && (Object.hasOwn(arguments_, 'cwd') || arguments_.isolation === 'worktree'
    || arguments_.run_in_background === true || Object.hasOwn(arguments_, 'name'))) {
    return false;
  }

  if (name === 'Bash' && arguments_.run_in_background === true) {
    return false;
  }

  const allowed = await qwenToolAllowed({
    sessionId: context.sessionId,
    promptId: context.promptId,
    invocationCwd: context.cwd,
    toolCallId: tool.toolCallId,
    toolName: mappedName ?? name,
    arguments: resolveSkillInput(name, arguments_, context.skillDirectory),
  }, context);

  return allowed && !context.signal?.aborted;
}

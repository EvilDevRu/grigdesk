import { promises as fs } from 'node:fs';
import path from 'node:path';

import { isRecord } from '../../../../shared/lib/objects.ts';
import { evaluateDirectCommand } from '../executors/_directSshPolicy.ts';
import type { QwenMcpServer } from './sandbox.ts';

/**
 * Проверка физического родителя работает и для ещё не созданного файла.
 * Симлинк в выбранной папке не расширяет разрешённый корень записи.
 */
async function contained(file: string, roots: readonly string[]): Promise<boolean> {
  let current = path.resolve(file);
  const suffix: string[] = [];

  while (true) {
    try {
      current = path.join(await fs.realpath(current), ...suffix.reverse());

      return roots.some((root) => current === root || current.startsWith(`${root}${path.sep}`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(current) === current) {
        return false;
      }

      suffix.push(path.basename(current));
      current = path.dirname(current);
    }
  }
}

/**
 * Последний guard применяется независимо от native approval, включая yolo.
 * Неизвестный инструмент, чужая identity и неподтверждённый MCP получают запрет.
 */
export async function qwenToolAllowed(value: unknown, context: {
  sessionId: string;
  promptId: string;
  cwd: string;
  mode: string;
  readonlyRoots: string[];
  mcpServers: QwenMcpServer[];
  blockDirectSsh: boolean;
  signal?: AbortSignal;
}): Promise<boolean> {
  if (!isRecord(value) || context.signal?.aborted || value.sessionId !== context.sessionId
    || value.promptId !== context.promptId || value.invocationCwd !== context.cwd
    || typeof value.toolCallId !== 'string' || !isRecord(value.arguments)) {
    return false;
  }

  const name = String(value.toolName || '');
  const args = value.arguments;

  if (name === 'run_shell_command') {
    return context.mode !== 'plan' && typeof args.command === 'string'
      && evaluateDirectCommand(args.command, { blockDirectSsh: context.blockDirectSsh }).verdict === 'allow';
  }

  const reads = ['read_file', 'read_many_files', 'list_directory', 'glob', 'grep_search'];
  const writes = ['write_file', 'edit', 'replace'];

  if (reads.includes(name) || writes.includes(name)) {
    const write = writes.includes(name);
    const file = args.file_path ?? args.absolute_path ?? args.path ?? context.cwd;

    if (typeof file !== 'string' || (write && context.mode === 'plan')) {
      return false;
    }

    return contained(path.resolve(context.cwd, file),
      write ? [context.cwd] : [context.cwd, ...context.readonlyRoots]);
  }

  if (name === 'save_memory' || name === 'ask_user_question' || name === 'task') {
    return false;
  }

  return context.mcpServers.some((server) =>
    name.startsWith(`mcp__${server.name}__`) || name.startsWith(`${server.name}__`));
}

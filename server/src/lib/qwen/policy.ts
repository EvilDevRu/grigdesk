import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isRecord } from '../../../../shared/lib/objects.ts';
import { evaluateDirectCommand } from '../executors/_directSshPolicy.ts';
import type { QwenMcpServer } from './sandbox.ts';

// Имена закреплены за проверенным CLI: новый инструмент не получает права автоматически.
// Служебные записи этих инструментов остаются в отдельном home текущего разговора.
const SESSION_TOOLS = new Set([
  'todo_write',
  'save_memory',
  'manage_memory',
  'search_memory',
  'ask_user_question',
  'enter_plan_mode',
  'exit_plan_mode',
  'agent',
  'task',
  'skill',
  'list_agents',
  'task_stop',
  'task_create',
  'task_update',
  'task_list',
  'team_create',
  'team_delete',
  'team_plan_approval',
  'request_shutdown',
  'send_message',
  'structured_output',
  'cron_create',
  'cron_list',
  'cron_delete',
  'loop_wakeup',
  'get_goal',
  'update_goal',
  'propose_goal',
]);

const MEDIA_TOOLS = new Set([
  'image_gen',
  'zoom_image',
  'display_image',
  'omni_downsample_image',
  'omni_downscale_video',
  'omni_downsample_audio',
  'omni_extract_keyframes',
  'omni_extract_audio',
  'omni_clip_video',
  'omni_convert_image',
  'omni_transcribe_audio',
  'omni_clip_image',
  'omni_clip_audio',
  'omni_caption_image',
  'omni_caption_audio',
  'omni_ocr_image',
  'omni_understand_video_segments',
  'omni_recall_media_memory',
]);

const WORKFLOW_TOOLS = new Set([
  'workflow',
  'artifact',
  'record_artifact',
  'record_source',
  'report_findings',
]);

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
  writableRoots: string[];
  mode: string;
  readonlyRoots: string[];
  mcpServers: QwenMcpServer[];
  blockDirectSsh: boolean;
  hostAccess?: boolean;
  signal?: AbortSignal;
}): Promise<boolean> {
  if (context.hostAccess === true) {
    if (!isRecord(value) || context.signal?.aborted || value.sessionId !== context.sessionId
      || typeof value.toolCallId !== 'string' || !value.toolCallId || !isRecord(value.arguments)) {
      return false;
    }

    const cwd = value.invocationCwd;
    const command = value.arguments.command;
    const shell = value.toolName === 'run_shell_command' || value.toolName === 'monitor';

    if (!shell || context.mode === 'plan' || typeof command !== 'string' || !command
      || (cwd !== undefined && (typeof cwd !== 'string' || !path.isAbsolute(cwd)))) {
      return false;
    }

    return evaluateDirectCommand(command, { blockDirectSsh: context.blockDirectSsh }).verdict === 'allow';
  }

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

  const reads = ['read_file', 'read_many_files', 'list_directory', 'glob', 'grep_search', 'lsp'];
  const writes = ['write_file', 'edit', 'replace', 'notebook_edit'];

  if (reads.includes(name) || writes.includes(name)) {
    const write = writes.includes(name);
    let file = args.file_path ?? args.absolute_path ?? args.path ?? args.filePath
      ?? args.notebook_path ?? context.cwd;

    if (name === 'lsp' && isRecord(args.item) && typeof args.item.uri === 'string') {
      try {
        file = fileURLToPath(args.item.uri);
      } catch {
        return false;
      }
    }

    if (typeof file !== 'string' || (write && context.mode === 'plan')) {
      return false;
    }

    return contained(path.resolve(context.cwd, file),
      write ? context.writableRoots : [...context.writableRoots, ...context.readonlyRoots]);
  }

  if (name === 'web_search' || name === 'web_fetch' || SESSION_TOOLS.has(name)) {
    return true;
  }

  if (MEDIA_TOOLS.has(name) || WORKFLOW_TOOLS.has(name)) {
    // Обработка медиа и workflow могут создавать файлы даже без стандартного write_file.
    // В режиме плана допускаются лишь инструменты чтения и служебное состояние сессии.
    return context.mode !== 'plan';
  }

  return context.mcpServers.some((server) =>
    name.startsWith(`mcp__${server.name}__`) || name.startsWith(`${server.name}__`));
}

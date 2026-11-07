import { createDeepSeekStepNormalizer } from '../deepseek/steps.ts';

const TOOL_NAMES: Record<string, string> = {
  run_shell_command: 'bash',
  read_file: 'read',
  write_file: 'write',
  edit: 'edit',
  grep_search: 'grep',
  glob: 'glob',
};

/**
 * ACP использует общую семантику toolCallId и terminal update, различаются имена tools.
 * Native GigaCode может прислать только terminal с _meta.toolName и diff без старта.
 */
export function createGigaCodeSteps(options: {
  model: string;
  cwd: string;
  mode: string;
}) {
  const normalize = createDeepSeekStepNormalizer(options);

  /**
   * Native имя переводится в существующий словарь ленты до общего ACP normalizer.
   * Id и terminal остаются исходными, поэтому один инструмент не размножается по чанкам.
   */
  const accept = (params: any) => {
    const update = params?.update;

    if (!update || typeof update !== 'object') {
      return [];
    }

    const nativeName = update._meta?.toolName || update.title;
    const diff = Array.isArray(update.content)
      ? update.content.find((block: any) => block?.type === 'diff')
      : null;
    const mapped = {
      ...update,
      title: TOOL_NAMES[nativeName] || nativeName,
      rawInput: update.rawInput || (diff ? {
        file_path: diff.path,
        old_string: diff.oldText,
        new_string: diff.newText,
        content: diff.newText,
      } : undefined),
    };

    return normalize({ update: mapped });
  };

  accept.flush = normalize.flush;

  return accept;
}

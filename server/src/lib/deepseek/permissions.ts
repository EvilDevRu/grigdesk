interface PermissionOption {
  optionId?: string;
  kind?: string;
}

export interface DeepSeekToolContext {
  title?: unknown;
  rawInput?: unknown;
  kind?: unknown;
}

export interface DeepSeekPermissionParams {
  toolCall?: { toolCallId?: unknown };
  options?: unknown;
}

export type DeepSeekPermissionAnswer = {
  outcome?: { outcome?: string; optionId?: unknown };
  allow?: unknown;
  selected?: unknown[];
} | null | undefined;

function optionByKind(params: DeepSeekPermissionParams, kind: string): PermissionOption | undefined {
  const options = Array.isArray(params.options) ? params.options as PermissionOption[] : [];
  return options.find((option) => option?.kind === kind);
}

export function permissionOutcome(
  params: DeepSeekPermissionParams,
  answer: DeepSeekPermissionAnswer,
): { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } } {
  if (answer?.outcome?.outcome === 'cancelled') return { outcome: { outcome: 'cancelled' } };
  if (answer?.outcome?.outcome === 'selected') {
    const wanted = String(answer.outcome.optionId || '');
    const options = Array.isArray(params.options) ? params.options as PermissionOption[] : [];
    if (options.some((option) => option.optionId === wanted)) {
      return { outcome: { outcome: 'selected', optionId: wanted } };
    }
  }

  const kind = answer?.allow === true ? 'allow_once' : 'reject_once';
  const option = optionByKind(params, kind) || optionByKind(params, 'reject_once');
  if (!option?.optionId) return { outcome: { outcome: 'cancelled' } };
  return { outcome: { outcome: 'selected', optionId: option.optionId } };
}

function toolKind(title: string): string {
  if (title === 'bash') return 'execute';
  if (title === 'read') return 'read';
  if (title === 'write' || title === 'edit') return 'edit';
  if (title === 'grep' || title === 'glob') return 'search';
  if (title.startsWith('mcp__')) return 'mcp';
  return 'other';
}

/**
 * Показывает человеку параметры именно проверяемого инструмента без потери содержимого.
 * Native gate требует явного разового решения и не допускает общего автоодобрения.
 */
export function deepSeekPermissionPresentation(
  params: DeepSeekPermissionParams,
  context: DeepSeekToolContext = {},
  explicitUser = false,
) {
  const title = String(context.title || 'Действие DeepSeek');
  const raw = context.rawInput && typeof context.rawInput === 'object'
    ? context.rawInput as Record<string, unknown>
    : {};
  const kind = toolKind(title);
  const command = typeof raw.command === 'string' ? raw.command : undefined;
  const filePath = typeof raw.file_path === 'string' ? raw.file_path : undefined;
  const description = typeof raw.description === 'string'
    ? raw.description
    : typeof raw.justification === 'string'
      ? raw.justification
      : undefined;
  const sandboxPermissions = typeof raw.sandbox_permissions === 'string'
    ? raw.sandbox_permissions
    : undefined;

  return {
    isQuestion: false,
    acceptsComment: false,
    tool: title,
    requiresExplicitUser: explicitUser || kind === 'other' || sandboxPermissions === 'danger-full-access',
    ...(explicitUser ? { canRemember: false } : {}),
    input: {
      kind,
      ...(command ? { command } : {}),
      ...(filePath ? { file_path: filePath } : {}),
      ...(description ? { description } : {}),
      ...(sandboxPermissions ? { sandbox_permissions: sandboxPermissions } : {}),
      ...(title === 'write' && typeof raw.content === 'string' ? { details: raw.content } : {}),
      ...(title === 'edit' && typeof raw.old_string === 'string' && typeof raw.new_string === 'string'
        ? { diff: { old: raw.old_string, new: raw.new_string } } : {}),
      ...(kind === 'mcp' ? { details: raw } : {}),
    },
  };
}

/**
 * ACP-ответ остаётся разовым и отклоняется при отмене, readonly или отсутствии контекста.
 * Gated consumer не наследует прежнее разрешение только по имени служебного MCP.
 */
export async function resolveDeepSeekPermission({
  params,
  context,
  mode,
  factory = false,
  toolPermissions = false,
  workToolNames = new Set<string>(),
  onPermission,
  cancelled = () => false,
  signal,
}: {
  params: DeepSeekPermissionParams;
  context?: DeepSeekToolContext;
  mode: 'read-only' | 'workspace-write';
  factory?: boolean;
  toolPermissions?: boolean;
  workToolNames?: ReadonlySet<string>;
  onPermission?: (presentation: Record<string, unknown>) => Promise<DeepSeekPermissionAnswer>;
  cancelled?: () => boolean;
  signal?: AbortSignal;
}) {
  const title = String(context?.title || '');
  const workPrefix = 'mcp__grigdesk-work__';
  if (factory || mode === 'read-only' || cancelled()) {
    return permissionOutcome(params, { allow: false });
  }
  if (!toolPermissions && title.startsWith(workPrefix) && workToolNames.has(title.slice(workPrefix.length))) {
    return permissionOutcome(params, { allow: true });
  }
  if (toolPermissions && (!context?.title || !context.rawInput || typeof context.rawInput !== 'object')) {
    return permissionOutcome(params, { allow: false });
  }

  const presentation = deepSeekPermissionPresentation(params, context, toolPermissions);
  const answer = onPermission ? await onPermission({ ...presentation, signal }) : { allow: false };
  if (cancelled()) return permissionOutcome(params, { allow: false });
  return permissionOutcome(params, answer);
}

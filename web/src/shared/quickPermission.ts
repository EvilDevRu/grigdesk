export const QUICK_PERMISSION_DETAIL_LIMIT = 400;

export interface QuickPermission {
  detail: string;
}

const DETAIL_KEYS = ['description', 'file_path', 'command', 'details'];

/**
 * Быстрое разрешение допустимо, когда тост показывает весь смысл запроса.
 * Сложные формы оставляют человеку переход в чат для полного просмотра.
 */
export function quickPermission(request: unknown): QuickPermission | null {
  const value = request as Record<string, unknown>;

  if (!request || typeof request !== 'object' || value.kind !== 'perm') {
    return null;
  }
  if (value.origin === 'ssh' || value.origin === 'db') {
    return null;
  }
  if (value.tool === 'ExitPlanMode') {
    return null;
  }

  const input = (value.input || {}) as Record<string, unknown>;

  if (input.plan) {
    return null;
  }
  if (input.kind) {
    return null;
  }
  if (Array.isArray(input.choices) && input.choices.length) {
    return null;
  }
  if (input.diff) {
    return null;
  }
  if (Object.entries(input).some(([key, content]) => !DETAIL_KEYS.includes(key) &&
    content !== null && content !== undefined && content !== '')) {
    return null;
  }

  const detail = DETAIL_KEYS.map((key) => String(input[key] ?? '').trim()).filter(Boolean).join('\n');

  return detail.length > QUICK_PERMISSION_DETAIL_LIMIT ? null : {
    detail
  };
}

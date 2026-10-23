type CodeAction = (action: Record<string, unknown>) => void;

let handler: CodeAction | null = null;

/**
 * Обработчик принадлежит только документу инструмента и снимается при его закрытии.
 * Обычная панель Кода сохраняет прежний локальный переход в чат.
 */
export function setCodeWindowAction(value: CodeAction | null) {
  handler = value;
}

/**
 * Доставляет только подготовленный черновик в главное окно.
 * Отсутствие оконного обработчика оставляет прежний локальный сценарий.
 */
export function sendCodeWindowAction(action: Record<string, unknown>): boolean {
  if (!handler) {
    return false;
  }

  handler({ type: 'code-chat', ...action });

  return true;
}

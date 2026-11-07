import { recordOrEmpty } from '../../../../shared/lib/objects.ts';
import { textOr } from '../../../../shared/lib/text.ts';

interface ApprovalInput {
  kind: string;
  description: string;
  command?: string;
  file_path?: string;
  details?: string;
  diff?: {
    old: string;
    new: string;
  };
}

/**
 * Сервер Kimi передаёт tool_input_display строкой либо объектом ToolInputDisplay.
 * Переводим его в общие поля карточки, сохраняя команды, пути и текст правок без обрезки.
 */
export function kimiServerApprovalInput(approval: Record<string, unknown>): ApprovalInput {
  const raw = approval.tool_input_display;
  const display = recordOrEmpty(raw);
  const kind = textOr(display.kind);
  const legacy = textOr(raw);

  // Общая политика разрешений читает kind. Формат предпросмотра не должен
  // менять тип действия, который передавал runtime до нормализации карточки.
  const input: ApprovalInput = {
    kind: textOr(approval.kind) || textOr(approval.action),
    description: textOr(approval.description) || textOr(display.description)
      || textOr(display.summary) || textOr(approval.action) || legacy,
  };
  const command = textOr(display.command) || textOr(approval.command) || legacy;
  const filePath = textOr(display.path);

  if (command) {
    input.command = command;
  }

  if (filePath) {
    input.file_path = filePath;
  }

  if (kind === 'diff' || (kind === 'file_io' && display.operation === 'edit')) {
    if (typeof display.before === 'string' && typeof display.after === 'string') {
      input.diff = {
        old: display.before,
        new: display.after,
      };
    } else {
      input.details = JSON.stringify(display, null, 2);
    }
  } else if (kind === 'file_io') {
    input.details = textOr(display.content) || textOr(display.detail);
  } else if (kind === 'generic') {
    input.details = typeof display.detail === 'string'
      ? display.detail
      : JSON.stringify(display.detail ?? display, null, 2);
  } else if (typeof raw === 'object' && raw !== null && kind !== 'command') {
    input.details = JSON.stringify(raw, null, 2);
  }

  return input;
}

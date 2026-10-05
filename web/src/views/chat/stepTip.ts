import { formatShellCommand } from '../../shared/shellFormat.ts';

export interface StepTip {
  code: string;
  lang: string;
  caption: string;
}

function text(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value : '';
}

const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

function commandText(row: Record<string, unknown>): string {
  return text(row.command) || (!Object.hasOwn(row, 'command') && row.lang === 'bash'
    ? text(row.preview)
    : '');
}

function fallbackText(row: Record<string, unknown>): string {
  return (FILE_TOOLS.has(text(row.name)) ? text(row.sub) : '') || text(row.title);
}

/**
 * Проверяет наличие справки без затрат на форматирование команды.
 * Шаблон может вызывать проверку при каждом обновлении ленты.
 */
export function hasStepTip(row: Record<string, unknown>): boolean {
  return Boolean(commandText(row) || fallbackText(row));
}

/**
 * Выбирает сохранённый текст инструмента для подсказки.
 * Форматирование применяется только при открытии поверхности.
 */
export function stepTip(row: Record<string, unknown>): StepTip | null {
  const command = commandText(row);
  const preview = text(row.preview);

  if (command) {
    return {
      code: formatShellCommand(command),
      lang: text(row.lang) || 'bash',
      caption: text(row.command) && preview !== command ? preview : '',
    };
  }

  const code = fallbackText(row);

  return code ? {
    code,
    lang: '',
    caption: '',
  } : null;
}

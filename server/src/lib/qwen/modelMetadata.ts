import { record } from './transport.ts';

/**
 * Подтверждение модели читается из текущего значения, возвращённого самим CLI.
 * Доступный вариант или отправленное значение запроса не подтверждают выбор сессии.
 */
export function qwenSelectedModel(value: unknown): string {
  if (!Array.isArray(value)) {
    return '';
  }

  const option = value.map(record).find((entry) => entry.id === 'model' && entry.type === 'select');

  return typeof option?.currentValue === 'string' ? option.currentValue.trim() : '';
}

/**
 * Ступени принадлежат выбранной модели, а не всему сервису API.
 * ACP допускает группы вариантов; неизвестные имена сохраняются без догадок по model id.
 */
export function qwenEffortOption(value: unknown): {
  current: string;
  levels: string[];
} | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const option = value.map(record).find((entry) => entry.id === 'reasoning_effort');

  if (!option || option.type !== 'select' || !Array.isArray(option.options)) {
    return null;
  }

  // Общий fallback CLI предлагает ступени даже неизвестным и нетекстовым моделям.
  // Только model-specific metadata доказывает, что набор относится к выбранной модели.
  const capability = record(option._meta)['qwenCode/reasoning'];

  if (!capability || typeof capability !== 'object' || Array.isArray(capability)) {
    return null;
  }

  const choices = option.options.flatMap((entry) => {
    const choice = record(entry);

    return Array.isArray(choice.options) ? choice.options.map(record) : [choice];
  });
  const levels = choices.map((choice) => choice.value).filter((entry): entry is string =>
    typeof entry === 'string' && entry.length > 0);

  return {
    current: typeof option.currentValue === 'string' ? option.currentValue : '',
    levels: [...new Set(levels)],
  };
}

// Подготовка запуска текущей формы: строки, проверка пачки и снимки запросов.
// JSON-копия отделяет нормализованные значения от реактивного черновика.
import type { Studio3dOffer } from '../../../../shared/studio3d/studio3dContracts.ts';
import type { FieldValues, Validation } from '../../../../shared/studio3d/studio3dOperations.ts';
import type { StudioRunInput } from './studio3dApi.ts';

interface CreationMetadata {
  selected: Studio3dOffer | undefined;
  values: FieldValues;
  name: string;
  project: string;
  category: string;
}

/**
 * Описание пачки разбивается по строкам; пустые строки не создают отдельного заказа.
 * Пробелы по краям не входят в отправляемый prompt.
 */
export function lines(values: FieldValues): string[] {
  return String(values.prompt ?? '').split(/\r?\n/)
    .map((line) => line.trim()).filter(Boolean);
}

/**
 * Локальная проверка сохраняет предел пачки, не заменяя серверную нормализацию.
 * Валидация возвращает те же значения текущего черновика.
 */
export function batchValidation(values: FieldValues, prompts = lines(values)): Validation {
  return {
    values,
    errors: prompts.length > 50
      ? [{ field: 'prompt', message: 'Пачка содержит максимум 50 строк.' }]
      : [],
    warnings: []
  };
}

/**
 * Все строки quote получают общие параметры, затем сервер нормализует собственный snapshot.
 * Неизвестная цена не подставляется нулём и не разрешает запуск пачки.
 */
export function batchRows(input: CreationMetadata, prompts = lines(input.values)) {
  const { selected, values, name, project, category } = input;

  if (!selected || selected.quote.total === null) {
    throw new Error('Цена пока не опубликована.');
  }

  return prompts.map((prompt, index) => ({
    provider: selected.provider,
    operation: selected.operation,
    values: { ...values, prompt },
    name: name.trim() ? `${name.trim().slice(0, 196)} ${index + 1}` : prompt.slice(0, 80),
    project: project || null,
    category: category || null,
    expectedPrice: selected.quote.total
  }));
}

/**
 * Одиночный заказ получает прежнюю JSON-копию нормализованных значений и метаданные.
 * Цена и uploads берутся из проверенного состояния формы перед отправкой.
 */
export function runRequest(input: Omit<CreationMetadata, 'selected'> & {
  selected: Studio3dOffer;
  normalizedValues?: FieldValues;
  expectedPrice: number;
  uploads: NonNullable<StudioRunInput['uploads']>;
}): StudioRunInput {
  const { selected, values, normalizedValues, expectedPrice, uploads, name, project, category } = input;

  return {
    provider: selected.provider,
    operation: selected.operation,
    values: JSON.parse(JSON.stringify(normalizedValues ?? values)) as FieldValues,
    expectedPrice,
    uploads,
    ...(name.trim() && { name: name.trim() }),
    project: project || null,
    category: category || null
  };
}

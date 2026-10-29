/**
 * Модель в DTO — подпись для человека; составной modelRef остаётся контрактом запуска.
 * JSON-пару разбираем только здесь, чтобы граф, попытки и live-лента называли её одинаково.
 */
export function runnerModelName(value: unknown): string | null {
  const model = typeof value === 'string' ? value.trim() : '';

  if (!model) {
    return null;
  }

  if (model.startsWith('[')) {
    try {
      const pair: unknown = JSON.parse(model);

      if (Array.isArray(pair) && pair.length === 2
        && pair.every((part) => typeof part === 'string' && part.trim())) {
        return pair[1].trim();
      }
    } catch {
      // Повреждённая диагностика не мешает читать остальной граф.
    }

    return null;
  }

  return model;
}

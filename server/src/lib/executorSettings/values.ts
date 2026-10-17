// Наложение создаёт независимый JSON-документ и не пишет в native base.
// Массивы заменяются атомарно; изменение отдельного индекса не разрешается.

import { decodeSettingsJson } from '../../../../shared/chat/providerSettingsContracts.ts';
import type { JsonValue } from '../../../../shared/chat/providerSettingsContracts.ts';
import type { NativeSettingsOverride } from './types.ts';

/**
 * Адреса уже разрешены каталогом, но опасные сегменты проверяются и здесь.
 * Ни прототипы, ни соседние overrides не меняются через ссылку на входной объект.
 */
export function overlayNativeSettings(
  base: JsonValue,
  overrides: readonly NativeSettingsOverride[],
): JsonValue {
  const result = decodeSettingsJson(base);

  for (const entry of overrides) {
    if (
      entry.path.length === 0 ||
      entry.path.some((part) => ['__proto__', 'prototype', 'constructor'].includes(part))
    ) {
      throw new Error('Недопустимый путь настройки');
    }

    let current = result;

    for (const [index, part] of entry.path.entries()) {
      if (current === null || typeof current !== 'object' || Array.isArray(current)) {
        throw new Error('Путь настройки не разрешает замену индекса или скаляра');
      }

      if (index === entry.path.length - 1) {
        current[part] = decodeSettingsJson(entry.value);
      } else {
        if (!Object.hasOwn(current, part)) {
          current[part] = {};
        }

        current = current[part]!;
      }
    }
  }

  return result;
}

// TOML передаётся отдельными argv, без интерпретации shell.
// Ключи inline table сохраняют буквальную точку как часть сегмента.

import type { PreparedNativeSettings } from './types.ts';
import type { JsonValue } from '../../../../shared/chat/providerSettingsContracts.ts';

/**
 * TOML basic string экранирует управляющие символы по собственному синтаксису.
 * Непарные surrogate и нечисловые JSON numbers не передаются в native parser.
 */
function string(value: string): string {
  const escapes: Record<string, string> = {
    '"': '\\"',
    '\\': '\\\\',
    '\b': '\\b',
    '\t': '\\t',
    '\n': '\\n',
    '\f': '\\f',
    '\r': '\\r',
  };

  for (const character of value) {
    const point = character.codePointAt(0)!;

    if (point >= 0xd800 && point <= 0xdfff) {
      throw new Error('Строка не представима в TOML');
    }
  }

  return `"${value.replace(
    /["\\\u0000-\u001f\u007f]/g,
    (character) => escapes[character] ?? `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )}"`;
}

/**
 * JSON null передаётся отдельно в thread config, поскольку TOML не имеет null.
 * Массив не фильтруется: неподдержанное значение закрывает подготовку вместо смены индексов.
 */
function serialize(value: JsonValue): string {
  if (typeof value === 'string') {
    return string(value);
  }

  if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
    return String(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(serialize).join(', ')}]`;
  }

  if (value !== null && typeof value === 'object') {
    return `{ ${Object.entries(value)
      .filter(([, item]) => item !== null)
      .map(([key, item]) => `${string(key)} = ${serialize(item)}`)
      .join(', ')} }`;
  }

  throw new Error('Значение не представимо в TOML');
}

/**
 * Аргументы общего слоя собираются из подготовленного плана запуска.
 * Нулевые и пустые значения сохраняются без применения native defaults.
 */
export function nativeSettingsTomlArgs(plan?: PreparedNativeSettings): string[] {
  if (!plan) {
    return [];
  }

  if (!plan.payload || typeof plan.payload !== 'object' || Array.isArray(plan.payload)) {
    throw new Error('Нативный слой Codex должен быть объектом');
  }

  return Object.entries(plan.payload)
    .filter(([, value]) => value !== null)
    .flatMap(([key, value]) => {
      if (!/^[A-Za-z0-9_-]+$/.test(key)) {
        throw new Error('Корневой ключ не поддерживается CLI Codex');
      }

      return ['-c', `${key}=${serialize(value)}`];
    });
}

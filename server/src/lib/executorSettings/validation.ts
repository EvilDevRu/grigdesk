// Проверка выбора выполняется общим сервисом до сохранения и перед запуском.
// Нативные ключи разрешаются только через поле достоверного каталога.

import type { NativeSettingsOverride, NormalizedSettingNode } from './types.ts';
import { decodeSettingsJson } from '../../../../shared/chat/providerSettingsContracts.ts';
import { canonicalSettingsJson } from './fingerprint.ts';
import { overlayNativeSettings } from './values.ts';

export interface NativeSettingsValidationError {
  code: 'unknown_field' | 'readonly_field' | 'invalid_value';
  message: string;
}

/**
 * Объекты являются группами, а items не создаёт адресуемые индексы массива.
 * Один и тот же обход используется при записи, проекции и подготовке запуска.
 */
export function flattenNativeSettings(fields: readonly NormalizedSettingNode[]): NormalizedSettingNode[] {
  return fields.flatMap((field) => [field, ...flattenNativeSettings(field.children ?? [])]);
}

/**
 * Проверка значения следует типу и всем поддержанным ограничениям схемы.
 * Enum сравнивается как JSON, поэтому число и одноимённая строка различаются.
 */
function validValue(field: NormalizedSettingNode, value: unknown): boolean {
  const constraints = field.constraints;

  if (
    constraints.enum &&
    !constraints.enum.some((choice) => canonicalSettingsJson(choice) === canonicalSettingsJson(value))
  ) {
    return false;
  }

  if (value === null) {
    return constraints.nullable === true || constraints.enum?.includes(null) === true;
  }

  const declaredType = Array.isArray(field.schema.type)
    ? field.schema.type.find((type) => type !== 'null')
    : field.schema.type;
  const kind =
    field.kind === 'enum' ? (typeof declaredType === 'string' ? declaredType : typeof value) : field.kind;

  if (kind === 'boolean') {
    return typeof value === 'boolean';
  }

  if (kind === 'string') {
    if (typeof value !== 'string') {
      return false;
    }

    const length = [...value].length;

    return (
      (constraints.minLength === undefined || length >= constraints.minLength) &&
      (constraints.maxLength === undefined || length <= constraints.maxLength)
    );
  }

  if (kind === 'number' || kind === 'integer') {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      (kind === 'integer' && !Number.isInteger(value))
    ) {
      return false;
    }

    const multiple = constraints.multipleOf;
    const ratio = multiple === undefined ? 0 : value / multiple;
    const exactMultiple =
      multiple === undefined ||
      (multiple > 0 &&
        Number.isFinite(ratio) &&
        Math.abs(ratio - Math.round(ratio)) <= Number.EPSILON * Math.max(1, Math.abs(ratio)) * 8);
    const stepRatio =
      constraints.step === undefined ? 0 : (value - (constraints.stepOrigin ?? 0)) / constraints.step;
    const exactStep =
      constraints.step === undefined ||
      (constraints.step > 0 &&
        Number.isFinite(stepRatio) &&
        Math.abs(stepRatio - Math.round(stepRatio)) <= Number.EPSILON * Math.max(1, Math.abs(stepRatio)) * 8);

    return (
      exactMultiple &&
      exactStep &&
      (constraints.minimum === undefined || value >= constraints.minimum) &&
      (constraints.maximum === undefined || value <= constraints.maximum) &&
      (constraints.exclusiveMinimum === undefined || value > constraints.exclusiveMinimum) &&
      (constraints.exclusiveMaximum === undefined || value < constraints.exclusiveMaximum)
    );
  }

  if (kind === 'array' && Array.isArray(value) && field.items) {
    return (
      (constraints.minItems === undefined || value.length >= constraints.minItems) &&
      (constraints.maxItems === undefined || value.length <= constraints.maxItems) &&
      value.every((item) => validValue(field.items!, item))
    );
  }

  return false;
}

/**
 * Неподтверждённый путь не становится нативной командой или произвольным JSON.
 * Проверка возвращает безопасную причину без самого значения.
 */
export function validateNativeSetting(
  fields: readonly NormalizedSettingNode[],
  fieldId: string,
  value: unknown,
  overrides: readonly NativeSettingsOverride[] = [],
): NativeSettingsValidationError | null {
  const field = flattenNativeSettings(fields).find((item) => item.id === fieldId);

  if (!field) {
    return { code: 'unknown_field', message: 'Поле отсутствует в текущем каталоге' };
  }

  if (!field.writable || field.secret || field.owner) {
    return { code: 'readonly_field', message: field.reason ?? 'Поле недоступно для записи' };
  }

  let validJson = true;

  try {
    decodeSettingsJson(value);
  } catch {
    validJson = false;
  }

  if (!validJson || !validValue(field, value)) {
    return { code: 'invalid_value', message: 'Значение не соответствует типу поля' };
  }

  for (const ancestor of field.ancestors ?? []) {
    const required = ancestor.schema.required;

    if (!Array.isArray(required)) {
      continue;
    }

    try {
      const next = overlayNativeSettings(
        ancestor.base ?? {},
        [
          ...overrides.filter((entry) => ancestor.path.every((part, index) => entry.path[index] === part)),
          { path: field.path, value: decodeSettingsJson(value) },
        ].map((entry) => ({ ...entry, path: entry.path.slice(ancestor.path.length) })),
      );

      if (
        next === null ||
        typeof next !== 'object' ||
        Array.isArray(next) ||
        required.some((key) => typeof key !== 'string' || !Object.hasOwn(next, key))
      ) {
        return { code: 'invalid_value', message: 'Выбор нарушает обязательные поля группы' };
      }
    } catch {
      return { code: 'invalid_value', message: 'Выбор несовместим с базовым значением группы' };
    }
  }

  return null;
}

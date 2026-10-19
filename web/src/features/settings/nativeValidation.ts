import type { ProviderSettingNode } from '../../../../shared/chat/providerSettingsContracts.ts';

/**
 * Клиент проверяет публичные ограничения до общей очереди применения.
 * Владение, CAS и скрытые ограничения групп окончательно проверяет сервер.
 */
export function validNativeDraft(field: ProviderSettingNode, value: unknown): boolean {
  const limits = field.constraints;

  if (limits.enum && !limits.enum.some((choice) => JSON.stringify(choice) === JSON.stringify(value))) {
    return false;
  }
  if (value === null) {
    return limits.nullable === true || limits.enum?.includes(null) === true;
  }

  const kind = field.kind === 'enum' ? typeof value : field.kind;

  if (kind === 'boolean') {
    return typeof value === 'boolean';
  }
  if (kind === 'string') {
    return typeof value === 'string'
      && (limits.minLength === undefined || [...value].length >= limits.minLength)
      && (limits.maxLength === undefined || [...value].length <= limits.maxLength);
  }
  if (kind === 'number' || kind === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)
        || kind === 'integer' && !Number.isInteger(value)) {
      return false;
    }

    const isStep = (step: number | undefined, origin = 0) => {
      const ratio = step === undefined ? 0 : (value - origin) / step;

      return step === undefined || step > 0 && Math.abs(ratio - Math.round(ratio))
        <= Number.EPSILON * Math.max(1, Math.abs(ratio)) * 8;
    };

    return (limits.minimum === undefined || value >= limits.minimum)
      && (limits.maximum === undefined || value <= limits.maximum)
      && (limits.exclusiveMinimum === undefined || value > limits.exclusiveMinimum)
      && (limits.exclusiveMaximum === undefined || value < limits.exclusiveMaximum)
      && isStep(limits.multipleOf) && isStep(limits.step, limits.stepOrigin ?? 0);
  }

  return kind === 'array' && Array.isArray(value) && Boolean(field.items)
    && (limits.minItems === undefined || value.length >= limits.minItems)
    && (limits.maxItems === undefined || value.length <= limits.maxItems)
    && value.every((item) => validNativeDraft(field.items!, item));
}

// Общие DTO и нормализация возможностей 3D-провайдеров; продуктовый словарь находится в плагине.

export type VersionKind =
  | 'image'
  | 'views'
  | 'model'
  | 'rigged'
  | 'animated'
  | 'parts'
  | 'splat'
  | 'export';

export type OperationId =
  | 'text-to-model'
  | 'image-to-model'
  | 'views-to-model'
  | 'image-to-splat'
  | 'text-to-image'
  | 'image-edit'
  | 'image-to-views'
  | 'views-edit'
  | 'retopology'
  | 'segment'
  | 'complete-parts'
  | 'smart-segment'
  | 'stylize'
  | 'retexture'
  | 'uv-unwrap'
  | 'rig-check'
  | 'rig'
  | 'animate'
  | 'export'
  | 'rotate'
  | 'scale';

export type FieldKind = 'text' | 'textarea' | 'number' | 'select' | 'toggle' | 'multiselect' | 'view-prompts';

export type FieldScalar = string | number | boolean | null;

export interface ViewPrompt {
  view: 'front' | 'left' | 'back' | 'right';
  prompt: string;
}

export type FieldValue = FieldScalar | string[] | ViewPrompt[];

export type FieldValues = Record<string, FieldValue>;

export interface FieldOption {
  value: string;
  label: string;
  hint?: string;
  group?: string;
}

// Условие показа поля: значение другого поля входит в is и не входит в not.
export interface FieldCondition {
  field: string;
  is?: readonly FieldScalar[];
  not?: readonly FieldScalar[];
}

export interface OperationField {
  id: string;
  kind: FieldKind;
  label: string;
  hint?: string;
  required?: boolean;
  default?: FieldValue;
  min?: number;
  max?: number;
  step?: number;
  maxLength?: number;
  maxItems?: number;
  unit?: string;
  options?: readonly FieldOption[];
  advanced?: boolean;
  visibleWhen?: readonly FieldCondition[];
}

export interface OperationPreset {
  id: string;
  label: string;
  hint?: string;
  values: FieldValues;
}

// Объявление исполнителя: какое действие, какие поля и что важно знать человеку.
export interface ProviderOperation {
  operation: OperationId;
  fields: readonly OperationField[];
  presets?: readonly OperationPreset[];
  note?: string;
  needsNative?: boolean;
  priceKnown?: boolean;
}

export interface UnitForms {
  one: string;
  few: string;
  many: string;
}

export interface QuoteLine {
  label: string;
  amount: number;
}

export interface Quote {
  total: number | null;
  lines: QuoteLine[];
  unit: UnitForms | null;
  usd: number | null;
  note: string | null;
}

export interface FieldIssue {
  field: string | null;
  message: string;
}

export interface Validation {
  values: FieldValues;
  errors: FieldIssue[];
  warnings: FieldIssue[];
}

export const CREDIT_FORMS: UnitForms = {
  one: 'кредит',
  few: 'кредита',
  many: 'кредитов',
};

/**
 * Поле видно, когда выполнены все его условия. Скрытое поле не уходит исполнителю:
 * его значение отбрасывается при нормализации, как будто его нет.
 */
export function isFieldVisible(field: OperationField, values: FieldValues): boolean {
  return (field.visibleWhen ?? []).every((condition) => {
    const value = values[condition.field];
    const scalar = Array.isArray(value) ? null : value ?? null;

    if (condition.is && !condition.is.includes(scalar)) {
      return false;
    }

    return !(condition.not && condition.not.includes(scalar));
  });
}

/**
 * Приводит сырые значения формы к объявленным полям: умолчания, типы, диапазоны,
 * обязательность. Незнакомые и скрытые поля выбрасываются; ошибки называют поле.
 */
export function normalizeValues(fields: readonly OperationField[], raw: Record<string, unknown>): Validation {
  const values: FieldValues = {};
  const errors: FieldIssue[] = [];

  for (const field of fields) {
    const value = coerceField(field, raw[field.id] === undefined ? field.default ?? null : raw[field.id]);

    values[field.id] = value.value;

    if (value.error) {
      errors.push({
        field: field.id,
        message: value.error
      });
    }
  }

  for (const field of fields) {
    if (!isFieldVisible(field, values)) {
      delete values[field.id];
      removeIssues(errors, field.id);
    } else if (field.required && isEmpty(values[field.id])) {
      errors.push({
        field: field.id,
        message: `Заполните поле «${field.label}».`
      });
    }
  }

  return {
    values,
    errors,
    warnings: []
  };
}

/**
 * Ошибки скрытого поля не показываются: человек не может их исправить.
 * Обход с конца, потому что элементы удаляются на месте.
 */
function removeIssues(issues: FieldIssue[], field: string) {
  for (let index = issues.length - 1; index >= 0; index -= 1) {
    if (issues[index]?.field === field) {
      issues.splice(index, 1);
    }
  }
}

// Пустое значение: ничего не выбрано, пустая строка или пустой список.
function isEmpty(value: FieldValue | undefined): boolean {
  if (Array.isArray(value)) {
    return value.length === 0;
  }

  return value === null || value === undefined || value === '';
}

/**
 * Приводит одно значение к виду поля. Число вне диапазона и вариант не из списка
 * дают ошибку, а не тихую подмену: цена зависит от этих значений.
 */
function coerceField(field: OperationField, raw: unknown): { value: FieldValue; error?: string } {
  if (raw === null || raw === undefined || raw === '') {
    return { value: field.kind === 'multiselect' || field.kind === 'view-prompts' ? [] : null };
  }

  if (field.kind === 'toggle') {
    return { value: raw === true || raw === 'true' };
  }

  if (field.kind === 'number') {
    return coerceNumber(field, raw);
  }

  if (field.kind === 'select') {
    const value = String(raw);
    const known = (field.options ?? []).some((option) => option.value === value);

    return known ? { value } : {
      value: null,
      error: `Недопустимое значение поля «${field.label}».`
    };
  }

  if (field.kind === 'multiselect') {
    return coerceList(field, raw);
  }

  if (field.kind === 'view-prompts') {
    return coerceViewPrompts(field, raw);
  }

  const text = String(raw).trim();

  if (field.maxLength !== undefined && text.length > field.maxLength) {
    return {
      value: text,
      error: `«${field.label}»: не длиннее ${field.maxLength} знаков.`
    };
  }

  return { value: text };
}

/**
 * Число проверяется на конечность и диапазон поля. Шаг не навязывается: дробный
 * рост в метрах допустим, а целые грани объявляют шаг 1 и проверяются так же.
 */
function coerceNumber(field: OperationField, raw: unknown): { value: FieldValue; error?: string } {
  const value = typeof raw === 'number' ? raw : Number(String(raw).replace(',', '.'));

  if (!Number.isFinite(value)) {
    return {
      value: null,
      error: `«${field.label}»: нужно число.`
    };
  }

  if ((field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max)) {
    return {
      value,
      error: `«${field.label}»: от ${field.min ?? '−∞'} до ${field.max ?? '∞'}.`
    };
  }

  if (field.step === 1 && !Number.isInteger(value)) {
    return {
      value,
      error: `«${field.label}»: нужно целое число.`
    };
  }

  return { value };
}

/**
 * Список вариантов: только известные значения, без повторов, не больше maxItems.
 * Порядок выбора сохраняется — от него зависит порядок заказов.
 */
function coerceList(field: OperationField, raw: unknown): { value: FieldValue; error?: string } {
  const list = Array.isArray(raw) ? raw.map(String) : [String(raw)];
  const known = new Set((field.options ?? []).map((option) => option.value));
  const value = [...new Set(list)].filter((item) => known.has(item));

  if (value.length !== new Set(list).size) {
    return {
      value,
      error: `Недопустимое значение поля «${field.label}».`
    };
  }

  if (field.maxItems !== undefined && value.length > field.maxItems) {
    return {
      value,
      error: `«${field.label}»: не больше ${field.maxItems}.`
    };
  }

  return { value };
}

/**
 * Подсказки по видам: известный вид и непустой текст. Повтор вида — ошибка:
 * исполнитель принимает по одной правке на вид.
 */
function coerceViewPrompts(field: OperationField, raw: unknown): { value: FieldValue; error?: string } {
  const views = ['front', 'left', 'back', 'right'];
  const list = Array.isArray(raw) ? raw : [];
  const value: ViewPrompt[] = [];

  for (const item of list) {
    const view = String((item as Record<string, unknown>)?.view ?? '');
    const prompt = String((item as Record<string, unknown>)?.prompt ?? '').trim();

    if (!views.includes(view) || !prompt || value.some((entry) => entry.view === view)) {
      return {
        value,
        error: `«${field.label}»: по одной правке на вид, текст обязателен.`
      };
    }

    value.push({
      view: view as ViewPrompt['view'],
      prompt
    });
  }

  return { value };
}

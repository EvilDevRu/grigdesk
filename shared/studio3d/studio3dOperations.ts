// Словарь раздела «3D»: виды версий, группы и действия, поля и цены. Один экземпляр на
// сервер и окно: исполнитель объявляет, какие действия умеет и с какими полями, а
// подписи, входы и выходы действий живут здесь, поэтому экран не ветвится по вендору.

// Причина одновременно объясняет потерю наблюдения и открывает ручной разбор в окне.
// Платный заказ с известным номером остаётся принятой задачей до решения человека.
export const MISSING_TASK_WAIT_REASON =
  'Заказ не найден после трёх проверок. Можно прекратить ожидание; оплата неизвестна.';

export const VERSION_KINDS = [
  'image',
  'views',
  'model',
  'rigged',
  'animated',
  'parts',
  'splat',
  'export',
] as const;

export type VersionKind = typeof VERSION_KINDS[number];

export const VERSION_KIND_LABELS: Readonly<Record<VersionKind, string>> = {
  image: 'Картинка',
  views: 'Виды',
  model: 'Модель',
  rigged: 'Скелет',
  animated: 'Движение',
  parts: 'Части',
  splat: 'Сплат',
  export: 'Экспорт',
};

export const OPERATION_GROUPS = [
  {
    id: 'create',
    label: 'Создание'
  },
  {
    id: 'images',
    label: 'Картинки'
  },
  {
    id: 'geometry',
    label: 'Геометрия'
  },
  {
    id: 'texture',
    label: 'Текстура'
  },
  {
    id: 'animation',
    label: 'Анимация'
  },
  {
    id: 'export',
    label: 'Экспорт'
  },
  {
    id: 'helpers',
    label: 'Помощники'
  },
] as const;

export type OperationGroup = typeof OPERATION_GROUPS[number]['id'];

// Чем питается действие: текстом, загруженной картинкой, набором видов или версией модели.
export type OperationInput = 'text' | 'image' | 'views' | 'model' | 'rigged' | 'animated' | 'parts';

// Что получается: новая версия своего вида, результат проверки или тот же вид, что на входе.
export type OperationOutput = VersionKind | 'check' | 'same';

export interface OperationSpec {
  id: string;
  label: string;
  group: OperationGroup;
  inputs: readonly OperationInput[];
  output: OperationOutput;
  hint: string;
}

export const OPERATIONS = [
  {
    id: 'text-to-model',
    label: 'Модель из текста',
    group: 'create',
    inputs: ['text'],
    output: 'model',
    hint: 'Описание словами превращается в трёхмерную модель.',
  },
  {
    id: 'image-to-model',
    label: 'Модель из картинки',
    group: 'create',
    inputs: ['image'],
    output: 'model',
    hint: 'Одна картинка предмета или персонажа превращается в модель.',
  },
  {
    id: 'views-to-model',
    label: 'Модель по видам',
    group: 'create',
    inputs: ['views'],
    output: 'model',
    hint: 'От двух до четырёх видов одного объекта; вид спереди обязателен.',
  },
  {
    id: 'image-to-splat',
    label: 'Сплат из фото',
    group: 'create',
    inputs: ['image'],
    output: 'splat',
    hint: 'Облако гауссовых точек для фона и сцен; это не сетка, дальше его не обработать.',
  },
  {
    id: 'text-to-image',
    label: 'Картинка из текста',
    group: 'images',
    inputs: ['text'],
    output: 'image',
    hint: 'Дешёвая проверка облика до заказа модели.',
  },
  {
    id: 'image-edit',
    label: 'Правка картинки',
    group: 'images',
    inputs: ['image'],
    output: 'image',
    hint: 'Правка словами или шаблоном: T-поза, достроить персонажа, выделить предмет.',
  },
  {
    id: 'image-to-views',
    label: 'Четыре вида',
    group: 'images',
    inputs: ['image'],
    output: 'views',
    hint: 'Из одной картинки получаются виды спереди, слева, сзади и справа.',
  },
  {
    id: 'views-edit',
    label: 'Правка видов',
    group: 'images',
    inputs: ['views'],
    output: 'views',
    hint: 'Правка отдельных видов словами, например «убери фонарь из руки».',
  },
  {
    id: 'retopology',
    label: 'Меньше полигонов',
    group: 'geometry',
    inputs: ['model', 'parts'],
    output: 'model',
    hint: 'Новая сетка с нужным числом граней; текстура переносится на неё.',
  },
  {
    id: 'segment',
    label: 'Разрезать на части',
    group: 'geometry',
    inputs: ['model'],
    output: 'parts',
    hint: 'Модель делится на части, которые можно достроить и выгрузить по отдельности.',
  },
  {
    id: 'complete-parts',
    label: 'Достроить части',
    group: 'geometry',
    inputs: ['parts'],
    output: 'parts',
    hint: 'Закрывает скрытые поверхности у выбранных частей.',
  },
  {
    id: 'smart-segment',
    label: 'Умная сегментация',
    group: 'geometry',
    inputs: ['image', 'model'],
    output: 'parts',
    hint: 'Части с подписями по картинке или готовой модели GLB.',
  },
  {
    id: 'stylize',
    label: 'Стилизация',
    group: 'geometry',
    inputs: ['model'],
    output: 'model',
    hint: 'Лего, воксели, мозаика Вороного или Minecraft.',
  },
  {
    id: 'retexture',
    label: 'Новая текстура',
    group: 'texture',
    inputs: ['model'],
    output: 'model',
    hint: 'Перерисовывает текстуру готовой модели.',
  },
  {
    id: 'uv-unwrap',
    label: 'UV-развёртка',
    group: 'texture',
    inputs: ['model', 'rigged', 'animated'],
    output: 'same',
    hint: 'Новая развёртка; текстура, скелет и движения переносятся на неё.',
  },
  {
    id: 'rig-check',
    label: 'Проверка скелета',
    group: 'animation',
    inputs: ['model'],
    output: 'check',
    hint: 'Можно ли поставить скелет и какой тип тела у модели.',
  },
  {
    id: 'rig',
    label: 'Скелет',
    group: 'animation',
    inputs: ['model'],
    output: 'rigged',
    hint: 'Кости и веса для анимации.',
  },
  {
    id: 'animate',
    label: 'Движения',
    group: 'animation',
    inputs: ['rigged'],
    output: 'animated',
    hint: 'Готовые движения на скелет: каждое — отдельная версия.',
  },
  {
    id: 'export',
    label: 'Экспорт',
    group: 'export',
    inputs: ['model', 'rigged', 'animated', 'parts'],
    output: 'export',
    hint: 'Другой формат, размер текстур, ориентация или пресет FBX.',
  },
  {
    id: 'rotate',
    label: 'Развернуть',
    group: 'helpers',
    inputs: ['model', 'rigged', 'animated', 'parts'],
    output: 'same',
    hint: 'Поворот модели целиком; скелет и движения поворачиваются вместе с ней.',
  },
  {
    id: 'scale',
    label: 'Задать рост',
    group: 'helpers',
    inputs: ['model', 'rigged', 'animated', 'parts'],
    output: 'same',
    hint: 'Масштаб по высоте в метрах.',
  },
] as const satisfies readonly OperationSpec[];

export type OperationId = typeof OPERATIONS[number]['id'];

const OPERATION_BY_ID: ReadonlyMap<string, OperationSpec> = new Map(
  OPERATIONS.map((operation) => [operation.id, operation]),
);

/**
 * Описание действия по id. Незнакомое действие честно отсутствует: экран не
 * придумывает для него подпись и не показывает кнопку.
 */
export function operationSpec(id: string): OperationSpec | null {
  return OPERATION_BY_ID.get(id) ?? null;
}

/**
 * Действия, которые принимают версию этого вида. Для создания с нуля вид — 'start':
 * тогда подходят действия от текста, картинки и видов, загруженных в форму.
 */
export function operationsFor(kind: VersionKind | 'start'): OperationSpec[] {
  const accepted: readonly OperationInput[] = kind === 'start'
    ? ['text', 'image', 'views']
    : [kind as OperationInput];

  return OPERATIONS.filter((operation) => {
    return operation.inputs.some((input) => accepted.includes(input));
  });
}

/**
 * Вид версии, которую даст действие. 'same' сохраняет вид входа: разворот модели со
 * скелетом остаётся моделью со скелетом. Проверка новой версии не создаёт.
 */
export function outputKind(operation: OperationSpec, input: VersionKind | null): VersionKind | 'check' {
  if (operation.output === 'same') {
    return input ?? 'model';
  }

  return operation.output;
}

/**
 * Уточняет вид по сводке скачанного файла: движения важнее скелета, скелет — сетки.
 * Картинки, виды, части, сплат и экспорт остаются как объявлены.
 */
export function refineKind(kind: VersionKind, stats: { bones?: number; animations?: unknown[] } | null) {
  if (!stats || !['model', 'rigged', 'animated'].includes(kind)) {
    return kind;
  }

  if ((stats.animations?.length ?? 0) > 0) {
    return 'animated';
  }

  return (stats.bones ?? 0) > 0 ? 'rigged' : 'model';
}

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

/**
 * Склоняет единицу по числу для показа: 1 кредит, 2 кредита, 5 кредитов. Дробное
 * число — родительный падеж единственного числа: 2,5 кредита.
 */
export function pluralForm(amount: number, forms: UnitForms): string {
  const absolute = Math.abs(amount);

  if (!Number.isInteger(absolute)) {
    return forms.few;
  }

  const last = absolute % 10;
  const hundred = absolute % 100;

  if (hundred >= 11 && hundred <= 14) {
    return forms.many;
  }

  if (last === 1) {
    return forms.one;
  }

  return last >= 2 && last <= 4 ? forms.few : forms.many;
}

/**
 * Цена для кнопки: «30 кредитов», «бесплатно» или «цена неизвестна». Число
 * округляется до сотых только для показа.
 */
export function formatPrice(total: number | null, unit: UnitForms | null): string {
  if (total === null || !Number.isFinite(total) || total < 0) {
    return 'цена неизвестна';
  }

  if (total === 0) {
    return 'бесплатно';
  }

  if (unit === null) {
    return 'цена неизвестна';
  }

  const rounded = Math.round(total * 100) / 100;
  const text = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(rounded);

  return `${text} ${pluralForm(rounded, unit)}`;
}

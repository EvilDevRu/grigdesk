// Расчёт цены Tripo по прайсу developers.tripo3d.ai на 11.10.2026.
// Один кредит равен $0,01; расчёт остаётся оценкой перед отправкой.

import {
  GPT_MODELS, MODEL_H, MODEL_OPTIONS, MODEL_P1, MODEL_P2, SOURCE_LABELS, USD_PER_CREDIT,
} from './catalogValues.ts';
import { CREDIT_FORMS } from '../../../../shared/studio3d/studio3dOperations.ts';
import type { FieldValues, Quote, QuoteLine } from '../../../../shared/studio3d/studio3dOperations.ts';
import type { InputContext } from '../studio3d/provider.ts';

const GENERATION_BASE: Readonly<Record<string, Readonly<Record<string, readonly [number, number]>>>> = {
  h: {
    text: [10, 20],
    image: [20, 30],
    views: [20, 30]
  },
  p1: {
    text: [30, 40],
    image: [40, 50],
    views: [40, 50]
  },
  p2: {
    text: [100, 110],
    image: [100, 110],
    views: [100, 110]
  },
};

const IMAGE_PRICES: Readonly<Record<string, number>> = {
  seedream_v4: 5,
  seedream_v5: 5,
  'gemini-2.5-flash': 5,
  'gemini-3.1-flash': 10,
  'gemini-3-pro': 15,
  chat_image_2: 10,
  'chat_image_2.5_flare': 10,
  'chat_image_2.5_sunburst': 10,
};

// Ступени качества GPT при размере по умолчанию: прайс считает их по ступени 2K.
const GPT_QUALITY_PRICES: Readonly<Record<string, number>> = {
  high: 25,
  xhigh: 30,
  max: 50
};

/**
 * Цена генерации: база по модели и входу, затем надбавки за качество текстуры, форму
 * Ultra, квады, low-poly «как руками» и части. Надбавки складываются, как в прайсе.
 */
function generationLines(operation: string, values: FieldValues): QuoteLine[] {
  const model = String(values.model ?? MODEL_H);
  const family = model === MODEL_P1 ? 'p1' : model === MODEL_P2 ? 'p2' : 'h';
  const source = operation === 'text-to-model' ? 'text' : operation === 'image-to-model' ? 'image' : 'views';
  const [plain, textured] = GENERATION_BASE[family]?.[source] ?? [0, 0];
  const name = MODEL_OPTIONS.find((entry) => entry.value === model)?.label ?? model;
  const lines: QuoteLine[] = [{
    label: `${SOURCE_LABELS[operation]} · ${name}`,
    amount: plain
  }];
  const push = (label: string, amount: number) => lines.push({
    label,
    amount
  });

  if (values.texture !== false) {
    push('Текстура', textured - plain);

    if (values.texture_quality === 'detailed') {
      push('HD-текстура', 10);
    } else if (values.texture_quality === 'extreme') {
      push('8K-текстура', 20);
    }
  }

  if (family === 'h' && values.geometry_quality === 'detailed') {
    push('Форма Ultra', 20);
  }

  if (values.quad === true) {
    push('Четырёхугольная сетка', 5);
  }

  if (family === 'h' && values.smart_low_poly === true) {
    push('Low-poly «как руками»', 10);
  }

  if (family === 'h' && values.generate_parts === true) {
    push('По частям', 20);
  }

  return lines;
}

/**
 * Экспорт дороже, когда меняется что-то кроме формата: прайс называет это
 * «сложной конвертацией» и перечисляет поля, которые её включают.
 */
function exportIsComplex(values: FieldValues): boolean {
  return values.quad === true
    || typeof values.face_limit === 'number'
    || values.flatten_bottom === true
    || (values.flatten_bottom_threshold ?? 0.01) !== 0.01
    || (values.texture_size ?? '4096') !== '4096'
    || (values.texture_format ?? 'JPEG') !== 'JPEG'
    || values.pivot_to_center_bottom === true
    || (values.scale_factor ?? 1) !== 1;
}

/**
 * Строки цены действия. Неизвестная Tripo цена возвращает null: кнопка покажет
 * «цена неизвестна» и не сможет отправить оплачиваемый заказ.
 */
function quoteLines(operation: string, values: FieldValues, context: InputContext): QuoteLine[] | null {
  const single = (label: string, amount: number) => [{
    label,
    amount
  }];

  if (SOURCE_LABELS[operation]) {
    if (![MODEL_H, MODEL_P1, MODEL_P2].includes(String(values.model ?? MODEL_H))) {
      return null;
    }

    return generationLines(operation, values);
  }

  if (operation === 'text-to-image' || operation === 'image-edit') {
    if (IMAGE_PRICES[String(values.model)] === undefined) {
      return null;
    }

    const quality = GPT_MODELS.includes(String(values.model))
      ? GPT_QUALITY_PRICES[String(values.quality)]
      : undefined;

    return single('Картинка', quality ?? IMAGE_PRICES[String(values.model)] ?? 0);
  }

  const fixed: Readonly<Record<string, readonly [string, number]>> = {
    'image-to-views': ['Четыре вида', 10],
    'image-to-splat': ['Сплат', 30],
    'uv-unwrap': ['UV-развёртка', 20],
    segment: ['Разрезка на части', 40],
    'rig-check': ['Проверка скелета', 0],
    rig: ['Скелет', 25],
  };
  const known = fixed[operation];

  if (known) {
    return single(known[0], known[1]);
  }

  return processingLines(operation, values, context, single);
}

/**
 * Цены обработки, где сумма зависит от значений: качество текстуры, способ
 * ретопологии, сложность экспорта, число правок и движений, вид входа.
 */
function processingLines(
  operation: string,
  values: FieldValues,
  context: InputContext,
  single: (label: string, amount: number) => QuoteLine[],
): QuoteLine[] | null {
  if (operation === 'views-edit') {
    return single('Правки видов', 5 * (Array.isArray(values.prompts) ? values.prompts.length : 0));
  }

  if (operation === 'retexture') {
    const prices: Readonly<Record<string, number>> = {
      extreme: 30,
      detailed: 20
    };

    return single('Новая текстура', prices[String(values.texture_quality)] ?? 10);
  }

  if (operation === 'export') {
    return single(exportIsComplex(values) ? 'Сложный экспорт' : 'Экспорт', exportIsComplex(values) ? 10 : 5);
  }

  if (operation === 'retopology') {
    const v3 = values.quad === true ? 40 : 35;
    const prices: Readonly<Record<string, number>> = {
      'v1.0': 10,
      'v3.0': v3
    };

    return single('Меньше полигонов', prices[String(values.model)] ?? 30);
  }

  if (operation === 'complete-parts') {
    return single('Достройка частей', values.completion_mode === 'quick_cap' ? 30 : 50);
  }

  if (operation === 'smart-segment') {
    return single('Умная сегментация', context.kind === 'image' ? 85 : 55);
  }

  if (operation === 'animate') {
    return single('Движения', 10 * (Array.isArray(values.animations) ? values.animations.length : 0));
  }

  return null;
}

/**
 * Цена действия с раскладкой. Сумма в долларах — для подсказки: 1 кредит = $0,01.
 * Стилизация и незнакомые действия получают total = null.
 */
export function tripoQuote(operation: string, values: FieldValues, context: InputContext): Quote {
  const lines = quoteLines(operation, values, context);

  if (!lines) {
    return {
      total: null,
      lines: [],
      unit: CREDIT_FORMS,
      usd: null,
      note: 'Tripo не публикует цену этого шага — её покажет счёт после заказа.'
    };
  }

  const total = lines.reduce((sum, line) => sum + line.amount, 0);

  return {
    total,
    lines: lines.filter((line) => line.amount !== 0 || lines.length === 1),
    unit: CREDIT_FORMS,
    usd: Math.round(total * USD_PER_CREDIT * 100) / 100,
    note: null,
  };
}

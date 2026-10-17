// Поля и готовые наборы действий Tripo для раздела «3D».
// Порядок зависимых полей задаёт нормализацию и показ вариантов.

import {
  GPT25_MODELS, GPT_MODELS, MODEL_H, MODEL_OPTIONS, MODEL_P1, MODEL_P2, RIG_V1, RIG_V2,
  SEGMENT_V1, SEGMENT_V2, TEXTURE_V3, TEXTURE_V35, option,
} from './catalogValues.ts';
import { MOTIONS_V1, RIG_TYPES, motionsV2 } from './motions.ts';
import type {
  FieldCondition, FieldOption, OperationField, OperationPreset, ProviderOperation,
} from '../../../../shared/studio3d/studio3dOperations.ts';
import type { InputContext } from '../studio3d/provider.ts';

/**
 * Сборка поля: обязательные id, вид и подпись плюс дополнительные свойства.
 * Объявления ниже читаются строкой на поле, без повторяющихся ключей.
 */
function field(id: string, kind: OperationField['kind'], label: string, extra: Partial<OperationField> = {}) {
  return {
    id,
    kind,
    label,
    ...extra
  } as OperationField;
}

const ON_TEXTURE: FieldCondition = {
  field: 'texture',
  is: [true]
};
const H_ONLY: FieldCondition = {
  field: 'model',
  is: [MODEL_H]
};
const P_ONLY: FieldCondition = {
  field: 'model',
  is: [MODEL_P1, MODEL_P2]
};
const SEED = {
  min: 0,
  max: 2147483647,
  step: 1,
  advanced: true
};

const TEXTURE_QUALITY = [
  option('standard', 'Обычное'),
  option('detailed', 'HD', '+10 кредитов.'),
  option('extreme', '8K', '+20 кредитов.'),
  option('fast', 'Быстрое', 'Только с текстурой v3.5; цена как у обычного.'),
];

/**
 * Поля генерации модели из текста, картинки или видов. Порядок важен: поле, от
 * которого зависит показ другого, объявлено раньше — нормализация скрывает их по
 * порядку объявления.
 */
function generationFields(source: 'text' | 'image' | 'views'): OperationField[] {
  const fields: OperationField[] = [];

  if (source === 'text') {
    fields.push(
      field('prompt', 'textarea', 'Описание', {
        required: true,
        maxLength: 1024,
        hint: 'Что сделать: предмет, материал, поза. До 1024 знаков.'
      }),
      field('negative_prompt', 'text', 'Чего не должно быть', {
        maxLength: 255,
        advanced: true
      }),
    );
  }

  fields.push(
    field('model', 'select', 'Модель', {
      default: MODEL_H,
      options: MODEL_OPTIONS
    }),
    field('face_limit', 'number', 'Граней', {
      min: 48,
      max: 2000000,
      step: 1,
      hint: 'Пусто — Tripo решит сам. P1: 50–20 000, P2: до 50 000.'
    }),
    field('texture', 'toggle', 'Текстура', { default: true }),
    field('pbr', 'toggle', 'Материалы PBR', {
      default: true,
      visibleWhen: [ON_TEXTURE]
    }),
    field('texture_quality', 'select', 'Качество текстуры', {
      default: 'standard',
      options: TEXTURE_QUALITY,
      visibleWhen: [ON_TEXTURE]
    }),
    field('texture_version', 'select', 'Версия текстуры', {
      default: TEXTURE_V3,
      advanced: true,
      options: [
        option(TEXTURE_V3, 'v3.0'),
        option(TEXTURE_V35, 'v3.5', 'Быстрое качество и снятие запечённого света.'),
      ],
      visibleWhen: [ON_TEXTURE],
    }),
    field('delight', 'toggle', 'Убрать запечённый свет', {
      default: true,
      advanced: true,
      visibleWhen: [ON_TEXTURE, {
        field: 'texture_version',
        is: [TEXTURE_V35]
      }],
    }),
    field('geometry_quality', 'select', 'Детализация формы', {
      default: 'standard',
      options: [option('standard', 'Обычная'), option('detailed', 'Ultra', '+20 кредитов.')],
      visibleWhen: [H_ONLY],
    }),
    field('quad', 'toggle', 'Четырёхугольная сетка', {
      default: false,
      hint: 'Результат придёт в FBX; +5 кредитов.',
      visibleWhen: [{
        field: 'model',
        is: [MODEL_H, MODEL_P2]
      }],
    }),
    field('smart_low_poly', 'toggle', 'Low-poly «как руками»', {
      default: false,
      hint: '500–20 000 граней; +10 кредитов.',
      visibleWhen: [H_ONLY],
    }),
    field('generate_parts', 'toggle', 'По частям', {
      default: false,
      hint: 'Части приходят без текстуры; +20 кредитов.',
      visibleWhen: [H_ONLY],
    }),
    field('auto_size', 'toggle', 'Реальный размер в метрах', { default: false }),
    field('export_uv', 'toggle', 'UV-развёртка', {
      default: true,
      advanced: true,
      visibleWhen: [P_ONLY]
    }),
    field('compress', 'toggle', 'Сжать геометрию', {
      default: false,
      advanced: true,
      hint: 'Сжатие meshopt: файл меньше.',
      visibleWhen: [H_ONLY],
    }),
  );

  if (source === 'image') {
    fields.push(field('enable_image_autofix', 'toggle', 'Подправить слабую картинку', {
      default: false,
      advanced: true
    }));
  }

  if (source !== 'text') {
    fields.push(
      field('texture_alignment', 'select', 'Текстура по', {
        default: 'original_image',
        advanced: true,
        options: [option('original_image', 'картинке'), option('geometry', 'форме')],
        visibleWhen: [ON_TEXTURE],
      }),
      field('orientation', 'select', 'Поворот', {
        default: 'default',
        advanced: true,
        options: [option('default', 'как решит Tripo'), option('align_image', 'как на картинке')],
      }),
    );
  }

  fields.push(field('model_seed', 'number', 'Сид формы', SEED));

  if (source === 'text') {
    fields.push(field('image_seed', 'number', 'Сид картинки', SEED));
  }

  fields.push(field('texture_seed', 'number', 'Сид текстуры', {
    ...SEED,
    visibleWhen: [ON_TEXTURE]
  }));

  return fields;
}

const GENERATION_PRESETS: readonly OperationPreset[] = [
  {
    id: 'game',
    label: 'Игра · low-poly',
    hint: 'P1, 5 000 граней, обычная текстура.',
    values: {
      model: MODEL_P1,
      face_limit: 5000,
      texture: true,
      pbr: true,
      texture_quality: 'standard'
    },
  },
  {
    id: 'detailed',
    label: 'Детально',
    hint: 'v3.1 с обычной текстурой.',
    values: {
      model: MODEL_H,
      face_limit: null,
      texture: true,
      pbr: true,
      texture_quality: 'standard'
    },
  },
  {
    id: 'print',
    label: 'Для печати',
    hint: 'Без текстуры — дешевле; дальше STL с плоским дном.',
    values: {
      model: MODEL_H,
      face_limit: null,
      texture: false,
      pbr: false
    },
  },
  {
    id: 'character',
    label: 'Персонаж',
    hint: 'v3.1 с текстурой; дальше проверка и скелет. Лучше T-поза.',
    values: {
      model: MODEL_H,
      face_limit: null,
      texture: true,
      pbr: true,
      texture_quality: 'standard'
    },
  },
];

const IMAGE_MODELS = [
  option('seedream_v4', 'Seedream 4', '5 кредитов; по умолчанию.'),
  option('seedream_v5', 'Seedream 5', '5 кредитов; качество выше.'),
  option('gemini-2.5-flash', 'Gemini 2.5 Flash', '5 кредитов; быстрая.'),
  option('gemini-3.1-flash', 'Gemini 3.1 Flash', '10 кредитов.'),
  option('gemini-3-pro', 'Gemini 3 Pro', '15 кредитов; высокое качество.'),
  option('chat_image_2', 'GPT Image 2', '10 кредитов.'),
  option('chat_image_2.5_flare', 'GPT Image 2.5 Flare', '10 кредитов; быстрее.'),
  option('chat_image_2.5_sunburst', 'GPT Image 2.5 Sunburst', '10 кредитов; бережнее к правке.'),
];

const TEMPLATES: Readonly<Record<string, FieldOption>> = {
  t_pose: option('t_pose', 'T-поза', 'Золотой шаг перед скелетом.'),
  character_completion: option('character_completion', 'Достроить персонажа'),
  asset_extraction: option('asset_extraction', 'Выделить предмет'),
  '3d_enhance': option('3d_enhance', 'Подготовить к 3D'),
  variants: option('variants', 'Варианты'),
  figure: option('figure', 'Фигурка'),
};

/**
 * Поля картинок: текст из описания или правка готовой картинки. Списки шаблонов у двух
 * ручек Tripo разные, у правки нет Seedream 4 — так проверяет сервер Tripo.
 */
function imageFields(edit: boolean): OperationField[] {
  const templates = edit
    ? ['t_pose', 'character_completion', '3d_enhance', 'variants', 'figure']
    : ['t_pose', 'character_completion', 'asset_extraction', 'variants', 'figure'];
  const models = edit ? IMAGE_MODELS.filter((model) => model.value !== 'seedream_v4') : IMAGE_MODELS;

  return [
    field('prompt', 'textarea', edit ? 'Что поправить' : 'Описание', {
      required: !edit,
      maxLength: 1024
    }),
    field('model', 'select', 'Модель картинок', {
      default: edit ? 'seedream_v5' : 'seedream_v4',
      options: models
    }),
    field('template', 'select', 'Шаблон', {
      options: templates.map((id) => TEMPLATES[id] ?? option(id, id))
    }),
    field('sketch_to_render', 'toggle', 'Скетч в рендер', {
      default: false,
      advanced: true
    }),
    field('quality', 'select', 'Качество GPT', {
      default: 'low',
      options: [
        option('low', 'Обычное'),
        option('medium', 'Среднее'),
        option('high', 'Высокое', '25 кредитов.'),
        option('xhigh', 'Очень высокое', 'Только GPT 2.5; 30 кредитов.'),
        option('max', 'Максимальное', 'Только GPT 2.5; 50 кредитов.'),
      ],
      visibleWhen: [{
        field: 'model',
        is: GPT_MODELS
      }],
    }),
    field('background', 'select', 'Фон', {
      default: 'auto',
      options: [
        option('auto', 'На выбор модели'),
        option('opaque', 'Сплошной'),
        option('transparent', 'Прозрачный'),
      ],
      visibleWhen: [{
        field: 'model',
        is: GPT25_MODELS
      }],
    }),
  ];
}

const EXPORT_FORMATS = [
  option('GLTF', 'GLB (glTF)'),
  option('FBX', 'FBX'),
  option('OBJ', 'OBJ'),
  option('USDZ', 'USDZ'),
  option('STL', 'STL'),
  option('3MF', '3MF', 'Один цвет — для печати.'),
];

/**
 * Поля экспорта. Состав зависит от входа: скелет и движения показываются только у
 * версий со скелетом, выбор частей — у разрезанной модели.
 */
function exportFields(context: InputContext): OperationField[] {
  const animated = context.kind === 'rigged' || context.kind === 'animated';
  const fields = [
    field('format', 'select', 'Формат', {
      required: true,
      default: 'GLTF',
      options: EXPORT_FORMATS
    }),
    field('fbx_preset', 'select', 'Пресет FBX', {
      default: 'blender',
      options: [option('blender', 'Blender'), option('3dsmax', '3ds Max'), option('mixamo', 'Mixamo')],
      visibleWhen: [{
        field: 'format',
        is: ['FBX']
      }],
    }),
    field('texture_size', 'select', 'Размер текстур', {
      default: '4096',
      options: ['4096', '2048', '1024', '512'].map((size) => option(size, `${size} px`)),
    }),
    field('texture_format', 'select', 'Формат текстур', {
      default: 'JPEG',
      advanced: true,
      options: [option('JPEG', 'JPEG'), option('PNG', 'PNG'), option('WEBP', 'WebP')],
    }),
    field('export_orientation', 'select', 'Взгляд модели', {
      default: '+x',
      options: [
        option('+x', 'вперёд по +X'),
        option('-x', 'по −X'),
        option('+y', 'по +Y'),
        option('-y', 'по −Y'),
      ],
    }),
    field('quad', 'toggle', 'Четырёхугольная сетка', {
      default: false,
      visibleWhen: [{
        field: 'format',
        is: ['FBX', 'OBJ', 'USDZ']
      }],
    }),
    field('force_symmetry', 'toggle', 'Симметрия', {
      default: false,
      advanced: true,
      visibleWhen: [{
        field: 'quad',
        is: [true]
      }],
    }),
    field('face_limit', 'number', 'Граней', {
      min: 48,
      max: 2000000,
      step: 1,
      hint: 'Пусто — как есть.'
    }),
    field('flatten_bottom', 'toggle', 'Плоское дно', {
      default: false,
      hint: 'Для печати.'
    }),
    field('flatten_bottom_threshold', 'number', 'Глубина среза дна', {
      default: 0.01,
      min: 0,
      max: 1,
      advanced: true,
      visibleWhen: [{
        field: 'flatten_bottom',
        is: [true]
      }],
    }),
    field('pivot_to_center_bottom', 'toggle', 'Опорная точка внизу по центру', { default: false }),
    field('scale_factor', 'number', 'Масштаб', {
      default: 1,
      min: 0.001,
      max: 1000,
      advanced: true
    }),
    field('bake', 'toggle', 'Запечь материалы в текстуры', {
      default: true,
      advanced: true
    }),
    field('pack_uv', 'toggle', 'Одна общая развёртка', {
      default: false,
      advanced: true
    }),
    field('export_vertex_colors', 'toggle', 'Цвета вершин', {
      default: false,
      advanced: true,
      visibleWhen: [{
        field: 'format',
        is: ['OBJ', 'GLTF']
      }],
    }),
  ];

  if (animated) {
    fields.push(
      field('with_animation', 'toggle', 'Скелет и движения', { default: true }),
      field('animate_in_place', 'toggle', 'Движение на месте', { default: false }),
    );
  }

  if (context.kind === 'parts') {
    fields.push(partsField(context, 'Только части'));
  }

  return fields;
}

// Выбор частей из сводки версии; пустой выбор означает все части.
function partsField(context: InputContext, label: string): OperationField {
  return field('part_names', 'multiselect', label, {
    hint: 'Пусто — все части.',
    options: (context.stats?.parts ?? []).map((part) => option(part, part)),
  });
}

/**
 * Поля «меньше полигонов». У v1 число граней обязательно и нет переноса текстуры,
 * развёртка UV бесплатна только у v3 — так описывает ручку Tripo.
 */
function retopologyFields(context: InputContext): OperationField[] {
  const fields = [
    field('model', 'select', 'Способ', {
      default: 'v2.0',
      options: [
        option('v2.0', 'Стандартный — v2', '30 кредитов.'),
        option('v3.0', 'Новый — v3', '35 кредитов, с квадами 40; можно сразу с UV.'),
        option('v1.0', 'Простой — v1', '10 кредитов; число граней обязательно.'),
      ],
    }),
    field('face_limit', 'number', 'Граней', {
      min: 500,
      max: 2000000,
      step: 1,
      hint: 'v2 и v3: 500–20 000, квады до 10 000; пусто — сам. v1: обязательно.'
    }),
    field('quad', 'toggle', 'Четырёхугольная сетка', { default: false }),
    field('bake', 'toggle', 'Перенести текстуру', {
      default: true,
      visibleWhen: [{
        field: 'model',
        is: ['v2.0', 'v3.0']
      }],
    }),
    field('smart_uv', 'toggle', 'Сразу развернуть UV', {
      default: false,
      hint: 'Бесплатно.',
      visibleWhen: [{
        field: 'model',
        is: ['v3.0']
      }],
    }),
  ];

  if (context.kind === 'parts') {
    fields.push({
      ...partsField(context, 'Только части'),
      visibleWhen: [{
        field: 'model',
        is: ['v2.0', 'v3.0']
      }],
    });
  }

  return fields;
}

/**
 * Поля скелета. Умолчания берутся из бесплатной проверки: тип тела, а для двуногих —
 * человеческий скелет v1 с сотней готовых движений.
 */
function rigFields(context: InputContext): OperationField[] {
  const rigType = context.rigCheck?.rigType ?? 'biped';

  return [
    field('model', 'select', 'Скелет', {
      default: rigType === 'biped' ? RIG_V1 : RIG_V2,
      options: [
        option(RIG_V1, 'Для человека', '41 кость, больше 90 готовых движений, без пальцев.'),
        option(RIG_V2, 'Для существ', 'Все типы тела, 11 общих движений.'),
      ],
    }),
    field('rig_type', 'select', 'Тип тела', {
      default: rigType,
      options: RIG_TYPES.map((type) => option(type.value, type.label))
    }),
    field('spec', 'select', 'Имена костей', {
      default: 'tripo',
      options: [option('tripo', 'Tripo'), option('mixamo', 'Mixamo', 'Для Unity и Mixamo.')],
    }),
    field('out_format', 'select', 'Формат', {
      default: 'glb',
      options: [option('glb', 'GLB'), option('fbx', 'FBX')]
    }),
  ];
}

/**
 * Поля движений: набор зависит от версии скелета, записанной во входной версии.
 * Заказ одного движения — одна задача Tripo, поэтому выбор ограничен десятью.
 */
function animateFields(context: InputContext): OperationField[] {
  const model = context.params?.model;
  const type = context.params?.rig_type;
  const motions = model === RIG_V1 ? MOTIONS_V1
    : model === RIG_V2 && typeof type === 'string' && RIG_TYPES.some((item) => item.value === type)
      ? motionsV2(type)
      : [];

  return [
    field('animations', 'multiselect', 'Движения', {
      required: true,
      maxItems: 10,
      options: motions.map((motion) => ({
        value: motion.id,
        label: motion.label,
        group: motion.group
      })),
    }),
    field('out_format', 'select', 'Формат', {
      default: 'glb',
      options: [option('glb', 'GLB'), option('fbx', 'FBX')]
    }),
    field('animate_in_place', 'toggle', 'На месте', {
      default: false,
      hint: 'Без смещения корня — для своей ходьбы в игре.'
    }),
    field('bake_animation', 'toggle', 'Запечь движение', {
      default: true,
      advanced: true,
      visibleWhen: [{
        field: 'out_format',
        is: ['glb']
      }],
    }),
    field('export_with_geometry', 'toggle', 'Вместе с сеткой', {
      default: true,
      advanced: true
    }),
  ];
}

/**
 * Объявления действий Tripo для версии на входе. Списки частей, движений и умолчания
 * скелета берутся из контекста, поэтому объявление строится на каждый запрос.
 */
export function tripoOperations(context: InputContext): ProviderOperation[] {
  return [
    {
      operation: 'text-to-model',
      fields: generationFields('text'),
      presets: GENERATION_PRESETS
    },
    {
      operation: 'image-to-model',
      fields: generationFields('image'),
      presets: GENERATION_PRESETS
    },
    {
      operation: 'views-to-model',
      fields: generationFields('views'),
      presets: GENERATION_PRESETS,
      note: 'Виды одного объекта одной высоты: макушка, глаза и подбородок на одних линиях.',
    },
    {
      operation: 'image-to-splat',
      fields: [field('model_seed', 'number', 'Сид', SEED)],
      note: 'Около четырёх минут. Сплат — не сетка: дальше его не обработать.',
    },
    {
      operation: 'text-to-image',
      fields: imageFields(false)
    },
    {
      operation: 'image-edit',
      fields: imageFields(true)
    },
    {
      operation: 'image-to-views',
      fields: []
    },
    {
      operation: 'views-edit',
      fields: [field('prompts', 'view-prompts', 'Правки по видам', { required: true })],
      needsNative: true,
    },
    {
      operation: 'retexture',
      fields: [
        field('model', 'select', 'Версия текстуры', {
          default: TEXTURE_V3,
          options: [
            option(TEXTURE_V3, 'v3.0'),
            option(TEXTURE_V35, 'v3.5', 'Быстрое качество и снятие света.'),
          ],
        }),
        field('texture_quality', 'select', 'Качество', {
          default: 'standard',
          options: TEXTURE_QUALITY
        }),
        field('pbr', 'toggle', 'Материалы PBR', { default: true }),
        field('delight', 'toggle', 'Убрать запечённый свет', {
          default: true,
          visibleWhen: [{
            field: 'model',
            is: [TEXTURE_V35]
          }],
        }),
        field('texture_seed', 'number', 'Сид текстуры', SEED),
      ],
    },
    {
      operation: 'stylize',
      fields: [
        field('style', 'select', 'Стиль', {
          required: true,
          default: 'lego',
          options: [
            option('lego', 'Лего'),
            option('voxel', 'Воксели'),
            option('voronoi', 'Мозаика Вороного'),
            option('minecraft', 'Minecraft'),
          ],
        }),
        field('block_size', 'number', 'Размер блока', {
          default: 80,
          min: 32,
          max: 128,
          step: 1,
          visibleWhen: [{
            field: 'style',
            is: ['minecraft']
          }],
        }),
      ],
      priceKnown: false,
      note: 'Цена стилизации не опубликована — запуск недоступен.',
    },
    {
      operation: 'export',
      fields: exportFields(context)
    },
    {
      operation: 'retopology',
      fields: retopologyFields(context)
    },
    {
      operation: 'uv-unwrap',
      fields: [
        field('bake', 'toggle', 'Перенести текстуру', { default: true }),
        field('compress', 'toggle', 'Сжать геометрию', {
          default: false,
          advanced: true
        }),
      ],
      note: 'До 80 000 треугольников; скелет и движения переносятся.',
    },
    {
      operation: 'segment',
      fields: [
        field('model', 'select', 'Способ', {
          default: SEGMENT_V1,
          options: [
            option(SEGMENT_V1, 'По геометрии'),
            option(SEGMENT_V2, 'По смыслу', 'Бета-версия Tripo.'),
          ],
        }),
        field('segmentation_granularity', 'select', 'Дробность', {
          default: 'balanced',
          options: [option('simple', 'Крупно'), option('balanced', 'Средне'), option('detailed', 'Мелко')],
          visibleWhen: [{
            field: 'model',
            is: [SEGMENT_V2]
          }],
        }),
        field('split_by_connectivity', 'toggle', 'Делить несвязанные куски', {
          default: true,
          visibleWhen: [{
            field: 'model',
            is: [SEGMENT_V2]
          }],
        }),
      ],
    },
    {
      operation: 'complete-parts',
      fields: [
        field('completion_mode', 'select', 'Как достроить', {
          default: 'ai_completion',
          options: [
            option('ai_completion', 'ИИ', '50 кредитов.'),
            option('quick_cap', 'Быстро закрыть дыры', '30 кредитов.'),
          ],
        }),
        partsField(context, 'Какие части'),
      ],
      needsNative: true,
    },
    {
      operation: 'smart-segment',
      fields: [
        field('granularity', 'select', 'Дробность', {
          default: 'medium',
          options: [option('coarse', 'Крупно'), option('medium', 'Средне'), option('fine', 'Мелко')],
        }),
        field('hint', 'text', 'Подсказка', {
          maxLength: 500,
          hint: 'Какие части нужны, например «кузов, двери, колёса».'
        }),
      ],
      note: 'Модель — только GLB.',
    },
    {
      operation: 'rig-check',
      fields: [],
      note: 'Бесплатно. Tripo охотнее оснащает модель, которая смотрит вперёд по +X.'
    },
    {
      operation: 'rig',
      fields: rigFields(context)
    },
    {
      operation: 'animate',
      fields: animateFields(context),
      needsNative: true,
      note: 'Каждое движение — отдельный заказ: пакетом Tripo отдавал в GLB только последнее. '
        + 'Превью до покупки нет.',
    },
  ];
}

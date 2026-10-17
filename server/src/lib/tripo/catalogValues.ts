// Общие значения каталога Tripo: модели, типы задач, native-входы и пулы.
// Имена моделей датированы: рекламный tripo-v3.1 сервер отклоняет кодом 1004.

import type { FieldOption, FieldValues } from '../../../../shared/studio3d/studio3dOperations.ts';

export const MODEL_H = 'v3.1-20260211';
export const MODEL_P1 = 'P1-20260311';
export const MODEL_P2 = 'P2-20260801';
export const TEXTURE_V3 = 'v3.0-20250812';
export const TEXTURE_V35 = 'v3.5-20260815';
export const RIG_V1 = 'v1.0-20240301';
export const RIG_V2 = 'v2.5-20260210';
export const SEGMENT_V1 = 'v1.0-20250506';
export const SEGMENT_V2 = 'v2.0-20260430';
export const USD_PER_CREDIT = 0.01;
export const IDENTITY_TRANSFORM = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export const ENDPOINTS: Readonly<Record<string, string>> = {
  'text-to-model': '/v3/generation/text-to-model',
  'image-to-model': '/v3/generation/image-to-model',
  'views-to-model': '/v3/generation/multiview-to-model',
  'image-to-splat': '/v3/generation/image-to-splat',
  'text-to-image': '/v3/generation/text-to-image',
  'image-edit': '/v3/generation/image-to-image',
  'image-to-views': '/v3/generation/image-to-multiview',
  'views-edit': '/v3/generation/edit-multiview',
  retexture: '/v3/models/texture',
  stylize: '/v3/models/stylize',
  export: '/v3/models/convert',
  retopology: '/v3/mesh/decimate',
  'uv-unwrap': '/v3/mesh/uv',
  segment: '/v3/mesh/segment',
  'complete-parts': '/v3/mesh/complete',
  'smart-segment': '/v3/mesh/smartsegment',
  'rig-check': '/v3/animations/rig-check',
  rig: '/v3/animations/rig',
  animate: '/v3/animations/retarget',
};

// Тип задачи Tripo по действию раздела; у умной сегментации он зависит от входа.
export const OPERATION_TASK_TYPES: Readonly<Record<string, string>> = {
  'text-to-model': 'text_to_model',
  'image-to-model': 'image_to_model',
  'views-to-model': 'multiview_to_model',
  'image-to-splat': 'image_to_splat',
  'text-to-image': 'text_to_image',
  'image-edit': 'generate_image',
  'image-to-views': 'generate_multiview_image',
  'views-edit': 'edit_multiview_image',
  retexture: 'texture_model',
  stylize: 'stylize_model',
  export: 'convert_model',
  retopology: 'highpoly_to_lowpoly',
  'uv-unwrap': 'mesh_uv',
  segment: 'mesh_segmentation',
  'complete-parts': 'mesh_completion',
  'smart-segment': 'smartsegment_model',
  'rig-check': 'animate_prerigcheck',
  rig: 'animate_rig',
  animate: 'animate_retarget',
};

// Обратная карта для заказов, сделанных вне раздела (агенты, прошлые записи на диске).
export const TASK_OPERATIONS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.entries(OPERATION_TASK_TYPES).map(([operation, type]) => [type, operation])),
  smartsegment_image: 'smart-segment',
  refine_model: 'refine',
  import_model: 'import',
  mesh_edit: 'mesh-edit',
};

export const MODEL_PRODUCING = new Set([
  'text_to_model',
  'image_to_model',
  'multiview_to_model',
  'refine_model',
  'texture_model',
  'stylize_model',
  'convert_model',
  'import_model',
  'highpoly_to_lowpoly',
  'mesh_segmentation',
  'mesh_completion',
  'mesh_uv',
  'animate_rig',
  'animate_retarget',
]);

export const IMAGE_TASKS = new Set(['text_to_image', 'generate_image']);
const MODEL_STEPS = new Set([
  'retexture',
  'stylize',
  'export',
  'retopology',
  'uv-unwrap',
  'segment',
  'rig-check',
  'rig',
]);
export const VIEW_TASKS = new Set(['generate_multiview_image', 'edit_multiview_image']);

/**
 * Можно ли подать версию номером задачи Tripo, без загрузки файла. Шаги «достроить
 * части», «движения» и «правка видов» требуют именно номер: файл Tripo не примет.
 */
export function nativeAccepts(operation: string, taskType: string | null): boolean {
  if (!taskType) {
    return false;
  }

  if (operation === 'complete-parts') {
    return taskType === 'mesh_segmentation';
  }

  if (operation === 'animate') {
    return taskType === 'animate_rig';
  }

  if (operation === 'views-edit' || operation === 'views-to-model') {
    return VIEW_TASKS.has(taskType);
  }

  if (operation === 'image-to-model' || operation === 'image-edit') {
    return IMAGE_TASKS.has(taskType);
  }

  return MODEL_STEPS.has(operation) && MODEL_PRODUCING.has(taskType);
}

// Шаги, которым годится только версия, сделанная этим же исполнителем.
export const NATIVE_ONLY: ReadonlySet<string> = new Set(['complete-parts', 'animate', 'views-edit']);

/**
 * Короткая сборка варианта списка: значение, подпись и необязательная подсказка.
 * Подсказка видна под списком и объясняет цену или ограничение варианта.
 */
export function option(value: string, label: string, hint?: string): FieldOption {
  return hint ? {
    value,
    label,
    hint
  } : {
    value,
    label
  };
}

export const MODEL_OPTIONS = [
  option(MODEL_H, 'Детальная — v3.1', 'До 2 млн граней; с текстурой около 2 минут.'),
  option(MODEL_P1, 'Low-poly — P1', 'Чистая сетка до 20 000 граней; около минуты.'),
  option(MODEL_P2, 'Low-poly с квадами — P2', 'Предварительная версия: до 50 000 граней, квады в FBX.'),
];

export const GPT_MODELS = ['chat_image_2', 'chat_image_2.5_flare', 'chat_image_2.5_sunburst'];
export const GPT25_MODELS = ['chat_image_2.5_flare', 'chat_image_2.5_sunburst'];

export const SOURCE_LABELS: Readonly<Record<string, string>> = {
  'text-to-model': 'Модель из текста',
  'image-to-model': 'Модель из картинки',
  'views-to-model': 'Модель по видам',
};

/**
 * Очередь Tripo: картинки идут строго по одной, остальные пулы шире и сами
 * отвечают отказом 2000, когда заполнены. Ключ пула нужен очереди раздела.
 */
export function tripoPool(operation: string, values: FieldValues): { key: string; limit: number | null } {
  if (['text-to-image', 'image-edit', 'image-to-views', 'views-edit'].includes(operation)) {
    return {
      key: 'image',
      limit: 1
    };
  }

  if (SOURCE_LABELS[operation]) {
    return {
      key: values.model === MODEL_H || values.model === undefined ? 'generation-h' : 'generation-p',
      limit: null
    };
  }

  const pools: Readonly<Record<string, string>> = {
    'rig-check': 'animation',
    rig: 'animation',
    animate: 'animation',
    retexture: 'processing',
    export: 'processing',
    stylize: 'processing',
    segment: 'mesh',
    'complete-parts': 'mesh',
    retopology: 'mesh',
  };

  return {
    key: pools[operation] ?? operation,
    limit: null
  };
}

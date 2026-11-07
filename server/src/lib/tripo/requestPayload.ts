// Сборка запросов Tripo v3 из значений и проверенных входов.
// Native-номер и файловый вход сохраняют условия каждого действия.

import {
  ENDPOINTS, IDENTITY_TRANSFORM, OPERATION_TASK_TYPES, SOURCE_LABELS,
} from './catalogValues.ts';
import { motionLabel } from './motions.ts';
import type { FieldValues } from '../../../../shared/studio3d/studio3dOperations.ts';
import type { InputContext } from '../studio3d/provider.ts';

export type TripoRef = string;

export interface TripoInputs {
  primary?: TripoRef;
  views?: Partial<Record<'front' | 'left' | 'back' | 'right', TripoRef>>;
  viewsTask?: string;
}

export interface TripoRequest {
  endpoint: string;
  body: Record<string, unknown>;
  label: string;
  taskType: string;
}

/**
 * Переносит значения формы в тело запроса: пустые поля не отправляются, переключатель
 * сжатия становится строкой geometry, размер текстур — числом, пустой шаблон исчезает.
 */
function payloadFromValues(values: FieldValues): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
      continue;
    }

    if (key === 'compress') {
      if (value === true) {
        body.compress = 'geometry';
      }

      continue;
    }

    body[key] = key === 'texture_size' ? Number(value) : value;
  }

  return body;
}

/**
 * Собирает запросы Tripo для действия. Обычно запрос один; у «Движений» — по одному
 * на движение, потому что пакет в GLB возвращал только последнее движение.
 */
export function tripoRequests(
  operation: string,
  values: FieldValues,
  inputs: TripoInputs,
  context: InputContext,
): TripoRequest[] {
  const endpoint = ENDPOINTS[operation];

  if (!endpoint) {
    throw new Error(`Tripo не умеет действие ${operation}`);
  }

  const body = payloadFromValues(values);
  const taskType = OPERATION_TASK_TYPES[operation] ?? operation;
  const label = SOURCE_LABELS[operation] ?? '';

  attachInputs(operation, body, inputs, context);

  if (operation === 'animate') {
    const motions = Array.isArray(values.animations) ? values.animations.map(String) : [];

    delete body.animations;

    return motions.map((motion) => ({
      endpoint,
      body: {
        ...body,
        animation: motion
      },
      label: motionLabel(motion),
      taskType,
    }));
  }

  return [{
    endpoint,
    body,
    label,
    taskType: operation === 'smart-segment' && context.kind === 'image' ? 'smartsegment_image' : taskType,
  }];
}

/**
 * Кладёт входы в тело по правилам ручки: виды — массивом с ключами сторон или номером
 * задачи видов, умная сегментация — с типом входа и единичной матрицей для модели.
 */
function attachInputs(
  operation: string,
  body: Record<string, unknown>,
  inputs: TripoInputs,
  context: InputContext,
) {
  if (operation === 'views-to-model') {
    body.inputs = inputs.viewsTask
      ? [{ task_id: inputs.viewsTask }]
      : (['front', 'left', 'back', 'right'] as const)
        .filter((view) => inputs.views?.[view])
        .map((view) => ({ [view]: inputs.views?.[view] }));

    return;
  }

  if (inputs.primary) {
    body.input = inputs.primary;
  }

  if (operation === 'uv-unwrap') {
    body.model = 'default';
  }

  if (operation === 'smart-segment') {
    body.seg_type = context.kind === 'image' ? 'image' : 'model';

    if (body.seg_type === 'model') {
      body.transform = IDENTITY_TRANSFORM;
    }
  }

  if (body.background === 'transparent') {
    body.output_format = 'png';
  }
}

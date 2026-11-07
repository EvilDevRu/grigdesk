// Проверки и нормализация параметров действий Tripo.
// Сообщения, несовместимости и предупреждения принадлежат каталогу действий.

import { tripoOperations } from './catalogFields.ts';
import { GPT25_MODELS, MODEL_H, MODEL_P1, MODEL_P2, RIG_V1, TEXTURE_V35 } from './catalogValues.ts';
import { normalizeValues } from '../../../../shared/studio3d/studio3dOperations.ts';
import type {
  FieldValues, OperationField, Validation,
} from '../../../../shared/studio3d/studio3dOperations.ts';
import type { InputContext } from '../studio3d/provider.ts';

/**
 * Поля действия для контекста; незнакомое действие — пустой список, и проверка
 * вернёт ошибку «Tripo этого не умеет».
 */
function fieldsOf(operation: string, context: InputContext): readonly OperationField[] | null {
  return tripoOperations(context).find((entry) => entry.operation === operation)?.fields ?? null;
}

/**
 * Проверяет и нормализует значения формы по правилам Tripo: диапазоны граней у
 * разных моделей, несовместимые сочетания и требования к входу. Безопасные поправки
 * делаются сразу и объясняются предупреждением.
 */
export function tripoValidate(
  operation: string,
  raw: Record<string, unknown>,
  context: InputContext,
): Validation {
  const fields = fieldsOf(operation, context);

  if (!fields) {
    return {
      values: {},
      errors: [{
        field: null,
        message: 'Tripo этого не умеет.'
      }],
      warnings: []
    };
  }

  const warnings: Validation['warnings'] = [];
  const adjusted = { ...raw };

  if (['text-to-model', 'image-to-model', 'views-to-model'].includes(operation)) {
    adjustGeneration(adjusted, warnings);
  }

  const result = normalizeValues(fields, adjusted);
  const specific = operationErrors(operation, result.values, context);
  const precise = new Set(specific.map((issue) => issue.field));

  result.warnings.push(...warnings);
  result.errors = [...result.errors.filter((issue) => !precise.has(issue.field)), ...specific];

  return result;
}

/**
 * Поправки генерации, которые Tripo иначе отклонил бы или молча изменил: части только
 * без текстуры, квады у частей не работают.
 */
function adjustGeneration(values: Record<string, unknown>, warnings: Validation['warnings']) {
  if ((values.model ?? MODEL_H) !== MODEL_H || values.generate_parts !== true) {
    return;
  }

  if (values.texture !== false || values.pbr === true) {
    values.texture = false;
    values.pbr = false;
    warnings.push({
      field: 'texture',
      message: 'Части Tripo делает без текстуры — её можно добавить потом шагом «Новая текстура».'
    });
  }

  if (values.quad === true) {
    values.quad = false;
    warnings.push({
      field: 'quad',
      message: 'Квады с частями не работают: части придут треугольниками.'
    });
  }
}

/**
 * Ошибки, которые зависят от сочетания полей и от входной версии. Возвращает
 * список: человек видит сразу все причины, а не по одной.
 */
function operationErrors(
  operation: string,
  values: FieldValues,
  context: InputContext,
): Validation['errors'] {
  const errors: Validation['errors'] = [];
  const add = (fieldId: string | null, message: string) => errors.push({
    field: fieldId,
    message
  });

  if (['text-to-model', 'image-to-model', 'views-to-model'].includes(operation)) {
    generationErrors(values, context, operation, add);
  }

  if (operation === 'retexture' && values.texture_quality === 'fast' && values.model !== TEXTURE_V35) {
    add('texture_quality', 'Быстрое качество есть только у текстуры v3.5.');
  }

  if (operation === 'image-edit' && !values.prompt && !values.template) {
    add('prompt', 'Опишите правку или выберите шаблон.');
  }

  if (operation === 'text-to-image' || operation === 'image-edit') {
    if (['xhigh', 'max'].includes(String(values.quality)) && !GPT25_MODELS.includes(String(values.model))) {
      add('quality', 'Это качество есть только у GPT Image 2.5.');
    }
  }

  if (operation === 'export' && values.quad === true && values.format === 'GLTF') {
    add('quad', 'Квады не помещаются в GLB: выберите FBX, OBJ или USDZ.');
  }

  if (operation === 'retopology') {
    retopologyErrors(values, add);
  }

  if (operation === 'uv-unwrap' && (context.stats?.triangles ?? 0) > 80000) {
    add(null, 'Tripo берёт до 80 000 треугольников — сначала уменьшите число полигонов.');
  }

  const glbOnly = ['rig-check', 'smart-segment'].includes(operation);

  if (glbOnly && context.kind !== 'image' && context.format !== 'glb') {
    add(null, 'Этот шаг Tripo принимает только в GLB.');
  }

  if (operation === 'rig' && values.model === RIG_V1 && values.rig_type !== 'biped') {
    add('model', 'Скелет для человека — только для двуногих: выберите скелет для существ.');
  }

  return errors;
}

/**
 * Проверки генерации: диапазоны граней по модели, части против умного low-poly,
 * быстрая текстура только у v3.5, у видов обязателен вид спереди.
 */
function generationErrors(
  values: FieldValues,
  context: InputContext,
  operation: string,
  add: (fieldId: string | null, message: string) => void,
) {
  const faces = typeof values.face_limit === 'number' ? values.face_limit : null;

  if (faces !== null && values.model === MODEL_P1 && (faces < 50 || faces > 20000)) {
    add('face_limit', 'Для P1 — от 50 до 20 000 граней.');
  }

  if (faces !== null && values.model === MODEL_P2 && faces > (values.quad === true ? 25000 : 50000)) {
    add('face_limit', values.quad === true
      ? 'P2 с квадами — до 25 000 граней.'
      : 'Для P2 — до 50 000 граней.');
  }

  const smartCeiling = values.quad === true ? 10000 : 20000;

  if (faces !== null && values.smart_low_poly === true && (faces < 500 || faces > smartCeiling)) {
    add('face_limit', 'Low-poly «как руками» — от 500 до 20 000 граней, с квадами до 10 000.');
  }

  if (values.smart_low_poly === true && values.generate_parts === true) {
    add('generate_parts', 'Выберите одно: части или low-poly «как руками» — вместе частей не будет.');
  }

  if (values.texture_quality === 'fast' && values.texture_version !== TEXTURE_V35) {
    add('texture_quality', 'Быстрое качество есть только у текстуры v3.5.');
  }

  if (operation === 'views-to-model' && (!context.views.includes('front') || context.views.length < 2)) {
    add(null, 'Нужен вид спереди и хотя бы ещё один вид.');
  }
}

/**
 * Диапазоны «меньше полигонов»: у v2 и v3 число граней необязательно, у v1 —
 * обязательно и шире. У квадов потолок ниже.
 */
function retopologyErrors(values: FieldValues, add: (fieldId: string | null, message: string) => void) {
  const faces = typeof values.face_limit === 'number' ? values.face_limit : null;
  const quad = values.quad === true;

  if (values.model === 'v1.0') {
    if (faces === null) {
      add('face_limit', 'У простого способа число граней обязательно.');
    } else if (faces > (quad ? 150000 : 2000000)) {
      add('face_limit', quad ? 'Квадов — до 150 000.' : 'Граней — до 2 000 000.');
    }

    return;
  }

  if (faces !== null && faces > (quad ? 10000 : 20000)) {
    add('face_limit', quad ? 'Квадов — от 500 до 10 000.' : 'Граней — от 500 до 20 000.');
  }
}

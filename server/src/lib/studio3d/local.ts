// Встроенный исполнитель «Локально»: бесплатные помощники над GLB прямо в GrigDesk —
// разворот и рост. Он второй исполнитель раздела и проверяет, что экран и очередь не
// привязаны к Tripo: его действия рисуются из того же объявления и сцепляются с чужими.

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { normalizeValues } from '../../../../shared/studio3d/studio3dOperations.ts';
import type {
  OperationField,
  ProviderOperation,
  Validation,
} from '../../../../shared/studio3d/studio3dOperations.ts';
import { inspectGlbFile, rewriteGlbFile } from './analysisProcess.ts';
import type { Quaternion } from './glb.ts';
import type { InputContext, LocalRequest, LocalResult, Studio3dProvider } from './provider.ts';

const HALF = Math.SQRT1_2;

const TURNS: Readonly<Record<string, { rotation: Quaternion; label: string }>> = {
  y90: {
    rotation: [0, HALF, 0, HALF],
    label: 'Поворот на 90° против часовой'
  },
  'y-90': {
    rotation: [0, -HALF, 0, HALF],
    label: 'Поворот на 90° по часовой'
  },
  y180: {
    rotation: [0, 1, 0, 0],
    label: 'Поворот на 180°'
  },
};

/**
 * Поле поворота с подсказкой по сводке: если фигура смотрит вдоль Z, Tripo охотнее
 * оснастит её после поворота на 90° — у Гринёва без этого проверка отвечала «нельзя».
 */
function rotateFields(context: InputContext): OperationField[] {
  const facing = context.stats?.facing;
  const hint = facing === 'z'
    ? 'Сейчас фигура смотрит вдоль Z; Tripo охотнее оснащает модель, смотрящую вдоль X.'
    : 'Поворот вокруг вертикальной оси; скелет и движения поворачиваются вместе с моделью.';

  return [{
    id: 'turn',
    kind: 'select',
    label: 'Поворот',
    default: 'y90',
    hint,
    options: [
      {
        value: 'y90',
        label: 'На 90° против часовой',
        hint: 'Взгляд с +Z на +X.'
      },
      {
        value: 'y-90',
        label: 'На 90° по часовой',
        hint: 'Взгляд с +X на +Z.'
      },
      {
        value: 'y180',
        label: 'На 180°'
      },
    ],
  }];
}

/**
 * Поле роста с подсказкой о текущей высоте. Tripo возвращает модели в своём масштабе
 * (у скелета размах рук равен единице), поэтому рост задаётся явно.
 */
function scaleFields(context: InputContext): OperationField[] {
  const height = context.stats?.size?.[1];

  return [{
    id: 'height',
    kind: 'number',
    label: 'Рост, м',
    required: true,
    min: 0.01,
    max: 1000,
    hint: typeof height === 'number' ? `Сейчас ${height.toLocaleString('ru-RU')} м.` : undefined,
  }];
}

/**
 * Проверка помощника: только GLB, у роста — известная высота модели. Значения
 * нормализуются общим правилом формы.
 */
function validateLocal(operation: string, raw: Record<string, unknown>, context: InputContext): Validation {
  const builders: Readonly<Record<string, (input: InputContext) => OperationField[]>> = {
    rotate: rotateFields,
    scale: scaleFields
  };
  const fields = builders[operation]?.(context) ?? null;

  if (!fields) {
    return {
      values: {},
      errors: [{
        field: null,
        message: 'Помощник этого не умеет.'
      }],
      warnings: []
    };
  }

  const result = normalizeValues(fields, raw);

  if (context.format !== 'glb') {
    result.errors.push({
      field: null,
      message: 'Помощники работают только с GLB.'
    });
  }

  const height = context.stats?.size?.[1];

  if (operation === 'scale' && !(typeof height === 'number' && height > 0)) {
    result.errors.push({
      field: null,
      message: 'Высота модели неизвестна — рост задать нельзя.'
    });
  }

  return result;
}

/**
 * Создаёт исполнителя «Локально». Действия мгновенные и бесплатные: файл
 * переписывается новым корневым узлом, бинарные данные модели не трогаются.
 */
export function createLocalStudio(): Studio3dProvider {
  return {
    id: 'local',
    name: 'Локально',
    local: true,
    unit: null,
    usdPerUnit: null,
    available: () => true,
    operations(context): ProviderOperation[] {
      return [
        {
          operation: 'rotate',
          fields: rotateFields(context)
        },
        {
          operation: 'scale',
          fields: scaleFields(context)
        },
      ];
    },
    validate: validateLocal,
    quote: () => ({
      total: 0,
      lines: [],
      unit: null,
      usd: null,
      note: null
    }),
    run: runLocal,
  };
}

/**
 * Выполняет помощник: читает GLB входа, оборачивает его поворотом или масштабом и
 * пишет model.glb в папку новой версии. Подпись версии называет, что сделано.
 */
async function runLocal(request: LocalRequest): Promise<LocalResult> {
  let label: string;
  let options;

  if (request.operation === 'rotate') {
    const turn = TURNS[String(request.values.turn)];

    if (!turn) {
      throw new Error('Неизвестный поворот модели.');
    }

    options = {
      rotation: turn?.rotation,
      name: 'grigdesk-rotate'
    };
    label = turn?.label ?? 'Поворот';
  } else if (request.operation === 'scale') {
    const height = Number(request.values.height);
    const current = (await inspectGlbFile(request.inputPath, {
      root: request.root,
      signal: request.signal
    })).size?.[1] ?? 0;

    if (!(current > 0) || !(height > 0)) {
      throw new Error('Высота модели неизвестна — рост задать нельзя.');
    }

    options = {
      scale: height / current,
      name: 'grigdesk-scale'
    };
    label = `Рост ${height.toLocaleString('ru-RU')} м`;
  } else {
    throw new Error('Неизвестный помощник.');
  }

  await fs.mkdir(request.outputDir, { recursive: true });
  await rewriteGlbFile(request.inputPath, path.join(request.outputDir, 'model.glb'), options, {
    root: request.root,
    signal: request.signal
  });

  return {
    files: [{
      role: 'model',
      name: 'model.glb'
    }],
    label
  };
}

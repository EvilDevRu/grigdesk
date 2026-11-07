// Разбор ответов, записей задач и истории трат Tripo.
// Роли файлов, параметры и стоимость проверяются на границе протокола.

import { createHash } from 'node:crypto';
import { IMAGE_TASKS, MODEL_PRODUCING, TASK_OPERATIONS, VIEW_TASKS } from './catalogValues.ts';
import { tripoTaskError } from './taskErrors.ts';
import type { FieldValues } from '../../../../shared/studio3d/studio3dOperations.ts';
import type {
  RecordedTask, RemoteOutput, RemoteState, RemoteTask, UsageRecord,
} from '../studio3d/provider.ts';

const STATES: readonly RemoteState[] = [
  'queued',
  'running',
  'success',
  'failed',
  'cancelled',
  'banned',
  'expired',
];

const URL_ROLES: Readonly<Record<string, string>> = {
  model_url: 'model',
  pbr_model_url: 'model',
  base_model_url: 'base-model',
  seg_model_url: 'model',
  rendered_image_url: 'preview',
  front_view_url: 'front',
  left_view_url: 'left',
  back_view_url: 'back',
  right_view_url: 'right',
  image_url: 'image',
  mask_url: 'mask',
  uv_render_url: 'uv',
};

/**
 * Собирает ссылки из output задачи: известные поля получают свою роль, прочие
 * ссылки — роль image или file. Ссылки подписаны и живут минуты: их сразу качают.
 */
function collectOutputs(output: unknown, type: string): RemoteOutput[] {
  const found: RemoteOutput[] = [];

  /**
   * Обходит объект и массивы вглубь; строка-ссылка становится файлом с ролью по
   * имени поля. Глубина ограничена: ответ исполнителя недоверенный.
   */
  const visit = (value: unknown, key: string, fieldPath: string, depth: number) => {
    if (depth > 4 || found.length >= 128) {
      return;
    }

    if (typeof value === 'string' && /^https?:\/\//.test(value)) {
      const extension = extensionOf(value);
      const ext = /^[a-z0-9]{1,10}$/.test(extension) ? extension : 'bin';
      const declaredRole = URL_ROLES[key] ?? 'file';
      const role = type === 'convert_model' && declaredRole === 'model' ? 'file' : declaredRole;
      const id = createHash('sha256').update(fieldPath).digest('hex').slice(0, 16);

      found.push({
        id,
        name: `${role}-${id}.${ext}`,
        role,
        url: value,
        ext
      });
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, key, `${fieldPath}.${index}`, depth + 1));
    } else if (value && typeof value === 'object') {
      for (const [childKey, child] of Object.entries(value)) {
        visit(child, childKey === 'url' ? key : childKey, `${fieldPath}.${childKey}`, depth + 1);
      }
    }
  };

  visit(output, '', '', 0);

  return found;
}

/**
 * Выбирает main из объявленных полей, независимо от порядка URL. Неизвестный ассет
 * сохраняется дополнительным файлом и не доказывает обязательный результат задачи.
 */
function outputContract(type: string, output: Record<string, unknown>, files: RemoteOutput[]) {
  const views = ['front', 'left', 'back', 'right'].filter((role) => files.some((file) => file.role === role));
  const viewTask = VIEW_TASKS.has(type);
  const imageTask = IMAGE_TASKS.has(type);
  const check = type === 'animate_prerigcheck';
  const modelTypes = ['image_to_splat', 'smartsegment_model', 'smartsegment_image'];
  const modelTask = MODEL_PRODUCING.has(type) || modelTypes.includes(type);
  const candidates = imageTask ? ['image_url'] : ['pbr_model_url', 'model_url', 'seg_model_url'];
  const expected = type === 'convert_model' ? 'file' : imageTask ? 'image' : 'model';
  let main: RemoteOutput | undefined;

  if (!viewTask && !check && (imageTask || modelTask)) {
    for (const key of candidates) {
      const value = output[key];
      const url = typeof value === 'string' ? value
        : value && typeof value === 'object' ? (value as Record<string, unknown>).url : null;

      main = files.find((file) => file.role === expected && file.url === url);

      if (main) {
        break;
      }
    }
  }

  for (const file of files) {
    const sameRole = files.filter((entry) => entry.role === file.role);

    if (file === main || sameRole.length === 1) {
      file.name = `${file.role}.${file.ext}`;
    }
  }

  const requiredRoles = check ? [] : viewTask ? (views.length ? views : ['front'])
    : imageTask || modelTask ? [expected] : ['unsupported-result'];

  return {
    mainFileId: main?.id ?? null,
    requiredRoles,
    views: viewTask ? views : []
  };
}

/**
 * Расширение файла по пути ссылки без подписи: model.glb?auth_key=… → glb.
 * Битая ссылка даёт пустую строку, а не исключение.
 */
function extensionOf(url: string): string {
  try {
    const name = new URL(url).pathname.split('/').at(-1) ?? '';
    const dot = name.lastIndexOf('.');

    return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  } catch {
    return '';
  }
}

/**
 * Приводит задачу Tripo к общему виду раздела. Неизвестный статус не превращается в
 * успех; прогресс ограничен 0–100; остаток времени берётся с верхнего уровня или из
 * output, как это делает tripo-cli.
 */
export function parseTripoTask(raw: unknown): RemoteTask | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  const task = raw as Record<string, unknown>;

  if (typeof task.task_id !== 'string' || !task.task_id) {
    return null;
  }

  const output = task.output && typeof task.output === 'object' ? task.output as Record<string, unknown> : {};
  const state = STATES.includes(task.status as RemoteState) ? task.status as RemoteState : 'unknown';
  const eta = numberOrNull(task.running_left_time) ?? numberOrNull(output.running_left_time);
  const reported = Math.round(numberOrNull(task.progress) ?? 0);
  const progress = state === 'success' ? 100 : Math.max(0, Math.min(100, reported));
  const type = typeof task.type === 'string' ? task.type : '';
  const outputs = collectOutputs(output, type);

  return {
    id: task.task_id,
    type,
    state,
    progress,
    etaSeconds: eta !== null && eta >= 0 ? eta : null,
    outputs,
    ...outputContract(type, output, outputs),
    extra: {
      ...taskExtra(output),
      params: recordedParams(task.input),
      inputTaskId: inputTaskId(task.input),
    },
    cost: numberOrNull(task.credits_consumed),
    error: ['failed', 'cancelled', 'banned', 'expired'].includes(state)
      ? tripoTaskError(state, numberOrNull(task.error_code), stringOrNull(task.error_message))
      : null,
    createdAt: stringOrNull(task.created_at),
    completedAt: stringOrNull(task.completed_at),
  };
}

/**
 * Неслучайные данные задачи кроме файлов: итог проверки скелета, подписи частей
 * умной сегментации и номера её внутренних задач.
 */
function taskExtra(output: Record<string, unknown>): Record<string, unknown> {
  const extra: Record<string, unknown> = {};

  if (typeof output.riggable === 'boolean') {
    extra.riggable = output.riggable;
    extra.rigType = typeof output.rig_type === 'string' ? output.rig_type : null;
  }

  if (typeof output.prompt === 'string') {
    extra.labels = output.prompt.split(',').map((label) => label.trim()).filter(Boolean).slice(0, 64);
  }

  return extra;
}

// Конечное число или null: ответ исполнителя не доверенный.
function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// Непустая строка не длиннее 2000 знаков или null.
function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value ? value.slice(0, 2000) : null;
}

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

/**
 * Узнаёт запись задачи Tripo на диске: файл task.json от tripo-cli или сохранённый
 * ответ GET /v3/tasks. Оба несут номер и тип задачи; остальное поле — по возможности.
 */
export function recognizeTripoRecord(json: unknown): RecordedTask | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return null;
  }

  let record = json as Record<string, unknown>;

  if ('code' in record || 'data' in record) {
    if (record.code !== 0 || !record.data || typeof record.data !== 'object' || Array.isArray(record.data)) {
      return null;
    }

    record = record.data as Record<string, unknown>;
  }

  if (typeof record.task_id !== 'string' || !TASK_ID.test(record.task_id)) {
    return null;
  }

  if (typeof record.type !== 'string' || !TASK_OPERATIONS[record.type]) {
    return null;
  }

  const input = record.input && typeof record.input === 'object'
    ? record.input as Record<string, unknown>
    : {};
  const source = inputTaskId(input);
  const params = recordedParams(input);

  const parsed = parseTripoTask(record);
  const riggable = parsed?.extra.riggable;

  return {
    taskId: record.task_id,
    type: record.type,
    createdAt: stringOrNull(record.created_at),
    completedAt: stringOrNull(record.completed_at),
    credits: numberOrNull(record.credits_consumed),
    prompt: typeof input.prompt === 'string' ? input.prompt.slice(0, 1024) : null,
    inputTaskId: source,
    params,
    status: parsed?.state ?? 'unknown',
    rigResult: typeof riggable === 'boolean' ? {
      riggable,
      rigType: typeof parsed?.extra.rigType === 'string' ? parsed.extra.rigType : null
    } : null,
    source: Array.isArray(record.files) ? 'cli' : 'raw',
  };
}

/**
 * Только scalar/строковые массивы API input становятся параметрами версии.
 * Ключ доступа и непрозрачные объекты не переносятся в persistent provenance.
 */
function recordedParams(value: unknown): FieldValues {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const params: FieldValues = {};

  for (const [key, item] of Object.entries(input)) {
    if (/key|token|secret|credential|authorization/i.test(key)) {
      continue;
    }

    if (item === null || typeof item === 'string' || typeof item === 'boolean'
      || (typeof item === 'number' && Number.isFinite(item))) {
      params[key] = item;
    } else if (Array.isArray(item) && item.every((entry) => typeof entry === 'string')) {
      params[key] = item;
    }
  }

  return params;
}

/**
 * Только task UUID задаёт родство; file token остаётся файловым входом.
 * Произвольная строка input не превращается в native provenance.
 */
function inputTaskId(value: unknown): string | null {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const upstream = [input.original_model_id, input.input]
    .find((id) => typeof id === 'string' && TASK_ID.test(id));

  return typeof upstream === 'string' ? upstream : null;
}

/**
 * Строки истории трат: номер, тип, сумма и время. Мусорные строки отбрасываются —
 * список приходит от исполнителя и проверяется поле за полем.
 */
export function parseUsage(data: unknown): UsageRecord[] {
  if (!Array.isArray(data)) {
    return [];
  }

  return data.flatMap((item) => {
    const row = item && typeof item === 'object' ? item as Record<string, unknown> : {};

    if (typeof row.task_id !== 'string' || !TASK_ID.test(row.task_id) || typeof row.type !== 'string') {
      return [];
    }

    return [{
      taskId: row.task_id,
      type: row.type,
      credits: numberOrNull(row.credits_consumed),
      createdAt: stringOrNull(row.created_at)
    }];
  });
}

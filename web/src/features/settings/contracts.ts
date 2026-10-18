import { isPlainRecord } from '../../../../shared/lib/objects.ts';
import { ApiError } from '../../shared/apiClient.ts';

export interface FieldAddress {
  pageId: string;
  entityId?: string;
  tabId?: string;
  fieldPath: string[];
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type FieldIntent =
  | {
    op: 'set';
    value: JsonValue;
    confirmed?: true;
  }
  | { op: 'unset' };

export type WriteStatus = 'success' | 'failed' | 'conflict' | 'unknown';

export interface FieldResult {
  key: string;
  status: WriteStatus;
  serverValue?: JsonValue;
  message?: string;
}

export interface ResourceWriteResult {
  status: WriteStatus;
  fields: FieldResult[];
  message?: string;
  httpStatus?: number;
}

export type WriteOutcome =
  | { ok: true }
  | {
    ok: false;
    outcome: Exclude<WriteStatus, 'success'>;
    status?: number;
    message: string;
  };

export interface ResourceAdapter {
  readonly id: string;
  readonly chain: string;
  readonly order: number;
  readonly sortKey?: readonly string[];
  readonly body: 'patch' | 'full-record' | 'per-field';
  readonly supportsUnset: boolean;
  read(signal: AbortSignal, refresh?: boolean): Promise<Record<string, JsonValue>>;
  validate(
    intents: ReadonlyMap<string, FieldIntent>,
    baseline: Readonly<Record<string, JsonValue>>,
  ): Array<{ key: string; message: string }>;
  write(
    intents: ReadonlyMap<string, FieldIntent>,
    baseline: Readonly<Record<string, JsonValue>>,
    signal: AbortSignal,
  ): Promise<ResourceWriteResult>;
}

export interface SessionField {
  key: string;
  address: FieldAddress;
  secret?: boolean;
  unavailable?: string;
  hasStoredValue?: boolean;
}

export interface ValidationIssue {
  resourceId: string;
  key: string;
  address: FieldAddress;
  message: string;
}

export interface FieldConflict {
  present: boolean;
  serverValue?: JsonValue;
}

export interface SessionFieldState extends SessionField {
  dirty: boolean;
  hasSecretDraft: boolean;
  value?: JsonValue;
  intent?: FieldIntent;
  conflict?: FieldConflict;
  error?: string;
}

export interface SessionResourceState {
  id: string;
  loaded: boolean;
  fields: SessionFieldState[];
}

export interface SessionSnapshot {
  sessionId: number;
  active: boolean;
  dirtyCount: number;
  resources: SessionResourceState[];
  applying: boolean;
  delayed: boolean;
  canClose: boolean;
  statusMessage: string;
  lastResult?: ApplyResult;
}

export interface SessionClock {
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface FieldChange {
  resourceId: string;
  key: string;
  address: FieldAddress;
}

export interface SavedFieldChange extends FieldChange {
  normalized: boolean;
  serverValue?: JsonValue;
}

export interface ApplyFailure {
  resourceId: string;
  status: Exclude<WriteStatus, 'success'>;
  message: string;
  httpStatus?: number;
}

export interface ApplyResult {
  status: 'success' | 'partial' | 'failed' | 'conflict' | 'unknown';
  saved: SavedFieldChange[];
  remaining: FieldChange[];
  errors: ApplyFailure[];
  validation: ValidationIssue[];
  shouldClose: boolean;
}

/**
 * HTTP-отказ является известным исходом, а обрыв или повреждённый ответ — неизвестным.
 * Явный отказ доменного store сохраняет его исход и HTTP-код для остановки по 401.
 */
export function classifyWriteError(error: unknown): Exclude<WriteOutcome, { ok: true }> {
  if (error instanceof ApiError) {
    return {
      ok: false,
      outcome: error.status === 409 ? 'conflict' : 'failed',
      status: error.status,
      message: error.message,
    };
  }

  if (isPlainRecord(error) && error.ok === false) {
    const outcome = ['failed', 'conflict', 'unknown'].includes(String(error.outcome))
      ? error.outcome as Exclude<WriteStatus, 'success'>
      : typeof error.status === 'number' ? 'failed' : 'unknown';

    return {
      ok: false,
      outcome,
      ...(typeof error.status === 'number' ? { status: error.status } : {}),
      message: typeof error.message === 'string' ? error.message : 'Не удалось сохранить настройки',
    };
  }

  return {
    ok: false,
    outcome: 'unknown',
    message: 'Не удалось определить результат записи',
  };
}

/**
 * Общая классификация превращается в явный результат неподтверждённого запроса.
 * Пустой список полей не объявляет успешными никакие намерения ресурса.
 */
export function resourceWriteFailure(error: unknown): ResourceWriteResult {
  const failure = classifyWriteError(error);

  return {
    status: failure.outcome,
    fields: [],
    message: failure.message,
    ...(failure.status === undefined ? {} : { httpStatus: failure.status }),
  };
}

/**
 * Декодер подтверждения принимает только JSON-значения, включая явный null.
 * Функции, undefined и нечисловые number не становятся серверным baseline.
 */
function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value);
  }

  return Array.isArray(value) ? value.every(isJsonValue)
    : isPlainRecord(value) && Object.values(value).every(isJsonValue);
}

/**
 * Resolved Promise не подтверждает запись без ожидаемой формы результата.
 * Потерянное поле остаётся задачей координатора, повреждённая форма даёт unknown.
 */
export function decodeResourceWriteResult(value: unknown): ResourceWriteResult {
  if (isPlainRecord(value) && value.ok === false) {
    return resourceWriteFailure(value);
  }

  const statuses = ['success', 'failed', 'conflict', 'unknown'];

  if (!isPlainRecord(value) || !statuses.includes(String(value.status)) || !Array.isArray(value.fields)
      || (value.message !== undefined && typeof value.message !== 'string')
      || (value.httpStatus !== undefined && typeof value.httpStatus !== 'number')) {
    throw new TypeError('Некорректный ответ записи настроек');
  }

  const seen = new Set<string>();
  const fields = value.fields.map((field): FieldResult => {
    if (!isPlainRecord(field) || typeof field.key !== 'string' || seen.has(field.key)
        || !statuses.includes(String(field.status))
        || (field.message !== undefined && typeof field.message !== 'string')
        || (Object.hasOwn(field, 'serverValue') && !isJsonValue(field.serverValue))) {
      throw new TypeError('Некорректное подтверждение поля настроек');
    }

    seen.add(field.key);

    return {
      key: field.key,
      status: field.status as WriteStatus,
      ...(Object.hasOwn(field, 'serverValue') ? {
        serverValue: structuredClone(field.serverValue as JsonValue),
      } : {}),
      ...(field.message === undefined ? {} : { message: field.message as string }),
    };
  });

  return {
    status: value.status as WriteStatus,
    fields,
    ...(value.message === undefined ? {} : { message: value.message as string }),
    ...(value.httpStatus === undefined ? {} : { httpStatus: value.httpStatus as number }),
  };
}

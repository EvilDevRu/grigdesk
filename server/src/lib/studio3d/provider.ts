// Контракт 3D-исполнителя для раздела «3D». Раздел говорит только с этим интерфейсом:
// облачный исполнитель отправляет заказы и опрашивает их, локальный выполняет действие
// сразу. Подписи действий и их входы живут в shared/studio3d/studio3dOperations.ts.

import type {
  FieldValues,
  ProviderOperation,
  Quote,
  UnitForms,
  Validation,
  VersionKind,
} from '../../../../shared/studio3d/studio3dOperations.ts';

export type RemoteState =
  | 'queued'
  | 'running'
  | 'success'
  | 'failed'
  | 'cancelled'
  | 'banned'
  | 'expired'
  | 'unknown';

export type ProviderErrorKind =
  | 'auth'
  | 'credits'
  | 'busy'
  | 'rate'
  | 'params'
  | 'input'
  | 'moderation'
  | 'complex'
  | 'expired'
  | 'not-found'
  | 'server'
  | 'network'
  | 'unknown';

// Ошибка для человека: message написан по-русски кокпитом, detail — текст исполнителя.
export interface ProviderError {
  kind: ProviderErrorKind;
  code: number | null;
  message: string;
  detail: string | null;
  retryAfterMs: number | null;
}

export interface RemoteOutput {
  id: string;
  name: string;
  role: string;
  url: string;
  ext: string;
}

export interface RemoteTask {
  id: string;
  type: string;
  state: RemoteState;
  progress: number;
  etaSeconds: number | null;
  outputs: RemoteOutput[];
  mainFileId: string | null;
  requiredRoles: string[];
  views: string[];
  extra: Record<string, unknown>;
  cost: number | null;
  error: ProviderError | null;
  createdAt: string | null;
  completedAt: string | null;
}

// Сводка входной версии, нужная проверкам исполнителя.
export interface InputStats {
  triangles?: number;
  parts?: string[];
  bones?: number;
  size?: number[] | null;
  facing?: string | null;
}

// Что известно о версии, над которой делается шаг: вид, сводка, параметры и проверки.
export interface InputContext {
  kind: VersionKind | null;
  format: string | null;
  stats: InputStats | null;
  params: FieldValues | null;
  nativeTaskType: string | null;
  rigCheck: { riggable: boolean; rigType: string | null } | null;
  views: readonly string[];
}

export interface ResolvedInput {
  role: 'primary' | 'front' | 'left' | 'back' | 'right';
  native: {
    taskId: string;
    taskType: string;
    accountKey?: string;
  } | null;
  file: {
    path: string;
    name: string;
    root?: string;
  } | null;
}

export interface SubmitRequest {
  operation: string;
  values: FieldValues;
  inputs: readonly ResolvedInput[];
  context: InputContext;
}

// Один будущий заказ: подпись версии, её значения и тело, понятное только исполнителю.
export interface PlannedTask {
  childId: string;
  label: string;
  values: FieldValues;
  taskType: string;
  payload: unknown;
}

// Непрозрачные credentials существуют только в памяти; на диск разрешён accountKey.
export interface AccountSnapshot {
  accountKey: string;
  credentials: unknown;
  billingUrl: string | null;
}

export interface SubmittedTask {
  taskId: string;
  taskType: string;
}

export interface UsageRecord {
  taskId: string;
  type: string;
  credits: number | null;
  createdAt: string | null;
}

export interface RecordedTask {
  taskId: string;
  type: string;
  createdAt: string | null;
  completedAt: string | null;
  credits: number | null;
  prompt: string | null;
  inputTaskId: string | null;
  params: FieldValues;
  status: RemoteState;
  rigResult: { riggable: boolean; rigType: string | null } | null;
  source: 'raw' | 'cli';
}

export interface Balance {
  available: number;
  reserved: number;
}

export interface LocalRequest {
  operation: string;
  values: FieldValues;
  inputPath: string;
  context: InputContext;
  outputDir: string;
  root?: string;
  signal?: AbortSignal;
}

export interface LocalResult {
  files: { role: string; name: string }[];
  label: string;
}

/**
 * Отказ исполнителя при отправке. submitted: false — заказ точно не принят и
 * кредиты не тронуты; null — неизвестно (оборвалась связь после отправки), такой
 * заказ нельзя повторять автоматически: его ищут в истории трат.
 */
export class ProviderFailure extends Error {
  error: ProviderError;
  submitted: boolean | null;

  constructor(error: ProviderError, submitted: boolean | null) {
    super(error.message);
    this.error = error;
    this.submitted = submitted;
  }
}

export interface Studio3dProvider {
  id: string;
  name: string;
  local: boolean;
  unit: UnitForms | null;
  usdPerUnit: number | null;
  available(): boolean | Promise<boolean>;
  operations(context: InputContext): ProviderOperation[];
  validate(operation: string, raw: Record<string, unknown>, context: InputContext): Validation;
  quote(operation: string, values: FieldValues, context: InputContext): Quote;
  nativeAccepts?(operation: string, taskType: string | null): boolean;
  pool?(operation: string, values: FieldValues): { key: string; limit: number | null };
  snapshot?(): AccountSnapshot;
  isCurrent?(snapshot: AccountSnapshot): boolean;
  balance?(snapshot?: AccountSnapshot): Promise<Balance | null>;
  plan?(request: SubmitRequest): PlannedTask[];
  prepare?(task: PlannedTask, snapshot: AccountSnapshot): Promise<PlannedTask>;
  send?(task: PlannedTask, snapshot: AccountSnapshot): Promise<SubmittedTask>;
  poll?(
    taskIds: readonly string[],
    snapshot?: AccountSnapshot,
  ): Promise<{ tasks: RemoteTask[]; missed: string[] }>;
  history?(snapshot?: AccountSnapshot): Promise<UsageRecord[]>;
  recognizeRecord?(json: unknown): RecordedTask | null;
  taskOperation?(taskType: string): string | null;
  cancelReads?(): void;
  run?(request: LocalRequest): Promise<LocalResult>;
}

// Пустой контекст: действие с нуля, без версии на входе.
export const START_CONTEXT: InputContext = {
  kind: null,
  format: null,
  stats: null,
  params: null,
  nativeTaskType: null,
  rigCheck: null,
  views: [],
};

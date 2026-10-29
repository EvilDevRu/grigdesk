import type {
  FieldValues,
  ProviderOperation,
  Quote,
  UnitForms,
  Validation,
  VersionKind,
} from '../../../shared/studio3d/studio3dOperations.ts';

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

// Ошибка для человека: message написан по-русски GrigDesk, detail — текст исполнителя.
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

// Снимок связан с исполнителем внутри ядра; ключи доступа в него не входят.
export interface PluginAccountSnapshot {
  readonly accountKey: string;
  readonly billingUrl: string | null;
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

export type PluginProvider = Readonly<{
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
  snapshot?(): PluginAccountSnapshot;
  isCurrent?(snapshot: PluginAccountSnapshot): boolean;
  balance?(snapshot?: PluginAccountSnapshot): Promise<Balance | null>;
  plan?(request: SubmitRequest): PlannedTask[];
  prepare?(task: PlannedTask, snapshot: PluginAccountSnapshot): Promise<PlannedTask>;
  send?(task: PlannedTask, snapshot: PluginAccountSnapshot): Promise<SubmittedTask>;
  poll?(
    taskIds: readonly string[],
    snapshot?: PluginAccountSnapshot,
  ): Promise<{ tasks: RemoteTask[]; missed: string[] }>;
  history?(snapshot?: PluginAccountSnapshot): Promise<UsageRecord[]>;
  recognizeRecord?(json: unknown): RecordedTask | null;
  taskOperation?(taskType: string): string | null;
  cancelReads?(): void;
  run?(request: LocalRequest): Promise<LocalResult>;
}>;

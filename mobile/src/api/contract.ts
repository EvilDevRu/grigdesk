import { mobileSchema } from './mobileContractSchema.ts';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export type Actions = Record<string, string>;
export type Page = {
  hasMore: boolean;
  nextCursor: string | null;
};
export type ChatState = 'idle' | 'running' | 'queued';
export type TaskState = 'running' | 'waiting' | 'stopped' | 'done' | 'idle';
export type DeviceInfo = {
  id: string;
  name: string;
};
export type Hello = {
  api: 1;
  features?: string[];
  minApp: string;
  serverTime: number;
  server: {
    name: string;
    version: string;
  };
  device: DeviceInfo | null;
};
export type ChatProvider = {
  id: string;
  name: string;
  color: string;
};
export type ChatActivityItem = {
  id: string;
  kind: 'tool' | 'think' | 'text' | 'note';
  title: string;
  text: string;
  result: string;
  state: 'running' | 'done' | 'error';
  at: number;
};
export type ChatActivity = {
  items: ChatActivityItem[];
  omitted: number;
};
export type ModelRef = { provider: string; model: string };
export type WorkdirChoice =
  | { kind: 'grigdesk' }
  | {
    kind: 'project';
    projectId: string;
    repoKey: string | null;
  }
  | { kind: 'path'; path: string };
export type ChatContext = {
  tokens: number | null;
  window: number | null;
  metric: string;
  estimate: boolean;
  live: boolean;
  compactWindow: number;
};
export type ChatSettings = {
  modelRef: ModelRef | null;
  workdir: WorkdirChoice;
  directory: string;
  context: ChatContext;
};
export type ChatModel = {
  provider: string;
  providerName: string;
  id: string;
  name: string;
  efforts: string[];
  context: number | null;
  contextVerified: boolean;
  autoCompact: boolean;
  available: boolean;
};
export type ChatOptions = {
  models: ChatModel[];
  defaultModelRef: ModelRef | null;
  tasks: Array<{ id: string; title: string }>;
  projects: Array<{ id: string; title: string }>;
  tasksOmitted: number;
  projectsOmitted: number;
};
export type WorkspacePreview = {
  directory: string;
  previousDirectory: string;
  transfer: 'none' | 'resume' | 'reseed' | 'unavailable';
  summaryAvailable: boolean;
  warnings: string[];
  actionToken: string;
};
export type Attention = {
  chats: {
    waiting: number;
    unread: number;
    running: number;
  };
  tasks: {
    waiting: number;
    stalled: number;
    running: number;
  };
};
export type ChatResult = { id: string; revision: number };

export type ChatSummary = {
  id: string;
  title: string;
  updatedAt: number;
  taskId: string | null;
  model: string;
  state: ChatState;
  waiting: number;
  modelRef?: ModelRef;
  unread?: boolean;
  provider?: ChatProvider;
  preview?: string;
  archived?: boolean;
  purpose?: string;
};
export type MessagePart =
  | {
      type: 'text';
      text: string;
      truncated?: boolean;
    }
  | {
      type: 'code';
      lang: string;
      text: string;
      truncated?: boolean;
    }
  | {
      type: 'image';
      ref: string;
      alt: string;
    };
export type Media = {
  ref: string;
  alt: string;
  from: 'step' | 'upload';
};
export type MobileMessage = {
  index: number;
  id: string;
  role: 'user' | 'assistant';
  turnId: string | null;
  clientId: string | null;
  at: number;
  stopped: boolean;
  error: boolean;
  parts: MessagePart[];
  media: Media[];
  activity?: ChatActivity;
};
export type Chats = Page & { chats: ChatSummary[] };
export type Chat = {
  chat: ChatSummary & {
    effort: string;
    settings?: ChatSettings;
    revision: number;
    actions: Actions;
  };
  activity?: ChatActivity;
  messages: MobileMessage[];
  hasMore: boolean;
  nextBefore: number | null;
};
export type Accepted = {
  accepted: true;
  clientId: string;
  turnId: string;
  state: 'started' | 'queued' | 'running' | 'done';
  duplicate: boolean;
};
export type Delivery = {
  clientId: string;
  turnId: string | null;
  state: 'unknown' | 'queued' | 'running' | 'done';
  outcome: 'reply' | 'stopped' | 'error' | 'refused' | 'interrupted' | null;
};
export type Deliveries = { deliveries: Delivery[] };
export type InputType = 'text' | 'number' | 'integer' | 'boolean' | 'choice' | 'multi-choice';
export type Question = {
  id: string;
  header: string;
  question: string;
  multiSelect: boolean;
  allowFreeText: boolean;
  inputType: InputType;
  required: boolean;
  options: Array<{
    id: string;
    label: string;
    description: string;
  }>;
  constraints: {
    format?: string;
    minLength?: number;
    maxLength?: number;
    minimum?: number;
    maximum?: number;
    minItems?: number;
    maxItems?: number;
  };
};
export type Permission = {
  pid: string;
  chatId: string | null;
  kind: 'permission';
  tool: string;
  summary: string;
  details: string;
  acceptsComment: boolean;
  canRemember: false;
  contentRevision: string;
  hasMore: boolean;
  nextOffset: number | null;
  actionToken: string | null;
};
export type QuestionWaiting = {
  pid: string;
  chatId: string | null;
  kind: 'question';
  prompt: string;
  structured: boolean;
  actions: Array<'accept' | 'cancel' | 'decline'>;
  questions: Question[];
  actionToken: string | null;
};
export type UnsupportedWaiting = {
  pid: string;
  chatId: string | null;
  kind: 'unsupported';
  reason: string;
};
export type Waiting = Page & { items: Array<Permission | QuestionWaiting | UnsupportedWaiting> };
export type TextPage = {
  text: string;
  contentRevision: string;
  hasMore: boolean;
  nextOffset: number | null;
  readToken: string | null;
};
export type TaskSummary = {
  id: string;
  title: string;
  state: TaskState;
  stage: string;
  needsHuman: {
    kind: 'gate' | 'other';
    gate: string | null;
    text: string;
    actionToken: string | null;
  } | null;
  updatedAt: number;
};
export type Tasks = Page & { tasks: TaskSummary[] };
export type Task = {
  task: TaskSummary & {
    stages: Array<{
      key: string;
      title: string;
      status: 'done' | 'running' | 'waiting' | 'failed' | 'idle';
    }>;
    actions: Actions;
  };
};
export type B24Summary = {
  id: string;
  title: string;
  status: string;
  deadline: number | null;
  priority: number;
  onPipeline: boolean;
};
export type B24Tasks = Page & { tasks: B24Summary[] };
export type B24Task = {
  task: {
    id: string;
    title: string;
    description: string;
    status: string;
    deadline: number | null;
    responsible: string;
    truncated?: boolean;
  };
};
export type LaunchOptions = {
  options: Array<{
    id: string;
    title: string;
    disabledReason?: string | null;
  }>;
  defaultId: string | null;
  actionToken: string | null;
  reason: string | null;
};
export type AppUpdate = {
  version: string;
  versionCode: number;
  size: number;
  sha256: string;
};
export type Operation = {
  state: 'pending' | 'done' | 'unknown' | 'not_found';
  result: {
    status: number;
    body: JsonValue;
  } | null;
};
export type WaitingAnswer = {
  action?: 'accept' | 'cancel' | 'decline';
  decision?: 'allow' | 'deny';
  comment?: string;
  actionToken: string;
  answers?: Array<{
    questionId: string;
    optionIds?: string[];
    text?: string;
    value?: JsonValue;
  }>;
};

type Schema = {
  type?: string;
  enum?: unknown[];
  anyOf?: Schema[];
  $ref?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  maxItems?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
};

export class ContractError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`Ответ не соответствует мобильному контракту: ${path}`);
    this.name = 'ContractError';
    this.path = path;
  }
}

/**
 * Обходит закреплённую JSON Schema без привязки к внутренним DTO GrigDesk.
 * Дополнительные поля допускаются, а обязательные поля, nullable и enum проверяются явно.
 */
function validate(schema: Schema, value: unknown, field: string, depth = 0): void {
  if (depth > 40) {
    throw new ContractError(field);
  }
  if (schema.$ref) {
    const key = schema.$ref.replace('#/$defs/', '');
    const target = (mobileSchema.$defs as unknown as Record<string, Schema>)[key];

    if (!target) {
      throw new ContractError(field);
    }

    validate(target, value, field, depth + 1);

    return;
  }
  if (schema.anyOf) {
    for (const variant of schema.anyOf) {
      try {
        validate(variant, value, field, depth + 1);

        return;
      } catch (error) {
        if (!(error instanceof ContractError)) {
          throw error;
        }
      }
    }

    throw new ContractError(field);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    throw new ContractError(field);
  }
  if (schema.type === 'null' && value !== null) {
    throw new ContractError(field);
  }
  if (schema.type === 'string') {
    if (
      typeof value !== 'string' ||
      value.length > (schema.maxLength ?? Infinity) ||
      (schema.pattern && !new RegExp(schema.pattern).test(value))
    ) {
      throw new ContractError(field);
    }
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      (schema.type === 'integer' && !Number.isSafeInteger(value)) ||
      value < (schema.minimum ?? -Infinity) ||
      value > (schema.maximum ?? Infinity)
    ) {
      throw new ContractError(field);
    }
  }
  if (schema.type === 'boolean' && typeof value !== 'boolean') {
    throw new ContractError(field);
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length > (schema.maxItems ?? Infinity)) {
      throw new ContractError(field);
    }

    value.forEach((item, index) =>
      validate(schema.items ?? {}, item, `${field}[${index}]`, depth + 1),
    );
  }
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new ContractError(field);
    }

    const object = value as Record<string, unknown>;

    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(object, key)) {
        throw new ContractError(`${field}.${key}`);
      }
    }
    for (const [key, item] of Object.entries(object)) {
      const property = schema.properties?.[key];

      if (property) {
        validate(property, item, `${field}.${key}`, depth + 1);
      } else if (schema.additionalProperties === false) {
        throw new ContractError(`${field}.${key}`);
      } else if (typeof schema.additionalProperties === 'object') {
        validate(schema.additionalProperties, item, `${field}.${key}`, depth + 1);
      }
    }
  }
}

/**
 * Закрывает неверный или слишком большой ответ до помещения данных в состояние UI.
 * Один и тот же декодер копируется в приложение после фиксации схемы и интеграционных тестов.
 */
export function decodeContract<T = unknown>(kind: string, value: unknown): T {
  const schema = (mobileSchema.$defs as unknown as Record<string, Schema>)[kind];
  let size: number;

  try {
    size = new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    throw new ContractError('$');
  }

  if (!schema || size > 2 * 1024 * 1024) {
    throw new ContractError('$');
  }

  validate(schema, value, '$');

  return value as T;
}

/**
 * Проверяет форму «hello» перед чтением её обязательных полей.
 * Необязательные поля будущего v1 остаются совместимыми с закреплёнными enum.
 */
export function decodeHello(value: unknown): Hello {
  return decodeContract<Hello>('hello', value);
}

/**
 * Проверяет форму «chats» перед чтением её обязательных полей.
 * Необязательные поля будущего v1 остаются совместимыми с закреплёнными enum.
 */
export function decodeChats(value: unknown): Chats {
  return decodeContract<Chats>('chats', value);
}

/**
 * Проверяет форму «chat» перед чтением её обязательных полей.
 * Необязательные поля будущего v1 остаются совместимыми с закреплёнными enum.
 */
export function decodeChat(value: unknown): Chat {
  return decodeContract<Chat>('chat', value);
}

/**
 * Проверяет форму «accepted» перед чтением её обязательных полей.
 * Необязательные поля будущего v1 остаются совместимыми с закреплёнными enum.
 */
export function decodeAccepted(value: unknown): Accepted {
  return decodeContract<Accepted>('accepted', value);
}

/**
 * Проверяет форму «waiting» перед чтением её обязательных полей.
 * Необязательные поля будущего v1 остаются совместимыми с закреплёнными enum.
 */
export function decodeWaiting(value: unknown): Waiting {
  return decodeContract<Waiting>('waiting', value);
}

/**
 * Проверяет форму «tasks» перед чтением её обязательных полей.
 * Необязательные поля будущего v1 остаются совместимыми с закреплёнными enum.
 */
export function decodeTasks(value: unknown): Tasks {
  return decodeContract<Tasks>('tasks', value);
}

/**
 * Проверяет форму «task» перед чтением её обязательных полей.
 * Необязательные поля будущего v1 остаются совместимыми с закреплёнными enum.
 */
export function decodeTask(value: unknown): Task {
  return decodeContract<Task>('task', value);
}

/**
 * Проверяет форму «b24-tasks» перед чтением её обязательных полей.
 * Необязательные поля будущего v1 остаются совместимыми с закреплёнными enum.
 */
export function decodeB24Tasks(value: unknown): B24Tasks {
  return decodeContract<B24Tasks>('b24-tasks', value);
}

/**
 * Проверяет форму «b24-task» перед чтением её обязательных полей.
 * Необязательные поля будущего v1 остаются совместимыми с закреплёнными enum.
 */
export function decodeB24Task(value: unknown): B24Task {
  return decodeContract<B24Task>('b24-task', value);
}

/**
 * Проверяет форму «launch-options» перед чтением её обязательных полей.
 * Необязательные поля будущего v1 остаются совместимыми с закреплёнными enum.
 */
export function decodeLaunchOptions(value: unknown): LaunchOptions {
  return decodeContract<LaunchOptions>('launch-options', value);
}

/**
 * Проверяет форму «app» перед чтением её обязательных полей.
 * Необязательные поля будущего v1 остаются совместимыми с закреплёнными enum.
 */
export function decodeAppUpdate(value: unknown): AppUpdate {
  return decodeContract<AppUpdate>('app', value);
}

/**
 * Проверяет форму «operations» перед чтением её обязательных полей.
 * Необязательные поля будущего v1 остаются совместимыми с закреплёнными enum.
 */
export function decodeOperation(value: unknown): Operation {
  return decodeContract<Operation>('operations', value);
}

/**
 * Проверяет форму «plan» перед чтением её обязательных полей.
 * Необязательные поля будущего v1 остаются совместимыми с закреплёнными enum.
 */
export function decodeTextPage(value: unknown): TextPage {
  return decodeContract<TextPage>('plan', value);
}

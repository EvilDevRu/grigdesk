// Клиентские формы подтверждений и вопросов: расширения исполнителя остаются данными.
// Сетевой envelope проверяется владельцем состояния перед публикацией этих форм.
import { localeTranslator } from '../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from './uiLocalePort.ts';
import { isRecord } from '../../../shared/lib/objects.ts';
import { normalizeChatWorkdir } from '../../../shared/chat/chatWorkdir.ts';
import type { ChatWorkdir } from '../../../shared/chat/chatWorkdir.ts';
import type { ChatContextUsage } from '../../../shared/chat/chatContextUsage.ts';
import type { ChatRunSnapshot } from '../../../shared/chat/chatRun.ts';
import type { ChatInTurnRun } from '../stores/chatInTurn.ts';
import type { InTurnPage, InTurnAvailability, InTurnReceipt, InTurnAssistantBlock }
  from '../../../shared/chat/chatInTurnContracts.ts';
import type { InTurnAttachment } from '../../../shared/chat/chatInTurnContracts.ts';

const t = localeTranslator(uiLocalePort);

export interface ChatAttachment extends Omit<InTurnAttachment, 'mime'> {
  mime?: string;
  path?: string;
}

/**
 * Файл загрузки проверяется перед добавлением в черновик или уточнение.
 * Неверный ответ остаётся ошибкой загрузки и не создаёт сломанное вложение.
 */
export function decodeChatAttachment(value: unknown): ChatAttachment {
  if (!isChatAttachment(value)) {
    throw new Error(t('core.invalidChatAttachment'));
  }

  return value;
}

/**
 * Контейнер хранит канонические строки файла и необязательный локальный путь.
 * Старый ответ без MIME остаётся обычным файлом, дополнительные поля не теряются.
 */
function isChatAttachment(value: unknown): value is ChatAttachment {
  return isRecord(value)
    && ['file', 'name', 'url'].every((key) => typeof value[key] === 'string')
    && (value.mime === undefined || typeof value.mime === 'string')
    && (value.path == null || typeof value.path === 'string');
}

export interface PermissionChoice {
  id: string;
  label: string;
  kind?: string;
}

export interface ChatPermission {
  pid: string;
  origin?: string;
  kind?: string;
  chatKey?: string;
  tool?: string;
  command?: string;
  canRemember?: boolean;
  user?: string;
  isRoot?: boolean;
  usesSudo?: boolean;
  server?: {
    label?: string;
    host?: string;
    port?: number;
  };
  profile?: { label?: string; role?: string };
  engine?: { label?: string; id?: string };
  prod?: boolean;
  queryClass?: string;
  tables?: string[];
  tableFunctions?: string[];
  forbidden?: string[];
  rowEstimate?: number;
  query?: string;
  autoReadReason?: { message?: string };
  input?: {
    kind?: string;
    description?: string;
    plan?: string;
    diff?: { old?: string; new?: string };
    choices?: PermissionChoice[];
    [key: string]: unknown;
  };
}

export type QuestionScalar = string | number | boolean | null;
export type QuestionValue = QuestionScalar | QuestionScalar[];

export interface ChatQuestionItem {
  key?: string;
  question: string;
  header?: string;
  hint?: string;
  multiSelect?: boolean;
  allowFreeText?: boolean;
  inputType?: string;
  format?: string;
  required?: boolean;
  placeholder?: string;
  default?: QuestionValue;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  options?: Array<{
    value?: QuestionValue;
    label?: string;
    description?: string;
  }>;
}

export interface ChatQuestion {
  pid: string;
  questions?: ChatQuestionItem[];
  structured?: boolean;
  source?: string;
  prompt?: string;
  actions?: Array<string | { action: string; label?: string }>;
}

export interface ChatChange {
  path?: string;
  kind?: string;
  diff?: string | { old?: string; new?: string };
}

export interface ChatStep extends Record<string, unknown> {
  k: string;
  truncated?: boolean;
  dropped?: number;
  id?: string;
  at?: number;
  text?: string;
  name?: string;
  title?: string;
  model?: string;
  mode?: string;
  level?: string;
  command?: string;
  preview?: string;
  lines?: number;
  ok?: boolean;
  sub?: string | boolean;
  parent?: string;
  diff?: { old?: string; new?: string };
  changes?: ChatChange[];
}

export interface ChatListRow {
  id: string;
  title: string;
  snippet: string;
  archived: boolean;
  draft: boolean;
  model: string;
  modelRef: unknown;
  taskId?: string | number | null;
  sending: boolean;
  compacting: boolean;
  unread: boolean;
  waiting: boolean;
  ts: number;
}


export interface HistoryAttachment extends Partial<ChatAttachment> {}

export interface ChatMessage extends Record<string, unknown> {
  role?: string;
  text?: string;
  pid?: string;
  model?: string;
  actualModel?: string;
  kind?: string;
  turnId?: string;
  runId?: string;
  messageId?: string;
  assistantMessageId?: string;
  finalAssistantMessageId?: string;
  sentAt?: number;
  queued?: boolean;
  delivery?: string;
  attachments?: HistoryAttachment[];
  steps?: ChatStep[];
  receipt?: Partial<InTurnReceipt>;
  outbox?: {
    seed?: string;
    slashCommand?: string;
    requestTitle?: boolean;
    workspaceKey?: string;
    workdir?: ChatWorkdir | null;
    taskId?: string | number | null;
  };
}

export interface ContextCache {
  scope: string;
  status: string;
  readTokens?: number;
  writeTokens?: number;
  uncachedTokens?: number;
}

export interface WorkdirPreview extends Record<string, unknown> {
  transfer: string;
  revision?: number;
  workspaceKey: string;
  target?: { cwd?: string; extraDirs?: string[] };
}

export interface WorkdirCandidate {
  taskId?: string | number | null;
  workdir?: ChatWorkdir | null;
}

export interface WorkdirProposal {
  candidate: WorkdirCandidate;
  remember: boolean;
  preview: WorkdirPreview;
  operationId: string;
  title?: string;
  transfer?: string | null;
}

export interface ChatRecord extends Record<string, unknown>, ChatContextUsage {
  id?: string;
  messages?: ChatMessage[];
  archived?: boolean;
  taskId?: string | number | null;
  title?: string;
  model?: string;
  modelRef?: { provider: string; model: string } | null;
  modelRefState?: unknown;
  purpose?: string;
  sourceChatId?: string | null;
  logicalIdentity?: unknown;
  schema?: number;
  surface?: string;
  revision?: number;
  effort?: string;
  mode?: string;
  sessionId?: string | null;
  totalInputTokens?: number;
  cachedInputTokens?: number;
  contextCache?: ContextCache;
  pendingSeed?: string;
  compactedAt?: number;
  draft?: string;
  draftAttachments?: ChatAttachment[];
  unread?: boolean;
  createdAt?: number;
  updatedAt?: number;
  closedAt?: number;
  workdir?: ChatWorkdir | null;
  workdirState?: {
    epoch?: number;
    committed?: { cwd?: string };
    transition?: {
      id?: string;
      phase?: string;
      error?: string;
    };
  } | null;
  workdirChanging?: boolean;
  workdirInitializing?: boolean;
  workdirImplicit?: boolean;
  workdirProposal?: WorkdirProposal | null;
  workdirPreview?: WorkdirPreview | null;
  sending?: boolean;
  compacting?: boolean;
  stopping?: boolean;
  progressTokens?: number;
  progressTokensEstimate?: boolean;
  turnStartedAt?: number;
  steps?: ChatStep[];
  error?: string | null;
  inflight?: number;
  offline?: boolean;
  sessionResetting?: boolean;
  sessionResetFailed?: boolean;
  liveContext?: number;
  liveContextUsage?: ChatContextUsage | null;
  liveContextCache?: ContextCache | null;
}

export interface ChatSession extends ChatRecord {
  id: string;
  messages: ChatMessage[];
}

export interface RuntimeRun {
  runId: string;
  active: boolean;
  source: string;
  snapshot: ChatRunSnapshot | null;
  finishing?: boolean;
  turnId?: string;
  queuedCount?: number;
  compact?: boolean;
}

export interface ChatMeta {
  activeId?: string | null;
  defModel?: string;
  defModelRef?: { provider: string; model: string } | null;
  defEffort?: string;
  defMode?: string;
  defWorkdir?: ChatWorkdir | null;
  recentWorkdirs?: ChatWorkdir[];
}

export interface ChatStoreData extends ChatMeta {
  sessions?: ChatSession[];
  archived?: ChatSession[];
  compactWindow?: number;
  turnProtocol?: number;
  workdirProtocol?: number;
  historyStepReuseProtocol?: number;
  speech?: unknown;
}

export interface ChatRequest extends ChatPermission, ChatQuestion {
  kind?: string;
}

export interface ChatRunEvent extends ChatContextUsage, Record<string, unknown> {
  chatKey: string;
  runId?: string;
  source?: string;
  turnId?: string;
  compact?: boolean;
  elapsedMs?: number;
  steps?: ChatStep[];
  tokens?: number;
  tokensIsEstimate?: boolean;
  contextCache?: ContextCache;
  snapshot?: unknown;
  inTurn?: InTurnPage & InTurnAvailability;
}

export interface ChatResult extends ChatContextUsage, Record<string, unknown> {
  id?: string;
  chatKey?: string;
  runId?: string;
  source?: string;
  turnId?: string;
  title?: string;
  userText?: string;
  hadAttachments?: boolean;
  userSentAt?: number;
  compact?: { kind?: string; seed?: string };
  reply?: string;
  role?: string;
  cost?: unknown;
  at?: number;
  steps?: ChatStep[];
  model?: string;
  actualModel?: string;
  effort?: string;
  stopped?: boolean;
  interruptedBy?: string;
  sessionReset?: boolean;
  sessionResetFailed?: boolean;
  sessionId?: string | null;
  totalInputTokens?: number;
  cachedInputTokens?: number;
  contextCache?: ContextCache;
  state?: string;
}

export interface ChatEnvelope extends ChatStoreData, ChatResult {
  chat?: ChatSession;
  pending?: ChatResult[];
  waiting?: ChatRequest[];
  active?: ChatRunEvent[];
  queued?: Array<{ chatKey: string; turnId: string }>;
  protocol?: number;
  messages?: Record<string, InTurnReceipt>;
  turns?: Record<string, { state: string }>;
  revision?: number;
  schema?: number;
  surface?: string;
  stale?: boolean;
  modelRef?: { provider: string; model: string } | null;
  modelRefState?: unknown;
  workdir?: ChatWorkdir | null;
  taskId?: string | number | null;
  workdirState?: ChatRecord['workdirState'];
  pendingSeed?: string;
  commentDelivered?: boolean;
  textDelivered?: boolean;
}

export interface ChatState {
  sessions: ChatSession[];
  archived: ChatSession[];
  activeId: string | null;
  defModel: string;
  defModelRef: ChatMeta['defModelRef'];
  defEffort: string;
  defMode: string;
  defWorkdir: ChatWorkdir | null;
  recentWorkdirs: ChatWorkdir[];
  loaded: boolean;
  revealRequest: string;
  pending: Record<string, ChatRequest>;
  saveError: string | null;
  compactWindow: number;
  speech: SpeechSnapshot;
  turnProtocol: number;
  workdirProtocol: number;
  historyStepReuseProtocol: number;
  deliveries: Record<string, {
    chatId: string;
    state: string;
    attempt: number;
  }>;
  inTurnProtocol: number;
  inTurnRuns: Record<string, ChatInTurnRun>;
  runtimeRuns: Record<string, RuntimeRun>;
  runRevisions: Record<string, number>;
  activeRequest: number;
  inTurnAttempts: Record<string, {
    runId: string;
    text: string;
    filesKey: string;
    messageId: string;
    sentAt: number;
  }>;
  inTurnError: string;
}

export interface SpeechSnapshot {
  engine: string;
  browserProcessing: string;
  browserAutoConsent: boolean;
  language: string;
  dictionary: string;
  quality: string;
  videoQuality: string;
  model: string | null;
  videoModel: string | null;
  device: string;
  computeType: string | null;
  beamSize: number | null;
  vadSilenceMs: number;
  conditionOnPreviousText: boolean;
  resident: boolean;
  keepAliveMin: number;
  local: { ready: boolean; reason: string };
  capabilities: {
    models: readonly unknown[];
    cuda: Record<string, unknown>;
    languages: readonly unknown[];
    lastDictionaryMeasure: unknown;
    resident: unknown;
    benchmark: Record<string, unknown> | null;
    local?: {
      ready: boolean;
      reason: string;
      checks: unknown[];
    };
  };
  revision: string;
}

/**
 * Необязательная строка старого протокола сохраняет отсутствие и явный null.
 * Проверка не создаёт поля: dirty-чат применяет только собственные ключи ответа.
 */
function optionalFields(value: Record<string, unknown>, keys: string[], kind: string): boolean {
  return keys.every((key) => value[key] == null || typeof value[key] === kind);
}

/**
 * Метаданные вложения проверяются без преобразования исходного объекта.
 * История сохраняет расширения исполнителя и прежние ссылки на файлы.
 */
function isHistoryMessage(value: unknown): value is ChatMessage {
  return isRecord(value)
    && optionalFields(value, ['role', 'text', 'pid', 'kind', 'turnId', 'runId', 'messageId',
      'assistantMessageId', 'finalAssistantMessageId', 'delivery'], 'string')
    && optionalFields(value, ['sentAt'], 'number')
    && optionalFields(value, ['queued'], 'boolean')
    && (value.steps == null || Array.isArray(value.steps))
    && (value.outbox == null || isRecord(value.outbox))
    && (value.attachments == null || (Array.isArray(value.attachments)
      && value.attachments.every((item) => isRecord(item)
        && optionalFields(item, ['file', 'name', 'url', 'mime'], 'string'))));
}

/**
 * Метаданные рабочей папки не читают файлы и не меняют выбор пользователя.
 * Отсутствие и явный null сохраняются для совместимости частичных ответов.
 */
function isWorkdirState(value: unknown): boolean {
  return value == null || (isRecord(value)
    && optionalFields(value, ['epoch'], 'number')
    && (value.committed == null || (isRecord(value.committed)
      && optionalFields(value.committed, ['cwd'], 'string')))
    && (value.transition == null || (isRecord(value.transition)
      && optionalFields(value.transition, ['id', 'phase', 'error'], 'string'))));
}

/**
 * Итог хода проверяет используемые метаданные без чтения исторических тел шагов.
 * Расширения ответа остаются в исходном объекте и не проецируются в узкую форму.
 */
function isChatResult(value: unknown): value is ChatResult {
  return isRecord(value)
    && optionalFields(value, ['id', 'chatKey', 'runId', 'source', 'turnId', 'title', 'userText',
      'reply', 'role', 'model', 'actualModel', 'effort', 'interruptedBy', 'sessionId', 'state'], 'string')
    && optionalFields(value, ['userSentAt', 'at', 'totalInputTokens', 'cachedInputTokens'], 'number')
    && optionalFields(value, ['hadAttachments', 'stopped', 'sessionReset', 'sessionResetFailed'], 'boolean')
    && (value.steps == null || Array.isArray(value.steps))
    && (value.compact == null || (isRecord(value.compact)
      && optionalFields(value.compact, ['kind', 'seed'], 'string')));
}

/**
 * Сессия проверяет только оболочки сообщений и используемые метаданные.
 * Исторические steps остаются непрочитанными, включая их getters и расширения.
 */
export function isChatSession(value: unknown): value is ChatSession {
  if (!isRecord(value) || typeof value.id !== 'string'
    || !optionalFields(value, ['title', 'model', 'effort', 'mode', 'sessionId', 'pendingSeed',
      'draft', 'purpose', 'sourceChatId', 'surface', 'contextMetric'], 'string')
    || !optionalFields(value, ['revision', 'schema', 'createdAt', 'updatedAt', 'contextTokens',
      'contextWindow', 'totalInputTokens', 'cachedInputTokens', 'compactedAt'], 'number')
    || (value.messages != null && (!Array.isArray(value.messages)
      || !value.messages.every(isHistoryMessage)))
    || (value.modelRef != null && !isModelRef(value.modelRef))
    || (value.taskId != null && typeof value.taskId !== 'string' && typeof value.taskId !== 'number')
    || (value.workdir != null && !normalizeChatWorkdir(value.workdir))
    || !isWorkdirState(value.workdirState)) {
    return false;
  }

  // Это прежний fallback _normalize, применённый до публикации оболочки.
  value.messages ??= [];

  return true;
}

function isModelRef(value: unknown): boolean {
  return isRecord(value) && typeof value.provider === 'string' && typeof value.model === 'string';
}

/**
 * Очередь спросов принимает прежние optional-поля серверов и расширения адаптеров.
 * Неверные id и контейнеры не создают подтверждение, на которое нельзя ответить.
 */
export function isChatRequest(value: unknown): value is ChatRequest {
  return isRecord(value) && typeof value.pid === 'string'
    && optionalFields(value, ['kind', 'origin', 'chatKey', 'tool', 'command', 'prompt'], 'string')
    && optionalFields(value, ['canRemember', 'structured', 'isRoot', 'usesSudo'], 'boolean')
    && (value.input == null || isRecord(value.input))
    && (value.questions == null || (Array.isArray(value.questions)
      && value.questions.every((item) => isRecord(item) && typeof item.question === 'string')));
}

/**
 * Снимок запуска проверяется до изменения runtime, а тяжёлые steps остаются данными.
 * Неизвестные model/vendor ids не ограничиваются списком клиента.
 */
function isChatRunEvent(value: unknown): value is ChatRunEvent {
  return isRecord(value) && typeof value.chatKey === 'string'
    && optionalFields(value, ['runId', 'source', 'turnId'], 'string')
    && optionalFields(value, ['tokens', 'elapsedMs'], 'number')
    && optionalFields(value, ['compact', 'tokensIsEstimate'], 'boolean')
    && (value.steps == null || Array.isArray(value.steps))
    && (value.inTurn == null || isInTurnPage(value.inTurn));
}

/**
 * Подтверждение уточнения требует устойчивых id и известного состояния доставки.
 * Неверный ACK оставляет прежний messageId для сверки и не разрешает новый POST.
 */
export function isInTurnEntry(value: unknown): value is InTurnReceipt | InTurnAssistantBlock {
  if (!isRecord(value) || typeof value.runId !== 'string' || typeof value.chatKey !== 'string'
    || typeof value.text !== 'string' || typeof value.revision !== 'number'
    || typeof value.sequence !== 'number') {
    return false;
  }

  return typeof value.messageId === 'string'
    ? typeof value.state === 'string'
      && ['accepted', 'delivering', 'forwarded', 'consumed', 'failed', 'unknown'].includes(value.state)
    : typeof value.assistantMessageId === 'string' && typeof value.complete === 'boolean';
}

/**
 * Страница сохраняет исходные записи канала и проверяет только его публичный envelope.
 * Пустые optional-поля старого сервера продолжают обрабатываться владельцем состояния.
 */
export function isInTurnPage(value: unknown): value is InTurnPage & { availability?: InTurnAvailability } {
  return isRecord(value)
    && (value.entries == null || (Array.isArray(value.entries) && value.entries.every(isInTurnEntry)))
    && optionalFields(value, ['throughSequence', 'runRevision', 'nextAfterSequence'], 'number')
    && (value.availability == null || isRecord(value.availability));
}

/**
 * Один envelope обслуживает HTTP и браузерные снимки без проекции optional-полей.
 * Проверяются контейнеры и читаемые метаданные; история не клонируется и не обрезается.
 */
function isChatEnvelope(value: unknown): value is ChatEnvelope {
  if (!isChatResult(value)
    || !optionalFields(value, ['activeId', 'defModel', 'defEffort', 'defMode', 'reply', 'title',
      'sessionId', 'state', 'surface', 'pendingSeed'], 'string')
    || !optionalFields(value, ['compactWindow', 'turnProtocol', 'workdirProtocol',
      'historyStepReuseProtocol', 'protocol', 'revision', 'schema'], 'number')
    || (value.sessions != null && (!Array.isArray(value.sessions)
      || !value.sessions.every(isChatSession)))
    || (value.archived != null && (!Array.isArray(value.archived)
      || !value.archived.every(isChatSession)))
    || (value.chat != null && !isChatSession(value.chat))
    || (value.active != null && (!Array.isArray(value.active)
      || !value.active.every(isChatRunEvent)))
    || (value.queued != null && (!Array.isArray(value.queued)
      || !value.queued.every((item) => isRecord(item) && typeof item.chatKey === 'string'
        && typeof item.turnId === 'string')))
    || (value.waiting != null && (!Array.isArray(value.waiting)
      || !value.waiting.every(isChatRequest)))
    || (value.pending != null && (!Array.isArray(value.pending)
      || !value.pending.every((item) => isChatResult(item) && typeof item.id === 'string')))
    || (value.messages != null && (!isRecord(value.messages)
      || !Object.values(value.messages).every((entry) => isInTurnEntry(entry) && 'messageId' in entry)))
    || (value.turns != null && (!isRecord(value.turns)
      || !Object.values(value.turns).every((item) => item == null
        || (isRecord(item) && typeof item.state === 'string'))))
    || (value.modelRef != null && !isModelRef(value.modelRef))
    || (value.defModelRef != null && !isModelRef(value.defModelRef))
    || (value.workdir != null && !normalizeChatWorkdir(value.workdir))
    || (value.defWorkdir != null && !normalizeChatWorkdir(value.defWorkdir))
    || !isWorkdirState(value.workdirState)
    || !optionalFields(value, ['stale', 'commentDelivered', 'textDelivered'], 'boolean')) {
    return false;
  }

  return true;
}

/**
 * Неверный снимок следует прежней ветке ошибки HTTP или fallback хранилища.
 * Исходный объект сохраняется вместе с отсутствующими optional-полями.
 */
export function decodeChatEnvelope(value: unknown): ChatEnvelope {
  if (!isChatEnvelope(value)) {
    throw new Error(t('core.invalidChatSnapshot'));
  }

  return value;
}

/**
 * Предпросмотр папки подтверждает способ переноса и ключ до записи outbox.
 * Старый ответ может не содержать CAS revision, но присланная revision должна быть числом.
 */
export function decodeWorkdirPreview(value: unknown): WorkdirPreview {
  if (!isRecord(value) || typeof value.transfer !== 'string'
    || (value.revision !== undefined && typeof value.revision !== 'number')
    || typeof value.workspaceKey !== 'string') {
    throw new Error(t('core.invalidChatSnapshot'));
  }

  return {
    ...value,
    transfer: value.transfer,
    revision: value.revision,
    workspaceKey: value.workspaceKey,
  };
}

export interface ChatEvent extends ChatRunEvent, Omit<ChatRequest, 'chatKey'> {
  id?: string;
  origin?: string;
  gone?: boolean;
  archived?: boolean;
  meta?: ChatMeta;
  step?: ChatStep;
  block?: InTurnAssistantBlock;
  sessionId?: string;
  queued?: number;
}

/**
 * SSE разделяется по имени до применения данных: неверный спрос не попадает в очередь.
 * События дефолтов сохраняют отсутствие own-полей и не стирают соседний выбор окна.
 */
export function decodeChatEvent(name: string, value: unknown): ChatEvent | null {
  const raw = value == null && name === 'chat-orphan' ? {} : value;

  if (!isRecord(raw)) {
    return null;
  }
  if ((name === 'chat-permission' || name === 'chat-question') && !isChatRequest(raw)) {
    return null;
  }
  if (name === 'chat-store-meta') {
    try {
      decodeChatEnvelope(raw.meta || {});
    } catch {
      return null;
    }
  }
  if (!optionalFields(raw, ['chatKey', 'pid', 'runId', 'turnId', 'source', 'sessionId'], 'string')
    || !optionalFields(raw, ['tokens', 'elapsedMs', 'queued'], 'number')
    || (raw.step != null && (!isRecord(raw.step) || typeof raw.step.k !== 'string'))
    || (raw.block != null && !isInTurnEntry(raw.block))) {
    return null;
  }

  return {
    ...raw,
    chatKey: typeof raw.chatKey === 'string' ? raw.chatKey : '',
    pid: typeof raw.pid === 'string' ? raw.pid : '',
  };
}

/**
 * Receipt проверяется до материализации сообщения и удаления попытки отправки.
 * Неизвестный исход идёт по прежней сверке GET с тем же устойчивым id.
 */
export function decodeInTurnReceipt(value: unknown): InTurnReceipt {
  if (!isInTurnEntry(value) || !('messageId' in value)) {
    throw new Error(t('core.invalidChatSnapshot'));
  }

  return value;
}

/**
 * Страница журнала допускается к merge только после проверки контейнера записей.
 * Ошибка не подтверждает сохранение pending и не удаляет серверную страховку.
 */
export function decodeInTurnPage(value: unknown): InTurnPage & { availability?: InTurnAvailability } {
  if (!isInTurnPage(value)) {
    throw new Error(t('core.invalidChatSnapshot'));
  }

  return value;
}

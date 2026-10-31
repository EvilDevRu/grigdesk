// Единственный mutation path общего Inbox.
//
// Все ручные решения сериализуются в одном server writer process. Это намеренно
// шире mutex одного item: после пересклейки два разных item ref могут покрывать
// одно сообщение, а второй вызов B24 всё равно обязан увидеть decision первого
// ДО внешнего side effect.

import { lexical } from '../../../../shared/lib/text.ts';
import { isPlainRecord } from '../../../../shared/lib/objects.ts';

import {
  buildInboxDraft,
  INBOX_DRAFT_LIMITS,
  safeInboxSourceUrl,
} from './draft.ts';
import { toPublicInboxItem } from './coordinator.ts';
import { skipReasonText } from './skipReason.ts';
import { inboxAutoNote } from './triage.ts';
import type { InboxTriageItem, InboxTriageRun } from './triage.ts';
import type { InternalInboxItem, InboxChannelState } from './coordinator.ts';
import type { InboxDraftAttachment } from './draft.ts';

type Payload = Record<string, unknown>;

// Соседи службы решений объявлены ровно тем, что она зовёт: сама она ничего не
// создаёт в обход общего рубежа и ничего не знает об учётных данных каналов.
interface CoordinatorPort {
  resolveItem: (ref: string, options: { nowMs: number }) => Promise<ResolvedItem>;
}

// Разрешённая карточка вместе с живой арендой канала. Аренду обязан закрыть тот,
// кто её получил: пока она открыта, аккаунт и поколение не меняются под руками.
interface ResolvedItem {
  channel: { id: string; label: string };
  channelState: InboxChannelState;
  accountRef: string;
  generation: unknown;
  refCodec: { decode: (ref: unknown, kind: string) => { ref?: unknown } };
  item: InternalInboxItem;
  context: {
    isCurrent?: () => Promise<unknown> | unknown;
    sourceUrl: (options: Payload) => Promise<unknown> | unknown;
    materializeAttachments?: (attachments: unknown) => Promise<unknown>;
    notifyTaskCreated?: (payload: Payload) => Promise<unknown>;
    inboxState: {
      decide: (options: Payload) => Promise<DecisionResult>;
      reset: (options: Payload) => Promise<DecisionResult | null>;
    };
  };
  release: () => Promise<unknown> | unknown;
}

interface DecisionResult {
  decisionId: string;
  version: number;
}

interface B24Port {
  isConfigured: () => boolean;
  createTask: (options: Payload) => Promise<{ id?: unknown } | null>;
  captureContext?: () => { trackerId: string | null; revision: number };
  assertContext?: (context: { trackerId: string | null; revision: number }) => void;
}

interface AttachmentAnalyzerPort {
  analyze: (options: Payload) => Promise<AttachmentAnalysisResult>;
}

interface AttachmentAnalysisResult {
  ok?: boolean;
  complete?: boolean;
  error?: string;
  text?: string;
  entries?: unknown[];
  visualPaths?: string[];
  release?: () => Promise<unknown> | unknown;
}

interface SkippedAttachment {
  attachment?: Payload;
  reason?: unknown;
  sizeBytes?: number | null;
  limitBytes?: number | null;
}

interface PreparedAttachments {
  files: Payload[];
  skipped: SkippedAttachment[];
}

interface UnanalyzedEntry {
  label: string;
  reason: string;
}

// Что уже могло уехать на портал без подтверждённого решения. Пока такая метка
// висит, канал не принимает новых решений: повтор создал бы вторую задачу.
interface IndeterminateMark {
  retryable: boolean;
  taskId: string | null;
  taskUrl: string;
}

interface ActionOptions {
  by: string;
  note: string;
  requireAllAttachments: boolean;
}

// Отложенная доставка ответа в исходный чат: задача уже создана и записана, а
// аренда канала передана сюда вместе с обязанностью её закрыть.
interface TaskNotificationReceipt {
  channel: string;
  resolved: ResolvedItem;
  payload: Payload & { taskId: string };
}

type LogPort = {
  info?: (details: unknown, message: string) => void;
  warn?: (details: unknown, message: string) => void;
  error?: (details: unknown, message: string) => void;
};

const TASK_KEYS = new Set([
  'revision', 'messageRefs', 'title', 'description', 'operatorNote',
]);
const DECIDE_KEYS = new Set(['revision', 'messageRefs']);
const RESET_KEYS = new Set([
  'revision', 'messageRefs', 'decisionId', 'decisionVersion',
]);
const MAX_MESSAGE_REFS = 10_000;
const MAX_TASK_ID_BYTES = 512;
const MAX_PUBLIC_ATTACHMENT_TEXT = 4096;
const MAX_DECISION_NOTE_BYTES = 32 * 1024;
const MAX_DERIVED_DESCRIPTION = 8_000;
const MAX_OPERATOR_NOTE = 4_000;
const MAX_UNANALYZED_LINES = 12;
const SAFE_REASON_RE = /^[a-z0-9_]{1,80}$/u;
const ACTION_OPTION_KEYS = new Set(['by', 'note', 'requireAllAttachments']);

export class InboxTaskServiceError extends Error {
  code: string;

  statusCode: number;

  details?: unknown;

  constructor(
    code: string,
    message: string,
    statusCode = 400,
    cause?: unknown,
    details: unknown = null,
  ) {
    super(message, cause ? { cause } : undefined);
    this.name = 'InboxTaskServiceError';
    this.code = code;
    this.statusCode = statusCode;
    if (details) this.details = structuredClone(details);
  }
}

// Явная аннотация типа обязательна: без неё TypeScript не считает вызов обрывом
// потока, и после проверки значение остаётся прежним.
const fail: (
  code: string,
  message: string,
  statusCode?: number,
  cause?: unknown,
  details?: unknown,
) => never = (code, message, statusCode = 400, cause, details = null) => {
  throw new InboxTaskServiceError(code, message, statusCode, cause, details);
};

const errorCode = (err: unknown) => (err as { code?: unknown } | null)?.code;

function exactBody(
  source: unknown,
  allowed: Set<string>,
  required: string[],
  where: string,
): void {
  if (!isPlainRecord(source)) fail('invalid_request', `${where}: ожидался JSON object.`);

  const body = source as Payload;
  const keys = Object.keys(body);
  if (keys.some((key) => !allowed.has(key)) || required.some((key) => !Object.hasOwn(body, key))) {
    fail('invalid_request', `${where}: поля запроса не совпадают с контрактом.`);
  }
}

function boundedText(value: unknown, where: string, limit: number, { optional = false }: {
  optional?: boolean;
} = {}): string {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string') fail('invalid_request', `${where}: ожидалась строка.`);
  const text = value.trim();
  if (text.length > limit || Buffer.byteLength(text, 'utf8') > limit * 4) {
    fail('invalid_request', `${where}: текст превышает допустимый размер.`);
  }
  return text;
}

/**
 * Пояснение человека к тому, чего машина не прочитала.
 *
 * Это единственный ключ, разрешающий создать задачу при неполном разборе:
 * прежний булев bypass ставил задачу из голого текста сообщений, и обращение
 * вида «на видео предложение по доработке» превращалось в задачу без сути.
 * Пустая строка ничего не объясняет и потому не считается пояснением.
 */
function operatorNoteText(value: unknown): string {
  const text = boundedText(value, 'operatorNote', MAX_OPERATOR_NOTE, { optional: true });
  return text;
}

/**
 * Что именно осталось неразобранным и почему.
 *
 * Один список на два адресата: человек читает его в модалке пояснения (иначе он
 * не знает, ЧТО описывать своими словами), исполнитель задачи — в описании, где
 * тот же список честно говорит, что видео не расшифровано и пересказ человека —
 * единственный источник его содержимого.
 *
 * Анализатор точнее списка `skipped`: он видит и нескачанные файлы, и те, что
 * скачались, но не поддались разбору. Пустой анализ бывает только когда он не
 * запускался вовсе — тогда причины берутся у канала.
 */
function unanalyzedEntries(
  attachmentAnalysis: AttachmentAnalysisResult | null,
  skipped: SkippedAttachment[] | null,
): UnanalyzedEntry[] {
  const entries = Array.isArray(attachmentAnalysis?.entries)
    ? attachmentAnalysis.entries as Payload[]
    : [];
  const source: { label: unknown[]; reason: unknown }[] = entries.length
    ? entries.filter((value) => value?.complete !== true).map((value) => ({
      label: [value?.displayLabel, value?.name],
      reason: value?.reason,
    }))
    : (Array.isArray(skipped) ? skipped : []).map((value) => {
      const attachment = (isPlainRecord(value?.attachment)
        ? value.attachment
        : (value || {})) as Payload;

      return {
        label: [attachment.displayLabel, attachment.name],
        // Канал прислал код; фразу собирает GrigDesk — та же, что и в разборе.
        reason: skipReasonText(value?.reason, {
          sizeBytes: value?.sizeBytes ?? null,
          limitBytes: value?.limitBytes ?? null,
        }),
      };
    });
  return source.slice(0, MAX_UNANALYZED_LINES).map((value) => ({
    label: truncateText(
      value.label.map((part) => String(part || '').trim()).filter(Boolean).join(' · '),
      200,
    ) || 'вложение',
    reason: truncateText(String(value.reason || '').replace(/\s+/gu, ' '), 240),
  }));
}

function unanalyzedList(entries: UnanalyzedEntry[]): string {
  if (!entries.length) return 'Содержимое вложений не удалось разобрать полностью.';
  return entries
    .map((value) => (value.reason ? `${value.label} — ${value.reason}` : value.label))
    .join('\n');
}

function truncateText(value: unknown, limit: number): string {
  const text = String(value || '').trim();
  if (text.length <= limit) return text;
  return limit > 1 ? `${text.slice(0, limit - 1).trimEnd()}…` : '';
}

function appendBoundedSections(
  description: string,
  sections: { title: string; text: string }[],
): string {
  const body = String(description || '').trim();
  const pending = (Array.isArray(sections) ? sections : [])
    .map((section) => ({
      marker: `── ${String(section?.title || '').trim()} ──`,
      text: String(section?.text || '').trim(),
    }))
    // Исходное сообщение недоверенное: совпавший заголовок в нём не доказывает,
    // что системная секция уже добавлена. Эта функция вызывается ровно один раз.
    .filter((section) => section.text);
  if (!pending.length) return body;

  const overhead = pending.reduce((total, section) => total + section.marker.length + 1, 0)
    + Math.max(0, pending.length - 1) * 2;
  let remaining = Math.max(0, MAX_DERIVED_DESCRIPTION - overhead);
  const blocks = pending.map((section, index) => {
    const share = Math.floor(remaining / (pending.length - index));
    const text = truncateText(section.text, share);
    remaining -= text.length;
    return `${section.marker}\n${text}`;
  });
  const derived = blocks.join('\n\n');
  const bodyBudget = Math.max(
    0,
    INBOX_DRAFT_LIMITS.description - derived.length - (body ? 2 : 0),
  );
  return [truncateText(body, bodyBudget), derived].filter(Boolean).join('\n\n');
}

function actionOptions(value: unknown, { attachments = false }: {
  attachments?: boolean;
} = {}): ActionOptions {
  if (value === undefined) return { by: 'human', note: '', requireAllAttachments: false };
  if (!isPlainRecord(value)
      || Object.keys(value).some((key) => !ACTION_OPTION_KEYS.has(key))) {
    fail('invalid_service_call', 'Internal action options не совпадают с контрактом.', 500);
  }

  const by = (value.by ?? 'human') as string;
  const note = (value.note ?? '') as string;
  const requireAllAttachments = (value.requireAllAttachments ?? false) as boolean;

  if (!['human', 'auto'].includes(by)
      || typeof note !== 'string'
      || Buffer.byteLength(note, 'utf8') > MAX_DECISION_NOTE_BYTES
      || typeof requireAllAttachments !== 'boolean'
      || (!attachments && requireAllAttachments)) {
    fail('invalid_service_call', 'Internal action options имеют неверные значения.', 500);
  }
  return { by, note, requireAllAttachments };
}

function assertRevision(value: unknown): string {
  if (typeof value !== 'string' || !/^v1_[A-Za-z0-9_-]{43}$/u.test(value)) {
    fail('invalid_revision', 'revision имеет неверный формат.');
  }
  return value as string;
}

function validateSelection(
  messageRefs: unknown,
  item: InternalInboxItem,
  refCodec: ResolvedItem['refCodec'],
): { refs: string[]; messages: InternalInboxItem['messages'] } {
  if (!Array.isArray(messageRefs)
      || messageRefs.length < 1
      || messageRefs.length > MAX_MESSAGE_REFS) {
    fail('invalid_selection', 'Нужно выбрать хотя бы одно сообщение.');
  }

  const canonical = (messageRefs as unknown[]).map((ref) => {
    try {
      return String(refCodec.decode(ref, 'message').ref);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);

      return fail('invalid_selection', `messageRefs содержит неверную ссылку: ${detail}`, 400, err);
    }
  });

  if (new Set(canonical).size !== canonical.length) {
    fail('invalid_selection', 'messageRefs содержит повторяющиеся ссылки.');
  }
  const selectedRefs = new Set(canonical);
  const availableRefs = new Set(item.messages.map((message) => message.messageRef));
  if (canonical.some((messageRef) => !availableRefs.has(messageRef))) {
    fail('stale_item', 'Выбор содержит сообщение, которого больше нет в item.', 409);
  }
  return {
    refs: [...selectedRefs].sort(lexical),
    // Порядок transcript задаёт authoritative item, а не порядок refs из body.
    messages: item.messages.filter((message) => selectedRefs.has(message.messageRef)),
  };
}

function ensureNewSelection(selection: { messages: { decision: unknown }[] }): void {
  if (selection.messages.some((message) => message.decision !== null)) {
    fail('stale_item', 'Хотя бы одно выбранное сообщение уже решено.', 409);
  }
}

function ensureWritable(resolved: ResolvedItem): void {
  if (resolved.channelState.readOnly || resolved.channelState.connection !== 'connected') {
    fail(
      'channel_disconnected',
      'Канал отключён: ранее принятые обращения доступны только для чтения до переподключения.',
      409,
    );
  }
}

/**
 * Что из подготовленного уезжает НА ПОРТАЛ. Разбор вложений это не трогает:
 * речь и кадры видео модель читает всегда, ограничивается только загрузка
 * исходных байтов в B24.
 *
 * Настройка называет ровно две группы, и стороны у неё разные по смыслу:
 * автомату выдаётся ТОЛЬКО разрешённое (человеческого суждения за ним нет),
 * а у человека настройка снимает запрещённое — выбранные им документы и
 * голосовые остаются как раньше. Сообщения выбирает человек, а не файлы:
 * решение «поставить задачу по этим трём сообщениям» не означает согласия
 * залить на портал сорокамегабайтное видео из них.
 */
const PHOTO_KINDS = new Set(['photo', 'image']);
const VIDEO_KINDS = new Set(['video', 'video_note', 'animation']);
const IMAGE_EXTENSIONS = new Set(['.bmp', '.gif', '.jpeg', '.jpg', '.png', '.webp']);
const IMAGE_DOCUMENT_KINDS = new Set(['document', 'sticker']);

function attachmentGroup(file: Payload | InboxDraftAttachment): string {
  const kind = String(file?.kind || '').trim().toLowerCase();
  if (PHOTO_KINDS.has(kind)) return 'photo';
  if (VIDEO_KINDS.has(kind)) return 'video';
  // Картинка, присланная файлом, остаётся картинкой: тот же признак по
  // расширению использует и разбор вложений.
  if (IMAGE_DOCUMENT_KINDS.has(kind)) {
    const name = String(file?.name || '');
    const dot = name.lastIndexOf('.');
    if (dot >= 0 && IMAGE_EXTENSIONS.has(name.slice(dot).toLowerCase())) return 'photo';
  }
  return 'other';
}

export function inboxAttachmentPolicy(raw: unknown): { photos: boolean; videos: boolean } {
  const value = isPlainRecord(raw) ? raw : {};
  // Умолчания повторяют манифест плагина: фотографии полезны в задаче, видео
  // раздувает портал и уже пересказано транскриптом.
  return {
    photos: value.photos !== false,
    videos: value.videos === true,
  };
}

export function selectAttachableFiles(files: unknown, policy: unknown, { by = 'human' }: {
  by?: string;
} = {}): Payload[] {
  const rules = inboxAttachmentPolicy(policy);

  return (Array.isArray(files) ? files as Payload[] : []).filter((file) => {
    const group = attachmentGroup(file);
    if (group === 'photo') return rules.photos;
    if (group === 'video') return rules.videos;
    return by === 'human';
  });
}

function materialized(value: unknown): PreparedAttachments {
  if (!isPlainRecord(value)
      || !Array.isArray(value.files)
      || !Array.isArray(value.skipped)) {
    fail('channel_materialize_failed', 'Канал вернул неверный результат подготовки вложений.', 503);
  }

  return {
    files: value.files as Payload[],
    skipped: value.skipped as SkippedAttachment[],
  };
}

function boundedPublicText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.length <= MAX_PUBLIC_ATTACHMENT_TEXT
    ? value
    : `${value.slice(0, MAX_PUBLIC_ATTACHMENT_TEXT - 1)}…`;
}

function publicSkipped(entries: SkippedAttachment[]) {
  return entries.map((entry) => {
    const envelope = isPlainRecord(entry) ? entry : {};
    const attachment = isPlainRecord(envelope.attachment) ? envelope.attachment : envelope;
    const rawReason = typeof envelope.reason === 'string' ? envelope.reason : '';
    return {
      kind: boundedPublicText(attachment.kind),
      displayLabel: boundedPublicText(attachment.displayLabel),
      name: boundedPublicText(attachment.name),
      size: Number.isSafeInteger(attachment.size) && Number(attachment.size) >= 0
        ? attachment.size as number
        : null,
      reason: SAFE_REASON_RE.test(rawReason) ? rawReason : 'attachment_failed',
    };
  });
}

/**
 * Чем закончилась попытка ответить в исходный чат.
 *
 * Наружу идёт только словарный код: свободный текст отказа провайдера содержит
 * URL с токеном, а показывать это предстоит в браузере. Больше того, различие
 * важно человеку: «связь оборвалась» повторится само при следующем обращении,
 * а «канал отказал» означает права или токен.
 */
function notificationFailureReason(err: unknown): string {
  const kind = (err as { kind?: unknown } | null)?.kind;

  if (kind === 'transport') return 'unreachable';
  if (kind === 'telegram') return 'rejected';

  return 'failed';
}

function publicNotification(outcome: unknown, fallbackReason = '') {
  const value = isPlainRecord(outcome) ? outcome : {};
  const enabled = value.enabled !== false;
  const sent = value.sent === true;
  const reason = typeof value.reason === 'string' && SAFE_REASON_RE.test(value.reason)
    ? value.reason
    : fallbackReason;
  return Object.freeze({ enabled, sent, reason: sent ? '' : reason });
}

function safeTaskId(value: unknown): string | null {
  const taskId = String(value ?? '').trim();
  if (!taskId
      || Buffer.byteLength(taskId, 'utf8') > MAX_TASK_ID_BYTES
      || /[\u0000-\u001f\u007f]/u.test(taskId)) return null;
  return taskId;
}

function validDecisionResult(value: unknown): boolean {
  return isPlainRecord(value)
    && typeof value.decisionId === 'string'
    && value.decisionId.length > 0
    && Number.isSafeInteger(value.version)
    && Number(value.version) > 0;
}

function sameSelection(left: ResolvedItem, right: ResolvedItem): boolean {
  if (left.item.revision !== right.item.revision) return false;
  if (left.accountRef !== right.accountRef || left.generation !== right.generation) return false;
  return true;
}

async function releaseAttachmentAnalysis(
  analysis: AttachmentAnalysisResult | null,
  log: LogPort,
): Promise<void> {
  try {
    await analysis?.release?.();
  } catch (error) {
    // Cleanup не должен превращать уже готовый разбор в потерю решения человека.
    log.warn?.({ code: errorCode(error) }, 'inbox: visual lease не удалось освободить');
  }
}

/**
 * Общий mutation service. `coordinator.resolveItem()` возвращает server-only item
 * и передаёт владение account lease до обязательного release() в finally.
 */
export class InboxTaskService {
  coordinator: CoordinatorPort;

  b24: B24Port;

  listProjects: () => Promise<unknown>;

  taskUrlFor: (taskId: string) => Promise<unknown> | unknown;

  onChanged: (payload: Payload) => unknown;

  isEnabled: () => Promise<unknown> | unknown;

  attachmentAnalyzer: AttachmentAnalyzerPort | null;

  attachmentTriage: ((options: Payload) => Promise<InboxTriageRun>) | null;

  attachmentPolicy: () => unknown;

  now: () => number;

  log: LogPort;

  queue: Promise<unknown>;

  indeterminateChannels: Map<string, IndeterminateMark>;

  indeterminateItems: Set<string>;

  indeterminateMessages: Set<string>;

  indeterminateDetails: Map<string, IndeterminateMark>;

  constructor({
    coordinator,
    b24,
    listProjects = async () => [],
    taskUrlFor = async () => '',
    onChanged = () => {},
    isEnabled,
    attachmentAnalyzer = null,
    attachmentTriage = null,
    attachmentPolicy = () => ({}),
    now = Date.now,
    log = console,
  }: {
    coordinator?: CoordinatorPort;
    b24?: B24Port;
    listProjects?: () => Promise<unknown>;
    taskUrlFor?: (taskId: string) => Promise<unknown> | unknown;
    onChanged?: (payload: Payload) => unknown;
    isEnabled?: () => Promise<unknown> | unknown;
    attachmentAnalyzer?: AttachmentAnalyzerPort | null;
    attachmentTriage?: ((options: Payload) => Promise<InboxTriageRun>) | null;
    attachmentPolicy?: () => unknown;
    now?: () => number;
    log?: LogPort;
  } = {}) {
    if (!coordinator || typeof coordinator.resolveItem !== 'function') {
      fail('invalid_service_config', 'InboxTaskService требует coordinator.', 500);
    }
    if (!b24 || typeof b24.isConfigured !== 'function' || typeof b24.createTask !== 'function') {
      fail('invalid_service_config', 'InboxTaskService требует B24 port с readiness.', 500);
    }
    if (typeof listProjects !== 'function' || typeof taskUrlFor !== 'function'
        || typeof onChanged !== 'function' || typeof isEnabled !== 'function'
        || (attachmentAnalyzer !== null && typeof attachmentAnalyzer?.analyze !== 'function')
        || (attachmentTriage !== null && typeof attachmentTriage !== 'function')
        || typeof attachmentPolicy !== 'function'
        || typeof now !== 'function') {
      fail('invalid_service_config', 'InboxTaskService получил неверные callbacks.', 500);
    }
    this.coordinator = coordinator;
    this.b24 = b24 as B24Port;
    this.listProjects = listProjects;
    this.taskUrlFor = taskUrlFor;
    this.onChanged = onChanged;
    this.isEnabled = isEnabled as () => Promise<unknown> | unknown;
    this.attachmentAnalyzer = attachmentAnalyzer;
    this.attachmentTriage = attachmentTriage;
    this.attachmentPolicy = attachmentPolicy;
    this.now = now;
    this.log = log;
    this.queue = Promise.resolve();
    // После B24 success + store failure автоматический повтор опасен. До явной
    // operator reconciliation этот process блокирует весь decisions channel,
    // а item/message keys сохраняет для точной диагностики пересклейки.
    this.indeterminateChannels = new Map();
    this.indeterminateItems = new Set();
    this.indeterminateMessages = new Set();
    this.indeterminateDetails = new Map();
  }

  _serialize<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.queue.then(operation, operation);

    this.queue = result.catch(() => {});

    return result;
  }

  async _resolve(ref: string): Promise<ResolvedItem> {
    try {
      return await this.coordinator.resolveItem(ref, { nowMs: this.now() });
    } catch (err) {
      if ((err as { statusCode?: unknown } | null)?.statusCode) throw err;

      return fail('inbox_failed', 'Inbox не смог заново проверить item.', 503, err);
    }
  }

  async _assertInboxEnabled() {
    if (!await this.isEnabled()) {
      fail('inbox_disabled', 'Плагин Inbox выключен во время операции.', 409);
    }
  }

  async _assertContextCurrent(resolved: ResolvedItem): Promise<void> {
    if (resolved.context.isCurrent && !await resolved.context.isCurrent()) {
      fail('account_changed', 'Account generation изменилась перед mutation.', 409);
    }
  }

  _validateItem(resolved: ResolvedItem, revision: unknown, { requireActive = false }: {
    requireActive?: boolean;
  } = {}): void {
    ensureWritable(resolved);
    if (requireActive && resolved.channelState.participation !== 'active') {
      fail('channel_deactivated', 'Автомат остановлен для деактивированного канала.', 409);
    }
    if (resolved.item.revision !== assertRevision(revision)) {
      fail('stale_item', 'Item изменился; перечитайте Inbox перед решением.', 409);
    }
  }

  async _publicItem(ref: string) {
    const refreshed = await this._resolve(ref);
    try {
      return toPublicInboxItem(refreshed.item);
    } finally {
      await refreshed.release();
    }
  }

  async _publicItemSafe(ref: string) {
    try {
      return await this._publicItem(ref);
    } catch (err) {
      this.log.warn?.(
        { code: errorCode(err) },
        'inbox: решение записано, но public item не перечитан',
      );

      return null;
    }
  }

  async _release(resolved: ResolvedItem | null): Promise<void> {
    try {
      await resolved?.release();
    } catch (err) {
      this.log.error?.({ code: errorCode(err) }, 'inbox: account lease не удалось освободить');
    }
  }

  _markIndeterminate(
    channel: string,
    itemRef: string,
    messageRefs: string[],
    details: { taskId?: unknown; taskUrl?: unknown },
  ): IndeterminateMark {
    const safe: IndeterminateMark = {
      retryable: false,
      taskId: safeTaskId(details?.taskId),
      taskUrl: String(details?.taskUrl || ''),
    };
    this.indeterminateChannels.set(channel, safe);
    this.indeterminateItems.add(itemRef);
    this.indeterminateDetails.set(itemRef, safe);
    for (const messageRef of messageRefs) {
      this.indeterminateMessages.add(messageRef);
      this.indeterminateDetails.set(messageRef, safe);
    }
    return safe;
  }

  _existingIndeterminate(
    channel: string,
    itemRef: string,
    messageRefs: string[],
  ): IndeterminateMark | null | undefined {
    if (this.indeterminateChannels.has(channel)) return this.indeterminateChannels.get(channel);
    if (this.indeterminateItems.has(itemRef)) return this.indeterminateDetails.get(itemRef);

    const messageRef = messageRefs.find((candidate) => this.indeterminateMessages.has(candidate));

    return messageRef ? this.indeterminateDetails.get(messageRef) : null;
  }

  async _taskUrl(taskId: string): Promise<string> {
    try {
      const raw = await this.taskUrlFor(taskId);

      return safeInboxSourceUrl(raw) || '';
    } catch (err) {
      this.log.warn?.(
        { taskId, code: errorCode(err) },
        'inbox: безопасная ссылка на B24-задачу не собрана',
      );

      return '';
    }
  }

  _notify(payload: Payload): void {
    try {
      const result = this.onChanged(payload);

      Promise.resolve(result).catch((err) => {
        this.log.warn?.({ code: errorCode(err) }, 'inbox: решение записано, но SSE не отправлен');
      });
    } catch (err) {
      this.log.warn?.({ code: errorCode(err) }, 'inbox: решение записано, но SSE не отправлен');
    }
  }

  async _deliverTaskNotification(receipt: TaskNotificationReceipt | null) {
    if (!receipt) return null;
    try {
      return publicNotification(
        await receipt.resolved.context.notifyTaskCreated?.(receipt.payload),
      );
    } catch (err) {
      // B24 и durable decision уже состоялись. Ошибка обратного сообщения не
      // имеет права превратить успех в повтор создания задачи. Но и молчать о
      // ней нельзя: раньше провал жил только в warn-логе, и со стороны человека
      // это выглядело как «оповещение просто не пришло» — при том, что
      // автоповтора здесь нет и не будет, а значит сообщить в чат придётся ему.
      this.log.warn?.(
        { channel: receipt.channel, taskId: receipt.payload.taskId, code: errorCode(err) },
        'inbox: задача создана, но channel confirmation не отправлен',
      );
      return publicNotification({ enabled: true, sent: false }, notificationFailureReason(err));
    } finally {
      await this._release(receipt.resolved);
    }
  }

  /**
   * Подготовка обращения закрепляет подключение до чтения чувствительного текста.
   * Перед созданием повторно проверяются поколение трекера и состояние источника.
   */
  async task(ref: string, source: unknown, internalOptions?: unknown) {
    const trackerContext = this.b24.captureContext?.();

    // Самый ранний gate: без B24 не читаем даже channel archive и текст.
    await this._assertInboxEnabled();
    if (!this.b24.isConfigured()) {
      fail('no_b24', 'Битрикс24 не подключён — задачу ставить негде.', 503);
    }
    exactBody(source, TASK_KEYS, ['revision', 'messageRefs'], 'task body');

    const body = source as Payload;
    const titleOverride = boundedText(body.title, 'title', INBOX_DRAFT_LIMITS.title, { optional: true });
    const descriptionOverride = boundedText(
      body.description,
      'description',
      INBOX_DRAFT_LIMITS.description,
      { optional: true },
    );
    const operatorNote = operatorNoteText(body.operatorNote);
    const action = actionOptions(internalOptions, { attachments: true });
    if (action.by === 'auto' && operatorNote) {
      fail('invalid_service_call', 'Автомат не может пояснять содержимое за человека.', 500);
    }

    const committed = await this._serialize(async () => {
      await this._assertInboxEnabled();
      if (!this.b24.isConfigured()) fail('no_b24', 'Битрикс24 больше не подключён.', 503);
      const first = await this._resolve(ref);
      let firstReleased = false;
      let second: ResolvedItem | null = null;

      try {
        this._validateItem(first, body.revision, { requireActive: action.by === 'auto' });
        const selection = validateSelection(body.messageRefs, first.item, first.refCodec);
        ensureNewSelection(selection);
        const priorIndeterminate = this._existingIndeterminate(
          first.channel.id,
          first.item.ref,
          selection.refs,
        );
        if (priorIndeterminate) {
          fail(
            'indeterminate_task_commit',
            'Для этого обращения B24 уже мог создать задачу; нужен operator reconciliation.',
            503,
            null,
            priorIndeterminate,
          );
        }

        const selectedHead = selection.messages[0] as InternalInboxItem['messages'][number];
        const selectedSourceUrl = await first.context.sourceUrl({
          source: selectedHead.source,
          message: selectedHead,
        });
        const selectedDraft = buildInboxDraft({
          source: selectedHead.source,
          messages: selection.messages,
        }, {
          kind: first.item.policy.kind,
          channelLabel: first.channel.label,
          sourceUrl: selectedSourceUrl,
        });
        const rawAttachments = selectedDraft.attachments;
        await this._assertInboxEnabled();
        if (rawAttachments.length && typeof first.context.materializeAttachments !== 'function') {
          fail('channel_materialize_failed', 'Канал не умеет подготовить свои вложения.', 503);
        }
        const prepared: PreparedAttachments = rawAttachments.length
          ? materialized(await first.context.materializeAttachments?.(rawAttachments))
          : { files: [], skipped: [] };
        // Файл, который канал не смог забрать (потолок Bot API в 20 МБ, отвалившаяся
        // сеть), разбирать нечем. Человеку это не тупик: он поясняет содержимое сам,
        // и обращение всё равно доходит до модели. Автомату — тупик по определению.
        if ((action.requireAllAttachments || !operatorNote) && prepared.skipped.length) {
          fail(
            'attachments_skipped',
            'Не все вложения удалось подготовить и разобрать.',
            409,
            null,
            { attachments: unanalyzedEntries(null, prepared.skipped) },
          );
        }

        // Долгий Whisper/model call не должен держать account lease. Байты уже
        // получены под generation checks, а второй resolve ниже заново проверит
        // revision, policy и generation непосредственно перед B24.
        await this._release(first);
        firstReleased = true;

        const analysisItem = {
          ...first.item,
          messages: selection.messages,
          attachments: rawAttachments,
          draft: selectedDraft,
        };
        let attachmentAnalysis: AttachmentAnalysisResult | null = null;
        let analysisComplete = true;
        let finalTitle = titleOverride || selectedDraft.title;
        let finalDescription = descriptionOverride || selectedDraft.description;
        let formulationNote = '';
        try {
          if (rawAttachments.length) {
            // Разбор идёт ДАЖЕ с пояснением человека: неподъёмный файл в обращении
            // обычно не один, и терять распознанную речь или прочитанный документ
            // из-за соседнего видео незачем — модель получит всё, что удалось.
            if (this.attachmentAnalyzer) {
              try {
                attachmentAnalysis = await this.attachmentAnalyzer.analyze({
                  item: analysisItem,
                  materialize: async () => prepared,
                });
              } catch (error) {
                this.log.warn?.(
                  { code: errorCode(error) },
                  'inbox: разбор вложений завершился ошибкой',
                );
                attachmentAnalysis = {
                  ok: false,
                  complete: false,
                  error: 'attachment_analysis_failed',
                };
              }
            } else {
              attachmentAnalysis = {
                ok: false,
                complete: false,
                error: 'attachment_analysis_unavailable',
              };
            }
            analysisComplete = Boolean(attachmentAnalysis?.ok && attachmentAnalysis?.complete);
            if (!analysisComplete && !operatorNote) {
              fail(
                'attachment_analysis_required',
                'Содержимое вложений не удалось полностью разобрать.',
                409,
                null,
                { attachments: unanalyzedEntries(attachmentAnalysis, prepared.skipped) },
              );
            }
          }

          const derivedSections: { title: string; text: string }[] = [];
          // Пояснение человека — первичный источник смысла там, где содержимое
          // недоступно машине, поэтому стоит выше любой производной выжимки.
          if (operatorNote) {
            derivedSections.push({ title: 'Пояснение оператора', text: operatorNote });
          }
          if (!analysisComplete) {
            derivedSections.push({
              title: 'Вложения без разбора',
              text: unanalyzedList(unanalyzedEntries(attachmentAnalysis, prepared.skipped)),
            });
          }
          if (attachmentAnalysis?.text && action.by === 'human') {
            derivedSections.push({
              title: analysisComplete ? 'Разбор вложений' : 'Разбор вложений (частичный)',
              text: attachmentAnalysis.text,
            });
          }

          // Речь и безопасный текст уже понятны без vision-модели. Изображения и
          // кадры видео считаются разобранными лишь после содержательного model call;
          // пояснение человека тоже уходит на разбор — иначе оно осталось бы
          // припиской к постановке, собранной из голого текста сообщений.
          // Голое текстовое обращение ручной путь тоже прогоняет через модель:
          // человек уже решил, что задача нужна, а постановку формулирует тот же
          // триаж, что у автомата, — иначе задача уезжала бы сырым transcript-ом.
          const hasVisuals = Boolean(attachmentAnalysis?.visualPaths?.length);
          if (action.by === 'human') {
            let triaged: InboxTriageRun | null = null;

            try {
              triaged = this.attachmentTriage
                ? await this.attachmentTriage({
                  item: analysisItem as unknown as InboxTriageItem,
                  attachmentAnalysis,
                  operatorNote,
                })
                : null;
            } catch (error) {
              this.log.warn?.(
                { code: errorCode(error) },
                'inbox: model-разбор обращения завершился ошибкой',
              );
            }
            // Без пояснения инвариант прежний: визуальное вложение, которое модель
            // не прочитала, задачей не становится. С пояснением человек уже сказал
            // суть своими словами; у голого текста суть и так в сообщениях, поэтому
            // недоступная модель не запирает ручную постановку — задача уедет как есть.
            if ((!triaged?.ok || !triaged.verdict) && hasVisuals && !operatorNote) {
              fail(
                'attachment_analysis_required',
                'Визуальные вложения не удалось разобрать выбранной моделью.',
                409,
                null,
                { attachments: [] },
              );
            }
            if (!triaged?.ok || !triaged.verdict) {
              const message = operatorNote
                ? 'inbox: пояснение оператора не удалось разобрать моделью; задача из текста и пояснения'
                : 'inbox: модель не сформулировала постановку; задача уходит текстом обращения';
              this.log[operatorNote ? 'warn' : 'info']?.(
                { code: triaged?.error || 'triage_unavailable' },
                message,
              );
            }
            if (triaged?.ok && triaged.verdict) {
              const verdict = triaged.verdict;
              if (!titleOverride && verdict.kind !== 'none' && verdict.title) {
                finalTitle = boundedText(
                  verdict.title,
                  'analysis title',
                  INBOX_DRAFT_LIMITS.title,
                ) || finalTitle;
              }
              if (!descriptionOverride && verdict.kind !== 'none' && verdict.description) {
                // Как у автомата: постановка модели заменяет сырой transcript в теле,
                // ссылка на источник сохраняется отдельной строкой. Модель, уверенность
                // и причина остаются в audit note решения, а не в описании задачи.
                const sourceLine = selectedDraft.source.url
                  ? `Источник · ${first.channel.label}: ${selectedDraft.source.url}`
                  : '';
                finalDescription = [verdict.description, sourceLine].filter(Boolean).join('\n\n');
                formulationNote = inboxAutoNote({ model: triaged.model, verdict });
              } else {
                const summary = [verdict.description, verdict.reason]
                  .map((part) => String(part || '').trim())
                  .filter(Boolean)
                  .join('\n\n');
                derivedSections.push({
                  title: hasVisuals && !operatorNote ? 'Выжимка визуального разбора' : 'Выжимка разбора',
                  text: summary,
                });
              }
            }
          }
          finalDescription = appendBoundedSections(finalDescription, derivedSections);
        } finally {
          // Analyzer держит lease на visualPaths до последнего потребителя. Без
          // release cache GC не может безопасно убрать кадры и изображения.
          await releaseAttachmentAnalysis(attachmentAnalysis, this.log);
        }

        // Список проектов читается до финального resolve: последний channel lookup
        // остаётся максимально близко к необратимому B24 side effect.
        if (!this.b24.isConfigured()) fail('no_b24', 'Битрикс24 больше не подключён.', 503);
        const projects = await this.listProjects();
        if (!Array.isArray(projects)) {
          fail('stale_policy', 'Список проектов временно недоступен.', 409);
        }

        // Rules, archive contents, assignments, activation и generation могли
        // измениться во время materialize. Второй resolve — обязательный pre-B24 CAS.
        second = await this._resolve(ref);
        this._validateItem(second, body.revision, { requireActive: action.by === 'auto' });
        if (!sameSelection(first, second)) {
          fail('stale_item', 'Account generation или item изменились во время подготовки.', 409);
        }
        const verified = validateSelection(body.messageRefs, second.item, second.refCodec);
        ensureNewSelection(verified);
        if (!projects.includes(second.item.policy.project)) {
          fail('stale_policy', 'Проект правила больше не существует.', 409);
        }
        await this._assertContextCurrent(second);
        await this._assertInboxEnabled();
        if (!this.b24.isConfigured()) fail('no_b24', 'Битрикс24 больше не подключён.', 503);

        // Настройка читается ЗДЕСЬ, а не в начале хода: между materialize и
        // порталом прошли Whisper и model call, и человек мог за это время
        // выключить загрузку. Из двух прочтений верно то, что ближе к side effect.
        const attachable = selectAttachableFiles(
          prepared.files,
          this.attachmentPolicy(),
          { by: action.by },
        );
        if (attachable.length !== prepared.files.length) {
          this.log.info?.(
            {
              itemRef: second.item.ref,
              by: action.by,
              attached: attachable.length,
              total: prepared.files.length,
            },
            'inbox: часть вложений не грузится на портал по настройке плагина',
          );
        }

        let created;

        if (trackerContext) {
          this.b24.assertContext?.(trackerContext);
        }

        try {
          created = await this.b24.createTask({
            title: finalTitle,
            description: finalDescription,
            groupId: second.item.policy.b24.groupId,
            responsibleId: second.item.policy.b24.responsibleId,
            priority: second.item.policy.b24.priority,
            // Содержимое уже разобрано и пересказано в постановке; на портал
            // едут только те исходники, которые разрешены настройкой плагина.
            images: attachable,
          });
        } catch (err) {
          fail(
            'b24_failed',
            'Портал не принял задачу. Обращение осталось новым.',
            502,
            err,
          );
        }

        const taskId = safeTaskId(created?.id);

        if (!taskId) {
          const details = this._markIndeterminate(second.channel.id, second.item.ref, verified.refs, {
            taskId: null,
            taskUrl: '',
          });
          fail(
            'indeterminate_task_commit',
            'Портал принял создание, но не вернул id задачи. Не повторяйте действие до сверки.',
            503,
            null,
            details,
          );
        }
        const taskUrl = await this._taskUrl(taskId);

        let decision: DecisionResult;

        try {
          decision = await second.context.inboxState.decide({
            activationEpoch: second.item.activationEpoch,
            originItemRef: second.item.ref,
            messageRefs: verified.refs,
            scopeRef: second.item.policy.scopeRef,
            status: 'task',
            taskId,
            taskUrl,
            by: action.by,
            // В audit остаётся факт: чем сформулирована постановка, разобрано ли
            // содержимое полностью и что пересказал человек. Иначе потом не
            // объяснить ни модель постановки, ни отсутствие расшифровки видео.
            note: operatorNote || formulationNote
              ? truncateText(
                [
                  action.note,
                  formulationNote,
                  operatorNote ? `Пояснение оператора при неполном разборе: ${operatorNote}` : '',
                ].filter(Boolean).join('\n'),
                MAX_DECISION_NOTE_BYTES / 4,
              )
              : action.note,
            decidedAtMs: this.now(),
          });
          if (!validDecisionResult(decision)) {
            throw Object.assign(new Error('Inbox state вернул невалидный decision result.'), {
              code: 'invalid_state_result',
            });
          }
        } catch (err) {
          const details = this._markIndeterminate(
            second.channel.id,
            second.item.ref,
            verified.refs,
            { taskId, taskUrl },
          );
          this.log.error?.({ itemRef: second.item.ref, taskId, code: errorCode(err) },
            'inbox: B24 task создана, decision commit неопределён');
          fail(
            'indeterminate_task_commit',
            'B24-задача создана, но Inbox не подтвердил запись решения. Не повторяйте действие.',
            503,
            err,
            details,
          );
        }

        this._notify({
          itemRef: second.item.ref,
          channel: second.channel.id,
          status: 'task',
          taskId,
        });
        const result = {
          taskId,
          taskUrl,
          decision: {
            decisionId: decision.decisionId,
            version: decision.version,
          },
          skipped: publicSkipped(prepared.skipped),
          item: await this._publicItemSafe(ref),
        };
        let notification: TaskNotificationReceipt | null = null;

        if (typeof second.context.notifyTaskCreated === 'function') {
          const anchor = verified.messages[0] as InternalInboxItem['messages'][number];
          const payload = {
            source: structuredClone(anchor.source),
            message: structuredClone(anchor),
            taskId,
            taskUrl,
            // Номер задачи ничего не говорит о том, ЧТО из разговора в неё уехало.
            // У разбитой карточки это единственный способ различить свои задачи.
            title: finalTitle,
          };
          const resolved = second;
          notification = {
            channel: resolved.channel.id,
            resolved,
            payload,
          };
          second = null; // ownership переходит post-commit доставке ниже
        }
        return { result, notification };
      } finally {
        await this._release(second);
        if (!firstReleased) await this._release(first);
      }
    });
    // Network confirmation не держит глобальную очередь Inbox: следующий
    // decision может начаться, пока Telegram отвечает. Account lease остаётся
    // жив до конца вызова и не даёт switch подменить bot/token на полпути.
    const notification = await this._deliverTaskNotification(committed.notification);
    return notification ? { ...committed.result, notification } : committed.result;
  }

  async dismiss(ref: string, source: unknown, internalOptions?: unknown) {
    exactBody(source, DECIDE_KEYS, ['revision', 'messageRefs'], 'dismiss body');

    const body = source as Payload;
    const action = actionOptions(internalOptions);
    return this._serialize(async () => {
      await this._assertInboxEnabled();
      const resolved = await this._resolve(ref);
      try {
        this._validateItem(resolved, body.revision, { requireActive: action.by === 'auto' });
        const selection = validateSelection(body.messageRefs, resolved.item, resolved.refCodec);
        ensureNewSelection(selection);
        const priorIndeterminate = this._existingIndeterminate(
          resolved.channel.id,
          resolved.item.ref,
          selection.refs,
        );
        if (priorIndeterminate) {
          fail(
            'indeterminate_task_commit',
            'Для выбранных сообщений B24 уже мог создать задачу; нужен operator reconciliation.',
            503,
            null,
            priorIndeterminate,
          );
        }
        await this._assertInboxEnabled();
        await this._assertContextCurrent(resolved);
        await this._assertInboxEnabled();
        const decision = await resolved.context.inboxState.decide({
          activationEpoch: resolved.item.activationEpoch,
          originItemRef: resolved.item.ref,
          messageRefs: selection.refs,
          scopeRef: resolved.item.policy.scopeRef,
          status: 'skipped',
          taskId: null,
          taskUrl: '',
          by: action.by,
          note: action.note,
          decidedAtMs: this.now(),
          requireActive: action.by === 'auto',
        });
        this._notify({
          itemRef: resolved.item.ref,
          channel: resolved.channel.id,
          status: 'skipped',
          taskId: null,
        });
        return {
          decision: { decisionId: decision.decisionId, version: decision.version },
          item: await this._publicItemSafe(ref),
        };
      } finally {
        await this._release(resolved);
      }
    });
  }

  async reset(ref: string, source: unknown) {
    exactBody(source, RESET_KEYS, [
      'revision', 'messageRefs', 'decisionId', 'decisionVersion',
    ], 'reset body');

    const body = source as Payload;

    if (typeof body.decisionId !== 'string' || !body.decisionId) {
      fail('invalid_request', 'decisionId обязателен.');
    }
    if (!Number.isSafeInteger(body.decisionVersion) || Number(body.decisionVersion) < 1) {
      fail('invalid_request', 'decisionVersion должен быть положительным целым.');
    }
    return this._serialize(async () => {
      await this._assertInboxEnabled();
      const resolved = await this._resolve(ref);
      try {
        this._validateItem(resolved, body.revision);
        const selection = validateSelection(body.messageRefs, resolved.item, resolved.refCodec);
        const priorIndeterminate = this._existingIndeterminate(
          resolved.channel.id,
          resolved.item.ref,
          selection.refs,
        );
        if (priorIndeterminate) {
          fail(
            'indeterminate_task_commit',
            'Decisions канала заблокированы до operator reconciliation.',
            503,
            null,
            priorIndeterminate,
          );
        }
        const own = selection.messages.every((message) => (
          message.decision?.status === 'skipped'
          && message.decision.decisionId === body.decisionId
          && message.decision.version === body.decisionVersion
        ));
        if (!own) fail('stale_decision', 'Выбор больше не принадлежит указанной skipped decision.', 409);
        await this._assertInboxEnabled();
        await this._assertContextCurrent(resolved);
        await this._assertInboxEnabled();
        const residual = await resolved.context.inboxState.reset({
          decisionId: body.decisionId,
          expectedVersion: body.decisionVersion,
          messageRefs: selection.refs,
          nowMs: this.now(),
        });
        this._notify({
          itemRef: resolved.item.ref,
          channel: resolved.channel.id,
          status: residual ? 'mixed' : 'new',
          taskId: null,
        });
        return {
          decision: residual
            ? { decisionId: residual.decisionId, version: residual.version }
            : null,
          item: await this._publicItemSafe(ref),
        };
      } finally {
        await this._release(resolved);
      }
    });
  }
}

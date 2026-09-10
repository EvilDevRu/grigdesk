// Provider-neutral triage общего Inbox. Модель видит только normalized presentation
// fields; channel-native IDs, attachment refs и credentials в prompt не попадают.

import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';

import { resolveModelRef } from '../chat/modelRef.ts';
import {
  boundedText,
  exactKeys,
  jsonCandidates,
  modelText,
} from '../modelJson.ts';
import { getExecutor } from '../executors/index.ts';
import { getModelsRegistry } from '../modelsRegistry.ts';
import { inboxTranscript, visibleInboxMessages, INBOX_DRAFT_LIMITS } from './draft.ts';

// Соседи разбора — ещё JavaScript. Объявлено ровно то, чем пользуется разбор:
// сузить чужую форму до нужного здесь честнее, чем описывать её целиком и разойтись
// с оригиналом при первой же его правке.
interface ResolvedTriageModel {
  id?: string;
  efforts?: string[];
  inputModalities?: string[];
}

interface ResolvedModelRef {
  ok: boolean;
  error?: string;
  modelRef?: { provider: string; model: string };
  model?: ResolvedTriageModel;
}

// Исполнитель недоверенного ввода. Обычного `run` мало: разбор кормит модель текстом
// из чужого канала, и это отдельная возможность адаптера с отдельным объявлением.
interface UntrustedExecutor {
  runUntrusted?: (options: Record<string, unknown>) => Promise<{ reply?: unknown }>;
  untrustedInput?: {
    text?: boolean;
    images?: boolean;
    maxImages?: number;
    mediaTypes?: string[];
  };
}

type FsPort = typeof fs;

const resolveTriageModelRef = resolveModelRef as (
  value: unknown,
  registry: unknown,
) => ResolvedModelRef;

// Карточка в том виде, в каком её читает разбор: только presentation-поля. Нативных
// идентификаторов канала и ссылок на вложения здесь нет и быть не может — модель
// видит разговор, а не доступ к каналу.
export interface InboxTriageItem {
  channel?: string;
  channelLabel?: string;
  status?: string;
  cold?: boolean;
  lastAt?: number;
  sourceUrl?: string | null;
  source?: { title?: string } | null;
  policy?: {
    kind?: string;
    autoTask?: {
      enabled?: boolean;
      minConfidence?: number;
      maxPerDay?: number;
    } | null;
  } | null;
  draft?: {
    title?: string;
    description?: string;
    source?: { url?: string } | null;
  } | null;
  messages?: unknown[];
}

export interface InboxTriageVerdict {
  kind: string;
  confidence: number;
  title: string;
  description: string;
  reason: string;
}

export interface InboxTriageStatement extends InboxTriageVerdict {
  messages: number[];
}

export interface InboxTriagePlan {
  statements: InboxTriageStatement[];
  messageCount: number;
  covered: number;
}

export interface InboxTriageModelRef {
  provider: string;
  model: string;
  effort?: string;
}

// Что решено по карточке или по одному поводу. `judge` означает «нужен ход модели»,
// и это не результат, а требование: ворота карточки пройдены, вердикта ещё нет.
export interface InboxAutoDecision {
  action: string;
  reason: string;
}

// Один повод из плана вместе с решением по нему: сам план ничего не создаёт,
// решение о создании принимается отдельно и по каждому поводу своё.
export interface InboxAutoPlanEntry {
  statement: InboxTriageStatement;
  action: string;
  reason: string;
}

// Решение по сообщению в том виде, в каком его считает дневная квота.
interface InboxDecisionLike {
  status?: string;
  by?: string;
  scopeRef?: string;
  decidedAtMs?: number;
}

// Разрешённая цель разбора: модель, её исполнитель и допустимый уровень эффорта.
export interface InboxTriageTarget {
  ok: boolean;
  error?: string;
  ref?: { provider: string; model: string };
  model?: ResolvedTriageModel;
  effort?: string | null;
  executor?: UntrustedExecutor;
}

export interface InboxTriageRun {
  ok: boolean;
  error?: string;
  model?: string;
  plan?: InboxTriagePlan | null;
  verdict?: InboxTriageVerdict | null;
}

export interface InboxVisualImage {
  mediaType: string;
  data: string;
}

interface AttachmentAnalysisView {
  text: string;
  visualPaths: string[];
  visualOverflow: boolean;
  visualInvalid: boolean;
}

type LogPort = {
  warn?: (details: unknown, message: string) => void;
};

export const INBOX_TRIAGE_KINDS = Object.freeze(['bug', 'wish', 'none']);
export const INBOX_TRIAGE_LIMITS = Object.freeze({
  transcript: 24_000,
  summary: 4_000,
  reason: 2_000,
  modelSegment: 256,
  attachmentContext: 12_000,
  attachmentPaths: 24,
  attachmentBytes: 20 * 1024 * 1024,
  attachmentTotalBytes: 80 * 1024 * 1024,
  statements: 10,
  operatorNote: 4_000,
});
export const INBOX_AUTO_MAX_AGE_MS = 86_400_000;

const VERDICT_KEYS = ['kind', 'confidence', 'title', 'description', 'reason'];
const STATEMENT_KEYS = [...VERDICT_KEYS, 'messages'];
const KIND_HINT = Object.freeze({
  bug: 'баги и поломки',
  wish: 'идеи и пожелания',
});
const VISUAL_MEDIA_TYPES = Object.freeze(new Map([
  ['.bmp', 'image/bmp'],
  ['.gif', 'image/gif'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
]));
// Разбор ответа модели общий с разбором встречи (lib/media/meetingPlan.ts):
// формат ответа один, и вторая копия этих проверок разошлась бы с первой.
const text = modelText;
const bounded = boundedText;

function clamp(value: unknown, limit: number): string {
  const result = text(value);

  if (!Number.isSafeInteger(limit) || limit < 1) return '';
  if (result.length <= limit) return result;

  return `${result.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}


export function normalizeInboxTriageModel(value: unknown): InboxTriageModelRef | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const raw = value as Record<string, unknown>;
  const provider = bounded(raw.provider, INBOX_TRIAGE_LIMITS.modelSegment);
  const model = bounded(raw.model, INBOX_TRIAGE_LIMITS.modelSegment);

  if (!provider || !model) return null;

  // Эффорт здесь только принимается на веру: допустимость уровня знает реестр,
  // а он ещё не прочитан. Сверка — в resolveInboxTriageTarget.
  const effort = bounded(raw.effort, INBOX_TRIAGE_LIMITS.modelSegment);

  return effort ? { provider, model, effort } : { provider, model };
}

/**
 * Уровень эффорта, который МОЖНО отдать этой модели. Неподдерживаемый не заменяется
 * соседним и не роняет ход: `--effort xhigh` у модели без такой возможности валит
 * запуск CLI, а сохранённая настройка живёт долго и легко устаревает после обновления
 * бинаря. Поэтому устаревший уровень снимается, а ход идёт на умолчании исполнителя.
 */
function supportedEffort(
  effort: string | undefined,
  model: ResolvedTriageModel | undefined,
  log: LogPort | undefined,
): string | null {
  if (!effort) return null;

  const levels = Array.isArray(model?.efforts) ? model.efforts : [];

  if (levels.includes(effort)) return effort;
  log?.warn?.(
    { effort, model: model?.id, levels },
    'разбор: уровень эффорта не поддержан моделью, иду на умолчании',
  );

  return null;
}

function safeAttachmentAnalysis(value: unknown): AttachmentAnalysisView {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { text: '', visualPaths: [], visualOverflow: false, visualInvalid: false };
  }

  const raw = value as Record<string, unknown>;
  const analysisText = clamp(raw.text, INBOX_TRIAGE_LIMITS.attachmentContext);
  const rawPaths = Array.isArray(raw.visualPaths) ? raw.visualPaths as unknown[] : [];
  const absolutePaths = rawPaths
    .filter((entry): entry is string => typeof entry === 'string' && path.isAbsolute(entry));

  return {
    text: analysisText,
    visualPaths: absolutePaths.slice(0, INBOX_TRIAGE_LIMITS.attachmentPaths),
    visualOverflow: absolutePaths.length > INBOX_TRIAGE_LIMITS.attachmentPaths,
    visualInvalid: absolutePaths.length !== rawPaths.length,
  };
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);

  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function hasImageSignature(bytes: Buffer, mediaType: string): boolean {
  if (mediaType === 'image/jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mediaType === 'image/png') {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  }
  if (mediaType === 'image/gif') {
    const signature = bytes.subarray(0, 6).toString('ascii');
    return signature === 'GIF87a' || signature === 'GIF89a';
  }
  if (mediaType === 'image/webp') {
    return bytes.length >= 12
      && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
      && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  }
  return mediaType === 'image/bmp'
    && bytes.length >= 2
    && bytes.subarray(0, 2).toString('ascii') === 'BM';
}

/**
 * Visual paths — внутренний transport анализатора, а не доступ модели к файловой
 * системе. Читаем их сервером из единственного cache root и дальше передаём адаптеру
 * только media type + base64. Ни cwd, ни writable/readable root модель не получает.
 */
export async function loadInboxVisualInputs(visualPaths: unknown, { config = {}, fsImpl = fs }: {
  config?: { mediaDir?: unknown };
  fsImpl?: FsPort;
} = {}): Promise<{ ok: boolean; images?: InboxVisualImage[]; error?: string }> {
  const paths = Array.isArray(visualPaths) ? visualPaths as string[] : [];

  if (!paths.length) return { ok: true, images: [] };

  const configuredRoot = typeof config?.mediaDir === 'string' && config.mediaDir
    ? path.join(config.mediaDir, 'inbox-attachment-analysis')
    : '';
  if (!configuredRoot) return { ok: false, error: 'invalid_attachment_path' };

  let root: string;

  try { root = await fsImpl.realpath(configuredRoot); } catch {
    return { ok: false, error: 'invalid_attachment_path' };
  }

  const images: InboxVisualImage[] = [];
  let totalBytes = 0;

  for (const sourcePath of paths) {
    let resolved: string;

    try { resolved = await fsImpl.realpath(sourcePath); } catch {
      return { ok: false, error: 'invalid_attachment_path' };
    }
    if (!isInside(root, resolved)) return { ok: false, error: 'invalid_attachment_path' };

    const mediaType = VISUAL_MEDIA_TYPES.get(path.extname(resolved).toLowerCase());
    if (!mediaType) return { ok: false, error: 'unsupported_media' };

    let handle: Awaited<ReturnType<FsPort['open']>> | undefined;

    try {
      handle = await fsImpl.open(resolved, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > INBOX_TRIAGE_LIMITS.attachmentBytes) {
        return { ok: false, error: 'attachment_media_limit' };
      }
      totalBytes += stat.size;
      if (totalBytes > INBOX_TRIAGE_LIMITS.attachmentTotalBytes) {
        return { ok: false, error: 'attachment_media_limit' };
      }
      const bytes = await handle.readFile();
      if (bytes.length !== stat.size || !hasImageSignature(bytes, mediaType)) {
        return { ok: false, error: 'invalid_attachment_media' };
      }
      images.push({ mediaType, data: bytes.toString('base64') });
    } catch {
      return { ok: false, error: 'invalid_attachment_path' };
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  return { ok: true, images };
}

function promptContext(
  item: InboxTriageItem | undefined,
  attachmentAnalysis: unknown,
  { numbered = false, operatorNote = '' }: { numbered?: boolean; operatorNote?: string } = {},
) {
  const messages = visibleInboxMessages(item?.messages || []);
  const transcript = inboxTranscript(messages, {
    limit: INBOX_TRIAGE_LIMITS.transcript,
    numbered,
  });
  const attachments = safeAttachmentAnalysis(attachmentAnalysis);
  return {
    label: text(item?.channelLabel) || text(item?.channel) || 'канал',
    source: text(item?.source?.title) || 'без названия',
    hint: (KIND_HINT as Record<string, string>)[String(item?.policy?.kind)]
      || 'обращения пользователей',
    transcript: transcript.text,
    truncated: transcript.truncated,
    total: messages.length,
    // Номера существуют только у показанных строк: обрезанный хвост модель не читала,
    // и приписать ему постановку она не имеет права.
    messageCount: Number.isSafeInteger(transcript.shown) ? transcript.shown : messages.length,
    attachmentBlock: attachments.text
      ? ['', 'Содержимое вложений, подготовленное сервером:', attachments.text]
      : [],
    visualBlock: attachments.visualPaths.length
      ? [
        '',
        `Вместе с запросом переданы визуальные вложения и кадры видео: ${attachments.visualPaths.length}.`,
        'Обязательно изучи сами изображения перед решением.',
      ]
      : [],
    // Пояснение приходит не из канала, а от оператора кокпита: он посмотрел то,
    // что машина прочитать не смогла (видео сверх лимита Telegram, чужой формат),
    // и пересказал суть. Для модели это самый достоверный кусок входа, и сказать
    // об этом надо прямо — иначе она уравняет его с болтовнёй в чате.
    operatorBlock: text(operatorNote)
      ? [
        '',
        'Пояснение оператора кокпита (он видел вложения, которые не удалось разобрать):',
        text(operatorNote).slice(0, INBOX_TRIAGE_LIMITS.operatorNote),
        'Это достоверный источник: опирайся на него наравне с текстом обращения.',
      ]
      : [],
  };
}

export function buildInboxTriagePrompt(item: InboxTriageItem | undefined, {
  attachmentAnalysis = null,
  operatorNote = '',
  decided = false,
}: {
  attachmentAnalysis?: unknown;
  operatorNote?: string;
  decided?: boolean;
} = {}) {
  const ctx = promptContext(item, attachmentAnalysis, { operatorNote });
  return {
    system: [
      'Ты разбираешь обращение из рабочего канала и решаешь, нужна ли по нему задача.',
      'Ответь одним JSON-объектом без markdown и любого другого текста.',
      'Обязательные поля: kind ("bug"|"wish"|"none"), confidence (число 0..1),',
      'title (одна строка), description (только подтверждённая обращением суть),',
      'reason (одно краткое предложение с причиной решения).',
      'Ничего не додумывай. Благодарность, разговор или вопрос без задачи — kind "none".',
      'Если не уверен, снижай confidence: обращение останется человеку.',
      // Ручной путь: решение «задача нужна» уже принято человеком, модель здесь
      // формулирует постановку, а не голосует заново.
      ...(decided || text(operatorNote)
        ? [text(operatorNote)
          ? 'Оператор уже решил, что задача нужна: сформулируй её из обращения и пояснения.'
          : 'Человек уже решил, что задача нужна: сформулируй постановку из обращения.']
        : []),
    ].join('\n'),
    user: [
      `Канал: ${ctx.label}. Источник: ${ctx.source}.`,
      `По правилу сюда поступают: ${ctx.hint}. Это подсказка, а не готовый ответ.`,
      '',
      'Обращение:',
      ctx.transcript,
      ...ctx.attachmentBlock,
      ...ctx.visualBlock,
      ...ctx.operatorBlock,
    ].join('\n'),
  };
}

/**
 * Карточка — это разговор, а не одна просьба: в неё склеены все сообщения человека
 * за окно тишины. Поэтому модель отвечает не одним вердиктом, а РАЗБИЕНИЕМ: список
 * поводов, у каждого свои номера сообщений. Номера — единственный способ сказать,
 * какая часть разговора относится к какой задаче, а какая является болтовнёй.
 */
export function buildInboxTriagePlanPrompt(item: InboxTriageItem | undefined, {
  attachmentAnalysis = null,
}: { attachmentAnalysis?: unknown } = {}) {
  const ctx = promptContext(item, attachmentAnalysis, { numbered: true });
  return {
    messageCount: ctx.messageCount,
    truncated: ctx.truncated,
    system: [
      'Ты разбираешь обращение из рабочего канала: подряд идущие сообщения одного разговора.',
      'В нём может быть несколько независимых поводов, а может не быть ни одного.',
      'Ответь одним JSON-объектом без markdown и любого другого текста.',
      'Формат: {"statements": [ … ]} — по одному элементу на каждый отдельный повод.',
      'Поля элемента: messages (массив номеров сообщений), kind ("bug"|"wish"|"none"),',
      'confidence (число 0..1), title (одна строка), description (только подтверждённая суть),',
      'reason (одно краткое предложение с причиной решения).',
      'Сообщения пронумерованы (#1, #2 …). Каждый номер укажи ровно один раз и распредели все.',
      'Сообщения одного повода объединяй в один элемент, даже если между ними есть посторонние.',
      'Уточнение к соседнему сообщению — часть того же повода, а не новый.',
      'Благодарности, разговор и вопросы без задачи собери в элемент с kind "none".',
      'Ничего не додумывай. Если не уверен, снижай confidence: повод останется человеку.',
    ].join('\n'),
    user: [
      `Канал: ${ctx.label}. Источник: ${ctx.source}.`,
      `По правилу сюда поступают: ${ctx.hint}. Это подсказка, а не готовый ответ.`,
      '',
      ctx.truncated
        ? `Показаны первые ${ctx.messageCount} сообщений из ${ctx.total}; остальные разберёт человек.`
        : `Сообщений в обращении: ${ctx.messageCount}.`,
      ctx.transcript,
      ...ctx.attachmentBlock,
      ...ctx.visualBlock,
    ].join('\n'),
  };
}

function verdictFields(raw: Record<string, unknown>): InboxTriageVerdict | null {
  if (!INBOX_TRIAGE_KINDS.includes(String(raw.kind))) return null;

  const title = bounded(raw.title, INBOX_DRAFT_LIMITS.title);
  const description = bounded(raw.description, INBOX_TRIAGE_LIMITS.summary);
  const reason = bounded(raw.reason, INBOX_TRIAGE_LIMITS.reason);

  if (title === null || description === null || reason === null) return null;

  const confidence = typeof raw.confidence === 'number'
    && Number.isFinite(raw.confidence)
    && raw.confidence >= 0
    && raw.confidence <= 1
    ? raw.confidence
    : 0;

  return { kind: String(raw.kind), confidence, title, description, reason };
}

export function parseInboxTriageVerdict(reply: unknown): InboxTriageVerdict | null {
  for (const candidate of jsonCandidates(reply)) {
    let raw: Record<string, unknown>;

    try { raw = JSON.parse(String(candidate)); } catch { continue; }
    if (!exactKeys(raw, VERDICT_KEYS)) continue;
    const verdict = verdictFields(raw);
    if (verdict) return verdict;
  }
  return null;
}

function statementFields(
  raw: Record<string, unknown>,
  messageCount: number,
  used: Set<number>,
): InboxTriageStatement | null {
  if (!exactKeys(raw, STATEMENT_KEYS)) return null;

  const verdict = verdictFields(raw);

  if (!verdict) return null;
  if (!Array.isArray(raw.messages)
      || raw.messages.length < 1
      || raw.messages.length > messageCount) return null;

  const messages: number[] = [];

  for (const index of raw.messages as number[]) {
    if (!Number.isSafeInteger(index) || index < 1 || index > messageCount) return null;
    // Пересечение — отказ всему плану: два решения на одно сообщение запрещены
    // контрактом decisions, и молча выбросить лишнее означало бы решить за модель.
    if (used.has(index)) return null;
    used.add(index);
    messages.push(index);
  }
  return { ...verdict, messages: messages.sort((a, b) => a - b) };
}

/**
 * План разбиения. Непокрытые номера — законный исход: их сообщения остаются человеку,
 * карточка становится `mixed`. А вот пересечение или номер вне диапазона отвергают
 * весь план: это уже не «модель не уверена», а ответ не по контракту.
 */
export function parseInboxTriagePlan(reply: unknown, { messageCount = 0 }: {
  messageCount?: number;
} = {}): InboxTriagePlan | null {
  if (!Number.isSafeInteger(messageCount) || messageCount < 1) return null;

  for (const candidate of jsonCandidates(reply)) {
    let raw: Record<string, unknown>;

    try { raw = JSON.parse(String(candidate)); } catch { continue; }
    if (!exactKeys(raw, ['statements'])
        || !Array.isArray(raw.statements)
        || raw.statements.length < 1
        || raw.statements.length > INBOX_TRIAGE_LIMITS.statements) continue;

    const used = new Set<number>();
    const statements: InboxTriageStatement[] = [];

    for (const entry of raw.statements as Record<string, unknown>[]) {
      const statement = statementFields(entry, messageCount, used);
      if (!statement) {
        statements.length = 0;
        break;
      }
      statements.push(statement);
    }
    if (!statements.length) continue;
    return { statements, messageCount, covered: used.size };
  }
  return null;
}

export function decideInboxAutoAction({ item, verdict, createdToday = 0, nowMs = 0 }: {
  item?: InboxTriageItem;
  verdict?: InboxTriageVerdict | null;
  createdToday?: number;
  nowMs?: number;
} = {}): InboxAutoDecision {
  const auto = item?.policy?.autoTask || {};

  if (!auto.enabled) return { action: 'off', reason: 'auto_disabled' };
  if (item?.status !== 'new') return { action: 'skip', reason: 'not_new' };
  if (!item?.cold) return { action: 'wait', reason: 'hot' };

  const ageMs = Math.max(0, Number(nowMs) - Number(item?.lastAt || 0) * 1000);

  if (ageMs > INBOX_AUTO_MAX_AGE_MS) return { action: 'old', reason: 'older_than_24h' };
  if (createdToday >= Number(auto.maxPerDay)) return { action: 'limit', reason: 'quota' };
  if (verdict === undefined) return { action: 'judge', reason: 'model_required' };
  if (!verdict) return { action: 'unclear', reason: 'invalid_verdict' };
  if (!INBOX_TRIAGE_KINDS.includes(verdict.kind)
      || !Number.isFinite(verdict.confidence)
      || verdict.confidence < 0
      || verdict.confidence > 1) {
    return { action: 'unclear', reason: 'invalid_verdict' };
  }
  if (verdict.confidence < Number(auto.minConfidence)) {
    return { action: 'unsure', reason: 'low_confidence' };
  }
  if (verdict.kind === 'none') return { action: 'dismiss', reason: verdict.reason || 'not_a_task' };

  return { action: 'create', reason: verdict.reason || 'model_task' };
}

/**
 * Ворота карточки и ворота каждого повода — разные вещи. Возраст, cold, статус и
 * участие проверяются один раз на карточку; уверенность и дневная квота — на каждый
 * повод отдельно, и квота тикает по ЗАДАЧАМ, а не по обращениям. Неуверенный повод
 * не отменяет соседние: его сообщения просто остаются человеку.
 */
export function decideInboxAutoPlan({ item, plan, createdToday = 0, nowMs = 0 }: {
  item?: InboxTriageItem;
  plan?: InboxTriagePlan | null;
  createdToday?: number;
  nowMs?: number;
} = {}): InboxAutoDecision & { statements: InboxAutoPlanEntry[] } {
  const card = decideInboxAutoAction({ item, createdToday, nowMs });

  if (card.action !== 'judge') return { ...card, statements: [] };
  if (plan === undefined) return { action: 'judge', reason: 'model_required', statements: [] };
  if (!plan || !Array.isArray(plan.statements) || plan.statements.length < 1) {
    return { action: 'unclear', reason: 'invalid_plan', statements: [] };
  }

  let made = 0;
  const statements = plan.statements.map((statement) => {
    const decision = decideInboxAutoAction({
      item,
      verdict: statement,
      createdToday: createdToday + made,
      nowMs,
    });
    if (decision.action === 'create') made += 1;
    return { statement, action: decision.action, reason: decision.reason };
  });
  return { action: 'run', reason: 'model_plan', statements };
}

export function countInboxAutoTasks(decisions: unknown, { scopeRef, sinceMs = 0 }: {
  scopeRef?: unknown;
  sinceMs?: number;
} = {}): number {
  if (typeof scopeRef !== 'string' || !Number.isSafeInteger(sinceMs) || sinceMs < 0) return 0;

  return (Array.isArray(decisions) ? decisions as InboxDecisionLike[] : []).filter((decision) => (
    decision?.status === 'task'
    && decision?.by === 'auto'
    && decision?.scopeRef === scopeRef
    && Number.isSafeInteger(decision?.decidedAtMs)
    && Number(decision.decidedAtMs) >= sinceMs
  )).length;
}

export function inboxAutoNote({ model = '', verdict = null, reason = '' }: {
  model?: string;
  verdict?: InboxTriageVerdict | null;
  reason?: string;
} = {}): string {
  const parts: string[] = [];
  const safeModel = clamp(model, 512);
  const safeReason = clamp(reason || verdict?.reason, INBOX_TRIAGE_LIMITS.reason);
  if (safeModel) parts.push(`разбор ${safeModel}`);
  if (Number.isFinite(verdict?.confidence)) parts.push(`уверенность ${verdict?.confidence}`);
  if (safeReason) parts.push(safeReason);
  return parts.join(' · ');
}

export function buildInboxAutoTask({ item, verdict, sourceUrl: override = null }: {
  item?: InboxTriageItem;
  verdict?: InboxTriageVerdict | null;
  sourceUrl?: string | null;
} = {}): { title: string; description: string } {
  const title = clamp(verdict?.title, INBOX_DRAFT_LIMITS.title)
    || clamp(item?.draft?.title, INBOX_DRAFT_LIMITS.title);
  const summary = clamp(verdict?.description, INBOX_TRIAGE_LIMITS.summary);
  const label = clamp(item?.channelLabel || item?.channel, 256) || 'канал';
  // Ссылка ведёт на первое сообщение ИМЕННО этого повода: у разбитой карточки
  // голова разговора и голова задачи — разные сообщения.
  const sourceUrl = clamp(
    override || item?.sourceUrl || item?.draft?.source?.url,
    INBOX_DRAFT_LIMITS.sourceUrlChars,
  );
  const source = sourceUrl ? `Источник · ${label}: ${sourceUrl}` : '';
  // Обычно summary обязана сформулировать модель. Исходный transcript нужен
  // лишь как fail-safe для некорректного, но принятого verdict без description.
  const statement = summary || clamp(item?.draft?.description, INBOX_TRIAGE_LIMITS.summary);
  return {
    title,
    description: [statement, source].filter(Boolean).join('\n\n'),
  };
}

/**
 * Разрешает модель только вместе с отдельным transport для недоверенного ввода.
 * Наличие обычного coding executor.run здесь недостаточно и fallback запрещён.
 */
export async function resolveInboxTriageTarget({
  modelRef,
  config = {},
  modelsRegistry = getModelsRegistry,
  executorResolver = getExecutor,
  requireImages = false,
  log = console,
}: {
  modelRef?: unknown;
  config?: Record<string, unknown>;
  modelsRegistry?: (config: { modelsPath: string }) => Promise<unknown> | unknown;
  executorResolver?: (provider: string) => Promise<unknown> | unknown;
  requireImages?: boolean;
  log?: LogPort;
} = {}): Promise<InboxTriageTarget> {
  const ref = normalizeInboxTriageModel(modelRef);
  if (!ref) return { ok: false, error: 'no_model' };

  let registry: unknown;

  // Реестру нужен только путь к models.json; здесь лежит серверный config целиком,
  // и его точная форма объявлена не тут, а в config.ts.
  try { registry = await modelsRegistry(config as { modelsPath: string }); } catch {
    return { ok: false, error: 'registry_failed' };
  }

  const resolved = resolveTriageModelRef(ref, registry);

  if (!resolved.ok || !resolved.modelRef) return { ok: false, error: resolved.error };

  let executor: UntrustedExecutor | undefined;

  try {
    executor = await executorResolver(resolved.modelRef.provider) as UntrustedExecutor;
  } catch {
    return { ok: false, error: 'executor_unavailable' };
  }
  if (!executor) return { ok: false, error: 'executor_unavailable' };
  if (typeof executor.runUntrusted !== 'function' || executor.untrustedInput?.text !== true) {
    return { ok: false, error: 'unsafe_model_provider' };
  }
  if (requireImages) {
    const modalities = Array.isArray(resolved.model?.inputModalities)
      ? resolved.model.inputModalities
      : [];
    if (!modalities.includes('image')
        || executor.untrustedInput?.images !== true
        || !Number.isSafeInteger(executor.untrustedInput?.maxImages)
        || Number(executor.untrustedInput?.maxImages) < 1
        || !Array.isArray(executor.untrustedInput?.mediaTypes)
        || executor.untrustedInput.mediaTypes?.length === 0) {
      return { ok: false, error: 'unsupported_media' };
    }
  }
  return {
    ok: true,
    ref: resolved.modelRef,
    model: resolved.model,
    effort: supportedEffort(ref.effort, resolved.model, log),
    executor,
  };
}

export async function runInboxTriage({
  item,
  attachmentAnalysis = null,
  modelRef,
  config = {},
  providerSettings = {},
  modelsRegistry = getModelsRegistry,
  executorResolver = getExecutor,
  log = console,
  signal,
  mode = 'verdict',
  operatorNote = '',
  decided = false,
}: {
  item?: InboxTriageItem;
  attachmentAnalysis?: unknown;
  modelRef?: unknown;
  config?: Record<string, unknown>;
  providerSettings?: Record<string, unknown>;
  modelsRegistry?: (config: { modelsPath: string }) => Promise<unknown> | unknown;
  executorResolver?: (provider: string) => Promise<unknown> | unknown;
  log?: LogPort;
  signal?: AbortSignal;
  mode?: string;
  operatorNote?: string;
  decided?: boolean;
} = {}): Promise<InboxTriageRun> {
  if (!['verdict', 'plan'].includes(mode)) return { ok: false, error: 'invalid_triage_mode' };
  const analysis = safeAttachmentAnalysis(attachmentAnalysis);
  if (analysis.visualInvalid) return { ok: false, error: 'invalid_attachment_path' };
  if (analysis.visualOverflow) return { ok: false, error: 'attachment_media_limit' };
  const hasVisuals = analysis.visualPaths.length > 0;
  const target = await resolveInboxTriageTarget({
    modelRef,
    config,
    modelsRegistry,
    executorResolver,
    requireImages: hasVisuals,
    log,
  });
  if (!target.ok || !target.ref || !target.executor) return target as InboxTriageRun;

  const { provider, model } = target.ref;
  const executor = target.executor;

  if (hasVisuals) {
    const maxImages = Number(executor.untrustedInput?.maxImages);
    if (maxImages < analysis.visualPaths.length) {
      return { ok: false, error: 'unsupported_media' };
    }
  }
  const loaded = await loadInboxVisualInputs(analysis.visualPaths, { config });

  if (!loaded.ok) return loaded as InboxTriageRun;

  const images = loaded.images || [];

  if (images.some((image) => !executor.untrustedInput?.mediaTypes?.includes(image.mediaType))) {
    return { ok: false, error: 'unsupported_media' };
  }
  const prompt = mode === 'plan'
    ? buildInboxTriagePlanPrompt(item, { attachmentAnalysis: analysis })
    // Пояснение оператора существует только у ручного пути: разбивать карточку
    // на поводы человек в этот момент уже не просит, он ставит одну задачу.
    : buildInboxTriagePrompt(item, { attachmentAnalysis: analysis, operatorNote, decided });
  let output: { reply?: unknown } | undefined;

  try {
    output = await executor.runUntrusted?.({
      config,
      message: `${prompt.system}\n\n${prompt.user}`,
      model,
      effort: target.effort || undefined,
      images,
      providerSettings: (providerSettings as Record<string, unknown>)?.[provider] || {},
      log,
      signal,
    });
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;

    if (['attachment_media_limit', 'invalid_attachment_media', 'unsupported_media']
      .includes(String(code))) {
      return { ok: false, error: String(code) };
    }

    return { ok: false, error: 'run_failed' };
  }

  const reply = text(output?.reply);

  if (!reply) return { ok: false, error: 'empty_reply' };

  const result: InboxTriageRun = { ok: true, model: `${provider}/${model}` };

  if (mode === 'plan') {
    result.plan = parseInboxTriagePlan(reply, {
      messageCount: (prompt as { messageCount?: number }).messageCount || 0,
    });
  } else {
    result.verdict = parseInboxTriageVerdict(reply);
  }

  return result;
}

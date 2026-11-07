// Локальная подготовка содержимого вложений для Inbox.
//
// Непрозрачные идентификаторы провайдера участвуют только во входе SHA-256. В
// результат, JSON-кэш и имена
// файлов они не попадают: наружу выходят лишь производный текст, безопасные пути
// локальных визуальных артефактов и человекочитаемые статусы.

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';

import { sha256 } from '../../../../shared/node/hash.ts';

import { skipReasonText } from './skipReason.ts';

type Payload = Record<string, unknown>;
type Scalar = string | number | boolean | null;

// Вложение так, как его видит подготовка: подпись, род и байты. Нативных адресов
// провайдера здесь нет — канал уже отдал файл, и дальше он живёт локальным артефактом.
interface PreparedFile {
  index?: number;
  kind?: unknown;
  displayLabel?: unknown;
  name?: unknown;
  buffer: Buffer;
}

interface SkippedFile {
  index?: number;
  kind?: unknown;
  displayLabel?: unknown;
  name?: unknown;
  reason?: unknown;
  sizeBytes?: number | null;
  limitBytes?: number | null;
}

interface PreparedAttachments {
  files: PreparedFile[];
  skipped: SkippedFile[];
}

interface EntryBase {
  index: number;
  kind: string;
  displayLabel: string;
  name: string;
}

// Одно вложение после разбора. `complete` отдельно от `status`: файл мог быть
// прочитан частично, и тогда карточка обязана сказать об этом человеку.
interface AnalysisEntry extends EntryBase {
  status: string;
  complete: boolean;
  text: string;
  reason: string | null;
  visualFiles: (string | VisualArtifact)[];
}

// Кадр или изображение по дороге в кэш: сначала это временный файл рядом с
// исходником, после публикации — имя артефакта в каталоге ключа.
interface VisualArtifact {
  path: string;
  ext: string;
}

// Один идущий разбор. Он общий для всех, кто попросил тот же ключ: второй
// потребитель присоединяется к первому, а отмена срабатывает, когда ушли все.
interface OperationRecord {
  key: string;
  controller: AbortController;
  consumers: number;
  settled: boolean;
  promise: Promise<InboxAttachmentAnalysisResult>;
  timer: ReturnType<typeof setTimeout>;
}

interface CacheRecord {
  key: string;
  bytes: number;
  mtimeMs: number;
  protected: boolean;
}

// То, что читают подписи вложения: род, заголовок и имя файла. Форма нарочно
// узкая — и подготовленный файл, и отказ канала, и ожидаемое вложение подходят.
type LabelledAttachment = {
  kind?: unknown;
  displayLabel?: unknown;
  name?: unknown;
} | null | undefined;

interface PublicAnalysisEntry extends EntryBase {
  status: string;
  complete: boolean;
  text: string;
  visualPaths: string[];
  reason: string | null;
}

export interface InboxAttachmentAnalysisResult {
  ok: boolean;
  complete: boolean;
  key: string;
  text: string;
  visualPaths: string[];
  entries: PublicAnalysisEntry[];
  release?: () => Promise<void>;
}

interface ImageInfo {
  ext: string;
  width: number;
  height: number;
  pixels: number;
}

// Слот подготовленного вложения: файл, отказ канала или дыра. Позиция обязана
// совпасть с ожидаемой — иначе разбор приписал бы текст одного файла другому.
interface PreparedSlot {
  type: string;
  value: PreparedFile | SkippedFile | null;
  index: number;
}

type LogPort = {
  info?: (details: unknown, message: string) => void;
  warn?: (details: unknown, message: string) => void;
  error?: (details: unknown, message: string) => void;
};

// Версия ПРАВИЛ разбора, а не формата записи: она входит и в fingerprint ключа,
// и в проверку чтения, поэтому смена алгоритма производных артефактов обязана
// её поднимать. Иначе уже разобранное вложение навсегда останется с результатом
// прежнего алгоритма — так один кадр скринкаста пережил бы починку выборки кадров.
// 2 — кадры видео берутся по всей длительности, а не только по сменам сцены.
const SCHEMA = 2;
const MAX_FILES = 12;
const MAX_BYTES = 80 * 1024 * 1024;
const MAX_TEXT_DOCUMENT_BYTES = 256 * 1024;
// Причина неразбора показывается человеку строкой в карточке: длинная сюда не
// влезет, а короткая обязана остаться читаемой фразой, а не кодом.
const MAX_REASON_CHARS = 240;
const MAX_ENTRY_TEXT_CHARS = 80_000;
const MAX_RESULT_TEXT_CHARS = 200_000;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_VISUAL_BYTES = 20 * 1024 * 1024;
const MAX_VISUAL_SIDE = 16_384;
const MAX_VISUAL_PIXELS = 40_000_000;
const DEFAULT_MAX_FRAMES = 4;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_CACHE_MAX_BYTES = 512 * 1024 * 1024;
const DEFAULT_TMP_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_GC_INTERVAL_MS = 5 * 60 * 1000;
const MAX_LIFECYCLE_MS = 365 * 24 * 60 * 60 * 1000;

const HASH_RE = /^[a-f0-9]{64}$/u;
const BUCKET_RE = /^[a-f0-9]{2}$/u;
const VISUAL_FILE_RE = /^[a-f0-9]{64}\.(?:bmp|gif|jpg|png|webp)$/u;
const ATOMIC_TEMP_RE = /^\.([a-f0-9]{64})\..+\.tmp$/u;
const WORK_TEMP_RE = /^([a-f0-9]{16})-/u;
const IMAGE_EXTENSIONS = new Set(['.bmp', '.gif', '.jpeg', '.jpg', '.png', '.webp']);
const TEXT_EXTENSIONS = new Set([
  '.csv', '.json', '.log', '.markdown', '.md', '.txt', '.xml', '.yaml', '.yml',
]);

// Чужая ошибка своего типа не обещает: код читается мягко, а решение по нему
// принимается уже своё.
const errorCode = (err: unknown) => (err as { code?: unknown } | null)?.code;

function scalar(value: unknown): Scalar {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return value === null ? null : '';
}

function itemAttachments(item: Payload | undefined): Payload[] {
  if (Array.isArray(item?.attachments) && item.attachments.length) {
    return item.attachments as Payload[];
  }

  const seen = new Set<unknown>();
  const attachments: Payload[] = [];

  for (const message of (Array.isArray(item?.messages) ? item.messages : []) as Payload[]) {
    const own = Array.isArray(message?.attachments) ? message.attachments as Payload[] : [];

    for (const attachment of own) {
      const identity = attachment?.dedupeKey || attachment?.ref;
      const key = typeof identity === 'string' && identity ? identity : Symbol('attachment');
      if (seen.has(key)) continue;
      seen.add(key);
      attachments.push(attachment);
    }
  }
  return attachments;
}

function fingerprintOf(item: Payload | undefined, revision: unknown, maxFrames: number): string {
  const attachments = itemAttachments(item).map((attachment) => ({
    ref: scalar(attachment?.ref),
    dedupeKey: scalar(attachment?.dedupeKey),
    kind: scalar(attachment?.kind),
    name: scalar(attachment?.name),
    size: scalar(attachment?.size),
    messageId: scalar(attachment?.messageId),
    groupId: scalar(attachment?.groupId),
  }));
  const messages = ((Array.isArray(item?.messages) ? item.messages : []) as Payload[])
    .map((message) => ({
      id: scalar(message?.id),
      messageRef: scalar(message?.messageRef),
      editedAt: scalar(message?.editedAt),
      occurredAt: scalar(message?.occurredAt),
    }));
  return sha256(JSON.stringify({
    schema: SCHEMA,
    revision,
    maxFrames,
    channel: scalar(item?.channel),
    accountRef: scalar(item?.accountRef),
    itemRef: scalar(item?.ref),
    itemRevision: scalar(item?.revision),
    messages,
    attachments,
  }));
}

function publicText(value: unknown, fallback = '', limit = 256): string {
  const text = typeof value === 'string' ? value : '';
  const cleaned = text
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return (cleaned || fallback).slice(0, limit);
}

function normalizedKind(value: unknown): string {
  return publicText(value, 'attachment', 80).toLowerCase();
}

function sanitizeFileName(value: unknown, fallback: string): string {
  const basename = path.basename(String(value || '').replace(/\\/gu, '/')).normalize('NFKC');
  const safe = basename
    .replace(/[^a-zA-Z0-9._-]+/gu, '_')
    .replace(/^\.+/u, '')
    .replace(/\.{2,}/gu, '.')
    .slice(0, 96);
  if (!safe || safe === '.' || safe === '..') return fallback;
  return safe;
}

function extensionOf(name: unknown): string {
  const ext = path.extname(String(name || '')).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/u.test(ext) ? ext : '';
}

function sourceExtension(kind: string, name: unknown): string {
  const ext = extensionOf(name);
  if (ext) return ext;
  if (kind === 'voice') return '.ogg';
  if (kind === 'audio') return '.audio';
  if (kind === 'video' || kind === 'video_note') return '.mp4';
  if (kind === 'image' || kind === 'photo') return '.jpg';
  return '.bin';
}

function detectedImageExtension(buffer: Buffer): string {
  if (buffer.length >= 8
      && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return '.png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return '.jpg';
  }
  const head = buffer.subarray(0, 12).toString('ascii');
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return '.gif';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return '.webp';
  if (head.startsWith('BM')) return '.bmp';
  return '';
}

function jpegDimensions(buffer: Buffer): { width: number; height: number } | null {
  let offset = 2;
  const sizeMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  while (offset + 8 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    if (marker === 0xda) return null;
    if (offset + 3 >= buffer.length) return null;
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > buffer.length) return null;
    if (sizeMarkers.has(Number(marker)) && length >= 7) {
      return {
        width: buffer.readUInt16BE(offset + 7),
        height: buffer.readUInt16BE(offset + 5),
      };
    }
    offset += 2 + length;
  }
  return null;
}

function webpDimensions(buffer: Buffer): { width: number; height: number } | null {
  const chunk = buffer.subarray(12, 16).toString('ascii');
  if (chunk === 'VP8X' && buffer.length >= 30) {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3),
    };
  }
  if (chunk === 'VP8L' && buffer.length >= 25 && buffer[20] === 0x2f) {
    const bits = buffer.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
  }
  if (chunk === 'VP8 ' && buffer.length >= 30
      && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }
  return null;
}

function imageDimensions(
  buffer: Buffer,
  ext: string,
): { width: number; height: number } | null {
  if (ext === '.png' && buffer.length >= 24
      && buffer.subarray(12, 16).toString('ascii') === 'IHDR'
      && buffer.includes(Buffer.from('IDAT', 'ascii'))
      && buffer.subarray(-8, -4).toString('ascii') === 'IEND') {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (ext === '.gif' && buffer.length >= 14 && buffer.at(-1) === 0x3b) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (ext === '.bmp' && buffer.length >= 26
      && buffer.readUInt32LE(10) < buffer.length) {
    return { width: Math.abs(buffer.readInt32LE(18)), height: Math.abs(buffer.readInt32LE(22)) };
  }
  if (ext === '.jpg' && buffer.length >= 4
      && buffer.at(-2) === 0xff && buffer.at(-1) === 0xd9) return jpegDimensions(buffer);
  if (ext === '.webp' && buffer.length >= 20
      && buffer.readUInt32LE(4) + 8 === buffer.length) return webpDimensions(buffer);
  return null;
}

function safeImageInfo(buffer: Buffer): ImageInfo | null {
  const ext = detectedImageExtension(buffer);
  const dimensions = imageDimensions(buffer, ext);
  if (!dimensions || !Number.isSafeInteger(dimensions.width)
      || !Number.isSafeInteger(dimensions.height)
      || dimensions.width < 1 || dimensions.height < 1
      || dimensions.width > MAX_VISUAL_SIDE || dimensions.height > MAX_VISUAL_SIDE
      || dimensions.width * dimensions.height > MAX_VISUAL_PIXELS) {
    return null;
  }
  return { ext, ...dimensions, pixels: dimensions.width * dimensions.height };
}

function safeImageExtension(buffer: Buffer): string {
  return safeImageInfo(buffer)?.ext || '';
}

function visualExtension(file: PreparedFile): string {
  return safeImageExtension(file.buffer);
}

function isImageKind(kind: string): boolean {
  return kind === 'image' || kind === 'photo';
}

function isImageLike(kind: string, file: PreparedFile): boolean {
  return (isImageKind(kind) || kind === 'document' || kind === 'sticker')
    && Boolean(visualExtension(file));
}

function isTextDocument(kind: string, name: unknown): boolean {
  return kind === 'document' && TEXT_EXTENSIONS.has(extensionOf(name));
}

function abortError(): Error {
  const error = Object.assign(new Error('Операция отменена.'), { code: 'ABORT_ERR' });

  error.name = 'AbortError';

  return error;
}

function timeoutError(): Error {
  const error = Object.assign(new Error('Разбор вложений превысил безопасный лимит времени.'), {
    code: 'attachment_analysis_timeout',
  });

  error.name = 'TimeoutError';

  return error;
}

function throwIfAborted(signal: AbortSignal | null | undefined): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError();
}

async function awaitWithSignal<Result>(
  operation: Promise<Result> | Result,
  signal: AbortSignal | null | undefined,
): Promise<Result> {
  throwIfAborted(signal);

  const work = Promise.resolve(operation);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((resolve, reject) => {
    onAbort = () => reject(signal?.reason instanceof Error ? signal.reason : abortError());
    signal?.addEventListener('abort', onAbort, { once: true });
  });

  try {
    return await Promise.race([work, aborted]);
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    work.catch(() => {});
  }
}

function isAbort(error: unknown, signal: AbortSignal | null | undefined): boolean {
  const failure = error as { name?: unknown; code?: unknown } | null;

  return Boolean(signal?.aborted || failure?.name === 'AbortError' || failure?.code === 'ABORT_ERR');
}

function isNoAudio(error: unknown): boolean {
  const failure = error as { code?: unknown; message?: unknown } | null;
  const code = String(failure?.code || '').toLowerCase();
  const message = String(failure?.message || '');
  return code === 'no_audio' || code === 'media_no_audio'
    || /(?:нет|отсутствует) аудио|no audio/iu.test(message);
}

function transcriptText(source: unknown): string {
  if (typeof source === 'string') return source.trim();
  if (!source || typeof source !== 'object') return '';

  const value = source as {
    text?: unknown;
    segments?: unknown;
    transcript?: { text?: unknown; segments?: unknown } | string;
  };

  if (typeof value.text === 'string') return value.text.trim();
  if (typeof value.transcript === 'string') return value.transcript.trim();
  if (typeof (value.transcript as { text?: unknown })?.text === 'string') {
    return String((value.transcript as { text?: unknown }).text).trim();
  }

  const nested = value.transcript as { segments?: unknown } | undefined;
  const segments = (Array.isArray(nested?.segments)
    ? nested.segments
    : Array.isArray(value.segments) ? value.segments : []) as { text?: unknown }[];

  return segments
    .map((segment) => (typeof segment?.text === 'string' ? segment.text.trim() : ''))
    .filter(Boolean)
    .join(' ')
    .trim();
}

function boundedDerivedText(value: unknown): { text: string; truncated: boolean } {
  const text = String(value || '').replace(/\r\n?/gu, '\n').trim();
  if (text.length <= MAX_ENTRY_TEXT_CHARS) return { text, truncated: false };
  return {
    text: `${text.slice(0, MAX_ENTRY_TEXT_CHARS - 1).trimEnd()}…`,
    truncated: true,
  };
}

function safeUtf8(buffer: Buffer): { ok: boolean; text: string; reason: string | null } {
  if (buffer.length > MAX_TEXT_DOCUMENT_BYTES) {
    return {
      ok: false,
      text: '',
      reason: `Текстовый документ больше ${MAX_TEXT_DOCUMENT_BYTES / 1024} КБ.`,
    };
  }
  let text: string;

  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return { ok: false, text: '', reason: 'Документ не является корректным UTF-8 текстом.' };
  }
  if (/\u0000/u.test(text) || /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    return { ok: false, text: '', reason: 'Документ содержит бинарные или управляющие данные.' };
  }
  const bounded = boundedDerivedText(text.replace(/^\uFEFF/u, ''));
  return {
    ok: true,
    text: bounded.text,
    reason: bounded.truncated ? 'Текст сокращён до безопасного лимита.' : null,
  };
}

function entryBase(file: LabelledAttachment, index: number): EntryBase {
  const kind = normalizedKind(file?.kind);
  const sourceName = String(file?.name || '').replace(/\\/gu, '/');
  const basename = path.basename(sourceName);
  return {
    index,
    kind,
    displayLabel: publicText(file?.displayLabel, 'вложение', 160),
    name: basename === '.' || basename === '..' ? '' : publicText(basename, '', 256),
  };
}

function comparableName(value: unknown): string {
  const source = String(value || '').replace(/\\/gu, '/');
  return publicText(path.basename(source), '', 256).toLowerCase();
}

function matchesExpected(file: LabelledAttachment, expected: LabelledAttachment): boolean {
  if (normalizedKind(file?.kind) !== normalizedKind(expected?.kind)) return false;
  if (publicText(file?.displayLabel, 'вложение', 160)
      !== publicText(expected?.displayLabel, 'вложение', 160)) return false;
  const wanted = comparableName(expected?.name);
  const actual = comparableName(file?.name);
  if (!wanted) return true;
  if (actual === wanted) return true;
  return !extensionOf(wanted) && actual.startsWith(`${wanted}.`);
}

function positionPrepared(
  expected: Payload[],
  prepared: PreparedAttachments,
): PreparedSlot[] | null {
  const slots: (PreparedSlot | null)[] = Array.from({ length: expected.length }, () => null);
  const put = (value: PreparedFile | SkippedFile, type: string) => {
    const index = value?.index;

    if (!Number.isSafeInteger(index)
        || Number(index) < 0 || Number(index) >= expected.length || slots[Number(index)]) {
      return false;
    }
    if (type === 'file' && !matchesExpected(value, expected[Number(index)])) return false;
    slots[Number(index)] = { type, value, index: Number(index) };

    return true;
  };
  if (!prepared.files.every((value) => put(value, 'file'))
      || !prepared.skipped.every((value) => put(value, 'skipped'))) {
    return null;
  }
  return slots.map((slot, index) => slot || { type: 'missing', value: null, index });
}

function entry(base: EntryBase, {
  status,
  complete,
  text = '',
  reason = null,
  visualFiles = [],
}: {
  status?: string;
  complete?: boolean;
  text?: string;
  reason?: string | null;
  visualFiles?: (string | VisualArtifact)[];
} = {}): AnalysisEntry {
  return {
    ...base,
    status: String(status),
    complete: Boolean(complete),
    text,
    reason,
    visualFiles,
  };
}

function resultEntry(
  value: AnalysisEntry,
  visualPathOf: (file: string) => string,
): PublicAnalysisEntry {
  return {
    index: value.index,
    kind: value.kind,
    displayLabel: value.displayLabel,
    name: value.name,
    status: value.status,
    complete: value.complete,
    text: value.text,
    visualPaths: value.visualFiles.map((file) => visualPathOf(file as string)),
    reason: value.reason,
  };
}

function aggregateText(entries: AnalysisEntry[]): string {
  const sections = entries
    .filter((value) => value.text)
    .map((value) => {
      const label = [value.displayLabel, value.name].filter(Boolean).join(' · ');
      return `── ${label || 'Вложение'} ──\n${value.text}`;
    });
  const text = sections.join('\n\n');
  if (text.length <= MAX_RESULT_TEXT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_TEXT_CHARS - 1).trimEnd()}…`;
}

function publicResult(key: string, { ok, complete, text, entries }: {
  ok: boolean;
  complete: boolean;
  text: string;
  entries: AnalysisEntry[];
}, visualPathOf: (file: string) => string): InboxAttachmentAnalysisResult {
  const publicEntries = entries.map((value) => resultEntry(value, visualPathOf));
  return {
    ok,
    complete,
    key,
    text,
    visualPaths: publicEntries.flatMap((value) => value.visualPaths),
    entries: publicEntries,
  };
}

function cloneResult(value: InboxAttachmentAnalysisResult): InboxAttachmentAnalysisResult {
  return {
    ...value,
    visualPaths: [...value.visualPaths],
    entries: value.entries.map((entryValue) => ({
      ...entryValue,
      visualPaths: [...entryValue.visualPaths],
    })),
  };
}

function limitResult(key: string, reason: string): InboxAttachmentAnalysisResult {
  return {
    ok: false,
    complete: false,
    key,
    text: '',
    visualPaths: [],
    entries: [{
      index: 0,
      kind: 'batch',
      displayLabel: 'вложения',
      name: '',
      status: 'error',
      complete: false,
      text: '',
      visualPaths: [],
      reason,
    }],
  };
}

function validateCacheEntry(source: unknown): AnalysisEntry | null {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;

  const value = source as Payload;
  const visualFiles = Array.isArray(value.visualFiles) ? value.visualFiles as string[] : null;

  if (!Number.isSafeInteger(value.index) || Number(value.index) < 0 || Number(value.index) >= MAX_FILES
      || typeof value.kind !== 'string' || typeof value.displayLabel !== 'string'
      || typeof value.name !== 'string' || value.status !== 'ready' || value.complete !== true
      || typeof value.text !== 'string' || value.text.length > MAX_ENTRY_TEXT_CHARS
      || (value.reason !== null && typeof value.reason !== 'string')
      || !visualFiles || visualFiles.some((file) => !VISUAL_FILE_RE.test(file))) {
    return null;
  }
  return {
    index: value.index as number,
    kind: value.kind as string,
    displayLabel: value.displayLabel as string,
    name: value.name as string,
    status: 'ready',
    complete: true,
    text: value.text as string,
    reason: value.reason as string | null,
    visualFiles: [...visualFiles],
  };
}

export const INBOX_ATTACHMENT_ANALYSIS_LIMITS = Object.freeze({
  files: MAX_FILES,
  bytes: MAX_BYTES,
  textDocumentBytes: MAX_TEXT_DOCUMENT_BYTES,
  frames: DEFAULT_MAX_FRAMES,
  cacheTtlMs: DEFAULT_CACHE_TTL_MS,
  cacheMaxBytes: DEFAULT_CACHE_MAX_BYTES,
  tmpTtlMs: DEFAULT_TMP_TTL_MS,
  gcIntervalMs: DEFAULT_GC_INTERVAL_MS,
});

export class InboxAttachmentAnalyzer {
  cacheDir: string;

  transcribe: ((options: Payload) => Promise<unknown>) | null;

  extractFrames: ((options: Payload) => Promise<unknown>) | null;

  maxFrames: number;

  revision: string | (() => string);

  timeoutMs: number;

  cacheTtlMs: number;

  cacheMaxBytes: number;

  tmpTtlMs: number;

  gcIntervalMs: number;

  now: () => number;

  inFlight: Map<string, OperationRecord>;

  activeKeys: Map<string, number>;

  resultLeases: Map<string, number>;

  cacheEntries: Map<string, number>;

  cacheBytes: number | null;

  lastGcAt: number | null;

  analysisTail: Promise<unknown>;

  gcTail: Promise<unknown>;

  constructor({
    cacheDir,
    transcribe = null,
    extractFrames = null,
    maxFrames = DEFAULT_MAX_FRAMES,
    revision = 'v1',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
    cacheMaxBytes = DEFAULT_CACHE_MAX_BYTES,
    tmpTtlMs = DEFAULT_TMP_TTL_MS,
    gcIntervalMs = DEFAULT_GC_INTERVAL_MS,
    now = Date.now,
  }: {
    cacheDir?: string;
    transcribe?: ((options: Payload) => Promise<unknown>) | null;
    extractFrames?: ((options: Payload) => Promise<unknown>) | null;
    maxFrames?: number;
    revision?: string | (() => string);
    timeoutMs?: number;
    cacheTtlMs?: number;
    cacheMaxBytes?: number;
    tmpTtlMs?: number;
    gcIntervalMs?: number;
    now?: () => number;
  } = {}) {
    if (!path.isAbsolute(cacheDir || '')) {
      throw new TypeError('cacheDir анализатора вложений должен быть абсолютным.');
    }
    if (transcribe !== null && typeof transcribe !== 'function') {
      throw new TypeError('transcribe должен быть функцией или null.');
    }
    if (extractFrames !== null && typeof extractFrames !== 'function') {
      throw new TypeError('extractFrames должен быть функцией или null.');
    }
    if (!Number.isSafeInteger(maxFrames) || maxFrames < 1 || maxFrames > 8) {
      throw new TypeError('maxFrames должен быть целым числом 1..8.');
    }
    if (typeof revision !== 'function'
        && (typeof revision !== 'string' || !revision.trim())) {
      throw new TypeError('revision анализатора должен быть непустой строкой или функцией.');
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_TIMEOUT_MS) {
      throw new TypeError(`timeoutMs должен быть целым числом 100..${MAX_TIMEOUT_MS}.`);
    }
    if (!Number.isSafeInteger(cacheTtlMs)
        || cacheTtlMs < 1_000 || cacheTtlMs > MAX_LIFECYCLE_MS) {
      throw new TypeError(`cacheTtlMs должен быть целым числом 1000..${MAX_LIFECYCLE_MS}.`);
    }
    if (!Number.isSafeInteger(tmpTtlMs)
        || tmpTtlMs < 1_000 || tmpTtlMs > MAX_LIFECYCLE_MS) {
      throw new TypeError(`tmpTtlMs должен быть целым числом 1000..${MAX_LIFECYCLE_MS}.`);
    }
    if (!Number.isSafeInteger(gcIntervalMs)
        || gcIntervalMs < 1_000 || gcIntervalMs > MAX_LIFECYCLE_MS) {
      throw new TypeError(`gcIntervalMs должен быть целым числом 1000..${MAX_LIFECYCLE_MS}.`);
    }
    if (!Number.isSafeInteger(cacheMaxBytes) || cacheMaxBytes < 1) {
      throw new TypeError('cacheMaxBytes должен быть положительным целым числом.');
    }
    if (typeof now !== 'function') throw new TypeError('now должен быть функцией.');
    this.cacheDir = path.normalize(cacheDir as string);
    this.transcribe = transcribe;
    this.extractFrames = extractFrames;
    this.maxFrames = maxFrames;
    this.revision = typeof revision === 'string' ? revision.trim() : revision;
    this.timeoutMs = timeoutMs;
    this.cacheTtlMs = cacheTtlMs;
    this.cacheMaxBytes = cacheMaxBytes;
    this.tmpTtlMs = tmpTtlMs;
    this.gcIntervalMs = gcIntervalMs;
    this.now = now;
    this.inFlight = new Map();
    this.activeKeys = new Map();
    this.resultLeases = new Map();
    this.cacheEntries = new Map();
    this.cacheBytes = null;
    this.lastGcAt = null;
    this.analysisTail = Promise.resolve();
    this.gcTail = Promise.resolve();
  }

  _revisionHash(): string {
    const raw = typeof this.revision === 'function' ? this.revision() : this.revision;
    if (typeof raw !== 'string' || !raw.trim()
        || Buffer.byteLength(raw, 'utf8') > 1024 * 1024) {
      throw new TypeError('Текущая revision анализа должна быть строкой до 1 МБ.');
    }
    return sha256(raw);
  }

  _bucket(key: string): string {
    if (!HASH_RE.test(key)) throw new TypeError('Некорректный hash-key анализа вложений.');
    return path.join(this.cacheDir, key.slice(0, 2));
  }

  _cacheFile(key: string): string {
    return path.join(this._bucket(key), `${key}.json`);
  }

  _visualDir(key: string): string {
    return path.join(this._visualRoot(key), 'visual');
  }

  _visualRoot(key: string): string {
    return path.join(this._bucket(key), key);
  }

  _visualPath(key: string, file: string): string {
    if (!VISUAL_FILE_RE.test(file)) throw new TypeError('Некорректное имя visual artifact.');
    return path.join(this._visualDir(key), file);
  }

  _currentTime(): number {
    const value = this.now();
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError('now() анализатора должен возвращать timestamp в миллисекундах.');
    }
    return value;
  }

  _cachePath(candidate: string, { allowRoot = false }: { allowRoot?: boolean } = {}): string {
    const resolved = path.resolve(candidate);
    const relative = path.relative(this.cacheDir, resolved);
    if ((!allowRoot && !relative)
        || relative.startsWith(`..${path.sep}`) || relative === '..'
        || path.isAbsolute(relative)) {
      throw new TypeError('Путь кэша вышел за пределы каталога анализатора.');
    }
    return resolved;
  }

  _protectedKeys(currentKey: string | null = null): Set<string> {
    const protectedKeys = new Set([
      ...this.inFlight.keys(),
      ...this.activeKeys.keys(),
      ...this.resultLeases.keys(),
    ]);
    if (currentKey) protectedKeys.add(currentKey);
    return protectedKeys;
  }

  _markActive(key: string): void {
    this.activeKeys.set(key, (this.activeKeys.get(key) || 0) + 1);
  }

  _unmarkActive(key: string): void {
    const count = this.activeKeys.get(key) || 0;
    if (count <= 1) this.activeKeys.delete(key);
    else this.activeKeys.set(key, count - 1);
  }

  _markResultLease(key: string): void {
    this.resultLeases.set(key, (this.resultLeases.get(key) || 0) + 1);
  }

  _unmarkResultLease(key: string): void {
    const count = this.resultLeases.get(key) || 0;
    if (count <= 1) this.resultLeases.delete(key);
    else this.resultLeases.set(key, count - 1);
  }

  _leasedClone(
    value: InboxAttachmentAnalysisResult,
    key: string,
  ): InboxAttachmentAnalysisResult {
    const cloned = cloneResult(value);
    if (!cloned.visualPaths.length) return cloned;

    // Lease берётся синхронно до resolve consumer promise: между снятием
    // inFlight-защиты и передачей visualPaths вызывающему коду нет окна для GC.
    this._markResultLease(key);

    let releasePromise: Promise<void> | null = null;
    Object.defineProperty(cloned, 'release', {
      enumerable: false,
      configurable: false,
      writable: false,
      value: () => {
        if (!releasePromise) {
          this._unmarkResultLease(key);
          releasePromise = this._maybeGarbageCollect().catch(() => {});
        }
        return releasePromise;
      },
    });
    return cloned;
  }

  async _pathStat(candidate: string): Promise<Stats | null> {
    const safe = this._cachePath(candidate, { allowRoot: true });

    try {
      return await fs.lstat(safe);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    }
  }

  async _ensureBase(): Promise<void> {
    await fs.mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.cacheDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('Каталог кэша анализатора не должен быть симлинком.');
    }
    await fs.chmod(this.cacheDir, 0o700).catch(() => {});
  }

  async _ensureCacheDirectory(candidate: string): Promise<void> {
    const target = this._cachePath(candidate, { allowRoot: true });
    await this._ensureBase();
    const relative = path.relative(this.cacheDir, target);
    let current = this.cacheDir;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try {
        await fs.mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
      }
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error('Путь кэша анализатора содержит симлинк или не-каталог.');
      }
    }
  }

  async _isSafeDirectory(candidate: string): Promise<boolean> {
    const target = this._cachePath(candidate, { allowRoot: true });
    const rootStat = await this._pathStat(this.cacheDir);
    if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) return false;
    const relative = path.relative(this.cacheDir, target);
    let current = this.cacheDir;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      const stat = await this._pathStat(current);
      if (!stat?.isDirectory() || stat.isSymbolicLink()) return false;
    }
    return true;
  }

  async _removeCachePath(candidate: string): Promise<boolean> {
    const target = this._cachePath(candidate);
    if (!await this._isSafeDirectory(path.dirname(target))) return false;
    const stat = await this._pathStat(target);
    if (!stat) return true;
    try {
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        await fs.rm(target, { recursive: true, force: true });
      } else {
        await fs.unlink(target);
      }
      return true;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return true;

      return false;
    }
  }

  async _removeCacheEntry(key: string): Promise<boolean> {
    const removedVisuals = await this._removeCachePath(this._visualRoot(key));
    const removedRecord = await this._removeCachePath(this._cacheFile(key));
    return removedVisuals && removedRecord;
  }

  async _visualRootInfo(
    key: string,
  ): Promise<{ exists: boolean; safe: boolean; bytes: number }> {
    const root = this._visualRoot(key);
    const rootStat = await this._pathStat(root);
    if (!rootStat) return { exists: false, safe: true, bytes: 0 };
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      return { exists: true, safe: false, bytes: rootStat.size || 0 };
    }
    let rootEntries: string[];

    try {
      rootEntries = await fs.readdir(root);
    } catch {
      return { exists: true, safe: false, bytes: 0 };
    }
    if (rootEntries.some((name) => name !== 'visual')) {
      return { exists: true, safe: false, bytes: 0 };
    }
    if (!rootEntries.length) return { exists: true, safe: true, bytes: 0 };
    const visualDir = this._visualDir(key);
    if (!await this._isSafeDirectory(visualDir)) {
      return { exists: true, safe: false, bytes: 0 };
    }
    let names: string[];

    try {
      names = await fs.readdir(visualDir);
    } catch {
      return { exists: true, safe: false, bytes: 0 };
    }
    let bytes = 0;
    for (const name of names) {
      if (!VISUAL_FILE_RE.test(name)) return { exists: true, safe: false, bytes };
      const stat = await this._pathStat(path.join(visualDir, name));
      if (!stat?.isFile() || stat.isSymbolicLink() || stat.size <= 0
          || stat.size > MAX_VISUAL_BYTES) {
        return { exists: true, safe: false, bytes };
      }
      bytes += stat.size;
    }
    return { exists: true, safe: true, bytes };
  }

  async _cleanupTemp(now: number, protectedKeys: Set<string>): Promise<void> {
    const tempRoot = path.join(this.cacheDir, '.tmp');
    const rootStat = await this._pathStat(tempRoot);
    if (!rootStat) return;
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      await this._removeCachePath(tempRoot);
      return;
    }
    const protectedPrefixes = new Set([...protectedKeys].map((key) => key.slice(0, 16)));
    let names: string[];

    try {
      names = await fs.readdir(tempRoot);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      const prefix = WORK_TEMP_RE.exec(name)?.[1] || null;
      if (prefix && protectedPrefixes.has(prefix)) continue;
      const candidate = path.join(tempRoot, name);
      const stat = await this._pathStat(candidate);
      if (stat && now - stat.mtimeMs > this.tmpTtlMs) {
        await this._removeCachePath(candidate);
      }
    }
  }

  async _scanBucket(
    bucketName: string,
    now: number,
    protectedKeys: Set<string>,
  ): Promise<CacheRecord[]> {
    const bucket = path.join(this.cacheDir, bucketName);
    const bucketStat = await this._pathStat(bucket);
    const protectsBucket = [...protectedKeys].some((key) => key.startsWith(bucketName));
    if (!bucketStat?.isDirectory() || bucketStat.isSymbolicLink()) {
      if (bucketStat && !protectsBucket) await this._removeCachePath(bucket);
      return [];
    }
    let names: string[];

    try {
      names = await fs.readdir(bucket);
    } catch {
      return [];
    }

    const jsonStats = new Map<string, Stats>();
    const visualKeys = new Set<string>();
    for (const name of names.sort()) {
      const jsonMatch = /^([a-f0-9]{64})\.json$/u.exec(name);

      if (jsonMatch && String(jsonMatch[1]).startsWith(bucketName)) {
        const stat = await this._pathStat(path.join(bucket, name));

        if (stat) jsonStats.set(String(jsonMatch[1]), stat);
        continue;
      }
      if (HASH_RE.test(name) && name.startsWith(bucketName)) {
        visualKeys.add(name);
        continue;
      }
      const tempKey = ATOMIC_TEMP_RE.exec(name)?.[1] || null;
      if (tempKey && tempKey.startsWith(bucketName) && !protectedKeys.has(tempKey)) {
        const candidate = path.join(bucket, name);
        const stat = await this._pathStat(candidate);
        if (stat && now - stat.mtimeMs > this.tmpTtlMs) {
          await this._removeCachePath(candidate);
        }
      }
    }

    const records: CacheRecord[] = [];
    const keys = [...new Set([...jsonStats.keys(), ...visualKeys])].sort();
    for (const key of keys) {
      const stat = jsonStats.get(key) || null;
      const visuals = await this._visualRootInfo(key);
      const protectedEntry = protectedKeys.has(key);
      const validRecord = stat?.isFile() && !stat.isSymbolicLink()
        && stat.size > 0 && stat.size <= MAX_CACHE_BYTES;
      if (!validRecord || !visuals.safe || (!stat && visuals.exists)) {
        if (!protectedEntry) await this._removeCacheEntry(key);
        continue;
      }
      records.push({
        key,
        bytes: (stat as Stats).size + visuals.bytes,
        mtimeMs: (stat as Stats).mtimeMs,
        protected: protectedEntry,
      });
    }
    return records;
  }

  _serializeCacheLifecycle<Result>(job: () => Promise<Result>): Promise<Result> {
    const operation = this.gcTail.then(job, job);
    this.gcTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async _maybeGarbageCollectNow(currentKey: string | null = null): Promise<void> {
    const now = this._currentTime();
    const protectedKeys = this._protectedKeys(currentKey);
    const quotaDue = this.cacheBytes !== null && this.cacheBytes > this.cacheMaxBytes
      && [...this.cacheEntries.keys()].some((key) => !protectedKeys.has(key));
    const intervalDue = this.lastGcAt === null || now < this.lastGcAt
      || now - this.lastGcAt >= this.gcIntervalMs;
    if (quotaDue || intervalDue) await this._garbageCollectNow(currentKey);
  }

  _maybeGarbageCollect(currentKey: string | null = null): Promise<void> {
    return this._serializeCacheLifecycle(() => this._maybeGarbageCollectNow(currentKey));
  }

  _recordCacheWrite(key: string): Promise<void> {
    return this._serializeCacheLifecycle(async () => {
      const stat = await this._pathStat(this._cacheFile(key));
      const visuals = await this._visualRootInfo(key);
      if (!stat?.isFile() || stat.isSymbolicLink() || !visuals.safe) return;
      if (this.cacheBytes === null) {
        await this._garbageCollectNow(key);
        return;
      }
      const bytes = stat.size + visuals.bytes;
      const previous = this.cacheEntries.get(key) || 0;
      this.cacheEntries.set(key, bytes);
      this.cacheBytes += bytes - previous;
      await this._maybeGarbageCollectNow(key);
    });
  }

  _garbageCollect(currentKey: string | null = null): Promise<void> {
    return this._serializeCacheLifecycle(() => this._garbageCollectNow(currentKey));
  }

  async _garbageCollectNow(currentKey: string | null = null): Promise<void> {
    await this._ensureBase();
    const now = this._currentTime();
    const protectedKeys = this._protectedKeys(currentKey);
    await this._cleanupTemp(now, protectedKeys);
    let rootNames: string[];

    try {
      rootNames = await fs.readdir(this.cacheDir);
    } catch {
      return;
    }

    const bucketNames = rootNames.filter((name) => BUCKET_RE.test(name)).sort();
    const records: CacheRecord[] = [];
    for (const bucketName of bucketNames) {
      records.push(...await this._scanBucket(bucketName, now, protectedKeys));
    }

    let totalBytes = records.reduce((total, record) => total + record.bytes, 0);
    const expired = records
      .filter((record) => !record.protected && now - record.mtimeMs > this.cacheTtlMs)
      .sort((left, right) => left.mtimeMs - right.mtimeMs || left.key.localeCompare(right.key));
    const removed = new Set<string>();
    for (const record of expired) {
      if (await this._removeCacheEntry(record.key)) {
        removed.add(record.key);
        totalBytes -= record.bytes;
      }
    }
    const quotaCandidates = records
      .filter((record) => !record.protected && !removed.has(record.key))
      .sort((left, right) => left.mtimeMs - right.mtimeMs || left.key.localeCompare(right.key));
    for (const record of quotaCandidates) {
      if (totalBytes <= this.cacheMaxBytes) break;
      if (await this._removeCacheEntry(record.key)) {
        removed.add(record.key);
        totalBytes -= record.bytes;
      }
    }
    for (const bucketName of bucketNames) {
      const bucket = path.join(this.cacheDir, bucketName);
      const stat = await this._pathStat(bucket);
      if (!stat?.isDirectory() || stat.isSymbolicLink()) continue;
      await fs.rmdir(bucket).catch(() => {});
    }
    const survivors = records.filter((record) => !removed.has(record.key));
    this.cacheEntries = new Map(survivors.map((record) => [record.key, record.bytes]));
    this.cacheBytes = survivors.reduce((total, record) => total + record.bytes, 0);
    this.lastGcAt = now;
  }

  async _atomicWrite(file: string, bytes: string | Buffer): Promise<void> {
    const dir = path.dirname(file);
    await this._ensureCacheDirectory(dir);
    const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
      await fs.rename(temp, file);
      await fs.chmod(file, 0o600).catch(() => {});
    } finally {
      await fs.unlink(temp).catch(() => {});
    }
  }

  async _readCache(key: string): Promise<InboxAttachmentAnalysisResult | null> {
    const file = this._cacheFile(key);

    if (!await this._isSafeDirectory(this._bucket(key))) return null;

    let stat: Stats;

    try {
      stat = await fs.lstat(file);
    } catch {
      return null;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0
        || stat.size > MAX_CACHE_BYTES
        || this._currentTime() - stat.mtimeMs > this.cacheTtlMs) return null;
    let value: Payload;

    try {
      value = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      return null;
    }
    if (value?.schema !== SCHEMA || value?.key !== key || value?.ok !== true
        || value?.complete !== true || typeof value?.text !== 'string'
        || value.text.length > MAX_RESULT_TEXT_CHARS || !Array.isArray(value?.entries)
        || value.entries.length > MAX_FILES) {
      return null;
    }

    const entries = (value.entries as unknown[]).map(validateCacheEntry);

    if (entries.some((entryValue) => entryValue === null)) return null;

    const ready = entries as AnalysisEntry[];
    const visualFiles = [...new Set(ready.flatMap((entryValue) => entryValue.visualFiles))]
      .map((file) => String(file));
    if (visualFiles.length && !await this._isSafeDirectory(this._visualDir(key))) return null;
    for (const visualFile of visualFiles) {
      try {
        const visualPath = this._visualPath(key, visualFile);
        const visualStat = await fs.lstat(visualPath);
        if (!visualStat.isFile() || visualStat.isSymbolicLink()
            || visualStat.size <= 0 || visualStat.size > MAX_VISUAL_BYTES) return null;
        const bytes = await fs.readFile(visualPath);
        const [expectedHash, expectedExtension] = visualFile.split('.');
        if (sha256(bytes) !== expectedHash
            || visualExtension({ buffer: bytes, name: visualFile }) !== `.${expectedExtension}`) {
          return null;
        }
      } catch {
        return null;
      }
    }
    return publicResult(key, {
      ok: true,
      complete: true,
      text: value.text,
      entries: ready,
    }, (visualFile) => this._visualPath(key, visualFile));
  }

  async _writeCache(key: string, value: {
    text: string;
    entries: AnalysisEntry[];
  }): Promise<void> {
    const record = {
      schema: SCHEMA,
      key,
      ok: true,
      complete: true,
      text: value.text,
      entries: value.entries,
    };
    await this._atomicWrite(this._cacheFile(key), `${JSON.stringify(record, null, 2)}\n`);
    await this._recordCacheWrite(key).catch(() => {});
  }

  async _writeSource(workDir: string, file: PreparedFile, index: number): Promise<string> {
    const kind = normalizedKind(file.kind);
    const fallback = `attachment-${String(index + 1).padStart(2, '0')}${sourceExtension(kind, file.name)}`;
    const safeName = sanitizeFileName(file.name, fallback);
    const source = path.join(workDir, 'input', `${String(index).padStart(2, '0')}-${safeName}`);
    await fs.mkdir(path.dirname(source), { recursive: true, mode: 0o700 });
    await fs.writeFile(source, file.buffer, { flag: 'wx', mode: 0o600 });
    return source;
  }

  async _validatedFrames(paths: unknown, destDir: string): Promise<VisualArtifact[]> {
    if (!Array.isArray(paths)) return [];

    const frames: VisualArtifact[] = [];
    let totalBytes = 0;

    for (const raw of (paths as unknown[]).slice(0, this.maxFrames)) {
      const candidate = typeof raw === 'string' ? raw : (raw as { path?: unknown })?.path;

      if (typeof candidate !== 'string' || !candidate) continue;
      const resolved = path.resolve(candidate);
      const relative = path.relative(path.resolve(destDir), resolved);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
      let stat: Stats;

      try { stat = await fs.lstat(resolved); } catch { continue; }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) continue;
      totalBytes += stat.size;
      if (totalBytes > MAX_VISUAL_BYTES) break;
      const ext = extensionOf(resolved).replace('.jpeg', '.jpg');
      if (!IMAGE_EXTENSIONS.has(extensionOf(resolved))) continue;
      frames.push({ path: resolved, ext });
    }
    return frames;
  }

  async _processAudio(
    file: PreparedFile,
    index: number,
    source: string,
    signal: AbortSignal | null | undefined,
  ): Promise<AnalysisEntry> {
    const base = entryBase(file, index);
    if (!this.transcribe) {
      return entry(base, {
        status: 'unsupported',
        complete: false,
        reason: 'Локальное распознавание речи недоступно.',
      });
    }
    try {
      const raw = await this.transcribe({ filePath: source, signal });
      throwIfAborted(signal);
      const bounded = boundedDerivedText(transcriptText(raw));
      if (!bounded.text) {
        return entry(base, {
          status: 'incomplete',
          complete: false,
          reason: 'Речь во вложении не обнаружена.',
        });
      }
      return entry(base, {
        status: 'ready',
        complete: true,
        text: bounded.text,
        reason: bounded.truncated ? 'Транскрипт сокращён до безопасного лимита.' : null,
      });
    } catch (error) {
      if (isAbort(error, signal)) throw error;
      return entry(base, {
        status: 'error',
        complete: false,
        reason: 'Не удалось локально распознать речь.',
      });
    }
  }

  async _processVideo(
    file: PreparedFile,
    index: number,
    source: string,
    workDir: string,
    signal: AbortSignal | null | undefined,
  ): Promise<AnalysisEntry> {
    const base = entryBase(file, index);
    const frameDir = path.join(workDir, 'frames', String(index).padStart(2, '0'));
    await fs.mkdir(frameDir, { recursive: true, mode: 0o700 });
    const speechPromise = this.transcribe
      ? this.transcribe({ filePath: source, signal })
      : Promise.reject(Object.assign(new Error('speech unavailable'), { code: 'speech_unavailable' }));
    const framesPromise = this.extractFrames
      ? this.extractFrames({
        filePath: source,
        destDir: frameDir,
        maxFrames: this.maxFrames,
        signal,
      })
      : Promise.reject(Object.assign(new Error('frames unavailable'), { code: 'frames_unavailable' }));
    const [speechState, frameState] = await Promise.allSettled([speechPromise, framesPromise]);
    throwIfAborted(signal);
    if ((speechState.status === 'rejected' && isAbort(speechState.reason, signal))
        || (frameState.status === 'rejected' && isAbort(frameState.reason, signal))) {
      throw abortError();
    }

    const frames = frameState.status === 'fulfilled'
      ? await this._validatedFrames(frameState.value, frameDir)
      : [];
    const noAudio = speechState.status === 'rejected' && isNoAudio(speechState.reason);
    const speechFailed = speechState.status === 'rejected' && !noAudio;
    const bounded = speechState.status === 'fulfilled'
      ? boundedDerivedText(transcriptText(speechState.value))
      : { text: '', truncated: false };
    const framesFailed = frameState.status === 'rejected';

    if (!frames.length || speechFailed || framesFailed) {
      let reason = 'Из видео не удалось получить кадры.';
      if (speechFailed && !this.transcribe) reason = 'Локальное распознавание речи недоступно.';
      else if (framesFailed && !this.extractFrames) reason = 'Извлечение кадров недоступно.';
      else if (speechFailed) reason = 'Не удалось локально распознать речь в видео.';
      return entry(base, {
        status: speechFailed || framesFailed ? 'error' : 'incomplete',
        complete: false,
        text: bounded.text,
        reason,
      });
    }

    return entry(base, {
      status: 'ready',
      complete: true,
      text: bounded.text,
      reason: bounded.truncated
        ? 'Транскрипт сокращён до безопасного лимита.'
        : (!bounded.text && noAudio ? 'Аудиодорожка отсутствует; подготовлены кадры.' : null),
      visualFiles: frames,
    });
  }

  async _processFile(
    file: PreparedFile,
    index: number,
    workDir: string,
    signal: AbortSignal | null | undefined,
  ): Promise<AnalysisEntry> {
    const source = await this._writeSource(workDir, file, index);
    const kind = normalizedKind(file.kind);
    if (kind === 'voice' || kind === 'audio') {
      return this._processAudio(file, index, source, signal);
    }
    if (kind === 'video' || kind === 'video_note') {
      return this._processVideo(file, index, source, workDir, signal);
    }
    if (isImageLike(kind, file)) {
      if (!file.buffer.length || file.buffer.length > MAX_VISUAL_BYTES) {
        return entry(entryBase(file, index), {
          status: 'error',
          complete: false,
          reason: file.buffer.length
            ? 'Визуальное вложение превышает безопасный лимит 20 МБ.'
            : 'Визуальное вложение оказалось пустым.',
        });
      }
      return entry(entryBase(file, index), {
        status: 'ready',
        complete: true,
        visualFiles: [{ path: source, ext: visualExtension(file) || '.jpg' }],
      });
    }
    if (isImageKind(kind)
        || ((kind === 'document' || kind === 'sticker')
          && IMAGE_EXTENSIONS.has(extensionOf(file.name)))) {
      return entry(entryBase(file, index), {
        status: 'unsupported',
        complete: false,
        reason: 'Вложение не прошло проверку безопасного растрового формата.',
      });
    }
    if (isTextDocument(kind, file.name)) {
      const decoded = safeUtf8(file.buffer);
      return entry(entryBase(file, index), {
        status: decoded.ok ? 'ready' : 'unsupported',
        complete: decoded.ok,
        text: decoded.text,
        reason: decoded.reason,
      });
    }
    const labels: Record<string, string> = {
      animation: 'Анимации пока не поддерживаются содержательным разбором.',
      document: 'Формат документа пока не поддерживается безопасным разбором.',
      sticker: 'Формат стикера пока не поддерживается визуальным разбором.',
    };
    return entry(entryBase(file, index), {
      status: 'unsupported',
      complete: false,
      reason: labels[kind] || 'Тип вложения пока не поддерживается содержательным разбором.',
    });
  }

  async _publishVisuals(key: string, entries: AnalysisEntry[]): Promise<void> {
    await this._removeCachePath(this._visualRoot(key));

    try {
      const published = new Map<string, string>();
      let totalBytes = 0;

      for (const entryValue of entries) {
        const names: string[] = [];

        for (const visual of entryValue.visualFiles as VisualArtifact[]) {
          const bytes = await fs.readFile(visual.path);
          totalBytes += bytes.byteLength;
          const ext = IMAGE_EXTENSIONS.has(visual.ext) ? visual.ext.replace('.jpeg', '.jpg') : '';
          if (!ext || safeImageExtension(bytes) !== ext || totalBytes > MAX_VISUAL_BYTES) {
            throw new Error('Некорректный visual artifact.');
          }
          const name = `${sha256(bytes)}${ext}`;
          const target = this._visualPath(key, name);
          if (!published.has(name)) {
            await this._atomicWrite(target, bytes);
            published.set(name, target);
          }
          names.push(name);
        }
        entryValue.visualFiles = names;
      }
    } catch (error) {
      await this._removeCachePath(this._visualRoot(key));
      throw error;
    }
  }

  async _analyzeFresh({ item, materialize, signal, key, expected }: {
    item?: Payload;
    materialize: () => Promise<unknown>;
    signal?: AbortSignal | null;
    key: string;
    expected: Payload[];
  }): Promise<InboxAttachmentAnalysisResult> {
    throwIfAborted(signal);
    if (expected.length > MAX_FILES) {
      return limitResult(key, `Допускается не больше ${MAX_FILES} вложений.`);
    }
    const declaredBytes = expected.reduce((total, attachment) => (
      Number.isSafeInteger(attachment?.size) && Number(attachment.size) > 0
        ? total + Number(attachment.size)
        : total
    ), 0);
    if (declaredBytes > MAX_BYTES) {
      return limitResult(key, 'Суммарный размер вложений превышает 80 МБ.');
    }
    if (expected.length === 0) {
      const value = { ok: true, complete: true, text: '', entries: [] as AnalysisEntry[] };

      await this._writeCache(key, value);

      return publicResult(key, value, (file) => this._visualPath(key, file));
    }

    let prepared: PreparedAttachments;

    try {
      prepared = await materialize() as PreparedAttachments;
      throwIfAborted(signal);
    } catch (error) {
      if (isAbort(error, signal)) throw error;
      return limitResult(key, 'Не удалось безопасно подготовить вложения.');
    }
    if (!prepared || typeof prepared !== 'object' || Array.isArray(prepared)
        || !Array.isArray(prepared.files) || !Array.isArray(prepared.skipped)) {
      return limitResult(key, 'Канал вернул некорректный результат подготовки вложений.');
    }
    if (prepared.files.length > MAX_FILES
        || prepared.files.length + prepared.skipped.length > MAX_FILES) {
      return limitResult(key, `Допускается не больше ${MAX_FILES} подготовленных вложений.`);
    }
    if (prepared.files.length + prepared.skipped.length > expected.length) {
      return limitResult(key, 'Канал вернул вложения вне запрошенного набора.');
    }
    if (prepared.files.some((file) => !Buffer.isBuffer(file?.buffer)
        || typeof file?.name !== 'string'
        || typeof file?.kind !== 'string'
        || typeof file?.displayLabel !== 'string')) {
      return limitResult(key, 'Канал вернул вложение в некорректном формате.');
    }
    const positioned = positionPrepared(expected, prepared);
    if (!positioned) {
      return limitResult(
        key,
        'Канал нарушил позиционный контракт подготовленных вложений.',
      );
    }
    const visualPixels = prepared.files.reduce((total: number, file) => {
      const kind = normalizedKind(file.kind);
      if (!isImageKind(kind) && kind !== 'document' && kind !== 'sticker') return total;
      return total + (safeImageInfo(file.buffer)?.pixels || 0);
    }, 0);
    if (visualPixels > MAX_VISUAL_PIXELS) {
      return limitResult(key, 'Суммарное разрешение изображений превышает безопасный лимит.');
    }
    const actualBytes = prepared.files.reduce((total, file) => total + file.buffer.byteLength, 0);
    if (actualBytes > MAX_BYTES) {
      return limitResult(key, 'Суммарный размер подготовленных вложений превышает 80 МБ.');
    }

    await this._ensureBase();
    const tempRoot = path.join(this.cacheDir, '.tmp');
    await this._ensureCacheDirectory(tempRoot);
    const workDir = await fs.mkdtemp(path.join(tempRoot, `${key.slice(0, 16)}-`));
    await fs.chmod(workDir, 0o700).catch(() => {});
    try {
      const entries: AnalysisEntry[] = [];

      for (const slot of positioned) {
        throwIfAborted(signal);
        if (slot.type === 'skipped' || slot.type === 'missing') {
          entries.push(entry(entryBase(expected[slot.index], slot.index), {
            status: 'skipped',
            complete: false,
            // Без причины человек видит «не разобралось» и не может отличить
            // потолок платформы (ожиданием не лечится) от сетевого сбоя (лечится).
            // Фраза собирается по КОДУ канала: свободный текст провайдера сюда не
            // попадает — в нём бывает токен, а нам его потом показывать человеку.
            reason: slot.type === 'skipped'
              ? publicText(
                skipReasonText((slot.value as SkippedFile)?.reason, {
                  sizeBytes: (slot.value as SkippedFile)?.sizeBytes ?? null,
                  limitBytes: (slot.value as SkippedFile)?.limitBytes ?? null,
                }),
                'Вложение не удалось скачать.',
                MAX_REASON_CHARS,
              )
              : 'Канал не вернул запрошенное вложение.',
          }));
          continue;
        }
        const file = slot.value as PreparedFile;

        try {
          entries.push(await this._processFile(file, slot.index, workDir, signal));
        } catch (error) {
          if (isAbort(error, signal)) throw error;
          entries.push(entry(entryBase(file, slot.index), {
            status: 'error',
            complete: false,
            reason: 'Не удалось локально подготовить содержимое вложения.',
          }));
        }
      }

      const ok = !entries.some((value) => value.status === 'error');
      const complete = entries.length === expected.length
        && entries.every((value) => value.complete);
      const text = aggregateText(entries);
      if (!ok || !complete) {
        for (const entryValue of entries) entryValue.visualFiles = [];
        return publicResult(key, { ok, complete: false, text, entries }, () => '');
      }

      await this._publishVisuals(key, entries);
      const value = { ok: true, complete: true, text, entries };

      try {
        await this._writeCache(key, value);
      } catch (error) {
        await this._removeCachePath(this._visualRoot(key));
        throw error;
      }
      return publicResult(key, value, (file) => this._visualPath(key, file));
    } finally {
      await this._removeCachePath(workDir);
    }
  }

  async _loadOrAnalyze(args: {
    item?: Payload;
    materialize: () => Promise<unknown>;
    signal?: AbortSignal | null;
    key: string;
    expected: Payload[];
  }): Promise<InboxAttachmentAnalysisResult> {
    await this._maybeGarbageCollect(args.key);

    const cached = await this._readCache(args.key);

    if (cached) return cached;

    return this._analyzeFresh(args);
  }

  _serialized<Result>(job: () => Promise<Result>): Promise<Result> {
    const operation = this.analysisTail.then(job, job);
    this.analysisTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  _startOperation(args: {
    item?: Payload;
    materialize: () => Promise<unknown>;
    key: string;
    expected: Payload[];
  }): OperationRecord {
    const controller = new AbortController();
    // `promise` заполняется следующей строкой: сам job обязан видеть уже
    // существующую запись, иначе отмена не найдёт свой разбор.
    const record: OperationRecord = {
      key: args.key,
      controller,
      consumers: 0,
      settled: false,
      promise: null as unknown as Promise<InboxAttachmentAnalysisResult>,
      timer: setTimeout(() => controller.abort(timeoutError()), this.timeoutMs),
    };
    record.promise = this._serialized(async () => {
      throwIfAborted(controller.signal);
      this._markActive(args.key);
      const active = this._loadOrAnalyze({ ...args, signal: controller.signal });
      active.finally(() => this._unmarkActive(args.key)).catch(() => {});
      return awaitWithSignal(active, controller.signal);
    });
    this.inFlight.set(args.key, record);
    record.promise.finally(() => {
      clearTimeout(record.timer);
      record.settled = true;
      if (this.inFlight.get(args.key) === record) this.inFlight.delete(args.key);
    }).catch(() => {});
    return record;
  }

  _joinOperation(
    record: OperationRecord,
    signal: AbortSignal | null | undefined,
  ): Promise<InboxAttachmentAnalysisResult> {
    throwIfAborted(signal);
    record.consumers += 1;

    return new Promise<InboxAttachmentAnalysisResult>((resolve, reject) => {
      let finished = false;
      const release = () => {
        if (finished) return false;
        finished = true;
        if (signal) signal.removeEventListener('abort', onAbort);
        record.controller.signal.removeEventListener('abort', onInternalAbort);
        record.consumers = Math.max(0, record.consumers - 1);
        return true;
      };
      const onAbort = () => {
        if (!release()) return;
        const reason = signal?.reason instanceof Error ? signal.reason : abortError();
        if (record.consumers === 0 && !record.settled) record.controller.abort(reason);
        reject(reason);
      };
      const onInternalAbort = () => {
        if (!release()) return;
        reject(record.controller.signal.reason instanceof Error
          ? record.controller.signal.reason
          : abortError());
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      record.controller.signal.addEventListener('abort', onInternalAbort, { once: true });
      record.promise.then(
        (value) => {
          if (finished) return;
          const cloned = this._leasedClone(value, record.key);
          if (!release()) {
            void cloned.release?.();
            return;
          }
          resolve(cloned);
        },
        (error) => {
          if (!release()) return;
          reject(error);
        },
      );
    });
  }

  async analyze({ item, materialize, signal = null }: {
    item?: Payload;
    materialize?: () => Promise<unknown>;
    signal?: AbortSignal | null;
  } = {}): Promise<InboxAttachmentAnalysisResult> {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new TypeError('InboxAttachmentAnalyzer требует item.');
    }
    if (typeof materialize !== 'function') {
      throw new TypeError('InboxAttachmentAnalyzer требует lazy materialize().');
    }
    throwIfAborted(signal);
    const expected = itemAttachments(item);
    const key = fingerprintOf(item, this._revisionHash(), this.maxFrames);
    let record = this.inFlight.get(key);
    if (record?.controller.signal.aborted) {
      if (this.inFlight.get(key) === record) this.inFlight.delete(key);
      record = undefined;
    }
    record ||= this._startOperation({
      item,
      materialize: materialize as () => Promise<unknown>,
      key,
      expected,
    });
    return this._joinOperation(record, signal);
  }
}

export default InboxAttachmentAnalyzer;

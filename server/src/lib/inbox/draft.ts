// Общий черновик задачи из Inbox bundle.
//
// Здесь нет provider imports и нативных адресов файлов. Канал уже дал presentation
// fields вложений и отдельно вычисленный source URL; draft только собирает одинаковый
// для человека и модели transcript, заголовок и ограниченное описание.

import type { InboxAttachmentRecord } from './message.ts';

export const INBOX_DRAFT_LIMITS = Object.freeze({
  title: 120,
  description: 20_000,
  sourceUrlChars: 8192,
});

const KIND_WORDS: Readonly<Record<string, string>> = Object.freeze({ bug: 'Баг', wish: 'Идея' });

type Payload = Record<string, unknown>;

// Сообщение глазами черновика: он читает только то, что показывает человеку и
// модели, и не знает ни нативных адресов файлов, ни внутренних полей канала.
interface DraftMessage {
  id?: string;
  text?: string;
  occurredAt?: number;
  groupId?: string | null;
  service?: boolean;
  author?: { name?: string };
  source?: { title?: string };
  attachments?: InboxAttachmentRecord[];
}

export interface InboxTranscript {
  text: string;
  truncated: boolean;
  shown: number;
}
const RUBRIC_RE = /^\s*(баг|бага|идея|пожелание|предложение|bug|idea)\s*(?:[/:—–-]|\s—\s)\s*/i;
const SAFE_SOURCE_PROTOCOLS = new Set(['https:', 'http:']);

export class InboxDraftError extends Error {
  code: string;

  constructor(message: string) {
    super(message);
    this.name = 'InboxDraftError';
    this.code = 'invalid_inbox_draft';
  }
}

// Явная аннотация типа обязательна: без неё TypeScript не считает вызов обрывом
// потока, и после проверки значение остаётся прежним.
const fail: (message: string) => never = (message) => {
  throw new InboxDraftError(message);
};

const two = (number: number) => String(number).padStart(2, '0');

function stamp(seconds: unknown, { time = true }: { time?: boolean } = {}): string {
  const date = new Date(Number(seconds) * 1000);
  if (Number.isNaN(date.getTime())) return time ? 'неизвестное время' : 'неизвестная дата';
  const day = `${two(date.getDate())}.${two(date.getMonth() + 1)}.${date.getFullYear()}`;
  return time ? `${day} ${two(date.getHours())}:${two(date.getMinutes())}` : day;
}

function trimText(value: unknown, limit: number): string {
  const text = String(value ?? '');
  if (text.length <= limit) return text;
  const cut = text.slice(0, Math.max(0, limit));
  const space = cut.lastIndexOf(' ');
  const useful = space > limit * 0.6 ? cut.slice(0, space) : cut;
  return `${useful.trimEnd()}…`;
}

/** Только http(s), без userinfo; unsafe/provider credential URLs fail closed. */
export function safeInboxSourceUrl(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > INBOX_DRAFT_LIMITS.sourceUrlChars) {
    fail('Source URL должен быть ограниченной строкой.');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail('Source URL не является абсолютным URL.');
  }
  if (!SAFE_SOURCE_PROTOCOLS.has(parsed.protocol) || parsed.username || parsed.password) {
    fail('Source URL использует небезопасную схему или содержит credentials.');
  }
  return parsed.href;
}

function attachmentLabel(attachment: InboxAttachmentRecord): string {
  const label = String(attachment?.displayLabel || attachment?.kind || 'вложение').trim() || 'вложение';
  const name = String(attachment?.name || '').trim();
  return name ? `${label} ${name}` : label;
}

function lineOf(message: DraftMessage, number: number | null = null): string {
  const author = String(message?.author?.name || '').trim() || 'неизвестно';
  const attachments = (message?.attachments || []).map(attachmentLabel);
  const body = [
    String(message?.text || '').trim(),
    attachments.length ? `(${attachments.join(', ')})` : '',
  ].filter(Boolean).join(' ');
  const prefix = number === null ? '' : `#${number} `;
  return `${prefix}[${stamp(message?.occurredAt)}] ${author}: ${body}`;
}

/**
 * Единственное правило «какие сообщения видны». Нумерованный transcript триажа и
 * его же обратная раскладка «номер → messageRef» обязаны получать один и тот же
 * список: разойдись эти два фильтра, и модель распределит сообщения по одним
 * номерам, а решение уедет на другие.
 */
export function visibleInboxMessages(messages: unknown): DraftMessage[] {
  return (Array.isArray(messages) ? messages as DraftMessage[] : [])
    .filter((message) => !message?.service);
}

function describe(lines: string[], footer: string, limit: number): InboxTranscript {
  if (!Number.isSafeInteger(limit) || limit < 1) fail('Transcript limit должен быть положительным целым.');
  if (footer.length >= limit) fail('Footer не помещается в transcript limit.');
  const budget = limit - footer.length;
  const full = lines.join('\n');
  if (full.length <= budget) {
    return { text: full + footer, truncated: false, shown: lines.length };
  }

  const note = (shown: number) => (
    `\n[обрезано: показаны первые ${shown} из ${lines.length} сообщений]`
  );
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    const next = used + line.length + (out.length ? 1 : 0);
    if (next + note(out.length + 1).length > budget) break;
    out.push(line);
    used = next;
  }
  if (!out.length && lines.length) {
    out.push(trimText(lines[0], Math.max(1, budget - note(1).length)));
  }
  // `shown` — сколько строк реально попало в текст. Нумерованному transcript это
  // граница: сослаться на сообщение, которого модель не видела, нельзя.
  return { text: out.join('\n') + note(out.length) + footer, truncated: true, shown: out.length };
}

/**
 * Transcript используется и карточкой, и model prompt. `numbered` добавляет строкам
 * сквозные номера: без них модель не может сказать, какие именно сообщения относятся
 * к одному поводу, а какие — к соседнему.
 */
export function inboxTranscript(messages: unknown, {
  limit = INBOX_DRAFT_LIMITS.description,
  footer = '',
  numbered = false,
}: {
  limit?: number;
  footer?: string;
  numbered?: boolean;
} = {}): InboxTranscript {
  if (!Array.isArray(messages)) fail('messages должен быть массивом.');
  if (typeof footer !== 'string') fail('footer должен быть строкой.');
  const visible = visibleInboxMessages(messages);
  return describe(
    visible.map((message, index) => lineOf(message, numbered ? index + 1 : null)),
    footer,
    limit,
  );
}

function titleOf(messages: DraftMessage[], kind: string): string {
  for (const message of messages) {
    const first = String(message.text || '').split('\n').map((line) => line.trim()).find(Boolean);
    if (!first) continue;
    const stripped = first.replace(RUBRIC_RE, '').trim();
    return trimText(stripped || first, INBOX_DRAFT_LIMITS.title);
  }
  const head = messages[0];
  const word = KIND_WORDS[kind] || 'Обращение';
  const author = String(head?.author?.name || '').trim() || 'неизвестный автор';
  return `${word} · ${author} · ${stamp(head?.occurredAt, { time: false })}`;
}

// Вложение в черновике несёт ещё и происхождение: из какого сообщения и какого
// альбома оно пришло. Наружу это не уезжает — публичный mapper оставляет подпись,
// род и размер, — но подготовка вложений без происхождения работать не может.
export interface InboxDraftAttachment extends InboxAttachmentRecord {
  messageId: string | undefined;
  groupId: string | null | undefined;
}

function collectAttachments(messages: DraftMessage[]): InboxDraftAttachment[] {
  const result: InboxDraftAttachment[] = [];
  const seen = new Set<unknown>();
  for (const message of messages) {
    for (const attachment of message.attachments || []) {
      const key = attachment.dedupeKey || attachment.ref;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        ref: attachment.ref,
        dedupeKey: attachment.dedupeKey,
        kind: attachment.kind,
        displayLabel: attachment.displayLabel,
        name: attachment.name,
        size: attachment.size,
        messageId: message.id,
        groupId: message.groupId,
      });
    }
  }
  return result;
}

/**
 * Черновик задачи из связки сообщений. Один и тот же текст видят человек в карточке
 * и модель в разборе: расхождение здесь означало бы решение по разным данным.
 */
export function buildInboxDraft(bundle: unknown, {
  kind = '',
  channelLabel = '',
  sourceUrl = null,
}: {
  kind?: string;
  channelLabel?: string;
  sourceUrl?: unknown;
} = {}) {
  const source = bundle as { messages?: unknown; source?: { title?: string } } | null;
  const messages = Array.isArray(source?.messages)
    ? (source.messages as DraftMessage[]).filter((message) => !message.service)
    : [];
  if (!messages.length) fail('Draft требует хотя бы одно неслужебное сообщение.');
  const url = safeInboxSourceUrl(sourceUrl);
  const label = String(channelLabel || '').trim();
  const footer = url ? `\n\nИсточник${label ? ` · ${label}` : ''}: ${url}` : '';
  const transcript = inboxTranscript(messages, { footer });

  return {
    title: titleOf(messages, kind),
    description: transcript.text,
    attachments: collectAttachments(messages),
    source: {
      title: String(source?.source?.title || messages[0]?.source?.title || ''),
      url,
    },
    truncated: transcript.truncated,
  };
}

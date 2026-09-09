// Чистая склейка нормализованных сообщений разных каналов.
//
// Activation epoch передаётся вне InboxMessage: это server-only provenance чтения
// archive. Она входит и в ключ, и в localBundleId, поэтому custom key никогда
// не протянет связку через период, когда участие канала было выключено.

import { validateInboxMessage } from './message.ts';
import type { InboxMessageRecord } from './message.ts';
import { assertAccountRef, assertChannel, assertNativeSegment } from './identity.ts';

export const MAX_SETTLE_MS = 86_400_000;
export const DEFAULT_CHANNEL_SETTLE_MS = Object.freeze({
  telegram: 600_000,
  github: 0,
});

export class InboxBundleError extends Error {
  code: string;

  statusCode: number;

  constructor(message: string) {
    super(message);
    this.name = 'InboxBundleError';
    this.code = 'invalid_inbox_bundle';
    this.statusCode = 400;
  }
}

// Правило склейки канала. Окно тишины и своя нарезка объявляются самим каналом:
// у Telegram обращение — переписка за паузу, у GitHub — один issue.
export interface InboxGrouping {
  settleMs: number;
  bundleKeyOf: ((message: InboxMessageRecord) => unknown) | null;
}

export interface InboxBundleEntry {
  message: InboxMessageRecord;
  activationEpoch: number;
}

export interface InboxBundle {
  localBundleId: string;
  activationEpoch: number;
  source: InboxMessageRecord['source'];
  groupingKey: string;
  firstAt: number;
  lastAt: number;
  messages: InboxMessageRecord[];
  settled?: boolean;
  cold?: boolean;
}

// Явная аннотация типа обязательна: без неё TypeScript не считает вызов обрывом
// потока, и после проверки значение остаётся прежним.
const fail: (message: string) => never = (message) => {
  throw new InboxBundleError(message);
};

function assertEpoch(value: unknown, where = 'activationEpoch'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    fail(`${where}: ожидалось положительное целое.`);
  }

  return value;
}

function canonicalKey(parts: unknown[]): string {
  return JSON.stringify(parts);
}

function customKeyOf(
  hook: InboxGrouping['bundleKeyOf'],
  message: InboxMessageRecord,
): unknown[] | null {
  if (!hook) return null;

  const value = hook(message) as { then?: unknown; kind?: unknown; id?: unknown } | null;

  if (value && typeof value.then === 'function') {
    fail('grouping.bundleKeyOf обязан быть синхронной pure-функцией.');
  }
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    return ['custom', assertNativeSegment(value, 'grouping.bundleKeyOf result')];
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value).sort();
    if (keys.length !== 2 || keys[0] !== 'id' || keys[1] !== 'kind') {
      fail('Объект grouping.bundleKeyOf должен иметь ровно поля {kind, id}.');
    }
    return [
      `custom:${assertNativeSegment(value.kind, 'grouping.bundleKeyOf kind')}`,
      assertNativeSegment(value.id, 'grouping.bundleKeyOf id'),
    ];
  }
  return fail('grouping.bundleKeyOf должен вернуть строку, {kind, id}, null или undefined.');
}

/** Проверяет grouping capability и подставляет только явно документированные defaults. */
export function validateInboxGrouping(channel: unknown, source: unknown = {}): InboxGrouping {
  const trustedChannel = assertChannel(channel);

  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    fail('grouping должен быть объектом.');
  }

  const raw = source as Record<string, unknown>;
  const defaults = DEFAULT_CHANNEL_SETTLE_MS as Record<string, number | undefined>;
  const settleMs = raw.settleMs ?? defaults[trustedChannel];

  if (typeof settleMs !== 'number' || !Number.isSafeInteger(settleMs)
      || settleMs < 0 || settleMs > MAX_SETTLE_MS) {
    fail(`grouping.settleMs должен быть целым 0..${MAX_SETTLE_MS}.`);
  }
  if (raw.bundleKeyOf !== undefined && typeof raw.bundleKeyOf !== 'function') {
    fail('grouping.bundleKeyOf должен быть функцией.');
  }

  return {
    settleMs,
    bundleKeyOf: (raw.bundleKeyOf as InboxGrouping['bundleKeyOf']) || null,
  };
}

/**
 * Полный namespaced grouping key одного сообщения.
 * Возвращаем tuple, а не строку с разделителями: provider ids свободно содержат `:`/`#`.
 *
 * Дефолт склеивает по МЕСТУ разговора: тема, а где тем нет — сам чат. Обращение это
 * переписка одного места за окно тишины, а не реплика одного участника, поэтому автора
 * в ключе нет намеренно: уточнение соседа («не раньше ПН») принадлежит тому же поводу,
 * рядом с которым сказано, и разведение их по карточкам ставило бы две задачи там, где
 * повод один. Reply и media group отдельными ветками тоже не нужны — и ответ, и части
 * альбома лежат в том же месте; своя ветка у альбома, наоборот, ОТРЫВАЛА его от текста
 * рядом. Каналу с другой нарезкой остаётся `grouping.bundleKeyOf`.
 */
export function inboxBundleKeyOf(
  message: InboxMessageRecord,
  activationEpoch: unknown,
  { bundleKeyOf = null }: Partial<InboxGrouping> = {},
): unknown[] {
  const epoch = assertEpoch(activationEpoch);
  const sourceId = assertNativeSegment(message?.source?.id, 'message.source.id');
  const custom = customKeyOf(bundleKeyOf, message);
  const local = custom
    || (message.source.threadId !== null ? ['thread', message.source.threadId] : ['chat']);

  return [1, 'bundle-key', message.channel, message.accountRef, sourceId, epoch, ...local];
}

function assertEntry(
  source: unknown,
  index: number,
  owner: { channel: string; accountRef: string },
): InboxBundleEntry {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    fail(`entries[${index}]: ожидался объект {message, activationEpoch}.`);
  }

  const raw = source as Record<string, unknown>;
  const keys = Object.keys(raw).sort();
  if (keys.length !== 2 || keys[0] !== 'activationEpoch' || keys[1] !== 'message') {
    fail(`entries[${index}]: допустимы только поля message и activationEpoch.`);
  }
  return {
    message: validateInboxMessage(raw.message, {
      expectedChannel: owner.channel,
      expectedAccountRef: owner.accountRef,
    }),
    activationEpoch: assertEpoch(raw.activationEpoch, `entries[${index}].activationEpoch`),
  };
}

const activityAt = (message: InboxMessageRecord) => message.editedAt ?? message.occurredAt;
const lexical = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const identityOf = (entry: InboxBundleEntry) => canonicalKey([
  entry.message.channel,
  entry.message.accountRef,
  entry.message.source.id,
  entry.message.id,
]);

function deduplicate(entries: InboxBundleEntry[]): InboxBundleEntry[] {
  const byMessage = new Map<string, InboxBundleEntry>();
  for (const entry of entries) {
    const id = identityOf(entry);
    const previous = byMessage.get(id);
    if (previous && previous.activationEpoch !== entry.activationEpoch) {
      fail(`Сообщение ${entry.message.id} неоднозначно попало в разные activation epochs.`);
    }
    if (!previous || activityAt(entry.message) >= activityAt(previous.message)) byMessage.set(id, entry);
  }
  return [...byMessage.values()];
}

function localBundleIdOf(entry: InboxBundleEntry, groupingTuple: unknown[]): string {
  const tuple = [
    1,
    'bundle',
    entry.message.source.id,
    entry.activationEpoch,
    groupingTuple.slice(6),
    entry.message.id,
  ];
  return Buffer.from(JSON.stringify(tuple), 'utf8').toString('base64url');
}

function makeBundle(
  entry: InboxBundleEntry,
  groupingTuple: unknown[],
  groupingKey: string,
): InboxBundle {
  const at = activityAt(entry.message);

  return {
    localBundleId: localBundleIdOf(entry, groupingTuple),
    activationEpoch: entry.activationEpoch,
    source: { ...entry.message.source },
    groupingKey,
    firstAt: entry.message.occurredAt,
    lastAt: at,
    messages: [],
  };
}

/**
 * Склеивает `{message, activationEpoch}` в воспроизводимые bundles.
 *
 * Результат отсортирован по `lastAt desc`, затем по `localBundleId`. На точной
 * границе settleMs начинается новая связка; `settled` становится true на той же
 * точной границе относительно переданного `nowMs`.
 */
export function bundleInboxMessages(entries: unknown, {
  channel,
  accountRef,
  grouping = {},
  nowMs = Date.now(),
}: {
  channel?: unknown;
  accountRef?: unknown;
  grouping?: unknown;
  nowMs?: number;
} = {}): InboxBundle[] {
  const owner = {
    channel: assertChannel(channel),
    accountRef: assertAccountRef(accountRef),
  };
  if (!Array.isArray(entries)) fail('entries должен быть массивом.');
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) fail('nowMs должен быть неотрицательным safe integer.');
  const contract = validateInboxGrouping(owner.channel, grouping);
  const normalized = deduplicate(
    (entries as unknown[]).map((entry, i) => assertEntry(entry, i, owner)),
  )
    .filter((entry) => !entry.message.service)
    .sort((a, b) => (
      a.message.occurredAt - b.message.occurredAt
      || lexical(a.message.source.id, b.message.source.id)
      || lexical(a.message.id, b.message.id)
      || a.activationEpoch - b.activationEpoch
    ));

  const bundles: InboxBundle[] = [];
  const latestByKey = new Map<string, InboxBundle>();

  for (const entry of normalized) {
    const at = activityAt(entry.message);
    const tuple = inboxBundleKeyOf(entry.message, entry.activationEpoch, contract);
    const groupingKey = canonicalKey(tuple);
    const latest = latestByKey.get(groupingKey);
    // Окно тишины скользящее: каждое новое сообщение места продлевает связку.
    let target = latest && at * 1000 - latest.lastAt * 1000 < contract.settleMs ? latest : null;
    if (!target) {
      target = makeBundle(entry, tuple, groupingKey);
      bundles.push(target);
      latestByKey.set(groupingKey, target);
    }

    target.messages.push(entry.message);
    target.firstAt = Math.min(target.firstAt, entry.message.occurredAt);
    target.lastAt = Math.max(target.lastAt, at);
  }

  for (const bundle of bundles) {
    bundle.messages.sort((a, b) => a.occurredAt - b.occurredAt || lexical(a.id, b.id));
    bundle.settled = nowMs - bundle.lastAt * 1000 >= contract.settleMs;
    bundle.cold = bundle.settled;
  }
  return bundles.sort((a, b) => b.lastAt - a.lastAt || lexical(a.localBundleId, b.localBundleId));
}

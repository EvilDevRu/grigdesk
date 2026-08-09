// Чистая склейка нормализованных сообщений разных каналов.
//
// Activation epoch передаётся вне InboxMessage: это server-only provenance чтения
// archive. Она входит и в ключ, и в localBundleId, поэтому reply/custom key никогда
// не протянет связку через период, когда участие канала было выключено.

import { validateInboxMessage } from './message.js';
import { assertAccountRef, assertChannel, assertNativeSegment } from './identity.js';

export const MAX_SETTLE_MS = 86_400_000;
export const DEFAULT_CHANNEL_SETTLE_MS = Object.freeze({
  telegram: 600_000,
  github: 0,
});

export class InboxBundleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InboxBundleError';
    this.code = 'invalid_inbox_bundle';
    this.statusCode = 400;
  }
}

const fail = (message) => {
  throw new InboxBundleError(message);
};

function assertEpoch(value, where = 'activationEpoch') {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${where}: ожидалось положительное целое.`);
  return value;
}

function canonicalKey(parts) {
  return JSON.stringify(parts);
}

function customKeyOf(hook, message) {
  if (!hook) return null;
  const value = hook(message);
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
  fail('grouping.bundleKeyOf должен вернуть строку, {kind, id}, null или undefined.');
}

/** Проверяет grouping capability и подставляет только явно документированные defaults. */
export function validateInboxGrouping(channel, raw = {}) {
  const trustedChannel = assertChannel(channel);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('grouping должен быть объектом.');
  }
  const settleMs = raw.settleMs ?? DEFAULT_CHANNEL_SETTLE_MS[trustedChannel];
  if (!Number.isSafeInteger(settleMs) || settleMs < 0 || settleMs > MAX_SETTLE_MS) {
    fail(`grouping.settleMs должен быть целым 0..${MAX_SETTLE_MS}.`);
  }
  if (raw.bundleKeyOf !== undefined && typeof raw.bundleKeyOf !== 'function') {
    fail('grouping.bundleKeyOf должен быть функцией.');
  }
  return { settleMs, bundleKeyOf: raw.bundleKeyOf || null };
}

/**
 * Полный namespaced grouping key одного сообщения.
 * Возвращаем tuple, а не строку с разделителями: provider ids свободно содержат `:`/`#`.
 */
export function inboxBundleKeyOf(message, activationEpoch, { bundleKeyOf } = {}) {
  const epoch = assertEpoch(activationEpoch);
  const sourceId = assertNativeSegment(message?.source?.id, 'message.source.id');
  const custom = customKeyOf(bundleKeyOf, message);
  let local;
  if (custom) local = custom;
  else if (message.parentId !== null) local = ['parent', message.parentId];
  else if (message.groupId !== null) local = ['group', message.groupId];
  else if (message.source.threadId !== null && message.author.id !== null) {
    local = ['thread-author', message.source.threadId, message.author.id];
  } else if (message.author.id !== null) local = ['author', message.author.id];
  else local = ['message', message.id];

  return [1, 'bundle-key', message.channel, message.accountRef, sourceId, epoch, ...local];
}

function assertEntry(raw, index, owner) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(`entries[${index}]: ожидался объект {message, activationEpoch}.`);
  }
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

const activityAt = (message) => message.editedAt ?? message.occurredAt;
const lexical = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const identityOf = (entry) => canonicalKey([
  entry.message.channel,
  entry.message.accountRef,
  entry.message.source.id,
  entry.message.id,
]);

function deduplicate(entries) {
  const byMessage = new Map();
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

function localBundleIdOf(entry, groupingTuple) {
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

function makeBundle(entry, groupingTuple, groupingKey) {
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
export function bundleInboxMessages(entries, {
  channel,
  accountRef,
  grouping = {},
  nowMs = Date.now(),
} = {}) {
  const owner = {
    channel: assertChannel(channel),
    accountRef: assertAccountRef(accountRef),
  };
  if (!Array.isArray(entries)) fail('entries должен быть массивом.');
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) fail('nowMs должен быть неотрицательным safe integer.');
  const contract = validateInboxGrouping(owner.channel, grouping);
  const normalized = deduplicate(entries.map((entry, i) => assertEntry(entry, i, owner)))
    .filter((entry) => !entry.message.service)
    .sort((a, b) => (
      a.message.occurredAt - b.message.occurredAt
      || lexical(a.message.source.id, b.message.source.id)
      || lexical(a.message.id, b.message.id)
      || a.activationEpoch - b.activationEpoch
    ));

  const bundles = [];
  const latestByKey = new Map();
  const byMessage = new Map();

  for (const entry of normalized) {
    const tuple = inboxBundleKeyOf(entry.message, entry.activationEpoch, contract);
    const groupingKey = canonicalKey(tuple);
    const at = activityAt(entry.message);
    let target = null;

    // Ответ на известное сообщение наследует его bundle, но только внутри той же epoch/source.
    if (!contract.bundleKeyOf && entry.message.parentId !== null) {
      target = byMessage.get(canonicalKey([
        entry.message.source.id,
        entry.activationEpoch,
        entry.message.parentId,
      ])) || null;
      if (target && at * 1000 - target.lastAt * 1000 >= contract.settleMs) target = null;
    }
    if (!target) {
      const latest = latestByKey.get(groupingKey);
      if (latest && at * 1000 - latest.lastAt * 1000 < contract.settleMs) target = latest;
    }
    if (!target) {
      target = makeBundle(entry, tuple, groupingKey);
      bundles.push(target);
      latestByKey.set(groupingKey, target);
    }

    target.messages.push(entry.message);
    target.firstAt = Math.min(target.firstAt, entry.message.occurredAt);
    target.lastAt = Math.max(target.lastAt, at);
    byMessage.set(canonicalKey([
      entry.message.source.id,
      entry.activationEpoch,
      entry.message.id,
    ]), target);
  }

  for (const bundle of bundles) {
    bundle.messages.sort((a, b) => a.occurredAt - b.occurredAt || lexical(a.id, b.id));
    bundle.settled = nowMs - bundle.lastAt * 1000 >= contract.settleMs;
    bundle.cold = bundle.settled;
  }
  return bundles.sort((a, b) => b.lastAt - a.lastAt || lexical(a.localBundleId, b.localBundleId));
}

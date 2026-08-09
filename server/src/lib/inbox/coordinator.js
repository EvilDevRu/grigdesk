// Координатор общего Inbox: явный список channel capabilities, lease каждой immutable
// generation, merge и единственный public mapper. Provider lifecycle и credentials сюда
// не входят; ошибка одного канала превращается в partial result, а не скрывает соседей.

import { createHash } from 'node:crypto';

import { bundleInboxMessages, validateInboxGrouping } from './bundle.js';
import { buildInboxDraft, safeInboxSourceUrl } from './draft.js';
import {
  assertAccountRef,
  assertChannel,
  assertNativeSegment,
  decodeInboxRef,
  InboxRefCodec,
} from './identity.js';
import { validateInboxMessage } from './message.js';
import { activationSummaryOf, projectDecisionState } from './state-store.js';

const CONNECTIONS = new Set([
  'disconnected',
  'connecting',
  'connected',
  'disconnecting',
  'switching',
  'degraded',
]);
const PARTICIPATIONS = new Set(['never_activated', 'active', 'deactivated']);
const REASONS = new Set(['account_changed', 'invalid_binding', 'invalid_state', 'provider_failure']);
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
// Public limit нельзя передавать adapter-у как admission limit: decisions живут
// уровнем выше, поэтому старые решённые rows иначе навсегда закрывают хвост
// очереди. Каждый adapter исчерпывающе page-ит native store до этого safety cap;
// `truncated` на таком запросе означает не частичный успех, а degraded channel.
const MAX_BATCHES = 10_000;
const MAX_POLICY_STRING_BYTES = 2048;
const BATCH_KEYS = ['activationEpoch', 'source', 'messages', 'policy', 'truncated'];
const SOURCE_KEYS = ['id', 'title', 'threadId'];
const POLICY_KEYS = ['scopeId', 'project', 'kind', 'b24', 'autoTask'];
const B24_KEYS = ['groupId', 'responsibleId', 'priority'];
const AUTO_KEYS = ['enabled', 'minConfidence', 'maxPerDay'];

const lexical = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const clone = (value) => structuredClone(value);
const itemOrder = (a, b) => (
  b.lastAt - a.lastAt
  || lexical(a.channel, b.channel)
  || lexical(a.ref, b.ref)
);

// Только new/mixed являются очередью, которую нужно продвигать. Полностью
// skipped item остаётся resettable history, но не может навсегда вытеснить
// более старый new. Итоговый ответ всё равно сохраняет документированный
// lastAt/channel/ref order.
const actionableItem = (item) => item.status === 'new' || item.status === 'mixed';

function selectInboxItems(items, limit) {
  const actionable = [];
  const history = [];
  for (const item of items) (actionableItem(item) ? actionable : history).push(item);
  const selected = actionable.slice(0, limit);
  if (selected.length < limit) selected.push(...history.slice(0, limit - selected.length));
  return selected.sort(itemOrder);
}

export class InboxCoordinatorError extends Error {
  constructor(code, message, statusCode = 500, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'InboxCoordinatorError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (code, message, statusCode = 500, cause) => {
  throw new InboxCoordinatorError(code, message, statusCode, cause);
};

const isPlainObject = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

function exactObject(value, keys, where, code = 'invalid_channel_contract') {
  if (!isPlainObject(value)) fail(code, `${where}: ожидался объект.`);
  const own = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (own.length !== expected.length || own.some((key, i) => key !== expected[i])) {
    fail(code, `${where}: поля не совпадают с contract (${keys.join(', ')}).`);
  }
}

function boundedString(value, where, { empty = false, maxBytes = MAX_POLICY_STRING_BYTES } = {}) {
  if (typeof value !== 'string') fail('invalid_channel_contract', `${where}: ожидалась строка.`);
  const bytes = Buffer.byteLength(value, 'utf8');
  if ((!empty && bytes === 0) || bytes > maxBytes) {
    fail('invalid_channel_contract', `${where}: недопустимый размер строки.`);
  }
  return value;
}

function validateLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIMIT) {
    fail('invalid_limit', `limit должен быть целым 1..${MAX_LIMIT}.`, 400);
  }
  return value;
}

function validateNow(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('invalid_request', 'nowMs должен быть неотрицательным safe integer.', 400);
  }
  return value;
}

function validateChannelCapability(raw) {
  if (!isPlainObject(raw)) fail('invalid_channel_contract', 'Channel capability должен быть объектом.');
  const id = assertChannel(raw.id, 'channel.id');
  const label = boundedString(raw.label, `channel ${id}.label`, { maxBytes: 256 });
  const grouping = validateInboxGrouping(id, raw.grouping || {});
  for (const method of ['enabled', 'state', 'acquireInboxContext']) {
    if (typeof raw[method] !== 'function') {
      fail('invalid_channel_contract', `Channel ${id} требует метод ${method}().`);
    }
  }
  return { id, label, grouping, capability: raw };
}

function validateSource(raw, where) {
  exactObject(raw, SOURCE_KEYS, where);
  const id = assertNativeSegment(raw.id, `${where}.id`);
  const title = boundedString(raw.title, `${where}.title`, { empty: true, maxBytes: 4096 });
  const threadId = raw.threadId === null
    ? null
    : assertNativeSegment(raw.threadId, `${where}.threadId`);
  return { id, title, threadId };
}

function nullableSafeInteger(value, where) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value)) fail('invalid_channel_contract', `${where}: ожидался null или safe integer.`);
  return value;
}

function validatePolicy(raw, where) {
  exactObject(raw, POLICY_KEYS, where);
  exactObject(raw.b24, B24_KEYS, `${where}.b24`);
  exactObject(raw.autoTask, AUTO_KEYS, `${where}.autoTask`);
  const scopeId = assertNativeSegment(raw.scopeId, `${where}.scopeId`);
  const project = boundedString(raw.project, `${where}.project`);
  const kind = boundedString(raw.kind, `${where}.kind`, { maxBytes: 80 });
  const groupId = nullableSafeInteger(raw.b24.groupId, `${where}.b24.groupId`);
  const responsibleId = nullableSafeInteger(raw.b24.responsibleId, `${where}.b24.responsibleId`);
  const priority = raw.b24.priority;
  if (priority !== null && ![0, 1, 2].includes(priority)) {
    fail('invalid_channel_contract', `${where}.b24.priority: бывает null|0|1|2.`);
  }
  if (typeof raw.autoTask.enabled !== 'boolean'
    || !Number.isFinite(raw.autoTask.minConfidence)
    || raw.autoTask.minConfidence < 0
    || raw.autoTask.minConfidence > 1
    || !Number.isSafeInteger(raw.autoTask.maxPerDay)
    || raw.autoTask.maxPerDay < 0
    || raw.autoTask.maxPerDay > 100) {
    fail('invalid_channel_contract', `${where}.autoTask не соответствует strict policy contract.`);
  }
  return {
    scopeId,
    project,
    kind,
    b24: { groupId, responsibleId, priority },
    autoTask: {
      enabled: raw.autoTask.enabled,
      minConfidence: raw.autoTask.minConfidence,
      maxPerDay: raw.autoTask.maxPerDay,
    },
  };
}

function validateBatch(raw, index, { channel, accountRef, epochs }) {
  const where = `batches[${index}]`;
  exactObject(raw, BATCH_KEYS, where);
  if (!Number.isSafeInteger(raw.activationEpoch) || !epochs.has(raw.activationEpoch)) {
    fail('invalid_channel_contract', `${where}.activationEpoch не принадлежит переданным windows.`);
  }
  if (!Array.isArray(raw.messages) || raw.messages.length < 1) {
    fail('invalid_channel_contract', `${where}.messages должен быть непустым массивом.`);
  }
  if (typeof raw.truncated !== 'boolean') {
    fail('invalid_channel_contract', `${where}.truncated должен быть boolean.`);
  }
  const source = validateSource(raw.source, `${where}.source`);
  const messages = raw.messages.map((message) => validateInboxMessage(message, {
    expectedChannel: channel,
    expectedAccountRef: accountRef,
  }));
  for (const message of messages) {
    if (message.source.id !== source.id
      || message.source.title !== source.title
      || message.source.threadId !== source.threadId) {
      fail('invalid_channel_contract', `${where}: source не совпадает с source сообщения.`);
    }
  }
  return {
    activationEpoch: raw.activationEpoch,
    source,
    messages,
    policy: validatePolicy(raw.policy, `${where}.policy`),
    truncated: raw.truncated,
  };
}

function validateContext(raw, meta) {
  if (!isPlainObject(raw)) fail('invalid_channel_context', `Channel ${meta.id} не выдал context.`);
  const accountRef = assertAccountRef(raw.accountRef, `channel ${meta.id} context.accountRef`);
  if (!['string', 'number'].includes(typeof raw.generation)
    || (typeof raw.generation === 'string' && !raw.generation)
    || (typeof raw.generation === 'number' && !Number.isSafeInteger(raw.generation))) {
    fail('invalid_channel_context', `Channel ${meta.id} выдал невалидную generation.`);
  }
  for (const method of ['createActivationMarker', 'listAuthorizedBatches', 'sourceUrl', 'release']) {
    if (typeof raw[method] !== 'function') {
      fail('invalid_channel_context', `Channel ${meta.id} context требует ${method}().`);
    }
  }
  if (raw.isCurrent !== undefined && typeof raw.isCurrent !== 'function') {
    fail('invalid_channel_context', `Channel ${meta.id} context.isCurrent должен быть функцией.`);
  }
  if (raw.materializeAttachments !== undefined && typeof raw.materializeAttachments !== 'function') {
    fail('invalid_channel_context', `Channel ${meta.id} context.materializeAttachments должен быть функцией.`);
  }
  const state = raw.inboxState;
  if (!state || typeof state.read !== 'function'
    || typeof state.summary !== 'function'
    || typeof state.activationWindows !== 'function'
    || typeof state.activate !== 'function'
    || typeof state.deactivate !== 'function') {
    fail('invalid_channel_context', `Channel ${meta.id} context.inboxState не реализует state store contract.`);
  }
  const refCodec = raw.refCodec || state.refCodec;
  if (!refCodec || typeof refCodec.decode !== 'function'
    || typeof refCodec.message !== 'function'
    || typeof refCodec.item !== 'function'
    || typeof refCodec.scope !== 'function') {
    fail('invalid_channel_context', `Channel ${meta.id} context не выдал refCodec.`);
  }
  if (refCodec.channel !== undefined && refCodec.channel !== meta.id) {
    fail('invalid_channel_context', `Channel ${meta.id} context.refCodec принадлежит другому channel.`);
  }
  if (refCodec.accountRef !== undefined && refCodec.accountRef !== accountRef) {
    fail('account_changed', `Channel ${meta.id} context.refCodec принадлежит другому account.`, 409);
  }
  return { context: raw, accountRef, generation: raw.generation, inboxState: state, refCodec };
}

function publicError(channel, error) {
  const raw = typeof error?.code === 'string' ? error.code : 'channel_failed';
  const code = /^[a-z0-9_]{1,80}$/.test(raw) ? raw : 'channel_failed';
  const messages = {
    account_changed: 'Подключённый аккаунт канала изменился.',
    invalid_binding: 'Привязка аккаунта канала повреждена.',
    invalid_state: 'Состояние канала повреждено.',
    invalid_activation_marker: 'Граница приёма канала повреждена.',
    stale_generation: 'Поколение канала изменилось во время чтения.',
  };
  return {
    channel,
    code,
    message: messages[code] || 'Канал временно не удалось прочитать.',
  };
}

function sanitizeState(meta, enabled, raw = {}, activation = null) {
  const connection = CONNECTIONS.has(raw.connection) ? raw.connection : 'degraded';
  const participation = activation?.participation
    || (PARTICIPATIONS.has(raw.participation) ? raw.participation : 'never_activated');
  const reason = raw.reason === null || raw.reason === undefined
    ? null
    : (REASONS.has(raw.reason) ? raw.reason : 'provider_failure');
  return {
    id: meta.id,
    label: meta.label,
    plugin: enabled ? 'enabled' : 'disabled',
    connection,
    participation,
    activationVersion: activation?.activationVersion ?? 0,
    currentEpoch: activation?.currentEpoch ?? null,
    startedAtMs: activation?.startedAtMs ?? null,
    endedAtMs: activation?.endedAtMs ?? null,
    endReason: activation?.endReason ?? null,
    reason,
    readOnly: !enabled || connection !== 'connected',
    truncated: false,
  };
}

function disabledState(meta) {
  return {
    id: meta.id,
    label: meta.label,
    plugin: 'disabled',
    connection: 'disconnected',
    participation: 'never_activated',
    activationVersion: 0,
    currentEpoch: null,
    startedAtMs: null,
    endedAtMs: null,
    endReason: null,
    reason: null,
    readOnly: true,
    truncated: false,
  };
}

function safeDecision(decision) {
  if (!decision) return null;
  let taskUrl = '';
  if (decision.taskUrl) {
    try {
      taskUrl = safeInboxSourceUrl(decision.taskUrl) || '';
    } catch {
      taskUrl = '';
    }
  }
  return {
    decisionId: decision.decisionId,
    version: decision.version,
    status: decision.status,
    taskId: decision.taskId,
    taskUrl,
    by: decision.by,
    note: decision.note,
    decidedAtMs: decision.decidedAtMs,
  };
}

function safeAttachment(attachment) {
  return {
    kind: attachment.kind,
    displayLabel: attachment.displayLabel,
    name: attachment.name,
    size: attachment.size,
  };
}

/** Единственный public mapper: новые internal поля автоматически наружу не попадут. */
export function toPublicInboxItem(item) {
  const readyAtMs = Number.isSafeInteger(item.autoReadyAtMs)
    ? item.autoReadyAtMs
    : item.lastAt * 1000;
  return {
    ref: item.ref,
    revision: item.revision,
    channel: { id: item.channel, label: item.channelLabel },
    source: { title: item.source.title, url: item.sourceUrl },
    project: item.policy.project,
    kind: item.policy.kind,
    status: item.status,
    decision: safeDecision(item.decision),
    firstAt: item.firstAt,
    lastAt: item.lastAt,
    cold: item.cold,
    autoTask: {
      enabled: item.policy.autoTask.enabled,
      readyAtMs,
    },
    title: item.draft.title,
    description: item.draft.description,
    truncated: item.draft.truncated,
    messages: item.messages.map((message) => ({
      messageRef: message.messageRef,
      occurredAt: message.occurredAt,
      editedAt: message.editedAt,
      author: { name: message.author.name },
      text: message.text,
      attachments: message.attachments.map(safeAttachment),
      decision: safeDecision(message.decision),
    })),
    attachments: item.attachments.map(safeAttachment),
  };
}

function revisionOf(item) {
  const payload = {
    schema: 1,
    ref: item.ref,
    activationEpoch: item.activationEpoch,
    source: item.source,
    sourceUrl: item.sourceUrl,
    messages: item.messages.map(({ messageRef, decision, ...message }) => ({
      messageRef,
      message,
      decision,
    })),
    policy: item.policy,
    status: item.status,
    decision: item.decision,
  };
  return `v1_${createHash('sha256').update(JSON.stringify(payload)).digest('base64url')}`;
}

function makeIdempotentRelease(context) {
  const underlyingRelease = context.release.bind(context);
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await underlyingRelease();
  };
}

export class InboxCoordinator {
  constructor({ channels, limit = DEFAULT_LIMIT }) {
    if (!Array.isArray(channels)) fail('invalid_channel_contract', 'channels должен быть массивом.');
    this.limit = validateLimit(limit);
    this.channels = channels.map(validateChannelCapability);
    this.byId = new Map();
    for (const meta of this.channels) {
      if (this.byId.has(meta.id)) fail('invalid_channel_contract', `Channel id «${meta.id}» повторяется.`);
      this.byId.set(meta.id, meta);
    }
  }

  async _enabled(meta) {
    return Boolean(await meta.capability.enabled());
  }

  async _rawState(meta) {
    const raw = await meta.capability.state();
    if (!isPlainObject(raw)) fail('invalid_channel_state', `Channel ${meta.id} state() вернул не объект.`);
    return raw;
  }

  async _acquire(meta) {
    const raw = await meta.capability.acquireInboxContext();
    try {
      const lease = validateContext(raw, meta);
      lease.release = makeIdempotentRelease(raw);
      // У transferred resolve lease оба очевидных пути cleanup идемпотентны.
      raw.release = lease.release;
      return lease;
    } catch (err) {
      try {
        if (raw && typeof raw.release === 'function') await raw.release();
      } catch {
        // Ошибка cleanup не должна замещать исходную ошибку невалидного context.
      }
      throw err;
    }
  }

  async _assertCurrent(lease) {
    if (lease.context.isCurrent && !await lease.context.isCurrent()) {
      fail('account_changed', 'Account generation изменилась во время операции.', 409);
    }
  }

  async _readLease(meta, lease, { nowMs }) {
    await this._assertCurrent(lease);
    const before = await lease.inboxState.read();
    if (before === null) {
      await this._assertCurrent(lease);
      return {
        items: [],
        decisions: [],
        activation: activationSummaryOf(null),
        truncated: false,
      };
    }
    const activation = activationSummaryOf(before);
    const activationWindows = await lease.inboxState.activationWindows();
    const epochs = new Set(activationWindows.map((window) => window.epoch));
    if (epochs.size !== before.activation.epochs.length) {
      fail('stale_activation_read', 'Activation windows изменились во время чтения.', 409);
    }
    const rawBatches = await lease.context.listAuthorizedBatches({
      nowMs,
      // Это scan budget, не размер HTTP-ответа. Public limit применяется только
      // после authoritative decision projection ниже.
      limit: MAX_BATCHES,
      activationWindows,
    });
    if (!Array.isArray(rawBatches) || rawBatches.length > MAX_BATCHES) {
      fail('invalid_channel_contract', `Channel ${meta.id} вернул невалидный список batches.`);
    }
    const batches = rawBatches.map((batch, i) => validateBatch(batch, i, {
      channel: meta.id,
      accountRef: lease.accountRef,
      epochs,
    }));
    if (batches.some((batch) => batch.truncated)) {
      fail(
        `${meta.id}_inbox_scan_truncated`,
        `Channel ${meta.id} не смог исчерпывающе прочитать activation windows в safety cap.`,
        503,
      );
    }
    const after = await lease.inboxState.read();
    if (!after || after.activation.version !== before.activation.version) {
      fail('stale_activation_read', 'Activation state изменился во время чтения.', 409);
    }

    const messageOwners = new Set();
    const partitions = new Map();
    for (const batch of batches) {
      const policyKey = JSON.stringify(batch.policy);
      let partition = partitions.get(policyKey);
      if (!partition) {
        partition = { policy: batch.policy, entries: [] };
        partitions.set(policyKey, partition);
      }
      for (const message of batch.messages) {
        const messageRef = lease.refCodec.message(message.source.id, message.id);
        if (messageOwners.has(messageRef)) {
          fail('invalid_channel_contract', `Channel ${meta.id} вернул сообщение в нескольких batches.`);
        }
        messageOwners.add(messageRef);
        partition.entries.push({ message, activationEpoch: batch.activationEpoch });
      }
    }

    const items = [];
    for (const { policy, entries } of partitions.values()) {
      const bundles = bundleInboxMessages(entries, {
        channel: meta.id,
        accountRef: lease.accountRef,
        grouping: meta.grouping.bundleKeyOf
          ? meta.grouping
          : { settleMs: meta.grouping.settleMs },
        nowMs,
      });
      for (const bundle of bundles) {
        const messageRefs = bundle.messages.map((message) => (
          lease.refCodec.message(message.source.id, message.id)
        ));
        const projection = projectDecisionState(messageRefs, after.decisions);
        const projectedByRef = new Map(projection.messages.map((entry) => [entry.messageRef, entry.decision]));
        const head = bundle.messages[0];
        const rawUrl = await lease.context.sourceUrl({ source: bundle.source, message: head });
        const sourceUrl = safeInboxSourceUrl(rawUrl);
        const draft = buildInboxDraft(bundle, {
          kind: policy.kind,
          channelLabel: meta.label,
          sourceUrl,
        });
        const ref = lease.refCodec.item(bundle.localBundleId);
        const item = {
          ref,
          revision: '',
          channel: meta.id,
          channelLabel: meta.label,
          activationEpoch: bundle.activationEpoch,
          localBundleId: bundle.localBundleId,
          source: clone(bundle.source),
          sourceUrl,
          firstAt: bundle.firstAt,
          lastAt: bundle.lastAt,
          cold: bundle.cold,
          autoReadyAtMs: bundle.lastAt * 1000 + meta.grouping.settleMs,
          status: projection.status,
          decision: projection.decision,
          messages: bundle.messages.map((message, i) => ({
            ...clone(message),
            messageRef: messageRefs[i],
            decision: projectedByRef.get(messageRefs[i]) || null,
          })),
          attachments: draft.attachments,
          policy: { ...clone(policy), scopeRef: lease.refCodec.scope(policy.scopeId) },
          draft,
        };
        item.revision = revisionOf(item);
        items.push(item);
      }
    }
    await this._assertCurrent(lease);
    return { items, decisions: clone(after.decisions), activation };
  }

  async _listChannel(meta, { nowMs, limit }) {
    let enabled;
    try {
      enabled = await this._enabled(meta);
      if (!enabled) return {
        items: [], decisions: [], generation: null, state: disabledState(meta), error: null,
      };
      await this._rawState(meta);
      const lease = await this._acquire(meta);
      try {
        const result = await this._readLease(meta, lease, { nowMs });
        if (!await this._enabled(meta)) fail('channel_disabled', `Channel ${meta.id} выключен.`, 404);
        const latestState = await this._rawState(meta);
        const state = sanitizeState(meta, true, latestState, result.activation);
        state.truncated = result.items.length > limit;
        return {
          items: result.items,
          decisions: result.decisions,
          generation: lease.generation,
          state,
          error: null,
        };
      } finally {
        await lease.release();
      }
    } catch (err) {
      const error = publicError(meta.id, err);
      return {
        items: [],
        decisions: [],
        generation: null,
        state: {
          ...(enabled ? sanitizeState(meta, true, { connection: 'degraded', reason: error.code }) : disabledState(meta)),
          readOnly: true,
        },
        error,
      };
    }
  }

  async list({ nowMs = Date.now(), limit = this.limit } = {}) {
    validateNow(nowMs);
    validateLimit(limit);
    const results = await Promise.all(this.channels.map((meta) => this._listChannel(meta, { nowMs, limit })));
    const internal = results.flatMap((result) => result.items).sort(itemOrder);
    const truncated = results.some((result) => result.state.truncated) || internal.length > limit;
    return {
      items: selectInboxItems(internal, limit).map(toPublicInboxItem),
      channels: results.map((result) => result.state),
      errors: results.map((result) => result.error).filter(Boolean),
      truncated,
      limit,
    };
  }

  /**
   * Server-only snapshot автомата. В отличие от `list()`, он сохраняет policy,
   * canonical refs и decisions для quota; наружу HTTP эти поля не маппятся.
   */
  async workerSnapshot({ nowMs = Date.now(), limit = this.limit } = {}) {
    validateNow(nowMs);
    validateLimit(limit);
    const results = await Promise.all(this.channels.map((meta) => (
      this._listChannel(meta, { nowMs, limit })
    )));
    return {
      channels: results.map((result) => ({
        state: clone(result.state),
        generation: result.generation,
        items: [...result.items].sort(itemOrder),
        decisions: clone(result.decisions),
        error: result.error ? clone(result.error) : null,
      })),
    };
  }

  /** Live gate перед передачей уже снятого snapshot модели; channel text не читает. */
  async workerGate(ref, { generation } = {}) {
    let decoded;
    try {
      decoded = decodeInboxRef(ref, { kind: 'item' });
    } catch (err) {
      fail('invalid_item_ref', err.message, 400, err);
    }
    const meta = this._channel(decoded.channel);
    if (!['string', 'number'].includes(typeof generation)
        || (typeof generation === 'string' && !generation)
        || (typeof generation === 'number' && !Number.isSafeInteger(generation))) {
      fail('invalid_worker_gate', 'Worker обязан передать snapshot generation.', 500);
    }
    if (!await this._enabled(meta)) fail('channel_disabled', `Channel ${meta.id} выключен.`, 404);
    const initial = await this._rawState(meta);
    if (initial.connection !== 'connected') {
      fail('channel_disconnected', `Channel ${meta.id} не подключён.`, 409);
    }
    const lease = await this._acquire(meta);
    try {
      if (decoded.accountRef !== lease.accountRef) {
        fail('account_changed', 'Worker item принадлежит прежнему account context.', 409);
      }
      if (generation !== lease.generation) {
        fail('account_changed', 'Worker snapshot принадлежит прежней runtime generation.', 409);
      }
      await this._assertCurrent(lease);
      const activation = await lease.inboxState.summary();
      if (activation.participation !== 'active') {
        fail('channel_deactivated', `Channel ${meta.id} не участвует в auto triage.`, 409);
      }
      if (!await this._enabled(meta)) fail('channel_disabled', `Channel ${meta.id} выключен.`, 404);
      const latest = await this._rawState(meta);
      if (latest.connection !== 'connected') {
        fail('channel_disconnected', `Channel ${meta.id} не подключён.`, 409);
      }
      await this._assertCurrent(lease);
      return { channel: meta.id };
    } finally {
      await lease.release();
    }
  }

  async summary({ nowMs = Date.now(), limit = this.limit } = {}) {
    validateNow(nowMs);
    validateLimit(limit);
    // Summary считает весь authoritative scan, а не selected public page:
    // иначе badge тихо занижает очередь при items > limit.
    const results = await Promise.all(this.channels.map((meta) => (
      this._listChannel(meta, { nowMs, limit })
    )));
    const counts = new Map(this.channels.map((meta) => [meta.id, {
      newCount: 0,
      mixedCount: 0,
      reviewCount: 0,
    }]));
    let itemCount = 0;
    for (const result of results) {
      itemCount += result.items.length;
      for (const item of result.items) {
        const own = counts.get(item.channel);
        // newCount сохраняет смысл «созрело для автомата», а reviewCount повторяет
        // вкладку человека «К разбору» и поэтому включает ещё hot new.
        if (item.status === 'new' && item.cold) own.newCount += 1;
        if (item.status === 'mixed') own.mixedCount += 1;
        if (actionableItem(item)) own.reviewCount += 1;
      }
    }
    return {
      newCount: [...counts.values()].reduce((sum, count) => sum + count.newCount, 0),
      mixedCount: [...counts.values()].reduce((sum, count) => sum + count.mixedCount, 0),
      reviewCount: [...counts.values()].reduce((sum, count) => sum + count.reviewCount, 0),
      truncated: results.some((result) => result.state.truncated) || itemCount > limit,
      channels: results.map((result) => ({
        id: result.state.id,
        ...counts.get(result.state.id),
        truncated: result.state.truncated,
      })),
      errors: results.map((result) => result.error).filter(Boolean),
    };
  }

  async _statusChannel(meta) {
    let enabled;
    try {
      enabled = await this._enabled(meta);
      if (!enabled) return { state: disabledState(meta), error: null };
      const rawState = await this._rawState(meta);
      const lease = await this._acquire(meta);
      try {
        await this._assertCurrent(lease);
        const activation = await lease.inboxState.summary();
        await this._assertCurrent(lease);
        return { state: sanitizeState(meta, true, rawState, activation), error: null };
      } finally {
        await lease.release();
      }
    } catch (err) {
      const error = publicError(meta.id, err);
      return {
        state: {
          ...(enabled ? sanitizeState(meta, true, { connection: 'degraded', reason: error.code }) : disabledState(meta)),
          readOnly: true,
        },
        error,
      };
    }
  }

  async status() {
    const results = await Promise.all(this.channels.map((meta) => this._statusChannel(meta)));
    return {
      channels: results.map((result) => result.state),
      errors: results.map((result) => result.error).filter(Boolean),
    };
  }

  _channel(id) {
    const meta = this.byId.get(id);
    if (!meta) fail('unknown_channel', `Inbox channel «${id}» не зарегистрирован.`, 404);
    return meta;
  }

  async _activationMutation(channel, body, action) {
    exactObject(body, ['activationVersion'], `${action} body`, 'invalid_request');
    if (!Number.isSafeInteger(body.activationVersion) || body.activationVersion < 0) {
      fail('invalid_request', 'activationVersion должен быть неотрицательным целым.', 400);
    }
    const meta = this._channel(channel);
    if (!await this._enabled(meta)) fail('channel_disabled', `Channel ${channel} выключен.`, 404);
    const initialState = await this._rawState(meta);
    if (initialState.connection !== 'connected') {
      fail('channel_disconnected', `Channel ${channel} не подключён.`, 409);
    }
    const lease = await this._acquire(meta);
    try {
      await this._assertCurrent(lease);
      const verifyCurrent = async () => {
        if (!await this._enabled(meta)) fail('channel_disabled', `Channel ${channel} выключен.`, 404);
        const liveState = await this._rawState(meta);
        if (liveState.connection !== 'connected') {
          fail('channel_disconnected', `Channel ${channel} не подключён.`, 409);
        }
        await this._assertCurrent(lease);
      };
      const activation = action === 'activate'
        ? await lease.inboxState.activate({
          expectedActivationVersion: body.activationVersion,
          createActivationMarker: lease.context.createActivationMarker.bind(lease.context),
          verifyReady: verifyCurrent,
          verifyCurrent,
        })
        : await lease.inboxState.deactivate({
          expectedActivationVersion: body.activationVersion,
          createActivationMarker: lease.context.createActivationMarker.bind(lease.context),
          beforeMarker: verifyCurrent,
          verifyCurrent,
        });
      await this._assertCurrent(lease);
      return { channel: { id: meta.id, label: meta.label }, activation };
    } finally {
      await lease.release();
    }
  }

  activate(channel, body) {
    return this._activationMutation(channel, body, 'activate');
  }

  deactivate(channel, body) {
    return this._activationMutation(channel, body, 'deactivate');
  }

  /**
   * Server-only resolve. Успешный результат передаёт caller-у lease; caller обязан
   * вызвать идемпотентный `release()` в finally после generation checks/side effects.
   */
  async resolveItem(ref, { nowMs = Date.now() } = {}) {
    validateNow(nowMs);
    let decoded;
    try {
      decoded = decodeInboxRef(ref, { kind: 'item' });
    } catch (err) {
      fail('invalid_item_ref', err.message, 400, err);
    }
    const meta = this._channel(decoded.channel);
    if (!await this._enabled(meta)) fail('channel_disabled', `Channel ${meta.id} выключен.`, 404);
    await this._rawState(meta);
    const lease = await this._acquire(meta);
    let transferred = false;
    try {
      if (decoded.accountRef !== lease.accountRef) {
        fail('account_changed', 'Item ref принадлежит прежнему account context.', 409);
      }
      await this._assertCurrent(lease);
      const result = await this._readLease(meta, lease, { nowMs });
      const canonical = lease.refCodec.decode(ref, 'item').ref;
      const item = result.items.find((candidate) => candidate.ref === canonical);
      if (!item) fail('stale_item', 'Item больше не существует в authorized Inbox.', 409);
      await this._assertCurrent(lease);
      if (!await this._enabled(meta)) fail('channel_disabled', `Channel ${meta.id} выключен.`, 404);
      const latestState = await this._rawState(meta);
      transferred = true;
      return {
        channel: { id: meta.id, label: meta.label },
        channelState: sanitizeState(meta, true, latestState, result.activation),
        accountRef: lease.accountRef,
        generation: lease.generation,
        refCodec: lease.refCodec,
        item,
        context: lease.context,
        release: lease.release,
      };
    } finally {
      if (!transferred) await lease.release();
    }
  }
}

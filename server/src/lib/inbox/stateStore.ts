// Строгое persisted state общего Inbox: activation epochs и решения по сообщениям.
//
// Один экземпляр обслуживает только одну доверенную пару channel + accountRef. Все
// read-modify-write проходят одну promise queue; обычная запись использует уникальный
// temp + atomic rename, а самая первая activation — temp + atomic hard-link, то есть
// create-if-absent без окна с частично записанным target.

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import {
  decodeActivationMarker,
  encodeActivationMarker,
  InboxActivationMarkerError,
} from './activation.ts';
import { assertAccountRef, assertChannel, InboxRefCodec, InboxRefError } from './identity.ts';

// `node:crypto` не экспортирует файловые constants; отдельная константа ниже нужна
// только для O_NOFOLLOW read. Такой импорт оставлен намеренно локальным к store.
import { constants as FS_CONSTANTS } from 'node:fs';

export const INBOX_STATE_SCHEMA = 1;
export const INBOX_STATE_LIMITS = Object.freeze({
  fileBytes: 64 * 1024 * 1024,
  epochs: 1024,
  decisions: 10_000,
  refsPerDecision: 10_000,
  decisionIdChars: 128,
  taskIdBytes: 512,
  taskUrlBytes: 8192,
  noteBytes: 32 * 1024,
  endReasonBytes: 256,
});

const TOP_KEYS = ['schemaVersion', 'channel', 'accountRef', 'activation', 'updatedAtMs', 'decisions'];
const ACTIVATION_KEYS = ['version', 'epochs'];
const EPOCH_KEYS = [
  'epoch',
  'startedAtMs',
  'startMarker',
  'endedAtMs',
  'endMarker',
  'endReason',
];
const DECISION_KEYS = [
  'decisionId',
  'version',
  'activationEpoch',
  'originItemRef',
  'messageRefs',
  'scopeRef',
  'status',
  'taskId',
  'taskUrl',
  'by',
  'note',
  'createdAtMs',
  'updatedAtMs',
  'decidedAtMs',
];
const DECISION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const STATUSES = new Set(['task', 'skipped']);
const AUTHORS = new Set(['human', 'auto']);

type Payload = Record<string, unknown>;

// Codec ссылок одной доверенной пары канал + аккаунт: состояние хранит только
// такие ссылки, и чужая сюда не попадёт даже из повреждённого файла.
interface RefCodecPort {
  channel?: string;
  accountRef?: string;
  decode: (ref: unknown, kind: string) => { ref?: unknown };
}

// Codec активации канала: маркер уходит в persisted state и возвращается обратно.
interface ActivationCodecPort {
  encode: (marker: unknown) => unknown;
  decode: (persisted: unknown) => unknown;
}

// Свидетель хода записи: канал вправе проверить свою готовность и текущего владельца
// прямо посреди мутации, но состояние он не меняет.
type ActivationWitness = (context: {
  channel: string;
  accountRef: string;
  activationVersion?: number;
}) => unknown;

export type InboxParticipation = 'never_activated' | 'active' | 'deactivated';
export type InboxDecisionStatus = 'task' | 'skipped';
export type InboxDecisionAuthor = 'human' | 'auto';

// Один период участия канала. Маркеры принадлежат каналу и наружу не выходят:
// их форму знает только его codec, а store хранит их как непрозрачный JSON.
export interface InboxActivationEpoch {
  epoch: number;
  startedAtMs: number;
  startMarker: unknown;
  endedAtMs: number | null;
  endMarker: unknown;
  endReason: string | null;
}

export interface InboxDecisionRecord {
  decisionId: string;
  version: number;
  activationEpoch: number;
  originItemRef: string;
  messageRefs: string[];
  scopeRef: string;
  status: InboxDecisionStatus;
  taskId: string | null;
  taskUrl: string;
  by: InboxDecisionAuthor;
  note: string;
  createdAtMs: number;
  updatedAtMs: number;
  decidedAtMs: number;
}

export interface InboxStateRecord {
  schemaVersion: number;
  channel: string;
  accountRef: string;
  activation: {
    version: number;
    epochs: InboxActivationEpoch[];
  };
  updatedAtMs: number;
  decisions: InboxDecisionRecord[];
}

export interface InboxActivationSummary {
  participation: InboxParticipation;
  activationVersion: number;
  currentEpoch: number | null;
  startedAtMs: number | null;
  endedAtMs: number | null;
  endReason: string | null;
}

export interface InboxDecisionSummary {
  decisionId: string;
  version: number;
  status: InboxDecisionStatus;
  taskId: string | null;
  taskUrl: string;
  by: InboxDecisionAuthor;
  note: string;
  decidedAtMs: number;
}

export interface InboxDecisionProjection {
  status: 'new' | 'mixed' | InboxDecisionStatus;
  decision: InboxDecisionSummary | null;
  messages: { messageRef: string; decision: InboxDecisionSummary | null }[];
}

export interface InboxActivationWindow {
  epoch: number;
  startMarker: unknown;
  endMarker: unknown;
}

// Чужая ошибка своего типа не обещает: текст и код читаются мягко, а решение
// принимается по ним, а не по instanceof.
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const errorCode = (err: unknown) => (err as { code?: unknown } | null)?.code;

const clone = <Value>(value: Value): Value => structuredClone(value);
const lexical = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// Последняя epoch есть всегда: пустой список отвергает валидатор, а до первой
// активации состояния нет вовсе. Отдельный helper избавляет от `at(-1)!` в каждом чтении.
function lastEpochOf(state: InboxStateRecord): InboxActivationEpoch {
  const epochs = state.activation.epochs;

  return epochs[epochs.length - 1] as InboxActivationEpoch;
}

export class InboxStateStoreError extends Error {
  code: string;

  statusCode: number;

  constructor(code: string, message: string, statusCode = 500, cause?: unknown) {
    super(message, cause ? { cause } : undefined);
    this.name = 'InboxStateStoreError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

// Явная аннотация типа обязательна: без неё TypeScript не считает вызов обрывом
// потока, и после проверки значение остаётся прежним.
const stateError: (
  code: string,
  message: string,
  statusCode?: number,
  cause?: unknown,
) => never = (code, message, statusCode = 500, cause) => {
  throw new InboxStateStoreError(code, message, statusCode, cause);
};

const isPlainObject = (value: unknown): value is Payload => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

function exactObject(value: unknown, keys: string[], where: string): void {
  if (!isPlainObject(value)) stateError('invalid_state', `${where}: ожидался объект.`);
  const own = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (own.length !== expected.length || own.some((key, i) => key !== expected[i])) {
    stateError('invalid_state', `${where}: поля не совпадают со schema v1.`);
  }
}

function safeMs(
  value: unknown,
  where: string,
  { nullable = false }: { nullable?: boolean } = {},
): number | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    stateError('invalid_state', `${where}: ожидались неотрицательные Unix milliseconds.`);
  }
  return value;
}

function boundedString(
  value: unknown,
  where: string,
  maxBytes: number,
  { empty = true, nullable = false }: { empty?: boolean; nullable?: boolean } = {},
): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'string') stateError('invalid_state', `${where}: ожидалась строка.`);
  const bytes = Buffer.byteLength(value, 'utf8');
  if ((!empty && bytes === 0) || bytes > maxBytes) {
    stateError('invalid_state', `${where}: строка имеет недопустимый размер.`);
  }
  return value;
}

function decodeOwnedRef(
  refCodec: RefCodecPort,
  ref: unknown,
  kind: string,
  where: string,
): string {
  try {
    return String(refCodec.decode(ref, kind).ref);
  } catch (err) {
    if (err instanceof InboxRefError) {
      stateError('invalid_state', `${where}: ${err.message}`, 500, err);
    }

    return stateError('invalid_state', `${where}: ref codec завершился ошибкой.`, 500, err);
  }
}

function validateEpoch(source: unknown, index: number, activationCodec: unknown) {
  const where = `activation.epochs[${index}]`;

  exactObject(source, EPOCH_KEYS, where);

  const raw = source as Payload;
  if (raw.epoch !== index + 1) stateError('invalid_state', `${where}.epoch: epochs должны идти с 1 без дыр.`);
  safeMs(raw.startedAtMs, `${where}.startedAtMs`);
  try {
    decodeActivationMarker(activationCodec, raw.startMarker);
  } catch (err) {
    if (err instanceof InboxActivationMarkerError) {
      stateError('invalid_activation_marker', `${where}.startMarker: ${err.message}`, 500, err);
    }
    throw err;
  }

  const open = raw.endedAtMs === null || raw.endMarker === null || raw.endReason === null;
  if (open) {
    if (raw.endedAtMs !== null || raw.endMarker !== null || raw.endReason !== null) {
      stateError('invalid_state', `${where}: у открытой epoch все end-поля должны быть null.`);
    }
  } else {
    safeMs(raw.endedAtMs, `${where}.endedAtMs`);
    boundedString(raw.endReason, `${where}.endReason`, INBOX_STATE_LIMITS.endReasonBytes, { empty: false });
    try {
      decodeActivationMarker(activationCodec, raw.endMarker);
    } catch (err) {
      if (err instanceof InboxActivationMarkerError) {
        stateError('invalid_activation_marker', `${where}.endMarker: ${err.message}`, 500, err);
      }
      throw err;
    }
  }
  return open;
}

function validateDecision(source: unknown, index: number, { refCodec, epochCount, assigned, ids }: {
  refCodec: RefCodecPort;
  epochCount: number;
  assigned: Map<string, unknown>;
  ids: Set<unknown>;
}): Payload {
  const where = `decisions[${index}]`;

  exactObject(source, DECISION_KEYS, where);

  const raw = source as Payload;
  if (typeof raw.decisionId !== 'string' || !DECISION_ID_RE.test(raw.decisionId)) {
    stateError('invalid_state', `${where}.decisionId: ожидался collision-resistant ASCII id.`);
  }
  if (ids.has(raw.decisionId)) stateError('invalid_state', `${where}.decisionId: duplicate id.`);
  ids.add(raw.decisionId);
  if (typeof raw.version !== 'number' || !Number.isSafeInteger(raw.version) || raw.version < 1) {
    stateError('invalid_state', `${where}.version: ожидалось положительное целое.`);
  }
  if (typeof raw.activationEpoch !== 'number'
    || !Number.isSafeInteger(raw.activationEpoch)
    || raw.activationEpoch < 1
    || raw.activationEpoch > epochCount) {
    stateError('invalid_state', `${where}.activationEpoch не принадлежит сохранённому interval.`);
  }
  decodeOwnedRef(refCodec, raw.originItemRef, 'item', `${where}.originItemRef`);
  decodeOwnedRef(refCodec, raw.scopeRef, 'scope', `${where}.scopeRef`);

  if (!Array.isArray(raw.messageRefs)
    || raw.messageRefs.length < 1
    || raw.messageRefs.length > INBOX_STATE_LIMITS.refsPerDecision) {
    stateError('invalid_state', `${where}.messageRefs: ожидался непустой ограниченный массив.`);
  }

  const canonicalRefs = (raw.messageRefs as unknown[]).map((ref, i) => (
    decodeOwnedRef(refCodec, ref, 'message', `${where}.messageRefs[${i}]`)
  ));
  const sorted = [...canonicalRefs].sort(lexical);
  if (canonicalRefs.some((ref, i) => ref !== sorted[i])) {
    stateError('invalid_state', `${where}.messageRefs должны быть canonical sorted unique set.`);
  }
  for (let i = 0; i < canonicalRefs.length; i += 1) {
    if (i > 0 && canonicalRefs[i] === canonicalRefs[i - 1]) {
      stateError('invalid_state', `${where}.messageRefs содержит duplicate.`);
    }
    const key = String(canonicalRefs[i]);
    const owner = assigned.get(key);

    if (owner) {
      stateError('invalid_state', `${where}.messageRefs пересекается с decision ${String(owner)}.`);
    }
    assigned.set(key, raw.decisionId);
  }

  if (!STATUSES.has(raw.status as string)) {
    stateError('invalid_state', `${where}.status: бывает task|skipped.`);
  }
  if (!AUTHORS.has(raw.by as string)) stateError('invalid_state', `${where}.by: бывает human|auto.`);
  if (raw.status === 'task') {
    boundedString(raw.taskId, `${where}.taskId`, INBOX_STATE_LIMITS.taskIdBytes, { empty: false });
    boundedString(raw.taskUrl, `${where}.taskUrl`, INBOX_STATE_LIMITS.taskUrlBytes);
  } else if (raw.taskId !== null || raw.taskUrl !== '') {
    stateError('invalid_state', `${where}: skipped decision требует taskId=null и taskUrl="".`);
  }
  boundedString(raw.note, `${where}.note`, INBOX_STATE_LIMITS.noteBytes);
  safeMs(raw.createdAtMs, `${where}.createdAtMs`);
  safeMs(raw.updatedAtMs, `${where}.updatedAtMs`);
  safeMs(raw.decidedAtMs, `${where}.decidedAtMs`);
  if (Number(raw.updatedAtMs) < Number(raw.createdAtMs)) {
    stateError('invalid_state', `${where}.updatedAtMs не может быть раньше createdAtMs.`);
  }
  return raw;
}

/** Строгая проверка persisted schema с owner/codec контекстом. */
export function validateInboxState(source: unknown, {
  channel,
  accountRef,
  refCodec,
  activationCodec,
  maxEpochs = INBOX_STATE_LIMITS.epochs,
}: {
  channel?: unknown;
  accountRef?: unknown;
  refCodec?: RefCodecPort;
  activationCodec?: unknown;
  maxEpochs?: number;
} = {}): InboxStateRecord {
  const trustedChannel = assertChannel(channel);
  const trustedAccountRef = assertAccountRef(accountRef);

  exactObject(source, TOP_KEYS, 'InboxState');

  const raw = source as Payload;
  const codec = refCodec as RefCodecPort;
  if (raw.schemaVersion !== INBOX_STATE_SCHEMA) {
    stateError('unsupported_state_schema', 'InboxState.schemaVersion: поддерживается только v1.');
  }
  if (raw.channel !== trustedChannel || raw.accountRef !== trustedAccountRef) {
    stateError('account_changed', 'InboxState owner не совпадает с trusted channel/accountRef.', 409);
  }
  exactObject(raw.activation, ACTIVATION_KEYS, 'InboxState.activation');

  const activation = raw.activation as Payload;

  if (!Array.isArray(activation.epochs)
    || activation.epochs.length < 1
    || activation.epochs.length > maxEpochs) {
    stateError('invalid_state', `activation.epochs: ожидалось 1..${maxEpochs} epochs.`);
  }

  const epochs = activation.epochs as Payload[];
  let openIndex = -1;

  epochs.forEach((epoch, i) => {
    const open = validateEpoch(epoch, i, activationCodec);
    if (open) {
      if (openIndex !== -1 || i !== epochs.length - 1) {
        stateError('invalid_state', 'Только последняя activation epoch может быть открыта.');
      }
      openIndex = i;
    }
  });
  const count = epochs.length;
  const expectedVersion = openIndex === count - 1 ? 2 * count - 1 : 2 * count;

  if (activation.version !== expectedVersion) {
    stateError('invalid_state', `activation.version должна быть ${expectedVersion}.`);
  }
  safeMs(raw.updatedAtMs, 'InboxState.updatedAtMs');
  if (!Array.isArray(raw.decisions) || raw.decisions.length > INBOX_STATE_LIMITS.decisions) {
    stateError('invalid_state', `decisions: допускается не больше ${INBOX_STATE_LIMITS.decisions} записей.`);
  }

  const assigned = new Map<string, unknown>();
  const ids = new Set<unknown>();

  (raw.decisions as unknown[]).forEach((decision, i) => validateDecision(decision, i, {
    refCodec: codec,
    epochCount: count,
    assigned,
    ids,
  }));

  return clone(raw) as unknown as InboxStateRecord;
}

function participationOf(state: InboxStateRecord | null): InboxParticipation {
  if (!state) return 'never_activated';

  return lastEpochOf(state).endedAtMs === null ? 'active' : 'deactivated';
}

/** Public activation summary: markers и accountRef принципиально не попадают наружу. */
export function activationSummaryOf(state: InboxStateRecord | null): InboxActivationSummary {
  if (!state) {
    return {
      participation: 'never_activated',
      activationVersion: 0,
      currentEpoch: null,
      startedAtMs: null,
      endedAtMs: null,
      endReason: null,
    };
  }

  const epoch = lastEpochOf(state);

  return {
    participation: participationOf(state),
    activationVersion: state.activation.version,
    currentEpoch: epoch.epoch,
    startedAtMs: epoch.startedAtMs,
    endedAtMs: epoch.endedAtMs,
    endReason: epoch.endReason,
  };
}

function safeDecisionSummary(decision: InboxDecisionRecord): InboxDecisionSummary {
  return {
    decisionId: decision.decisionId,
    version: decision.version,
    status: decision.status,
    taskId: decision.taskId,
    taskUrl: decision.taskUrl,
    by: decision.by,
    note: decision.note,
    decidedAtMs: decision.decidedAtMs,
  };
}

/** Coverage projection для пересобранного item после split/merge. */
export function projectDecisionState(
  messageRefs: unknown,
  decisions: unknown,
): InboxDecisionProjection {
  if (!Array.isArray(messageRefs) || !Array.isArray(decisions)) {
    stateError('invalid_projection', 'Projection требует массивы messageRefs и decisions.', 400);
  }

  const assignment = new Map<string, InboxDecisionRecord>();

  for (const decision of decisions as InboxDecisionRecord[]) {
    for (const ref of decision.messageRefs || []) {
      if (assignment.has(ref)) stateError('invalid_state', 'Projection получила overlapping decisions.');
      assignment.set(ref, decision);
    }
  }

  const messages = (messageRefs as string[]).map((messageRef) => {
    const decision = assignment.get(messageRef) || null;

    return { messageRef, decision: decision ? safeDecisionSummary(decision) : null };
  });
  const hits = messages
    .map((entry) => entry.decision)
    .filter((decision): decision is InboxDecisionSummary => Boolean(decision));

  if (hits.length === 0 || !hits[0]) return { status: 'new', decision: null, messages };

  const first = hits[0];
  const same = hits.length === messages.length
    && hits.every((decision) => decision.decisionId === first.decisionId);

  if (same) return { status: first.status, decision: first, messages };

  return { status: 'mixed', decision: null, messages };
}

function validateExpectedVersion(value: unknown, where: string): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    stateError('invalid_request', `${where}: ожидалось неотрицательное целое.`, 400);
  }
}

function validateMutationTime(value: unknown, where = 'nowMs'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    stateError('invalid_request', `${where}: ожидались неотрицательные Unix milliseconds.`, 400);
  }

  return value;
}

function uniqueSortedRefs(refs: unknown, refCodec: RefCodecPort): string[] {
  if (!Array.isArray(refs)
    || refs.length < 1
    || refs.length > INBOX_STATE_LIMITS.refsPerDecision) {
    stateError('invalid_selection', 'messageRefs должен быть непустым ограниченным массивом.', 400);
  }

  const canonical = (refs as unknown[]).map((ref, i) => {
    try {
      return String(refCodec.decode(ref, 'message').ref);
    } catch (err) {
      return stateError('invalid_selection', `messageRefs[${i}]: ${errorText(err)}`, 400, err);
    }
  });

  if (new Set(canonical).size !== canonical.length) {
    stateError('invalid_selection', 'messageRefs содержит duplicate.', 400);
  }

  return canonical.sort(lexical);
}

export class InboxStateStore {
  file: string;

  channel: string;

  accountRef: string;

  refCodec: RefCodecPort;

  activationCodec: ActivationCodecPort;

  maxEpochs: number;

  createDecisionId: () => string;

  queue: Promise<unknown>;

  constructor({
    file,
    channel,
    accountRef,
    refCodec,
    activationCodec,
    maxEpochs = INBOX_STATE_LIMITS.epochs,
    createDecisionId = randomUUID,
  }: {
    file?: unknown;
    channel?: unknown;
    accountRef?: unknown;
    refCodec?: RefCodecPort;
    activationCodec?: ActivationCodecPort;
    maxEpochs?: number;
    createDecisionId?: () => string;
  }) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) {
      stateError('invalid_store_config', 'InboxStateStore.file должен быть абсолютным trusted path.');
    }
    this.file = file;
    this.channel = assertChannel(channel);
    this.accountRef = assertAccountRef(accountRef);
    this.refCodec = refCodec || new InboxRefCodec({ channel, accountRef });
    if (this.refCodec.channel !== undefined && this.refCodec.channel !== this.channel) {
      stateError('invalid_store_config', 'refCodec привязан к другому channel.');
    }
    if (this.refCodec.accountRef !== undefined && this.refCodec.accountRef !== this.accountRef) {
      stateError('invalid_store_config', 'refCodec привязан к другому accountRef.');
    }
    if (!activationCodec
      || typeof activationCodec.encode !== 'function'
      || typeof activationCodec.decode !== 'function') {
      stateError('invalid_store_config', 'InboxStateStore требует channel-specific activationCodec.');
    }
    if (!Number.isSafeInteger(maxEpochs) || maxEpochs < 1 || maxEpochs > INBOX_STATE_LIMITS.epochs) {
      stateError('invalid_store_config', `maxEpochs должен быть 1..${INBOX_STATE_LIMITS.epochs}.`);
    }
    if (typeof createDecisionId !== 'function') {
      stateError('invalid_store_config', 'createDecisionId должен быть функцией.');
    }
    this.activationCodec = activationCodec;
    this.maxEpochs = maxEpochs;
    this.createDecisionId = createDecisionId;
    this.queue = Promise.resolve();
  }

  _enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.queue.then(operation, operation);

    this.queue = result.catch(() => {});

    return result;
  }

  _validate(raw: unknown): InboxStateRecord {
    return validateInboxState(raw, {
      channel: this.channel,
      accountRef: this.accountRef,
      refCodec: this.refCodec,
      activationCodec: this.activationCodec,
      maxEpochs: this.maxEpochs,
    });
  }

  async _read(): Promise<InboxStateRecord | null> {
    let handle: fs.FileHandle | null | undefined;

    try {
      handle = await fs.open(this.file, FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.size > INBOX_STATE_LIMITS.fileBytes) {
        stateError('invalid_state', 'Inbox state не является обычным ограниченным файлом.');
      }
      const body = await handle.readFile('utf8');
      let parsed: unknown;

      try {
        parsed = JSON.parse(body);
      } catch (err) {
        stateError('invalid_state', `Inbox state содержит битый JSON: ${errorText(err)}`, 500, err);
      }

      return this._validate(parsed);
    } catch (err) {
      if (errorCode(err) === 'ENOENT') return null;
      if (err instanceof InboxStateStoreError) throw err;

      return stateError('state_unreadable', `Inbox state не прочитан: ${errorText(err)}`, 500, err);
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async read(): Promise<InboxStateRecord | null> {
    return this._enqueue(async () => clone(await this._read()));
  }

  async summary(): Promise<InboxActivationSummary> {
    return activationSummaryOf(await this.read());
  }

  async activationWindows(): Promise<InboxActivationWindow[]> {
    const state = await this.read();
    if (!state) return [];
    return state.activation.epochs.map((epoch) => ({
      epoch: epoch.epoch,
      startMarker: decodeActivationMarker(this.activationCodec, epoch.startMarker),
      endMarker: epoch.endMarker === null
        ? null
        : decodeActivationMarker(this.activationCodec, epoch.endMarker),
    }));
  }

  _serialize(state: InboxStateRecord): string {
    const validated = this._validate(state);

    return `${JSON.stringify(validated, null, 2)}\n`;
  }

  async _writeTemp(body: string): Promise<string> {
    const dir = path.dirname(this.file);

    await fs.mkdir(dir, { recursive: true, mode: 0o700 });

    const temp = path.join(dir, `.${path.basename(this.file)}.${process.pid}.${randomUUID()}.tmp`);
    let handle: fs.FileHandle | null | undefined;

    try {
      handle = await fs.open(temp, 'wx', 0o600);
      await handle.writeFile(body, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      return temp;
    } catch (err) {
      await handle?.close().catch(() => {});
      await fs.unlink(temp).catch(() => {});
      throw err;
    }
  }

  async _replace(state: InboxStateRecord): Promise<void> {
    const temp = await this._writeTemp(this._serialize(state));
    try {
      await fs.rename(temp, this.file);
    } finally {
      await fs.unlink(temp).catch(() => {});
    }
  }

  async _createIfAbsent(state: InboxStateRecord): Promise<boolean> {
    const temp = await this._writeTemp(this._serialize(state));

    try {
      await fs.link(temp, this.file);
      return true;
    } catch (err) {
      if (errorCode(err) === 'EEXIST') return false;
      throw err;
    } finally {
      await fs.unlink(temp).catch(() => {});
    }
  }

  async activate({
    expectedActivationVersion,
    createActivationMarker,
    nowMs = Date.now(),
    verifyReady,
    verifyCurrent,
  }: {
    expectedActivationVersion?: unknown;
    createActivationMarker?: (context: { nowMs: number }) => unknown;
    nowMs?: number;
    verifyReady?: ActivationWitness;
    verifyCurrent?: ActivationWitness;
  }): Promise<InboxActivationSummary> {
    validateExpectedVersion(expectedActivationVersion, 'expectedActivationVersion');
    validateMutationTime(nowMs);
    if (typeof createActivationMarker !== 'function') {
      stateError('invalid_request', 'activate требует server-side createActivationMarker.', 400);
    }
    return this._enqueue(async () => {
      const current = await this._read();
      if (current && participationOf(current) === 'active') return activationSummaryOf(current);
      const version = current?.activation.version ?? 0;
      if (version !== expectedActivationVersion) {
        stateError('stale_activation', 'Activation state уже изменился.', 409);
      }
      if (current && current.activation.epochs.length >= this.maxEpochs) {
        stateError('activation_epoch_overflow', 'Достигнут предел activation epochs; нужна operator compaction.', 409);
      }
      await verifyReady?.({ channel: this.channel, accountRef: this.accountRef, activationVersion: version });
      await verifyCurrent?.({ channel: this.channel, accountRef: this.accountRef });
      const marker = await createActivationMarker({ nowMs });
      let encoded: unknown;

      try {
        encoded = encodeActivationMarker(this.activationCodec, marker);
      } catch (err) {
        stateError('invalid_activation_marker', errorText(err), 500, err);
      }
      await verifyCurrent?.({ channel: this.channel, accountRef: this.accountRef });

      const epochNumber = (current?.activation.epochs.length ?? 0) + 1;
      const epoch: InboxActivationEpoch = {
        epoch: epochNumber,
        startedAtMs: nowMs,
        startMarker: encoded,
        endedAtMs: null,
        endMarker: null,
        endReason: null,
      };
      const next: InboxStateRecord = current ? {
        ...current,
        activation: {
          version: version + 1,
          epochs: [...current.activation.epochs, epoch],
        },
        updatedAtMs: nowMs,
      } : {
        schemaVersion: INBOX_STATE_SCHEMA,
        channel: this.channel,
        accountRef: this.accountRef,
        activation: { version: 1, epochs: [epoch] },
        updatedAtMs: nowMs,
        decisions: [],
      };

      if (current) {
        await this._replace(next);
        return activationSummaryOf(next);
      }
      if (await this._createIfAbsent(next)) return activationSummaryOf(next);
      const raced = await this._read();
      if (raced && participationOf(raced) === 'active') return activationSummaryOf(raced);

      return stateError(
        'stale_activation',
        'Первую activation одновременно изменил другой writer.',
        409,
      );
    });
  }

  async deactivate({
    expectedActivationVersion,
    createActivationMarker,
    nowMs = Date.now(),
    endReason = 'manual',
    beforeMarker,
    verifyCurrent,
  }: {
    expectedActivationVersion?: unknown;
    createActivationMarker?: (context: { nowMs: number }) => unknown;
    nowMs?: number;
    endReason?: string;
    beforeMarker?: ActivationWitness;
    verifyCurrent?: ActivationWitness;
  }): Promise<InboxActivationSummary> {
    validateExpectedVersion(expectedActivationVersion, 'expectedActivationVersion');
    validateMutationTime(nowMs);
    if (typeof createActivationMarker !== 'function') {
      stateError('invalid_request', 'deactivate требует server-side createActivationMarker.', 400);
    }
    boundedString(endReason, 'endReason', INBOX_STATE_LIMITS.endReasonBytes, { empty: false });
    return this._enqueue(async () => {
      const current = await this._read();
      if (!current) stateError('never_activated', 'Канал ещё ни разу не был activated.', 409);
      if (participationOf(current) === 'deactivated') return activationSummaryOf(current);
      if (current.activation.version !== expectedActivationVersion) {
        stateError('stale_activation', 'Activation state уже изменился.', 409);
      }
      await beforeMarker?.({ channel: this.channel, accountRef: this.accountRef });
      await verifyCurrent?.({ channel: this.channel, accountRef: this.accountRef });
      const marker = await createActivationMarker({ nowMs });
      let encoded: unknown;

      try {
        encoded = encodeActivationMarker(this.activationCodec, marker);
      } catch (err) {
        stateError('invalid_activation_marker', errorText(err), 500, err);
      }
      await verifyCurrent?.({ channel: this.channel, accountRef: this.accountRef });

      const epochs = current.activation.epochs.map((epoch, i) => (
        i === current.activation.epochs.length - 1
          ? { ...epoch, endedAtMs: nowMs, endMarker: encoded, endReason }
          : epoch
      ));
      const next: InboxStateRecord = {
        ...current,
        activation: { version: current.activation.version + 1, epochs },
        updatedAtMs: nowMs,
      };
      await this._replace(next);
      return activationSummaryOf(next);
    });
  }

  _nextDecisionId(existing: Set<string>): string {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const id = this.createDecisionId();

      if (typeof id !== 'string' || !DECISION_ID_RE.test(id)) {
        stateError('invalid_decision_id', 'createDecisionId вернул невалидный collision-resistant id.');
      }
      if (!existing.has(id)) return id;
    }

    return stateError('decision_id_collision', 'Не удалось создать уникальный decisionId.');
  }

  async decide({
    activationEpoch,
    originItemRef,
    messageRefs,
    scopeRef,
    status,
    taskId = null,
    taskUrl = '',
    by = 'human',
    note = '',
    decidedAtMs = Date.now(),
    requireActive = false,
  }: {
    activationEpoch?: unknown;
    originItemRef?: unknown;
    messageRefs?: unknown;
    scopeRef?: unknown;
    status?: unknown;
    taskId?: string | null;
    taskUrl?: string;
    by?: string;
    note?: string;
    decidedAtMs?: number;
    requireActive?: boolean;
  }): Promise<InboxDecisionRecord> {
    validateMutationTime(decidedAtMs, 'decidedAtMs');

    const refs = uniqueSortedRefs(messageRefs, this.refCodec);
    let itemRef: string;
    let canonicalScopeRef: string;

    try {
      itemRef = String(this.refCodec.decode(originItemRef, 'item').ref);
      canonicalScopeRef = String(this.refCodec.decode(scopeRef, 'scope').ref);
    } catch (err) {
      return stateError('invalid_decision', errorText(err), 400, err);
    }
    if (!STATUSES.has(status as string) || !AUTHORS.has(by)) {
      stateError('invalid_decision', 'Decision требует status task|skipped и by human|auto.', 400);
    }
    if (typeof requireActive !== 'boolean') {
      stateError('invalid_decision', 'Decision requireActive должен быть boolean.', 400);
    }
    if (typeof activationEpoch !== 'number'
      || !Number.isSafeInteger(activationEpoch)
      || activationEpoch < 1) {
      stateError('invalid_decision', 'activationEpoch должен быть положительным целым.', 400);
    }
    if (status === 'task') {
      if (typeof taskId !== 'string' || !taskId) {
        stateError('invalid_decision', 'Task decision требует строковый taskId.', 400);
      }
    } else if (taskId !== null || taskUrl !== '') {
      stateError('invalid_decision', 'Skipped decision требует taskId=null и taskUrl="".', 400);
    }
    if (typeof taskUrl !== 'string' || typeof note !== 'string') {
      stateError('invalid_decision', 'taskUrl и note должны быть строками.', 400);
    }

    return this._enqueue(async () => {
      const current = await this._read();
      if (!current) stateError('never_activated', 'Decision нельзя записать до первой activation.', 409);
      if (requireActive && participationOf(current) !== 'active') {
        stateError('channel_deactivated', 'Auto decision запрещён после деактивации канала.', 409);
      }
      if (activationEpoch > current.activation.epochs.length) {
        stateError('stale_item', 'Item принадлежит неизвестной activation epoch.', 409);
      }
      const assigned = new Set(current.decisions.flatMap((decision) => decision.messageRefs));
      if (refs.some((ref) => assigned.has(ref))) {
        stateError('stale_item', 'Хотя бы одно сообщение уже принадлежит decision.', 409);
      }
      if (current.decisions.length >= INBOX_STATE_LIMITS.decisions) {
        stateError('decision_limit', 'Достигнут предел decisions; unsafe pruning запрещён.', 409);
      }
      const decisionId = this._nextDecisionId(
        new Set(current.decisions.map((decision) => decision.decisionId)),
      );
      const decision: InboxDecisionRecord = {
        decisionId,
        version: 1,
        activationEpoch,
        originItemRef: itemRef,
        messageRefs: refs,
        scopeRef: canonicalScopeRef,
        status: status as InboxDecisionStatus,
        taskId,
        taskUrl,
        by: by as InboxDecisionAuthor,
        note,
        createdAtMs: decidedAtMs,
        updatedAtMs: decidedAtMs,
        decidedAtMs,
      };
      const next: InboxStateRecord = {
        ...current,
        updatedAtMs: decidedAtMs,
        decisions: [...current.decisions, decision],
      };
      await this._replace(next);
      return clone(decision);
    });
  }

  async reset({ decisionId, expectedVersion, messageRefs, nowMs = Date.now() }: {
    decisionId?: unknown;
    expectedVersion?: unknown;
    messageRefs?: unknown;
    nowMs?: number;
  }): Promise<InboxDecisionRecord | null> {
    validateMutationTime(nowMs);
    if (typeof decisionId !== 'string' || !DECISION_ID_RE.test(decisionId)) {
      stateError('invalid_request', 'decisionId имеет невалидный формат.', 400);
    }
    if (typeof expectedVersion !== 'number'
      || !Number.isSafeInteger(expectedVersion)
      || expectedVersion < 1) {
      stateError('invalid_request', 'expectedVersion должен быть положительным целым.', 400);
    }
    const refs = uniqueSortedRefs(messageRefs, this.refCodec);
    return this._enqueue(async () => {
      const current = await this._read();
      if (!current) stateError('stale_decision', 'Decision уже отсутствует.', 409);
      const index = current.decisions.findIndex((decision) => decision.decisionId === decisionId);
      const decision = current.decisions[index];
      if (!decision || decision.version !== expectedVersion) {
        stateError('stale_decision', 'Decision уже изменился.', 409);
      }
      if (decision.status === 'task') {
        stateError('task_reset_forbidden', 'Task decision нельзя reset: B24 task уже создан.', 409);
      }
      const own = new Set(decision.messageRefs);
      if (refs.some((ref) => !own.has(ref))) {
        stateError('stale_decision', 'Reset subset больше не принадлежит этой версии decision.', 409);
      }
      const remove = new Set(refs);
      const residual = decision.messageRefs.filter((ref) => !remove.has(ref));
      const decisions = [...current.decisions];
      let updated: InboxDecisionRecord | null = null;

      if (residual.length) {
        updated = {
          ...decision,
          version: decision.version + 1,
          messageRefs: residual,
          updatedAtMs: nowMs,
        };
        decisions[index] = updated;
      } else {
        decisions.splice(index, 1);
      }
      const next: InboxStateRecord = { ...current, updatedAtMs: nowMs, decisions };

      await this._replace(next);

      return updated ? clone(updated) : null;
    });
  }
}

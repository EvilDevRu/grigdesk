// Durable single-writer archive GitHub Issues.
//
// Каждая новая transport delivery получает монотонный ingestion seq. Первый
// semantic issue сохраняет immutable snapshot; повтор того же issue с другим
// immutable webhook transport дописывается как receipt, но list() возвращает
// только первую запись. REST Issues API отдаёт mutable текущую проекцию, поэтому
// её позднее изменение считается semantic duplicate/no-op, а не конфликтом и не
// новым receipt. Поэтому edit и redelivery после новой activation boundary не
// воскрешают issue, впервые попавший в закрытый gap.
import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';

import { assertAccountRef } from '../inbox/identity.ts';
import type { Stats } from 'node:fs';
import {
  GitHubStoreError,
  normalizeGitHubRepositoryId,
  readStableFileNoFollow,
} from './accountBindings.ts';

const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_ROW_BYTES = 2 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const MAX_SNAPSHOT_DEPTH = 24;
const MAX_SNAPSHOT_ENTRIES = 20_000;
const ROW_KEYS = [
  'schemaVersion', 'channel', 'accountRef', 'seq', 'transport', 'semanticKey',
  'repositoryId', 'issueId', 'occurredAt', 'firstSeq', 'duplicateOfSeq', 'snapshot',
];
const TRANSPORT_KEYS = ['kind', 'id'];
const APPEND_KEYS = ['transport', 'repositoryId', 'issueId', 'semanticKey', 'occurredAt', 'snapshot'];
const TRANSPORT_KINDS = new Set(['webhook', 'rest']);
const TRANSPORT_ID_RE = /^[\x21-\x7e]{1,512}$/;

// Доставка, принёсшая issue. Webhook неизменяем и годится как ключ повтора, а
// REST отдаёт текущую проекцию: она законно меняется после правки issue.
export interface ArchiveTransport {
  kind: string;
  id: string;
}

export interface ArchiveRow {
  schemaVersion: 1;
  channel: 'github';
  accountRef: string;
  seq: number;
  transport: ArchiveTransport;
  semanticKey: string;
  repositoryId: string;
  issueId: string;
  occurredAt: number;
  firstSeq: number;
  duplicateOfSeq: number | null;
  snapshot: Payload;
  snapshotJson: string;
}

export interface ArchiveAppendResult {
  appended: boolean;
  inserted: boolean;
  duplicate: boolean;
  seq: number;
  row: Omit<ArchiveRow, 'snapshotJson'>;
}

export interface ArchiveListOptions {
  afterSeq?: number;
  throughSeq?: number | null;
  limit?: number;
}

export interface GitHubArchiveStoreOptions {
  dir?: string;
  accountRef?: unknown;
  repositoryId?: unknown;
}

interface IndexedRow {
  row: ArchiveRow;
  fingerprint: string;
}

type Payload = Record<string, unknown>;

function fail(code: string, message: string, cause: unknown = null): never {
  throw new GitHubStoreError(code, message, cause);
}

// Код ошибки файловой системы: пропажа файла — обычное состояние, остальное нет.
function failureCode(error: unknown): string {
  const code = error !== null && typeof error === 'object'
    ? (error as { code?: unknown }).code
    : undefined;

  return typeof code === 'string' ? code : '';
}

function isPlainObject(value: unknown): value is Payload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exactObject(value: unknown, keys: string[], where: string): void {
  if (!isPlainObject(value)) fail('github_archive_invalid', `${where}: ожидался объект.`);
  const own = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (own.length !== expected.length || own.some((key, index) => key !== expected[index])) {
    fail('github_archive_invalid', `${where}: схема полей не совпадает с версией 1.`);
  }
}

function normalizeIssueId(value: unknown, where = 'issueId'): string {
  try { return normalizeGitHubRepositoryId(value, where); } catch (err) {
    fail('github_archive_invalid', `${where}: ожидалась каноническая positive decimal-строка.`, err);
  }
}

function normalizeTransport(source: unknown): ArchiveTransport {
  exactObject(source, TRANSPORT_KEYS, 'transport');
  const raw = source as Payload;
  if (!TRANSPORT_KINDS.has(raw.kind as string) || typeof raw.id !== 'string'
      || !TRANSPORT_ID_RE.test(raw.id) || /[\\"\s]/u.test(raw.id)) {
    fail(
      'github_archive_invalid',
      'transport должен содержать kind webhook|rest и bounded opaque ASCII id.',
    );
  }

  return { kind: raw.kind as string, id: raw.id };
}

function transportKey(transport: ArchiveTransport): string {
  return JSON.stringify([1, transport.kind, transport.id]);
}

/** Collision-free semantic identity issue в одном provider namespace. */
export function githubIssueSemanticKey(repositoryId: unknown, issueId: unknown): string {
  return JSON.stringify([
    1,
    'github.com',
    'issue',
    normalizeGitHubRepositoryId(repositoryId),
    normalizeIssueId(issueId),
  ]);
}

function canonicalJsonValue(value: unknown, depth: number, budget: { count: number }): unknown {
  if (depth > MAX_SNAPSHOT_DEPTH) {
    fail('github_archive_invalid', 'snapshot превышает допустимую глубину.');
  }
  budget.count += 1;
  if (budget.count > MAX_SNAPSHOT_ENTRIES) {
    fail('github_archive_invalid', 'snapshot содержит слишком много значений.');
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('github_archive_invalid', 'snapshot содержит не finite number.');
    return value;
  }
  if (Array.isArray(value)) {
    return (value as unknown[]).map((item) => canonicalJsonValue(item, depth + 1, budget));
  }
  if (!isPlainObject(value)) {
    fail('github_archive_invalid', 'snapshot должен состоять только из JSON-safe plain values.');
  }
  const out = Object.create(null) as Payload;
  for (const key of Object.keys(value).sort()) {
    if (Buffer.byteLength(key, 'utf8') > 1024) {
      fail('github_archive_invalid', 'snapshot содержит слишком длинное имя поля.');
    }
    out[key] = canonicalJsonValue(value[key], depth + 1, budget);
  }
  return out;
}

function normalizeSnapshot(value: unknown): { value: Payload; json: string } {
  if (!isPlainObject(value)) fail('github_archive_invalid', 'snapshot issue должен быть объектом.');
  const canonical = canonicalJsonValue(value, 0, { count: 0 });
  const json = JSON.stringify(canonical);
  if (Buffer.byteLength(json, 'utf8') > MAX_SNAPSHOT_BYTES) {
    fail('github_archive_invalid', 'snapshot issue превышает лимит 1 MiB.');
  }
  return { value: JSON.parse(json) as Payload, json };
}

function safeSeq(value: unknown, where: string, { zero = false }: { zero?: boolean } = {}): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (zero ? 0 : 1)) {
    const shape = zero ? 'неотрицательный' : 'положительный';

    fail('github_archive_invalid', `${where}: ожидался ${shape} safe integer.`);
  }

  return value;
}

function safeOccurredAt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail('github_archive_invalid', 'occurredAt должен быть Unix seconds в safe integer.');
  }
  return value;
}

function fingerprint(
  { repositoryId, issueId, semanticKey, occurredAt, snapshotJson }: {
    repositoryId: string;
    issueId: string;
    semanticKey: string;
    occurredAt: number;
    snapshotJson: string;
  },
): string {
  return JSON.stringify([repositoryId, issueId, semanticKey, occurredAt, snapshotJson]);
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

async function syncDirectory(dir: string): Promise<void> {
  let handle;
  try {
    handle = await open(dir, constants.O_RDONLY
      | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0));
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

const clone = <Value>(value: Value): Value => JSON.parse(JSON.stringify(value)) as Value;
const cloneRow = ({ snapshotJson: _snapshotJson, ...row }: ArchiveRow) => clone(row);

export class GitHubArchiveStore {
  /** `dir` — account namespace; файл живёт в `archive/issues.ndjson`. */
  accountRef!: string;

  repositoryId: string;

  file: string;

  queue: Promise<unknown>;

  loading: Promise<void> | null;

  loaded: boolean;

  fileInfo: Stats | null;

  lastSeq: number;

  byTransport: Map<string, IndexedRow>;

  bySemantic: Map<string, IndexedRow>;

  rows: ArchiveRow[];

  constructor({ dir, accountRef, repositoryId }: GitHubArchiveStoreOptions) {
    if (typeof dir !== 'string' || !dir) throw new TypeError('GitHubArchiveStore: dir обязателен.');
    try { this.accountRef = assertAccountRef(accountRef) as string; } catch (err) {
      fail('github_archive_owner_mismatch', 'GitHubArchiveStore получил неверный accountRef.', err);
    }
    this.repositoryId = normalizeGitHubRepositoryId(repositoryId);
    this.file = path.join(dir, 'archive', 'issues.ndjson');
    this.queue = Promise.resolve();
    this.loading = null;
    this.loaded = false;
    this.fileInfo = null;
    this.lastSeq = 0;
    this.byTransport = new Map();
    this.bySemantic = new Map();
    this.rows = [];
  }

  _enqueue<Result>(fn: () => Promise<Result>): Promise<Result> {
    const next = this.queue.then(fn, fn);
    this.queue = next.then(() => {}, () => {});
    return next;
  }

  _validateRow(source: unknown, expectedSeq: number): ArchiveRow {
    exactObject(source, ROW_KEYS, `archive row ${expectedSeq}`);
    const raw = source as Payload;
    if (raw.schemaVersion !== 1 || raw.channel !== 'github') {
      fail('github_archive_invalid', `archive row ${expectedSeq}: неизвестная schema/channel.`);
    }
    if (raw.accountRef !== this.accountRef
        || normalizeGitHubRepositoryId(raw.repositoryId) !== this.repositoryId) {
      fail('github_archive_owner_mismatch', `archive row ${expectedSeq} принадлежит другому account owner.`);
    }
    const seq = safeSeq(raw.seq, `archive row ${expectedSeq}.seq`);
    if (seq !== expectedSeq) {
      fail('github_archive_invalid', 'GitHub archive seq должен идти с единицы без дыр и перестановок.');
    }
    const issueId = normalizeIssueId(raw.issueId);
    const semanticKey = githubIssueSemanticKey(this.repositoryId, issueId);
    if (raw.semanticKey !== semanticKey) {
      fail('github_archive_invalid', `archive row ${expectedSeq}: semanticKey неканоничен.`);
    }
    const transport = normalizeTransport(raw.transport);
    const snapshot = normalizeSnapshot(raw.snapshot);
    const occurredAt = safeOccurredAt(raw.occurredAt);
    const firstSeq = safeSeq(raw.firstSeq, `archive row ${expectedSeq}.firstSeq`);
    if (raw.duplicateOfSeq !== null) {
      safeSeq(raw.duplicateOfSeq, `archive row ${expectedSeq}.duplicateOfSeq`);
    }
    return {
      schemaVersion: 1,
      channel: 'github',
      accountRef: this.accountRef,
      seq,
      transport,
      semanticKey,
      repositoryId: this.repositoryId,
      issueId,
      occurredAt,
      firstSeq,
      duplicateOfSeq: raw.duplicateOfSeq as number | null,
      snapshot: snapshot.value,
      snapshotJson: snapshot.json,
    };
  }

  _indexRow(row: ArchiveRow): void {
    const delivery = transportKey(row.transport);
    if (this.byTransport.has(delivery)) {
      fail('github_archive_conflict', 'GitHub archive содержит повтор одного transport key.');
    }
    const fp = fingerprint(row);
    const first = this.bySemantic.get(row.semanticKey);
    if (!first) {
      if (row.firstSeq !== row.seq || row.duplicateOfSeq !== null) {
        fail('github_archive_invalid', 'Первый semantic snapshot должен ссылаться сам на себя.');
      }
      this.bySemantic.set(row.semanticKey, { row, fingerprint: fp });
      this.rows.push(row);
    } else {
      if (row.firstSeq !== first.row.seq || row.duplicateOfSeq !== first.row.seq) {
        fail('github_archive_invalid', 'Duplicate receipt ссылается не на первый semantic snapshot.');
      }
      if (fp !== first.fingerprint) {
        fail('github_archive_conflict', 'Один semantic issue имеет конфликтующие immutable snapshots.');
      }
    }
    this.byTransport.set(delivery, { row, fingerprint: fp });
    this.lastSeq = row.seq;
  }

  async _load(): Promise<void> {
    const snapshot = await readStableFileNoFollow(this.file, {
      missing: null,
      maxBytes: MAX_ARCHIVE_BYTES,
      privateFile: true,
    });
    if (!snapshot) {
      this.fileInfo = null;
      this.loaded = true;
      return;
    }
    const stable = snapshot as { bytes: Buffer; info: Stats };
    const bytes = stable.bytes;
    if (bytes.length && bytes[bytes.length - 1] !== 0x0a) {
      fail('github_archive_invalid', 'GitHub archive оборван: последняя строка не завершена newline.');
    }
    let start = 0;
    let expectedSeq = 1;
    while (start < bytes.length) {
      const end = bytes.indexOf(0x0a, start);
      const line = bytes.subarray(start, end);
      if (!line.length || line.length > MAX_ROW_BYTES) {
        fail('github_archive_invalid', `GitHub archive row ${expectedSeq} пуст или слишком велик.`);
      }
      let parsed: unknown;
      try { parsed = JSON.parse(line.toString('utf8')); } catch (err) {
        fail('github_archive_invalid', `GitHub archive row ${expectedSeq} не является JSON.`, err);
      }
      this._indexRow(this._validateRow(parsed, expectedSeq));
      expectedSeq += 1;
      start = end + 1;
    }
    this.fileInfo = stable.info;
    this.loaded = true;
  }

  _ensureLoaded(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    if (!this.loading) this.loading = this._load();
    return this.loading;
  }

  async _assertUnchanged(): Promise<void> {
    let info: Stats;
    try { info = await lstat(this.file); } catch (err) {
      if (failureCode(err) === 'ENOENT' && this.fileInfo === null) return;
      fail('github_store_changed', 'GitHub archive исчез или недоступен после snapshot.', err);
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      fail('github_store_unsafe', 'GitHub archive path больше не является обычным файлом.');
    }
    if (this.fileInfo === null || !sameFile(this.fileInfo, info)) {
      fail('github_store_changed', 'GitHub archive изменён вне single-writer queue.');
    }
  }

  async _appendRow(row: ArchiveRow): Promise<void> {
    const dir = path.dirname(this.file);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const parent = await lstat(dir);
    if (parent.isSymbolicLink() || !parent.isDirectory()) {
      fail('github_store_unsafe', 'Каталог GitHub archive не является обычным каталогом.');
    }
    await this._assertUnchanged();

    const source = row as unknown as Payload;
    const serializable = Object.fromEntries(ROW_KEYS.map((key) => [key, source[key]]));
    const line = `${JSON.stringify(serializable)}\n`;
    const bytes = Buffer.byteLength(line, 'utf8');
    if (bytes > MAX_ROW_BYTES) fail('github_archive_invalid', 'GitHub archive row превышает лимит 2 MiB.');

    let handle;
    try {
      handle = await open(
        this.file,
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW || 0),
        0o600,
      );
      const before = await handle.stat();
      if (!before.isFile() || (before.mode & 0o077) !== 0) {
        fail('github_store_permissions', 'GitHub archive должен быть обычным owner-only файлом.');
      }
      if ((this.fileInfo && !sameFile(this.fileInfo, before))
          || (!this.fileInfo && before.size !== 0)) {
        fail('github_store_changed', 'GitHub archive изменён перед append.');
      }
      await handle.writeFile(line, 'utf8');
      await handle.sync();
      const after = await handle.stat();
      const atPath = await lstat(this.file);
      if (!after.isFile() || atPath.isSymbolicLink() || !atPath.isFile()
          || after.dev !== atPath.dev || after.ino !== atPath.ino
          || after.size !== before.size + bytes || after.size !== atPath.size) {
        fail('github_store_changed', 'GitHub archive append не образовал один целый row.');
      }
      this.fileInfo = after;
      // Для первого append durable должна быть не только строка, но и directory entry.
      await syncDirectory(dir);
    } catch (err) {
      if (err instanceof GitHubStoreError) throw err;
      fail('github_store_write_failed', 'GitHub archive append завершился ошибкой.', err);
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  /**
   * Приём одной доставки. Первая запись semantic issue становится источником для
   * Inbox; повтор той же доставки — квитанция, а расхождение — конфликт.
   */
  async append(input: unknown): Promise<ArchiveAppendResult> {
    return this._enqueue(async () => {
      await this._ensureLoaded();
      if (!isPlainObject(input)) fail('github_archive_invalid', 'GitHub archive append ожидает объект.');
      exactObject(input, APPEND_KEYS, 'GitHub archive append');
      const raw = input as Payload;
      const owner = normalizeGitHubRepositoryId(raw.repositoryId);
      if (owner !== this.repositoryId) {
        fail('github_archive_owner_mismatch', 'Append принадлежит другому repository owner.');
      }
      const issueId = normalizeIssueId(raw.issueId);
      const semanticKey = githubIssueSemanticKey(owner, issueId);
      if (raw.semanticKey !== semanticKey) {
        fail('github_archive_invalid', 'Append semanticKey не совпадает с canonical repository/issue identity.');
      }
      const transport = normalizeTransport(raw.transport);
      const occurredAt = safeOccurredAt(raw.occurredAt);
      const snapshot = normalizeSnapshot(raw.snapshot);
      const fp = fingerprint({
        repositoryId: owner,
        issueId,
        semanticKey,
        occurredAt,
        snapshotJson: snapshot.json,
      });
      const delivery = transportKey(transport);
      const knownDelivery = this.byTransport.get(delivery);
      if (knownDelivery) {
        if (knownDelivery.row.semanticKey !== semanticKey) {
          fail('github_archive_conflict', 'Один transport key принёс конфликтующий immutable snapshot.');
        }
        const first = (this.bySemantic.get(semanticKey) as IndexedRow).row;
        // REST transport — не immutable delivery: один и тот же issue endpoint
        // после edit возвращает другое title/body/updated_at. Первый принятый
        // snapshot остаётся источником Inbox, а текущая проекция лишь доказывает,
        // что тот же semantic issue всё ещё существует.
        if (transport.kind !== 'rest' && knownDelivery.fingerprint !== fp) {
          fail('github_archive_conflict', 'Один transport key принёс конфликтующий immutable snapshot.');
        }
        return {
          appended: false,
          inserted: false,
          duplicate: true,
          seq: knownDelivery.row.seq,
          row: cloneRow(first),
        };
      }

      const knownSemantic = this.bySemantic.get(semanticKey);
      if (knownSemantic && transport.kind === 'rest'
          && knownSemantic.fingerprint !== fp) {
        return {
          appended: false,
          inserted: false,
          duplicate: true,
          seq: knownSemantic.row.seq,
          row: cloneRow(knownSemantic.row),
        };
      }
      if (knownSemantic && knownSemantic.fingerprint !== fp) {
        fail('github_archive_conflict', 'Один semantic issue принёс конфликтующий immutable snapshot.');
      }
      const seq = this.lastSeq + 1;
      if (!Number.isSafeInteger(seq)) fail('github_archive_invalid', 'GitHub archive исчерпал safe seq.');
      const firstSeq = knownSemantic?.row.seq ?? seq;
      const row: ArchiveRow = {
        schemaVersion: 1,
        channel: 'github',
        accountRef: this.accountRef,
        seq,
        transport,
        semanticKey,
        repositoryId: owner,
        issueId,
        occurredAt,
        firstSeq,
        duplicateOfSeq: knownSemantic ? firstSeq : null,
        snapshot: snapshot.value,
        snapshotJson: snapshot.json,
      };
      await this._appendRow(row);
      this._indexRow(row);
      const first = (this.bySemantic.get(semanticKey) as IndexedRow).row;
      return {
        appended: true,
        inserted: !knownSemantic,
        duplicate: Boolean(knownSemantic),
        seq,
        row: cloneRow(first),
      };
    });
  }

  /** Последний ingestion seq, включая duplicate receipts. */
  async head(): Promise<number> {
    return this._enqueue(async () => {
      await this._ensureLoaded();
      await this._assertUnchanged();
      return this.lastSeq;
    });
  }

  /** Только immutable первые snapshots; transport receipts наружу списка не дублируют issue. */
  async list(
    { afterSeq = 0, throughSeq = null, limit = 1000 }: ArchiveListOptions = {},
  ): Promise<Omit<ArchiveRow, 'snapshotJson'>[]> {
    return this._enqueue(async () => {
      await this._ensureLoaded();
      await this._assertUnchanged();
      safeSeq(afterSeq, 'afterSeq', { zero: true });
      if (throughSeq !== null) safeSeq(throughSeq, 'throughSeq', { zero: true });
      if (!Number.isSafeInteger(limit) || limit < 0 || limit > 10_000) {
        fail('github_archive_invalid', 'limit должен быть целым 0..10000.');
      }
      const upper = throughSeq ?? Number.MAX_SAFE_INTEGER;
      return this.rows
        .filter((row) => row.seq > afterSeq && row.seq <= upper)
        .slice(0, limit)
        .map(cloneRow);
    });
  }

  async findIssue(issueId: unknown) {
    return this._enqueue(async () => {
      await this._ensureLoaded();
      await this._assertUnchanged();
      const hit = this.bySemantic.get(githubIssueSemanticKey(this.repositoryId, issueId));
      return hit ? cloneRow(hit.row) : null;
    });
  }

  async receipt(transport: unknown) {
    return this._enqueue(async () => {
      await this._ensureLoaded();
      await this._assertUnchanged();
      const hit = this.byTransport.get(transportKey(normalizeTransport(transport)));
      return hit ? cloneRow(hit.row) : null;
    });
  }
}

// Server-owned sidecar связи chatKey ↔ provider session. Он намеренно не является
// частью chat JSON: client-wins merge, stale PUT и старое окно не могут назначить resume id.
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const SCHEMA = 1;
const REQUIRED_IDENTITY = ['provider', 'cwdRealpath', 'model', 'authProfileId', 'securityProfile'];

// Identity сессии: пять полей, при смене любого из них сессия не переносится.
export interface BindingIdentity {
  provider: string;
  cwdRealpath: string;
  model: string;
  authProfileId: string;
  securityProfile: string;
}

// Запись sidecar: identity плюс сама сессия и её поколение.
export interface BindingRecord extends BindingIdentity {
  schema: number;
  chatKey: string;
  generation: number;
  sessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

// Что приходит на запись: identity, ключ чата и (не всегда) id сессии.
export interface BindingInput extends Partial<BindingIdentity> {
  chatKey?: unknown;
  sessionId?: unknown;
}

export class BindingStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'BindingStoreError';
    this.code = code;
    Object.assign(this, details);
  }
}

function requiredText(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new BindingStoreError('invalid_binding', `пустое поле binding: ${field}`);
  return text;
}

function generationOf(value: unknown): number {
  const generation = Number(value);
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new BindingStoreError('invalid_generation', 'generation должна быть неотрицательным целым');
  }
  return generation;
}

function clone<Value>(value: Value): Value {
  return value ? JSON.parse(JSON.stringify(value)) : value;
}

function fileKey(chatKey: string): string {
  return createHash('sha256').update(chatKey).digest('hex');
}

function sameIdentity(record: BindingRecord | null, wanted: BindingIdentity): boolean {
  const left = record as unknown as Record<string, unknown> | null;
  const right = wanted as unknown as Record<string, unknown>;

  return REQUIRED_IDENTITY.every((field) => left?.[field] === right[field]);
}

export class ChatSessionBindingStore {
  readonly dir: string;

  readonly retentionMs: number;

  readonly now: () => number;

  private mutationTail: Promise<unknown>;

  constructor({ dir, retentionMs = 30 * 24 * 60 * 60 * 1000, now = () => Date.now() }: {
    dir: string;
    retentionMs?: number;
    now?: () => number;
  }) {
    if (!path.isAbsolute(dir || '')) throw new TypeError('binding dir должен быть абсолютным');
    this.dir = dir;
    this.retentionMs = retentionMs;
    this.now = now;
    this.mutationTail = Promise.resolve();
  }

  async ensureDir(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.dir, 0o700).catch(() => {});
  }

  fileOf(chatKey: unknown): string {
    return path.join(this.dir, `${fileKey(requiredText(chatKey, 'chatKey'))}.json`);
  }

  async writeAtomic(file: string, value: unknown): Promise<void> {
    await this.ensureDir();
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    const bytes = `${JSON.stringify(value, null, 2)}\n`;
    await fs.writeFile(temp, bytes, { mode: 0o600, flag: 'wx' });
    await fs.rename(temp, file);
    await fs.chmod(file, 0o600).catch(() => {});
  }

  async _readFile(file: string): Promise<BindingRecord | null> {
    let parsed: BindingRecord;
    try { parsed = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'ENOENT') return null;
      throw new BindingStoreError('binding_corrupt', `binding не читается: ${path.basename(file)}`);
    }
    if (parsed?.schema !== SCHEMA || !parsed.chatKey) {
      throw new BindingStoreError('binding_corrupt', `неподдерживаемая схема binding: ${path.basename(file)}`);
    }
    generationOf(parsed.generation);
    return parsed;
  }

  async read(chatKey: unknown): Promise<BindingRecord | null> {
    const wanted = requiredText(chatKey, 'chatKey');
    const record = await this._readFile(this.fileOf(wanted));
    if (record && record.chatKey !== wanted) {
      throw new BindingStoreError('binding_collision', 'binding hash указывает на другой chatKey');
    }
    return clone(record);
  }

  async list(): Promise<BindingRecord[]> {
    let names: string[] = [];
    try { names = await fs.readdir(this.dir); } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'ENOENT') return [];
      throw error;
    }
    const records: BindingRecord[] = [];
    for (const name of names.sort()) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const record = await this._readFile(path.join(this.dir, name));
      if (record) records.push(record);
    }
    return clone(records);
  }

  async _serialized<Value>(job: () => Promise<Value>): Promise<Value> {
    const next = this.mutationTail.then(job, job);
    this.mutationTail = next.then(() => {}, () => {});
    return next;
  }

  _normalizeIdentity(input: BindingInput | null | undefined): BindingIdentity {
    const cwdRealpath = requiredText(input?.cwdRealpath, 'cwdRealpath');
    if (!path.isAbsolute(cwdRealpath)) {
      throw new BindingStoreError('invalid_binding', 'cwdRealpath должен быть абсолютным');
    }
    return {
      provider: requiredText(input?.provider, 'provider'),
      cwdRealpath: path.normalize(cwdRealpath),
      model: requiredText(input?.model, 'model'),
      authProfileId: requiredText(input?.authProfileId, 'authProfileId'),
      securityProfile: requiredText(input?.securityProfile, 'securityProfile'),
    };
  }

  async _assertSessionUnique(
    chatKey: string,
    provider: string,
    sessionId: string | null,
  ): Promise<void> {
    if (!sessionId) return;
    const owner = (await this.list()).find((record) => (
      record.provider === provider && record.sessionId === sessionId && record.chatKey !== chatKey
    ));
    if (owner) {
      throw new BindingStoreError('session_owned_by_another_chat', 'provider session уже связана с другим чатом', {
        ownerChatKey: owner.chatKey,
      });
    }
  }

  /**
   * CAS-запись. expectedGeneration=null означает «binding ещё не существует».
   * sessionId=null резервирует новую generation до `session/new`; фактический ID затем
   * сохраняется вторым CAS до первого prompt.
   */
  async compareAndSwap(
    input: BindingInput,
    expectedGeneration: number | null = null,
    options: { legacySecurityProfiles?: readonly string[] } = {},
  ): Promise<BindingRecord> {
    return this._serialized(async () => {
      const chatKey = requiredText(input?.chatKey, 'chatKey');
      const identity = this._normalizeIdentity(input);
      const current = await this.read(chatKey);
      const expected = expectedGeneration === null ? null : generationOf(expectedGeneration);
      const actual = current?.generation ?? null;
      if (actual !== expected) {
        throw new BindingStoreError('stale_binding_generation', 'binding уже изменён другим ходом/окном', {
          expectedGeneration: expected,
          actualGeneration: actual,
        });
      }

      const legacyProfile = current && options.legacySecurityProfiles?.includes(current.securityProfile)
        && REQUIRED_IDENTITY.filter((field) => field !== 'securityProfile')
          .every((field) => current[field as keyof BindingIdentity]
            === identity[field as keyof BindingIdentity])
        && input.sessionId === current.sessionId;

      if (current && !sameIdentity(current, identity) && input?.sessionId && !legacyProfile) {
        throw new BindingStoreError('binding_identity_changed', 'нельзя перенести sessionId между профилями binding');
      }
      const sessionId = input?.sessionId == null ? null : requiredText(input.sessionId, 'sessionId');
      await this._assertSessionUnique(chatKey, identity.provider, sessionId);
      const timestamp = new Date(this.now()).toISOString();
      const record: BindingRecord = {
        schema: SCHEMA,
        chatKey,
        generation: (current?.generation || 0) + 1,
        ...identity,
        sessionId,
        createdAt: current?.createdAt || timestamp,
        updatedAt: timestamp,
      };
      const file = this.fileOf(chatKey);
      if (current) await this.writeAtomic(`${file}.previous`, current);
      await this.writeAtomic(file, record);
      return clone(record);
    });
  }

  /** Новая identity всегда получает новую generation и пустую session. */
  async rotate(
    input: BindingInput,
    expectedGeneration: number | null = null,
  ): Promise<BindingRecord> {
    return this.compareAndSwap({ ...input, sessionId: null }, expectedGeneration);
  }

  async assertResumeOwner({ chatKey, provider, sessionId }: {
    chatKey: unknown;
    provider: string;
    sessionId: string;
  }): Promise<BindingRecord> {
    const record = await this.read(chatKey);
    if (!record || record.provider !== provider || record.sessionId !== sessionId) {
      throw new BindingStoreError('forged_session', 'resume session не принадлежит этому чату');
    }
    const other = (await this.list()).find((candidate) => (
      candidate.chatKey !== chatKey
        && candidate.provider === provider
        && candidate.sessionId === sessionId
    ));
    if (other) throw new BindingStoreError('cross_chat_session', 'session связана более чем с одним чатом');
    return record;
  }

  async remove(chatKey: unknown): Promise<boolean> {
    return this._serialized(async () => {
      const file = this.fileOf(chatKey);
      const existed = !!(await this._readFile(file));
      if (existed) {
        await fs.rm(file, { force: true });
        await fs.rm(`${file}.previous`, { force: true });
      }
      return existed;
    });
  }

  /** Удаляет sidecar только для уже отсутствующих чатов и только после retention window. */
  async cleanup({ activeChatKeys = [], now = this.now() }: {
    activeChatKeys?: Iterable<unknown>;
    now?: number;
  } = {}): Promise<string[]> {
    const active = new Set([...activeChatKeys].map(String));
    const removed: string[] = [];
    for (const record of await this.list()) {
      if (active.has(record.chatKey)) continue;
      const updated = Date.parse(record.updatedAt || '');
      if (!Number.isFinite(updated) || now - updated < this.retentionMs) continue;
      if (await this.remove(record.chatKey)) removed.push(record.chatKey);
    }
    return removed;
  }

  /** Immutable backup перед миграциями/ремонтом sidecar. */
  async backup(label = 'manual'): Promise<string> {
    return this._serialized(async () => {
      await this.ensureDir();
      const safeLabel = String(label).replace(/[^a-z0-9._-]+/gi, '-').slice(0, 48) || 'backup';
      const backupDir = path.join(this.dir, 'backups', `${this.now()}-${safeLabel}-${randomUUID()}`);
      await fs.mkdir(backupDir, { recursive: true, mode: 0o700 });
      const records = await this.list();
      for (const record of records) {
        await fs.writeFile(
          path.join(backupDir, `${fileKey(record.chatKey)}.json`),
          `${JSON.stringify(record, null, 2)}\n`,
          { mode: 0o600, flag: 'wx' },
        );
      }
      await fs.writeFile(path.join(backupDir, 'manifest.json'), `${JSON.stringify({
        schema: 1,
        createdAt: new Date(this.now()).toISOString(),
        count: records.length,
      }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      return backupDir;
    });
  }

  /** Restore требует явного backup path; вызывается только recovery-кодом/тестами. */
  async restore(backupDir: string): Promise<string[]> {
    return this._serialized(async () => {
      const canonicalRoot = await fs.realpath(path.join(this.dir, 'backups'));
      const canonicalBackup = await fs.realpath(backupDir);
      if (!canonicalBackup.startsWith(`${canonicalRoot}${path.sep}`)) {
        throw new BindingStoreError('invalid_backup', 'backup находится вне binding store');
      }
      const manifest = JSON.parse(await fs.readFile(path.join(canonicalBackup, 'manifest.json'), 'utf8'));
      if (manifest?.schema !== 1) throw new BindingStoreError('invalid_backup', 'неподдерживаемая схема backup');
      const restored: string[] = [];
      for (const name of (await fs.readdir(canonicalBackup)).sort()) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        const record = JSON.parse(await fs.readFile(path.join(canonicalBackup, name), 'utf8'));
        if (fileKey(requiredText(record.chatKey, 'chatKey')) !== name.slice(0, -5)) {
          throw new BindingStoreError('invalid_backup', 'chatKey не совпадает с именем backup');
        }
        await this.writeAtomic(this.fileOf(record.chatKey), record);
        restored.push(record.chatKey);
      }
      return restored;
    });
  }
}

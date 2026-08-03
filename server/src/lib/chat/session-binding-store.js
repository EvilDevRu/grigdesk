// Server-owned sidecar связи chatKey ↔ provider session. Он намеренно не является
// частью chat JSON: client-wins merge, stale PUT и старое окно не могут назначить resume id.
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const SCHEMA = 1;
const REQUIRED_IDENTITY = ['provider', 'cwdRealpath', 'model', 'authProfileId', 'securityProfile'];

export class BindingStoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BindingStoreError';
    this.code = code;
    Object.assign(this, details);
  }
}

function requiredText(value, field) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new BindingStoreError('invalid_binding', `пустое поле binding: ${field}`);
  return text;
}

function generationOf(value) {
  const generation = Number(value);
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new BindingStoreError('invalid_generation', 'generation должна быть неотрицательным целым');
  }
  return generation;
}

function clone(value) {
  return value ? JSON.parse(JSON.stringify(value)) : null;
}

function fileKey(chatKey) {
  return createHash('sha256').update(chatKey).digest('hex');
}

function sameIdentity(record, wanted) {
  return REQUIRED_IDENTITY.every((field) => record?.[field] === wanted?.[field]);
}

export class ChatSessionBindingStore {
  constructor({ dir, retentionMs = 30 * 24 * 60 * 60 * 1000, now = () => Date.now() }) {
    if (!path.isAbsolute(dir || '')) throw new TypeError('binding dir должен быть абсолютным');
    this.dir = dir;
    this.retentionMs = retentionMs;
    this.now = now;
    this.mutationTail = Promise.resolve();
  }

  async ensureDir() {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.dir, 0o700).catch(() => {});
  }

  fileOf(chatKey) {
    return path.join(this.dir, `${fileKey(requiredText(chatKey, 'chatKey'))}.json`);
  }

  async writeAtomic(file, value) {
    await this.ensureDir();
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    const bytes = `${JSON.stringify(value, null, 2)}\n`;
    await fs.writeFile(temp, bytes, { mode: 0o600, flag: 'wx' });
    await fs.rename(temp, file);
    await fs.chmod(file, 0o600).catch(() => {});
  }

  async _readFile(file) {
    let parsed;
    try { parsed = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw new BindingStoreError('binding_corrupt', `binding не читается: ${path.basename(file)}`);
    }
    if (parsed?.schema !== SCHEMA || !parsed.chatKey) {
      throw new BindingStoreError('binding_corrupt', `неподдерживаемая схема binding: ${path.basename(file)}`);
    }
    generationOf(parsed.generation);
    return parsed;
  }

  async read(chatKey) {
    const wanted = requiredText(chatKey, 'chatKey');
    const record = await this._readFile(this.fileOf(wanted));
    if (record && record.chatKey !== wanted) {
      throw new BindingStoreError('binding_collision', 'binding hash указывает на другой chatKey');
    }
    return clone(record);
  }

  async list() {
    let names = [];
    try { names = await fs.readdir(this.dir); } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const records = [];
    for (const name of names.sort()) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const record = await this._readFile(path.join(this.dir, name));
      if (record) records.push(record);
    }
    return clone(records);
  }

  async _serialized(job) {
    const next = this.mutationTail.then(job, job);
    this.mutationTail = next.then(() => {}, () => {});
    return next;
  }

  _normalizeIdentity(input) {
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

  async _assertSessionUnique(chatKey, provider, sessionId) {
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
  async compareAndSwap(input, expectedGeneration = null) {
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
      if (current && !sameIdentity(current, identity) && input?.sessionId) {
        throw new BindingStoreError('binding_identity_changed', 'нельзя перенести sessionId между профилями binding');
      }
      const sessionId = input?.sessionId == null ? null : requiredText(input.sessionId, 'sessionId');
      await this._assertSessionUnique(chatKey, identity.provider, sessionId);
      const timestamp = new Date(this.now()).toISOString();
      const record = {
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
  async rotate(input, expectedGeneration = null) {
    return this.compareAndSwap({ ...input, sessionId: null }, expectedGeneration);
  }

  async assertResumeOwner({ chatKey, provider, sessionId }) {
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

  async remove(chatKey) {
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
  async cleanup({ activeChatKeys = [], now = this.now() } = {}) {
    const active = new Set([...activeChatKeys].map(String));
    const removed = [];
    for (const record of await this.list()) {
      if (active.has(record.chatKey)) continue;
      const updated = Date.parse(record.updatedAt || '');
      if (!Number.isFinite(updated) || now - updated < this.retentionMs) continue;
      if (await this.remove(record.chatKey)) removed.push(record.chatKey);
    }
    return removed;
  }

  /** Immutable backup перед миграциями/ремонтом sidecar. */
  async backup(label = 'manual') {
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
  async restore(backupDir) {
    return this._serialized(async () => {
      const canonicalRoot = await fs.realpath(path.join(this.dir, 'backups'));
      const canonicalBackup = await fs.realpath(backupDir);
      if (!canonicalBackup.startsWith(`${canonicalRoot}${path.sep}`)) {
        throw new BindingStoreError('invalid_backup', 'backup находится вне binding store');
      }
      const manifest = JSON.parse(await fs.readFile(path.join(canonicalBackup, 'manifest.json'), 'utf8'));
      if (manifest?.schema !== 1) throw new BindingStoreError('invalid_backup', 'неподдерживаемая схема backup');
      const restored = [];
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

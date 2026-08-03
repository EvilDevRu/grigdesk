// Хранилище истории чатов: папка chats/ в корне проекта.
// Каждый чат — свой файл chats/YYYY-MM/<id>.json (месяц СОЗДАНИЯ чата, файл не переезжает),
// мета (активный чат, дефолты модели/усилия) — chats/meta.json. Битый файл одного чата
// не валит остальную историю: он пропускается с предупреждением.
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { mergeChat } from './merge-chat.js';
import {
  CHAT_SCHEMA,
  CHAT_SURFACES,
  migrateChatModelRecord,
  migrateDefaultModel,
} from './model-ref.js';

const SERVER_CHAT_KEYS = new Set([
  'schema', 'surface', 'revision', 'modelRefState', 'sessionBindingState',
  // Binding не должен оказаться в chat JSON даже под выдуманным клиентом именем.
  'binding', 'bindingGeneration', 'sessionBinding',
]);

function stableJson(value) {
  return JSON.stringify(value);
}

function clientChat(value) {
  const next = { ...(value || {}) };
  for (const key of SERVER_CHAT_KEYS) delete next[key];
  return next;
}

function legacySessionState(chat) {
  if (chat?.sessionBindingState?.state) return chat.sessionBindingState;
  return chat?.sessionId
    ? { state: 'legacy_unbound', reason: 'missing_server_identity' }
    : { state: 'none' };
}

export class ChatHistoryStore {
  /**
   * @param {{ chatsDir: string, legacyPath?: string, log?: object }} opts
   *   legacyPath — старая схема «вся история в одном файле», мигрируется однократно.
   */
  constructor({
    chatsDir,
    legacyPath = '',
    log = null,
    registryProvider = async () => ({}),
    defaultSurface = 'chats',
    now = () => Date.now(),
  }) {
    this.dir = chatsDir;
    this.legacyPath = legacyPath;
    this.log = log;
    this.registryProvider = registryProvider;
    this.defaultSurface = CHAT_SURFACES.has(defaultSurface) ? defaultSurface : 'embedded';
    this.now = now;
    this.migrationPromise = null;
    // id чата → хвост очереди его сохранений (см. withChatLock).
    this.locks = new Map();
  }

  /**
   * Папка истории с самогитигнором: чаты — рабочие данные, в репозиторий не едут.
   */
  async ensureDir() {
    await fs.mkdir(this.dir, { recursive: true });
    const gi = path.join(this.dir, '.gitignore');
    try { await fs.access(gi); } catch { await fs.writeFile(gi, '*\n!.gitignore\n'); }
  }

  fileOf(chat) {
    const month = new Date(chat.createdAt || chat.updatedAt || Date.now()).toISOString().slice(0, 7);
    return path.join(this.dir, month, `${chat.id}.json`);
  }

  /**
   * Скан всех чат-файлов: Map id → { path, chat, json }.
   * Нечитаемый файл пропускаем — теряется один чат, не вся история.
   */
  async scan() {
    const map = new Map();
    let months = [];
    try { months = await fs.readdir(this.dir); } catch { return map; }
    for (const m of months) {
      if (!/^\d{4}-\d{2}$/.test(m)) continue;
      const mdir = path.join(this.dir, m);
      for (const f of await fs.readdir(mdir)) {
        if (!f.endsWith('.json')) continue;
        const p = path.join(mdir, f);
        try {
          const json = await fs.readFile(p, 'utf8');
          const chat = JSON.parse(json);
          if (chat?.id) map.set(chat.id, { path: p, chat, json });
        } catch (e) {
          this.log?.warn({ file: p, err: e.message }, 'чат-файл не читается, пропущен');
        }
      }
    }
    return map;
  }

  /**
   * Запись через tmp+rename: оборванная запись не оставляет полуфайл.
   */
  async writeAtomic(p, data) {
    await fs.mkdir(path.dirname(p), { recursive: true });
    const temp = `${p}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, data, { mode: 0o600, flag: 'wx' });
    await fs.rename(temp, p);
    await fs.chmod(p, 0o600).catch(() => {});
  }

  async registry() {
    try { return (await this.registryProvider()) || {}; }
    catch (error) {
      this.log?.warn({ err: error.message }, 'реестр моделей недоступен для миграции чатов');
      return {};
    }
  }

  async readMetaRaw() {
    try { return JSON.parse(await fs.readFile(path.join(this.dir, 'meta.json'), 'utf8')); }
    catch { return {}; }
  }

  /**
   * Перед первой schema-v2 миграцией сохраняем исходные байты. Backup не участвует
   * в обычном чтении и остаётся пригодным для явного recovery/проверки rollback.
   */
  async backupMigration(entries, meta, label = 'chat-schema-v2') {
    const backupDir = path.join(
      this.dir,
      '.migration-backups',
      `${this.now()}-${label}-${randomUUID()}`,
    );
    await fs.mkdir(backupDir, { recursive: true, mode: 0o700 });
    for (const { path: source, json } of entries.values()) {
      const rel = path.relative(this.dir, source);
      const target = path.join(backupDir, rel);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.writeFile(target, json, { mode: 0o600, flag: 'wx' });
    }
    if (Object.keys(meta || {}).length) {
      await fs.writeFile(
        path.join(backupDir, 'meta.json'),
        stableJson(meta),
        { mode: 0o600, flag: 'wx' },
      );
    }
    await fs.writeFile(path.join(backupDir, 'manifest.json'), `${JSON.stringify({
      schema: 1,
      targetSchema: CHAT_SCHEMA,
      createdAt: new Date(this.now()).toISOString(),
      chats: entries.size,
    }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    return backupDir;
  }

  async migrateSchema() {
    await this.ensureDir();
    const entries = await this.scan();
    const meta = await this.readMetaRaw();
    const registry = await this.registry();
    const changes = [];
    for (const entry of entries.values()) {
      const surface = CHAT_SURFACES.has(entry.chat?.surface)
        ? entry.chat.surface
        : this.defaultSurface;
      const { chat: migrated } = migrateChatModelRecord(entry.chat, registry, { surface });
      migrated.revision = Number.isSafeInteger(entry.chat?.revision) && entry.chat.revision >= 0
        ? entry.chat.revision
        : 0;
      migrated.sessionBindingState = legacySessionState(entry.chat);
      const json = stableJson(migrated);
      if (json !== entry.json) changes.push({ ...entry, migrated, json });
    }
    const { meta: migratedMeta } = migrateDefaultModel(meta, registry);
    migratedMeta.schema = CHAT_SCHEMA;
    const metaChanged = stableJson(migratedMeta) !== stableJson(meta);
    if (!changes.length && !metaChanged) return { changed: false, backupDir: null };

    const backupDir = await this.backupMigration(entries, meta);
    for (const change of changes) await this.writeAtomic(change.path, change.json);
    if (metaChanged) await this.writeAtomic(path.join(this.dir, 'meta.json'), stableJson(migratedMeta));
    return { changed: true, backupDir };
  }

  async ensureMigrated() {
    if (!this.migrationPromise) this.migrationPromise = this.migrateSchema();
    return this.migrationPromise;
  }

  /** Явное восстановление chat-файлов из backup; production API этот метод не публикует. */
  async restoreMigrationBackup(backupDir) {
    const backupRoot = await fs.realpath(path.join(this.dir, '.migration-backups'));
    const sourceRoot = await fs.realpath(backupDir);
    if (!sourceRoot.startsWith(`${backupRoot}${path.sep}`)) throw new Error('backup вне chatsDir');
    const manifest = JSON.parse(await fs.readFile(path.join(sourceRoot, 'manifest.json'), 'utf8'));
    if (manifest?.schema !== 1) throw new Error('неподдерживаемый backup');
    const restored = [];
    const walk = async (dir) => {
      for (const item of await fs.readdir(dir, { withFileTypes: true })) {
        if (item.name === 'manifest.json') continue;
        const source = path.join(dir, item.name);
        if (item.isDirectory()) { await walk(source); continue; }
        if (!item.isFile() || !item.name.endsWith('.json')) continue;
        const rel = path.relative(sourceRoot, source);
        const target = path.join(this.dir, rel);
        if (!target.startsWith(`${this.dir}${path.sep}`)) throw new Error('небезопасный backup path');
        await this.writeAtomic(target, await fs.readFile(source, 'utf8'));
        restored.push(rel);
      }
    };
    await walk(sourceRoot);
    this.migrationPromise = null;
    return restored;
  }

  /**
   * Раскладывает стор по файлам: пишет только изменившиеся чаты, удаляет файлы
   * исчезнувших, переносит файл при смене месяца (не должно случаться).
   */
  async save(body) {
    await this.ensureMigrated();
    await this.ensureDir();
    const incoming = [
      ...(body.sessions || []).map((c) => ({ ...c, archived: false })),
      ...(body.archived || []).map((c) => ({ ...c, archived: true })),
    ];
    const existing = await this.scan();
    const seen = new Set();
    for (const c of incoming) {
      if (!c.id) continue;
      seen.add(c.id);
      await this.saveOne(c, !!c.archived);
    }
    for (const [id, v] of existing) {
      if (!seen.has(id)) await fs.rm(v.path, { force: true });
    }
    await this.saveMeta({
      activeId: body.activeId ?? null,
      defModel: body.defModel,
      defModelRef: body.defModelRef,
      defEffort: body.defEffort,
      defMode: body.defMode,
    });
  }

  /**
   * Запись ОДНОГО чата — основной путь сохранения. Раньше клиент присылал весь стор
   * одним телом; вместе с лентами шагов он дорос до лимита тела запроса, сервер начал
   * отвечать 413, и история не сохранялась вовсе. Одно тело = один чат, и объём запроса
   * больше не зависит от того, сколько всего чатов накопилось.
   *
   * Присланная копия НЕ ЗАМЕЩАЕТ серверную, а сливается с ней (`mergeChat`): окно может
   * отстать и принести ленту без чужих сообщений — раньше это стирало ответы, дошедшие
   * до другого устройства. Запись сериализована по id: два окна, сохраняющие один чат
   * одновременно, читали бы диск до записи друг друга и всё равно теряли сообщения.
   *
   * @returns {{written: boolean, restored: number, dropped: number}}
   *   written — файл изменился (false — на диске уже лежит ровно это, частый случай
   *   лишнего persist); restored/dropped — что дало слияние, см. merge-chat.js.
   */
  async saveOne(chat, archived = false) {
    if (!chat?.id) return { written: false, restored: 0, dropped: 0 };
    await this.ensureMigrated();
    return this.withChatLock(chat.id, async () => {
      await this.ensureDir();
      // Ищем прежний файл этого чата: он мог лежать в другом месяце (архив, ручная правка).
      const prev = (await this.scan()).get(chat.id);
      const registry = await this.registry();
      const incomingRevision = Number.isSafeInteger(chat.revision) ? chat.revision : null;
      const currentRevision = Number.isSafeInteger(prev?.chat?.revision) ? prev.chat.revision : 0;
      // Клиент без revision — старая версия. Историю от него по-прежнему принимаем,
      // но server-owned выбор модели уже не откатываем.
      const stale = !!prev && incomingRevision !== currentRevision;
      const clean = clientChat(chat);
      const surface = CHAT_SURFACES.has(prev?.chat?.surface)
        ? prev.chat.surface
        : this.defaultSurface;
      let prepared;
      if (stale) {
        prepared = {
          ...clean,
          model: prev.chat.model,
          modelRef: prev.chat.modelRef,
          modelRefState: prev.chat.modelRefState,
        };
      } else {
        prepared = migrateChatModelRecord(clean, registry, { surface }).chat;
      }
      const { chat: merged, restored, dropped } = mergeChat(prev?.chat || null, prepared);
      const c = {
        ...merged,
        schema: CHAT_SCHEMA,
        surface,
        sessionBindingState: legacySessionState(prev?.chat || merged),
        archived: !!archived,
      };
      if (stale && prev?.chat) {
        c.model = prev.chat.model;
        c.modelRef = prev.chat.modelRef;
        c.modelRefState = prev.chat.modelRefState;
      }
      c.createdAt = c.createdAt || c.updatedAt || Date.now();
      const target = this.fileOf(c);
      // Нет семантического изменения — revision не накручиваем из-за повторного PUT.
      const currentShape = prev ? { ...c, revision: currentRevision } : null;
      if (prev && prev.path === target && stableJson(currentShape) === prev.json) {
        return { written: false, restored, dropped, stale, chat: prev.chat };
      }
      c.revision = currentRevision + 1;
      const json = stableJson(c);
      await this.writeAtomic(target, json);
      if (prev && prev.path !== target) await fs.rm(prev.path, { force: true });
      return { written: true, restored, dropped, stale, chat: c };
    });
  }

  /**
   * Очередь записи на чат: сохранения одного чата выполняются по очереди, разных —
   * параллельно. Ошибка одного сохранения не рвёт цепочку следующим.
   */
  async withChatLock(id, fn) {
    const prev = this.locks.get(id) || Promise.resolve();
    const next = prev.then(fn, fn);
    // Хвост очереди чистим, только если за время работы её никто не продлил.
    this.locks.set(id, next.then(() => {}, () => {}));
    const done = this.locks.get(id);
    done.then(() => { if (this.locks.get(id) === done) this.locks.delete(id); });
    return next;
  }

  /**
   * Один чат по id — точечная досинхронизация окон: по событию `chat-store` окно тянет
   * ровно изменившийся чат, а не всю историю (она растёт, а меняется всегда один чат).
   */
  async readOne(id) {
    if (!id) return null;
    await this.ensureMigrated();
    const found = (await this.scan()).get(String(id));
    return found ? found.chat : null;
  }

  /** Удаление чата (человек стёр его в списке). Файла нет — значит уже удалён. */
  async remove(id) {
    if (!id) return false;
    await this.ensureMigrated();
    const prev = (await this.scan()).get(id);
    if (!prev) return false;
    await fs.rm(prev.path, { force: true });
    return true;
  }

  /**
   * Мета (активный чат и дефолты новых чатов) — отдельно от чатов, поэтому переключение
   * вкладки не тащит за собой переписку. Пишем слиянием: частичное обновление не должно
   * стирать соседние поля.
   */
  async saveMeta(meta) {
    await this.ensureMigrated();
    await this.ensureDir();
    const prev = await this.readMetaRaw();
    const next = { ...prev };
    for (const k of ['activeId', 'defModel', 'defModelRef', 'defEffort', 'defMode']) {
      if (meta?.[k] !== undefined) next[k] = meta[k];
    }
    const migrated = migrateDefaultModel(next, await this.registry()).meta;
    migrated.schema = CHAT_SCHEMA;
    await this.writeAtomic(path.join(this.dir, 'meta.json'), stableJson(migrated));
    return migrated;
  }

  async read() {
    await this.ensureMigrated();
    let map = await this.scan();
    // Одноразовая миграция со старой схемы «всё в одном файле».
    if (!map.size && this.legacyPath) {
      try {
        const legacy = JSON.parse(await fs.readFile(this.legacyPath, 'utf8'));
        if (legacy?.sessions?.length || legacy?.archived?.length) {
          await this.save(legacy);
          await fs.rename(this.legacyPath, this.legacyPath + '.migrated');
          map = await this.scan();
        }
      } catch { /* старого файла нет — начинаем с пустого */ }
    }
    const meta = await this.readMetaRaw();
    const all = [...map.values()].map((v) => v.chat).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    return {
      sessions: all.filter((c) => !c.archived),
      archived: all.filter((c) => c.archived),
      activeId: meta.activeId ?? null,
      defModel: meta.defModel,
      defModelRef: meta.defModelRef,
      defModelRefState: meta.defModelRefState,
      defEffort: meta.defEffort,
      // defMode клиент присылал, а мета его не хранила — выбранный режим прав не переживал
      // перезагрузку страницы и молча откатывался к режиму по умолчанию.
      defMode: meta.defMode,
    };
  }
}

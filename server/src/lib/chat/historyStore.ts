// Хранилище истории чатов: папка chats/ в корне проекта.
// Каждый чат — свой файл chats/YYYY-MM/<id>.json (месяц СОЗДАНИЯ чата, файл не переезжает),
// мета (активный чат, дефолты модели/усилия) — chats/meta.json. Битый файл одного чата
// не валит остальную историю: он пропускается с предупреждением.
import { randomUUID } from 'node:crypto';
import { chatPreview } from './chatPreview.ts';
import { writeDurableFile } from '../durableFile.ts';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { normalizeChatWorkdir, normalizeRecentWorkdirs, sameChatWorkdir }
  from '../../../../shared/chatWorkdir.ts';
import type { WorkdirState } from './workdirTransition.ts';

import { mergeChat } from './mergeChat.ts';
import type { ChatRecord } from './mergeChat.ts';
import { messageKey } from './messageIdentity.ts';
import { historyStepReuseAck, restoreHistorySteps } from './historyStepReuse.ts';
import type { HistoryStepReuseAck } from '../../../../shared/chatHistoryStepReuse.ts';
import type { ModelRegistry } from './modelRef.ts';
import {
  CHAT_SCHEMA,
  CHAT_SURFACES,
  migrateChatModelRecord,
  migrateDefaultModel,
} from './modelRef.ts';

const SERVER_CHAT_KEYS = new Set([
  'schema', 'surface', 'revision', 'modelRefState', 'sessionBindingState',
  'logicalIdentity', 'workdirState',
  'executionRunId', 'mobileHistoryAppliedAt', 'mobileHistoryEpoch',
  // Binding не должен оказаться в chat JSON даже под выдуманным клиентом именем.
  'binding', 'bindingGeneration', 'sessionBinding',
]);

export const WORKDIR_MEMORY_KEYS = [
  'sessionId', 'pendingSeed', 'contextTokens', 'contextWindow', 'contextMetric',
  'contextIsEstimate', 'totalInputTokens', 'cachedInputTokens', 'contextCache', 'compactedAt',
];

const COMPANION_PURPOSE = 'companion';
const COMPANION_TASK_RE = /^[1-9][0-9]{0,18}$/;

// Запись чата на диске. Форма открытая: клиент владеет своими полями, сервер —
// перечисленными в SERVER_CHAT_KEYS.
export interface StoredChat extends ChatRecord {
  id?: string;
  purpose?: string;
  taskId?: string | null;
  logicalIdentity?: string;
  revision?: number;
  archived?: boolean;
  surface?: string;
  sessionId?: string | null;
  workdirState?: WorkdirState;
  sessionBindingState?: { state?: string; reason?: string };
  model?: unknown;
  modelRef?: unknown;
  modelRefState?: unknown;
}

// Шапка чата для лёгких списков: поля строки списка без сообщений и состояния хода.
export type ChatHead = Pick<
  StoredChat,
  | 'id'
  | 'title'
  | 'purpose'
  | 'taskId'
  | 'logicalIdentity'
  | 'model'
  | 'modelRef'
  | 'unread'
  | 'archived'
  | 'createdAt'
  | 'updatedAt'
> & { preview: string };

// Файл чата вместе с исходными байтами: они нужны сравнению и переносу.
export interface ChatEntry {
  path: string;
  chat: StoredChat;
  json: string;
}

// Итог сохранения одного чата.
export interface SaveResult {
  written: boolean;
  restored: number;
  dropped: number;
  stale?: boolean;
  chat?: StoredChat;
  stepReuseAck?: HistoryStepReuseAck;
}

// Итог ensureByPurpose. `restored` здесь означает «поднят из архива», а не число
// восстановленных слиянием сообщений, поэтому тип отдельный от SaveResult.
export interface EnsuredChat {
  chat?: StoredChat;
  created: boolean;
  restored: boolean;
  written: boolean;
  dropped?: number;
  stale?: boolean;
}

// Мета истории: активный чат и дефолты новых чатов.
export interface ChatMeta {
  activeId?: string | null;
  defModel?: unknown;
  defModelRef?: unknown;
  defModelRefState?: unknown;
  defEffort?: unknown;
  defMode?: unknown;
  defWorkdir?: unknown;
  recentWorkdirs?: unknown;
  schema?: number;
}

// Журнал сервера в том минимуме, который использует хранилище.
interface HistoryLog {
  warn?: (fields: Record<string, unknown>, message: string) => void;
}

export class ChatHistoryError extends Error {
  readonly code: string;

  readonly statusCode: number;

  readonly conflicts: unknown[];

  constructor(code: string, message: string, { statusCode = 409, conflicts = [] }: {
    statusCode?: number;
    conflicts?: unknown[];
  } = {}) {
    super(message);
    this.name = 'ChatHistoryError';
    this.code = code;
    this.statusCode = statusCode;
    this.conflicts = conflicts;
  }
}

export function normalizeCompanionTaskId(value: unknown): string | null {
  if (value == null) return null;
  const taskId = typeof value === 'number' && Number.isSafeInteger(value)
    ? String(value)
    : value;
  if (typeof taskId !== 'string' || !COMPANION_TASK_RE.test(taskId)) {
    throw new ChatHistoryError(
      'bad_companion_task_id',
      'Нужен канонический положительный номер задачи.',
      { statusCode: 400 },
    );
  }
  return taskId;
}

export function companionLogicalIdentity(taskId: unknown = null): string {
  const canonical = normalizeCompanionTaskId(taskId);
  return canonical ? `companion:task:${canonical}` : 'companion:global';
}

// Логическая идентичность companion-чата: валидна ли она и чему равна.
interface CompanionIdentity {
  valid: boolean;
  taskId: string | null;
  key: string;
}

function companionIdentity(chat: StoredChat | null | undefined): CompanionIdentity | null {
  if (chat?.purpose !== COMPANION_PURPOSE) return null;
  let taskId: string | null;
  try { taskId = normalizeCompanionTaskId(chat.taskId); }
  catch { return { valid: false, taskId: chat.taskId ?? null, key: '' }; }
  const key = companionLogicalIdentity(taskId);
  return { valid: chat.logicalIdentity === key, taskId, key };
}

function conflictView(chat: StoredChat | null | undefined) {
  return {
    id: String(chat?.id || ''),
    title: String(chat?.title || ''),
    archived: !!chat?.archived,
    createdAt: chat?.createdAt || null,
    updatedAt: chat?.updatedAt || null,
  };
}

function identityConflict(conflicts: StoredChat[] = []): ChatHistoryError {
  return new ChatHistoryError(
    'companion_chat_conflict',
    'Найдено несколько или повреждённых companion-чатов с одной logical identity.',
    { conflicts: conflicts.map(conflictView) },
  );
}

function rebindError(): ChatHistoryError {
  return new ChatHistoryError(
    'chat_identity_rebind',
    'Обычный save не может создать или изменить server-owned identity чата.',
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Клиентское представление не получает серверные identity и durable receipt.
 * Сохранение старого окна сравнивается только с разрешёнными клиенту полями.
 */
function clientChat(value: StoredChat | null | undefined): StoredChat {
  const next: StoredChat = { ...(value || {}) };

  for (const key of SERVER_CHAT_KEYS) {
    delete next[key];
  }

  if (Array.isArray(next.messages)) {
    next.messages = next.messages.map((message) => {
      const { mobileId: _mobileId, ...clientMessage } = message;

      return clientMessage;
    });
  }

  return next;
}

/**
 * Серверные receipt и блоки перекрывают копию окна с тем же устойчивым id.
 * Остальные поля сообщения сохраняются: они могут содержать метаданные финала.
 */
function protectCanonicalMessages(
  messages: unknown,
  canonical: unknown,
): ChatRecord['messages'] {
  const result = Array.isArray(messages) ? [...messages] : [];
  const trusted = Array.isArray(canonical) ? canonical : [];
  const positions = new Map<string, number>();

  for (const [index, message] of result.entries()) {
    positions.set(messageKey(message), index);
  }

  for (const message of trusted) {
    if (!message?.serverCanonical) {
      continue;
    }

    const key = messageKey(message);
    const index = positions.get(key);

    if (index === undefined) {
      positions.set(key, result.length);
      result.push(message);
    } else {
      result[index] = { ...result[index], ...message };
    }
  }

  return result;
}

function legacySessionState(chat: StoredChat | null | undefined) {
  if (chat?.sessionBindingState?.state) return chat.sessionBindingState;
  return chat?.sessionId
    ? { state: 'legacy_unbound', reason: 'missing_server_identity' }
    : { state: 'none' };
}

export class ChatHistoryStore {
  readonly dir: string;

  readonly legacyPath: string;

  readonly log: HistoryLog | null;

  readonly registryProvider: () => Promise<ModelRegistry>;

  readonly defaultSurface: string;

  readonly now: () => number;

  private migrationPromise: Promise<{ changed: boolean; backupDir: string | null }> | null;

  private locks: Map<string, Promise<void>>;

  private logicalLocks: Map<string, Promise<void>>;

  private canonicalMessages: ((chatId: string, chat: StoredChat) => ChatRecord['messages']) | null = null;

  // Путь чат-файла → признаки файла и его шапка. Список чатов телефона не разбирает
  // неизменённые файлы заново: полная история весит сотни мегабайт.
  private headCache = new Map<string, {
    ino: number;
    size: number;
    mtimeMs: number;
    head: ChatHead | null;
  }>();

  /** `legacyPath` — старая схема «вся история в одном файле», мигрируется однократно. */
  constructor({
    chatsDir,
    legacyPath = '',
    log = null,
    registryProvider = async () => ({}),
    defaultSurface = 'chats',
    now = () => Date.now(),
  }: {
    chatsDir: string;
    legacyPath?: string;
    log?: HistoryLog | null;
    registryProvider?: () => Promise<ModelRegistry>;
    defaultSurface?: string;
    now?: () => number;
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
    // Логическая идентичность → хвост атомарного создания или восстановления. Блокировки по id недостаточно:
    // до появления первого файла у двух окон ещё нет общего id чата.
    this.logicalLocks = new Map();
  }

  /** Привязка durable-журналов уточнений после создания их владельцев в chat module. */
  setCanonicalMessages(source: (chatId: string, chat: StoredChat) => ChatRecord['messages']): void {
    this.canonicalMessages = source;
  }

  /**
   * Папка истории с самогитигнором: чаты — рабочие данные, в репозиторий не едут.
   */
  async ensureDir(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const gi = path.join(this.dir, '.gitignore');
    try { await fs.access(gi); } catch { await fs.writeFile(gi, '*\n!.gitignore\n'); }
  }

  fileOf(chat: StoredChat): string {
    const month = new Date(chat.createdAt || chat.updatedAt || Date.now()).toISOString().slice(0, 7);
    return path.join(this.dir, month, `${chat.id}.json`);
  }

  /**
   * Точечное чтение файла по id, без полного `scan()`.
   *
   * Месяц в пути — свойство `createdAt`, поэтому каталог заранее неизвестен: перебираем
   * месяцы от свежих к старым и пробуем ровно один файл в каждом. Исходные байты и путь
   * нужны сохранению для сравнения и переноса файла. Содержимое перечитывается при каждом
   * обращении, чтобы запись под блокировкой сливалась со свежей серверной копией.
   */
  async readEntry(id: unknown): Promise<ChatEntry | null> {
    if (!id) {
      return null;
    }
    const chatId = String(id);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(chatId)) {
      return null;
    }

    let months: string[] = [];
    try {
      months = await fs.readdir(this.dir);
    } catch {
      return null;
    }
    for (const month of months.filter((m) => /^\d{4}-\d{2}$/.test(m)).sort().reverse()) {
      const file = path.join(this.dir, month, `${chatId}.json`);
      try {
        const json = await fs.readFile(file, 'utf8');
        const chat = JSON.parse(json);
        if (chat?.id === chatId) {
          return { path: file, chat, json };
        }
      } catch {
        // Нет в этом месяце или файл битый — ищем дальше.
      }
    }
    return null;
  }

  /** Читает один чат без запуска миграции для служебных подписчиков. */
  async peek(id: unknown): Promise<StoredChat | null> {
    return (await this.readEntry(id))?.chat ?? null;
  }

  /**
   * Скан всех чат-файлов: Map id → { path, chat, json }.
   * Нечитаемый файл пропускаем — теряется один чат, не вся история.
   */
  async scan(): Promise<Map<string, ChatEntry>> {
    const map = new Map<string, ChatEntry>();
    let months: string[] = [];
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
          this.log?.warn?.({ file: p, err: (e as Error).message }, 'чат-файл не читается, пропущен');
        }
      }
    }
    return map;
  }

  /**
   * Шапки всех чатов без сообщений для частых лёгких списков (мобильный фасад).
   * Файл разбирается заново только при смене inode, размера или mtime; при повторе id,
   * как и в scan(), остаётся последний найденный файл. Удалённые файлы покидают кэш.
   */
  async heads(): Promise<ChatHead[]> {
    await this.ensureMigrated();

    const map = new Map<string, ChatHead>();
    const seen = new Set<string>();
    let months: string[] = [];

    try {
      months = await fs.readdir(this.dir);
    } catch {
      return [];
    }

    for (const month of months) {
      if (!/^\d{4}-\d{2}$/.test(month)) {
        continue;
      }

      const directory = path.join(this.dir, month);

      for (const name of await fs.readdir(directory)) {
        if (!name.endsWith('.json')) {
          continue;
        }

        const file = path.join(directory, name);

        seen.add(file);

        try {
          const head = await this.headOf(file);

          if (head?.id) {
            map.set(head.id, head);
          }
        } catch (e) {
          this.log?.warn?.({ file, err: (e as Error).message }, 'чат-файл не читается, пропущен');
        }
      }
    }

    for (const file of [...this.headCache.keys()]) {
      if (!seen.has(file)) {
        this.headCache.delete(file);
      }
    }

    return [...map.values()].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }

  /**
   * Шапка одного файла: из кэша по признакам файла либо из свежего разбора JSON.
   * В кэше остаются только поля списка, сообщения после разбора освобождаются.
   */
  private async headOf(file: string): Promise<ChatHead | null> {
    const stat = await fs.stat(file);
    const cached = this.headCache.get(file);

    if (cached && cached.ino === stat.ino && cached.size === stat.size
      && cached.mtimeMs === stat.mtimeMs) {
      return cached.head;
    }

    const chat = JSON.parse(await fs.readFile(file, 'utf8')) as StoredChat;
    const head: ChatHead | null = chat?.id
      ? {
        id: chat.id,
        title: chat.title,
        purpose: chat.purpose,
        taskId: chat.taskId,
        logicalIdentity: chat.logicalIdentity,
        model: chat.model,
        modelRef: chat.modelRef,
        unread: chat.unread,
        archived: chat.archived,
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt,
        preview: chatPreview(chat),
      }
      : null;

    this.headCache.set(file, {
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      head,
    });

    return head;
  }

  /**
   * Запись через tmp+rename: оборванная запись не оставляет полуфайл.
   * При durable приёме сообщения fsync завершается до ответа об успешной записи.
   */
  async writeAtomic(p: string, data: string, durable = false): Promise<void> {
    if (durable) {
      await writeDurableFile(p, data);

      return;
    }

    await fs.mkdir(path.dirname(p), { recursive: true });

    const temp = `${p}.${process.pid}.${randomUUID()}.tmp`;

    await fs.writeFile(temp, data, { mode: 0o600, flag: 'wx' });
    await fs.rename(temp, p);
    await fs.chmod(p, 0o600).catch(() => {});
  }

  async registry(): Promise<ModelRegistry> {
    try { return (await this.registryProvider()) || {}; }
    catch (error) {
      this.log?.warn?.(
        { err: (error as Error).message },
        'реестр моделей недоступен для миграции чатов',
      );
      return {};
    }
  }

  async readMetaRaw(): Promise<ChatMeta> {
    try { return JSON.parse(await fs.readFile(path.join(this.dir, 'meta.json'), 'utf8')); }
    catch { return {}; }
  }

  /**
   * Исходные байты того, что сейчас будет перезаписано. История чатов нигде больше
   * не хранится (папка под самогитигнором), а мигратор переписывает файлы сам при
   * старте — без копии ошибка в нём стёрла бы переписку молча и безвозвратно.
   *
   * Копируются ТОЛЬКО перезаписываемые файлы. Прежняя полная копия всей истории на
   * каждое расхождение защиты не добавляла (нетронутые файлы и так лежат целыми,
   * а откат возвращает ровно затёртое), зато набрала 268 МБ за три недели: рутинный
   * перерезолв моделей после обновления каталога стоил 7,5 МБ на каждый перезапуск.
   * Настоящая смена схемы трогает все файлы и поэтому копируется целиком сама собой.
   *
   * `sources` — файлы и их байты ДО записи, `meta` — прежняя мета, если её тоже
   * перезаписывают.
   */
  async backupMigration(
    sources: Array<{ path: string; json: string }>,
    meta: ChatMeta | null,
    label = 'chat-schema-v2',
  ): Promise<string> {
    const backupDir = path.join(
      this.dir,
      '.migration-backups',
      `${this.now()}-${label}-${randomUUID()}`,
    );
    await fs.mkdir(backupDir, { recursive: true, mode: 0o700 });
    let chats = 0;
    for (const { path: source, json } of sources) {
      const rel = path.relative(this.dir, source);
      const target = path.join(backupDir, rel);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.writeFile(target, json, { mode: 0o600, flag: 'wx' });
      chats += 1;
    }
    if (meta && Object.keys(meta).length) {
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
      chats,
    }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    return backupDir;
  }

  async migrateSchema(): Promise<{ changed: boolean; backupDir: string | null }> {
    await this.ensureDir();
    const entries = await this.scan();
    const meta = await this.readMetaRaw();
    const registry = await this.registry();
    const changes: Array<ChatEntry & { migrated: Record<string, unknown>; originalJson: string }> = [];
    for (const entry of entries.values()) {
      const surface = CHAT_SURFACES.has(String(entry.chat?.surface))
        ? entry.chat.surface
        : this.defaultSurface;
      const { chat: migrated } = migrateChatModelRecord(entry.chat, registry, { surface });
      migrated.revision = Number.isSafeInteger(entry.chat?.revision)
        && Number(entry.chat.revision) >= 0
        ? entry.chat.revision
        : 0;
      migrated.sessionBindingState = legacySessionState(entry.chat);
      const json = stableJson(migrated);
      // originalJson именно отдельным полем: спред entry кладёт исходные байты в
      // `json`, а следом их затирает мигрированный — копировать было бы уже нечего.
      if (json !== entry.json) changes.push({ ...entry, migrated, json, originalJson: entry.json });
    }
    const { meta: migratedMeta } = migrateDefaultModel(meta, registry);
    migratedMeta.schema = CHAT_SCHEMA;
    const metaChanged = stableJson(migratedMeta) !== stableJson(meta);
    if (!changes.length && !metaChanged) return { changed: false, backupDir: null };

    const backupDir = await this.backupMigration(
      changes.map((change) => ({ path: change.path, json: change.originalJson })),
      metaChanged ? meta : null,
    );
    for (const change of changes) await this.writeAtomic(change.path, change.json);
    if (metaChanged) await this.writeAtomic(path.join(this.dir, 'meta.json'), stableJson(migratedMeta));
    return { changed: true, backupDir };
  }

  async ensureMigrated(): Promise<{ changed: boolean; backupDir: string | null }> {
    if (!this.migrationPromise) this.migrationPromise = this.migrateSchema();
    return this.migrationPromise;
  }

  /** Явное восстановление chat-файлов из backup; production API этот метод не публикует. */
  async restoreMigrationBackup(backupDir: string): Promise<string[]> {
    const backupRoot = await fs.realpath(path.join(this.dir, '.migration-backups'));
    const sourceRoot = await fs.realpath(backupDir);
    if (!sourceRoot.startsWith(`${backupRoot}${path.sep}`)) throw new Error('backup вне chatsDir');
    const manifest = JSON.parse(await fs.readFile(path.join(sourceRoot, 'manifest.json'), 'utf8'));
    if (manifest?.schema !== 1) throw new Error('неподдерживаемый backup');
    const restored: string[] = [];
    const walk = async (dir: string): Promise<void> => {
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
   * HTTP-восстановление задаёт preserveMissing: старый снимок не удаляет чужие новые чаты.
   */
  async save(body: {
    sessions?: StoredChat[];
    archived?: StoredChat[];
    activeId?: string | null;
    defModel?: unknown;
    defModelRef?: unknown;
    defEffort?: unknown;
    defMode?: unknown;
    defWorkdir?: unknown;
    recentWorkdirs?: unknown;
  }, { preserveMissing = false } = {}): Promise<void> {
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
      // Полный PUT остался миграционным compatibility endpoint-ом. Server-created
      // companion нельзя удалить устаревшим снимком всего стора; для явного удаления
      // есть точечный DELETE.
      if (!preserveMissing && !seen.has(id)
        && v.chat?.purpose !== COMPANION_PURPOSE && !v.chat?.workdirState) {
        await this.remove(id);
      }
    }

    await this.saveMeta({
      activeId: body.activeId ?? null,
      defModel: body.defModel,
      defModelRef: body.defModelRef,
      defEffort: body.defEffort,
      defMode: body.defMode,
      defWorkdir: body.defWorkdir,
      recentWorkdirs: body.recentWorkdirs,
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
  async saveOne(
    chat: StoredChat | null | undefined,
    archived = false,
    { serverIdentity = '', reuseSteps }: { serverIdentity?: string; reuseSteps?: unknown } = {},
  ): Promise<SaveResult> {
    if (!chat?.id) return { written: false, restored: 0, dropped: 0 };

    const incoming = chat;

    await this.ensureMigrated();

    return this.withChatLock(incoming.id!, async () => {
      await this.ensureDir();
      // Ищем прежний файл этого чата: он мог лежать в другом месяце (архив, ручная правка).
      const prev = await this.readEntry(incoming.id);
      const chat = reuseSteps === undefined
        ? incoming
        : restoreHistorySteps(incoming, prev?.chat || null, reuseSteps);
      const registry = await this.registry();
      const incomingRevision = Number.isSafeInteger(chat.revision) ? chat.revision : null;
      const currentRevision = Number.isSafeInteger(prev?.chat?.revision)
        ? Number(prev?.chat?.revision)
        : 0;
      // Клиент без revision — старая версия. Историю от него по-прежнему принимаем,
      // но server-owned выбор модели уже не откатываем.
      const stale = !!prev && incomingRevision !== currentRevision;
      const clean = clientChat(chat);
      const choice = normalizeChatWorkdir(chat.workdir);

      if (Object.hasOwn(chat, 'workdir') && !choice) {
        throw new ChatHistoryError('bad_workdir', 'Выбор папки повреждён.', { statusCode: 400 });
      }
      if (prev && !stale && (
        (Object.hasOwn(chat, 'workdir') && !sameChatWorkdir(chat.workdir, prev.chat.workdir))
        || (Object.hasOwn(chat, 'taskId') && (chat.taskId || null) !== (prev.chat.taskId || null))
      ) && prev.chat.purpose !== COMPANION_PURPOSE) {
        throw new ChatHistoryError('workdir_change_required', 'Папка и задача меняются отдельным переходом.');
      }

      clean.workdir = prev
        ? (Object.hasOwn(prev.chat, 'workdir') ? prev.chat.workdir : { kind: 'cockpit' })
        : choice;

      if (prev) {
        clean.taskId = prev.chat.taskId ?? null;
      }

      const phase = prev?.chat.workdirState?.transition?.phase;

      if (phase && !['done', 'failed'].includes(phase)
        && ['modelRef', 'mode', 'effort'].some((key) => (
          Object.hasOwn(chat, key) && JSON.stringify(chat[key]) !== JSON.stringify(prev?.chat[key])
        ))) {
        throw new ChatHistoryError('chat_busy', 'Сначала дождитесь переноса разговора.');
      }

      const previousIdentity = companionIdentity(prev?.chat);
      let identity: CompanionIdentity | null = null;
      if (serverIdentity) {
        let taskId: string | null;
        try { taskId = normalizeCompanionTaskId(chat.taskId); } catch { throw rebindError(); }
        const expected = companionLogicalIdentity(taskId);
        if (chat.purpose !== COMPANION_PURPOSE || serverIdentity !== expected) throw rebindError();
        identity = { valid: true, taskId, key: expected };
      } else if (prev?.chat?.purpose === COMPANION_PURPOSE) {
        if (!previousIdentity?.valid) throw identityConflict([prev.chat]);
        if (Object.hasOwn(chat, 'purpose') && chat.purpose !== COMPANION_PURPOSE) throw rebindError();
        if (Object.hasOwn(chat, 'taskId')) {
          let taskId: string | null;
          try { taskId = normalizeCompanionTaskId(chat.taskId); } catch { throw rebindError(); }
          if (taskId !== previousIdentity.taskId) throw rebindError();
        }
        if (Object.hasOwn(chat, 'logicalIdentity')
          && chat.logicalIdentity !== previousIdentity.key) throw rebindError();
        identity = previousIdentity;
      } else if (chat.purpose === COMPANION_PURPOSE
        || Object.hasOwn(chat, 'logicalIdentity')) {
        throw rebindError();
      }
      if (identity && choice?.kind !== 'cockpit') {
        throw new ChatHistoryError('workdir_change_required', 'Папка компаньона определяется его задачей.');
      }
      if (identity) {
        clean.purpose = COMPANION_PURPOSE;
        clean.taskId = identity.taskId;
        clean.logicalIdentity = identity.key;
      }
      const surface = CHAT_SURFACES.has(String(prev?.chat?.surface))
        ? String(prev?.chat?.surface)
        : this.defaultSurface;
      let prepared: StoredChat;
      if (stale) {
        prepared = {
          ...clean,
          model: prev?.chat.model,
          modelRef: prev?.chat.modelRef,
          modelRefState: prev?.chat.modelRefState,
        };
      } else {
        prepared = migrateChatModelRecord(clean, registry, { surface }).chat;
      }
      const { chat: merged, restored, dropped } = mergeChat(
        prev?.chat || null,
        prepared,
        { allowClear: !stale },
      );
      const c: StoredChat = {
        ...merged,
        schema: CHAT_SCHEMA,
        surface,
        sessionBindingState: legacySessionState(prev?.chat || merged),
        archived: !!archived,
      };

      // Маркеры исполнения принадлежат серверу даже у свежего клиентского PUT.
      // Подтверждённая очистка меняет поколение, чтобы ledger не вернул старые реплики.
      for (const key of ['executionRunId', 'mobileHistoryAppliedAt', 'mobileHistoryEpoch']) {
        if (prev?.chat[key] !== undefined) {
          c[key] = prev.chat[key];
        }
      }

      const cleared = !stale && !!prev?.chat.messages?.length
        && Array.isArray(chat.messages) && chat.messages.length === 0;

      if (cleared) {
        c.mobileHistoryEpoch = Number(prev?.chat.mobileHistoryEpoch || 0) + 1;
        c.executionRunId = null;
        c.mobileHistoryAppliedAt = 0;
      }

      c.messages = cleared ? [] : protectCanonicalMessages(
        c.messages,
        [
          ...(prev?.chat.messages || []).filter((message) => message.serverCanonical),
          ...(this.canonicalMessages?.(String(chat.id), c) || []),
        ],
      );

      // Идентификаторы старых реплик принадлежат серверу, включая неканоническую историю веба.
      // Кратность одинаковых legacy-реплик сохраняется: один прежний id не назначается двум сообщениям.
      const mobileIds = new Map<string, string[]>();

      for (const message of prev?.chat.messages || []) {
        if (typeof message.mobileId !== 'string') {
          continue;
        }

        const key = messageKey(message);
        const ids = mobileIds.get(key) || [];

        ids.push(message.mobileId);
        mobileIds.set(key, ids);
      }

      for (const message of c.messages || []) {
        const id = mobileIds.get(messageKey(message))?.shift();

        if (id) {
          message.mobileId = id;
        }
      }

      if (stale && prev?.chat) {
        c.model = prev.chat.model;
        c.modelRef = prev.chat.modelRef;
        c.modelRefState = prev.chat.modelRefState;
        c.effort = prev.chat.effort;
        c.mode = prev.chat.mode;
        c.unread = prev.chat.unread;
      }
      if (prev?.chat.workdirState) {
        c.workdirState = prev.chat.workdirState;

        for (const key of WORKDIR_MEMORY_KEYS) {
          c[key] = prev.chat[key] ?? null;
        }
      }
      c.createdAt = c.createdAt || c.updatedAt || Date.now();
      const target = this.fileOf(c);
      // Нет семантического изменения — revision не накручиваем из-за повторного PUT.
      const currentShape = prev ? { ...c, revision: currentRevision } : null;

      if (prev && prev.path === target && stableJson(currentShape) === prev.json) {
        return {
          written: false,
          restored,
          dropped,
          stale,
          chat: prev.chat,
          stepReuseAck: historyStepReuseAck(chat, prev.chat)
        };
      }
      c.revision = currentRevision + 1;
      const json = stableJson(c);
      await this.writeAtomic(target, json);
      if (prev && prev.path !== target) await fs.rm(prev.path, { force: true });

      return {
        written: true,
        restored,
        dropped,
        stale,
        chat: c,
        stepReuseAck: historyStepReuseAck(chat, c)
      };
    });
  }

  /**
   * Серверная мутация исполняемого состояния поверх свежей записи.
   * Async callback завершает атомарный сброс сессии до допуска следующего PUT.
   * Генерация ответа модели под этим lock не выполняется.
   */
  async patchExecution(
    id: string,
    patch: (chat: StoredChat) => Partial<StoredChat> | Promise<Partial<StoredChat>>,
    options: { durable?: boolean; skipUnchanged?: boolean } = {},
  ): Promise<StoredChat> {
    await this.ensureMigrated();

    return this.withChatLock(id, async () => {
      const entry = await this.readEntry(id);

      if (!entry) {
        throw new ChatHistoryError('unknown_chat', 'Чат не найден.', { statusCode: 404 });
      }

      const before = stableJson(entry.chat);
      const next = {
        ...entry.chat,
        ...await patch(entry.chat),
      };

      if (options.skipUnchanged && stableJson(next) === before) {
        if (options.durable) {
          await this.writeAtomic(entry.path, entry.json, true);
        }

        return entry.chat;
      }

      next.revision = Number(entry.chat.revision || 0) + 1;

      await this.writeAtomic(entry.path, stableJson(next), options.durable);

      return next;
    });
  }

  /**
   * Барьер истории перед следующим ходом: короткий lock, свежая копия и одна
   * атомарная запись. При ошибке вызывающий не запускает executor.
   */
  async syncMessages(
    id: string,
    project: (messages: ChatRecord['messages'], chat: StoredChat) => ChatRecord['messages'],
  ): Promise<StoredChat> {
    await this.ensureMigrated();

    return this.withChatLock(id, async () => {
      const entry = await this.readEntry(id);

      if (!entry) {
        throw new ChatHistoryError('unknown_chat', 'Чат не найден.', { statusCode: 404 });
      }

      const messages = project(entry.chat.messages, entry.chat);
      const protectedMessages = protectCanonicalMessages(
        messages,
        this.canonicalMessages?.(id, entry.chat),
      );

      if (stableJson(protectedMessages) === stableJson(entry.chat.messages)) {
        return entry.chat;
      }

      const next = {
        ...entry.chat,
        messages: protectedMessages,
        revision: Number(entry.chat.revision || 0) + 1,
      };

      await this.writeAtomic(entry.path, stableJson(next));

      return next;
    });
  }

  /**
   * Очередь записи на чат: сохранения одного чата выполняются по очереди, разных —
   * параллельно. Ошибка одного сохранения не рвёт цепочку следующим.
   */
  async withChatLock<Value>(id: string, fn: () => Promise<Value>): Promise<Value> {
    const prev = this.locks.get(id) || Promise.resolve();
    const next = prev.then(fn, fn);
    // Хвост очереди чистим, только если за время работы её никто не продлил.
    const done = next.then(() => {}, () => {});
    this.locks.set(id, done);
    done.then(() => { if (this.locks.get(id) === done) this.locks.delete(id); });
    return next;
  }

  /** Та же очередь, но до появления физического chat id — по logical identity. */
  async withLogicalLock<Value>(key: string, fn: () => Promise<Value>): Promise<Value> {
    const prev = this.logicalLocks.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    const done = next.then(() => {}, () => {});
    this.logicalLocks.set(key, done);
    done.then(() => { if (this.logicalLocks.get(key) === done) this.logicalLocks.delete(key); });
    return next;
  }

  /**
   * Атомарно найти, создать или восстановить обычный chat record по server-owned
   * purpose/task scope. Сейчас единственный разрешённый purpose — companion.
   */
  async ensureByPurpose({ purpose, taskId = null }: {
    purpose?: string;
    taskId?: unknown;
  } = {}): Promise<EnsuredChat> {
    if (purpose !== COMPANION_PURPOSE) {
      throw new ChatHistoryError(
        'bad_chat_purpose',
        'Поддерживается только purpose companion.',
        { statusCode: 400 },
      );
    }
    const canonicalTaskId = normalizeCompanionTaskId(taskId);
    const key = companionLogicalIdentity(canonicalTaskId);
    await this.ensureMigrated();
    return this.withLogicalLock<EnsuredChat>(key, async () => {
      await this.ensureDir();
      const entries = await this.scan();
      const candidates = [...entries.values()]
        .map((entry) => entry.chat)
        .filter((chat) => {
          if (chat?.purpose !== COMPANION_PURPOSE) return false;
          // Берём объединение canonical scope и уже объявленного key. Иначе запись
          // `{taskId: 2, logicalIdentity: task:1}` была бы невидима ensure(task:1),
          // и сервер создал бы второй файл с тем же logical identity.
          if (chat.logicalIdentity === key) return true;
          try { return normalizeCompanionTaskId(chat.taskId) === canonicalTaskId; }
          catch { return false; }
        });
      if (candidates.length !== 1 && candidates.length !== 0) throw identityConflict(candidates);
      const current = candidates.length === 1 ? candidates[0] : null;
      if (current) {
        const identity = companionIdentity(current);
        if (!identity?.valid || identity.key !== key) throw identityConflict(candidates);
        if (!current.archived) {
          return { chat: current, created: false, restored: false, written: false };
        }
        const saved = await this.saveOne(current, false, { serverIdentity: key });
        return {
          ...saved,
          chat: saved.chat,
          created: false,
          restored: true,
        };
      }

      const at = this.now();
      const saved = await this.saveOne({
        id: randomUUID(),
        title: canonicalTaskId ? `Компаньон · задача #${canonicalTaskId}` : 'Компаньон',
        purpose: COMPANION_PURPOSE,
        taskId: canonicalTaskId,
        logicalIdentity: key,
        messages: [],
        createdAt: at,
        updatedAt: at,
      }, false, { serverIdentity: key });
      return {
        ...saved,
        chat: saved.chat,
        created: true,
        restored: false,
      };
    });
  }

  /**
   * Один чат по id — точечная досинхронизация окон: по событию `chat-store` окно тянет
   * ровно изменившийся чат, а не всю историю (она растёт, а меняется всегда один чат).
   */
  async readOne(id: unknown): Promise<StoredChat | null> {
    if (!id) return null;
    await this.ensureMigrated();
    const found = await this.readEntry(id);
    return found ? found.chat : null;
  }

  /** Удаление чата (человек стёр его в списке). Файла нет — значит уже удалён. */
  async remove(id: unknown): Promise<boolean> {
    if (!id) return false;
    await this.ensureMigrated();
    const chatId = String(id);
    // Companion ensure держит logical lock, а внутри него берёт per-id lock. DELETE
    // соблюдает тот же порядок, чтобы конкурентный ensure был линейным и без deadlock.
    const initial = await this.readEntry(chatId);
    const identity = companionIdentity(initial?.chat);
    const removeUnderChatLock = () => this.withChatLock(chatId, async () => {
      // Перечитываем файл уже под тем же per-id lock, что использует saveOne. DELETE,
      // начавшийся во время atomic PUT, удалит его результат, а не позволит позднему
      // rename воскресить durable companion identity.
      const prev = await this.readEntry(chatId);
      if (!prev) return false;
      await fs.rm(prev.path, { force: true });
      return true;
    });
    return identity?.valid
      ? this.withLogicalLock(identity.key, removeUnderChatLock)
      : removeUnderChatLock();
  }

  /**
   * Мета (активный чат и дефолты новых чатов) — отдельно от чатов, поэтому переключение
   * вкладки не тащит за собой переписку. Пишем слиянием: частичное обновление не должно
   * стирать соседние поля.
   */
  async saveMeta(meta: ChatMeta | null | undefined): Promise<ChatMeta> {
    await this.ensureMigrated();
    await this.ensureDir();
    const prev = await this.readMetaRaw();
    const next: Record<string, unknown> = { ...prev };
    const source = (meta ?? {}) as Record<string, unknown>;

    const metaKeys = [
      'activeId', 'defModel', 'defModelRef', 'defEffort', 'defMode', 'defWorkdir', 'recentWorkdirs',
    ];

    for (const k of metaKeys) {
      if (source[k] !== undefined) next[k] = source[k];
    }

    if (source.defWorkdir !== undefined) {
      const workdir = normalizeChatWorkdir(source.defWorkdir);

      if (!workdir) {
        throw new ChatHistoryError('bad_workdir', 'Папка по умолчанию повреждена.', { statusCode: 400 });
      }

      next.defWorkdir = workdir;
    }

    next.recentWorkdirs = normalizeRecentWorkdirs(next.recentWorkdirs);

    const migrated = migrateDefaultModel(next, await this.registry()).meta;
    migrated.schema = CHAT_SCHEMA;
    await this.writeAtomic(path.join(this.dir, 'meta.json'), stableJson(migrated));
    return migrated;
  }

  async read(): Promise<Record<string, unknown>> {
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
      defWorkdir: normalizeChatWorkdir(meta.defWorkdir) || { kind: 'cockpit' },
      recentWorkdirs: normalizeRecentWorkdirs(meta.recentWorkdirs),
    };
  }
}

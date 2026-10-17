// Хранилище базы агентов: agents/<id>.md — YAML-подобный frontmatter + тело-промпт.
// База ГЛОБАЛЬНАЯ (библиотека): агенты не привязаны к проектам — это маршруты
// проектов ссылаются на агентов (один ко многим).
// Формат намеренно простой (key: value, без вложенности). Все поля, кроме id файла, —
// рекомендации автору нового узла: runtime не читает отсюда tier/effort/executor/policy.
import { constants as fsConstants, promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { FileHandle } from 'node:fs/promises';

import { acquireKernelFileLock } from '../../lib/kernelLock.ts';
import type { AgentCard } from '../../../../shared/pipeline/agentsContracts.ts';

// Карточка агента без идентификатора: id задаёт имя файла в базе.
export type AgentRecord = Omit<AgentCard, 'id'>;

type NumberField = 'timeout' | 'budget';
type BooleanField = 'readonly' | 'optional';
type TextField = Exclude<keyof AgentRecord, NumberField | BooleanField | 'prompt'>;

// Описание поля frontmatter: имя и тип связаны, поэтому запись значения проверяема.
type FieldSpec =
  | readonly [TextField, 'str']
  | readonly [NumberField, 'num']
  | readonly [BooleanField, 'bool'];

// Поля frontmatter и их типы (порядок = порядок записи в файл).
const FIELDS: readonly FieldSpec[] = [
  ['kind', 'str'],      // agent | human | code — рекомендуемая форма нового блока
  ['label', 'str'],     // подпись блока
  ['sub', 'str'],       // сноска под блоком
  ['key', 'str'],       // рекомендуемый runKey нового узла
  ['tier', 'str'],      // класс требуемой модели, НЕ семейство (см. TIERS ниже)
  ['effort', 'str'],    // только авторская рекомендация; runtime policy — в runners.env
  ['timeout', 'num'],   // рекомендуемый timeout class/лимит, 0 = без рекомендации
  ['budget', 'num'],    // ориентир бюджета этапа, 0 = без рекомендации
  ['readonly', 'bool'], // рекомендация policy=state-only для нового узла
  ['optional', 'bool'], // рекомендация разрешить штатный skipped
];

/**
 * Класс требуемой модели, а не семейство. Библиотека агентов ГЛОБАЛЬНАЯ, а проекты
 * живут на разных провайдерах: «opus» в общем шаблоне нечего сверить с профилем на
 * codex, а «нужен рассуждающий класс» — есть чем. Какое семейство какому классу
 * соответствует, знает сам исполнитель (executor.familyClass), не эта база.
 */
export const TIERS = ['reasoning', 'balanced', 'cheap'];

// Совместимость чтения: до классов в шаблонах лежало claude-семейство (`model: opus`).
// Таблица одноразовая — при первом сохранении файл перепишется полем tier.
const LEGACY_MODEL_TIER: Record<string, string | undefined> = {
  opus: 'reasoning',
  fable: 'reasoning',
  sonnet: 'balanced',
  haiku: 'cheap',
};

export const ID_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;

// Ошибка хранилища: код разбирает HTTP-слой, поэтому он часть контракта наружу.
interface StoreError extends Error {
  code: string;
}

// Тождество файла на диске: dev+ino переживают переименование, путь — нет.
interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

// Версия файла: тождество плюс размер и времена — по ним видна правка на месте.
interface FileSnapshot extends FileIdentity {
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

const errorCode = (error: unknown) => (error as { code?: unknown } | null)?.code;

function storeError(code: string, message: string, cause: unknown = null): StoreError {
  const error = new Error(message) as StoreError;

  error.code = code;
  if (cause) error.cause = cause;

  return error;
}

function sameFile(left: FileIdentity | null, right: FileIdentity | null): boolean {
  if (!left || !right) return left === right;
  return left.dev === right.dev && left.ino === right.ino;
}

function sameVersion(left: FileSnapshot | null, right: FileSnapshot | null): boolean {
  if (!left || !right) return left === right;
  return sameFile(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
    await handle.sync();
  } catch {
    // На отдельных FS fsync каталога недоступен. Atomic link/rename от этого
    // остаются атомарными; слабее становится только гарантия после power loss.
  } finally {
    await handle?.close();
  }
}

export function defaults(): AgentRecord {
  return {
    kind: 'agent', label: '', sub: '', key: '', tier: '', effort: '',
    timeout: 0, budget: 0, readonly: false, optional: false, prompt: '',
  };
}

/** Разбор файла агента: frontmatter между парой '---' + тело-промпт. */
export function parseAgentFile(text: string): AgentRecord {
  const a = defaults();
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) { a.prompt = text.trim(); return a; }
  let legacyModel = '';
  for (const line of (m[1] ?? '').split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (k === 'model') { legacyModel = v; continue; }
    const f = FIELDS.find(([name]) => name === k);
    if (!f) continue;
    const [field, type] = f;
    if (type === 'num') a[field] = Number(v) || 0;
    else if (type === 'bool') a[field] = v === 'true';
    else a[field] = v;
  }
  // Файлы базы пишутся людьми и живут дольше формата: старое семейство читаем как класс.
  if (!a.tier && legacyModel) a.tier = LEGACY_MODEL_TIER[legacyModel.toLowerCase()] || '';
  a.prompt = text.slice(m[0].length).replace(/^\n+/, '').replace(/\s+$/, '');
  return a;
}

function serializeFrontmatterField(
  name: string,
  type: FieldSpec[1],
  value: string | number | boolean,
): string {
  if (type === 'str') {
    if (typeof value !== 'string') {
      throw storeError('invalid_agent_metadata', `${name}: ожидалась строка`);
    }
  } else if (type === 'num') {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw storeError('invalid_agent_metadata', `${name}: ожидалось неотрицательное целое`);
    }
  } else if (type === 'bool' && typeof value !== 'boolean') {
    throw storeError('invalid_agent_metadata', `${name}: ожидался boolean`);
  }
  const serialized = String(value);
  if (serialized.length > 2_000 || /[\u0000-\u001f\u007f]/u.test(serialized)) {
    throw storeError(
      'invalid_agent_metadata',
      `${name}: frontmatter допускает только одну строку без управляющих символов`,
    );
  }
  if (name === 'tier' && serialized && !TIERS.includes(serialized)) {
    throw storeError('invalid_agent_metadata', `tier: допустимо ${TIERS.join(' | ')} либо пусто`);
  }
  return serialized;
}

/** Сериализация агента в текст файла. */
export function serializeAgent(a: AgentRecord): string {
  const lines = ['---'];
  for (const [k, type] of FIELDS) {
    lines.push(`${k}: ${serializeFrontmatterField(k, type, a[k] ?? defaults()[k])}`);
  }
  if (typeof a.prompt !== 'string') {
    throw storeError('invalid_agent_metadata', 'prompt: ожидалась строка');
  }
  lines.push('---', '', a.prompt.trim(), '');
  return lines.join('\n');
}

export class AgentsStore {
  readonly dir: string;

  constructor(dir: string) {
    if (typeof dir !== 'string' || !dir.trim()) {
      throw storeError('unsafe_agents_root', 'Каталог agents обязателен');
    }
    this.dir = path.resolve(dir);
    if (this.dir === path.parse(this.dir).root) {
      throw storeError('unsafe_agents_root', 'Корень filesystem нельзя использовать как agentsDir');
    }
  }

  /**
   * Проверяет каждый компонент корня без следования по symlink. Проверка
   * повторяется перед каждой операцией: config может быть безопасным при старте,
   * а каталог — подменён позднее.
   */
  async _root({ create }: { create: boolean }): Promise<string> {
    const parsed = path.parse(this.dir);
    let current = parsed.root;
    const parts = path.relative(parsed.root, this.dir).split(path.sep).filter(Boolean);
    for (const part of parts) {
      current = path.join(current, part);
      let info;
      try {
        info = await fs.lstat(current);
      } catch (error) {
        if (errorCode(error) !== 'ENOENT' || !create) throw error;
        try {
          await fs.mkdir(current, { mode: 0o700 });
        } catch (mkdirError) {
          if (errorCode(mkdirError) !== 'EEXIST') throw mkdirError;
        }
        info = await fs.lstat(current);
      }
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw storeError(
          'unsafe_agents_root',
          `${current}: небезопасный компонент каталога agents`,
        );
      }
    }
    return this.dir;
  }

  async _ensureGitignore(): Promise<void> {
    // Папка — данные машины, не код: самогитигнорится (тот же паттерн, что chats/).
    const gi = path.join(this.dir, '.gitignore');
    let handle: FileHandle | null | undefined;
    try {
      handle = await fs.open(
        gi,
        fsConstants.O_WRONLY
          | fsConstants.O_CREAT
          | fsConstants.O_EXCL
          | fsConstants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile('*\n!.gitignore\n');
      await handle.sync();
      await handle.close();
      handle = null;
      await syncDirectory(this.dir);
    } catch (error) {
      await handle?.close().catch(() => {});
      if (errorCode(error) !== 'EEXIST') {
        if (errorCode(error) === 'ELOOP') {
          throw storeError('unsafe_agents_root', `${gi}: .gitignore является symlink`, error);
        }
        throw error;
      }
      let existing: FileHandle | undefined;
      try {
        existing = await fs.open(gi, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        const info = await existing.stat();
        if (!info.isFile()) {
          throw storeError('unsafe_agents_root', `${gi}: .gitignore не является обычным файлом`);
        }
      } catch (openError) {
        if (errorCode(openError) === 'unsafe_agents_root') throw openError;
        throw storeError('unsafe_agents_root', `${gi}: небезопасный .gitignore`, openError);
      } finally {
        await existing?.close().catch(() => {});
      }
    }
  }

  async ensureDir(): Promise<void> {
    await this._root({ create: true });
    await this._ensureGitignore();
    // Не даём подменить root между mkdir/.gitignore и последующей операцией.
    await this._root({ create: false });
  }

  async _withMutationLock<Value>(operation: () => Promise<Value>): Promise<Value> {
    await this.ensureDir();
    const held = await acquireKernelFileLock({
      lockPath: path.join(this.dir, '.agents.lock'),
      label: 'agents store',
      timeoutCode: 'agent_store_locked',
      unavailableCode: 'unsafe_agents_root',
      lostCode: 'agent_store_lock_lost',
      errorFactory: (code, message) => storeError(code, message),
    });
    try {
      held.assertHeld();
      const result = await operation();
      held.assertHeld();
      return result;
    } finally {
      await held.release();
    }
  }

  fileOf(id: string): string {
    if (!ID_RE.test(id)) {
      throw storeError('bad_id', 'bad agent id');
    }
    return path.join(this.dir, `${id}.md`);
  }

  async _snapshot(id: string, { missing = false } = {}): Promise<FileSnapshot | null> {
    await this._root({ create: false });
    const file = this.fileOf(id);
    try {
      const info = await fs.lstat(file, { bigint: true });
      if (info.isSymbolicLink() || !info.isFile()) {
        throw storeError('unsafe_agent_file', `${file}: файл агента небезопасен`);
      }
      return {
        dev: info.dev,
        ino: info.ino,
        size: info.size,
        mtimeNs: info.mtimeNs,
        ctimeNs: info.ctimeNs,
      };
    } catch (error) {
      if (missing && errorCode(error) === 'ENOENT') return null;
      throw error;
    }
  }

  /** Безопасное чтение через открытый fd: подмена path после open не меняет источник байтов. */
  async readBytes(id: string): Promise<Buffer> {
    await this._root({ create: false });
    const file = this.fileOf(id);
    let handle: FileHandle | undefined;
    try {
      handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const before = await handle.stat({ bigint: true });
      if (!before.isFile()) {
        throw storeError('unsafe_agent_file', `${file}: файл агента небезопасен`);
      }
      const bytes = await handle.readFile();
      const after = await handle.stat({ bigint: true });
      if (!sameVersion(before, after)) {
        throw storeError('agent_file_changed', `${file}: файл агента подменён во время чтения`);
      }
      const current = await this._snapshot(id);
      if (!sameFile(after, current)) {
        throw storeError('agent_file_changed', `${file}: путь агента подменён во время чтения`);
      }
      return bytes;
    } catch (error) {
      if (errorCode(error) === 'ELOOP') {
        throw storeError('unsafe_agent_file', `${file}: symlink агента запрещён`, error);
      }
      throw error;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async list(): Promise<AgentCard[]> {
    await this.ensureDir();
    const out: AgentCard[] = [];
    for (const entry of await fs.readdir(this.dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const id = entry.name.slice(0, -3);
      if (!ID_RE.test(id)) continue;
      try {
        out.push({ id, ...parseAgentFile((await this.readBytes(id)).toString('utf8')) });
      } catch { /* битый файл одного агента не валит список */ }
    }
    out.sort((a, b) => a.id.localeCompare(b.id));
    return out;
  }

  async get(id: string): Promise<AgentCard> {
    const text = (await this.readBytes(id)).toString('utf8');
    return { id, ...parseAgentFile(text) };
  }

  async save(id: string, agent: AgentRecord): Promise<void> {
    return this._withMutationLock(async () => {
      const file = this.fileOf(id);
      const before = await this._snapshot(id, { missing: true });
      const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
      let handle: FileHandle | null | undefined;
      try {
        handle = await fs.open(
          tmp,
          fsConstants.O_WRONLY
            | fsConstants.O_CREAT
            | fsConstants.O_EXCL
            | fsConstants.O_NOFOLLOW,
          0o600,
        );
        await handle.writeFile(serializeAgent(agent));
        await handle.sync();
        const temporary = await handle.stat({ bigint: true });
        if (!temporary.isFile()) {
          throw storeError('unsafe_agent_file', `${tmp}: временный файл агента небезопасен`);
        }
        await handle.close();
        handle = null;

        // Kernel lock координирует все экземпляры AgentsStore. Snapshot дополнительно
        // замечает ручную правку файла до commit; прямой редактор на диске сам lock
        // не соблюдает и поэтому не является поддерживаемым конкурентным writer-ом.
        const current = await this._snapshot(id, { missing: true });
        if (!sameVersion(before, current)) {
          throw storeError('agent_file_changed', `${file}: файл агента изменился во время сохранения`);
        }
        if (before === null) {
          // link не перезаписывает уже появившийся файл или symlink.
          try {
            await fs.link(tmp, file);
          } catch (error) {
            if (errorCode(error) === 'EEXIST') {
              throw storeError('agent_file_changed', `${file}: файл агента появился во время сохранения`, error);
            }
            throw error;
          }
          await fs.unlink(tmp);
        } else {
          // rename атомарно меняет только directory entry и никогда не следует
          // по конечному symlink.
          await fs.rename(tmp, file);
        }
        const published = await this._snapshot(id);
        if (!sameFile(temporary, published)) {
          throw storeError('agent_file_changed', `${file}: публикация агента была подменена`);
        }
        await syncDirectory(this.dir);
      } finally {
        await handle?.close().catch(() => {});
        await fs.rm(tmp, { force: true });
      }
    });
  }

  async exists(id: string): Promise<boolean> {
    try {
      return Boolean(await this._snapshot(id, { missing: true }));
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false;
      throw error;
    }
  }

  async remove(id: string): Promise<void> {
    return this._withMutationLock(async () => {
      const before = await this._snapshot(id);
      const current = await this._snapshot(id);
      if (!sameVersion(before, current)) {
        throw storeError('agent_file_changed', `${this.fileOf(id)}: файл агента изменился перед удалением`);
      }
      await fs.unlink(this.fileOf(id));
      await syncDirectory(this.dir);
    });
  }

  async isEmpty(): Promise<boolean> {
    return (await this.list()).length === 0;
  }
}

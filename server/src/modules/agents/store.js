// Хранилище базы агентов: agents/<id>.md — YAML-подобный frontmatter + тело-промпт.
// База ГЛОБАЛЬНАЯ (библиотека): агенты не привязаны к проектам — это маршруты
// проектов ссылаются на агентов (один ко многим).
// Формат намеренно простой (key: value, без вложенности). Все поля, кроме id файла, —
// рекомендации автору нового узла: runtime не читает отсюда tier/effort/executor/policy.
import { constants as fsConstants, promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { acquireKernelFileLock } from '../../lib/kernel-lock.js';

// Поля frontmatter и их типы (порядок = порядок записи в файл).
const FIELDS = [
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
const LEGACY_MODEL_TIER = {
  opus: 'reasoning', fable: 'reasoning', sonnet: 'balanced', haiku: 'cheap',
};

export const ID_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;

function storeError(code, message, cause = null) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function sameFile(left, right) {
  if (!left || !right) return left === right;
  return left.dev === right.dev && left.ino === right.ino;
}

function sameVersion(left, right) {
  if (!left || !right) return left === right;
  return sameFile(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function syncDirectory(directory) {
  let handle;
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

export function defaults() {
  return {
    kind: 'agent', label: '', sub: '', key: '', tier: '', effort: '',
    timeout: 0, budget: 0, readonly: false, optional: false, prompt: '',
  };
}

/** Разбор файла агента: frontmatter между парой '---' + тело-промпт. */
export function parseAgentFile(text) {
  const a = defaults();
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) { a.prompt = text.trim(); return a; }
  let legacyModel = '';
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (k === 'model') { legacyModel = v; continue; }
    const f = FIELDS.find(([name]) => name === k);
    if (!f) continue;
    if (f[1] === 'num') a[k] = Number(v) || 0;
    else if (f[1] === 'bool') a[k] = v === 'true';
    else a[k] = v;
  }
  // Файлы базы пишутся людьми и живут дольше формата: старое семейство читаем как класс.
  if (!a.tier && legacyModel) a.tier = LEGACY_MODEL_TIER[legacyModel.toLowerCase()] || '';
  a.prompt = text.slice(m[0].length).replace(/^\n+/, '').replace(/\s+$/, '');
  return a;
}

function serializeFrontmatterField(name, type, value) {
  if (type === 'str') {
    if (typeof value !== 'string') {
      throw storeError('invalid_agent_metadata', `${name}: ожидалась строка`);
    }
  } else if (type === 'num') {
    if (!Number.isSafeInteger(value) || value < 0) {
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
export function serializeAgent(a) {
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
  constructor(dir) {
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
  async _root({ create }) {
    const parsed = path.parse(this.dir);
    let current = parsed.root;
    const parts = path.relative(parsed.root, this.dir).split(path.sep).filter(Boolean);
    for (const part of parts) {
      current = path.join(current, part);
      let info;
      try {
        info = await fs.lstat(current);
      } catch (error) {
        if (error?.code !== 'ENOENT' || !create) throw error;
        try {
          await fs.mkdir(current, { mode: 0o700 });
        } catch (mkdirError) {
          if (mkdirError?.code !== 'EEXIST') throw mkdirError;
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

  async _ensureGitignore() {
    // Папка — данные машины, не код: самогитигнорится (тот же паттерн, что chats/).
    const gi = path.join(this.dir, '.gitignore');
    let handle;
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
      if (error?.code !== 'EEXIST') {
        if (error?.code === 'ELOOP') {
          throw storeError('unsafe_agents_root', `${gi}: .gitignore является symlink`, error);
        }
        throw error;
      }
      let existing;
      try {
        existing = await fs.open(gi, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        const info = await existing.stat();
        if (!info.isFile()) {
          throw storeError('unsafe_agents_root', `${gi}: .gitignore не является обычным файлом`);
        }
      } catch (openError) {
        if (openError?.code === 'unsafe_agents_root') throw openError;
        throw storeError('unsafe_agents_root', `${gi}: небезопасный .gitignore`, openError);
      } finally {
        await existing?.close().catch(() => {});
      }
    }
  }

  async ensureDir() {
    await this._root({ create: true });
    await this._ensureGitignore();
    // Не даём подменить root между mkdir/.gitignore и последующей операцией.
    await this._root({ create: false });
  }

  async _withMutationLock(operation) {
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

  fileOf(id) {
    if (!ID_RE.test(id)) {
      const error = new Error('bad agent id');
      error.code = 'bad_id';
      throw error;
    }
    return path.join(this.dir, `${id}.md`);
  }

  async _snapshot(id, { missing = false } = {}) {
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
      if (missing && error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  /** Безопасное чтение через открытый fd: подмена path после open не меняет источник байтов. */
  async readBytes(id) {
    await this._root({ create: false });
    const file = this.fileOf(id);
    let handle;
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
      if (error?.code === 'ELOOP') {
        throw storeError('unsafe_agent_file', `${file}: symlink агента запрещён`, error);
      }
      throw error;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async list() {
    await this.ensureDir();
    const out = [];
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

  async get(id) {
    const text = (await this.readBytes(id)).toString('utf8');
    return { id, ...parseAgentFile(text) };
  }

  async save(id, agent) {
    return this._withMutationLock(async () => {
      const file = this.fileOf(id);
      const before = await this._snapshot(id, { missing: true });
      const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
      let handle;
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
            if (error?.code === 'EEXIST') {
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

  async exists(id) {
    try {
      return Boolean(await this._snapshot(id, { missing: true }));
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  }

  async remove(id) {
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

  async isEmpty() {
    return (await this.list()).length === 0;
  }
}

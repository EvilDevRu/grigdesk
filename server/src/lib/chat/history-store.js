// Хранилище истории чатов: папка chats/ в корне проекта.
// Каждый чат — свой файл chats/YYYY-MM/<id>.json (месяц СОЗДАНИЯ чата, файл не переезжает),
// мета (активный чат, дефолты модели/усилия) — chats/meta.json. Битый файл одного чата
// не валит остальную историю: он пропускается с предупреждением.
import { promises as fs } from 'node:fs';
import path from 'node:path';

export class ChatHistoryStore {
  /**
   * @param {{ chatsDir: string, legacyPath?: string, log?: object }} opts
   *   legacyPath — старая схема «вся история в одном файле», мигрируется однократно.
   */
  constructor({ chatsDir, legacyPath = '', log = null }) {
    this.dir = chatsDir;
    this.legacyPath = legacyPath;
    this.log = log;
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
    await fs.writeFile(p + '.tmp', data);
    await fs.rename(p + '.tmp', p);
  }

  /**
   * Раскладывает стор по файлам: пишет только изменившиеся чаты, удаляет файлы
   * исчезнувших, переносит файл при смене месяца (не должно случаться).
   */
  async save(body) {
    await this.ensureDir();
    const incoming = [
      ...(body.sessions || []).map((c) => ({ ...c, archived: false })),
      ...(body.archived || []).map((c) => ({ ...c, archived: true })),
    ];
    const existing = await this.scan();
    const seen = new Set();
    for (const c of incoming) {
      if (!c.id) continue;
      c.createdAt = c.createdAt || c.updatedAt || Date.now();
      seen.add(c.id);
      const target = this.fileOf(c);
      const json = JSON.stringify(c);
      const prev = existing.get(c.id);
      if (prev && prev.path === target && prev.json === json) continue;
      await this.writeAtomic(target, json);
      if (prev && prev.path !== target) await fs.rm(prev.path, { force: true });
    }
    for (const [id, v] of existing) {
      if (!seen.has(id)) await fs.rm(v.path, { force: true });
    }
    await this.saveMeta({
      activeId: body.activeId ?? null, defModel: body.defModel, defEffort: body.defEffort, defMode: body.defMode,
    });
  }

  /**
   * Запись ОДНОГО чата — основной путь сохранения. Раньше клиент присылал весь стор
   * одним телом; вместе с лентами шагов он дорос до лимита тела запроса, сервер начал
   * отвечать 413, и история не сохранялась вовсе. Одно тело = один чат, и объём запроса
   * больше не зависит от того, сколько всего чатов накопилось.
   * Возвращает false, если на диске уже лежит ровно это (частый случай — лишний persist).
   */
  async saveOne(chat, archived = false) {
    if (!chat?.id) return false;
    await this.ensureDir();
    const c = { ...chat, archived: !!archived };
    c.createdAt = c.createdAt || c.updatedAt || Date.now();
    const target = this.fileOf(c);
    const json = JSON.stringify(c);
    // Ищем прежний файл этого чата: он мог лежать в другом месяце (архив, ручная правка).
    const prev = (await this.scan()).get(c.id);
    if (prev && prev.path === target && prev.json === json) return false;
    await this.writeAtomic(target, json);
    if (prev && prev.path !== target) await fs.rm(prev.path, { force: true });
    return true;
  }

  /** Удаление чата (человек стёр его в списке). Файла нет — значит уже удалён. */
  async remove(id) {
    if (!id) return false;
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
    await this.ensureDir();
    let prev = {};
    try { prev = JSON.parse(await fs.readFile(path.join(this.dir, 'meta.json'), 'utf8')); } catch { /* меты ещё нет */ }
    const next = { ...prev };
    for (const k of ['activeId', 'defModel', 'defEffort', 'defMode']) {
      if (meta?.[k] !== undefined) next[k] = meta[k];
    }
    await this.writeAtomic(path.join(this.dir, 'meta.json'), JSON.stringify(next));
    return next;
  }

  async read() {
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
    let meta = {};
    try { meta = JSON.parse(await fs.readFile(path.join(this.dir, 'meta.json'), 'utf8')); } catch { /* меты ещё нет */ }
    const all = [...map.values()].map((v) => v.chat).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    return {
      sessions: all.filter((c) => !c.archived),
      archived: all.filter((c) => c.archived),
      activeId: meta.activeId ?? null,
      defModel: meta.defModel,
      defEffort: meta.defEffort,
      // defMode клиент присылал, а мета его не хранила — выбранный режим прав не переживал
      // перезагрузку страницы и молча откатывался к режиму по умолчанию.
      defMode: meta.defMode,
    };
  }
}

// Хранилище базы агентов: agents/<id>.md — YAML-подобный frontmatter + тело-промпт.
// База ГЛОБАЛЬНАЯ (библиотека): агенты не привязаны к проектам — это маршруты
// проектов ссылаются на агентов (один ко многим).
// Формат намеренно простой (key: value, без вложенности) — читается и человеком, и движком.
import { promises as fs } from 'node:fs';
import path from 'node:path';

// Поля frontmatter и их типы (порядок = порядок записи в файл).
const FIELDS = [
  ['kind', 'str'],      // agent | human | code — форма блока на схеме
  ['label', 'str'],     // подпись блока
  ['sub', 'str'],       // сноска под блоком
  ['key', 'str'],       // ключ реестра прогона (SCOUT, PHPCHECK…)
  ['model', 'str'],     // семейство модели ('' = сессионная; точный id = явный pin)
  ['effort', 'str'],    // усилие размышлений ('' = дефолт движка); значения — из реестра моделей
  ['timeout', 'num'],   // сек, 0 = дефолт движка
  ['budget', 'num'],    // ориентир бюджета этапа, 0 = нет
  ['readonly', 'bool'], // запрет записи в каталоги проекта
  ['optional', 'bool'], // этап можно штатно пропускать
];

export const ID_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;

export function defaults() {
  return {
    kind: 'agent', label: '', sub: '', key: '', model: '', effort: '',
    timeout: 0, budget: 0, readonly: false, optional: false, prompt: '',
  };
}

/** Разбор файла агента: frontmatter между парой '---' + тело-промпт. */
export function parseAgentFile(text) {
  const a = defaults();
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) { a.prompt = text.trim(); return a; }
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    const f = FIELDS.find(([name]) => name === k);
    if (!f) continue;
    if (f[1] === 'num') a[k] = Number(v) || 0;
    else if (f[1] === 'bool') a[k] = v === 'true';
    else a[k] = v;
  }
  a.prompt = text.slice(m[0].length).replace(/^\n+/, '').replace(/\s+$/, '');
  return a;
}

/** Сериализация агента в текст файла. */
export function serializeAgent(a) {
  const lines = ['---'];
  for (const [k] of FIELDS) lines.push(`${k}: ${a[k] ?? ''}`);
  lines.push('---', '', (a.prompt || '').trim(), '');
  return lines.join('\n');
}

export class AgentsStore {
  constructor(dir) { this.dir = dir; }

  async ensureDir() {
    await fs.mkdir(this.dir, { recursive: true });
    // Папка — данные машины, не код: самогитигнорится (тот же паттерн, что chats/).
    const gi = path.join(this.dir, '.gitignore');
    try { await fs.access(gi); } catch { await fs.writeFile(gi, '*\n!.gitignore\n'); }
  }

  fileOf(id) { return path.join(this.dir, `${id}.md`); }

  async list() {
    await this.ensureDir();
    const out = [];
    for (const f of await fs.readdir(this.dir)) {
      if (!f.endsWith('.md')) continue;
      const id = f.slice(0, -3);
      try {
        out.push({ id, ...parseAgentFile(await fs.readFile(this.fileOf(id), 'utf8')) });
      } catch { /* битый файл одного агента не валит список */ }
    }
    out.sort((a, b) => a.id.localeCompare(b.id));
    return out;
  }

  async get(id) {
    const text = await fs.readFile(this.fileOf(id), 'utf8');
    return { id, ...parseAgentFile(text) };
  }

  async save(id, agent) {
    await this.ensureDir();
    const tmp = `${this.fileOf(id)}.tmp`;
    await fs.writeFile(tmp, serializeAgent(agent));
    await fs.rename(tmp, this.fileOf(id));
  }

  async exists(id) {
    try { await fs.access(this.fileOf(id)); return true; } catch { return false; }
  }

  async remove(id) { await fs.unlink(this.fileOf(id)); }

  async isEmpty() {
    await this.ensureDir();
    return !(await fs.readdir(this.dir)).some((f) => f.endsWith('.md'));
  }
}

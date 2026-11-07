import { promises as fs } from 'node:fs';
import path from 'node:path';

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const FIELDS = [
  'projectId', 'sessionId', 'profileId', 'actor', 'query', 'queryClass', 'tables',
  'decision', 'outcome', 'durationMs', 'rows', 'bytes', 'truncated', 'error',
];

// Запись журнала. Поля берутся по явному allowlist: пароль, параметры запроса и
// значения строк не должны попасть в файл ни при какой форме входа.
export interface DbAuditRecord {
  at: string;
  [field: string]: unknown;
}

export interface DbAuditPage {
  items: DbAuditRecord[];
  nextCursor: number | null;
  skippedRecords?: number;
}

function recordOf(entry: unknown, at: string): DbAuditRecord {
  const source = (entry ?? {}) as Record<string, unknown>;
  const record: DbAuditRecord = { at };

  for (const field of FIELDS) {
    if (source[field] !== undefined) record[field] = source[field];
  }

  return record;
}

/**
 * Журнал хранит только поля allowlist, без пароля, параметров и значений строк.
 * Повреждённые строки остаются на диске, но не скрывают целые записи при чтении.
 */
export async function createDbAudit(
  { dir = '', now = () => new Date() }: { dir?: string; now?: () => Date | number } = {},
) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });

  async function cleanup() {
    const threshold = new Date(now()).getTime() - RETENTION_MS;
    const names = await fs.readdir(dir).catch(() => []);
    await Promise.all(names.filter((name) => /^\d{4}-\d{2}-\d{2}\.ndjson$/u.test(name))
      .map(async (name) => {
        const day = Date.parse(`${name.slice(0, 10)}T00:00:00.000Z`);
        if (Number.isFinite(day) && day < threshold) {
          await fs.rm(path.join(dir, name), { force: true });
        }
      }));
  }

  /**
   * Новая запись отделяется от повреждённого или незавершённого хвоста переводом строки.
   * Существующие байты не исправляются и не удаляются автоматически.
   */
  async function append(entry: unknown): Promise<DbAuditRecord> {
    await cleanup();
    const at = new Date(now()).toISOString();
    const record = recordOf(entry, at);
    const file = await fs.open(path.join(dir, `${at.slice(0, 10)}.ndjson`), 'a+', 0o600);

    try {
      const { size } = await file.stat();
      const last = Buffer.alloc(1);

      if (size > 0) {
        await file.read(last, 0, 1, size - 1);
      }

      const separator = size > 0 && last[0] !== 10 ? '\n' : '';

      await file.appendFile(`${separator}${JSON.stringify(record)}\n`);
    } finally {
      await file.close();
    }

    return record;
  }

  /**
   * Повреждённая строка учитывается предупреждением, не меняя файл и порядок записей.
   * Пагинация считает только целые записи, поэтому следующий cursor остаётся честным.
   */
  async function list(
    { cursor = 0, limit = 50 }: { cursor?: unknown; limit?: unknown } = {},
  ): Promise<DbAuditPage> {
    await cleanup();
    const names = (await fs.readdir(dir).catch(() => []))
      .filter((name) => name.endsWith('.ndjson')).sort().reverse();
    const items: DbAuditRecord[] = [];
    let skippedRecords = 0;

    for (const name of names) {
      const raw = await fs.readFile(path.join(dir, name), 'utf8');

      for (const line of raw.split('\n').filter((value) => value.trim()).reverse()) {
        try {
          const entry: unknown = JSON.parse(line);

          if (!entry || typeof entry !== 'object' || Array.isArray(entry)
            || typeof (entry as DbAuditRecord).at !== 'string') {
            skippedRecords += 1;
            continue;
          }

          items.push(recordOf(entry, (entry as DbAuditRecord).at));
        } catch {
          skippedRecords += 1;
        }
      }
    }

    const offset = Math.max(0, Number(cursor) || 0);
    const size = Math.max(1, Math.min(200, Number(limit) || 50));

    return {
      items: items.slice(offset, offset + size),
      nextCursor: offset + size < items.length ? offset + size : null,
      ...(skippedRecords ? { skippedRecords } : {}),
    };
  }

  return { append, list, cleanup };
}

export default createDbAudit;

import { promises as fs } from 'node:fs';
import path from 'node:path';

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function recordOf(entry, at) {
  const fields = [
    'projectId', 'connectionId', 'sessionId', 'label', 'role', 'host', 'user',
    'command', 'decision', 'comment', 'result', 'exitCode', 'signal', 'output',
  ];
  const record = {};
  for (const field of fields) {
    if (entry[field] !== undefined) {
      record[field] = entry[field];
    }
  }
  record.at = at;
  return record;
}

/**
 * Дневной NDJSON-журнал хранит только ограниченный результат. Поля вне явного
 * allowlist, включая пароль и полный сырой вывод, отбрасываются до сериализации.
 */
export async function createSshAudit(options = {}) {
  const dir = options.dir;
  const now = options.now || (() => new Date());
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);

  async function cleanup() {
    const threshold = new Date(now()).getTime() - RETENTION_MS;
    const names = await fs.readdir(dir).catch(() => []);
    await Promise.all(names.filter((name) => /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(name)).map(
      async (name) => {
        const day = Date.parse(`${name.slice(0, 10)}T00:00:00.000Z`);
        if (Number.isFinite(day) && day < threshold) {
          await fs.rm(path.join(dir, name), { force: true });
        }
      },
    ));
  }

  async function append(entry) {
    await cleanup();
    const instant = new Date(now());
    const at = instant.toISOString();
    const file = path.join(dir, `${at.slice(0, 10)}.ndjson`);
    const record = recordOf(entry, at);
    await fs.appendFile(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    await fs.chmod(file, 0o600);
    return record;
  }

  async function list({ cursor = 0, limit = 50, connectionId = '' } = {}) {
    await cleanup();
    const names = (await fs.readdir(dir).catch(() => []))
      .filter((name) => name.endsWith('.ndjson'))
      .sort()
      .reverse();
    const items = [];
    for (const name of names) {
      const raw = await fs.readFile(path.join(dir, name), 'utf8');
      for (const line of raw.trim().split('\n').filter(Boolean).reverse()) {
        const item = JSON.parse(line);
        if (!connectionId || item.connectionId === connectionId) {
          items.push(item);
        }
      }
    }
    const offset = Math.max(0, Number(cursor) || 0);
    const size = Math.max(1, Math.min(200, Number(limit) || 50));
    const page = items.slice(offset, offset + size);
    return {
      items: page,
      nextCursor: offset + page.length < items.length ? offset + page.length : null,
    };
  }

  return { append, list, cleanup };
}

export default createSshAudit;

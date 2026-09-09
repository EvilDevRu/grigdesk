import { DatabaseSync } from 'node:sqlite';

interface PreflightCheck {
  id: string;
  ok: boolean;
  reasonCode?: string;
  actualVersion?: unknown;
}

// Одна проверка среды. Отказ — это состояние, а не исключение: отчёт читают и
// человек, и клиент запуска, и «проверить не удалось» им обоим важнее падения.
function check(id: string, operation: () => Record<string, unknown>): PreflightCheck {
  try {
    return { id, ok: true, ...operation() };
  } catch {
    return { id, ok: false, reasonCode: `${id}_unavailable` };
  }
}

/**
 * Probe использует только in-memory SQLite и потому не создаёт пользовательскую
 * базу. Отчёт пригоден и человеку, и versioned startup-клиенту.
 */
export async function runKnowledgeSearchRuntimePreflight(): Promise<{
  ok: boolean;
  reasonCode?: string;
  checks: PreflightCheck[];
}> {
  const node = check('node_runtime', () => ({ actualVersion: process.versions.node }));
  let sqliteVersion = '';
  const sqlite = check('sqlite_runtime', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const row = db.prepare('SELECT sqlite_version() AS version').get() as { version?: unknown };

      sqliteVersion = String(row?.version);
      return { actualVersion: sqliteVersion };
    } finally {
      db.close();
    }
  });
  const fts = check('fts5', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE VIRTUAL TABLE probe_fts USING fts5(value)');
      db.prepare('INSERT INTO probe_fts(value) VALUES (?)').run('готово');
      const row = db
        .prepare("SELECT count(*) AS count FROM probe_fts WHERE probe_fts MATCH 'готово'")
        .get() as { count?: unknown };
      const found = Number(row?.count);

      if (found !== 1) {
        throw new Error('FTS5 self-check failed');
      }
      return { actualVersion: sqliteVersion || process.versions.sqlite || '' };
    } finally {
      db.close();
    }
  });
  const checks = [node, sqlite, fts];
  const failed = checks.find((item) => !item.ok);
  return {
    ok: !failed,
    ...(failed ? { reasonCode: failed.reasonCode } : {}),
    checks,
  };
}

export default runKnowledgeSearchRuntimePreflight;

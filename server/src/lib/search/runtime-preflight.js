import { DatabaseSync } from 'node:sqlite';

function check(id, operation) {
  try {
    return { id, ok: true, ...operation() };
  } catch (error) {
    return { id, ok: false, reasonCode: `${id}_unavailable` };
  }
}

/**
 * Probe использует только in-memory SQLite и потому не создаёт пользовательскую
 * базу. Отчёт пригоден и человеку, и versioned startup-клиенту.
 */
export async function runKnowledgeSearchRuntimePreflight() {
  const node = check('node_runtime', () => ({ actualVersion: process.versions.node }));
  let sqliteVersion = '';
  const sqlite = check('sqlite_runtime', () => {
    const db = new DatabaseSync(':memory:');
    try {
      sqliteVersion = String(db.prepare('SELECT sqlite_version() AS version').get().version);
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
      const found = db.prepare("SELECT count(*) AS count FROM probe_fts WHERE probe_fts MATCH 'готово'")
        .get().count;
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

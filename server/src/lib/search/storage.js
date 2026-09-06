import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import {
  KnowledgeError,
  conflict,
  invalidArguments,
  notFound,
  unavailable,
} from './errors.js';
import { normalizeForSearch, normalizedTokens, originalFragment } from './normalize.js';
import { SAMPLE_RECORDS } from './sample-records.js';
import { KNOWLEDGE_SCHEMA_SQL, KNOWLEDGE_SCHEMA_VERSION, SAMPLE_MARKER } from './schema.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCE_DOCUMENT_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const SEMANTIC_FIELDS = ['project', 'repository', 'kind', 'title', 'body', 'tags'];
const PROVENANCE_FIELDS = ['actor', 'channel', 'ref'];
const PROVENANCE_CHANNELS = new Set(['pipeline', 'chat', 'cli']);

function tagsOf(db, id) {
  return db.prepare(
    'SELECT tag FROM record_tags WHERE record_id = ? ORDER BY position, tag',
  ).all(id).map((row) => row.tag);
}

function publicRecord(db, row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    project: row.project,
    repository: row.repository,
    kind: row.kind,
    title: row.title,
    body: row.body,
    tags: tagsOf(db, row.id),
    updatedAt: row.updated_at,
    revision: row.revision,
    provenance: row.provenance ? JSON.parse(row.provenance) : null,
  };
}

function cleanProvenance(value) {
  if (value == null) {
    return null;
  }
  if (typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...PROVENANCE_FIELDS].sort().join(',')) {
    throw invalidArguments('Происхождение записи заполнено некорректно.');
  }
  const provenance = {
    actor: String(value.actor || '').trim(),
    channel: String(value.channel || '').trim(),
    ref: String(value.ref || '').trim(),
  };
  if (provenance.actor !== 'executor' || !PROVENANCE_CHANNELS.has(provenance.channel)
    || !provenance.ref) {
    throw invalidArguments('Происхождение записи заполнено некорректно.');
  }
  return provenance;
}

function cleanTags(value) {
  const result = [];
  for (const raw of Array.isArray(value) ? value : []) {
    const tag = String(raw || '').normalize('NFKC').trim();
    if (tag && !result.includes(tag)) {
      result.push(tag);
    }
  }
  return result;
}

/**
 * Первый тег адресует карту и потому проверяется до удаления пустых тегов:
 * очистка не должна незаметно назначать следующую тему владельцем записи.
 */
function cleanRecordTags(value) {
  const sourceDocument = Array.isArray(value) && typeof value[0] === 'string'
    ? value[0].normalize('NFKC').trim()
    : '';

  if (!SOURCE_DOCUMENT_RE.test(sourceDocument)) {
    throw invalidArguments(
      'Первый тег обязателен: используйте строчные латинские буквы, цифры и дефис между ними.',
    );
  }

  return cleanTags(value);
}

function cleanRecord(input, current = null) {
  const merged = { ...(current || {}), ...(input || {}) };
  const value = {
    project: String(merged.project || '').trim(),
    repository: String(merged.repository || '').trim(),
    kind: String(merged.kind || '').trim(),
    title: String(merged.title || '').trim(),
    body: String(merged.body || ''),
    tags: cleanRecordTags(merged.tags),
    provenance: Object.hasOwn(input || {}, 'provenance')
      ? cleanProvenance(input.provenance)
      : cleanProvenance(current?.provenance),
  };
  if (!value.project || !value.repository || !value.kind || !value.title) {
    throw invalidArguments('Проект, репозиторий, вид и заголовок обязательны.');
  }
  return value;
}

function withTransaction(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Исходная ошибка важнее вторичного отказа rollback.
    }
    throw error;
  }
}

function replaceIndex(db, id, value) {
  db.prepare('DELETE FROM records_fts WHERE id = ?').run(id);
  db.prepare('INSERT INTO records_fts(id, title, tags, body) VALUES (?, ?, ?, ?)').run(
    id,
    normalizeForSearch(value.title),
    normalizeForSearch(value.tags.join(' ')),
    normalizeForSearch(value.body),
  );
}

function replaceTags(db, id, tags) {
  db.prepare('DELETE FROM record_tags WHERE record_id = ?').run(id);
  const insert = db.prepare(
    'INSERT INTO record_tags(record_id, tag, position) VALUES (?, ?, ?)',
  );
  tags.forEach((tag, index) => insert.run(id, tag, index));
}

function insertRecord(db, input, {
  id = randomUUID(),
  updatedAt = new Date().toISOString(),
  revision = 1,
} = {}) {
  const value = cleanRecord(input);
  db.prepare(`
    INSERT INTO records(
      id, project, repository, kind, title, body, updated_at, revision, provenance
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    value.project,
    value.repository,
    value.kind,
    value.title,
    value.body,
    updatedAt,
    revision,
    value.provenance ? JSON.stringify(value.provenance) : null,
  );
  replaceTags(db, id, value.tags);
  replaceIndex(db, id, value);
  return id;
}

function importStale() {
  return new KnowledgeError('Снимок импорта устарел или требует решения конфликтов.', {
    code: 'KNOWLEDGE_IMPORT_STALE',
  });
}

function sameSemanticRecord(left, right) {
  return SEMANTIC_FIELDS.every((field) => {
    if (field === 'tags') {
      return left.tags.length === right.tags.length
        && left.tags.every((tag, index) => tag === right.tags[index]);
    }
    return left[field] === right[field];
  });
}

/**
 * Проверяет lossless-запись снимка до планирования batch: импорт не имеет права
 * нормализовать поля молча или принять источник, который нельзя превратить в карту.
 */
function validateImportedRecords(input) {
  if (!Array.isArray(input)) {
    throw invalidArguments('Снимок знаний должен содержать массив записей.');
  }

  const ids = new Set();
  return input.map((record) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw invalidArguments('Каждая запись снимка должна быть объектом.');
    }
    if (!UUID_RE.test(String(record.id || '')) || ids.has(record.id)) {
      throw invalidArguments('UUID записей снимка должны быть уникальными и корректными.');
    }
    ids.add(record.id);

    for (const field of ['project', 'repository', 'kind', 'title', 'body', 'updatedAt']) {
      if (typeof record[field] !== 'string') {
        throw invalidArguments(`Поле ${field} записи снимка должно быть строкой.`);
      }
    }
    if (!record.project.trim() || !record.repository.trim() || !record.kind.trim()
      || !record.title.trim() || !Number.isFinite(Date.parse(record.updatedAt))) {
      throw invalidArguments('Обязательные поля записи снимка заполнены некорректно.');
    }
    if (!Number.isInteger(record.revision) || record.revision < 1) {
      throw invalidArguments('Ревизия записи снимка должна быть положительным целым числом.');
    }
    if (!Array.isArray(record.tags) || !record.tags.length
      || record.tags.some((tag) => typeof tag !== 'string' || !tag.trim())
      || new Set(record.tags).size !== record.tags.length) {
      throw invalidArguments('Теги записи снимка должны быть непустым упорядоченным массивом.');
    }
    if (!SOURCE_DOCUMENT_RE.test(record.tags[0])) {
      throw invalidArguments('Первый тег записи должен быть безопасным именем документа.');
    }

    const semantic = cleanRecord(record);
    if (!sameSemanticRecord(semantic, record)) {
      throw invalidArguments('Поля записи снимка не должны требовать нормализации.');
    }
    return { ...record, tags: [...record.tags] };
  }).sort((left, right) => left.id.localeCompare(right.id));
}

function changedFields(incoming, current) {
  return SEMANTIC_FIELDS.filter((field) => {
    if (field === 'tags') {
      return !sameSemanticRecord({ ...incoming, ...current, tags: incoming.tags }, current);
    }
    return incoming[field] !== current[field];
  });
}

/**
 * Строит authoritative план относительно текущей транзакции. Сначала распознаёт
 * semantic no-op, поэтому отличающаяся ревизия одинаковой записи не создаёт конфликт.
 */
function buildImportPlan(db, records) {
  const incomingIds = new Set(records.map((record) => record.id));
  const plan = [];
  const conflicts = [];

  for (const incoming of records) {
    const current = publicRecord(db, db.prepare('SELECT * FROM records WHERE id = ?').get(incoming.id));
    if (!current) {
      plan.push({ action: 'create', incoming });
    } else if (sameSemanticRecord(incoming, current)) {
      plan.push({ action: 'unchanged', incoming, current });
    } else if (current.revision === incoming.revision) {
      plan.push({ action: 'update', incoming, current });
    } else {
      const item = {
        id: incoming.id,
        title: incoming.title,
        baseRevision: incoming.revision,
        currentRevision: current.revision,
        changedFields: changedFields(incoming, current),
        incoming,
        current,
      };
      plan.push({ action: 'conflict', incoming, current, conflict: item });
      conflicts.push(item);
    }
  }

  const targetOnly = db.prepare('SELECT id FROM records ORDER BY id').all()
    .filter((row) => !incomingIds.has(row.id)).length;
  const count = (action) => plan.filter((item) => item.action === action).length;
  return {
    plan,
    conflicts,
    summary: {
      create: count('create'),
      update: count('update'),
      unchanged: count('unchanged'),
      conflict: count('conflict'),
      targetOnly,
    },
  };
}

function writeImportedUpdate(db, incoming, current) {
  const revision = current.revision + 1;
  const updatedAt = new Date().toISOString();
  db.prepare(`
    UPDATE records SET project = ?, repository = ?, kind = ?, title = ?, body = ?,
      updated_at = ?, revision = ? WHERE id = ?
  `).run(
    incoming.project,
    incoming.repository,
    incoming.kind,
    incoming.title,
    incoming.body,
    updatedAt,
    revision,
    incoming.id,
  );
  replaceTags(db, incoming.id, incoming.tags);
  replaceIndex(db, incoming.id, incoming);
}

async function prepareDatabaseFile(dbPath, { readOnly = false } = {}) {
  if (!path.isAbsolute(dbPath)) {
    throw unavailable('invalid_path');
  }
  const parent = path.dirname(dbPath);
  try {
    if (!readOnly) {
      await mkdir(parent, { recursive: true, mode: 0o700 });
    }
    const parentStat = await lstat(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
      throw unavailable('parent_not_directory');
    }
    if (!readOnly) {
      await chmod(parent, 0o700);
    }

    let fileStat = await lstat(dbPath).catch((error) => {
      if (error?.code === 'ENOENT') {
        return null;
      }
      throw error;
    });
    if (!fileStat) {
      if (readOnly) {
        throw unavailable('db_missing');
      }
      const flags = constants.O_CREAT | constants.O_EXCL | constants.O_RDWR
        | (constants.O_NOFOLLOW || 0);
      const handle = await open(dbPath, flags, 0o600);
      await handle.close();
      fileStat = await lstat(dbPath);
    }
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      throw unavailable(fileStat.isSymbolicLink() ? 'db_symlink' : 'db_not_regular');
    }
    if (!readOnly) {
      await chmod(dbPath, 0o600);
    }
  } catch (error) {
    throw unavailable(
      error?.reasonCode || (readOnly && error?.code === 'ENOENT' ? 'db_missing' : 'db_open_failed'),
      error,
    );
  }
}

function seedOnce(db) {
  const marker = db.prepare('SELECT value FROM meta WHERE key = ?').get(SAMPLE_MARKER);
  if (marker) {
    return;
  }
  withTransaction(db, () => {
    for (const sample of SAMPLE_RECORDS) {
      insertRecord(db, sample);
    }
    db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run(SAMPLE_MARKER, '1');
  });
}

/**
 * Добавляет nullable-поле v2 к живой v1-БД до смены marker-а. Проверка колонок делает
 * миграцию идемпотентной после прерванного открытия между ALTER и обновлением meta.
 */
function migrateSchema(db) {
  withTransaction(db, () => {
    const columns = db.prepare('PRAGMA table_info(records)').all().map((row) => row.name);
    if (!columns.includes('provenance')) {
      db.exec('ALTER TABLE records ADD COLUMN provenance TEXT');
    }
    db.prepare(`
      INSERT INTO meta(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run('schema_version', KNOWLEDGE_SCHEMA_VERSION);
  });
}

/**
 * Открывает синхронную SQLite-границу для worker-а или короткоживущего CLI.
 * До вызова файл не существует; после открытия его тип и режим проверены явно.
 */
export async function openKnowledgeStorage({
  dbPath,
  seedSamples = false,
  readOnly = false,
} = {}) {
  const resolvedDbPath = String(dbPath || '');
  await prepareDatabaseFile(resolvedDbPath, { readOnly });
  let db;
  try {
    db = readOnly
      ? new DatabaseSync(resolvedDbPath, { readOnly: true })
      : new DatabaseSync(resolvedDbPath);
    db.exec('PRAGMA foreign_keys=ON');
    db.exec('PRAGMA busy_timeout=5000');
    if (readOnly) {
      db.exec('PRAGMA query_only=ON');
    } else {
      db.exec('PRAGMA journal_mode=DELETE');
      db.exec('PRAGMA synchronous=FULL');
      db.exec(KNOWLEDGE_SCHEMA_SQL);
      migrateSchema(db);
      if (seedSamples) {
        seedOnce(db);
      }
      await chmod(resolvedDbPath, 0o600);
    }
  } catch (error) {
    try {
      db?.close();
    } catch {
      // Открытие уже завершилось ошибкой.
    }
    throw unavailable('db_open_failed', error);
  }

  let closed = false;

  function rowById(id) {
    return db.prepare('SELECT * FROM records WHERE id = ?').get(id);
  }

  function assertWritable() {
    if (readOnly) {
      throw unavailable('read_only');
    }
  }

  return {
    async list({ project, repository, tags = [], limit = 500 } = {}) {
      const where = [];
      const values = [];
      if (project) {
        where.push('r.project = ?');
        values.push(String(project));
      }
      if (repository) {
        where.push('r.repository = ?');
        values.push(String(repository));
      }
      for (const tag of cleanTags(tags)) {
        where.push('EXISTS (SELECT 1 FROM record_tags rt WHERE rt.record_id = r.id AND rt.tag = ?)');
        values.push(tag);
      }
      const count = Math.max(1, Math.min(1000, Number(limit) || 500));
      const rows = db.prepare(`
        SELECT r.* FROM records r
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY r.updated_at DESC, r.id ASC LIMIT ?
      `).all(...values, count);
      const projects = db.prepare('SELECT DISTINCT project FROM records ORDER BY project')
        .all().map((row) => row.project);
      const facetTags = db.prepare('SELECT DISTINCT tag FROM record_tags ORDER BY tag')
        .all().map((row) => row.tag);
      return {
        items: rows.map((row) => publicRecord(db, row)),
        facets: { projects, tags: facetTags },
      };
    },

    async search({ query = '', project, repository, tags = [], limit = 20 } = {}) {
      const tokens = [...new Set(normalizedTokens(query))];
      if (!tokens.length) {
        return { items: [] };
      }
      const where = ['records_fts MATCH ?'];
      const match = tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(' OR ');
      const values = [match];
      if (project) {
        where.push('r.project = ?');
        values.push(String(project));
      }
      if (repository) {
        where.push('r.repository = ?');
        values.push(String(repository));
      }
      for (const tag of cleanTags(tags)) {
        where.push('EXISTS (SELECT 1 FROM record_tags rt WHERE rt.record_id = r.id AND rt.tag = ?)');
        values.push(tag);
      }
      const count = Math.max(1, Math.min(100, Number(limit) || 20));
      const rows = db.prepare(`
        SELECT r.*, bm25(records_fts, 0.0, 10.0, 5.0, 1.0) AS rank
        FROM records_fts JOIN records r ON r.id = records_fts.id
        WHERE ${where.join(' AND ')}
        ORDER BY rank ASC, r.updated_at DESC, r.id ASC LIMIT ?
      `).all(...values, count);
      return {
        items: rows.map((row) => ({
          id: row.id,
          title: row.title,
          tags: tagsOf(db, row.id),
          fragment: originalFragment(row.body, tokens),
        })),
      };
    },

    async read(id) {
      if (!UUID_RE.test(String(id || ''))) {
        return null;
      }
      return publicRecord(db, rowById(id));
    },

    async create(input) {
      assertWritable();
      const id = withTransaction(db, () => insertRecord(db, input));
      return publicRecord(db, rowById(id));
    },

    async exportSnapshot() {
      const rows = db.prepare('SELECT * FROM records ORDER BY id').all();
      return { records: rows.map((row) => publicRecord(db, row)) };
    },

    async previewImport(input) {
      const records = validateImportedRecords(input);
      const preview = buildImportPlan(db, records);
      return { summary: preview.summary, conflicts: preview.conflicts };
    },

    async applyImport(input, inputResolutions = []) {
      assertWritable();
      const records = validateImportedRecords(input);
      const resolutions = Array.isArray(inputResolutions) ? inputResolutions : [];

      return withTransaction(db, () => {
        const currentPlan = buildImportPlan(db, records);
        const byId = new Map(resolutions.map((item) => [item?.id, item]));

        for (const conflictItem of currentPlan.conflicts) {
          const resolution = byId.get(conflictItem.id);
          if (!resolution || !['keep-current', 'use-import'].includes(resolution.decision)
            || resolution.expectedCurrentRevision !== conflictItem.currentRevision) {
            throw importStale();
          }
        }

        const result = {
          created: 0,
          updated: 0,
          unchanged: 0,
          keptCurrent: 0,
          overwritten: 0,
          targetOnly: currentPlan.summary.targetOnly,
          total: 0,
        };
        for (const item of currentPlan.plan) {
          if (item.action === 'create') {
            insertRecord(db, item.incoming, {
              id: item.incoming.id,
              updatedAt: item.incoming.updatedAt,
              revision: item.incoming.revision,
            });
            result.created += 1;
          } else if (item.action === 'update') {
            writeImportedUpdate(db, item.incoming, item.current);
            result.updated += 1;
          } else if (item.action === 'unchanged') {
            result.unchanged += 1;
          } else if (byId.get(item.incoming.id).decision === 'keep-current') {
            result.keptCurrent += 1;
          } else {
            writeImportedUpdate(db, item.incoming, item.current);
            result.overwritten += 1;
          }
        }
        result.total = db.prepare('SELECT COUNT(*) AS count FROM records').get().count;
        return result;
      });
    },

    async update(id, input = {}) {
      assertWritable();
      if (!UUID_RE.test(String(id || ''))) {
        throw notFound();
      }
      return withTransaction(db, () => {
        const current = publicRecord(db, rowById(id));
        if (!current) {
          throw notFound();
        }
        if (Number(input.expectedRevision) !== current.revision) {
          throw conflict(current.revision);
        }
        const value = cleanRecord(input, current);
        const revision = current.revision + 1;
        const updatedAt = new Date().toISOString();
        db.prepare(`
          UPDATE records SET project = ?, repository = ?, kind = ?, title = ?, body = ?,
            updated_at = ?, revision = ?, provenance = ? WHERE id = ?
        `).run(
          value.project, value.repository, value.kind, value.title, value.body,
          updatedAt, revision, value.provenance ? JSON.stringify(value.provenance) : null, id,
        );
        replaceTags(db, id, value.tags);
        replaceIndex(db, id, value);
        return publicRecord(db, rowById(id));
      });
    },

    async delete(id, { expectedRevision } = {}) {
      assertWritable();
      return withTransaction(db, () => {
        const current = publicRecord(db, rowById(id));
        if (!current) {
          throw notFound();
        }
        if (Number(expectedRevision) !== current.revision) {
          throw conflict(current.revision);
        }
        db.prepare('DELETE FROM records_fts WHERE id = ?').run(id);
        db.prepare('DELETE FROM records WHERE id = ?').run(id);
        return { deleted: true, id };
      });
    },

    async close() {
      if (!closed) {
        closed = true;
        db.close();
      }
    },
  };
}

export const createKnowledgeStorage = openKnowledgeStorage;
export default openKnowledgeStorage;

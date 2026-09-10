export const KNOWLEDGE_SCHEMA_VERSION = '2';
export const SAMPLE_MARKER = 'samples_v1';

export const KNOWLEDGE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS records (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    repository TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    provenance TEXT
  );
  CREATE TABLE IF NOT EXISTS record_tags (
    record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (record_id, tag)
  );
  CREATE INDEX IF NOT EXISTS record_tags_tag_idx ON record_tags(tag, record_id);
  CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
    id UNINDEXED,
    title,
    tags,
    body,
    tokenize = 'unicode61'
  );
`;

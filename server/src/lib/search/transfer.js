import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { KnowledgeError, invalidArguments, unavailable } from './errors.js';

const SCHEMA_VERSION = 1;
const SOURCE_DOCUMENT_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GENERATED_START = '<!-- knowledge-map:start -->';
const GENERATED_END = '<!-- knowledge-map:end -->';
const RECORD_FIELDS = [
  'id',
  'title',
  'body',
  'tags',
  'kind',
  'project',
  'repository',
  'sourceDocument',
  'revision',
  'updatedAt',
];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalSnapshotPayload(records) {
  return JSON.stringify({ schemaVersion: SCHEMA_VERSION, records });
}

function staleImport(preview) {
  const error = new KnowledgeError('Экспорт или база изменились.', {
    code: 'KNOWLEDGE_IMPORT_STALE',
  });
  error.preview = preview;
  return error;
}

function validateApplyInput(input) {
  if (!input || typeof input !== 'object'
    || !/^[0-9a-f]{64}$/u.test(String(input.snapshotHash || ''))
    || !Array.isArray(input.resolutions)) {
    throw invalidArguments('Apply импорта требует snapshotHash и массив решений.');
  }

  const ids = new Set();
  for (const resolution of input.resolutions) {
    if (!UUID_RE.test(String(resolution?.id || '')) || ids.has(resolution.id)
      || !['keep-current', 'use-import'].includes(resolution?.decision)
      || !Number.isInteger(resolution?.expectedCurrentRevision)
      || resolution.expectedCurrentRevision < 1) {
      throw invalidArguments('Решения импорта заполнены некорректно.');
    }
    ids.add(resolution.id);
  }
}

function exactRecords(snapshot) {
  const records = Array.isArray(snapshot) ? snapshot : snapshot?.records;
  if (!Array.isArray(records)) {
    throw invalidArguments('Хранилище вернуло некорректный снимок знаний.');
  }
  return [...records].sort((left, right) => String(left?.id).localeCompare(String(right?.id)));
}

function sourceDocumentOf(record) {
  const sourceDocument = record?.tags?.[0];
  if (!SOURCE_DOCUMENT_RE.test(String(sourceDocument || ''))) {
    throw invalidArguments('Первый тег записи должен быть безопасным именем документа.');
  }
  return sourceDocument;
}

/**
 * Проверяет lossless DTO до файловой или DB-границы. Нормализация здесь запрещена:
 * иначе export/import мог бы незаметно менять проверенное знание.
 */
function validateRecord(record, { imported = false } = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw invalidArguments('Снимок содержит некорректную запись.');
  }
  if (!UUID_RE.test(String(record.id || ''))) {
    throw invalidArguments('UUID записи снимка заполнен некорректно.');
  }
  if (typeof record.body !== 'string') {
    throw invalidArguments('Тело записи снимка должно быть строкой.');
  }
  if (imported) {
    const fields = Object.keys(record).sort();
    const expected = [...RECORD_FIELDS].sort();
    if (fields.length !== expected.length
      || fields.some((field, index) => field !== expected[index])) {
      throw invalidArguments('Запись файла должна содержать ровно десять полей формата.');
    }
  }
  for (const field of ['project', 'repository', 'kind', 'title']) {
    if (typeof record[field] !== 'string' || !record[field].trim()
      || record[field] !== record[field].trim()) {
      throw invalidArguments(`Поле ${field} записи снимка заполнено некорректно.`);
    }
  }
  if (!Array.isArray(record.tags) || !record.tags.length
    || record.tags.some((tag) => typeof tag !== 'string' || !tag.trim() || tag !== tag.trim())
    || new Set(record.tags).size !== record.tags.length) {
    throw invalidArguments('Теги записи снимка должны быть точным упорядоченным массивом.');
  }
  if (!Number.isInteger(record.revision) || record.revision < 1
    || typeof record.updatedAt !== 'string'
    || !Number.isFinite(Date.parse(record.updatedAt))) {
    throw invalidArguments('Время или ревизия записи снимка заполнены некорректно.');
  }

  const sourceDocument = sourceDocumentOf(record);
  if (imported && record.sourceDocument !== sourceDocument) {
    throw invalidArguments('sourceDocument записи должен совпадать с первым тегом.');
  }
  return sourceDocument;
}

function exportedRecord(record) {
  const sourceDocument = validateRecord(record);
  return {
    id: record.id,
    title: record.title,
    body: record.body,
    tags: [...record.tags],
    kind: record.kind,
    project: record.project,
    repository: record.repository,
    sourceDocument,
    revision: record.revision,
    updatedAt: record.updatedAt,
  };
}

/** Разбирает и целиком проверяет самодостаточный файл до обращения к базе. */
function parseBackup(bytes) {
  let backup;
  try {
    const text = typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('utf8');
    backup = JSON.parse(text);
  } catch {
    throw invalidArguments('Файл резервной копии не является корректным JSON.');
  }

  if (!backup || typeof backup !== 'object' || Array.isArray(backup)
    || backup.schemaVersion !== SCHEMA_VERSION || !Array.isArray(backup.records)) {
    throw invalidArguments('Версия или структура файла резервной копии не поддерживается.');
  }
  const envelopeFields = Object.keys(backup).sort();
  if (envelopeFields.length !== 3
    || envelopeFields.join(',') !== 'records,schemaVersion,snapshotHash') {
    throw invalidArguments('Файл резервной копии содержит неизвестные поля.');
  }

  const ids = new Set();
  let previousId = '';
  for (const record of backup.records) {
    validateRecord(record, { imported: true });
    if (ids.has(record.id) || (previousId && previousId.localeCompare(record.id) >= 0)) {
      throw invalidArguments('UUID записей файла должны быть уникальны и отсортированы.');
    }
    ids.add(record.id);
    previousId = record.id;
  }

  const expectedHash = sha256(canonicalSnapshotPayload(backup.records));
  if (!/^[0-9a-f]{64}$/u.test(String(backup.snapshotHash || ''))
    || backup.snapshotHash !== expectedHash) {
    throw invalidArguments('Контрольная сумма файла резервной копии не совпадает.');
  }

  const records = backup.records.map(({ sourceDocument: _sourceDocument, ...record }) => ({
    ...record,
    tags: [...record.tags],
  }));
  return { snapshotHash: backup.snapshotHash, records };
}

function safeMapText(value) {
  return String(value || '')
    .replaceAll('\r', ' ')
    .replaceAll('\n', ' ')
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]')
    .trim();
}

// Псевдо-проект собственного корня: им помечается обход в однопроектном режиме,
// где имя проекта неизвестно, а каталог карт всё равно один.
const OWN_ROOT = '\u0000own-root';

/**
 * Карта — оглавление темы, которое @-каскад грузит в контекст каждого агента,
 * поэтому строка несёт только заголовок и два тега. Ревизия сюда не пишется:
 * в git-файле она стареет сразу, для `--expected-revision` годится лишь свежая
 * из `knowledge read`, а рост был бы вечным — по строке на каждую правку.
 */
function generatedMap(sourceDocument, records) {
  const lines = [
    ...(sourceDocument === 'knowledge' ? [GENERATED_START] : []),
    `# Карта: ${sourceDocument}`,
    '',
    '> Полный текст открывается по живой ссылке `/knowledge/<uuid>`; '
      + 'агент: `knowledge search/read`.',
    '',
  ];
  for (const record of records) {
    const tags = record.tags.slice(1, 3).map(safeMapText).join(', ');
    const target = `#/knowledge/${record.id}`;
    lines.push(`- [${safeMapText(record.title)}](${target})${tags ? ` · ${tags}` : ''}`);
  }
  if (sourceDocument === 'knowledge') {
    lines.push('', GENERATED_END);
  }
  lines.push('');
  return lines.join('\n');
}

function mergeManualPreamble(current, generated) {
  const start = current.indexOf(GENERATED_START);
  const end = current.indexOf(GENERATED_END);
  if (start !== -1 && end >= start) {
    const suffix = current.slice(end + GENERATED_END.length).replace(/^\s*/u, '');
    return `${current.slice(0, start)}${generated}${suffix}`;
  }
  const preamble = current.trimEnd();
  return preamble ? `${preamble}\n\n${generated}` : generated;
}

async function atomicWrite(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, value);
  await rename(temporary, filePath);
}

async function replaceWithBackup(filePath, value, replacements) {
  const previous = await readFile(filePath).catch((error) => {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  });
  replacements.push({ filePath, previous });
  await atomicWrite(filePath, value);
}

/** При ошибке серии возвращает существовавшие карты и удаляет созданные. */
async function rollbackReplacements(replacements) {
  for (const replacement of [...replacements].reverse()) {
    if (replacement.previous === null) {
      await rm(replacement.filePath, { force: true });
    } else {
      await atomicWrite(replacement.filePath, replacement.previous);
    }
  }
}

async function contextBytes(rootDir) {
  const cockpitDir = path.join(rootDir, 'docs/cockpit');
  const names = await readdir(cockpitDir).catch(() => []);
  const chunks = await Promise.all([
    readFile(path.join(rootDir, 'AGENTS.md')).catch(() => Buffer.alloc(0)),
    readFile(path.join(rootDir, 'CLAUDE.md')).catch(() => Buffer.alloc(0)),
    ...names.filter((name) => name.endsWith('.md'))
      .map((name) => readFile(path.join(cockpitDir, name)).catch(() => Buffer.alloc(0))),
  ]);
  return chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
}

/**
 * Создаёт human-only сервис резервной копии и отдельного обновления карт.
 * `mapsRootFor` отвечает, в каком репозитории лежат карты проекта: у каждого проекта
 * он свой, иначе оглавление чужого проекта попало бы в контекст агента кокпита.
 * Без резолвера сервис остаётся однопроектным и пишет в собственный корень.
 */
export function createKnowledgeTransfer({
  rootDir,
  knowledge,
  mapsRootFor,
  listKnownProjects,
} = {}) {
  const repositoryRoot = path.resolve(String(rootDir || ''));
  const resolveMapsRoot = typeof mapsRootFor === 'function'
    ? mapsRootFor
    : () => repositoryRoot;
  const knownProjects = typeof listKnownProjects === 'function'
    ? listKnownProjects
    : () => [];

  async function exportKnowledge() {
    try {
      const records = exactRecords(await knowledge.exportSnapshot()).map(exportedRecord);
      const snapshotHash = sha256(canonicalSnapshotPayload(records));
      return Buffer.from(JSON.stringify({ schemaVersion: SCHEMA_VERSION, snapshotHash, records }));
    } catch (error) {
      if (error?.code?.startsWith?.('KNOWLEDGE_')) {
        throw error;
      }
      throw unavailable('export_failed', error);
    }
  }

  async function previewImport(bytes) {
    const backup = parseBackup(bytes);
    const preview = await knowledge.previewImport(backup.records);
    return { snapshotHash: backup.snapshotHash, ...preview };
  }

  async function applyImport(bytes, input = {}) {
    validateApplyInput(input);
    const backup = parseBackup(bytes);
    if (input.snapshotHash !== backup.snapshotHash) {
      const preview = await knowledge.previewImport(backup.records);
      throw staleImport({ snapshotHash: backup.snapshotHash, ...preview });
    }
    try {
      return await knowledge.applyImport(backup.records, input.resolutions);
    } catch (error) {
      if (error?.code !== 'KNOWLEDGE_IMPORT_STALE') {
        throw error;
      }
      const preview = await knowledge.previewImport(backup.records);
      throw staleImport({ snapshotHash: backup.snapshotHash, ...preview });
    }
  }

  /**
   * Пересобирает карты. Адрес карты — пара «проект + тема»: тема даёт имя файла,
   * проект — репозиторий, в котором файл лежит. Неизвестный корень обрывает заход
   * целиком: положить оглавление проекта наугад хуже, чем отказать.
   */
  async function updateMaps({ project, sourceDocuments } = {}) {
    const replacements = [];
    try {
      const targeted = sourceDocuments !== undefined;
      let targets = null;
      if (targeted) {
        if (!Array.isArray(sourceDocuments) || !sourceDocuments.length
          || sourceDocuments.some((item) => !SOURCE_DOCUMENT_RE.test(String(item || '')))) {
          throw invalidArguments('Цели карт должны быть безопасными именами документов.');
        }
        targets = [...new Set(sourceDocuments.map(String))];
      }
      const scope = project === undefined ? null : String(project || '');
      if (scope !== null && !scope) {
        throw invalidArguments('Проект карты должен быть непустым.');
      }

      const records = exactRecords(await knowledge.exportSnapshot());
      const byProject = new Map();
      for (const record of records) {
        const sourceDocument = validateRecord(record);
        if (targeted && !targets.includes(sourceDocument)) {
          continue;
        }
        if (scope !== null && record.project !== scope) {
          continue;
        }
        const topics = byProject.get(record.project) || new Map();
        const sourceRecords = topics.get(sourceDocument) || [];
        sourceRecords.push(record);
        topics.set(sourceDocument, sourceRecords);
        byProject.set(record.project, topics);
      }

      const visited = new Set(byProject.keys());
      if (scope !== null) {
        visited.add(scope);
      } else if (!targeted) {
        for (const known of await knownProjects()) {
          if (known) {
            visited.add(String(known));
          }
        }
        // Однопроектный режим: корень один и известен без резолвера, поэтому обойти его
        // надо даже при пустом снимке — иначе прежняя карта останется с мёртвыми ссылками.
        if (!visited.size && typeof mapsRootFor !== 'function') {
          visited.add(OWN_ROOT);
        }
      }

      let mapBytes = 0;
      let mapCount = 0;
      const owners = new Map();
      const contextByProject = {};
      for (const projectId of [...visited].sort()) {
        // Проект из реестра без единой записи попал сюда только ради подчистки старых
        // карт: нет корня — нечего и чистить, и один ненастроенный проект не обязан
        // ронять пересборку остальных.
        const cleanupOnly = scope === null && !targeted && !byProject.has(projectId);
        const root = await resolveMapsRoot(projectId);
        if (!root || !path.isAbsolute(String(root))) {
          if (cleanupOnly) {
            continue;
          }
          throw unavailable('maps_root_unknown');
        }
        const mapsDir = path.join(String(root), 'docs/cockpit');
        const topics = byProject.get(projectId) || new Map();
        if (targeted) {
          for (const sourceDocument of targets) {
            if (!topics.has(sourceDocument)) {
              topics.set(sourceDocument, []);
            }
          }
        } else {
          const existingNames = await readdir(mapsDir).catch((error) => {
            if (error?.code === 'ENOENT') {
              return [];
            }
            throw error;
          });
          for (const name of existingNames) {
            if (name.endsWith('.md')) {
              const sourceDocument = name.slice(0, -3);
              if (SOURCE_DOCUMENT_RE.test(sourceDocument) && !topics.has(sourceDocument)) {
                topics.set(sourceDocument, []);
              }
            }
          }
        }

        const sortedMaps = [...topics].sort(([left], [right]) => left.localeCompare(right));
        for (const [sourceDocument, sourceRecords] of sortedMaps) {
          const target = path.join(mapsDir, `${sourceDocument}.md`);
          const owner = owners.get(target);
          if (owner !== undefined && owner !== projectId) {
            throw unavailable('maps_root_collision');
          }
          owners.set(target, projectId);
          const generated = generatedMap(sourceDocument, sourceRecords);
          const current = sourceDocument === 'knowledge'
            ? await readFile(target, 'utf8').catch(() => '')
            : '';
          const value = sourceDocument === 'knowledge'
            ? mergeManualPreamble(current, generated)
            : generated;
          await replaceWithBackup(target, value, replacements);
          mapBytes += Buffer.byteLength(value, 'utf8');
          mapCount += 1;
        }
        if (!targeted && projectId !== OWN_ROOT) {
          contextByProject[projectId] = await contextBytes(String(root));
        }
      }

      const result = {
        recordCount: records.length,
        mapCount,
        mapBytes,
      };
      if (!targeted) {
        result.contextBytes = contextByProject;
        result.totalContextBytes = await contextBytes(repositoryRoot);
      }
      return result;
    } catch (error) {
      if (replacements.length) {
        await rollbackReplacements(replacements).catch(() => {});
      }
      if (error?.code?.startsWith?.('KNOWLEDGE_')) {
        throw error;
      }
      throw unavailable('maps_refresh_failed', error);
    }
  }

  return { exportKnowledge, previewImport, applyImport, updateMaps };
}

export default createKnowledgeTransfer;

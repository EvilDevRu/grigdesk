import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { knowledgeStorageFactory, record } from './helpers/knowledge.js';

let transferModule;
let transferModuleError;
try {
  transferModule = await import('../../server/src/lib/search/transfer.js');
} catch (error) {
  transferModuleError = error;
}

const FIRST_ID = '00000000-0000-4000-8000-000000000021';
const SECOND_ID = '00000000-0000-4000-8000-000000000022';
const RECORD_FIELDS = [
  'id', 'title', 'body', 'tags', 'kind', 'project', 'repository', 'sourceDocument',
  'revision', 'updatedAt',
];

function snapshotRecord(overrides = {}) {
  return {
    id: FIRST_ID,
    title: 'Полная запись',
    body: '\nТело с Markdown и конечной строкой.\n',
    tags: ['knowledge', 'transfer', 'третий тег'],
    kind: 'fact',
    project: 'cockpit-test',
    repository: 'main',
    revision: 7,
    updatedAt: '2026-08-28T10:20:30.000Z',
    ...overrides,
  };
}

function createTransfer(rootDir, knowledge, options = {}) {
  assert.ok(transferModule, `Перенос знаний ещё не реализован: ${transferModuleError?.message}`);
  const factory = transferModule.createKnowledgeTransfer || transferModule.default;
  assert.equal(typeof factory, 'function', 'transfer.js обязан экспортировать фабрику сервиса');
  return factory({ rootDir, knowledge, ...options });
}

function transferFixture(t, records, overrides = {}) {
  const calls = [];
  const knowledge = {
    async exportSnapshot() {
      calls.push(['exportSnapshot']);
      return records;
    },
    async previewImport(imported) {
      calls.push(['previewImport', imported]);
      return overrides.previewResult || {
        summary: { create: imported.length, update: 0, unchanged: 0, conflict: 0, targetOnly: 0 },
        conflicts: [],
      };
    },
    async applyImport(imported, resolutions) {
      calls.push(['applyImport', imported, resolutions]);
      return overrides.applyResult || {
        created: imported.length,
        updated: 0,
        unchanged: 0,
        keptCurrent: 0,
        overwritten: 0,
        targetOnly: 0,
        total: imported.length,
      };
    },
  };
  return {
    calls,
    transfer: createTransfer(t.rootDir, knowledge, overrides.transferOptions || {}),
  };
}

async function temporaryRoot(t) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'cockpit-knowledge-transfer-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  t.rootDir = rootDir;
  return rootDir;
}

function bytesOf(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  if (typeof value === 'string') {
    return Buffer.from(value, 'utf8');
  }
  assert.fail('Экспорт обязан вернуть байты или UTF-8 строку единого файла');
}

function parseBackup(value) {
  return JSON.parse(bytesOf(value).toString('utf8'));
}

function backupBytes(records) {
  const exportedRecords = records
    .map((item) => ({ ...item, sourceDocument: item.tags[0] }))
    .toSorted((left, right) => left.id.localeCompare(right.id));
  const snapshotHash = createHash('sha256')
    .update(JSON.stringify({ schemaVersion: 1, records: exportedRecords }))
    .digest('hex');

  return Buffer.from(JSON.stringify({ schemaVersion: 1, snapshotHash, records: exportedRecords }));
}

async function treeSnapshot(rootDir) {
  async function walk(relative = '') {
    const names = await readdir(path.join(rootDir, relative), { withFileTypes: true }).catch(() => []);
    const entries = [];
    for (const name of names.sort((left, right) => left.name.localeCompare(right.name))) {
      const child = path.join(relative, name.name);
      if (name.isDirectory()) {
        entries.push([`${child}/`, null], ...await walk(child));
      } else {
        entries.push([child, await readFile(path.join(rootDir, child), 'utf8')]);
      }
    }
    return entries;
  }
  return walk();
}

test('Экспорт возвращает один versioned JSON со всеми десятью полями записи', async (t) => {
  await temporaryRoot(t);
  const records = [
    snapshotRecord({ id: SECOND_ID, title: 'Вторая' }),
    snapshotRecord({ id: FIRST_ID, title: 'Первая' }),
  ];
  const { transfer } = transferFixture(t, records);
  const backup = parseBackup(await transfer.exportKnowledge());

  assert.deepEqual({
    schemaVersion: backup.schemaVersion,
    ids: backup.records.map((item) => item.id),
    fields: backup.records.map((item) => Object.keys(item).sort()),
    timestampNoise: Object.hasOwn(backup, 'createdAt') || Object.hasOwn(backup, 'exportedAt'),
  }, {
    schemaVersion: 1,
    ids: [FIRST_ID, SECOND_ID],
    fields: [RECORD_FIELDS.toSorted(), RECORD_FIELDS.toSorted()],
    timestampNoise: false,
  });
});

test('Контрольная сумма покрывает версию и все записи единого файла', async (t) => {
  await temporaryRoot(t);
  const { transfer } = transferFixture(t, [snapshotRecord()]);
  const backup = parseBackup(await transfer.exportKnowledge());
  const expected = createHash('sha256')
    .update(JSON.stringify({ schemaVersion: 1, records: backup.records }))
    .digest('hex');

  assert.equal(backup.snapshotHash, expected);
});

test('Экспорт не создаёт и не изменяет файлы в корне репозитория', async (t) => {
  const rootDir = await temporaryRoot(t);
  await mkdir(path.join(rootDir, 'docs/cockpit'), { recursive: true });
  await writeFile(path.join(rootDir, 'docs/cockpit/manual.md'), 'ручной файл\n');
  const { transfer } = transferFixture(t, [snapshotRecord()]);
  const before = await treeSnapshot(rootDir);

  await transfer.exportKnowledge();

  assert.deepEqual(await treeSnapshot(rootDir), before);
});

test('Предпросмотр читает переданные байты и не читает дерево репозитория', async (t) => {
  const rootDir = await temporaryRoot(t);
  const exported = [snapshotRecord()];
  const source = transferFixture(t, exported);
  const bytes = backupBytes(exported);
  await mkdir(path.join(rootDir, 'docs/knowledge'), { recursive: true });
  await writeFile(path.join(rootDir, 'docs/knowledge/manifest.json'), '{"битый":true}\n');
  const before = await treeSnapshot(rootDir);

  await source.transfer.previewImport(bytes);

  assert.deepEqual({
    imported: source.calls.find((call) => call[0] === 'previewImport')?.[1],
    tree: await treeSnapshot(rootDir),
  }, { imported: exported, tree: before });
});

test('Применение читает только переданный файл и не изменяет дерево репозитория', async (t) => {
  const rootDir = await temporaryRoot(t);
  const records = [snapshotRecord()];
  const { calls, transfer } = transferFixture(t, records);
  const bytes = backupBytes(records);
  const backup = parseBackup(bytes);
  bytes.snapshotHash = backup.snapshotHash;
  bytes.resolutions = [];
  await mkdir(path.join(rootDir, 'docs/knowledge'), { recursive: true });
  await writeFile(path.join(rootDir, 'docs/knowledge/manifest.json'), '{отравленное дерево');
  await writeFile(path.join(rootDir, 'не-менять.txt'), 'канарейка\n');
  const before = await treeSnapshot(rootDir);
  calls.length = 0;
  let caught;

  try {
    await transfer.applyImport(bytes, { snapshotHash: backup.snapshotHash, resolutions: [] });
  } catch (error) {
    caught = error;
  }

  assert.deepEqual({
    error: caught?.message || null,
    calls,
    tree: await treeSnapshot(rootDir),
  }, {
    error: null,
    calls: [['applyImport', records, []]],
    tree: before,
  });
});

test('Файл с неподдерживаемой версией отклоняется до обращения к базе', async (t) => {
  await temporaryRoot(t);
  const { calls, transfer } = transferFixture(t, []);
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 2, snapshotHash: '0'.repeat(64), records: [] }));

  let caught;
  try {
    await transfer.previewImport(bytes);
  } catch (error) {
    caught = error;
  }

  assert.deepEqual({
    rejectedForVersion: /верс/iu.test(caught?.message || ''),
    dbCalled: calls.some((call) => call[0] === 'previewImport'),
  }, {
    rejectedForVersion: true,
    dbCalled: false,
  });
});

test('Файл с несовпадающим sourceDocument отклоняется до обращения к базе', async (t) => {
  await temporaryRoot(t);
  const { calls, transfer } = transferFixture(t, []);
  const records = [{ ...snapshotRecord(), sourceDocument: 'other-map' }];
  const snapshotHash = createHash('sha256')
    .update(JSON.stringify({ schemaVersion: 1, records }))
    .digest('hex');
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, snapshotHash, records }));

  let caught;
  try {
    await transfer.previewImport(bytes);
  } catch (error) {
    caught = error;
  }

  assert.deepEqual({
    rejectedForSource: /sourceDocument|перв[^\n]*тег/iu.test(caught?.message || ''),
    dbCalled: calls.some((call) => call[0] === 'previewImport'),
  }, {
    rejectedForSource: true,
    dbCalled: false,
  });
});

test('Обновление карт пишет живую ссылку и только верхнеуровневые карты', async (t) => {
  const rootDir = await temporaryRoot(t);
  await mkdir(path.join(rootDir, 'docs/cockpit'), { recursive: true });
  await writeFile(path.join(rootDir, 'CLAUDE.md'), 'не менять\n');
  const { transfer } = transferFixture(t, [snapshotRecord()]);

  await transfer.updateMaps();

  const tree = await treeSnapshot(rootDir);
  const map = await readFile(path.join(rootDir, 'docs/cockpit/knowledge.md'), 'utf8');
  assert.deepEqual({
    paths: tree.map(([name]) => name),
    liveLink: map.includes(`](#/knowledge/${FIRST_ID})`),
    canary: await readFile(path.join(rootDir, 'CLAUDE.md'), 'utf8'),
  }, {
    paths: ['CLAUDE.md', 'docs/', 'docs/cockpit/', 'docs/cockpit/knowledge.md'],
    liveLink: true,
    canary: 'не менять\n',
  });
});

test('Обновление карт очищает прежнюю карту темы без записей', async (t) => {
  const rootDir = await temporaryRoot(t);
  await mkdir(path.join(rootDir, 'docs/cockpit'), { recursive: true });
  await writeFile(
    path.join(rootDir, 'docs/cockpit/empty-topic.md'),
    `# Карта: empty-topic\n\n- [Устаревшая](#/knowledge/${FIRST_ID})\n`,
  );
  const { transfer } = transferFixture(t, []);

  await transfer.updateMaps();

  const map = await readFile(path.join(rootDir, 'docs/cockpit/empty-topic.md'), 'utf8');
  assert.equal(map.includes(FIRST_ID), false);
});

test('Обновлённые карты перечисляют все записи снимка без лишних UUID', async (t) => {
  const rootDir = await temporaryRoot(t);
  const records = [
    snapshotRecord({ tags: ['alpha'], title: 'Альфа' }),
    snapshotRecord({ id: SECOND_ID, tags: ['beta'], title: 'Бета' }),
  ];
  const { transfer } = transferFixture(t, records);

  await transfer.updateMaps();

  const maps = await Promise.all(['alpha', 'beta'].map((name) => (
    readFile(path.join(rootDir, `docs/cockpit/${name}.md`), 'utf8')
  )));
  const ids = maps.flatMap((text) => (
    [...text.matchAll(/\]\(#\/knowledge\/([0-9a-f-]+)\)/giu)].map((match) => match[1])
  ));
  assert.deepEqual(ids.toSorted(), records.map((item) => item.id).toSorted());
});

test('Точечное обновление одной темы оставляет соседнюю карту байт-в-байт', async (t) => {
  const rootDir = await temporaryRoot(t);
  const cockpitDir = path.join(rootDir, 'docs/cockpit');
  await mkdir(cockpitDir, { recursive: true });
  const betaCanary = '# Ручная карта beta\n\nканарейка, которую нельзя перезаписывать\n';
  await writeFile(path.join(cockpitDir, 'beta.md'), betaCanary);
  const records = [
    snapshotRecord({ tags: ['alpha'], title: 'Альфа' }),
    snapshotRecord({ id: SECOND_ID, tags: ['beta'], title: 'Бета' }),
  ];
  const { transfer } = transferFixture(t, records);

  await transfer.updateMaps({ sourceDocuments: ['alpha'] });

  assert.equal(await readFile(path.join(cockpitDir, 'beta.md'), 'utf8'), betaCanary);
});

test('Точечный перенос знания очищает старую тему и создаёт новую', async (t) => {
  const rootDir = await temporaryRoot(t);
  const cockpitDir = path.join(rootDir, 'docs/cockpit');
  await mkdir(cockpitDir, { recursive: true });
  await writeFile(
    path.join(cockpitDir, 'old-topic.md'),
    `# Карта: old-topic\n\n- [Старая запись](#/knowledge/${FIRST_ID})\n`,
  );
  const records = [snapshotRecord({ tags: ['new-topic'], title: 'Перенесённая запись' })];
  const { transfer } = transferFixture(t, records);

  await transfer.updateMaps({ sourceDocuments: ['old-topic', 'new-topic'] });

  const oldMap = await readFile(path.join(cockpitDir, 'old-topic.md'), 'utf8');
  const newMap = await readFile(path.join(cockpitDir, 'new-topic.md'), 'utf8');
  assert.deepEqual({ oldHasUuid: oldMap.includes(FIRST_ID), newHasUuid: newMap.includes(FIRST_ID) }, {
    oldHasUuid: false,
    newHasUuid: true,
  });
});

test('Небезопасная цель карты отклоняется до чтения снимка базы', async (t) => {
  await temporaryRoot(t);
  const { calls, transfer } = transferFixture(t, []);

  await assert.rejects(
    transfer.updateMaps({ sourceDocuments: ['../outside'] }),
    (error) => error?.code === 'KNOWLEDGE_INVALID_ARGUMENTS' && calls.length === 0,
  );
});

test('Точечная пересборка не читает и не заменяет отравленную соседнюю тему', async (t) => {
  const rootDir = await temporaryRoot(t);
  const cockpitDir = path.join(rootDir, 'docs/cockpit');
  await mkdir(path.join(cockpitDir, 'poison.md'), { recursive: true });
  const records = [
    snapshotRecord({ tags: ['alpha'], title: 'Альфа' }),
    snapshotRecord({ id: SECOND_ID, tags: ['poison'], title: 'Не целевая запись' }),
  ];
  const { transfer } = transferFixture(t, records);

  const result = await transfer.updateMaps({ sourceDocuments: ['alpha'] });
  const alpha = await readFile(path.join(cockpitDir, 'alpha.md'), 'utf8');

  assert.deepEqual({ recordCount: result.recordCount, alphaHasUuid: alpha.includes(FIRST_ID) }, {
    recordCount: 2,
    alphaHasUuid: true,
  });
});

test('Происхождение не попадает ни в карту, ни в десятиполевый backup', async (t) => {
  const rootDir = await temporaryRoot(t);
  const sentinel = 'pipeline-node-sentinel';
  const records = [snapshotRecord({
    provenance: { actor: 'executor', channel: 'pipeline', ref: sentinel },
  })];
  const { transfer } = transferFixture(t, records);

  const backup = bytesOf(await transfer.exportKnowledge()).toString('utf8');
  await transfer.updateMaps({ sourceDocuments: ['knowledge'] });
  const map = await readFile(path.join(rootDir, 'docs/cockpit/knowledge.md'), 'utf8');

  assert.equal(`${backup}\n${map}`.includes(sentinel), false);
});

test('Ошибка обновления одной карты откатывает уже записанные карты', async (t) => {
  const rootDir = await temporaryRoot(t);
  const cockpitDir = path.join(rootDir, 'docs/cockpit');
  await mkdir(path.join(cockpitDir, 'zeta.md'), { recursive: true });
  await writeFile(path.join(cockpitDir, 'alpha.md'), 'исходная карта alpha\n');
  const records = [
    snapshotRecord({ tags: ['alpha'], title: 'Альфа' }),
    snapshotRecord({ id: SECOND_ID, tags: ['zeta'], title: 'Зета' }),
  ];
  const { transfer } = transferFixture(t, records);
  let caught;

  try {
    await transfer.updateMaps();
  } catch (error) {
    caught = error;
  }

  assert.deepEqual({
    methodAvailable: typeof transfer.updateMaps === 'function',
    rejectedByFilesystem: typeof caught?.code === 'string',
    alpha: await readFile(path.join(cockpitDir, 'alpha.md'), 'utf8'),
  }, {
    methodAvailable: true,
    rejectedByFilesystem: true,
    alpha: 'исходная карта alpha\n',
  });
});

test('Экспорт и импорт восстанавливают записи в новой пустой базе без файлов корпуса', async (t) => {
  const rootDir = await temporaryRoot(t);
  const factory = knowledgeStorageFactory();
  const firstDb = path.join(rootDir, 'first', 'knowledge.db');
  const first = await factory({ dbPath: firstDb, seedSamples: false });
  const created = await first.create(record({
    title: 'Круг переноса',
    body: '\nТочное тело резервной копии.\n',
    tags: ['knowledge', 'backup'],
  }));
  const exporter = createTransfer(rootDir, first);
  const bytes = bytesOf(await exporter.exportKnowledge());
  await first.close();
  await rm(path.dirname(firstDb), { recursive: true, force: true });

  const secondDb = path.join(rootDir, 'second', 'knowledge.db');
  const second = await factory({ dbPath: secondDb, seedSamples: false });
  t.after(() => second.close?.());
  const importer = createTransfer(rootDir, second);
  const preview = await importer.previewImport(bytes);
  await importer.applyImport(bytes, { snapshotHash: preview.snapshotHash, resolutions: [] });
  const restored = await second.read(created.id);

  assert.deepEqual({
    id: restored.id,
    body: restored.body,
    tags: restored.tags,
    sourceDocument: restored.tags[0],
    revision: restored.revision,
    corpusExists: await access(path.join(rootDir, 'docs/knowledge'))
      .then(() => true)
      .catch(() => false),
  }, {
    id: created.id,
    body: created.body,
    tags: created.tags,
    sourceDocument: created.tags[0],
    revision: created.revision,
    corpusExists: false,
  });
});

async function exists(filePath) {
  return access(filePath).then(() => true).catch(() => false);
}

test('Карты двух проектов расходятся по своим репозиториям', async (t) => {
  const rootDir = await temporaryRoot(t);
  const alphaRoot = path.join(rootDir, 'alpha-repo');
  const zetaRoot = path.join(rootDir, 'zeta-repo');
  const { transfer } = transferFixture(t, [
    snapshotRecord({ id: FIRST_ID, project: 'alpha', tags: ['alpha-topic'] }),
    snapshotRecord({ id: SECOND_ID, project: 'zeta', tags: ['zeta-topic'] }),
  ], {
    transferOptions: {
      mapsRootFor: (project) => (project === 'alpha' ? alphaRoot : zetaRoot),
    },
  });

  await transfer.updateMaps();

  const alphaMap = await readFile(path.join(alphaRoot, 'docs/cockpit/alpha-topic.md'), 'utf8');
  const zetaMap = await readFile(path.join(zetaRoot, 'docs/cockpit/zeta-topic.md'), 'utf8');

  assert.deepEqual({
    alphaHasOwn: alphaMap.includes(FIRST_ID),
    alphaHasForeign: alphaMap.includes(SECOND_ID),
    zetaHasOwn: zetaMap.includes(SECOND_ID),
    foreignTopicLeaked: await exists(path.join(zetaRoot, 'docs/cockpit/alpha-topic.md')),
  }, {
    alphaHasOwn: true,
    alphaHasForeign: false,
    zetaHasOwn: true,
    foreignTopicLeaked: false,
  });
});

test('Неизвестный корень карт обрывает заход и откатывает уже записанное', async (t) => {
  const rootDir = await temporaryRoot(t);
  const knownRoot = path.join(rootDir, 'known-repo');
  const { transfer } = transferFixture(t, [
    snapshotRecord({ id: FIRST_ID, project: 'alpha', tags: ['alpha-topic'] }),
    snapshotRecord({ id: SECOND_ID, project: 'zeta', tags: ['zeta-topic'] }),
  ], {
    transferOptions: {
      mapsRootFor: (project) => (project === 'alpha' ? knownRoot : null),
    },
  });

  const failure = await transfer.updateMaps().then(() => null, (error) => error);

  assert.deepEqual({
    code: failure?.code,
    reason: failure?.reasonCode,
    partialWrite: await exists(path.join(knownRoot, 'docs/cockpit/alpha-topic.md')),
  }, {
    code: 'KNOWLEDGE_UNAVAILABLE',
    reason: 'maps_root_unknown',
    partialWrite: false,
  });
});

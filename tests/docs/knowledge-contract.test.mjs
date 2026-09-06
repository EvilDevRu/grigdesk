import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { measureKnowledgeContext } from '../../server/src/lib/search/context.js';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);

// Единственная цель @-каскада. Файл держит карты локальной базы и в репозиторий не входит,
// поэтому сторожа отличают его отсутствие от битой ссылки.
const LOCAL_CASCADE = 'CLAUDE.local.md';

async function source(relativePath) {
  return readFile(path.join(ROOT, relativePath), 'utf8').catch(() => '');
}

test('CLAUDE.md ссылается на канонический контракт знаний', async () => {
  const claude = await source('CLAUDE.md');

  assert.equal(
    /\[([^\]]*знан[^\]]*)\]\(docs\/cockpit\/guide\/knowledge\.md\)/iu.test(claude),
    true,
  );
});

test('AGENTS.md сам объясняет исполнителю полный путь к базе знаний', async () => {
  const agents = await source('AGENTS.md');

  assert.deepEqual({
    mapsAreHeaders: /карт[^\n]{0,100}(?:заголов|только темы)/iu.test(agents),
    routeIsNotFile: /#\/knowledge\/<uuid>[\s\S]{0,140}не\s+файл|не\s+файл[\s\S]{0,140}#\/knowledge\/<uuid>/iu
      .test(agents),
    search: /knowledge\s+search/iu.test(agents),
    read: /knowledge\s+read/iu.test(agents),
    write: /knowledge\s+write/iu.test(agents),
    sameTurn: /исправ[^\n]{0,120}(?:том же|одном) заход/iu.test(agents),
  }, {
    mapsAreHeaders: true,
    routeIsNotFile: true,
    search: true,
    read: true,
    write: true,
    sameTurn: true,
  });
});

// Каскад репозитория состоит из ОДНОЙ строки: карты локальны для машины и в git не входят,
// поэтому прямой @-импорт карты вернул бы в поставку ссылку на файл, которого в клоне нет.
test('Каскад CLAUDE.md ведёт только в локальное оглавление', async () => {
  const claude = await source('CLAUDE.md');
  const imports = [...claude.matchAll(/^@([^\s]+)$/gm)].map((match) => match[1]);

  assert.deepEqual({
    imports,
    directMaps: imports.filter((target) => target.startsWith('docs/cockpit/')),
  }, {
    imports: [LOCAL_CASCADE],
    directMaps: [],
  });
});

test('Контракт описывает приватный путь базы и машинный override', async () => {
  const contract = await source('docs/cockpit/guide/knowledge.md');

  assert.deepEqual({
    defaultPath: contract.includes('~/.config/cockpit/knowledge/knowledge.db'),
    env: contract.includes('COCKPIT_KNOWLEDGE_DB_PATH'),
    modes: /0700[\s\S]{0,200}0600|0600[\s\S]{0,200}0700/.test(contract),
  }, {
    defaultPath: true,
    env: true,
    modes: true,
  });
});

test('Контракт различает CLI search/read/write и коды 0, 1, 2, 64', async () => {
  const contract = await source('docs/cockpit/guide/knowledge.md');

  assert.deepEqual({
    search: /knowledge\s+search/iu.test(contract),
    read: /knowledge\s+read/iu.test(contract),
    write: /knowledge\s+write/iu.test(contract),
    codes: ['0', '1', '2', '64'].every((code) => new RegExp(`(?:код|exit)[^\\n]{0,30}${code}`, 'iu')
      .test(contract)),
  }, {
    search: true,
    read: true,
    write: true,
    codes: true,
  });
});

test('Контракт фиксирует морфологию, её границы, ранжирование и пустой поиск', async () => {
  const contract = await source('docs/cockpit/guide/knowledge.md');

  assert.deepEqual({
    morphology: /деплой[\s\S]{0,120}деплоя|деплоя[\s\S]{0,120}деплой/iu.test(contract),
    fleetingVowel: /сборка[\s\S]{0,80}сборок/iu.test(contract),
    partOfSpeech: /перезапустить[\s\S]{0,80}перезапуск/iu.test(contract),
    ranking: /ранж|bm25/iu.test(contract),
    empty: /пуст[^\n]{0,80}(результат|список|items)/iu.test(contract),
  }, {
    morphology: true,
    fleetingVowel: true,
    partOfSpeech: true,
    ranking: true,
    empty: true,
  });
});

test('Контракт перечисляет HTTP, tool, live gate и CAS-ошибки', async () => {
  const contract = await source('docs/cockpit/guide/knowledge.md');

  assert.deepEqual({
    http: contract.includes('/api/knowledge'),
    tool: contract.includes('knowledge_search'),
    disabled: contract.includes('plugin_disabled'),
    unavailable: contract.includes('knowledge_unavailable'),
    conflict: contract.includes('knowledge_conflict') && contract.includes('expectedRevision'),
  }, {
    http: true,
    tool: true,
    disabled: true,
    unavailable: true,
    conflict: true,
  });
});

test('Контракт описывает запись, происхождение, карты и запрет удаления исполнителем', async () => {
  const contract = await source('docs/cockpit/guide/knowledge.md');

  assert.deepEqual({
    toolWrite: /knowledge_search[\s\S]{0,300}(?:action[^\n]{0,40}write|write)/iu.test(contract),
    fullRecord: ['repository', 'kind', 'title', 'body', 'tags']
      .every((field) => contract.includes(field)),
    revisionConflict: /(?:ревизи|revision)[\s\S]{0,200}(?:расхожд|конфликт|CAS)/iu.test(contract),
    noDelete: /(?:delete|удален)[^\n]{0,160}(?:недоступ|запрещ|только человек)/iu.test(contract),
    targetedMaps: /(?:точеч|соответствующ|стар[^\n]{0,30}нов)[^\n]{0,160}карт/iu.test(contract),
    fullHumanRefresh: /(?:пол[а-я]* пересбор|все карт)[^\n]{0,160}(?:человек|ручн)/iu.test(contract),
    provenance: ['actor', 'channel', 'ref'].every((field) => contract.includes(field)),
    noRuntimeIds: /runtime|task\/run|task[^\n]{0,40}run/iu.test(contract),
  }, {
    toolWrite: true,
    fullRecord: true,
    revisionConflict: true,
    noDelete: true,
    targetedMaps: true,
    fullHumanRefresh: true,
    provenance: true,
    noRuntimeIds: true,
  });
});

test('Замер отделяет текущую карту sample-записей от исторического @-каскада', async () => {
  const contract = await source('docs/cockpit/guide/knowledge.md');

  assert.deepEqual({
    dated: /29\.08\.2026|2026-08-29/.test(contract),
    samples: /три|3\s+(?:sample|пробн)/iu.test(contract),
    mapBytes: /карт[^\n]{0,80}(?:байт|КБ)/iu.test(contract),
    bodyBytes: /(?:тела|body)[^\n]{0,80}(?:байт|КБ)/iu.test(contract),
    historical: /истор[^\n]{0,100}(?:100\s*КБ|≈100)/iu.test(contract),
  }, {
    dated: true,
    samples: true,
    mapBytes: true,
    bodyBytes: true,
    historical: true,
  });
});

// Отсутствие локального оглавления — штатное состояние клона, а не поломка каскада.
test('Каждая цель @-каскада, кроме локального оглавления, существует в репозитории', async () => {
  const claude = await source('CLAUDE.md');
  const imports = [...claude.matchAll(/^@([^\s]+)$/gm)].map((match) => match[1]);
  const missing = [];
  for (const target of imports) {
    if (target === LOCAL_CASCADE) {
      continue;
    }
    const exists = await access(path.join(ROOT, target)).then(() => true).catch(() => false);
    if (!exists) {
      missing.push(target);
    }
  }

  assert.deepEqual(missing, []);
});

// Замер считает ровно то, что агент носит на себе каждый ход: корневые инструкции и весь
// @-каскад, включая вложенный локальный уровень с картами. Обход именно транзитивный:
// карты подключены не из CLAUDE.md, и счёт по одному уровню перестал бы их видеть.
// Карты вне каскада читаются по требованию и контекста не занимают, в бюджет не входят.
test('AGENTS.md, CLAUDE.md, карты @-каскада и резерв занимают не больше 60000 байт', async () => {
  const measured = await measureKnowledgeContext(ROOT);
  const reserveBytes = 512;
  const totalBytes = measured.totalBytes + reserveBytes;

  assert.deepEqual({
    cascadeEmpty: measured.imports.length === 0,
    unreadable: measured.missing.filter((target) => target !== LOCAL_CASCADE),
    withinBudget: totalBytes <= 60_000,
  }, {
    cascadeEmpty: false,
    unreadable: [],
    withinBudget: true,
  }, `фактический объём контекста: ${totalBytes} байт`);
});

const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

function liveMapIds(text) {
  return [...text.matchAll(new RegExp(
    `^- \\[[^\\n]+\\]\\(#/knowledge/(${UUID_SOURCE})\\)(?: ·[^\\n]+)?$`,
    'gimu',
  ))].map((match) => match[1].toLowerCase());
}

test('Каталог tracked-корпуса физически отсутствует в репозитории', async () => {
  const exists = await access(path.join(ROOT, 'docs/knowledge'))
    .then(() => true)
    .catch(() => false);

  assert.equal(exists, false);
});

// Верхний уровень docs/cockpit принадлежит картам целиком: продуктовые документы лежат в
// guide/ и reference/ именно поэтому. Пустой список — рабочая копия без записей или клон.
test('Все docs/cockpit документы являются картами с общей шапкой чтения', async () => {
  const names = (await readdir(path.join(ROOT, 'docs/cockpit')))
    .filter((name) => name.endsWith('.md'))
    .sort();
  const invalid = [];
  for (const name of names) {
    const map = await source(`docs/cockpit/${name}`);
    if (!map.includes('/knowledge') || !/knowledge\s+(?:search|read)/u.test(map)) {
      invalid.push(name);
    }
  }

  assert.deepEqual({ invalid }, { invalid: [] });
});

test('Карты содержат непустой набор уникальных ссылок на живые записи', async () => {
  const names = (await readdir(path.join(ROOT, 'docs/cockpit')))
    .filter((name) => name.endsWith('.md'));
  const maps = await Promise.all(names.map((name) => source(`docs/cockpit/${name}`)));
  const ids = maps.flatMap(liveMapIds);

  assert.deepEqual({
    linksPresent: names.length === 0 || ids.length > 0,
    duplicates: ids.length - new Set(ids).size,
  }, {
    linksPresent: true,
    duplicates: 0,
  });
});

test('В картах нет UUID без canonical live-ссылки и ссылок на txt', async () => {
  const names = (await readdir(path.join(ROOT, 'docs/cockpit')))
    .filter((name) => name.endsWith('.md'));
  const maps = await Promise.all(names.map((name) => source(`docs/cockpit/${name}`)));
  const text = maps.join('\n');
  const allIds = [...text.matchAll(new RegExp(`\\b${UUID_SOURCE}\\b`, 'giu'))]
    .map((match) => match[0].toLowerCase());

  assert.deepEqual({
    allIds: allIds.toSorted(),
    linkedIds: maps.flatMap(liveMapIds).toSorted(),
    txtLinks: [...text.matchAll(/\]\([^)]*\.txt\)/gu)].length,
  }, {
    allIds: maps.flatMap(liveMapIds).toSorted(),
    linkedIds: maps.flatMap(liveMapIds).toSorted(),
    txtLinks: 0,
  });
});

test('Сторож живых ссылок отклоняет неверный route и голый UUID', () => {
  const uuid = '00000000-0000-4000-8000-000000000099';
  const sample = [
    `- [Верная](#/knowledge/${uuid})`,
    `- [Битая](#/knowlege/${uuid})`,
    `Голая identity: ${uuid}`,
  ].join('\n');

  assert.deepEqual(liveMapIds(sample), [uuid]);
});

test('Router поддерживает прямой адрес каждой живой ссылки карты', async () => {
  const router = await source('web/src/router.js');

  assert.equal(router.includes("path: '/knowledge/:id?'"), true);
});

test('Физический контракт описывает единый самодостаточный backup и все поля записи', async () => {
  const contract = await source('docs/cockpit/guide/knowledge.md');
  const fields = [
    'id', 'title', 'body', 'tags', 'kind', 'project', 'repository', 'sourceDocument',
    'revision', 'updatedAt',
  ];

  assert.deepEqual({
    version: /schemaVersion[\s\S]{0,80}\b1\b/u.test(contract),
    checksum: /snapshotHash|sha-?256/iu.test(contract),
    fields: fields.filter((field) => !contract.includes(field)),
    oneFile: /од(?:ин|ного|ним)\s+файл/iu.test(contract),
  }, {
    version: true,
    checksum: true,
    fields: [],
    oneFile: true,
  });
});

test('Физический контракт разделяет backup import/export и обновление карт', async () => {
  const contract = await source('docs/cockpit/guide/knowledge.md');

  assert.deepEqual({
    previewApply: /preview[\s\S]{0,500}apply|предпросмотр[\s\S]{0,500}примен/iu.test(contract),
    conflict: /конфликт|CAS/iu.test(contract),
    mapsAction: /Обновить карты/u.test(contract),
    humanOnly: /human-only|только человек/iu.test(contract),
    noGitCorpus: /корпус[^\n]{0,120}(?:не хранится|вне git)|git[^\n]{0,120}не хран/iu.test(contract),
  }, {
    previewApply: true,
    conflict: true,
    mapsAction: true,
    humanOnly: true,
    noGitCorpus: true,
  });
});

test('Физический контракт больше не обещает manifest tracked-корпуса', async () => {
  const contract = await source('docs/cockpit/guide/knowledge.md');

  assert.equal(/создаёт manifest|Manifest публикуется|docs\/knowledge\/manifest\.json/iu.test(contract), false);
});

test('CLAUDE.md сохраняет язык, правила работы и запрет рестарта из чата', async () => {
  const claude = await source('CLAUDE.md');

  assert.deepEqual({
    language: /Всё общение и комментарии в коде[^\n]*русском/iu.test(claude),
    readability: /Читаемость кода/iu.test(claude) && /110 символ/iu.test(claude),
    docsSameTurn: /исправь канонический документ в том же заходе/iu.test(claude)
      && /(?:том же заходе|каноническ)[\s\S]{0,220}knowledge\s+write/iu.test(claude),
    manualStep: /пароль или ручной шаг[\s\S]{0,180}жди ответа/iu.test(claude)
      && /обходной стенд[\s\S]{0,120}после отказа/iu.test(claude),
    noRestart: /перезапуск изнутри[\s\S]{0,300}убивает/iu.test(claude),
    uiBoundary: /UI имеет одну публичную границу/iu.test(claude),
  }, {
    language: true,
    readability: true,
    docsSameTurn: true,
    manualStep: true,
    noRestart: true,
    uiBoundary: true,
  });
});

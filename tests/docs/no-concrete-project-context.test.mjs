import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { scanText } from './helpers/privateIdentifiers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const execFileAsync = promisify(execFile);
const ROOT_DOCS = new Set(['AGENTS.md', 'CLAUDE.md', 'README.md', 'tests/README.md']);
const ENGINE_DOCS = new Set(['engine/AGENTS.md', 'engine/CLAUDE.md', 'engine/README.md']);

// Названия продуктов и технические виды профиля не являются именами подключённых проектов.
// Неизвестное латинское имя по-прежнему требует placeholder, включая имя с заглавной буквы.
const PROFILE_TERMS = new Set([
  'demo', 'demo-profile', 'example', 'example-profile', 'fixture', 'sample-profile',
  'grigdesk', 'kimi', 'dsh', 'glm', 'worktree', 'native', 'vue', 'teleport',
  'grigdesk-glm-profile-v3', 'kimi-contained-v1', 'web',
]);

const RULES = [
  ['конкретный путь локального профиля', /\bprofiles\/[A-Za-z0-9][A-Za-z0-9._-]*/gu],
  ['конкретное значение --profile', /--profile(?:=|\s+)(?!<|\$)[A-Za-z0-9][A-Za-z0-9._-]*/giu],
  ['конкретный профиль в factory CLI', /\bfactory\s+profile\s+(?!<|\$)[A-Za-z0-9][A-Za-z0-9._-]*/giu],
  [
    'конкретный профиль в factory-check',
    /^(?:[A-Z_][A-Z0-9_]*=\S+[ \t]+)*(?:\.\.\/|engine\/)?bin\/factory-check[ \t]+(?!--|<|\$)[A-Za-z0-9][A-Za-z0-9._-]*/gimu,
  ],
  ['конкретный профиль в dashboard CLI', /\bbin\/dashboard\s+(?!<|\$)[A-Za-z0-9][A-Za-z0-9._-]*/giu],
  // Пробел ограничен одной строкой: латинское имя в начале следующей строки не профиль.
  // Кавычки Markdown снимаются перед поиском без изменения смещений и номеров строк.
  [
    'конкретный профиль в прозе',
    /профил(?:ь|я|ю|е|ем)[ \t]+(?!<|\$)([a-z][a-z0-9._-]*)/giu,
  ],
  ['реальный task token', /(?<![\\\w])t\d{4,}\b/giu],
  ['номер задачи с маркером', /[№#][ \t]*\d{4,}\b/gu],
  ['ветка или ссылка задачи', /\btask[-/:][ \t]*\d{4,}\b/giu],
  [
    'реальный task ID в прозе',
    /(?:задач(?:а|и|е|у|ей)?|прогон(?:а|е|у|ом)?|попытк(?:а|и|е|у|ой))[ \t]+\d{4,}\b/giu,
  ],
  ['реальный task ID в factory CLI', /\b(?:engine\/)?bin\/factory\s+\d{4,}\b/giu],
  ['ссылка на локальный план', /(?:docs\/|(?:\.\.\/)+)plans\/[^\s`<>()[\]]+\.md/gu],
  ['старый источник переноса', /^Источник до переноса:/gmu],
  ['запуск тестов без сторожа', /^\s*(?:[A-Z_][A-Z0-9_]*=\S+[ \t]+)*node[ \t]+--test\b/gmu],
];

/**
 * Выбирает общие инструкции и документацию поставки.
 * Локальные планы и заметки дополнительно исключает Git при получении списка.
 */
function isCommonDoc(file) {
  return ROOT_DOCS.has(file)
    || ENGINE_DOCS.has(file)
    || (file.startsWith('docs/') && file.endsWith('.md'));
}

/**
 * Учитывает новые неигнорируемые документы вместе с индексом.
 * Проверка должна находить ошибку до коммита, но не читать личные планы машины.
 */
async function commonDocs() {
  const { stdout } = await execFileAsync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  );
  return stdout.split('\0').filter(isCommonDoc);
}

function lineAt(source, index) {
  return source.slice(0, index).split('\n').length;
}

/**
 * Находит идентификаторы и непереносимые инструкции независимо от Markdown-выделения.
 * Возвращает позиции исходного текста, чтобы диагностика указывала точную строку.
 */
function scan(source) {
  const hits = [];
  const normalized = source.replace(/[`*]/g, ' ');

  for (const [label, pattern] of RULES) {
    for (const match of normalized.matchAll(pattern)) {
      const term = match[1]?.replace(/[.]+$/, '').toLowerCase();

      if (label === 'конкретный профиль в прозе' && PROFILE_TERMS.has(term)) {
        continue;
      }

      if (label === 'конкретный профиль в прозе' && term === 'profiles'
        && normalized[match.index + match[0].length] === '/') {
        continue;
      }

      hits.push({ label, value: match[0], index: match.index });
    }
  }

  return hits;
}

test('правило имени профиля в прозе отличает утечку от синтетики и вёрстки', () => {
  assert.deepEqual(
    scan('маршрут `feature` профиля customer-project нёс узел').map((hit) => hit.label),
    ['конкретный профиль в прозе'],
  );
  assert.deepEqual(scan('профиля fixture'), []);
  assert.deepEqual(scan('профилю `<profile>`'), []);
  assert.deepEqual(scan('профиля проекта'), []);
  assert.deepEqual(scan('marker профиля\n    routes/ source definitions'), []);
  assert.deepEqual(scan('Профиль Kimi; профиля DSH; профиль Vue.'), []);
  assert.deepEqual(scan('Profiles/clientRuntime'), []);
  assert.equal(scan('профиля `Customer-Project`').length, 1);
  assert.equal(scan('profiles/Fixture').length, 1);
});

test('номера задач обнаруживаются в прозе, заголовках и Markdown-выделении', () => {
  for (const source of ['Задача №12345', 'задачи **12345**', 'задаче `12345`',
    '## Решение № 12345', 'task-12345', 't12345', '#12345 — пример']) {
    assert.ok(scan(source).length > 0, source);
  }

  assert.deepEqual(scan('Задача <TASK>; v1; 100000000000..999999999999; порт 3000; версия 0.164.0'), []);
});

test('конкретный локальный план и голый node --test не проходят как инструкция', () => {
  assert.equal(scan('`docs/plans/private-plan.md`').length, 1);
  assert.equal(scan('[план](../../plans/private-plan.md)').length, 1);
  assert.equal(scan('node --test tests/docs/example.test.mjs').length, 1);
  assert.deepEqual(scan('Планы хранятся в `docs/plans/` вне Git.'), []);
  assert.deepEqual(scan('bash tests/run-node-tests-safe.sh --test tests/docs/example.test.mjs'), []);
});

test('общая документация обезличена и содержит переносимые инструкции', async () => {
  const hits = [];

  for (const file of await commonDocs()) {
    let source;

    try {
      source = await readFile(path.join(ROOT, file), 'utf8');
    } catch (error) {
      // `git ls-files --cached` видит staged-файл даже после его удаления из
      // рабочей копии. Удалённый документ проверять уже нечего.
      if (error?.code === 'ENOENT') {
        continue;
      }

      throw error;
    }

    hits.push(...scanText(file, source));

    for (const { label, value, index } of scan(source)) {
      hits.push(`${file}:${lineAt(source, index)}: ${label}: ${value}`);
    }
  }

  assert.deepEqual(hits, []);
});

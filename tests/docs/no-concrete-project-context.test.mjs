import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const execFileAsync = promisify(execFile);
const ROOT_DOCS = new Set(['AGENTS.md', 'CLAUDE.md', 'README.md']);
const ENGINE_DOCS = new Set(['engine/AGENTS.md', 'engine/CLAUDE.md', 'engine/README.md']);

const RULES = [
  ['конкретный путь локального профиля', /\bprofiles\/[A-Za-z0-9][A-Za-z0-9._-]*/giu],
  ['конкретное значение --profile', /--profile(?:=|\s+)(?!<|\$)[A-Za-z0-9][A-Za-z0-9._-]*/giu],
  ['конкретный профиль в factory CLI', /\bfactory\s+profile\s+(?!<|\$)[A-Za-z0-9][A-Za-z0-9._-]*/giu],
  [
    'конкретный профиль в factory-check',
    /^(?:[A-Z_][A-Z0-9_]*=\S+[ \t]+)*(?:\.\.\/|engine\/)?bin\/factory-check[ \t]+(?!--|<|\$)[A-Za-z0-9][A-Za-z0-9._-]*/gimu,
  ],
  ['конкретный профиль в dashboard CLI', /\bbin\/dashboard\s+(?!<|\$)[A-Za-z0-9][A-Za-z0-9._-]*/giu],
  // Путь `profiles/<имя>` ловит правило выше, но имя профиля попадает в общий текст и
  // прозой — «маршрут `feature` профиля <имя>». Синтетические имена разрешены явным
  // списком: он тот же, что у `no-private-identifiers`, и держит оба guard на одном
  // словаре. Латиница в классе не задевает обычное «профиля проекта», а разделитель —
  // пробелы ТОЙ ЖЕ строки: при переносе следующая строка часто начинается латиницей
  // (`routes/` в колонке структуры профиля), и `\s+` срабатывал бы на вёрстке.
  [
    'конкретный профиль в прозе',
    /профил(?:ь|я|ю|е|ем)[ \t]+(?!<|\$)(?!(?:demo|demo-profile|example|example-profile|fixture|sample-profile)\b)[a-z][a-z0-9._-]*/giu,
  ],
  ['реальный task token', /(?<![\\\w])t\d{4,}\b/giu],
  [
    'реальный task ID в прозе',
    /(?:задач(?:а|и|е|у|ей)?|прогон(?:а|е|у|ом)?|попытк(?:а|и|е|у|ой))\s+#?\d{4,}/giu,
  ],
  ['реальный task ID в factory CLI', /\b(?:engine\/)?bin\/factory\s+\d{4,}\b/giu],
];

function isCommonDoc(file) {
  return ROOT_DOCS.has(file)
    || ENGINE_DOCS.has(file)
    || (file.startsWith('docs/') && file.endsWith('.md'));
}

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

function scan(source) {
  const hits = [];

  for (const [label, pattern] of RULES) {
    for (const match of source.matchAll(pattern)) {
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
});

test('общая документация не содержит конкретные profile/task identifiers', async () => {
  const hits = [];

  for (const file of await commonDocs()) {
    let source;
    try {
      source = await readFile(path.join(ROOT, file), 'utf8');
    } catch (error) {
      // `git ls-files --cached` видит staged-файл даже после его удаления из
      // рабочей копии. Удалённый документ проверять уже нечего.
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    for (const { label, value, index } of scan(source)) {
      hits.push(`${file}:${lineAt(source, index)}: ${label}: ${value}`);
    }
  }

  assert.deepEqual(hits, []);
});

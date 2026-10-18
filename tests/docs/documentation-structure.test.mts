import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GRIGDESK_DOCS = 'docs/grigdesk';

// Папки docs/grigdesk, которые не являются областями: контракты продукта и справочник.
const NOT_AREAS = new Set(['guide', 'reference']);

// Локальная точка входа Claude Code: в свежем клоне её нет, и это штатное состояние.
const LOCAL_CASCADE = 'CLAUDE.local.md';

// Всё, что агент носит на себе каждый ход: корневые инструкции и транзитивный @-каскад.
// Документы и оглавления читаются по ссылке и в бюджет не входят.
const CASCADE_BUDGET_BYTES = 16_000;

function source(relativePath: string): string {
  const absolute = path.join(ROOT, relativePath);

  return existsSync(absolute) ? readFileSync(absolute, 'utf8') : '';
}

function areas(): string[] {
  return readdirSync(path.join(ROOT, GRIGDESK_DOCS), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !NOT_AREAS.has(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function imports(text: string): string[] {
  return [...text.matchAll(/^@(\S+)$/gm)].map((match) => match[1] ?? '');
}

/**
 * Обходит @-каскад транзитивно: вложенный уровень тоже едет в контекст, а повторы и
 * циклы считаются один раз. Отсутствующая цель просто не добавляет байтов.
 */
function cascade(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) {
    return seen;
  }

  seen.add(entry);
  for (const target of imports(source(entry))) {
    cascade(target, seen);
  }
  return seen;
}

/**
 * Файлы, которые видит Git: игнорируемые черновики машины (docs/local, docs/plans) не
 * участвуют в проверке поставки, как и в markdown-links.
 */
function visibleFiles(prefix: string): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', prefix],
    { cwd: ROOT, encoding: 'utf8' },
  );

  return out.split('\0').filter((file) => file && existsSync(path.join(ROOT, file)));
}

test('в docs/grigdesk есть области, и у каждой есть README-оглавление', () => {
  const list = areas();
  const withoutReadme = list
    .filter((area) => !existsSync(path.join(ROOT, GRIGDESK_DOCS, area, 'README.md')));

  assert.equal(list.length > 0, true);
  assert.deepEqual(withoutReadme, []);
});

// Документ, на который не ведёт оглавление, агент не найдёт: он читает README области,
// а не листинг папки.
test('README области ведёт на каждый документ своей папки', () => {
  const orphans: string[] = [];

  for (const area of areas()) {
    const dir = `${GRIGDESK_DOCS}/${area}`;
    const readme = source(`${dir}/README.md`);
    const linked = new Set([...readme.matchAll(/\]\(([^)\s#]+)(?:#[^)\s]*)?\)/g)]
      .map((match) => path.posix.normalize(path.posix.join(dir, match[1] ?? ''))));

    for (const file of visibleFiles(dir)) {
      if (file.endsWith('.md') && !file.endsWith('/README.md') && !linked.has(file)) {
        orphans.push(file);
      }
    }
  }

  assert.deepEqual(orphans, []);
});

test('CLAUDE.md и карта документации ведут в каждую область', () => {
  const claude = source('CLAUDE.md');
  const index = source('docs/README.md');

  assert.deepEqual({
    missingInClaude: areas().filter((area) => !claude.includes(`](docs/grigdesk/${area}/README.md)`)),
    missingInIndex: areas().filter((area) => !index.includes(`](grigdesk/${area}/README.md)`)),
  }, {
    missingInClaude: [],
    missingInIndex: [],
  });
});

// Верхний уровень принадлежит папкам: документ без области не попадает ни в одно оглавление.
test('верхний уровень docs/grigdesk держит только папки', () => {
  const loose = visibleFiles(GRIGDESK_DOCS)
    .filter((file) => path.posix.dirname(file) === GRIGDESK_DOCS);

  assert.deepEqual(loose, []);
});

test('каскад CLAUDE.md подключает только локальную точку входа', () => {
  assert.deepEqual(imports(source('CLAUDE.md')), [LOCAL_CASCADE]);
});

test('AGENTS.md, CLAUDE.md и @-каскад укладываются в бюджет контекста', () => {
  const files = ['AGENTS.md', ...cascade('CLAUDE.md')];
  const totalBytes = files.reduce((sum, file) => sum + Buffer.byteLength(source(file)), 0);

  assert.equal(
    totalBytes <= CASCADE_BUDGET_BYTES,
    true,
    `фактический объём контекста: ${totalBytes} байт`,
  );
});

test('AGENTS.md объясняет исполнителю путь к документации', () => {
  const agents = source('AGENTS.md');

  assert.deepEqual({
    readmeFirst: /docs\/grigdesk\/<область>\/README\.md/u.test(agents),
    search: /`rg`/u.test(agents),
    sameTurn: /исправ[^\n]{0,120}(?:том же|одном) заход/iu.test(agents),
    localTier: /docs\/local\//u.test(agents),
  }, {
    readmeFirst: true,
    search: true,
    sameTurn: true,
    localTier: true,
  });
});

test('CLAUDE.md сохраняет язык, правила работы и запрет рестарта из чата', () => {
  const claude = source('CLAUDE.md');

  assert.deepEqual({
    language: /Всё общение и комментарии в коде[^\n]*русском/iu.test(claude),
    readability: /Читаемость кода/iu.test(claude) && /110 символ/iu.test(claude),
    docsSameTurn: /исправь канонический документ в том же заходе/iu.test(claude)
      && /отдельный файл в папке области и строка в её README/iu.test(claude),
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

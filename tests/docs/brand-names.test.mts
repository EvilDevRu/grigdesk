import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

interface Allowance {
  path: string;
  pattern: RegExp;
  reason: string;
  removeWhen: string;
}

export interface BrandHit {
  file: string;
  line: number;
  text: string;
}

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const OLD = /cockpit|кокпит/gi;

export const BRAND_ALLOWANCES: Allowance[] = [
  ...['docs/grigdesk/server/brand-migration.md', 'docs/grigdesk/overview/legacy-names.md']
    .map((file) => ({
      path: file,
      pattern: /cockpit|кокпит/gi,
      reason: 'Документация переноса и чтения старых значений',
      removeWhen: 'Удаление совместимости',
    })),
  {
    path: 'deploy/lib/desktop-app.sh',
    pattern: /Кокпит|cockpit-local/gi,
    reason: 'Перенос старого профиля окна при установке; константы сверяются с legacyBrand.ts',
    removeWhen: 'Удаление переноса профиля',
  },
  {
    path: 'deploy/lib/cli-link.sh',
    pattern: /cockpit/g,
    reason: 'Уборка висячей ссылки прежней команды; константа сверяется с legacyBrand.ts',
    removeWhen: 'Удаление совместимости',
  },
  {
    path: 'shared/runtime/legacyBrand.ts',
    pattern: /cockpit|кокпит/gi,
    reason: 'Единственный источник старых имён для диагностики, переноса и чтения старых данных',
    removeWhen: 'Удаление совместимости',
  },
  {
    path: 'tests/docs/brand-names.test.mts',
    pattern: /cockpit|кокпит/gi,
    reason: 'Образцы запрещённого имени в стороже',
    removeWhen: 'Никогда',
  },
];

/**
 * Разрешение покрывает конкретное вхождение, а не всю строку рядом с ним.
 * Счётчик использования позволяет удалить разрешения, потерявшие свой контракт.
 */
function inspectLine(file: string, line: number, text: string, used: Set<number>): BrandHit[] {
  const spans: Array<[number, number]> = [];

  BRAND_ALLOWANCES.forEach((entry, index) => {
    const matchesPath = entry.path.endsWith('/') ? file.startsWith(entry.path) : file === entry.path;

    const selfExample = file === 'tests/docs/brand-names.test.mts' && entry.path !== file;

    if (selfExample || (entry.path && !matchesPath)) {
      return;
    }

    for (const match of text.matchAll(entry.pattern)) {
      spans.push([match.index, match.index + match[0].length]);
      used.add(index);
    }
  });

  const forbidden = [...text.matchAll(OLD)].some((match) => !spans.some(
    ([start, end]) => start <= match.index && end >= match.index + match[0].length,
  ));

  return forbidden ? [{
    file,
    line,
    text,
  }] : [];
}

/**
 * Анализирует только переданный текст: негативные пробы не читают рабочее дерево.
 * Одна находка соответствует одной строке независимо от числа старых слов в ней.
 */
export function findBrandNames(file: string, text: string, used = new Set<number>()): BrandHit[] {
  return text.split('\n').flatMap((line, index) => inspectLine(file, index + 1, line, used));
}

const files = [...new Set(execFileSync('git', [
  'ls-files', '--cached', '--others', '--exclude-standard', '-z',
], {
  cwd: ROOT,
  encoding: 'utf8',
  maxBuffer: 16 << 20,
}).split('\0').filter(Boolean))]
  .filter((file) => existsSync(path.join(ROOT, file)));
const used = new Set<number>();
const pathHits = files.flatMap((file) => inspectLine(file, 0, file, used));
const textHits = files.flatMap((file) => {
  const full = path.join(ROOT, file);
  const info = lstatSync(full);

  if (!info.isFile() || info.size > 4 * 1024 * 1024) {
    return [];
  }

  const bytes = readFileSync(full);

  return bytes.includes(0) ? [] : findBrandNames(file, bytes.toString('utf8'), used);
});

test('GD-01: пути не содержат старого имени вне таблицы', () => {
  assert.equal(pathHits.length, 0, JSON.stringify(pathHits.slice(0, 20)));
});

test('GD-02: текст не содержит старого имени вне таблицы', () => {
  assert.equal(textHits.length, 0, JSON.stringify(textHits.slice(0, 20)));
});

test('GD-03: каждое разрешение описано и относится к существующему пути', () => {
  for (const entry of BRAND_ALLOWANCES) {
    assert.ok(entry.reason.trim() && entry.removeWhen.trim(), entry.path);
    assert.ok(existsSync(path.join(ROOT, entry.path)), entry.path);
  }
});

test('GD-04: каждое разрешение используется', () => {
  assert.deepEqual(BRAND_ALLOWANCES.filter((_, index) => !used.has(index)), []);
});

test('GD-05: негативная проба обнаруживает все четыре формы', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'brand-names-'));
  const file = path.join(directory, 'negative.ts');

  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(file, 'COCKPIT_X\nКокпита\ncockpitFoo\nbin/cockpit');
  assert.equal(findBrandNames('negative.ts', readFileSync(file, 'utf8')).length, 4);
});

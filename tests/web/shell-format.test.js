import assert from 'node:assert/strict';
import test from 'node:test';

import { formatShellCommand } from '../../web/src/shared/shellFormat.ts';

const CASES = [
  ['ls -la', null],
  ["cd /srv/app && rg -n 'TODO' src | head -20; echo ---; sed -n 1,80p src/main.ts | cat",
    "cd /srv/app &&\n  rg -n 'TODO' src |\n  head -20\necho ---\nsed -n 1,80p src/main.ts |\n  cat"],
  [`echo "a && b; c | d" && printf '%s|%s' x y && rg -n 'foo|bar' src/very/long/path/to/make/it/long`,
    `echo "a && b; c | d" &&\n  printf '%s|%s' x y &&\n  rg -n 'foo|bar' src/very/long/path/to/make/it/long`],
  [
    'cd "$(git rev-parse --show-toplevel)" && (cd web && npm run build) && echo built-and-ready-for-review',
    null,
  ],
  ['cd /srv/app && (cd web && npm run build) && echo built-and-ready-for-review-with-padding-text',
    'cd /srv/app &&\n  (cd web && npm run build) &&\n  echo built-and-ready-for-review-with-padding-text'],
  ['diff <(sort a.txt) <(sort b.txt) && echo same-content-in-both-files-after-sorting-them-all',
    'diff <(sort a.txt) <(sort b.txt) &&\n  echo same-content-in-both-files-after-sorting-them-all'],
  [`find . -name '*.tmp' -exec rm {} \\; && echo removed-all-temporary-files-from-the-tree`,
    `find . -name '*.tmp' -exec rm {} \\; &&\n  echo removed-all-temporary-files-from-the-tree`],
  ["cat <<'EOF' > notes.txt && echo written-notes-file-with-a-long-enough-tail-text-now", null],
  ['grep -c foo <<< "$text" && echo found-it-in-the-text-and-some-padding-to-be-long-enough',
    'grep -c foo <<< "$text" &&\n  echo found-it-in-the-text-and-some-padding-to-be-long-enough'],
  ['[[ -f a.txt && -f b.txt ]] && echo both-files-exist-and-this-line-is-long-enough-now',
    '[[ -f a.txt && -f b.txt ]] &&\n  echo both-files-exist-and-this-line-is-long-enough-now'],
  ['(( count > 0 || force )) && echo going-on-with-the-count-and-a-long-tail-of-text-now',
    '(( count > 0 || force )) &&\n  echo going-on-with-the-count-and-a-long-tail-of-text-now'],
  ['make build && make test # потом && выкладка, а этот хвост делает строку ещё длиннее',
    'make build &&\n  make test # потом && выкладка, а этот хвост делает строку ещё длиннее'],
  ['echo one\necho two && echo three', null],
  ['echo "unbalanced && quote and some more text to pass the length threshold of eighty', null],
  ['npm run build 2>&1 | tee .state/artifacts/build.log && echo build-finished-successfully',
    'npm run build 2>&1 |\n  tee .state/artifacts/build.log &&\n  echo build-finished-successfully'],
  ['case "$x" in a) echo first-branch-of-case;; b) echo second-branch-of-case-now;; esac', null],
  ['test -f config.json || echo missing-config-file-please-create-it-before-the-start',
    'test -f config.json ||\n  echo missing-config-file-please-create-it-before-the-start'],
  ['for f in a b c; do echo "$f"; done; echo finished-the-loop-over-all-of-the-files-now',
    'for f in a b c\ndo echo "$f"\ndone\necho finished-the-loop-over-all-of-the-files-now'],
  ['cmd1 |& tee out.log; echo "exit: $?" and some more text to make it longer than eighty',
    'cmd1 |&\n  tee out.log\necho "exit: $?" and some more text to make it longer than eighty'],
  // Контрпримеры первого ревью: консервативный возврат входа.
  ["printf '%s\\n' ${value//;/,} && echo replaced-all-semicolons-with-commas-in-the-value", null],
  ["printf '%s\\n' ${value:-a|b} && echo default-value-with-a-pipe-inside-the-expansion", null],
  ['echo $[1 + 2] && echo old-style-arithmetic-expansion-is-not-parsed-by-the-formatter', null],
  ["printf $'a;b\\n' && echo ansi-c-quoting-is-not-parsed-by-the-formatter-at-all-here", null],
  ['printf \'%s\\n\' "$(printf "%s" "alpha && beta")" && echo nested-substitution-inside-quotes', null],
  ['echo "started at `date`" && echo backticks-inside-double-quotes-are-not-parsed-here', null],
  [`printf '%s\\n' hello\\ ; echo escaped-space-before-the-separator-must-survive-here-too`,
    `printf '%s\\n' hello\\ \necho escaped-space-before-the-separator-must-survive-here-too`],
  ['  echo leading-and-trailing-spaces-without-separators-stay-byte-for-byte-the-same   ', null],
  ['echo (unbalanced && echo the-parenthesis-is-never-closed-in-this-long-command-line', null],
  // Граница длины: 80 символов — как есть, 81 — форматируется.
  [`echo a && echo ${'b'.repeat(65)}`, null],
  [`echo a && echo ${'b'.repeat(66)}`,
    `echo a &&
  echo ${'b'.repeat(66)}`],
];

/**
 * Литеральные ожидания проверяют формат независимо от реализации сканера.
 * Индексы объединяют родственные конструкции оболочки в отдельный сценарий.
 */
function checkCases(indices) {
  for (const index of indices) {
    const [input, expected] = CASES[index];

    assert.equal(formatShellCommand(input), expected ?? input, `Пример ${index + 1}`);
  }
}

test('TIP-FMT-01: короткие и многострочные сохраняются', () => {
  checkCases([0, 12]);
});

test('TIP-FMT-02: опорная цепочка', () => {
  checkCases([1]);
});

test('TIP-FMT-03: кавычки и подстановки', () => {
  checkCases([2, 3, 4, 5]);
});

test('TIP-FMT-04: экранирование и перенаправления', () => {
  checkCases([6, 14, 16, 18]);
});

test('TIP-FMT-05: неоднозначные конструкции и here-string', () => {
  checkCases([7, 8, 13, 15, 27]);
});

test('TIP-FMT-06: условия, арифметика, комментарий и цикл', () => {
  checkCases([9, 10, 11, 17]);
});

test('TIP-FMT-07: консервативный возврат сложных подстановок', () => {
  checkCases([19, 20, 21, 22, 23, 24]);
});

test('TIP-FMT-08: пробелы и граница длины', () => {
  checkCases([25, 26, 28, 29]);
});

test('TIP-FMT-09: повторное форматирование не меняет результат', () => {
  for (const [input] of CASES) {
    const formatted = formatShellCommand(input);

    assert.equal(formatShellCommand(formatted), formatted);
  }
});

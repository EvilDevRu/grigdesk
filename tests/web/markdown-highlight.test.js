import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalLanguage, highlightCode } from '../../web/src/shared/markdown/codeHighlight.ts';

test('RMD-HL-01: синоним языка находит грамматику', () => {
  assert.equal(canonicalLanguage('TS'), 'typescript');
  assert.equal(canonicalLanguage('sh'), 'bash');
  assert.equal(canonicalLanguage('nope'), '');
  assert.equal(canonicalLanguage('constructor'), '');
  assert.equal(canonicalLanguage('toString'), '');
});

test('RMD-HL-02: TypeScript подсвечен переменными темы, текст строк не меняется', async () => {
  const lines = await highlightCode('const a = "x";\nlet b', 'ts');

  assert.equal(lines?.length, 2);
  assert.deepEqual(lines?.[0][0], { content: 'const', color: 'var(--md-code-token-keyword)' });
  assert.deepEqual(lines?.map((line) => line.map(({ content }) => content).join('')),
    ['const a = "x";', 'let b']);
});

test('RMD-HL-03: неизвестный язык и слишком длинный код — null', async () => {
  assert.equal(await highlightCode('x', 'nope'), null);
  assert.equal(await highlightCode('a'.repeat(20_001), 'ts'), null);
});

test('RMD-HL-04: Vue с вложенными грамматиками подсвечивается', async () => {
  const code = '<template><div>{{ a }}</div></template>';
  const lines = await highlightCode(code, 'vue');

  assert.notEqual(lines, null);
  assert.equal(lines?.flat().map(({ content }) => content).join(''), code);
});

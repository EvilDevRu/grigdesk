import assert from 'node:assert/strict';
import test from 'node:test';

import { diffLines, isDiffLanguage, plainLines, shouldCollapse }
  from '../../web/src/shared/markdown/fenceLines.ts';

test('RMD-LINES-01: простые строки сохраняют текст и пустую строку', () => {
  assert.deepEqual(plainLines('a\n\nb').map((line) => line.tokens[0].content), ['a', '', 'b']);
  assert.equal(plainLines('').length, 1);
});

test('RMD-LINES-02: вид строк диффа', () => {
  const code = 'diff --git a/x b/x\nindex 1..2\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n same';

  assert.deepEqual(diffLines(code).map(({ kind }) => kind),
    ['meta', 'meta', 'meta', 'meta', 'hunk', 'del', 'add', '']);
});

test('RMD-LINES-03: дифф по языкам diff и patch, регистр не важен', () => {
  assert.equal(isDiffLanguage('Patch'), true);
  assert.equal(isDiffLanguage('DIFF'), true);
  assert.equal(isDiffLanguage('ts'), false);
});

test('RMD-LINES-04: сворачивание после 24 строк', () => {
  assert.equal(shouldCollapse(Array(24).fill('x').join('\n')), false);
  assert.equal(shouldCollapse(Array(25).fill('x').join('\n')), true);
});

test('RMD-LINES-05: +++i и ---flag — содержимое diff', () => {
  assert.deepEqual(diffLines('+++i\n---flag\n+++ b/x\n--- a/x').map(({ kind }) => kind),
    ['add', 'del', 'meta', 'meta']);
});

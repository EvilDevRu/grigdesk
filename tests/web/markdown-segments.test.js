import assert from 'node:assert/strict';
import test from 'node:test';

import { fenceKind, fenceLanguage, isClosedFence, splitMarkdown }
  from '../../web/src/shared/markdown/segments.ts';
import { mdTokensToHtml } from '../../web/src/shared/md.ts';

test('RMD-SEG-01: обычный текст — один кусок Markdown', () => {
  const segments = splitMarkdown('Обычный ответ');

  assert.deepEqual(segments.map(({ key, kind }) => ({ key, kind })), [
    { key: '0:markdown', kind: 'markdown' },
  ]);
  assert.match(mdTokensToHtml(segments[0].tokens), /<p>Обычный ответ<\/p>/);
});

test('RMD-SEG-02: текст, схема, текст — три куска по порядку', () => {
  const segments = splitMarkdown('Ответ\n\n```mermaid\nflowchart TD\n A-->B\n```\n\nХвост');

  assert.deepEqual(segments.map(({ key }) => key), ['0:markdown', '1:fence', '2:markdown']);
  assert.deepEqual(segments[1], {
    key: '1:fence',
    kind: 'fence',
    fence: 'mermaid',
    lang: 'mermaid',
    code: 'flowchart TD\n A-->B',
    closed: true,
  });
});

test('RMD-SEG-03: незакрытый блок в конце помечен открытым', () => {
  const segment = splitMarkdown('Текст\n\n```mermaid\nflowchart TD\n A-->')[1];

  assert.equal(segment.closed, false);
  assert.equal(segment.code, 'flowchart TD\n A-->');
});

test('RMD-SEG-04: одна строка ограды — открытый пустой блок с языком', () => {
  const segment = splitMarkdown('```ts title="x.ts"')[0];

  assert.equal(segment.lang, 'ts');
  assert.equal(segment.code, '');
  assert.equal(segment.closed, false);
});

test('RMD-SEG-05: закрывающая ограда учитывает символ и длину', () => {
  assert.equal(isClosedFence('~~~diff\n+a\n~~~\n'), true);
  assert.equal(isClosedFence('```\nx\n````'), true);
  assert.equal(isClosedFence('```\nx\n~~~'), false);
  assert.equal(isClosedFence('````\nx\n```'), false);
});

test('RMD-SEG-06: отступной код и вложенные блоки остаются Markdown', () => {
  for (const source of [
    'Абзац\n\n    indented\n', '- пункт\n\n  ```ts\n  x\n  ```', '> ```ts\n> x\n> ```',
  ]) {
    assert.deepEqual(splitMarkdown(source).map(({ kind }) => kind), ['markdown']);
  }
});

test('RMD-SEG-07: пустые строки между блоками не дают кусков', () => {
  assert.deepEqual(splitMarkdown('```a\n```\n\n```b\n```').map(({ key }) => key),
    ['0:fence', '1:fence']);
  assert.deepEqual(splitMarkdown('\n\n'), []);
});

test('RMD-SEG-08: язык нормализуется, мусор отбрасывается', () => {
  assert.equal(fenceLanguage('TS title="x"'), 'ts');
  assert.equal(fenceLanguage('{.python}'), '');
  assert.equal(fenceKind('mermaid'), 'mermaid');
  assert.equal(fenceKind('constructor'), 'code');
});

test('RMD-SEG-09: сноска из конца разрешается в первом куске', () => {
  const segment = splitMarkdown('См. [план][p]\n\n```ts\nx\n```\n\n[p]: https://example.com/plan')[0];

  assert.match(mdTokensToHtml(segment.tokens), /href="https:\/\/example.com\/plan"/);
});

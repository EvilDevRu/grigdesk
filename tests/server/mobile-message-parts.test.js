import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectMedia,
  splitMessageParts,
} from '../../server/src/lib/mobile/facade/messageParts.ts';

test('MC-28/MC-29: код, локальные картинки, внешние адреса и media со значимым итогом', () => {
  assert.deepEqual(splitMessageParts(''), []);
  assert.deepEqual(splitMessageParts('```ts\n![x](a.png)\n```'), [
    {
      type: 'code',
      lang: 'ts',
      text: '![x](a.png)\n',
    },
  ]);
  assert.deepEqual(splitMessageParts('Вот ![схема](<screens/test.png>) конец'), [
    {
      type: 'text',
      text: 'Вот ',
    },
    {
      type: 'image',
      ref: 'w:c2NyZWVucy90ZXN0LnBuZw',
      alt: 'схема',
    },
    {
      type: 'text',
      text: ' конец',
    },
  ]);
  assert.deepEqual(splitMessageParts('![x](https://example.invalid/a.png)'), [
    {
      type: 'text',
      text: '[картинка: x] <https://example.invalid/a.png>',
    },
  ]);
  assert.deepEqual(
    collectMedia({
      role: 'assistant',
      steps: [
        {
          name: 'Read',
          text: '[изображение]',
          sub: 'a.png',
        },
        {
          name: 'Read',
          text: 'Ошибка',
          sub: 'b.jpg',
        },
        {
          name: 'GenerateImage',
          text: '[изображение]',
          sub: 'c.webp',
        },
        {
          name: 'Read',
          text: '[изображение]',
          sub: 'd.svg',
        },
      ],
    }),
    [
      {
        ref: 'w:YS5wbmc',
        alt: 'Read: a.png',
        from: 'step',
      },
      {
        ref: 'w:Yy53ZWJw',
        alt: 'GenerateImage: c.webp',
        from: 'step',
      },
    ],
  );
  assert.deepEqual(
    collectMedia({
      role: 'user',
      attachments: [
        {
          file: 'first.png',
          name: 'Первая',
        },
        {
          file: 'report.pdf',
          name: 'Отчёт',
        },
      ],
    }),
    [
      {
        ref: 'u:first.png',
        alt: 'Первая',
        from: 'upload',
      },
    ],
  );
});

test('MC-29: media из настоящей ленты, где вызов и итог шага — отдельные записи по id', () => {
  assert.deepEqual(
    collectMedia({
      role: 'assistant',
      steps: [
        {
          k: 'start',
          model: 'claude-haiku-5-5',
        },
        {
          k: 'tool',
          id: 'read-ok',
          name: 'Read',
          title: 'a.png',
          sub: '/work/a.png',
        },
        {
          k: 'res',
          id: 'read-ok',
          ok: true,
          text: '[изображение]',
          lines: 1,
        },
        {
          k: 'tool',
          id: 'read-failed',
          name: 'Read',
          title: 'b.png',
          sub: '/work/b.png',
        },
        {
          k: 'res',
          id: 'read-failed',
          ok: false,
          text: 'File does not exist.',
        },
        {
          k: 'tool',
          id: 'view',
          name: 'Read',
          title: 'c.jpg',
          sub: '/work/c.jpg',
        },
        {
          k: 'res',
          id: 'view',
          ok: true,
          text: '',
        },
        {
          k: 'tool',
          id: 'generated',
          name: 'GenerateImage',
          title: 'кот',
          sub: '/gen/d.webp',
        },
        {
          k: 'res',
          id: 'generated',
          ok: true,
          text: '[изображение]',
        },
        {
          k: 'tool',
          id: 'pending',
          name: 'Read',
          title: 'e.png',
          sub: '/work/e.png',
        },
        {
          k: 'tool',
          id: 'notes',
          name: 'Read',
          title: 'notes.md',
          sub: '/work/notes.md',
        },
        {
          k: 'res',
          id: 'notes',
          ok: true,
          text: '# Заметки',
        },
        {
          k: 'tool',
          id: 'shell',
          name: 'Bash',
          title: 'ls',
          sub: '/work/f.png',
        },
        {
          k: 'res',
          id: 'shell',
          ok: true,
          text: 'f.png',
        },
      ],
    }),
    [
      {
        ref: `w:${Buffer.from('/work/a.png').toString('base64url')}`,
        alt: 'Read: a.png',
        from: 'step',
      },
      {
        ref: `w:${Buffer.from('/work/c.jpg').toString('base64url')}`,
        alt: 'Read: c.jpg',
        from: 'step',
      },
      {
        ref: `w:${Buffer.from('/gen/d.webp').toString('base64url')}`,
        alt: 'GenerateImage: d.webp',
        from: 'step',
      },
    ],
  );
});

test('MC-28: preview длинного и незакрытого fence не открывает картинки внутри кода', () => {
  const parts = splitMessageParts('```ts\n![inside](hidden.png)\n' + 'x'.repeat(40000) + '\n```');

  assert.equal(parts.length, 1);
  assert.equal(parts[0].type, 'code');
  assert.equal(parts[0].truncated, true);
  assert.equal(splitMessageParts('```ts\n![inside](hidden.png)')[0].type, 'code');
});

// Rich-сообщение (Bot API 10.1): содержимое приезжает деревом блоков, а плоские
// `text`/`caption`/`video` у него пусты. Без разбора блоков такое сообщение
// доходило до Входящих пустой карточкой — ни текста, ни вложения.
import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeMessage } from '../../server/src/lib/telegram/updates.ts';

const CHAT = { id: -1001234567890, type: 'supergroup', title: 'Проект' };
const BASE = { message_id: 21214, date: 1789042055, chat: CHAT, from: { id: 42, first_name: 'Пётр' } };

const video = {
  duration: 17,
  width: 1920,
  height: 1080,
  file_name: 'bug.mp4',
  mime_type: 'video/mp4',
  file_id: 'video-file-id',
  file_unique_id: 'video-unique',
  file_size: 3_500_000,
};

test('текст и видео rich-сообщения доезжают в плоский контракт', () => {
  const msg = normalizeMessage({
    ...BASE,
    rich_message: {
      blocks: [
        { type: 'paragraph', text: 'Баг при сбросе фильтра' },
        { type: 'paragraph', text: '' },
        { type: 'video', video, caption: { text: 'https://example.test/positions' } },
      ],
    },
  });

  assert.equal(msg.text, 'Баг при сбросе фильтра\nhttps://example.test/positions');
  assert.deepEqual(msg.media, [{
    kind: 'video',
    fileId: 'video-file-id',
    uniqueId: 'video-unique',
    size: 3_500_000,
    name: 'bug.mp4',
    mime: 'video/mp4',
  }]);
});

test('оформленные куски абзаца склеиваются, а не теряются', () => {
  const msg = normalizeMessage({
    ...BASE,
    rich_message: {
      blocks: [{
        type: 'paragraph',
        text: [
          { type: 'plain', text: 'смотри ' },
          { type: 'bold', text: 'здесь' },
          { type: 'link', text: [{ type: 'plain', text: ' → ссылка' }] },
        ],
      }],
    },
  });

  assert.equal(msg.text, 'смотри здесь → ссылка');
});

test('фото в блоке берётся самым крупным размером', () => {
  const msg = normalizeMessage({
    ...BASE,
    rich_message: {
      blocks: [{
        type: 'photo',
        photo: [
          { file_id: 'small', file_unique_id: 'u-small', file_size: 900, width: 90, height: 60 },
          { file_id: 'big', file_unique_id: 'u-big', file_size: 90_000, width: 1280, height: 720 },
        ],
      }],
    },
  });

  assert.deepEqual(msg.media, [{
    kind: 'photo',
    fileId: 'big',
    uniqueId: 'u-big',
    size: 90_000,
    width: 1280,
    height: 720,
  }]);
});

test('блоки контейнера разбираются вместе с ним', () => {
  const msg = normalizeMessage({
    ...BASE,
    rich_message: {
      blocks: [{
        type: 'collage',
        blocks: [
          { type: 'paragraph', text: 'внутри' },
          { type: 'document', document: { file_id: 'doc', file_unique_id: 'u-doc', file_name: 'log.txt' } },
        ],
      }],
    },
  });

  assert.equal(msg.text, 'внутри');
  assert.equal(msg.media[0].kind, 'document');
  assert.equal(msg.media[0].fileId, 'doc');
});

test('плоское сообщение разбирается по-прежнему', () => {
  const msg = normalizeMessage({ ...BASE, caption: 'подпись', video });

  assert.equal(msg.text, 'подпись');
  assert.equal(msg.media.length, 1);
  assert.equal(msg.media[0].kind, 'video');
});

test('глубина и ширина дерева ограничены', () => {
  let deepest = { type: 'paragraph', text: 'дно' };

  for (let i = 0; i < 40; i += 1) deepest = { type: 'collage', blocks: [deepest] };

  const wide = Array.from({ length: 4000 }, (_, i) => ({ type: 'paragraph', text: `часть ${i}` }));
  const msg = normalizeMessage({ ...BASE, rich_message: { blocks: [deepest, ...wide] } });

  assert.ok(!msg.text.includes('дно'), 'слишком глубокий блок не разбирается');
  assert.ok(msg.text.split('\n').length <= 500, 'ширина ограничена пределом блоков');
});

test('сообщение без rich_message не ломается', () => {
  const msg = normalizeMessage({ ...BASE, text: 'обычный текст' });

  assert.equal(msg.text, 'обычный текст');
  assert.deepEqual(msg.media, []);
});

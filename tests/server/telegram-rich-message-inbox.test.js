// Стык rich-сообщения (Bot API 10.1) и Входящих: карточка собирается из того же
// native-ряда архива, который пишет поллер.
//
// Вид вложения нормализатор и канал объявляют каждый у себя. Разъехались списки —
// теряется не одно вложение: `attachmentOf` роняет разбор архивного ряда целиком,
// и карточка не собирается вовсе. Поэтому виды проверяются сквозным проходом.
import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeUpdate } from '../../server/src/lib/telegram/updates.ts';
import { toInboxMessage } from '../../server/src/lib/telegram/inboxChannel.ts';

const ACCOUNT_REF = 'acc_telegram_rich_inbox_01';
const CHAT = -1001000000042;
const THREAD = 42;
const T0 = 1_786_172_400;

const update = (over = {}) => normalizeUpdate({
  update_id: 1,
  message: {
    message_id: 20425,
    message_thread_id: THREAD,
    date: T0,
    chat: { id: CHAT, title: 'Проект', type: 'supergroup', is_forum: true },
    from: { id: 42, first_name: 'Пётр' },
    ...over,
  },
});

// Фото приезжает лесенкой размеров, остальное — одним файлом.
const fileOf = (field) => (field === 'photo'
  ? [
    { file_id: 'ph-small', file_unique_id: 'u-ph-small', width: 10, height: 10, file_size: 90 },
    { file_id: 'ph-big', file_unique_id: 'u-ph-big', width: 100, height: 100, file_size: 4096 },
  ]
  : {
    file_id: `${field}-id`,
    file_unique_id: `u-${field}`,
    file_size: 2048,
    mime_type: 'application/octet-stream',
  });

test('пересланное rich-сообщение доходит до карточки с текстом и видео', () => {
  const normalized = update({
    forward_date: T0 - 60,
    forward_origin: { type: 'user', date: T0 - 60, sender_user: { id: 7, first_name: 'Иван' } },
    rich_message: {
      blocks: [
        { type: 'paragraph', text: 'Баг при сбросе фильтра по группе' },
        { type: 'paragraph', text: '' },
        {
          type: 'video',
          video: {
            file_id: 'vid',
            file_unique_id: 'u-vid',
            file_size: 8_238_219,
            duration: 24,
            mime_type: 'video/mp4',
          },
          // Подпись приезжает не строкой, а оформленным фрагментом-ссылкой:
          // именно в такой форме её прислал Телеграм на живом сообщении.
          caption: {
            type: 'url',
            text: 'https://example.test/projects/12728/positions',
            url: 'https://example.test/projects/12728/positions',
          },
        },
      ],
    },
  });
  const card = toInboxMessage(normalized.msg, { accountRef: ACCOUNT_REF });

  assert.equal(
    card.text,
    'Баг при сбросе фильтра по группе\nhttps://example.test/projects/12728/positions',
  );
  assert.deepEqual(card.attachments, [{
    ref: 'vid',
    dedupeKey: 'u-vid',
    kind: 'video',
    displayLabel: 'видео',
    name: '',
    size: 8_238_219,
  }]);
});

test('каждый вид rich-вложения канал Входящих принимает', () => {
  const fields = [
    'photo', 'video', 'animation', 'audio', 'voice_note', 'video_note', 'document', 'sticker',
  ];

  for (const field of fields) {
    const normalized = update({
      rich_message: { blocks: [{ type: field, [field]: fileOf(field) }] },
    });

    assert.equal(normalized.msg.media.length, 1, `${field}: нормализатор увидел вложение`);

    const card = toInboxMessage(normalized.msg, { accountRef: ACCOUNT_REF });

    assert.equal(card.attachments.length, 1, `${field}: карточка получила вложение`);
    assert.ok(card.attachments[0].kind, `${field}: у вложения есть вид`);
    assert.ok(card.attachments[0].displayLabel, `${field}: у вложения есть подпись для человека`);
  }
});

test('незнакомый блок не роняет разбор и не выдумывает вложений', () => {
  const normalized = update({
    rich_message: {
      blocks: [
        { type: 'poll', poll: { id: '1', question: 'вопрос' } },
        { type: 'paragraph', text: 'подпись рядом' },
      ],
    },
  });
  const card = toInboxMessage(normalized.msg, { accountRef: ACCOUNT_REF });

  assert.equal(card.text, 'подпись рядом');
  assert.deepEqual(card.attachments, []);
});

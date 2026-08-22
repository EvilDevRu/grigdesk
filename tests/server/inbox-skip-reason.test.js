import assert from 'node:assert/strict';
import test from 'node:test';

import { skipReasonCode, skipReasonText } from '../../server/src/lib/inbox/skip-reason.js';

test('код причины принимается только машинный', () => {
  assert.equal(skipReasonCode('file_too_large'), 'file_too_large');
  assert.equal(skipReasonCode('download_failed'), 'download_failed');
  // Свободный текст провайдера кодом не является: именно в нём приезжает токен.
  assert.equal(skipReasonCode('token=secret-value'), null);
  assert.equal(skipReasonCode('файл 53 МБ'), null);
  assert.equal(skipReasonCode(''), null);
  assert.equal(skipReasonCode('a'.repeat(81)), null);
  assert.equal(skipReasonCode(42), null);
});

test('фразу собирает кокпит, а числа приходят отдельными полями', () => {
  assert.equal(
    skipReasonText('file_too_large', { sizeBytes: 56_215_647, limitBytes: 20 * 1024 * 1024 }),
    'файл 54 МБ — бот не может скачать больше 20 МБ',
  );
  // Без размеров остаётся общая формулировка: выдумывать числа неоткуда.
  assert.equal(
    skipReasonText('file_too_large'),
    'файл больше предела бота — Telegram не отдаёт такие файлы',
  );
  assert.equal(skipReasonText('not_connected'), 'канал отключён — файл не забрать');
  // Временный отказ обязан звать повторить, постоянный — нет: иначе человек
  // одинаково читает потолок Bot API и моргнувшую сеть.
  assert.match(skipReasonText('download_failed'), /попробуйте позже/);
  assert.equal(skipReasonText('too_many_attachments'), 'вложений в обращении больше, чем разбирается за раз');
});

test('текст провайдера наружу не проходит ни при каких полях', () => {
  const leaky = 'https://api.telegram.org/file/bot123:SECRET/x.mp4 не скачался';
  const text = skipReasonText(leaky, { sizeBytes: 999, limitBytes: 100 });
  assert.equal(text, 'вложение не удалось подготовить');
  assert.ok(!text.includes('SECRET'));
  // Незнакомый код не притворяется известным: новый канал не получит чужую фразу.
  assert.equal(skipReasonText('brand_new_channel_reason'), 'вложение не удалось подготовить');
});

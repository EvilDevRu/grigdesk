// Разбор ссылок t.me из текста задачи Битрикса: пять форм, хвосты и дедуп.
// Парсер отвечает ТОЛЬКО на вопрос «что за адрес написан», область доступа и чат
// определяет резолв (см. telegram-link-scope.test.js): за формой
// `t.me/<username>/<N>` может стоять и пост канала, и сообщение группы.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseTelegramLinks,
  telegramMessageLink,
} from '../../server/src/lib/telegram/links.js';

const one = (text) => {
  const links = parseTelegramLinks(text);
  assert.equal(links.length, 1, `ожидалась одна ссылка в «${text}», получено ${links.length}`);
  return links[0];
};

test('native message link строится только для public username или private supergroup', () => {
  assert.equal(telegramMessageLink({
    chatId: -1001234567890, chatUsername: '', threadId: null, messageId: 42,
  }), 'https://t.me/c/1234567890/42');
  assert.equal(telegramMessageLink({
    chatId: -1001234567890, chatUsername: '@cockpit_bugs', threadId: 7, messageId: 42,
  }), 'https://t.me/cockpit_bugs/7/42');
  assert.equal(telegramMessageLink({
    chatId: 555000111, chatUsername: '', threadId: null, messageId: 42,
  }), null);
  assert.equal(telegramMessageLink({
    chatId: -1001234567890, chatUsername: 'bad/name', threadId: null, messageId: 42,
  }), null);
});

test('публичный чат: t.me/<username>/<msg>', () => {
  const link = one('смотри https://t.me/cockpit_bugs/1287 там всё');
  assert.equal(link.username, 'cockpit_bugs');
  assert.equal(link.chatId, null);
  assert.equal(link.messageId, 1287);
  assert.equal(link.threadId, null);
  assert.equal(link.commentId, null);
  // Пост канала и сообщение группы пишутся одинаково — решает резолв, не парсер.
  assert.equal(link.ambiguous, true);
});

test('публичный форум: t.me/<username>/<thread>/<msg>', () => {
  const link = one('https://t.me/cockpit_bugs/12/1287');
  assert.equal(link.username, 'cockpit_bugs');
  assert.equal(link.threadId, 12);
  assert.equal(link.messageId, 1287);
  assert.equal(link.ambiguous, false); // тема бывает только у группы-форума
});

test('приватная группа: t.me/c/<internal>/<msg>, chat_id дописывается -100', () => {
  const link = one('https://t.me/c/1234567890/42');
  assert.equal(link.chatId, -1001234567890);
  assert.equal(link.username, null);
  assert.equal(link.messageId, 42);
  assert.equal(link.threadId, null);
});

test('приватный форум: t.me/c/<internal>/<thread>/<msg>', () => {
  const link = one('https://t.me/c/1234567890/7/42');
  assert.equal(link.chatId, -1001234567890);
  assert.equal(link.threadId, 7);
  assert.equal(link.messageId, 42);
});

test('комментарий к посту канала: ?comment=<id>', () => {
  const link = one('https://t.me/my_channel/900?comment=17');
  assert.equal(link.username, 'my_channel');
  assert.equal(link.messageId, 900);
  assert.equal(link.commentId, 17);
  // Комментарии живут в группе обсуждения — форма уже не двусмысленна.
  assert.equal(link.ambiguous, false);
});

test('хвосты ?single и ?t= разбор не ломают и в ключ не идут', () => {
  assert.equal(one('https://t.me/c/1234567890/42?single').messageId, 42);
  assert.equal(one('https://t.me/cockpit_bugs/1287?t=1m30s').messageId, 1287);
  // Тот же адрес с разными косметическими хвостами — одна ссылка, не три.
  const links = parseTelegramLinks([
    'https://t.me/c/1234567890/42',
    'https://t.me/c/1234567890/42?single',
    'https://t.me/c/1234567890/42?t=15',
  ].join('\n'));
  assert.equal(links.length, 1);
});

test('?thread= — та же тема форума, что и сегментом пути', () => {
  const bySegment = one('https://t.me/c/1234567890/7/42');
  const byQuery = one('https://t.me/c/1234567890/42?thread=7');
  assert.equal(byQuery.threadId, 7);
  assert.equal(byQuery.messageId, 42);
  assert.equal(byQuery.key, bySegment.key);
});

test('несколько ссылок в одном тексте; дубли схлопываются', () => {
  const links = parseTelegramLinks([
    'Первое: https://t.me/c/1234567890/42',
    'Второе: t.me/cockpit_bugs/12/1287 (без схемы)',
    'Ещё раз первое: https://t.me/c/1234567890/42?single',
  ].join('\n'));
  assert.equal(links.length, 2);
  assert.deepEqual(links.map((l) => l.messageId), [42, 1287]);
});

test('чужие домены и служебные пути игнорируются', () => {
  const text = [
    'https://example.com/t.me/cockpit_bugs/1287',
    'https://nott.me/cockpit_bugs/1287',
    'https://t.me/joinchat/AAAAAEyDvBGtq0j4mIz2xQ',
    'https://t.me/+AbCdEfGhIjKl',
    'https://t.me/addstickers/CockpitPack',
    'https://t.me/cockpit_bugs',           // чат без сообщения — раскрывать нечего
    'https://t.me/c/1234567890',            // то же для приватного
  ].join('\n');
  assert.deepEqual(parseTelegramLinks(text), []);
});

test('ссылка внутри блока кода ссылкой не считается', () => {
  const fenced = ['Пример вызова:', '```', 'curl https://t.me/c/1234567890/42', '```'].join('\n');
  assert.deepEqual(parseTelegramLinks(fenced), []);
  assert.deepEqual(parseTelegramLinks('в строке `https://t.me/cockpit_bugs/1287` только пример'), []);
  // Код рядом с настоящей ссылкой её не глушит.
  const mixed = `${fenced}\nа обсуждение тут: https://t.me/cockpit_bugs/1287`;
  assert.deepEqual(parseTelegramLinks(mixed).map((l) => l.messageId), [1287]);
});

test('знаки препинания и скобки в конец ссылки не попадают', () => {
  assert.equal(one('см. (https://t.me/c/1234567890/42).').raw, 'https://t.me/c/1234567890/42');
  assert.equal(one('тут: https://t.me/cockpit_bugs/1287, дальше текст').messageId, 1287);
});

test('мусор на входе не роняет разбор', () => {
  for (const bad of [null, undefined, '', 42, {}, 'https://t.me/c/абв/42', 'https://t.me/ab/1']) {
    assert.deepEqual(parseTelegramLinks(bad), [], String(bad));
  }
});

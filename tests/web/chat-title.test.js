import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyGeneratedChatTitle,
  chatTitleFromMessage,
  firstMessageTitle,
  provisionalChatTitle,
  shouldRequestChatTitle,
} from '../../web/src/shared/chatTitle.ts';

test('первый запрос даёт название из трёх значимых слов', () => {
  assert.equal(
    chatTitleFromMessage('Пожалуйста, добавь автоматическое название чата по первому запросу'),
    'Автоматическое название чата',
  );
  assert.equal(
    chatTitleFromMessage('Please implement OAuth callback race protection'),
    'OAuth callback race',
  );
});

test('технологии и имена файлов не разваливаются на несколько слов', () => {
  assert.equal(
    chatTitleFromMessage('Исправь C++ parser в web/src/parser.cpp'),
    'C++ parser web/src/parser.cpp',
  );
  assert.equal(chatTitleFromMessage('Docker compose'), 'Docker compose');
});

test('автоназвание не перетирает ручное имя или уже начатый чат', () => {
  assert.equal(shouldRequestChatTitle({ title: '', messages: [] }), true);
  assert.equal(firstMessageTitle(
    { title: 'Ручное название чата', messages: [] },
    'Добавь экспорт отчёта',
  ), '');
  assert.equal(firstMessageTitle(
    { title: '', messages: [{ role: 'user', text: 'Первый запрос' }] },
    'Второй запрос',
  ), '');
});

test('семантическое имя заменяет только временный заголовок', () => {
  const provisional = provisionalChatTitle('Добавь автоматическое название чата');
  const session = { title: provisional };
  assert.equal(applyGeneratedChatTitle(session, 'Автоназвание Чатов Запросом', provisional), true);
  assert.equal(session.title, 'Автоназвание Чатов Запросом');

  session.title = 'Моё ручное название';
  assert.equal(applyGeneratedChatTitle(session, 'Другое Имя Чата', provisional), false);
  assert.equal(session.title, 'Моё ручное название');
});

test('чат только с вложением получает понятное имя', () => {
  assert.equal(firstMessageTitle(
    { title: '', messages: [] },
    '',
    [{ name: 'screen.png' }],
  ), 'Чат с вложением');
});

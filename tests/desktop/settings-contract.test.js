import assert from 'node:assert/strict';
import test from 'node:test';

import {
  settingsWindowUrl,
  isSettingsWindowRequest,
  desktopUserAgent,
  desktopWindowRole,
  desktopDocumentMode,
  validTerminalInsert,
  validChatKey,
  decodeSettingsWindowMessage,
} from '../../shared/desktop/desktopWindowContract.ts';

const origin = 'http://127.0.0.1:8140';
const mainUa = 'Electron CockpitSettings/1 CockpitWindow/main';
const settingsUa = 'Electron CockpitSettings/1 CockpitWindow/settings';

test('SW-C01 точный адрес окна', () => {
  assert.equal(settingsWindowUrl(origin), origin + '/?window=settings#/settings');
  assert.equal(isSettingsWindowRequest(settingsWindowUrl(origin), origin), true);
  assert.equal(isSettingsWindowRequest(
    'http://127.0.0.1:80/?window=settings#/settings', 'http://127.0.0.1',
  ), true);
});

test('SW-C02 похожие адреса не открывают окно', () => {
  for (const target of [
    'http://127.0.0.1:9000/?window=settings#/settings',
    'https://127.0.0.1:8140/?window=settings#/settings',
    'http://user:pass@127.0.0.1:8140/?window=settings#/settings',
    origin + '/?window=settings&x=1#/settings',
    origin + '/?window=main#/settings',
    origin + '/x?window=settings#/settings',
    origin + '/?window=settings#/settings/x',
    origin + '/?window=settings',
    'blob:' + origin + '/?window=settings#/settings',
    'data:text/html,settings',
    'file:///settings',
    'не URL',
  ]) {
    assert.equal(isSettingsWindowRequest(target, origin), false, target);
  }
});

test('SW-C03 один комплект маркеров', () => {
  const first = desktopUserAgent('Mozilla Electron', 'main');
  const second = desktopUserAgent(first, 'settings');

  assert.equal(first, 'Mozilla Electron CockpitSettings/1 CockpitWindow/main');
  assert.equal(second, 'Mozilla Electron CockpitSettings/1 CockpitWindow/settings');
  assert.equal(desktopWindowRole(second), 'settings');
});

test('SW-C04 роль только из полного комплекта', () => {
  assert.equal(desktopWindowRole(mainUa), 'main');

  for (const value of [
    '', 'Electron', 'CockpitSettings/2 CockpitWindow/main',
    'CockpitSettings/1 CockpitWindow/auxiliary', 'CockpitSettings/1',
    mainUa + ' CockpitSettings/1', mainUa + ' CockpitWindow/settings',
    'XCockpitSettings/1 CockpitWindow/main',
  ]) {
    assert.equal(desktopWindowRole(value), null, value);
  }
});

test('SW-C05 режим документа', () => {
  assert.equal(desktopDocumentMode(mainUa, ''), 'main');
  assert.equal(desktopDocumentMode(settingsUa, '?window=settings'), 'settings');
  assert.equal(desktopDocumentMode(settingsUa, ''), 'page');
  assert.equal(desktopDocumentMode(settingsUa, '?window=settings&x=1'), 'page');
  assert.equal(desktopDocumentMode('Electron', '?window=settings'), 'page');
});

test('SW-C06 строка терминала и ключ чата', () => {
  assert.equal(validTerminalInsert('npm install example'), true);
  assert.equal(validTerminalInsert('a'.repeat(16384)), true);

  for (const value of ['', null, 1, 'a'.repeat(16385), 'я'.repeat(8193),
    '\n', '\r', '\t', '\u0000', '\u001b', '\u007f']) {
    assert.equal(validTerminalInsert(value), false);
  }

  assert.equal(validChatKey('a'.repeat(128)), true);

  for (const value of ['', 1, 'a'.repeat(129), 'a\nb', '\u007f']) {
    assert.equal(validChatKey(value), false);
  }
});

test('SW-C07 строгий декодер', () => {
  const messages = [
    { version: 1, type: 'settings-changed' },
    {
      version: 1,
      type: 'terminal-request',
      requestId: 'r_1',
      insert: 'npm install example'
    },
    {
      version: 1,
      type: 'open-chat-request',
      requestId: 'r-2',
      chatKey: 'chat'
    },
    {
      version: 1,
      type: 'intent-result',
      requestId: 'r3',
      ok: true
    },
  ];

  for (const message of messages) {
    const decoded = decodeSettingsWindowMessage(message);

    assert.deepEqual(decoded, message);
    assert.equal(decoded === message, false);
    assert.equal(decodeSettingsWindowMessage({ ...message, extra: true }), null);
    assert.equal(decodeSettingsWindowMessage({ ...message, version: 2 }), null);
  }

  for (const value of [null, [], 'message', {}, { version: 1, type: 'other' },
    {
      version: 1,
      type: 'terminal-request',
      requestId: 'x'
    },
    ...['', 'a'.repeat(65), 'bad!'].map((requestId) => ({ ...messages[2], requestId })),
    { ...messages[2], insert: '\n' }, { ...messages[3], chatKey: '' },
    { ...messages[4], ok: 'true' }]) {
    assert.equal(decodeSettingsWindowMessage(value), null);
  }
});

test('настройки сохраняют версию интерфейса главного окна', () => {
  const root = origin + '/ui/' + 'a'.repeat(64) + '/';
  const target = root + '?window=settings#/settings';

  assert.equal(settingsWindowUrl(root + '#/chats'), target);
  assert.equal(isSettingsWindowRequest(target, origin), true);
  assert.equal(isSettingsWindowRequest(origin + '/ui/invalid/?window=settings#/settings', origin), false);
  assert.equal(decodeSettingsWindowMessage({ version: 1, type: 'reload-main' }), null);
});

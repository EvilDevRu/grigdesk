import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isSettingsWindowRequest,
  desktopUserAgent,
  desktopWindowRole,
  desktopDocumentMode,
  validTerminalInsert,
  validChatKey,
} from '../../shared/desktop/desktopWindowContract.ts';

const origin = 'http://127.0.0.1:8140';
const mainUa = 'Electron GrigDeskSettings/1 GrigDeskWindow/main';
const settingsUa = 'Electron GrigDeskSettings/1 GrigDeskWindow/settings';

test('SW-C01 точный адрес окна', () => {
  assert.equal(isSettingsWindowRequest(origin + '/?window=settings#/settings', origin), true);
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
  const second = desktopUserAgent(first, 'main');

  assert.equal(first, 'Mozilla Electron GrigDeskSettings/1 GrigDeskWindow/main');
  assert.equal(second, first);
  assert.equal(desktopWindowRole(second), 'main');
});

test('SW-C04 роль только из полного комплекта', () => {
  assert.equal(desktopWindowRole(mainUa), 'main');

  for (const value of [
    '', 'Electron', 'GrigDeskSettings/2 GrigDeskWindow/main',
    'GrigDeskSettings/1 GrigDeskWindow/auxiliary', 'GrigDeskSettings/1',
    mainUa + ' GrigDeskSettings/1', mainUa + ' GrigDeskWindow/settings',
    'XGrigDeskSettings/1 GrigDeskWindow/main',
  ]) {
    assert.equal(desktopWindowRole(value), null, value);
  }
});

test('SW-C05 режим документа', () => {
  assert.equal(desktopDocumentMode(mainUa, ''), 'main');
  assert.equal(desktopDocumentMode(settingsUa, '?window=settings'), 'page');
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

test('настройки сохраняют версию интерфейса главного окна', () => {
  const root = origin + '/ui/' + 'a'.repeat(64) + '/';
  const target = origin + '/?window=settings#/settings';

  assert.equal(isSettingsWindowRequest(target, origin), true);
  assert.equal(isSettingsWindowRequest(root + '?window=settings#/settings', origin), false);
  assert.equal(isSettingsWindowRequest(origin + '/ui/invalid/?window=settings#/settings', origin), false);
});

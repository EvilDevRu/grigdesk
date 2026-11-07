import assert from 'node:assert/strict';
import test from 'node:test';

import { readClientConfig } from '../../server/src/lib/clientAccess/config.ts';

test('клиентский вход: пустая настройка не открывает сокеты', () => {
  assert.deepEqual(readClientConfig({}), {
    state: 'disabled',
    addresses: [],
    address: null,
    reason: null,
  });
});

test('клиентский вход: IPv4-слушатели и адрес для привязки разбираются отдельно', () => {
  const config = readClientConfig({
    GRIGDESK_CLIENT_LISTEN: ' 127.0.0.1:47110, 0.0.0.0:443 ',
    GRIGDESK_CLIENT_ADDRESS: ' machine.example:65535 ',
  });

  assert.deepEqual(config, {
    state: 'configured',
    addresses: [
      { host: '127.0.0.1', port: 47110 },
      { host: '0.0.0.0', port: 443 },
    ],
    address: 'machine.example:65535',
    reason: null,
  });
  assert.equal(readClientConfig({ GRIGDESK_CLIENT_LISTEN: '127.0.0.1:1' }).state, 'configured');
  assert.equal(readClientConfig({ GRIGDESK_CLIENT_ADDRESS: '192.0.2.1:8443' }).address, '192.0.2.1:8443');
  assert.equal(readClientConfig({ GRIGDESK_CLIENT_ADDRESS: `${'a'.repeat(253)}:443` }).state, 'disabled');
});

test('клиентский вход: неверные listen/address возвращают error без исключения', () => {
  for (const value of [
    'localhost:443', '::1:443', '[::1]:443', '256.0.0.1:443', '127.0.0.1',
    '127.0.0.1:0', '127.0.0.1:65536', '127.0.0.1:-1', '127.0.0.1:1.5',
    '127.0.0.1:443,', ',127.0.0.1:443', 'https://127.0.0.1:443',
  ]) {
    const config = readClientConfig({ GRIGDESK_CLIENT_LISTEN: value });

    assert.equal(config.state, 'error', value);
    assert.deepEqual(config.addresses, [], value);
    assert.ok(config.reason.includes('GRIGDESK_CLIENT_LISTEN'), value);
  }

  for (const value of [
    '[::1]:443', 'machine:0', 'machine:65536', 'http://machine:443', 'machine/path:443',
    'machine_name:443', 'MACHINE:443', `${'a'.repeat(254)}:443`, 'machine:443:444',
  ]) {
    const config = readClientConfig({
      GRIGDESK_CLIENT_LISTEN: '127.0.0.1:443',
      GRIGDESK_CLIENT_ADDRESS: value,
    });

    assert.equal(config.state, 'error', value);
    assert.deepEqual(config.addresses, [], value);
    assert.ok(config.reason.includes('GRIGDESK_CLIENT_ADDRESS'), value);
  }
});


test('S7: пример окружения описывает явный TLS-вход и имя машины', async () => {
  const { readFile } = await import('node:fs/promises');
  const text = await readFile(new URL('../../.env.example', import.meta.url), 'utf8');

  for (const key of ['GRIGDESK_CLIENT_LISTEN', 'GRIGDESK_CLIENT_ADDRESS', 'GRIGDESK_SERVER_NAME']) {
    assert.match(text, new RegExp('^# ' + key + '=', 'm'));
  }

  assert.doesNotMatch(text, /Неизменяемые версии интерфейса из AppImage/);
});

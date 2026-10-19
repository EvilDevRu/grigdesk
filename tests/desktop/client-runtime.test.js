import assert from 'node:assert/strict';
import { once } from 'node:events';
import { access } from 'node:fs/promises';
import net from 'node:net';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { clientUiDirectory } from '../../desktop/src/clientUi.ts';
import { createClientRuntime } from '../../desktop/src/clientRuntime.ts';
import { temporary } from '../relay/helpers.js';

test('D7: готовый пакет игнорирует dev-подмену интерфейса', () => {
  const options = {
    packaged: true,
    resources: '/package/resources',
    source: '/dev/dist',
    override: '/other'
  };

  assert.equal(clientUiDirectory(options), '/package/resources/ui');
  assert.equal(clientUiDirectory({ ...options, packaged: false }), '/other');
});

test('D8: отменённый во время чтения ключа upgrade закрывает сокет окна', async (t) => {
  const root = await temporary(t);
  const identity = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const profile = {
    id: 'fixture',
    name: 'Фикстура',
    kind: 'remote',
    address: 'https://machine.example:443',
    fp: '1'.repeat(64),
    port: 47183,
    createdAt: 0
  };
  const runtime = createClientRuntime({
    settings: {
      version: 2,
      profiles: [profile],
      selected: profile.id,
      window: {
        width: 900,
        height: 700,
        maximized: false
      }
    },
    save: async () => {},
    uiDir: root,
    secret: 'fixture-secret',
    identity: { load: () => {
      entered.resolve();

      return identity.promise;
    } },
    identityDirectory: root,
    localAvailable: () => false,
    localAddress: () => '',
    windowKey: async () => '',
    onOrigin: () => {},
    navigate: async () => {},

  });

  t.after(() => runtime.close());

  const origin = await runtime.start();

  await entered.promise;

  const socket = net.connect(Number(new URL(origin).port), '127.0.0.1');

  socket.on('error', () => {});
  t.after(() => socket.destroy());
  await once(socket, 'connect');

  const closed = new Promise((resolve) => socket.once('close', () => resolve(true)));

  socket.write(`GET /api/ws HTTP/1.1\r\nHost: ${new URL(origin).host}\r\n`
    + 'Cookie: grigdesk_pipe=fixture-secret\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  await delay(30);
  runtime.shell.disconnect(profile.id);
  identity.resolve(undefined);
  assert.equal(await Promise.race([closed, delay(500).then(() => false)]), true);
});

test('D9: снятые экраны прежнего серверного UI не остаются в рабочем комплекте', async () => {
  for (const name of ['offline.ts', 'accessUnavailable.ts', 'storageProtection.ts']) {
    assert.equal(await access(new URL(`../../desktop/src/${name}`, import.meta.url))
      .then(() => true, () => false), false, name);
  }
});

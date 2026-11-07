import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseArgs } from '../../cli/args.ts';
import { renderTerminalQr } from '../../cli/terminalQr.ts';
import { AuthStore } from '../../server/src/lib/authStore.ts';
import authModule from '../../server/src/modules/auth/index.ts';
import devicesModule from '../../server/src/modules/devices/index.ts';
import authPlugin from '../../server/src/plugins/auth.ts';
import { DeviceStore } from '../../server/src/lib/mobile/store.ts';
import { PairingCodes } from '../../server/src/lib/mobile/pairing.ts';
import { completed } from './helpers/sandbox.mts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');
const entry = fileURLToPath(new URL('../../cli/main.ts', import.meta.url));

/**
 * Отдельный Fastify выдаёт настоящую сессию по синтетическому ключу окна.
 * Дочерняя команда получает только тестовый порт и пути и не вызывает системные службы.
 */
async function commandFixture(t: TestContext, disabled = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-device-cli-'));
  const devices = new DeviceStore(root);
  const pairing = new PairingCodes({ devices });
  const authStore = new AuthStore({
    legacyAccountPath: path.join(root, 'account.json'),
    sessionsPath: path.join(root, 'sessions.json'),
  });
  const app = Fastify();
  const windowAuth = { key: 'x'.repeat(43), origin: '' };
  const keyFile = path.join(root, 'window-key');
  const tokens: unknown[] = [];

  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(keyFile, windowAuth.key, { mode: 0o600 });
  app.addHook('onRequest', async (request: { headers: Record<string, unknown> }) => {
    tokens.push(request.headers['x-grigdesk-token']);
  });
  await app.register(authPlugin, { authStore });
  await app.register(authModule, { authStore, windowAuth });
  await app.register(devicesModule, {
    devices,
    pairing,
    identity: () => ({ fp: 'a'.repeat(64) }),
    name: 'Стенд',
    address: 'machine.example:443',
    listener: () => ({
      state: () => ({
        state: disabled ? 'disabled' : 'online',
        addresses: ['127.0.0.1:8443'],
        error: null,
      }),
      disconnect() {
      },
      async close() {
      },
    }),
    disconnectMobile() {
    },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });

  const port = app.server.address().port;

  windowAuth.origin = `http://127.0.0.1:${port}`;

  return {
    tokens,
    devices,
    run: (args: string[], extra: Record<string, string> = {}) => completed(spawn(process.execPath,
      [entry, ...args], {
        env: {
          PATH: process.env.PATH,
          HOME: root,
          GRIGDESK_HOME: path.join(root, 'data'),
          GRIGDESK_ENV_FILE: path.join(root, 'env'),
          GRIGDESK_PORT: String(port),
          GRIGDESK_WINDOW_KEY_PATH: keyFile,
          ...extra,
        },
      })),
  };
}

test('device: разбор add/list/revoke и справка без эффектов', () => {
  assert.equal(parseArgs(['device', 'add', 'Ноутбук', '--address', 'machine:443', '--json']).kind, 'device');
  assert.equal(parseArgs(['device', 'list', '--json']).kind, 'device');
  assert.equal(parseArgs(['device', 'revoke', 'd12345678']).kind, 'device');
  assert.equal(parseArgs(['device', '--help']).kind, 'help');

  for (const argv of [
    ['device'], ['device', 'add'], ['device', 'revoke'], ['device', 'list', 'лишнее'],
    ['device', 'list', '--address', 'x'], ['device', 'add', 'x', '--address'],
  ]) {
    assert.throws(() => parseArgs(argv), /grigdesk-ctl|Укажите/);
  }
});

test('device: QR 3×3 даёт точные полублоки и поле 4 модуля', () => {
  const text = renderTerminalQr(['101', '010', '111']);
  const lines = text.trimEnd().split('\n');

  assert.equal(text, [
    '           ',
    '           ',
    '    ▀▄▀    ',
    '    ▀▀▀    ',
    '           ',
    '           ',
    '',
  ].join('\n'));
  assert.equal(text.split('\n').slice(0, -1).every((line) => line.length === 11), true);
  assert.ok(lines.length >= 4);
  assert.match(renderTerminalQr(['1'], true), /\x1b\[30;47m/);
});

test('device: команда выдаёт QR/строку, JSON, список и отзыв без CLI-токена', async (t) => {
  const f = await commandFixture(t);
  const added = await f.run(['device', 'add', 'Ноутбук']);

  assert.equal(added.code, 0, added.stderr);
  assert.match(added.stdout, /GRIGDESK:PAIR:1:/);
  assert.match(added.stdout, /Действует 10 минут, один раз/);
  assert.match(added.stdout, /[▀▄█]/);
  assert.doesNotMatch(added.stdout, /\x1b/);

  const json = await f.run(['device', 'add', 'Ноутбук', '--json']);

  assert.equal(json.code, 0, json.stderr);
  assert.ok(JSON.parse(json.stdout).text.startsWith('GRIGDESK:PAIR:1:'));

  const device = await f.devices.add({
    name: 'Ноутбук',
    fp: 'b'.repeat(64),
    scope: 'client',
  });
  const list = await f.run(['device', 'list', '--json']);

  assert.equal(list.code, 0, list.stderr);
  assert.equal(JSON.parse(list.stdout).devices[0].id, device.id);
  assert.equal((await f.run(['device', 'revoke', device.id])).code, 0);
  assert.equal(f.tokens.every((token) => token === undefined), true);
});

test('device: ошибки дают код 1 и русскую подсказку, разбор — код 2', async (t) => {
  const f = await commandFixture(t);
  const missing = await f.run(['device', 'list'], { GRIGDESK_WINDOW_KEY_PATH: '/missing-test-window-key' });

  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /Нет ключа окна: команда работает на машине с запущенным сервером/);
  assert.equal((await f.run(['device', 'add'])).code, 2);

  const off = await commandFixture(t, true);
  const response = await off.run(['device', 'add', 'Ноутбук']);

  assert.equal(response.code, 1);
  assert.match(response.stderr, /GRIGDESK_CLIENT_LISTEN/);
});

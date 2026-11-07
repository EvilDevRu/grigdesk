import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { createPinia } from '../../web/node_modules/pinia/dist/pinia.mjs';
import { useShellStore } from '../../web/src/stores/shell.ts';
import { normalizeSettings } from '../../desktop/src/settings.ts';
import { Profiles } from '../../desktop/src/profiles.ts';
import { createShellApi } from '../../desktop/src/pipe/shellApi.ts';

test('настоящий long-poll доставляет несовместимость в Pinia после online', async (t) => {
  const settings = normalizeSettings({
    version: 1,
    connection: { kind: 'local', origin: 'http://127.0.0.1:12345' },
  });
  const profiles = new Profiles({
    settings,
    save: async () => {},
    available: async () => true,
  });
  const shell = createShellApi({
    profiles,
    localAvailable: () => false,
    localAddress: () => '',
    navigate: async () => {},
    pairing: { addByPairing: async () => {} },
    upstream: () => {
      throw new Error('not used');
    },
  });
  const server = http.createServer((req, res) => shell.handle(req, res));
  const store = useShellStore(createPinia());

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    store.stop();
    shell.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const origin = `http://127.0.0.1:${server.address().port}`;
  const fetchOriginal = globalThis.fetch;

  t.mock.method(globalThis, 'fetch', (url, options) => fetchOriginal(origin + url, options));
  shell.report('local', {
    status: 'online',
    detail: null,
    serverApi: { major: 0, minor: 1 },
  });
  await store.start();
  assert.equal(store.status, 'online');
  await new Promise((resolve) => setTimeout(resolve, 30));
  shell.report('local', {
    status: 'incompatible',
    detail: { code: 'client_upgrade_required' },
    serverApi: { major: 1, minor: 0 },
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(store.status, 'incompatible');
});

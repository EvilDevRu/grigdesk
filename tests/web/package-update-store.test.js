import assert from 'node:assert/strict';
import test from 'node:test';

import { compileModule, webFile } from './helpers/compile-vue.js';

const API_STUB = [
  'const harness = globalThis.__packageUpdateHarness;',
  'harness.calls = [];',
  'export const api = {',
  '  get: async () => ({ updateCapability: { kind: \'package\', message: \'x\' }, job: null }),',
  '  post: async (url, body) => {',
  '    harness.calls.push({ url, body });',
  '    if (url === \'/api/system/version/check\') {',
  '      return { updateCapability: { kind: \'package\', message: \'x\' }, job: null,',
  '        updateAvailable: true,',
  '        packageUpdate: { version: \'0.3.0\', archiveSha256: \'b\'.repeat(64) } };',
  '    }',
  '    if (url === \'/api/system/package-update\') {',
  '      return { ok: true, job: { id: \'j1\', kind: \'package-update\',',
  '        status: \'downloading\', stage: \'downloading\',',
  '        progress: { downloadedBytes: 50, totalBytes: 100 } } };',
  '    }',
  '    throw new Error(\'unexpected \' + url);',
  '  },',
  '};',
  'export const failureText = () => \'ошибка сети\';',
].join('\n');

test('PUS-1: installPackage шлёт подтверждённую версию; packageProgress считает проценты',
  async (t) => {
    globalThis.__packageUpdateHarness = { calls: [] };

    const storeModule = await compileModule(webFile('src/stores/grigdeskUpdate.ts'), {
      stubs: { '../shared/apiClient.ts': API_STUB },
    });
    const piniaModule = await import('../../web/node_modules/pinia/dist/pinia.mjs');

    piniaModule.setActivePinia(piniaModule.createPinia());

    const store = storeModule.useGrigDeskUpdateStore();

    t.after(() => {
      return store.stop();
    });

    await store.check();
    assert.equal(store.status?.updateAvailable, true);

    const job = await store.installPackage();

    assert.equal(job?.status, 'downloading');
    assert.deepEqual(globalThis.__packageUpdateHarness.calls.at(-1), {
      url: '/api/system/package-update',
      body: {
        expectedVersion: '0.3.0',
        expectedArchiveSha256: 'b'.repeat(64)
      },
    });
    assert.equal(store.packageProgress, 50);
    assert.equal(store.active, true);
  });

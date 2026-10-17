process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test from 'node:test';
import { compileModule, webFile } from './helpers/compile-vue.js';
import { LIBRARY_ID, stateDto } from './helpers/studio3d-fixtures.js';
import { api as sharedApi } from '../../web/src/shared/apiClient.ts';

const TRANSPORT = `export const api = {}; export class ApiError extends Error {
constructor(message, status, data) { super(message); this.status=status; this.data=data; } }
globalThis.__studioTransportError=ApiError;`;

test('WA-01 все ручки имеют правильный method/path/body и единый HTTP отказ', async () => {
  const module = await compileModule(webFile('src/features/studio3d/studio3dApi.ts'), {
    stubs: { '../../shared/apiClient.ts': TRANSPORT },
  });
  const calls = [];
  const transport = Object.fromEntries(['get', 'post', 'patch', 'del', 'postBytes', 'getBlob', 'upload']
    .map((method) => [method, async (...args) => {
      calls.push({ method, args });
      
      throw new globalThis.__studioTransportError('fixture', 409, { error: 'fixture_conflict',
        message: 'fixture' });
    }]));
  const api = module.createStudio3dApi(transport);
  const body = { libraryId: LIBRARY_ID };
  const cases = [
    ['state', [], 'get', '/state'],
    ['models', [{ q: 'куб', project: 'demo' }], 'get', '/models?q=%D0%BA%D1%83%D0%B1&project=demo'],
    ['model', ['demo'], 'get', '/models/demo'],
    ['patchModel', ['demo', body], 'patch', '/models/demo'],
    ['createModel', [body], 'post', '/models'],
    ['deleteModel', ['demo', LIBRARY_ID], 'del', `/models/demo?libraryId=${LIBRARY_ID}`],
    ['deleteVersion', ['demo', 'v01-model', LIBRARY_ID], 'del',
      `/models/demo/versions/v01-model?libraryId=${LIBRARY_ID}`],
    ...['lighten', 'redownload', 'retry', 'save'].map((name) => [name, ['demo', 'v01-model', body],
      'post', `/models/demo/versions/v01-model/${name}`]),
    ['preview', ['demo', 'v01-model', LIBRARY_ID, new Blob(['fixture'], { type: 'image/webp' })],
      'postBytes', `/models/demo/versions/v01-model/preview?libraryId=${LIBRARY_ID}`],
    ['fromFile', ['demo', body], 'post', '/models/demo/versions/from-file'],
    ['file', ['demo', 'v01-model', 'model.glb'], 'getBlob', '/files/demo/v01-model/model.glb'],
    ...['offers', 'quote', 'run'].map((name) => [name, [body], 'post', `/${name}`]),
    ['job', ['intent', LIBRARY_ID], 'get', `/jobs/intent?libraryId=${LIBRARY_ID}`],
    ['reconcile', ['intent', 'child', body], 'post', '/jobs/intent/children/child/reconcile'],
    ['closeUnknown', ['intent', 'child', body], 'post', '/jobs/intent/children/child/close-unknown'],
    ['batchQuote', [body], 'post', '/batches/quote'], ['batchRun', [body], 'post', '/batches/run'],
    ['upload', [LIBRARY_ID, new File(['fixture'], 'fixture.glb')], 'upload', '/uploads'],
    ['tasks', [true], 'get', '/tasks?refresh=1'],
    ['importTask', ['tripo', 'task', LIBRARY_ID], 'post', '/tasks/tripo/task/import'],
    ['scan', [LIBRARY_ID], 'post', '/scan'], ['resolve', [body], 'post', '/viewer/resolve'],
    ['viewerFile', ['token', 'model.glb'], 'getBlob', '/viewer/file/token/model.glb'],
  ];

  for (const [name, args, method, path] of cases) {
    await assert.rejects(api[name](...args), (error) => error instanceof module.Studio3dApiError
      && error.status === 409 && error.code === 'fixture_conflict', name);
    assert.equal(calls.at(-1).method, method, name);
    assert.equal(calls.at(-1).args[0], '/api/studio3d' + path, name);
    
    if (method === 'post' && name !== 'scan' && name !== 'importTask') {
      assert.deepEqual(calls.at(-1).args[1], body, name);
    }
    if (name === 'upload') {
      assert.deepEqual([...calls.at(-1).args[1].keys()], ['libraryId', 'file']);
    }
  }
  
  transport.get = async () => stateDto();
  assert.equal((await api.state()).libraryId, LIBRARY_ID);
  transport.get = async () => ({ ...stateDto(), active: 'wrong' });
  await assert.rejects(api.state(), /Некорректный ответ раздела «3D»/);
});

test('WA-07 consumer abort сохраняет deadline и не повторяет отменённый GET', async (t) => {
  const previousFetch = globalThis.fetch;
  const controller = new AbortController();
  let calls = 0;
  
  globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
    calls += 1;
    
    const signal = options.signal;
    
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    
    if (signal.aborted) {
      reject(signal.reason);
    }
  });
  
  const fallback = setTimeout(() => controller.abort(), 150);
  
  t.after(() => {
    clearTimeout(fallback);
    globalThis.fetch = previousFetch;
  });
  await assert.rejects(sharedApi.get('/api/studio3d/state', {
    retry: false,
    signal: controller.signal,
    timeoutMs: 5
  }), (error) => error.name === 'TimeoutError');
  assert.equal(calls, 1);
});

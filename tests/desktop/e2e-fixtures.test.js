import assert from 'node:assert/strict';
import test from 'node:test';
import { startStub } from './e2e/stub.mjs';

test('D6: fixture redirect передаёт настоящий 302 в main-frame Electron', async (t) => {
  const stub = await startStub();

  t.after(() => stub.close());

  const response = await fetch(stub.address + '/api/redirect', { redirect: 'manual' });

  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), stub.links.redirect);
});

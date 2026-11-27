import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { qwenLiveFingerprint } from '../../server/src/lib/qwen/live.ts';
import { qwenFixture, runInput } from '../helpers/qwenFixture.mjs';

test('Qwen Host: fingerprint меняется от прав и scope, но не от картинок', async (t) => {
  const fixture = await qwenFixture(t);
  const base = runInput(fixture, 'shared-model(openai)', {
    providerSettings: { allowHostAccess: true },
  });
  const first = await qwenLiveFingerprint(base);

  assert.equal(await qwenLiveFingerprint({
    ...base,
    attachmentPaths: [path.join(fixture.root, 'a.png')],
  }), first);
  assert.equal(await qwenLiveFingerprint({ ...base, attachmentsDir: fixture.root }), first);
  assert.notEqual(await qwenLiveFingerprint({ ...base, workToolScopeKey: 'two' }), first);
  assert.notEqual(await qwenLiveFingerprint({
    ...base, providerSettings: { allowHostAccess: false },
  }), first);
  assert.notEqual(await qwenLiveFingerprint({ ...base, permissionMode: 'plan' }), first);
  assert.notEqual(await qwenLiveFingerprint({ ...base, extraDirs: [fixture.root] }), first);
});

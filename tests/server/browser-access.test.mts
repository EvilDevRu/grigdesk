import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserAccess } from '../../server/src/lib/browser/browserAccess.ts';

test('BR13-G: queued click не переживает revoke и новый grant тому же owner', async () => {
  let release = () => {};
  let entered = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let mutations = 0;
  const access = createBrowserAccess({
    generation: () => 1,
    exists: async () => true,
    queue: async (_owner, _input, options) => {
      assert.equal(options.grantEpoch, 1);
      entered();
      await gate;

      if (!await options.authorize()) {
        throw new Error('browser_access_denied');
      }

      mutations += 1;

      return { ok: true };
    },
  });

  access.commitGrant('chat:a', {
    tabId: 'one',
    url: 'http://fixture.test/',
    grantEpoch: 1
  });

  const pending = access.invoke('chat:a', {
    action: 'click',
    tabId: 'one',
    ref: 'e1',
    pageEpoch: 2
  });

  await ready;
  access.revoke('one');
  access.commitGrant('chat:a', {
    tabId: 'one',
    url: 'http://fixture.test/',
    grantEpoch: 3
  });

  const rejected = assert.rejects(pending, /browser_access_denied/u);

  release();
  await rejected;
  assert.equal(mutations, 0);
  await assert.rejects(() => access.invoke('chat:other', { action: 'snapshot', tabId: 'one' }),
    /browser_access_denied/u);
});

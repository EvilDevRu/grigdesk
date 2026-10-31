import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PrefsStore } from '../../server/src/lib/prefsStore.ts';
import { createBrowserRouting } from '../../server/src/lib/browser/browserRouting.ts';

test('BR14-R: transport preference переживает restart и не теряет соседние prefs', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'browser-routing-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  const prefs = new PrefsStore({ prefsPath: path.join(root, 'prefs.json') });
  const routing = createBrowserRouting(prefs);

  assert.equal(routing.mode(), 'legacy');
  routing.set('grigdesk');
  prefs.write({ gitRefreshBeforeRun: false });

  const fresh = createBrowserRouting(new PrefsStore({ prefsPath: path.join(root, 'prefs.json') }));

  assert.equal(fresh.mode(), 'grigdesk');
  assert.equal(prefs.read().gitRefreshBeforeRun, false);
  fresh.set('legacy');
  assert.equal(routing.mode(), 'legacy');
});

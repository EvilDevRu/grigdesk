import assert from 'node:assert/strict';
import test from 'node:test';
import { clientBrowser } from './helpers/client-browser.mjs';

test('W14: два browser-стенда имеют независимые кэши Vite', { timeout: 30000 }, async (t) => {
  const first = await clientBrowser(t);
  const second = await clientBrowser(t);

  assert.notEqual(first.cacheDir, second.cacheDir);
});

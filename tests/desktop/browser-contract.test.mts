import assert from 'node:assert/strict';
import test from 'node:test';
import { browserUrl, normalizeBrowserPreferences } from '../../shared/browser/browserContract.ts';

test('BR01: defaults, независимые настройки и канонический HTTP(S)', () => {
  assert.deepEqual(normalizeBrowserPreferences(null), {
    open: 'external',
    external: 'system',
    agents: false,
  });
  assert.deepEqual(normalizeBrowserPreferences({
    open: 'internal',
    external: 'app:firefox',
    agents: true,
  }), {
    open: 'internal',
    external: 'app:firefox',
    agents: true,
  });
  assert.equal(browserUrl('http://[::1]:5191/a#b'), 'http://[::1]:5191/a#b');

  for (const value of ['javascript:1', 'file:///tmp/a', 'https://u:p@a.test', '//a.test', 'x\n']) {
    assert.throws(() => browserUrl(value));
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeDeepSeekPermissionMode } from '../../server/src/lib/deepseek/toolPermissionPolicy.ts';

test('пустой mode становится default, три известных ID сохраняются', () => {
  for (const value of [undefined, '', 'default', 'auto', 'read-only']) {
    assert.deepEqual(normalizeDeepSeekPermissionMode(value), {
      ok: true, mode: value || 'default',
    });
  }
});

test('неизвестный или нестроковый mode не становится default', () => {
  for (const value of ['plan', 'bypassPermissions', 'AUTO', null, [], {}, 1]) {
    assert.equal(normalizeDeepSeekPermissionMode(value).ok, false);
  }
});

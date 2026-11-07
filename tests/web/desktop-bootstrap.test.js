import assert from 'node:assert/strict';
import test from 'node:test';

import { mountDesktopEntry } from './helpers/desktop-entry.js';

test('bootstrap запускает возможности устройства без регистрации SW и установки PWA', async (t) => {
  const { calls } = await mountDesktopEntry(t);

  assert.deepEqual(calls, ['download', 'back', 'viewport', 'wake', 'notify']);
});

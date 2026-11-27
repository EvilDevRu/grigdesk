import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../', import.meta.url);

test('MV1-ABS: v1-тесты и helpers мобильного пакета отсутствуют', async () => {
  for (const rel of [
    'tests/mobile/client.test.js',
    'tests/mobile/contract.test.js',
    'tests/mobile/independence.test.js',
    'tests/mobile/desktop-link.test.js',
    'tests/mobile/desktop-ui.test.js',
    'tests/mobile/emulator.test.js',
    'tests/mobile/chat-controls.test.js',
    'tests/mobile/chat-presentation.test.js',
    'tests/mobile/ui.test.js',
    'tests/mobile/ui-regressions.test.js',
    'tests/mobile/helpers',
    'tests/mobile/visual/run.mjs',
    'tests/mobile/visual/scenarios.mjs',
    'tests/mobile/visual/tabletFixture.mjs',
    'tests/mobile/visual/tabletInteractions.mjs',
    'tests/mobile/visual/contacts.py',
    'tests/desktop/node-link.test.js',
    'mobile/src',
    'tools/mobile-phone',
  ]) {
    await assert.rejects(() => lstat(new URL(rel, root)), { code: 'ENOENT' }, rel);
  }
});

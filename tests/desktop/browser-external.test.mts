import assert from 'node:assert/strict';
import test from 'node:test';
import { openExternalBrowser } from '../../desktop/src/browser/externalBrowser.ts';

test('BR03: выбранный launcher получает URL одним аргументом и не меняет default ОС', async () => {
  const calls: unknown[] = [];
  const port = {
    system: async (url: string) => {
      calls.push(['system', url]);
    },
    resolve: async (id: string) => id === 'app:ff'
      ? { command: '/usr/bin/gio', args: ['launch', '/fixtures/firefox.desktop'] } : null,
    spawn: async (command: string, args: string[]) => {
      calls.push([command, args]);
    },
  };
  const url = 'http://localhost:5191/?x=$(touch%20/tmp/probe)&y=1';

  await openExternalBrowser(port, 'app:ff', url);
  assert.deepEqual(calls, [['/usr/bin/gio', ['launch', '/fixtures/firefox.desktop', url]]]);
  await assert.rejects(() => openExternalBrowser(port, 'app:missing', url), /browser_app_missing/u);
  assert.equal(calls.length, 1);
  await openExternalBrowser(port, 'system', url);
  assert.deepEqual(calls[1], ['system', url]);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createSettingsActions } from '../../web/src/features/settings/actions.ts';

test('SW-X02/03: действия одного документа не добавляют Enter, отказ остаётся явным', async () => {
  const calls = [];
  const actions = createSettingsActions({
    requestAction: async (run) => run(),
    notify: (message) => calls.push(message),
    openTerminal: async (request) => {
      calls.push(request);

      return true;
    },
    openChat: async () => false,
  });

  assert.equal(await actions.openTerminal('npm install sample'), true);
  assert.deepEqual(calls, [{ insert: 'npm install sample' }]);
  assert.equal(await actions.openTerminal('bad\n'), false);
  assert.equal(await actions.openChat('chat'), false);
});

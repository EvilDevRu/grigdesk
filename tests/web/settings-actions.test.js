import assert from 'node:assert/strict';
import test from 'node:test';
import { installUiBrowser } from './helpers/ui-components.js';
import { compileModule, webFile } from './helpers/compile-vue.js';
import { createSettingsActions } from '../../web/src/features/settings/actions.ts';

test('IN08/09: переход ждёт выбора dirty, не отправляет Enter и сохраняет модал при отказе', async (t) => {
  await installUiBrowser(t);

  const [{ createPinia }, module] = await Promise.all([
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
    compileModule(webFile('src/stores/settings.ts')),
  ]);
  const settings = module.useSettingsStore(createPinia());
  const calls = [];
  const actions = createSettingsActions({
    requestAction: settings.requestAction,
    notify: (message) => calls.push(['error', message]),
    openTerminal: async (target) => {
      calls.push(target);

      return true;
    },
    openChat: async (key) => {
      calls.push(key);

      return false;
    },
  });

  settings.setAuthenticated(true);
  settings.requestOpen();
  settings.registerResource({
    id: 'fixture',
    chain: 'fixture',
    order: 1,
    body: 'patch',
    supportsUnset: false,
    read: async () => ({ enabled: false }),
    validate: () => [],
    write: async () => ({ status: 'success', fields: [{
      key: 'enabled',
      status: 'success',
      serverValue: true,
    }] }),
  }, [{ key: 'enabled', address: { pageId: 'interface.behavior', fieldPath: ['enabled'] } }]);
  await settings.loadResource('fixture');
  settings.setField('fixture', 'enabled', true);

  let transition = actions.openTerminal('echo пример');

  assert.equal(settings.closeChoiceOpen, true);
  assert.deepEqual(calls, []);
  await settings.chooseClose('continue');
  assert.equal(await transition, false);
  transition = actions.openTerminal('echo пример');
  await settings.chooseClose('discard');
  assert.equal(await transition, true);
  assert.deepEqual(calls, [{ insert: 'echo пример' }]);
  settings.requestOpen();
  assert.equal(await actions.openTerminal('echo пример\n'), false);
  assert.equal(settings.isOpen, true);
  assert.equal(await actions.openChat('chat-key'), false);
  assert.equal(settings.isOpen, true);
  settings.dispose();
});

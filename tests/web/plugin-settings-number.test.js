import assert from 'node:assert/strict';
import test from 'node:test';
import { settingsHarness } from './helpers/settings-harness.js';

test('Числовое поле: границы манифеста, число в полном PUT и общий Apply', async (t) => {
  const h = await settingsHarness(t, 'plugins.installed', 'PluginPage', {
    prepare({ plugins }) {
      plugins.list = [{
        id: 'ssh-fixture',
        name: 'SSH',
        enabled: true,
        system: false,
        settings: [{
          key: 'limit',
          label: 'Лимит вывода',
          type: 'number',
          min: 4,
          max: 1024,
          step: 4,
        }],
        values: { limit: 64 },
      }];
    },
  });
  const input = h.wrapper.get('input[type="number"]');

  assert.deepEqual(['min', 'max', 'step'].map((name) => input.attributes(name)), ['4', '1024', '4']);
  await input.setValue('68');
  assert.equal(h.writes().length, 0);
  await h.settings.apply();
  assert.deepEqual(h.writes()[0].body, { values: { limit: 68 }, placements: {} });
});

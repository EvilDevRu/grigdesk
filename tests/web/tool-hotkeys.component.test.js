import assert from 'node:assert/strict';
import test from 'node:test';
import { settingsHarness } from './helpers/settings-harness.js';

test('Клавиши: запись, конфликт, Escape, возврат умолчания и запись только по Apply', async (t) => {
  const h = await settingsHarness(t, 'interface.shortcuts', 'InterfacePage');
  const row = h.wrapper.get('[data-hotkey-tool="terminal"]');
  const hotkeys = h.module.useHotkeysStore();
  const baseline = hotkeys.comboOf('terminal');

  await row.get('[data-record]').trigger('click');
  assert.equal(hotkeys.recording, 'terminal');
  h.browser.dispatchEvent(new h.browser.KeyboardEvent('keydown', {
    key: 'Escape',
    code: 'Escape',
    bubbles: true,
  }));
  assert.equal(hotkeys.recording, null);
  assert.equal(h.settings.snapshot.dirtyCount, 0);
  await row.get('[data-record]').trigger('click');
  h.browser.dispatchEvent(new h.browser.KeyboardEvent('keydown', {
    key: 'w',
    code: 'KeyW',
    ctrlKey: true,
    bubbles: true,
  }));
  await h.flushPromises();
  assert.match(h.wrapper.text(), /браузер|систем/);
  await h.settings.apply();
  assert.equal(hotkeys.comboOf('terminal'), baseline);
  h.settings.discardField('hotkeys', 'overrides');
  await row.findAll('button').find((item) => item.text() === 'Выключить').trigger('click');
  assert.equal(hotkeys.comboOf('terminal'), baseline);
  await h.settings.apply();
  assert.equal(hotkeys.comboOf('terminal'), '');
  await h.flushPromises();
  await row.findAll('button').find((item) => item.text() === 'Вернуть').trigger('click');
  await h.settings.apply();
  assert.equal(hotkeys.comboOf('terminal'), baseline);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { settingsHarness } from './helpers/settings-harness.js';

test('Автопродолжение: значение, общий Apply и явный отказ записи', async (t) => {
  const h = await settingsHarness(t, 'automation.chats', 'PreferencesPage');
  const toggle = h.wrapper.get('[aria-label="Продолжать ход сам после обрыва связи"]');

  assert.equal(toggle.attributes('aria-checked'), 'true');
  await toggle.trigger('click');
  assert.equal(h.writes().length, 0);
  assert.equal(h.control.data.prefs.chatAutoContinue, true);
  h.control.handlers['/api/settings/prefs'] = () =>
    new Response(JSON.stringify({ error: 'Синтетический отказ' }), { status: 500 });
  await h.settings.apply('ok');
  assert.equal(h.settings.isOpen, true);
  assert.equal(h.settings.snapshot.dirtyCount, 1);
  assert.match(h.wrapper.text(), /Синтетический отказ/);
  delete h.control.handlers['/api/settings/prefs'];
  await h.settings.apply();
  assert.equal(h.control.data.prefs.chatAutoContinue, false);
  assert.equal(h.settings.snapshot.dirtyCount, 0);
});

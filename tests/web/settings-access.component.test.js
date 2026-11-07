import assert from 'node:assert/strict';
import test from 'node:test';
import { settingsHarness } from './helpers/settings-harness.js';

test('LO-10/ACCESS-WEB-18: вход по ключу и мобильный доступ без выхода и смены пароля', async (t) => {
  const h = await settingsHarness(t, 'connections.mobile', 'ConnectionsPage', {
    prepare({ control }) {
      control.handlers['/api/mobile/status'] = () => new Response(JSON.stringify(control.data.mobile));
    },
  });
  const help = h.wrapper.findAll('button')
    .find((button) => button.text().includes('Вход на этом компьютере'));

  await help.trigger('click');
  assert.match(h.wrapper.text(), /ключ/);
  assert.match(h.wrapper.text(), /компьютер/);
  assert.doesNotMatch(h.wrapper.text(), /Выйти|Сменить пароль/);
  assert.ok(h.wrapper.find('.mobile-access').exists());
  assert.equal(h.writes().length, 0);
});

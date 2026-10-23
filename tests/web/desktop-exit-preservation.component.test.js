import assert from 'node:assert/strict';
import test from 'node:test';

import { settingsHarness } from './helpers/settings-harness.js';

for (const accepted of [true, false]) {
  test(`RESTART-KEEP: ${accepted ? 'согласие' : 'отмена'} рестарта не останавливает конвейеры`,
    async (t) => {
      let bridgeCalls = 0;
      const h = await settingsHarness(t, 'system.startup', 'SystemPage', {
        /**
         * Доступный desktop-сервер и два активных чата вызывают штатный вопрос рестарта.
         * Все записи остаются в журнале транспорта для проверки отсутствия Stop.
         */
        prepare({ control }) {
          control.answer = accepted;
          control.handlers['/api/system/server'] = () => new Response(JSON.stringify({
            mode: 'desktop',
            managed: true,
            restartSupported: true,
          }));
          control.handlers['/api/chat/active'] = () => new Response(JSON.stringify({
            active: [{ chatKey: 'one' }, { chatKey: 'two' }],
          }));
          control.handlers['/api/system/restart'] = () => new Response(JSON.stringify({ ok: true }));
        },
      });

      h.browser.grigdeskDesktopExit = () => {
        bridgeCalls += 1;
      };
      t.after(() => delete h.browser.grigdeskDesktopExit);

      const restart = h.wrapper.findAll('button')
        .find((button) => button.text() === 'Перезапустить сервер');

      assert.ok(restart, 'Существующая кнопка рестарта доступна');
      await restart.trigger('click');
      await h.flushPromises();

      assert.equal(h.control.confirms.length, 1);
      assert.deepEqual(h.writes().map(({ path, method }) => ({ path, method })), accepted
        ? [{ path: '/api/system/restart', method: 'POST' }] : []);
      assert.equal(h.control.calls.some((call) => /\/tasks\/[^/]+\/stop/.test(call.path)), false);
      assert.equal(bridgeCalls, 0);
    });
}

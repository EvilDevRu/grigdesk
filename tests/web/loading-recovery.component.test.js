import assert from 'node:assert/strict';
import test from 'node:test';

import { settingsHarness } from './helpers/settings-harness.js';

const pages = [
  ['automation.chats', 'PreferencesPage', '/api/settings/prefs'],
  ['speech.advanced', 'SpeechPage', '/api/settings/speech'],
  ['system.processes', 'ProcessesPage', '/api/chat/sessions'],
];

for (const [page, component, endpoint] of pages) {
  test(`ошибка первого чтения ${component} снимает загрузку и не открывает пустую форму`, async (t) => {
    const h = await settingsHarness(t, page, component, {
      prepare({ control }) {
        control.handlers[endpoint] = () => new Response(JSON.stringify({
          error: 'synthetic_read_failed',
        }), { status: 503 });
      },
    });

    assert.equal(h.wrapper.find('[role="alert"]').exists(), true);
    assert.equal(h.wrapper.find('[data-ui-loading]').exists(), false);
    assert.equal(h.wrapper.find('input, select, textarea').exists(), false);
  });
}

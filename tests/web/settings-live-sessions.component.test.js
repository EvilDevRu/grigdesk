import assert from 'node:assert/strict';
import test from 'node:test';
import { settingsHarness } from './helpers/settings-harness.js';

test('Процессы: DTO и подтверждение погашения свободного/занятого без рабочего сервера', async (t) => {
  const h = await settingsHarness(t, 'system.processes', 'ProcessesPage', {
    prepare({ control }) {
      control.handlers['/api/chat/sessions'] = () => new Response(JSON.stringify({
        maxSessions: 4,
        idleMs: 1800000,
        sessions: [{
          chatKey: 'sample',
          chatTitle: 'Разбор',
          executor: 'fixture',
          pid: 123,
          cwd: '/fixture/work',
          running: false,
        }],
      }));
      control.handlers['/api/chat/sessions/sample'] = () => new Response(JSON.stringify({ ok: true }));
    },
  });

  assert.match(h.wrapper.text(), /Разбор/);
  assert.match(h.wrapper.text(), /123/);
  assert.match(h.wrapper.text(), /\/fixture\/work/);
  assert.match(h.wrapper.text(), /Лимит пула — 4/);
  h.control.answer = false;
  await h.wrapper.findAll('button').find((item) => item.text() === 'Погасить').trigger('click');
  assert.equal(h.writes().length, 0);
  h.control.answer = true;
  await h.wrapper.findAll('button').find((item) => item.text() === 'Погасить').trigger('click');
  await h.flushPromises();
  assert.equal(h.writes()[0].method, 'DELETE');
  assert.equal(h.writes()[0].path, '/api/chat/sessions/sample');
});

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
  assert.match(h.wrapper.text(), /Лимит пула\s*4, автогашение через 30 мин простоя/);
  h.control.answer = false;
  await h.wrapper.findAll('button').find((item) => item.text() === 'Погасить').trigger('click');
  assert.equal(h.writes().length, 0);
  h.control.answer = true;
  await h.wrapper.findAll('button').find((item) => item.text() === 'Погасить').trigger('click');
  await h.flushPromises();
  assert.equal(h.writes()[0].method, 'DELETE');
  assert.equal(h.writes()[0].path, '/api/chat/sessions/sample');
});

/**
 * Массовое гашение читает полный ответ сервера: отказ закрытия не выглядит
 * обычным завершением операции, а список обновляется даже при частичном неуспехе.
 */
function bulkCloseHarness(t, bulkResult) {
  let listCalls = 0;

  return settingsHarness(t, 'system.processes', 'ProcessesPage', {
    prepare({ control }) {
      control.handlers['/api/chat/sessions'] = (call) => {
        if (call.method === 'DELETE') {
          return Response.json(bulkResult);
        }

        listCalls += 1;

        return Response.json({
          maxSessions: 4,
          idleMs: 1800000,
          sessions: [{
            chatKey: 'sample',
            chatTitle: 'Разбор',
            executor: 'fixture',
            pid: 123,
            running: false,
          }],
        });
      };
    },
  }).then((h) => ({ h, listCalls: () => listCalls }));
}

test('Процессы: частичный отказ массового гашения виден и список обновляется', async (t) => {
  const { h, listCalls } = await bulkCloseHarness(t, {
    ok: true,
    closed: 1,
    skipped: 0,
    failed: 1,
  });

  await h.wrapper.findAll('button').find((item) => item.text() === 'Погасить свободные').trigger('click');
  await h.flushPromises();

  assert.match(h.wrapper.text(), /Не удалось погасить: 1/);
  assert.doesNotMatch(h.wrapper.text(), /Занятых пропущено/, 'отказ не выглядит обычным завершением');
  assert.ok(listCalls() >= 2, 'список процессов обновлён после операции');
  assert.equal(h.writes()[0].method, 'DELETE');
  assert.equal(h.writes()[0].path, '/api/chat/sessions');
});

test('Процессы: полный отказ массового гашения показывает число отказов', async (t) => {
  const { h, listCalls } = await bulkCloseHarness(t, {
    ok: true,
    closed: 0,
    skipped: 0,
    failed: 2,
  });

  await h.wrapper.findAll('button').find((item) => item.text() === 'Погасить свободные').trigger('click');
  await h.flushPromises();

  assert.match(h.wrapper.text(), /Не удалось погасить процессы: 2/);
  assert.doesNotMatch(h.wrapper.text(), /Занятых пропущено/);
  assert.ok(listCalls() >= 2, 'неподтверждённые процессы остались в списке');
});

test('Процессы: успешное массовое гашение сохраняет обычное сообщение', async (t) => {
  const { h } = await bulkCloseHarness(t, {
    ok: true,
    closed: 2,
    skipped: 1,
    failed: 0,
  });

  await h.wrapper.findAll('button').find((item) => item.text() === 'Погасить свободные').trigger('click');
  await h.flushPromises();

  assert.match(h.wrapper.text(), /Погашено: 2\. Занятых пропущено: 1/);
  assert.doesNotMatch(h.wrapper.text(), /Не удалось погасить/);
});

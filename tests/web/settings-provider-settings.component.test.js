import assert from 'node:assert/strict';
import test from 'node:test';
import { settingsHarness } from './helpers/settings-harness.js';

const risk = 'Агент сможет запускать прямые SSH-клиенты с правами процесса GrigDesk. '
  + 'Режим прав Bash не заменяет этот запрет. Подтверждений и журнала SSH-инструмента не будет.';

test('Запрет SSH: подтверждение при правке, отказ, общий Apply и один диалог', async (t) => {
  const h = await settingsHarness(t, 'agents.providers', 'ProviderPage', {
    entityId: 'fixture',
    prepare({ providers, control }) {
      providers.providers[0].settings = [{
        id: 'blockDirectSsh',
        kind: 'toggle',
        label: 'Запретить прямой SSH',
        value: true,
        confirm: { off: {
          text: risk,
          label: 'Разрешить прямой SSH',
          danger: true,
        } },
      }];
      control.handlers['/api/providers/fixture/settings'] = ({ body }) =>
        new Response(JSON.stringify({ ok: true, value: body.value }));
    },
  });

  h.settings.selectPage('agents.providers', 'fixture', 'parameters');
  await h.flushPromises();

  const toggle = h.wrapper.get('[aria-label="Запретить прямой SSH"]');

  h.control.answer = false;
  await toggle.setValue(false);
  assert.equal(h.settings.snapshot.dirtyCount, 0);
  assert.equal(h.writes().length, 0);
  assert.equal(h.control.confirms[0][0], risk);
  h.control.answer = true;
  await toggle.setValue(false);
  assert.equal(h.writes().length, 0);
  assert.equal(h.settings.snapshot.dirtyCount, 1);
  await h.settings.apply();
  assert.equal(h.writes().length, 1);
  assert.equal(h.writes()[0].body.value, false);
  assert.equal(h.writes()[0].body.confirmed, true);
  await toggle.setValue(true);
  assert.equal(h.control.confirms.length, 2);
});

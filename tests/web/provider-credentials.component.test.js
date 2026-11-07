import assert from 'node:assert/strict';
import test from 'node:test';
import { settingsHarness } from './helpers/settings-harness.js';

test('Ключи: хвост, приватный ввод, отказ сохраняет draft, Apply отправляет только diff', async (t) => {
  const h = await settingsHarness(t, 'agents.providers', 'ProviderPage', {
    entityId: 'fixture',
    prepare({ providers, control }) {
      providers.providers[0].credentials = [
        {
          env: 'ONE',
          kind: 'secret',
          label: 'Первый ключ',
          set: true,
          inFile: true,
          preview: '…cdef',
        },
        {
          env: 'TWO',
          kind: 'secret',
          label: 'Второй ключ',
          set: false,
          inFile: false,
        },
      ];
      control.handlers['/api/providers/fixture/credentials'] = () =>
        new Response(JSON.stringify({ error: 'Отказ ключа' }), { status: 500 });
    },
  });

  h.settings.selectPage('agents.providers', 'fixture', 'access');
  await h.flushPromises();

  const input = h.wrapper.get('[aria-label="Первый ключ"]');

  assert.equal(input.element.value, '');
  assert.match(input.attributes('placeholder'), /cdef/);
  await input.setValue('new-private-key');
  assert.equal(h.writes().length, 0);
  assert.equal(JSON.stringify(h.settings.$state).includes('new-private-key'), false);
  await h.settings.apply();
  assert.equal(h.settings.snapshot.dirtyCount, 1);
  assert.equal(input.element.value, 'new-private-key');
  assert.match(h.wrapper.text(), /Отказ ключа/);
  h.control.handlers['/api/providers/fixture/credentials'] = () =>
    new Response(JSON.stringify({ ok: true }));
  await h.settings.apply();
  assert.deepEqual(h.writes().at(-1).body, { values: { ONE: 'new-private-key' } });
  h.settings.dispose();
  assert.equal(h.settings.getValue('providerCredentials:fixture', 'ONE'), undefined);
});

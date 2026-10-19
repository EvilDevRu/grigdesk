import assert from 'node:assert/strict';
import test from 'node:test';
import catalog from '../fixtures/executor-settings/synthetic-catalog.json' with { type: 'json' };
import { settingsHarness } from './helpers/settings-harness.js';

test('Native editor: типы, вложенность, список, поиск и сохранение через сессию', async (t) => {
  const snapshot = structuredClone(catalog);
  const base = snapshot.fields[0];
  const field = (key, kind, extra = {}) => ({
    ...base,
    id: JSON.stringify([key]),
    path: [key],
    label: key,
    kind,
    base: { state: 'unknown' },
    default: { state: 'unknown' },
    ...extra,
  });

  snapshot.providerId = 'fixture';
  snapshot.fields = [
    field('enabled', 'boolean', { base: { state: 'known', value: true } }),
    field('unknownBoolean', 'boolean'),
    field('count', 'integer', { constraints: { minimum: 0, maximum: 10 } }),
    field('choice', 'enum', { constraints: { enum: ['1', 1, true, null] } }),
    field('group', 'object', { writable: false, children: [field('text', 'string')] }),
    field('list', 'array', { base: { state: 'known', value: [true] }, items: field('item', 'boolean') }),
    field('readonly', 'string', { writable: false }),
  ];

  const h = await settingsHarness(t, 'agents.providers', 'ProviderPage', {
    entityId: 'fixture',
    prepare({ control }) {
      control.handlers['/api/providers/fixture/settings/catalog'] = () =>
        new Response(JSON.stringify(snapshot));
      control.handlers['/api/providers/fixture/settings/overrides'] = ({ body }) => {
        const entry = snapshot.fields.flatMap((item) => item.children ?? [item])
          .find((item) => item.id === body.fieldId);

        entry.override = body.operation === 'set'
          ? { state: 'known', value: body.value } : { state: 'unset' };
        snapshot.revision = String(Number(snapshot.revision) + 1);

        return new Response(JSON.stringify({
          ok: true,
          changed: true,
          catalog: snapshot,
        }));
      };
    },
  });

  h.settings.selectPage('agents.providers', 'fixture', 'parameters');
  await h.flushPromises();
  await h.wrapper.findAll('button')
    .find((item) => item.text().includes('Дополнительные параметры')).trigger('click');
  await h.flushPromises();

  assert.match(h.wrapper.text(), /Для чатов GrigDesk/);
  assert.match(h.wrapper.text(), /Наследуется/);
  assert.doesNotMatch(h.wrapper.text(), /readonly/);
  assert.equal(h.wrapper.get('input[type="number"]').attributes('min'), '0');
  assert.equal(h.wrapper.get('input[type="number"]').attributes('max'), '10');
  await h.wrapper.get('[aria-label="unknownBoolean"]').setValue('1');
  assert.equal(h.wrapper.get('[aria-label="unknownBoolean"]').element.tagName, 'SELECT');
  await h.wrapper.get('[aria-label="enabled"]').setValue(false);
  await h.wrapper.get('input[type="number"]').setValue('3');
  await h.wrapper.get('[aria-label="choice"]').setValue('1');
  await h.wrapper.get('[aria-label="text"]').setValue('вложенный текст');
  assert.equal(h.writes().length, 0);
  assert.equal(h.settings.getValue('providerNative:fixture', '["choice"]'), 1);
  assert.equal(h.settings.getValue('providerNative:fixture', '["enabled"]'), false);
  await h.settings.apply();
  assert.deepEqual(h.writes().map((call) => call.body.revision), ['0', '1', '2', '3', '4']);
  assert.equal(h.settings.snapshot.dirtyCount, 0);
  await h.wrapper.get('[aria-label="Найти дополнительный параметр"]').setValue('list');
  assert.equal(h.wrapper.find('[aria-label="count"]').exists(), false);
  assert.equal(h.wrapper.findAll('button').some((item) => item.text() === 'Добавить элемент'), true);
});

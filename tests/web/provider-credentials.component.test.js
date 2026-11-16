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

/**
 * ACK подтверждает сохранённый выбор даже до обновления фонового реестра.
 * Запоздавший свежий снимок не создаёт ложного конфликта уже принятого поля.
 */
test('Доступ: сохранение выбора переживает холодный снимок каталога', async (t) => {
  for (const previous of [null, 'previous']) {
    await t.test(`Предыдущее значение: ${previous}`, async (scenario) => {
      const credential = {
        env: 'SERVICE',
        kind: 'choice',
        label: 'Сервис API',
        set: previous !== null,
        inFile: previous !== null,
        value: previous,
        options: ['previous', 'international'].map((value) => ({ value, label: value })),
      };
      const saved = {
        ...credential,
        value: 'international',
        set: true,
        inFile: true,
      };
      const h = await settingsHarness(scenario, 'agents.providers', 'ProviderPage', {
        entityId: 'fixture',
        prepare({ providers, control }) {
          providers.providers[0].credentials = [credential];
          control.handlers['/api/providers/fixture/credentials'] = () =>
            Response.json({ ok: true, credentials: [saved] });
          control.handlers['/api/providers/usage'] = () => Response.json({ usage: {} });
        },
      });

      h.settings.selectPage('agents.providers', 'fixture', 'access');
      await h.flushPromises();
      h.settings.setField('providerCredentials:fixture', 'SERVICE', 'international');
      await h.flushPromises();

      assert.match(h.wrapper.get('[data-provider-chat-notice]').text(), /Сохраните подключение/);
      assert.match(h.wrapper.get('[data-provider-chat-notice]').text(),
        /загрузить модели выбранного сервиса/);
      assert.equal(h.wrapper.get('[data-provider-apply-access]').text(), 'Применить');

      const result = await h.settings.apply();

      assert.equal(result.status, 'success');
      assert.equal(h.settings.snapshot.dirtyCount, 0);
      assert.equal(h.settings.getValue('providerCredentials:fixture', 'SERVICE'), 'international');
      h.providers.providers = h.providers.providers.map((entry) => ({ ...entry, credentials: [saved] }));
      await h.flushPromises();
      assert.equal(h.wrapper.find('[data-conflict]').exists(), false);
      assert.equal(h.wrapper.find('[data-provider-apply-access]').exists(), false);
      assert.doesNotMatch(h.wrapper.text(), /Сервер не принял значение/);
      assert.equal(h.writes().length, 1);
    });
  }
});

/**
 * Сбой чтения после успешной записи не разрешает повторно отправить секрет.
 * Окно объясняет следующий шаг отдельно от подтверждённых полей доступа.
 */
test('Доступ: отказ обновления списка не оставляет сохранённый ключ в черновике', async (t) => {
  const choice = {
    env: 'SERVICE',
    kind: 'choice',
    label: 'Сервис',
    set: false,
    inFile: false,
    value: null,
    options: [{ value: 'international', label: 'Международный' }],
  };
  const h = await settingsHarness(t, 'agents.providers', 'ProviderPage', {
    entityId: 'fixture',
    /**
     * Запись подтверждается до независимого отказа чтения списка исполнителей.
     * HTTP использует только синтетические поля и не обращается к ключам владельца.
     */
    prepare({ providers, control }) {
      providers.providers[0].credentials = [choice, {
        env: 'KEY',
        kind: 'secret',
        label: 'Ключ',
        set: false,
        inFile: false,
        value: null,
      }];
      control.handlers['/api/providers/fixture/credentials'] = () => Response.json({
        ok: true,
        credentials: [{
          ...choice,
          value: 'international',
          set: true,
          inFile: true,
        }],
      });
      control.handlers['/api/providers'] = () => Response.json({ error: 'Нет связи' }, { status: 503 });
      control.handlers['/api/providers/usage'] = () => Response.json({ usage: {} });
    },
  });

  h.settings.selectPage('agents.providers', 'fixture', 'access');
  await h.flushPromises();
  h.settings.setField('providerCredentials:fixture', 'SERVICE', 'international');
  h.settings.setField('providerCredentials:fixture', 'KEY', 'synthetic-private-key');

  const result = await h.settings.apply();

  assert.equal(result.status, 'partial');
  assert.equal(result.saved.length, 2);
  assert.equal(h.settings.snapshot.dirtyCount, 0);
  assert.equal(h.settings.getValue('providerCredentials:fixture', 'KEY'), undefined);
  assert.match(result.errors[0].message, /Доступ сохранён.*Перепроверить/);
  assert.equal(JSON.stringify(h.settings.snapshot).includes('synthetic-private-key'), false);
  await h.settings.apply();
  assert.equal(h.writes().length, 1);
});

/**
 * Неполный успешный ответ не доказывает ни принятие значения, ни отказ сервера.
 * Форма сохраняет выбор и объясняет необходимость проверки без ложного обвинения сервера.
 */
test('Доступ: отсутствие подтверждённого выбора объясняется как неизвестный результат', async (t) => {
  const h = await settingsHarness(t, 'agents.providers', 'ProviderPage', {
    entityId: 'fixture',
    prepare({ providers, control }) {
      providers.providers[0].credentials = [{
        env: 'SERVICE',
        kind: 'choice',
        label: 'Сервис',
        value: null,
        set: false,
        options: [{ value: 'international', label: 'Международный' }],
      }];
      control.handlers['/api/providers/fixture/credentials'] = () => Response.json({ ok: true });
      control.handlers['/api/providers/usage'] = () => Response.json({ usage: {} });
    },
  });

  h.settings.selectPage('agents.providers', 'fixture', 'access');
  await h.flushPromises();
  h.settings.setField('providerCredentials:fixture', 'SERVICE', 'international');

  const result = await h.settings.apply();

  assert.equal(result.status, 'unknown');
  assert.equal(h.settings.snapshot.dirtyCount, 1);
  assert.match(result.errors[0].message, /Не удалось подтвердить сохранение/);
  assert.doesNotMatch(h.wrapper.text(), /Сервер не принял значение/);
  assert.equal(h.writes().length, 1);
});

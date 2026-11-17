process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { compileModule, compileVue, webFile } from './helpers/compile-vue.js';
import { createSettingsSession } from '../../web/src/features/settings/session.ts';
import { createUiBrowser } from './helpers/ui-components.js';

let browser;
let component;
let mount;
let flushPromises;
let reactive;

before(async () => {
  browser = await createUiBrowser();
  ({ reactive } = await import('../../web/node_modules/vue/index.mjs'));
  ({ mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  ));
  component = await compileVue(webFile('src/shared/AccessProfileDialog.vue'), {
    expose: ['proceed', 'cancel'],
    stubs: {
      '../stores/accessProfiles.ts': `
        export const useAccessProfilesStore = () => globalThis.__profileDialog.store;
      `,
      '../stores/settings.ts': `
        export const useSettingsStore = () => ({ bindSession() {} });
      `,
      '../features/settings/accessProfileDraft.ts': `
        export const accessProfileDraft = () => globalThis.__profileDialog.draft;
      `,
      './apiClient.ts': 'export const api = { onUnauthorized: () => () => {} };',
    },
  });
});

after(async () => {
  await browser?.close();
});

/**
 * Настоящий диалог и UI-kit используют синтетический серверный шаг и приватный черновик.
 * Журнал фиксирует границу rename/login, не дублируя решение компонента в тестовом транспорте.
 */
async function dialogFixture(t, { existing = true, cli = false, reauthenticate = false } = {}) {
  const profile = {
    id: 'profile-a',
    name: 'Основной аккаунт',
    methodId: cli ? 'cli' : 'api-key',
    revision: 3,
    accessRevision: 2,
    accountGeneration: 1,
    authState: 'ready',
  };
  const method = {
    id: profile.methodId,
    kind: cli ? 'cli' : 'api-key',
    label: cli ? 'CLI' : 'API',
    fields: cli ? [] : [{
      id: 'apiKey',
      kind: 'secret',
      label: 'API-ключ',
    }],
    isolated: true,
  };
  const baseline = { name: existing ? profile.name : '', methodId: method.id };
  const values = reactive({ ...baseline });
  const calls = [];
  const control = {
    createError: false,
    patchError: false,
    gate: null,
  };
  const store = reactive({
    lists: { fixture: { methods: [method], profiles: [profile] } },
    attempts: {},
    errors: {},
    pending: {},
    unresolved: {},
    /**
     * Сначала возвращается серверная попытка, затем принимается ввод её точного шага.
     * Отказ создания оставляет ключ неотправленным и не превращается в rename.
     */
    async mutate(provider, route, body, verb = 'POST') {
      calls.push({
        route,
        body,
        verb,
      });
      await control.gate?.promise;

      if (route === '/attempts') {
        if (control.createError) {
          this.errors[provider] = 'Нет связи';

          return;
        }

        this.attempts[provider] = {
          id: 'attempt-a',
          name: body.name,
          methodId: body.methodId,
          revision: 1,
          state: 'pending',
          step: {
            id: 'fields-a',
            kind: cli ? 'waiting' : 'fields',
            fields: method.fields,
          },
        };
      } else if (verb === 'PATCH' && control.patchError) {
        this.errors[provider] = 'Профиль изменён в другом окне';
      } else if (route.includes('/steps/')) {
        this.attempts[provider] = {
          ...this.attempts[provider],
          state: 'saved',
          step: { id: 'result-a', kind: 'result' },
        };
      }
    },
  });
  const draft = {
    ready: Promise.resolve(),
    get: (key) => values[key] ?? '',
    set: (key, value) => {
      values[key] = value;
    },
    discard: (key) => {
      values[key] = baseline[key] ?? '';
    },
    /**
     * Секреты стираются отдельно от имени при переходе серверного шага.
     * Полная отмена возвращает значения к исходному снимку формы.
     */
    clear(secretsOnly = false) {
      for (const key of Object.keys(values)) {
        if (!secretsOnly || !['name', 'methodId'].includes(key)) {
          values[key] = baseline[key] ?? '';
        }
      }
    },
  };

  globalThis.__profileDialog = { store, draft };

  const wrapper = mount(component, {
    props: {
      providerId: 'fixture',
      ...(existing ? { profile } : {}),
      reauthenticate,
    },
    attachTo: document.body,
    global: { stubs: { transition: false } },
  });

  t.after(() => {
    wrapper.unmount();
    delete globalThis.__profileDialog;
  });
  await flushPromises();

  return {
    wrapper,
    values,
    calls,
    control,
    store,
  };
}

test('имя и ключ находятся в одной форме; пустой ключ отправляет только переименование', async (t) => {
  const f = await dialogFixture(t);
  const dialog = document.querySelector('[role="dialog"]');

  assert.ok(dialog.hasAttribute('data-ui-workspace'));
  assert.ok(dialog.querySelector('input[aria-label="Имя профиля"]'));
  assert.ok(dialog.querySelector('input[aria-label="API-ключ"]'));
  assert.ok(dialog.textContent.includes('Оставьте поле пустым'));
  assert.ok(dialog.querySelector('button[data-variant="solid"][data-tone="accent"]'));
  f.values.name = 'Новое название';
  f.values.apiKey = '   ';
  await f.wrapper.vm.proceed();

  assert.deepEqual(f.calls, [{
    route: '/profile-a',
    verb: 'PATCH',
    body: { name: 'Новое название', expectedRevision: 3 },
  }]);
  assert.equal(f.wrapper.emitted('close').length, 1);
});

test('новый ключ отправляется один раз серверному шагу вместе с выбранным названием', async (t) => {
  const f = await dialogFixture(t);

  f.values.name = 'Новое подключение';
  f.values.apiKey = 'synthetic-private-key';
  await Promise.all([f.wrapper.vm.proceed(), f.wrapper.vm.proceed()]);

  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[0].body, {
    name: 'Новое подключение',
    methodId: 'api-key',
    profileId: 'profile-a',
    expectedRevision: 3,
  });
  assert.deepEqual(f.calls[1].body, {
    expectedRevision: 1,
    input: { apiKey: 'synthetic-private-key' },
  });
  assert.equal(f.calls.some((call) => call.verb === 'PATCH'), false);
  assert.equal(f.values.apiKey, '');
  assert.equal(JSON.stringify(f.store).includes('synthetic-private-key'), false);
});

test('новый API-профиль требует название и ключ до отправки мастера', async (t) => {
  const f = await dialogFixture(t, { existing: false });

  f.values.name = 'Новый профиль';
  await f.wrapper.vm.proceed();
  assert.equal(f.calls.length, 0);
  f.values.apiKey = 'synthetic-private-key';
  await f.wrapper.vm.proceed();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].body.profileId, undefined);
});

test('отказ создания не отправляет ключ; конфликт имени оставляет окно открытым', async (t) => {
  const f = await dialogFixture(t);

  f.control.createError = true;
  f.values.apiKey = 'synthetic-private-key';
  await f.wrapper.vm.proceed();
  assert.equal(f.calls.length, 1);
  assert.equal(f.values.apiKey, '');
  assert.equal(f.wrapper.emitted('close'), undefined);
  f.store.errors.fixture = '';
  f.control.patchError = true;
  f.values.name = 'Другое имя';
  await f.wrapper.vm.proceed();
  assert.equal(f.calls.at(-1).verb, 'PATCH');
  assert.equal(f.wrapper.emitted('close'), undefined);
});

test('переименование CLI не начинает login, явное восстановление начинает', async (t) => {
  const f = await dialogFixture(t, { cli: true });

  f.values.name = 'Имя CLI';
  await f.wrapper.vm.proceed();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].verb, 'PATCH');
  await f.wrapper.setProps({ reauthenticate: true });
  await f.wrapper.vm.proceed();
  assert.equal(f.calls.at(-1).route, '/attempts');
});

test('отмена до отправки очищает ввод; закрытие во время записи ждёт её завершения', async (t) => {
  const f = await dialogFixture(t);

  f.values.apiKey = 'synthetic-private-key';
  await f.wrapper.vm.cancel();
  assert.equal(f.values.apiKey, '');
  assert.equal(f.calls.length, 0);
  f.control.gate = Promise.withResolvers();
  f.values.name = 'Имя во время записи';

  const saving = f.wrapper.vm.proceed();

  await flushPromises();
  await f.wrapper.vm.cancel();
  assert.equal(f.wrapper.emitted('close').length, 1);
  f.control.gate.resolve();
  await saving;
  assert.equal(f.wrapper.emitted('close').length, 2);
});

test('повторное открытие использует сохранённое имя, переход страницы сохраняет черновик', async (t) => {
  const { accessProfileDraft } = await compileModule(webFile('src/features/settings/accessProfileDraft.ts'), {
    stubs: { '../../ui.ts': 'export const messageRef = key => ({ key });' },
  });
  const session = createSettingsSession();
  const services = new Map();
  const settings = {
    get snapshot() {
      return session.getSnapshot();
    },
    sessionService(id, create) {
      if (!services.has(id)) {
        services.set(id, create());
      }

      return services.get(id);
    },
    registerResource: session.register,
    loadResource: session.load,
    acceptSnapshot: session.acceptSnapshot,
    getValue: session.getValue,
    setField: session.setField,
    discardField: session.discardField,
  };

  session.begin();
  t.after(() => session.dispose('close'));

  const first = accessProfileDraft(settings, 'fixture', 'profile-a', [], {
    name: 'Первое имя',
    methodId: 'api-key',
  });

  await first.ready;
  first.set('name', 'Несохранённый черновик');

  const resumed = accessProfileDraft(settings, 'fixture', 'profile-a', [], {
    name: 'Первое имя',
    methodId: 'api-key',
  });

  assert.equal(resumed.get('name'), 'Несохранённый черновик');
  resumed.clear();

  const saved = accessProfileDraft(settings, 'fixture', 'profile-a', [], {
    name: 'Сохранённое имя',
    methodId: 'api-key',
  });

  assert.equal(saved.get('name'), 'Сохранённое имя');
  assert.equal(settings.snapshot.dirtyCount, 0);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { createUiBrowser } from './helpers/ui-components.js';
import { compileVue, webFile } from './helpers/compile-vue.js';

// Окно на весь файл: Vue запоминает `document` при первом импорте runtime-dom, и
// Teleport диалога из второго окна ушёл бы в body первого, уже закрытого.
let shared = null;

const CREDENTIALS = [
  {
    env: 'TEST_API_KEY',
    kind: 'secret',
    label: 'Ключ API',
    set: true,
    inFile: true,
    preview: '…cdef',
    value: null,
  },
  {
    env: 'TEST_SECOND_KEY',
    kind: 'secret',
    label: 'Второй ключ',
    set: false,
    inFile: false,
    preview: null,
    value: null,
  },
  {
    env: 'TEST_MODE',
    kind: 'choice',
    label: 'Режим',
    options: [
      { value: 'api', label: 'Обычный API' },
      { value: 'plan', label: 'Coding Plan' },
    ],
    set: true,
    inFile: false,
    preview: null,
    value: 'api',
  },
];

async function browserHarness() {
  shared ||= await createUiBrowser();
  shared.document.body.innerHTML = '<div id="mount"></div>';

  return shared;
}

/**
 * Монтирует блок ключей с поддельным стором исполнителей: тест видит, что именно
 * ушло бы на сервер, и задаёт ответ сохранения.
 */
async function mountCredentials(t, browser, store, credentials = CREDENTIALS) {
  const { mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );

  globalThis.__credentialsStore = store;

  const Component = await compileVue(webFile('src/views/settings/ProviderCredentials.vue'), {
    stubs: {
      '../../stores/providers.js': 'export const useProvidersStore = () => globalThis.__credentialsStore;',
    },
  });
  const wrapper = mount(Component, {
    props: {
      providerId: 'keyed',
      providerName: 'Keyed',
      credentials,
    },
    attachTo: browser.document.querySelector('#mount'),
  });

  t.after(() => {
    wrapper.unmount();
    delete globalThis.__credentialsStore;
  });
  await flushPromises();

  return { wrapper, flushPromises };
}

function buttonText(browser, text) {
  return [...browser.document.querySelectorAll('button')]
    .find((button) => button.textContent.trim() === text);
}

// Окно закрывается с анимацией: ждём пару кадров, пока узел уйдёт из DOM.
async function afterLeave(flushPromises) {
  await new Promise((resolve) => {
    setTimeout(resolve, 120);
  });
  await flushPromises();
}

// Ввод значения так, как это делает человек: значение и событие input.
function typeInto(browser, input, value) {
  input.value = value;
  input.dispatchEvent(new browser.window.Event('input', { bubbles: true }));
}

test('карточка показывает только признак и хвост, окно отправляет лишь изменённое', async (t) => {
  const browser = await browserHarness();
  const saves = [];
  const store = {
    async saveCredentials(providerId, values) {
      saves.push([providerId, values]);

      return { ok: true };
    },
  };
  const { flushPromises } = await mountCredentials(t, browser, store);
  const text = browser.document.body.textContent;

  assert.match(text, /Ключ API\s*задан · …cdef/);
  assert.match(text, /Второй ключ\s*не задан/);
  assert.match(text, /Режим\s*Обычный API/);
  assert.equal(buttonText(browser, 'Задать ключи…')?.tagName, 'BUTTON');

  buttonText(browser, 'Задать ключи…').click();
  await flushPromises();

  const save = () => buttonText(browser, 'Сохранить');

  assert.equal(save()?.disabled, true);
  // Удаление — кнопка в строке своего поля, только у значения из .env.
  assert.equal(browser.document.querySelectorAll('[data-testid="credential-remove"]').length, 1);

  const secondKey = browser.document.querySelector('input[name="TEST_SECOND_KEY"]');

  assert.equal(secondKey?.type, 'password');
  assert.equal(Boolean(browser.document.querySelector('select[name="TEST_MODE"]')), false);
  typeInto(browser, secondKey, '  new-secret-value  ');
  // Выбор из двух–четырёх вариантов — переключатель кнопками.
  buttonText(browser, 'Coding Plan').click();
  await flushPromises();

  assert.equal(save()?.disabled, false);
  save().click();
  await flushPromises();

  assert.deepEqual(saves, [['keyed', { TEST_SECOND_KEY: 'new-secret-value', TEST_MODE: 'plan' }]]);
  await afterLeave(flushPromises);
  assert.equal(Boolean(browser.document.querySelector('input[name="TEST_SECOND_KEY"]')), false);

  buttonText(browser, 'Задать ключи…').click();
  await flushPromises();

  assert.equal(browser.document.querySelector('input[name="TEST_SECOND_KEY"]')?.value, '');
});

test('отказ сервера остаётся в окне вместе с введённым значением', async (t) => {
  const browser = await browserHarness();
  const store = {
    async saveCredentials() {
      return { ok: false, error: 'Строка 3 файла окружения: перенос значения.' };
    },
  };
  const { flushPromises } = await mountCredentials(t, browser, store);

  buttonText(browser, 'Задать ключи…').click();
  await flushPromises();

  const first = browser.document.querySelector('input[name="TEST_API_KEY"]');

  typeInto(browser, first, 'replacement-key');
  await flushPromises();
  buttonText(browser, 'Сохранить').click();
  await flushPromises();

  assert.match(browser.document.body.textContent, /Строка 3 файла окружения/);
  assert.equal(browser.document.querySelector('input[name="TEST_API_KEY"]')?.value, 'replacement-key');
});

const MODE_KEYS = [
  {
    env: 'TEST_MODE',
    kind: 'choice',
    label: 'Режим',
    options: [
      {
        value: 'api',
        label: 'Обычный API',
        hint: 'Оплата по расходу.',
      },
      {
        value: 'plan',
        label: 'Coding Plan',
        hint: 'Подписка.',
      },
    ],
    set: true,
    inFile: true,
    preview: null,
    value: 'api',
  },
  {
    env: 'TEST_API_KEY',
    kind: 'secret',
    label: 'Ключ API',
    when: { env: 'TEST_MODE', value: 'api' },
    set: true,
    inFile: true,
    preview: '…cdef',
    value: null,
  },
  {
    env: 'TEST_PLAN_KEY',
    kind: 'secret',
    label: 'Ключ плана',
    when: { env: 'TEST_MODE', value: 'plan' },
    set: false,
    inFile: false,
    preview: null,
    value: null,
  },
];

test('карточка и окно показывают только ключ выбранного режима', async (t) => {
  const browser = await browserHarness();
  const saves = [];
  const store = {
    async saveCredentials(providerId, values) {
      saves.push(values);

      return { ok: true };
    },
  };
  const { flushPromises } = await mountCredentials(t, browser, store, MODE_KEYS);
  const card = browser.document.querySelector('[data-testid="provider-credentials"]').textContent;

  assert.match(card, /Ключ API\s*задан · …cdef/);
  assert.doesNotMatch(card, /Ключ плана/u, 'ключ другого режима в карточке не показан');
  assert.equal(Boolean(buttonText(browser, 'Изменить ключи…')), true, 'ключ режима задан — ничего не нужно');

  buttonText(browser, 'Изменить ключи…').click();
  await flushPromises();

  const field = (name) => browser.document.querySelector(`input[name="${name}"]`);

  assert.ok(field('TEST_API_KEY'));
  assert.equal(field('TEST_PLAN_KEY') === null, true);
  // Режим из .env не удаляют, а переключают: «Удалить» есть только у ключа.
  assert.equal(browser.document.querySelectorAll('[data-testid="credential-remove"]').length, 1);
  assert.match(browser.document.body.textContent, /Оплата по расходу\./u);

  typeInto(browser, field('TEST_API_KEY'), 'typed-but-hidden');
  buttonText(browser, 'Coding Plan').click();
  await flushPromises();

  assert.equal(field('TEST_API_KEY') === null, true);
  assert.ok(field('TEST_PLAN_KEY'));
  assert.match(browser.document.body.textContent, /Подписка\./u);

  typeInto(browser, field('TEST_PLAN_KEY'), 'plan-secret');
  await flushPromises();
  buttonText(browser, 'Сохранить').click();
  await flushPromises();

  // Скрытое поле не уходит: сохраняется ровно то, что видит человек.
  assert.deepEqual(saves, [{ TEST_MODE: 'plan', TEST_PLAN_KEY: 'plan-secret' }]);
});

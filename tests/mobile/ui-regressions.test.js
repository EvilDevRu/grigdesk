import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { compileModule, webFile } from './helpers/compile-vue.js';
import { installBrowser } from './helpers/ui.js';

process.env.NODE_ENV = 'test';

/**
 * Компоненты используют один Vue document и тот же Pinia store, что App в собранном модуле.
 * Управляемые задержки проверяют смену разрешения и media без подмены lifecycle компонентов.
 */
test('Обновление запросов, media и keyboard focus сохраняет актуальный экран', async (t) => {
  const browser = installBrowser();
  const observers = [];

  globalThis.IntersectionObserver = class {
    constructor(callback) {
      observers.push(callback);
    }
    observe() {}
    disconnect() {}
  };

  const { mount, flushPromises } =
    await import('../../mobile/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs');
  const { createPinia, disposePinia } =
    await import('../../mobile/node_modules/pinia/dist/pinia.mjs');
  const { WaitingCard, MediaImage, UiDialog, PairForm, router, useLinkStore } = await compileModule(
    webFile('../tests/mobile/helpers/testApp.ts'),
  );
  const pinia = createPinia();
  const store = useLinkStore(pinia);
  const global = { plugins: [pinia] };
  const waiting = JSON.parse(
    await readFile(new URL('../fixtures/mobile-contract/v1/waiting.json', import.meta.url), 'utf8'),
  );
  const details = JSON.parse(
    await readFile(new URL('../fixtures/mobile-contract/v1/details.json', import.meta.url), 'utf8'),
  );

  t.after(async () => {
    disposePinia(pinia);
    await browser.happyDOM.abort();
  });

  await t.test('Завершение первой привязки не отменяет выбранный человеком раздел', async () => {
    const originalAdd = store.add;
    let finish;

    store.state = {
      paired: false,
      unlocked: false,
      generation: 1,
    };
    store.add = async () => {
      store.state.paired = true;
      await new Promise((resolve) => {
        finish = resolve;
      });
    };
    await router.push('/chats');

    const wrapper = mount(PairForm, { global: { plugins: [pinia, router] } });

    try {
      await wrapper.find('textarea').setValue('test-pairing-code');
      await wrapper.findAll('button').find((button) => button.text() === 'Добавить').trigger('click');
      await router.push('/tasks');
      finish();
      await flushPromises();
      assert.equal(router.currentRoute.value.path, '/tasks');

      store.add = async () => {};
      await router.push('/relays/add');
      await wrapper.find('textarea').setValue('test-relay-code');
      await wrapper.findAll('button').find((button) => button.text() === 'Добавить').trigger('click');
      await flushPromises();
      assert.equal(router.currentRoute.value.path, '/relays');
    } finally {
      wrapper.unmount();
      store.add = originalAdd;
    }
  });

  await t.test(
    'Новый token перечитывается; поздняя старая страница не возвращает read proof',
    async () => {
      const permission = waiting.items.find((item) => item.kind === 'permission');
      let resolveOld;
      let calls = 0;

      store.api = {
        getWaitingDetails: async () => {
          calls += 1;

          if (calls === 1) {
            return new Promise((resolve) => {
              resolveOld = resolve;
            });
          }

          return {
            ...details,
            text: 'Новое основание',
            hasMore: false,
            readToken: 'new-proof',
          };
        },
      };

      const wrapper = mount(WaitingCard, {
        props: { item: permission },
        global,
      });

      try {
        await wrapper.setProps({
          item: {
            ...permission,
            actionToken: 'new-action-token',
          },
        });
        await flushPromises();
        assert.equal(calls, 2);
        resolveOld({
          ...details,
          text: 'Устаревшее основание',
          hasMore: true,
        });
        await flushPromises();
        assert.match(wrapper.text(), /Новое основание/);
        assert.doesNotMatch(wrapper.text(), /Устаревшее основание/);

        const allow = wrapper.findAll('button').find((button) => button.text() === 'Разрешить');

        assert.equal(allow.attributes('disabled'), undefined);
      } finally {
        wrapper.unmount();
      }
    },
  );

  await t.test('Типизированное число имеет одно поле и отправляет числовое value', async () => {
    const original = waiting.items.find((item) => item.kind === 'question');
    const question = {
      ...original.questions[0],
      inputType: 'integer',
      options: [],
      allowFreeText: true,
      required: true,
      constraints: {
        minimum: 1,
        maximum: 9,
      },
    };
    let body;

    store.api = {
      answerWaiting: async (_pid, value) => {
        body = value;

        return { ok: true };
      },
    };

    const wrapper = mount(WaitingCard, {
      props: {
        item: {
          ...original,
          questions: [question],
          actions: ['accept'],
        },
      },
      global,
    });

    try {
      assert.equal(wrapper.findAll('input,textarea').length, 1);
      await wrapper.find('input').setValue('3');
      await wrapper
        .findAll('button')
        .find((button) => button.text() === 'Ответить')
        .trigger('click');
      await flushPromises();
      assert.deepEqual(body.answers, [
        {
          questionId: question.id,
          value: 3,
        },
      ]);
    } finally {
      wrapper.unmount();
    }
  });

  await t.test('Видимая картинка перечитывает новый ref без нового intersection', async () => {
    const fetched = [];

    store.state = {
      unlocked: true,
      generation: 1,
    };
    store.bridge = {
      fetchMedia: async (input) => {
        fetched.push(input.ref);

        return { path: '/' + input.ref.slice(2) + '.png' };
      },
    };

    const wrapper = mount(MediaImage, {
      props: {
        chatId: 'chat',
        mediaRef: 'u:first',
        alt: '',
      },
      global,
    });

    try {
      observers.at(-1)([{ isIntersecting: true }]);
      await flushPromises();
      await wrapper.setProps({ mediaRef: 'u:second' });
      await flushPromises();
      assert.deepEqual(fetched, ['u:first', 'u:second']);
      assert.equal(wrapper.find('img').attributes('src'), '/second.png');
    } finally {
      wrapper.unmount();
    }
  });

  await t.test('Tab остаётся внутри диалога, закрытие возвращает фокус', async () => {
    const origin = document.createElement('button');

    document.body.append(origin);
    origin.focus();

    const wrapper = mount(UiDialog, {
      props: { title: 'Подтверждение' },
      attachTo: document.body,
      global,
    });

    try {
      await flushPromises();

      const controls = [...document.querySelector('[role="dialog"]').querySelectorAll('button')];

      assert.equal(document.activeElement === controls[0], true);
      controls.at(-1).focus();
      controls.at(-1).dispatchEvent(
        new window.KeyboardEvent('keydown', {
          key: 'Tab',
          bubbles: true,
        }),
      );
      assert.equal(document.activeElement === controls[0], true);
      controls[0].dispatchEvent(
        new window.KeyboardEvent('keydown', {
          key: 'Tab',
          shiftKey: true,
          bubbles: true,
        }),
      );
      assert.equal(document.activeElement === controls.at(-1), true);
    } finally {
      wrapper.unmount();
      assert.equal(document.activeElement === origin, true);
      origin.remove();
    }
  });
});

/**
 * Список чатов перечитывается на смену состояния хода, но не на каждый progress:
 * пока агенты работают, такие события идут раз в секунду и съедали бы сеть телефона.
 */
test('Список чатов не перечитывается на каждый progress активного хода', async (t) => {
  const browser = installBrowser();
  const { mount, flushPromises } =
    await import('../../mobile/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs');
  const { createPinia, disposePinia } =
    await import('../../mobile/node_modules/pinia/dist/pinia.mjs');
  const { MockLink } = await import('../../mobile/src/link/mockLink.ts');
  const chats = await readFile(
    new URL('../fixtures/mobile-contract/v1/chats.json', import.meta.url),
    'utf8',
  );
  const hello = await readFile(
    new URL('../fixtures/mobile-contract/v1/hello.json', import.meta.url),
    'utf8',
  );
  let lists = 0;
  const bridge = new MockLink({
    request: async (input) => {
      if (input.path.startsWith('/api/mobile/v1/chats')) {
        lists += 1;

        return { status: 200, body: chats };
      }

      return { status: 200, body: hello };
    },
  });

  globalThis.__mobileUiBridge = bridge;

  const { App, router } = await compileModule(webFile('../tests/mobile/helpers/testApp.ts'), {
    stubs: {
      '../link/index.ts': 'export const getLink = async () => globalThis.__mobileUiBridge;',
    },
  });
  const pinia = createPinia();

  await router.push('/chats');

  const wrapper = mount(App, {
    attachTo: document.body,
    global: { plugins: [pinia, router] },
  });

  t.after(async () => {
    wrapper.unmount();
    disposePinia(pinia);
    await bridge.stopEvents();
    delete globalThis.__mobileUiBridge;
    await browser.happyDOM.abort();
  });
  await flushPromises();

  const initial = lists;

  assert.ok(initial >= 1, 'список не загружен');

  for (let index = 0; index < 5; index += 1) {
    bridge.emit('chat', { chatId: 'chat-alpha', kind: 'progress' });
  }

  await flushPromises();
  assert.equal(lists, initial, 'progress перечитал список');
  bridge.emit('chat', { chatId: 'chat-alpha', kind: 'done' });
  await flushPromises();
  assert.equal(lists, initial + 1);
  bridge.emit('chats', {});
  await flushPromises();
  assert.equal(lists, initial + 2);
});

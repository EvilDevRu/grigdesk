// Метка доставки проверяется настоящим ChatSession и UI-примитивами.
// Одно окно и стабильные диспетчеры разделяют реактивные сценарии без кэша чужого стора.
import assert from 'node:assert/strict';
import test from 'node:test';

import { messageDeliveryMark } from '../../web/src/views/chat/messageDeliveryMark.ts';

globalThis.__sharedChatContextFill = (await import(
  '../../shared/chatContext.ts')).contextFill;

const { installUiBrowser } = await import('./helpers/ui-components.js');
const { compileChatSession } = await import('./helpers/chat-session.js');

process.env.NODE_ENV = 'test';

const P = '__pendingMark';
const PROVIDERS = [{
  id: 'claude',
  name: 'Claude',
  available: true,
  models: [{
    id: 'claude-test',
    name: 'Test',
    efforts: [],
  }],
}];

function modelOf(value) {
  const id = value && typeof value === 'object' ? value.model || '' : value || '';
  const provider = PROVIDERS.find((item) => item.models.some((model) => model.id === id)) || null;

  return {
    id,
    model: provider?.models.find((model) => model.id === id) || null,
    provider,
  };
}

test('метка доставки в пузыре', async (t) => {
  const browser = await installUiBrowser(t, 'https://cockpit.test/#/chats');
  const { reactive, nextTick } = await import('../../web/node_modules/vue/index.mjs');
  const { mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs');
  let current = null;

  // Модуль читает globalThis.<prefix>* один раз при импорте: ставим стабильные диспетчеры ДО компиляции.
  globalThis[`${P}Api`] = {
    url: (path) => path,
    get: async () => ({ tasks: [] }),
    post: async () => ({}),
  };
  globalThis[`${P}ChatStore`] = () => current.chat;
  globalThis[`${P}TasksStore`] = () => ({ async load() {
    return null;
  } });
  globalThis[`${P}UiStore`] = () => ({});
  globalThis[`${P}ProvidersStore`] = () => ({
    providers: PROVIDERS,
    load() {},
    modelOf,
    visibleModels: (provider) => provider.models,
    modesOf: () => [],
  });
  // Общий диалог подтверждения подменяет фасад UI-kit: тест решает ответ и видит вопрос.
  const confirms = [];
  let confirmAnswer = true;

  globalThis[`${P}ConfirmDialog`] = (text, options) => {
    confirms.push({
      text,
      options,
    });

    return Promise.resolve(confirmAnswer);
  };
  t.after(() => {
    for (const key of ['Api', 'ChatStore', 'TasksStore', 'UiStore', 'ProvidersStore', 'ConfirmDialog']) {
      delete globalThis[`${P}${key}`];
    }
  });

  const ChatSession = await compileChatSession(P);

  /**
   * Каждый сценарий получает свежие сообщения и доставку через стабильный диспетчер.
   * Одно окно и одна компиляция сохраняют корректный document Vue для подсказок.
   */
  async function mountWith(scenario, messages, deliveries = {}) {
    const session = reactive({
      id: 'pending-chat',
      title: 'Синтетический чат',
      model: 'claude-test',
      modelRef: { provider: 'claude', model: 'claude-test' },
      effort: '',
      mode: '',
      messages,
      steps: [],
      draft: '',
      sending: false,
      compacting: false,
      sessionResetting: false,
    });
    const retries = [];

    current = {
      chat: reactive({
        sessions: [session],
        deliveries,
        markRead() {},
        setDraft() {},
        permFor: () => null,
        questionFor: () => null,
        tabLabel: () => session.title,
        async retryDelivery(sid, turnId) {
          retries.push([sid, turnId]);
        },
      }),
    };

    const wrapper = mount(ChatSession, {
      attachTo: browser.document.querySelector('#mount'),
      props: { sid: session.id },
    });

    scenario.after(() => wrapper.unmount());
    await flushPromises();

    return {
      wrapper,
      session,
      retries,
      chat: current.chat,
    };
  }

  await t.test('метка доставки: очередь, отправка, проверка, сбои', () => {
    const queued = 'Ждёт очереди — уйдёт, когда агент закончит текущий ход';
    const user = {
      role: 'user',
      delivery: 'sending',
      queued: true,
    };
    const cases = [
      ['posting', {
        kind: 'pending',
        label: 'Отправляется',
        icon: 'clock',
      }],
      ['checking', {
        kind: 'pending',
        label: 'Проверяю доставку',
        icon: 'clock',
      }],
      [undefined, {
        kind: 'pending',
        label: 'Проверяю доставку',
        icon: 'clock',
      }],
      ['unknown', {
        kind: 'pending',
        label: 'Проверяю доставку',
        icon: 'clock',
      }],
      ['retrying', {
        kind: 'pending',
        label: 'Нет связи с сервером — повторяю отправку…',
        icon: 'offline',
      }],
      ['lost', {
        kind: 'failed',
        label: 'Не доставлено: сервер не подтвердил приём',
      }],
    ];

    for (const [state, expected] of cases) {
      assert.deepEqual(messageDeliveryMark(user, state), expected);
    }

    assert.deepEqual(messageDeliveryMark({ role: 'user', queued: true }), {
      kind: 'pending',
      label: queued,
      icon: 'clock',
    });
    assert.equal(messageDeliveryMark({ role: 'assistant', queued: true }), null);
    assert.equal(messageDeliveryMark({ ...user, kind: 'in-turn' }, 'posting'), null);
    assert.equal(messageDeliveryMark({ role: 'user' }), null);
  });

  await t.test(
    'реплика в очереди: часики у времени с подсказкой, без строки над пузырём', async (scenario) => {
    const sentAt = Date.UTC(2026, 9, 6, 9, 49);
    const { wrapper } = await mountWith(scenario, [{
      role: 'user',
      text: 'вопрос',
      sentAt,
      queued: true,
    }]);

    assert.equal(wrapper.find('.m-queued').exists(), false);
    assert.doesNotMatch(wrapper.text(), /⏳|уйдёт, когда/u);

    const mark = wrapper.find('.msg.user .m-meta [data-role="chat-message-pending"]');

    assert.equal(mark.exists(), true);

    const label = 'Ждёт очереди — уйдёт, когда агент закончит текущий ход';

    assert.equal(mark.attributes('aria-label'), label);
    assert.equal(mark.attributes('data-ui-tooltip'), label);
    assert.equal(mark.get('svg').attributes('stroke'), 'currentColor');
    assert.equal(wrapper.get('.m-time').text(), new Intl.DateTimeFormat('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(sentAt));
  });

  await t.test('отправка и проверка доставки — тоже часики', async (scenario) => {
    const { wrapper, chat } = await mountWith(scenario, [
      {
        role: 'user',
        text: 'x',
        turnId: 't1',
        delivery: 'sending',
      },
    ], { t1: { state: 'posting' } });
    const selector = '[data-role="chat-message-pending"]';

    assert.equal(wrapper.find(selector).exists(), true);
    assert.equal(wrapper.get(selector).attributes('aria-label'), 'Отправляется');
    chat.deliveries.t1.state = 'checking';
    await nextTick();
    assert.equal(wrapper.get(selector).attributes('aria-label'), 'Проверяю доставку');
    assert.equal(wrapper.find('[data-role="chat-delivery"]').exists(), false);
  });

  await t.test('сбой доставки — значок у пузыря, повтор через окно подтверждения', async (scenario) => {
    const { wrapper, chat, session, retries } = await mountWith(scenario, [
      {
        role: 'user',
        text: 'x',
        turnId: 't1',
        delivery: 'sending',
      },
    ], { t1: { state: 'lost' } });
    const retry = '[data-context="chat-delivery-retry"]';

    confirms.length = 0;
    assert.equal(wrapper.find('[data-role="chat-delivery"]').exists(), false, 'строки над пузырём нет');
    assert.doesNotMatch(wrapper.text(), /⚠|Отправить ещё раз/u);
    assert.equal(wrapper.find(`.msg.user .mrow > ${retry}`).exists(), true, 'значок рядом с пузырём');
    assert.match(wrapper.get(retry).attributes('aria-label'), /^Не доставлено: сервер не подтвердил приём/u);
    assert.match(wrapper.get(retry).attributes('data-ui-tooltip'), /повторить отправку/u);
    assert.equal(wrapper.get(`${retry} svg`).attributes('stroke'), 'currentColor');
    assert.equal(wrapper.find('[data-role="chat-message-pending"]').exists(), false);

    confirmAnswer = false;
    await wrapper.get(retry).trigger('click');
    await flushPromises();
    assert.equal(confirms.length, 1);
    assert.equal(confirms[0].options.title, 'Сообщение не доставлено');
    assert.equal(confirms[0].options.okText, 'Повторить отправку');
    assert.equal(retries.length, 0, 'отказ в окне ничего не отправляет');

    confirmAnswer = true;
    await wrapper.get(retry).trigger('click');
    await flushPromises();
    assert.deepEqual(retries, [[session.id, 't1']]);

    chat.deliveries.t1.state = 'retrying';
    await nextTick();

    const offline = wrapper.get('.m-meta [data-role="chat-message-pending"]');

    assert.match(offline.attributes('aria-label'), /^Нет связи с сервером/u);
    assert.doesNotMatch(wrapper.text(), /📡/u);
    assert.equal(wrapper.find(retry).exists(), false);

    chat.deliveries.t1.state = 'lost';
    session.sessionResetting = true;
    await nextTick();
    assert.equal(wrapper.get(retry).attributes('disabled') !== undefined, true);
    await wrapper.get(retry).trigger('click');
    await flushPromises();
    assert.equal(retries.length, 1);
    assert.equal(confirms.length, 2, 'замороженный чат окно не открывает');
  });

  await t.test('принятая реплика — только время', async (scenario) => {
    const { wrapper } = await mountWith(scenario, [{
      role: 'user',
      text: 'принято',
      sentAt: Date.now(),
    }]);

    assert.equal(wrapper.find('[data-role="chat-message-pending"]').exists(), false);
    assert.equal(wrapper.find('.m-time').exists(), true);
  });

  await t.test('метка меняется без перемонтирования', async (scenario) => {
    const { wrapper, chat, session } = await mountWith(scenario, [
      {
        role: 'user',
        text: 'x',
        turnId: 't1',
        delivery: 'sending',
      },
    ], { t1: { state: 'posting' } });
    const selector = '[data-role="chat-message-pending"]';

    assert.equal(wrapper.find(selector).exists(), true);
    assert.equal(wrapper.get(selector).attributes('aria-label'), 'Отправляется');
    chat.deliveries.t1.state = 'checking';
    await nextTick();
    assert.equal(wrapper.get(selector).attributes('aria-label'), 'Проверяю доставку');
    delete session.messages[0].delivery;
    session.messages[0].queued = true;
    await nextTick();
    assert.match(wrapper.get(selector).attributes('aria-label'), /^Ждёт очереди/u);
    delete session.messages[0].queued;
    await nextTick();
    assert.equal(wrapper.find(selector).exists(), false);
  });

  await t.test('часики без времени и текста, только у реплик человека', async (scenario) => {
    const { wrapper } = await mountWith(scenario, [
      {
        role: 'user',
        queued: true,
        attachments: [{ file: 'note.txt', name: 'note.txt' }],
      },
      {
        role: 'assistant',
        text: 'Ответ',
        sentAt: Date.now(),
      },
      {
        role: 'error',
        text: 'Ошибка',
        sentAt: Date.now(),
      },
      {
        role: 'user',
        kind: 'in-turn',
        text: 'Уточнение',
        runId: 'run-a',
        messageId: 'message-a',
        receipt: { state: 'accepted' },
      },
    ]);

    assert.equal(wrapper.find('.msg.user .text [data-role="chat-message-pending"]').exists(), true);
    assert.equal(wrapper.findAll('[data-role="chat-message-pending"]').length, 1);
    assert.equal(wrapper.find('.msg.assistant .m-meta').exists(), false);
    assert.equal(wrapper.find('.msg.error .m-meta').exists(), false);
    assert.equal(wrapper.find('[data-role="chat-in-turn-delivery"]').exists(), true);
  });
});

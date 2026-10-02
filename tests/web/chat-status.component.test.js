import assert from 'node:assert/strict';
import test from 'node:test';

import { compileChatSession } from './helpers/chat-session.js';
import { installUiBrowser } from './helpers/ui-components.js';
import { apiHarness, chatStoreFixture, sseOf } from './helpers/chat-store.js';
import { api } from '../../web/src/shared/apiClient.ts';

globalThis.__sharedChatContextFill = (await import('../../shared/chatContext.ts')).contextFill;
process.env.NODE_ENV = 'test';

test('ChatSession: snapshot, живые квоты, один таймер и сведения обычным текстом', async (t) => {
  const browser = await installUiBrowser(t, 'http://cockpit.test/#/chats');
  const chat = await chatStoreFixture({ sessions: [{
    id: 'status-component',
    model: 'next-model',
    modelRef: { provider: 'next-provider', model: 'next-model' },
    title: 'Синтетическая проверка',
    messages: [{
      role: 'user',
      text: 'Проверь сводку',
      turnId: 'turn-status-a',
    }],
    steps: [],
    draft: '',
    workdirState: { committed: { cwd: '/next/project' } },
  }] });
  const { useProvidersStore } = await import('../../web/src/stores/providers.js');
  const providers = useProvidersStore();

  providers.providers = [
    {
      id: 'next-provider',
      name: 'Следующий',
      available: true,
      models: [{ id: 'next-model', name: 'Следующая модель' }],
    },
    {
      id: 'running-provider',
      name: 'Текущий',
      available: true,
      models: [{ id: 'run-model', name: 'Модель запуска' }],
    },
  ];
  providers.load = async () => {};
  providers.applyUsage({ 'running-provider': {
    state: 'ok', bars: [{
      key: 'week',
      label: 'Неделя',
      pct: 20,
    }],
  } });
  t.mock.method(api, 'get', async () => ({ tasks: [] }));
  apiHarness.get = async () => ({
    entries: [],
    nextAfterSequence: null,
    throughSequence: 0,
  });

  globalThis.__statusComponentChatStore = () => chat;
  globalThis.__statusComponentProvidersStore = () => providers;
  globalThis.__statusComponentApi = { url: (value) => value, get: async () => ({ tasks: [] }) };
  globalThis.__statusComponentTasksStore = () => ({ load: async () => {} });
  globalThis.__statusComponentUiStore = () => ({});

  const [{ mount, flushPromises }, component] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileChatSession('__statusComponent'),
  ]);
  const wrapper = mount(component, {
    attachTo: browser.document.querySelector('#mount'), props: { sid: 'status-component' },
  });

  t.after(() => wrapper.unmount());
  await flushPromises();
  assert.equal(wrapper.find('[data-role="chat-status"]').exists(), false);

  const sse = sseOf(chat);
  const snapshot = (runId) => ({
    chatKey: 'status-component',
    runId,
    providerId: 'running-provider',
    requestedModelId: 'run-model',
    cwd: '/running/source',
    extraDirs: ['/running/shared'],
  });

  sse('chat-turn-start', {
    chatKey: 'status-component',
    runId: 'run-status-a',
    snapshot: snapshot('run-status-a'),
  });
  await flushPromises();

  const firstTimer = wrapper.find('[data-role="chat-thinking"]').element;

  assert.equal(wrapper.findAll('[data-role="chat-thinking"]').length, 1);
  assert.equal(wrapper.find('.cs-body').element.contains(firstTimer), true);
  assert.equal(wrapper.find('[data-role="chat-turn"]').element.contains(firstTimer), true);
  assert.equal(wrapper.find('[data-role="chat-status"]').element.contains(firstTimer), true);
  assert.equal(wrapper.findAll('[data-role="chat-status"]').length, 1);
  assert.equal(wrapper.findAll('.ahead').length, 1);
  assert.match(wrapper.find('[data-role="chat-status-model"]').text(), /Модель запуска/);
  assert.match(wrapper.find('[data-role="chat-status-cwd"]').text(), /running\/source/);
  assert.match(wrapper.find('[data-role="chat-status-usage"]').text(), /80%/);

  providers.applyUsage({ 'running-provider': {
    state: 'ok', bars: [{
      key: 'week',
      label: 'Неделя',
      pct: 35,
    }],
  } });
  await flushPromises();
  assert.match(wrapper.find('[data-role="chat-status-usage"]').text(), /65%/);

  const summary = wrapper.find('[data-role="chat-status-summary"]');

  assert.equal(summary.find('button, [role="button"], [tabindex]').exists(), false);
  assert.match(summary.attributes('title'), /\/running\/source/);
  assert.match(summary.attributes('title'), /\/running\/shared/);

  for (const state of ['unavailable', 'unsupported', 'auth_required', 'blocked', 'rate_limited']) {
    providers.applyUsage({ 'running-provider': {
      state,
      stale: true,
      bars: [{
        key: 'week',
        label: 'Неделя',
        pct: 35,
      }],
    } });
    await flushPromises();
    assert.equal(wrapper.find('[data-role="chat-status-usage"]').exists(), false, state);
    assert.equal(summary.findAll('.chat-status__sep').length, 1, state);
    assert.doesNotMatch(summary.attributes('title'), /лимит|устарели|Неделя/iu, state);
    assert.match(summary.text(), /Модель запуска/);
  }

  providers.applyUsage({ 'running-provider': {
    state: 'ok',
    bars: [{
      key: 'unknown',
      label: 'Неизвестное окно',
      pct: null,
    }],
  } });
  await flushPromises();
  assert.equal(wrapper.find('[data-role="chat-status-usage"]').exists(), false);

  providers.applyUsage({ 'running-provider': {
    state: 'ok',
    bars: [
      {
        key: 'unknown',
        label: 'Неизвестное окно',
        pct: null,
      },
      {
        key: 'week',
        label: 'Неделя',
        pct: 100,
      },
    ],
  } });
  await flushPromises();
  assert.match(wrapper.get('[data-role="chat-status-usage"]').text(), /Неделя:\s*0%/u);
  assert.doesNotMatch(summary.text(), /нет данных|Неизвестное окно|\+1/u);
  assert.match(summary.attributes('title'), /Неделя: 0%/u);

  await summary.trigger('click');
  await flushPromises();
  assert.equal(Boolean(browser.document.querySelector('[data-role="chat-status-popover"]')), false);

  sse('chat-done', {
    chatKey: 'status-component',
    runId: 'run-status-a',
    queued: 1,
  });
  sse('chat-turn-start', {
    chatKey: 'status-component',
    runId: 'run-status-b',
    snapshot: snapshot('run-status-b'),
  });
  await flushPromises();
  assert.equal(wrapper.find('[data-role="chat-thinking"]').element === firstTimer, false);
  assert.equal(wrapper.findAll('[data-role="chat-thinking"]').length, 1);

  sse('chat-turn-start', {
    chatKey: 'status-component',
    runId: 'run-compact',
    compact: true,
    snapshot: snapshot('run-compact'),
  });
  await flushPromises();
  assert.equal(wrapper.findAll('[data-role="chat-thinking"]').length, 0);
  assert.match(wrapper.find('[data-role="chat-status"]').text(), /Сжимаю контекст/);
  assert.equal(wrapper.find('[data-role="chat-status"] .ui-spinner').exists(), true);
  assert.equal(wrapper.find('[data-role="chat-status-summary"]').exists(), false);
  assert.equal(wrapper.find('[data-role="chat-status-model"]').exists(), false);

  sse('chat-done', {
    chatKey: 'status-component',
    runId: 'run-compact',
  });
  await flushPromises();
  assert.equal(wrapper.find('[data-role="chat-status"]').exists(), false);
});

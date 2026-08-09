import assert from 'node:assert/strict';
import test from 'node:test';

import { apiError, mountChannelView } from './helpers/channel-views.js';

process.env.NODE_ENV = 'test';

const EMPTY_STATUS = {
  configured: false, state: null, repositoryId: null, fullName: null,
  connectedAt: null, connection: 'disconnected', reason: null, cleanupPending: false,
};
const CONNECTED = {
  configured: true,
  state: 'connected',
  repositoryId: '123456',
  fullName: 'EvilDevRu/ai-cockpit',
  connectedAt: 1_786_172_300_000,
  connection: 'connected',
  reason: null,
  cleanupPending: false,
};

function button(wrapper, text) {
  const found = wrapper.findAll('button').find((entry) => entry.text() === text);
  assert.ok(found, `не найдена кнопка «${text}»`);
  return found;
}

test('connect отправляет exact owner/repo/token, после успеха секрет исчезает', async (t) => {
  const calls = [];
  let current = EMPTY_STATUS;
  const api = {
    async get(url) {
      calls.push(['GET', url]);
      if (url === '/api/github/status') return current;
      if (url === '/api/github/rules') return { rules: [] };
      assert.fail(`unexpected GET ${url}`);
    },
    async post(url, body) {
      calls.push(['POST', url, body]);
      current = { ...CONNECTED, state: 'pending', connection: 'connected', connectedAt: null };
      return { ok: true };
    },
  };
  const { wrapper, settle } = await mountChannelView(t, 'github', { api });
  await wrapper.get('input[name="owner"]').setValue('  EvilDevRu ');
  await wrapper.get('input[name="repo"]').setValue(' ai-cockpit  ');
  await wrapper.get('input[name="token"]').setValue('  github_pat_private  ');
  await button(wrapper, 'Подключить').trigger('click');
  await settle();

  assert.deepEqual(calls[1], [
    'POST', '/api/github/connect',
    { owner: 'EvilDevRu', repo: 'ai-cockpit', token: 'github_pat_private' },
  ]);
  assert.match(wrapper.text(), /EvilDevRu\/ai-cockpit/);
  assert.match(wrapper.text(), /signed ping/);
  assert.match(wrapper.text(), /Allowlist пуст/);
  assert.equal(wrapper.get('[data-state="provider-read-only"]').exists(), true);
  assert.doesNotMatch(wrapper.text(), /github_pat_private/);
  assert.equal(wrapper.find('input[name="token"]').exists(), false);
});

test('status рендерит только public allowlist, recheck/disconnect посылают exact empty body', async (t) => {
  const calls = [];
  const leaked = {
    ...CONNECTED,
    token: 'github_pat_must_not_render',
    secret: 'webhook_secret_must_not_render',
    ingressRef: 'ingress_must_not_render',
    hookId: '999999',
    accountRef: 'acc_must_not_render',
  };
  const api = {
    async get(url) {
      calls.push(['GET', url]);
      return url.endsWith('/rules') ? { rules: [] } : leaked;
    },
    async post(url, body) { calls.push(['POST', url, body]); return { ok: true }; },
  };
  const prompts = [];
  const { wrapper, settle } = await mountChannelView(t, 'github', {
    api,
    confirm: async (text) => { prompts.push(text); return true; },
  });
  assert.match(wrapper.text(), /EvilDevRu\/ai-cockpit/);
  assert.doesNotMatch(wrapper.text(), /must_not_render|999999/);
  assert.match(wrapper.text(), /не включает очередь автоматически/);
  assert.equal(wrapper.get('a[href="#/inbox"]').exists(), true);

  await button(wrapper, 'Перепроверить').trigger('click');
  await settle();
  await button(wrapper, 'Отключить').trigger('click');
  await settle();
  assert.deepEqual(calls.filter(([method]) => method === 'POST'), [
    ['POST', '/api/github/recheck', {}],
    ['POST', '/api/github/disconnect', {}],
  ]);
  assert.match(prompts[0], /Webhook будет удалён/);
});

test('пустой allowlist виден явно, PUT передаёт rules[0..1] без dangerous auto defaults', async (t) => {
  const calls = [];
  let storedRules = [];
  const api = {
    async get(url) {
      return url.endsWith('/rules') ? { rules: storedRules } : CONNECTED;
    },
    async put(url, body) {
      calls.push(['PUT', url, body]);
      storedRules = body.rules.map((rule) => ({
        ...rule,
        b24: { responsibleId: null, groupId: null, priority: 1 },
        autoTask: { enabled: false, minConfidence: 0.7, maxPerDay: 10 },
      }));
      return { rules: storedRules };
    },
  };
  const { wrapper, settle } = await mountChannelView(t, 'github', { api });
  assert.equal(wrapper.get('[data-state="empty-allowlist"]').exists(), true);
  assert.match(wrapper.text(), /Issues .* не попадут в Inbox/);

  await button(wrapper, 'Допустить в Inbox').trigger('click');
  await wrapper.get('input[name="project"]').setValue(' cockpit ');
  await wrapper.get('select[name="kind"]').setValue('wish');
  await button(wrapper, 'Сохранить').trigger('click');
  await settle();

  assert.deepEqual(calls, [[
    'PUT', '/api/github/rules', {
      repositoryId: '123456',
      rules: [{ repositoryId: '123456', project: 'cockpit', kind: 'wish' }],
    },
  ]]);
  assert.match(wrapper.text(), /Новое правило не включает автоматическое/);
});

test('404 plugin_disabled старого server не оставляет форму с секретом', async (t) => {
  const api = {
    async get() { throw apiError(404, { error: 'plugin_disabled', message: 'GitHub выключен.' }); },
    async post() { assert.fail('недоступный plugin ничего не меняет'); },
  };
  const { wrapper } = await mountChannelView(t, 'github', { api });
  assert.equal(wrapper.get('[data-state="plugin-disabled"]').exists(), true);
  assert.equal(wrapper.find('input').exists(), false);
  assert.equal(wrapper.find('[role="alert"]').exists(), false);
});

test('отключённый provider явно показывает отсутствие ingress и read-only историю', async (t) => {
  const api = {
    async get(url) {
      assert.equal(url, '/api/github/status');
      return EMPTY_STATUS;
    },
    async post() { assert.fail('без действия пользователя запросов быть не должно'); },
  };
  const { wrapper } = await mountChannelView(t, 'github', { api });
  const state = wrapper.get('[data-state="provider-disconnected"]');
  assert.match(state.text(), /новые issues не принимаются/);
  assert.match(state.text(), /только для чтения/);
});

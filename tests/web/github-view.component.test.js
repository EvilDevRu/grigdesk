import { measured } from './helpers/performance-surface.js';
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
  fullName: 'example-org/example-repo',
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
  await wrapper.get('input[name="owner"]').setValue('  example-org ');
  await wrapper.get('input[name="repo"]').setValue(' example-repo  ');
  await wrapper.get('input[name="token"]').setValue('  github_pat_private  ');
  await button(wrapper, 'Подключить').trigger('click');
  await settle();

  assert.deepEqual(calls[1], [
    'POST', '/api/github/connect',
    { owner: 'example-org', repo: 'example-repo', token: 'github_pat_private' },
  ]);
  assert.match(wrapper.text(), /example-org\/example-repo/);
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
  assert.match(wrapper.text(), /example-org\/example-repo/);
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
      // Сервер отвечает подтверждением и сохранённым правилом целиком.
      return { ok: true, rules: storedRules };
    },
  };
  const { wrapper, settle } = await mountChannelView(t, 'github', { api });
  assert.equal(wrapper.get('[data-state="empty-allowlist"]').exists(), true);
  assert.match(wrapper.text(), /Issues .* не попадут в Inbox/);

  await button(wrapper, 'Допустить в Inbox').trigger('click');
  await wrapper.get('input[name="project"]').setValue(' grigdesk ');
  await wrapper.get('select[name="kind"]').setValue('wish');
  await button(wrapper, 'Сохранить').trigger('click');
  await settle();

  assert.deepEqual(calls, [[
    'PUT', '/api/github/rules', {
      repositoryId: '123456',
      rules: [{ repositoryId: '123456', project: 'grigdesk', kind: 'wish' }],
    },
  ]]);
  assert.match(wrapper.text(), /Новое правило не включает автоматическое/);
  assert.equal(wrapper.find('[role="alert"]').exists(), false, 'сохранение прошло без отказа');
});

test('agentSearch legacy-default закрыт и включается отдельным подтверждённым CAS', async (t) => {
  const calls = [];
  const confirmations = [];
  let fingerprint = 'ghpol1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  let storedRule = {
    repositoryId: '123456',
    project: 'grigdesk',
    kind: 'bug',
    b24: { responsibleId: null, groupId: null, priority: 1 },
    autoTask: { enabled: false, minConfidence: 0.7, maxPerDay: 10 },
    // Legacy server record намеренно не содержит agentSearch.
  };
  const api = {
    async get(url) {
      if (url.endsWith('/rules')) return { rules: [storedRule], policyFingerprint: fingerprint };
      return CONNECTED;
    },
    async put(url, body) {
      calls.push(['PUT', url, body]);
      assert.equal(url, '/api/github/rules/agent-search');
      storedRule = { ...storedRule, agentSearch: body.enabled };
      fingerprint = 'ghpol1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      return { ok: true, rules: [storedRule], policyFingerprint: fingerprint };
    },
  };
  const { wrapper, settle } = await mountChannelView(t, 'github', {
    api,
    confirm: async (text) => { confirmations.push(text); return true; },
  });
  const checkbox = wrapper.get('input[name="agentSearch"]');
  assert.equal(checkbox.element.checked, false);
  assert.match(wrapper.text(), /человеческий Inbox/iu);

  await checkbox.setValue(true);
  await settle();

  assert.equal(confirmations.length, 1);
  assert.match(confirmations[0], /агент/iu);
  assert.deepEqual(calls, [[
    'PUT', '/api/github/rules/agent-search', {
      repositoryId: '123456',
      expectedPolicyFingerprint: 'ghpol1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      enabled: true,
    },
  ]]);
  assert.equal(wrapper.get('input[name="agentSearch"]').element.checked, true);
  assert.match(wrapper.text(), /разрешён агентам выбранного проекта/iu);
  assert.equal(wrapper.find('[role="alert"]').exists(), false);
});

test('agentSearch после потерянного ответа PUT перечитывает и различает фактический исход', async (t) => {
  let ruleGets = 0;
  let storedEnabled = false;
  const api = {
    async get(url) {
      if (url === '/api/github/status') return CONNECTED;
      assert.equal(url, '/api/github/rules');
      ruleGets += 1;
      return {
        rules: [{
          repositoryId: '123456', project: 'grigdesk', kind: 'bug',
          agentSearch: storedEnabled,
        }],
        policyFingerprint: ruleGets === 1
          ? 'ghpol1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
          : 'ghpol1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      };
    },
    async put(url) {
      assert.equal(url, '/api/github/rules/agent-search');
      storedEnabled = true; // commit прошёл, а ответ потерялся
      throw new Error('Связь оборвалась.');
    },
  };
  const { wrapper, settle } = await mountChannelView(t, 'github', { api });

  await wrapper.get('input[name="agentSearch"]').setValue(true);
  await settle();

  assert.equal(ruleGets, 2, 'после любой ошибки PUT нужен authoritative GET');
  assert.equal(wrapper.get('input[name="agentSearch"]').element.checked, true);
  assert.match(wrapper.text(), /повторная проверка.*подтвердила.*разрешён/iu);
});

test('agentSearch после ошибки PUT не выдаёт неприменённое желаемое состояние за факт', async (t) => {
  let ruleGets = 0;
  const api = {
    async get(url) {
      if (url === '/api/github/status') return CONNECTED;
      assert.equal(url, '/api/github/rules');
      ruleGets += 1;
      return {
        rules: [{
          repositoryId: '123456', project: 'grigdesk', kind: 'bug', agentSearch: false,
        }],
        policyFingerprint: 'ghpol1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      };
    },
    async put() { throw new Error('Запрос отклонён.'); },
  };
  const { wrapper, settle } = await mountChannelView(t, 'github', { api });

  await wrapper.get('input[name="agentSearch"]').setValue(true);
  await settle();

  assert.equal(ruleGets, 2);
  assert.equal(wrapper.get('input[name="agentSearch"]').element.checked, false);
  assert.match(wrapper.get('[role="alert"]').text(),
    /повторная проверка.*закрыт.*запрошенное включение не применено/iu);
});

test('agentSearch не выдаёт старое значение за достоверное, если PUT и GET провалились', async (t) => {
  let mutationStarted = false;
  let puts = 0;
  const api = {
    async get(url) {
      if (url === '/api/github/status') return CONNECTED;
      assert.equal(url, '/api/github/rules');
      if (mutationStarted) throw new Error('Не удалось перечитать rules.');
      return {
        rules: [{
          repositoryId: '123456', project: 'grigdesk', kind: 'bug', agentSearch: true,
        }],
        policyFingerprint: 'ghpol1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      };
    },
    async put(url) {
      assert.equal(url, '/api/github/rules/agent-search');
      puts += 1;
      mutationStarted = true;
      throw new Error('Связь оборвалась.');
    },
  };
  const { wrapper, settle } = await mountChannelView(t, 'github', { api });

  await wrapper.get('input[name="agentSearch"]').setValue(false);
  await settle();

  const checkbox = wrapper.get('input[name="agentSearch"]');
  assert.equal(puts, 1);
  assert.equal(checkbox.element.checked, false, 'старое true не показывается как подтверждённый policy');
  assert.equal(checkbox.element.disabled, true, 'без нового fingerprint повторная мутация запрещена');
  assert.match(wrapper.get('[data-state="agent-search-unknown"]').text(),
    /состояние доступа.*не подтверждено.*неизвестно/iu);
});

test('обычное редактирование rule не переносит agentSearch через human allowlist PUT', async (t) => {
  const calls = [];
  const storedRule = {
    repositoryId: '123456',
    project: 'grigdesk',
    kind: 'bug',
    b24: { responsibleId: null, groupId: null, priority: 1 },
    autoTask: { enabled: false, minConfidence: 0.7, maxPerDay: 10 },
    agentSearch: true,
  };
  const api = {
    async get(url) {
      return url.endsWith('/rules') ? {
        rules: [storedRule],
        policyFingerprint: 'ghpol1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      } : CONNECTED;
    },
    async put(url, body) {
      calls.push(['PUT', url, body]);

      return { ok: true, rules: [storedRule] };
    },
  };
  const { wrapper, settle } = await mountChannelView(t, 'github', { api });
  await wrapper.get('input[name="project"]').setValue('grigdesk-next');
  await button(wrapper, 'Сохранить').trigger('click');
  await settle();
  assert.equal(Object.hasOwn(calls[0][2].rules[0], 'agentSearch'), false);
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

test('PERF: первый отказ GitHub даёт error, не ready', async (t) => {
  const failure = apiError(503, { error: 'github down' });
  const { wrapper } = await mountChannelView(t, 'github', {
    api: { get: async () => {
      throw failure;
    }, post: async () => {
      throw failure;
    } },
  });
  const f = measured(t, wrapper, 'github', 'route');

  await f.paint();
  assert.equal(f.log.snapshot().entries.at(-1).data.phase, 'error');
});

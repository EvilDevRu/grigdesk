// Opt-in подтверждения созданной задачи в Telegram.
//
// Настройка принадлежит exact правилу чата/темы и работает для обоих способов
// постановки. Старые правила без поля обязаны остаться молчащими и не выглядеть
// как несохранённая правка сразу после открытия страницы.
import assert from 'node:assert/strict';
import test from 'node:test';

import { mountTelegramView, settle } from './helpers/telegram-view.js';

process.env.NODE_ENV = 'test';

const BOT = {
  configured: true,
  username: 'inbox_bot',
  botId: 42,
  tokenHint: '…4242',
  canReadAllGroupMessages: true,
  connectedAt: 0,
  serviceChatId: null,
};
const POLICY_FINGERPRINT = `telegram-rules-v1:${'1'.repeat(64)}`;
const NEXT_POLICY_FINGERPRINT = `telegram-rules-v1:${'2'.repeat(64)}`;

function rule(over = {}) {
  return {
    project: 'demo',
    chatId: -100123,
    username: null,
    title: 'Баги пользователей',
    threadId: null,
    kind: 'bug',
    b24: { responsibleId: null, groupId: null, priority: 1 },
    draft: 'manual',
    notifyTaskCreated: false,
    agentSearch: false,
    autoTask: { enabled: false, minConfidence: 0.7, maxPerDay: 10 },
    autoLaunch: { enabled: false, route: '', minConfidence: 0.8, maxPerDay: 3, vetoMinutes: 10 },
    ...over,
  };
}

function server(initialRules) {
  const puts = [];
  let rules = structuredClone(initialRules);
  let policyFingerprint = POLICY_FINGERPRINT;
  const copy = (value) => JSON.parse(JSON.stringify(value));
  return {
    puts,
    api: {
      async get(url) {
        if (url === '/api/telegram/status') return { bot: BOT, poll: { running: true } };
        if (url === '/api/telegram/chats') {
          return {
            chats: rules.map((entry) => ({
              id: entry.chatId,
              title: entry.title,
              type: 'supergroup',
            })),
          };
        }
        if (url === '/api/telegram/rules') {
          return { rules: copy(rules), projects: ['demo'], policyFingerprint };
        }
        if (url === '/api/b24/users') return { users: [] };
        if (url === '/api/b24/groups') return { groups: [] };
        return {};
      },
      async post() { return {}; },
      async put(url, body) {
        puts.push({ url, body: copy(body) });
        if (url === '/api/telegram/rules/agent-search') {
          const found = rules.find((candidate) => (
            candidate.project === body.rule.project
            && candidate.chatId === body.rule.chatId
            && candidate.username === body.rule.username
            && candidate.threadId === body.rule.threadId
          ));
          found.agentSearch = body.enabled;
        } else {
          const previous = rules;
          rules = copy(body.rules).map((candidate) => ({
            ...candidate,
            agentSearch: previous.find((stored) => (
              stored.project === candidate.project
              && stored.chatId === candidate.chatId
              && stored.username === candidate.username
              && stored.threadId === candidate.threadId
            ))?.agentSearch === true,
          }));
        }
        policyFingerprint = NEXT_POLICY_FINGERPRINT;
        return { ok: true, rules: copy(rules), policyFingerprint };
      },
    },
  };
}

const options = (wrapper) => wrapper.findAll('.task-reply-option');
const agentOptions = (wrapper) => wrapper.findAll('.agent-search-option');
const rulesSave = (wrapper) => wrapper.find('.savebar .btn.primary');

test('старое правило остаётся молчащим и объясняет ручной и автоматический flow', async (t) => {
  const old = rule();
  delete old.notifyTaskCreated;
  const srv = server([old]);
  const { wrapper } = await mountTelegramView(t, {
    api: srv.api,
    prefix: 'task-reply-old',
  });

  assert.equal(options(wrapper).length, 1);
  assert.equal(options(wrapper)[0].get('input').element.checked, false);
  assert.match(options(wrapper)[0].text(), /ручной или автоматической постановки/i);
  assert.equal(rulesSave(wrapper).exists(), false, 'открытие старого правила не создаёт dirty-state');
  assert.deepEqual(srv.puts, []);
});

test('старое правило закрыто агенту и не создаёт dirty-state', async (t) => {
  const old = rule();
  delete old.agentSearch;
  const srv = server([old]);
  const { wrapper } = await mountTelegramView(t, {
    api: srv.api,
    prefix: 'agent-search-old',
  });

  assert.equal(agentOptions(wrapper).length, 1);
  assert.equal(agentOptions(wrapper)[0].get('input').element.checked, false);
  assert.match(agentOptions(wrapper)[0].text(), /агент/i);
  assert.equal(rulesSave(wrapper).exists(), false);
  assert.deepEqual(srv.puts, []);
});

test('agentSearch включается только у выбранного правила и уезжает с policy CAS', async (t) => {
  const srv = server([
    rule(),
    rule({ chatId: -100999, threadId: 77, title: 'Идеи · тема 77', kind: 'wish' }),
  ]);
  const { wrapper, flushPromises } = await mountTelegramView(t, {
    api: srv.api,
    prefix: 'agent-search-save',
  });

  await agentOptions(wrapper)[0].get('input').setValue(true);
  await settle(flushPromises);
  assert.equal(agentOptions(wrapper)[1].get('input').element.checked, false);

  assert.equal(srv.puts.length, 1);
  assert.equal(srv.puts[0].url, '/api/telegram/rules/agent-search');
  assert.equal(srv.puts[0].body.botId, 42);
  assert.equal(srv.puts[0].body.expectedPolicyFingerprint, POLICY_FINGERPRINT);
  assert.equal(srv.puts[0].body.enabled, true);
  assert.deepEqual(srv.puts[0].body.rule, {
    project: 'demo', chatId: -100123, username: null, threadId: null,
  });
  assert.equal(agentOptions(wrapper)[0].get('input').element.checked, true);
  assert.equal(rulesSave(wrapper).exists(), false, 'отдельный opt-in не ждёт общего Save');
});

test('enable agentSearch требует отдельного подтверждения', async (t) => {
  const srv = server([rule()]);
  const { wrapper, flushPromises } = await mountTelegramView(t, {
    api: srv.api,
    confirm: async () => false,
    prefix: 'agent-search-confirm',
  });

  await agentOptions(wrapper)[0].get('input').setValue(true);
  await settle(flushPromises);

  assert.deepEqual(srv.puts, [], 'отмена подтверждения не должна менять policy');
  assert.equal(agentOptions(wrapper)[0].get('input').element.checked, false);
});

test('подтверждение включается только у выбранного правила и сохраняется с bot CAS', async (t) => {
  const srv = server([
    rule(),
    rule({ chatId: -100999, threadId: 77, title: 'Идеи · тема 77', kind: 'wish' }),
  ]);
  const { wrapper, flushPromises } = await mountTelegramView(t, {
    api: srv.api,
    prefix: 'task-reply-save',
  });

  await options(wrapper)[0].get('input').setValue(true);
  assert.equal(options(wrapper)[1].get('input').element.checked, false);
  assert.equal(rulesSave(wrapper).exists(), true, 'тумблер должен сделать правило изменённым');
  assert.equal(rulesSave(wrapper).element.disabled, false);
  await rulesSave(wrapper).trigger('click');
  await settle(flushPromises);

  const shownError = wrapper.find('.err');
  assert.equal(shownError.exists(), false, shownError.exists() ? shownError.text() : '');
  assert.equal(srv.puts.length, 1);
  assert.equal(srv.puts[0].url, '/api/telegram/rules');
  assert.equal(srv.puts[0].body.botId, 42);
  assert.equal(srv.puts[0].body.rules[0].notifyTaskCreated, true);
  assert.equal(srv.puts[0].body.rules[1].notifyTaskCreated, false);
  assert.equal(srv.puts[0].body.rules[0].agentSearch, undefined,
    'обычный rules PUT не владеет agentSearch');
  assert.equal(rulesSave(wrapper).exists(), false, 'успешное сохранение гасит dirty-state');
});

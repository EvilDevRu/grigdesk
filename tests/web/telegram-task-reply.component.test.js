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
    autoTask: { enabled: false, minConfidence: 0.7, maxPerDay: 10 },
    autoLaunch: { enabled: false, route: '', minConfidence: 0.8, maxPerDay: 3, vetoMinutes: 10 },
    ...over,
  };
}

function server(initialRules) {
  const puts = [];
  let rules = structuredClone(initialRules);
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
          return { rules: copy(rules), projects: ['demo'] };
        }
        if (url === '/api/b24/users') return { users: [] };
        if (url === '/api/b24/groups') return { groups: [] };
        return {};
      },
      async post() { return {}; },
      async put(url, body) {
        puts.push({ url, body: copy(body) });
        rules = copy(body.rules);
        return { ok: true, rules: copy(rules) };
      },
    },
  };
}

const options = (wrapper) => wrapper.findAll('.task-reply-option');
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
  assert.equal(rulesSave(wrapper).exists(), false, 'успешное сохранение гасит dirty-state');
});

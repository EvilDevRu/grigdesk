// Редактор правил «чат или тема → проект» в разделе «Телеграм».
//
// Правило — это РАЗРЕШЕНИЕ читать чат (allowlist фазы 2 плана), поэтому проверки
// здесь не про удобство формы: чат не должен разрешаться сам собой, снятое правило
// не должно уезжать на сервер до нажатия «Сохранить», а правило, которого редактор
// показывает не целиком (b24, автозапуск), не должно терять невидимые поля.
import assert from 'node:assert/strict';
import test from 'node:test';
import { apiError, mountTelegramView, settle } from './helpers/telegram-view.js';

process.env.NODE_ENV = 'test';

const CHAT = -1001000000042;
const T0 = Date.UTC(2026, 7, 7, 10, 0, 0) / 1000;

const BOT = {
  configured: true,
  botId: 8123456789,
  username: 'example_inbox_bot',
  firstName: 'GrigDesk · входящие',
  canReadAllGroupMessages: true,
  tokenHint: '…v5u6',
  connectedAt: Date.parse('2026-08-07T10:00:00Z'),
  privacyHint: '',
};

const POLL = {
  running: true, offset: 43, lastPollAt: Date.parse('2026-08-07T12:00:00Z'),
  lastMessageAt: T0 * 1000, conflict: false, lastError: null,
};

const CHATS = [
  { id: CHAT, title: 'Команда Альфа · разработка', type: 'supergroup', isForum: true, messages: 3, lastAt: T0 },
  { id: 5551234, title: 'Иван', type: 'private', isForum: false, messages: 1, lastAt: T0 - 3600 },
];
const TOPICS = [
  { id: 42, title: 'Баги', messages: 7, lastAt: T0 },
  { id: 77, title: 'Идеи', messages: 3, lastAt: T0 - 60 },
];
const POLICY_FINGERPRINT = `telegram-rules-v1:${'5'.repeat(64)}`;
const NEXT_POLICY_FINGERPRINT = `telegram-rules-v1:${'6'.repeat(64)}`;

/** Правило в том виде, в каком его отдаёт сервер (нормализованное целиком). */
function rule(over = {}) {
  return {
    project: 'demo',
    chatId: CHAT,
    username: null,
    title: 'Команда Альфа · разработка',
    threadId: null,
    kind: 'bug',
    b24: { responsibleId: null, groupId: null, priority: 1 },
    draft: 'manual',
    autoLaunch: { enabled: false, route: '', minConfidence: 0.8, maxPerDay: 3, vetoMinutes: 10 },
    ...over,
  };
}

/**
 * Сервер раздела: статус, чаты и правила. `puts` копит тела PUT — по ним и видно,
 * что именно редактор считает правилом.
 */
function server({
  rules = [],
  projects = ['demo', 'shop'],
  groups = [{ id: 101, name: 'Проект Альфа' }],
  topics = TOPICS,
  onPut = null,
} = {}) {
  const calls = [];
  const puts = [];
  return {
    calls,
    puts,
    api: {
      async get(url) {
        calls.push(['GET', url]);
        if (url.endsWith('/chats')) return { chats: CHATS };
        if (url.endsWith('/topics')) return { topics };
        if (url.endsWith('/groups')) return { groups };
        if (url.endsWith('/users')) return { users: [] };
        // Копия, как у настоящего api-client (там всё приходит из JSON.parse):
        // иначе правка «на месте» меняла бы и то, что якобы лежит на сервере.
        if (url.endsWith('/rules')) {
          return { rules: structuredClone(rules), projects, policyFingerprint: POLICY_FINGERPRINT };
        }
        return { bot: BOT, poll: POLL };
      },
      async post(url) {
        calls.push(['POST', url]);
        return { ok: true, bot: BOT, poll: POLL };
      },
      async put(url, body) {
        calls.push(['PUT', url]);
        puts.push(body);
        if (onPut) return onPut(body);
        return { ok: true, rules: body.rules, policyFingerprint: NEXT_POLICY_FINGERPRINT };
      },
    },
  };
}

const mountView = (t, opts) => mountTelegramView(t, { ...opts, prefix: 'rules' });

const btn = (wrapper, text) => wrapper.findAll('button').find((b) => b.text().includes(text));
const saveBtn = (wrapper) => btn(wrapper, 'Сохранить');
const chatSelect = (row) => row.get('.ui-select-wrap:has(.chat-select) select');
const topicSelect = (row) => row.get('.ui-select-wrap:has(.topic-select) select');
const projectSelect = (row) => row.get('.ui-select-wrap:has(.project-select) select');
const trackerGroupSelect = (row) => row.get('.ui-select-wrap:has(.tracker-group-select) select');

test('правил нет — раздел говорит, что закрыты все чаты, и ничего не сохраняет сам', async (t) => {
  const srv = server();
  const { wrapper } = await mountView(t, { api: srv.api });

  // Пустой allowlist — это «читать нельзя нигде», и человек должен понимать это
  // до того, как удивится неразвёрнутой ссылке.
  assert.match(wrapper.text(), /ни один чат не разрешён/i);
  assert.equal(wrapper.findAll('.rule').length, 0);
  assert.equal(Boolean(saveBtn(wrapper)), false, 'кнопка сохранения при нетронутых правилах');
  assert.deepEqual(srv.puts, [], 'открытие раздела записало правила');
});

test('правило добавляется чатом из услышанных: на сервер уезжает id, а не подпись', async (t) => {
  const srv = server();
  const { wrapper, flushPromises } = await mountView(t, { api: srv.api });

  await btn(wrapper, 'Добавить').trigger('click');
  const row = wrapper.get('.rule');
  await chatSelect(row).setValue(`id:${CHAT}`);
  await projectSelect(row).setValue('shop');
  // Пока не нажали «Сохранить», на сервере ничего не меняется.
  assert.deepEqual(srv.puts, []);

  await saveBtn(wrapper).trigger('click');
  await settle(flushPromises);

  assert.equal(srv.puts.length, 1);
  const [saved] = srv.puts[0].rules;
  assert.equal(saved.chatId, CHAT, 'id чата должен быть числом, как в архиве');
  assert.equal(saved.project, 'shop');
  assert.equal(saved.threadId, null, 'пустое поле темы значит «весь чат»');
  // Подпись чата кладём в правило: бота могут убрать из чата, и имени взять
  // будет негде, а правило останется.
  assert.equal(saved.title, 'Команда Альфа · разработка');
  // Сохранили — несохранённого не осталось.
  assert.equal(Boolean(saveBtn(wrapper)), false);
});

test('услышанные темы подгружаются сами и выбранная уезжает числом', async (t) => {
  const srv = server();
  const { wrapper, flushPromises } = await mountView(t, { api: srv.api });

  await btn(wrapper, 'Добавить').trigger('click');
  const row = wrapper.get('.rule');
  await chatSelect(row).setValue(`id:${CHAT}`);
  await settle(flushPromises);

  assert.match(topicSelect(row).text(), /Баги · тема 42/);
  assert.match(topicSelect(row).text(), /Идеи · тема 77/);
  await topicSelect(row).setValue('42');
  await projectSelect(row).setValue('demo');
  await saveBtn(wrapper).trigger('click');
  await settle(flushPromises);

  assert.equal(srv.puts[0].rules[0].threadId, 42);
  assert.ok(srv.calls.some(([method, url]) => method === 'GET' && url.endsWith(`/chats/${CHAT}/topics`)));
  assert.match(wrapper.text(), /соседн/i, 'не сказано, что правило темы не открывает соседние');
});

test('неуслышанную тему по-прежнему можно указать номером вручную', async (t) => {
  const srv = server({ topics: [] });
  const { wrapper, flushPromises } = await mountView(t, { api: srv.api });

  await btn(wrapper, 'Добавить').trigger('click');
  const row = wrapper.get('.rule');
  await chatSelect(row).setValue(`id:${CHAT}`);
  await projectSelect(row).setValue('demo');
  await row.findAll('input')
    .find((i) => (i.attributes('placeholder') || '').startsWith('тема'))
    .setValue('91');
  await saveBtn(wrapper).trigger('click');
  await settle(flushPromises);

  assert.equal(srv.puts[0].rules[0].threadId, 91);
});

// Правило редактор показывает НЕ целиком: черновик и автозапуск приедут поздними
// фазами. Пока их нет в форме, они обязаны переживать сохранение — иначе первая же
// правка чата обнулила бы то, что человек прописал в файле руками.
test('поля, которых нет в форме, при сохранении не теряются', async (t) => {
  const rich = rule({
    kind: 'wish',
    draft: 'auto',
    b24: { responsibleId: 17, groupId: 3, priority: 2 },
    autoLaunch: { enabled: true, route: 'feature', minConfidence: 0.9, maxPerDay: 1, vetoMinutes: 30 },
  });
  const srv = server({ rules: [rich] });
  const { wrapper, flushPromises } = await mountView(t, { api: srv.api });

  await projectSelect(wrapper.get('.rule')).setValue('shop');
  await saveBtn(wrapper).trigger('click');
  await settle(flushPromises);

  const [saved] = srv.puts[0].rules;
  assert.equal(saved.project, 'shop');
  assert.equal(saved.kind, 'wish');
  assert.equal(saved.draft, 'auto');
  assert.deepEqual(saved.b24, { responsibleId: 17, groupId: 3, priority: 2 });
  assert.deepEqual(saved.autoLaunch, {
    enabled: true, route: 'feature', minConfidence: 0.9, maxPerDay: 1, vetoMinutes: 30,
  });
});

test('публичный чат привязывается именем — иначе ссылку t.me/имя нечем сопоставить', async (t) => {
  const srv = server();
  const { wrapper, flushPromises } = await mountView(t, { api: srv.api });

  await btn(wrapper, 'Добавить').trigger('click');
  const row = wrapper.get('.rule');
  await chatSelect(row).setValue('name');
  // Ищем поле по подсказке, а не по номеру: полей в строке прибавляется (тема,
  // группа портала), и «первый input» переставал бы значить то же самое.
  const nameInput = row.findAll('input').find((i) => i.attributes('placeholder') === 'имя_чата');
  assert.ok(nameInput, 'поле имени чата не появилось');
  await nameInput.setValue('@example_team');
  await projectSelect(row).setValue('demo');
  await saveBtn(wrapper).trigger('click');
  await settle(flushPromises);

  const [saved] = srv.puts[0].rules;
  assert.equal(saved.username, '@example_team', 'имя чата уехало не так, как введено');
  assert.equal(saved.chatId, null);
});

test('правило чата, которого бот больше не слышит, видно и его можно снять', async (t) => {
  const gone = rule({ chatId: -100777000, title: 'Старый чат' });
  const srv = server({ rules: [gone] });
  const { wrapper, flushPromises } = await mountView(t, { api: srv.api });

  // Чата нет ни в архиве, ни в списке услышанных — но правило действует, значит
  // оно обязано быть на экране: иначе разрешение не отозвать.
  const row = wrapper.get('.rule');
  assert.match(row.text(), /Старый чат/);
  assert.equal(chatSelect(row).element.value, 'id:-100777000');

  await btn(row, '×').trigger('click');
  await saveBtn(wrapper).trigger('click');
  await settle(flushPromises);
  assert.deepEqual(srv.puts[0].rules, [], 'снятое правило не ушло с сервера');
});

test('проект, которого нет в списке, не подменяется молча', async (t) => {
  const srv = server({ rules: [rule({ project: 'archived' })], projects: ['demo', 'shop'] });
  const { wrapper } = await mountView(t, { api: srv.api });

  // Пустой селект означал бы «проект не выбран», и первое же сохранение увело бы
  // правило в другой проект. Показываем как есть.
  assert.equal(projectSelect(wrapper.get('.rule')).element.value, 'archived');
});

test('проект Битрикс24 выбирается по имени, а в правило уезжает числовой id', async (t) => {
  const srv = server({ groups: [
    { id: 101, name: 'Проект Альфа' },
    { id: 44, name: 'Магазин' },
  ] });
  const { wrapper, flushPromises } = await mountView(t, { api: srv.api });

  await btn(wrapper, 'Добавить').trigger('click');
  const row = wrapper.get('.rule');

  assert.match(trackerGroupSelect(row).text(), /Проект Альфа/);
  assert.match(trackerGroupSelect(row).text(), /Магазин/);

  await chatSelect(row).setValue(`id:${CHAT}`);
  await projectSelect(row).setValue('demo');
  await trackerGroupSelect(row).setValue('101');
  await saveBtn(wrapper).trigger('click');
  await settle(flushPromises);

  assert.equal(srv.puts[0].rules[0].b24.groupId, 101);
  assert.equal(typeof srv.puts[0].rules[0].b24.groupId, 'number');
});

test('недоступный сохранённый проект Битрикс24 остаётся выбранным', async (t) => {
  const saved = rule({ b24: { responsibleId: null, groupId: 99, priority: 1 } });
  const srv = server({ rules: [saved], groups: [{ id: 101, name: 'Проект Альфа' }] });
  const { wrapper } = await mountView(t, { api: srv.api });

  const select = trackerGroupSelect(wrapper.get('.rule'));
  assert.equal(select.element.value, '99');
  assert.match(select.text(), /Проект #99.*сохранён/);
});

test('отказ сервера виден его же текстом, а правки остаются на экране', async (t) => {
  const srv = server({
    onPut() {
      throw apiError(400, { error: 'bad_rules', message: 'Правило 1: проект «demo» не найден.' });
    },
  });
  const { wrapper, flushPromises } = await mountView(t, { api: srv.api });

  await btn(wrapper, 'Добавить').trigger('click');
  const row = wrapper.get('.rule');
  await chatSelect(row).setValue(`id:${CHAT}`);
  await projectSelect(row).setValue('demo');
  await saveBtn(wrapper).trigger('click');
  await settle(flushPromises);

  assert.match(wrapper.get('.err').text(), /Правило 1: проект «demo» не найден\./);
  assert.equal(wrapper.findAll('.rule').length, 1, 'правка пропала после отказа');
  assert.ok(saveBtn(wrapper), 'кнопка сохранения пропала, хотя ничего не сохранилось');
});

test('«Отменить» возвращает то, что лежит на сервере', async (t) => {
  const srv = server({ rules: [rule()] });
  const { wrapper, flushPromises } = await mountView(t, { api: srv.api });

  await projectSelect(wrapper.get('.rule')).setValue('shop');
  assert.ok(saveBtn(wrapper), 'правка не считается несохранённой');

  await btn(wrapper, 'Отменить').trigger('click');
  await settle(flushPromises);

  assert.equal(projectSelect(wrapper.get('.rule')).element.value, 'demo');
  assert.equal(Boolean(saveBtn(wrapper)), false);
  assert.deepEqual(srv.puts, [], 'отмена что-то записала');
});

test('agentSearch после потерянного ответа PUT подтверждает фактический commit через GET', async (t) => {
  const stored = [rule({ agentSearch: false })];
  const srv = server({
    rules: stored,
    onPut() {
      stored[0].agentSearch = true; // commit прошёл, а HTTP-ответ потерялся
      throw new Error('Связь оборвалась.');
    },
  });
  const { wrapper, flushPromises } = await mountView(t, { api: srv.api });

  await wrapper.get('.agent-search-option input').setValue(true);
  await settle(flushPromises);

  assert.equal(srv.calls.filter(([method, url]) => method === 'GET' && url.endsWith('/rules')).length, 2);
  assert.equal(wrapper.get('.agent-search-option input').element.checked, true);
  assert.match(wrapper.text(), /повторная проверка.*подтвердила.*разрешён/iu);
});

test('agentSearch после ошибки PUT показывает authoritative отказ, а не запрошенный enable', async (t) => {
  const stored = [rule({ agentSearch: false })];
  const srv = server({
    rules: stored,
    onPut() { throw new Error('Запрос отклонён.'); },
  });
  const { wrapper, flushPromises } = await mountView(t, { api: srv.api });

  await wrapper.get('.agent-search-option input').setValue(true);
  await settle(flushPromises);

  assert.equal(wrapper.get('.agent-search-option input').element.checked, false);
  assert.match(wrapper.get('.err').text(),
    /повторная проверка.*закрыт.*запрошенное включение не применено/iu);
});

test('agentSearch отключается и явно показывает unknown, если после PUT не удался и GET', async (t) => {
  let mutationStarted = false;
  const stored = [rule({ agentSearch: true })];
  const srv = server({
    rules: stored,
    onPut() {
      mutationStarted = true;
      throw new Error('Связь оборвалась.');
    },
  });
  const get = srv.api.get.bind(srv.api);
  srv.api.get = async (url) => {
    if (mutationStarted && url.endsWith('/rules')) {
      srv.calls.push(['GET', url]);
      throw new Error('Не удалось перечитать rules.');
    }
    return get(url);
  };
  const { wrapper, flushPromises } = await mountView(t, { api: srv.api });

  await wrapper.get('.agent-search-option input').setValue(false);
  await settle(flushPromises);

  const checkbox = wrapper.get('.agent-search-option input');
  assert.equal(srv.puts.length, 1);
  assert.equal(checkbox.element.checked, false);
  assert.equal(checkbox.element.disabled, true, 'без authoritative fingerprint новый PUT запрещён');
  assert.match(wrapper.get('[data-state="agent-search-unknown"]').text(),
    /состояние доступа.*не подтверждено.*неизвестно/iu);
});

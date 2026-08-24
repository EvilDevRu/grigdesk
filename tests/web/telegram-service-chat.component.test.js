// Выбор служебного чата в разделе «Телеграм».
//
// Служебный чат — это адрес, куда бот пересылает сам себе чужую рабочую
// переписку (копия удаляется сразу же). Поэтому проверки тут не про удобство
// селекта, а про то, что туда нельзя случайно поставить лишнее:
//  • в списке только личка, которую бот уже слышал: групповой чат показал бы
//    служебную копию всем участникам, а произвольный номер — это «шли переписку,
//    куда скажу»;
//  • ничего не сохраняется само: адрес уезжает только по кнопке;
//  • отказ сервера не оставляет на экране выбор, которого сервер не принял.
import assert from 'node:assert/strict';
import test from 'node:test';
import { apiError, mountTelegramView, settle } from './helpers/telegram-view.js';

process.env.NODE_ENV = 'test';

const GROUP = -1001000000042;   // явно синтетический рабочий чат — служебным быть не может
const OWNER = 5551234;          // личка хозяина
const T0 = Date.UTC(2026, 7, 7, 10, 0, 0) / 1000;

const bot = (over = {}) => ({
  configured: true,
  botId: 8123456789,
  username: 'example_inbox_bot',
  firstName: 'Кокпит · входящие',
  canReadAllGroupMessages: true,
  tokenHint: '…v5u6',
  connectedAt: Date.parse('2026-08-07T10:00:00Z'),
  privacyHint: '',
  serviceChatId: null,
  serviceChatTitle: '',
  ...over,
});

const POLL = {
  running: true, offset: 43, lastPollAt: Date.parse('2026-08-07T12:00:00Z'),
  lastMessageAt: T0 * 1000, conflict: false, lastError: null,
};

const CHATS = [
  { id: GROUP, title: 'Команда Альфа · разработка', type: 'supergroup', isForum: true, messages: 3, lastAt: T0 },
  { id: OWNER, title: 'Тестовый пользователь', type: 'private', isForum: false, messages: 1, lastAt: T0 - 3600 },
];

/**
 * Сервер раздела. `posts` копит тела — по ним и видно, что уехало наружу; сам
 * адрес хранится вместе с токеном, поэтому ответом всегда идёт свежий `bot`.
 */
function server({ saved = bot(), chats = CHATS, onPost = null } = {}) {
  const posts = [];
  let current = saved;
  return {
    posts,
    api: {
      async get(url) {
        if (url.endsWith('/chats')) return { chats: structuredClone(chats) };
        if (url.endsWith('/rules')) return { rules: [], projects: ['demo'] };
        return { bot: structuredClone(current), poll: POLL };
      },
      async post(url, body) {
        posts.push({ url, body });
        if (onPost) return onPost(body);
        const chat = chats.find((c) => c.id === body.chatId);
        current = bot({
          serviceChatId: body.chatId ?? null,
          serviceChatTitle: chat?.title || '',
        });
        return { ok: true, bot: structuredClone(current) };
      },
      async put() { return { ok: true, rules: [] }; },
    },
  };
}

const mountView = (t, opts) => mountTelegramView(t, { ...opts, prefix: 'service' });

/** Карточка служебного чата: свой селект и своя кнопка сохранения. */
function card(wrapper) {
  const box = wrapper.findAll('.card').find((c) => c.text().includes('Служебный чат'));
  assert.ok(box, 'карточки служебного чата нет на экране');
  return box;
}
const select = (wrapper) => card(wrapper).get('select');
const saveBtn = (wrapper) => card(wrapper).findAll('button').find((b) => b.text().includes('Сохранить'));
const optionValues = (wrapper) => select(wrapper).findAll('option').map((o) => o.element.value);

test('в списке только личка: групповой чат служебным не назначить', async (t) => {
  const srv = server();
  const { wrapper } = await mountView(t, { api: srv.api });

  // Групповой чат бот слышит, и он есть выше в «Что слышит бот» — но выбрать его
  // служебным нельзя: копию там увидят все участники.
  assert.deepEqual(optionValues(wrapper), ['', String(OWNER)]);
  assert.ok(!card(wrapper).text().includes('Команда Альфа'), 'групповой чат попал в выбор');
  // Пока не выбран — сказано, что ссылки останутся неразвёрнутыми.
  assert.match(card(wrapper).text(), /неразвёрнут/i);
  assert.deepEqual(srv.posts, [], 'открытие раздела что-то сохранило');
});

test('адрес уезжает числом и только по кнопке', async (t) => {
  const srv = server();
  const { wrapper, flushPromises } = await mountView(t, { api: srv.api });

  assert.equal(Boolean(saveBtn(wrapper)), false, 'кнопка сохранения при нетронутом выборе');
  await select(wrapper).setValue(String(OWNER));
  assert.deepEqual(srv.posts, [], 'выбор уехал на сервер до нажатия кнопки');

  await saveBtn(wrapper).trigger('click');
  await settle(flushPromises);

  assert.equal(srv.posts.length, 1);
  assert.equal(srv.posts[0].url, '/api/telegram/service-chat');
  assert.equal(srv.posts[0].body.botId, 8123456789, 'provider identity служит CAS старой формы');
  assert.equal(srv.posts[0].body.chatId, OWNER, 'id чата должен быть числом, как в архиве');
  assert.equal(Boolean(saveBtn(wrapper)), false, 'кнопка осталась, хотя всё сохранено');
  assert.match(wrapper.get('.ok').text(), /Тестовый пользователь/);
});

test('«не выбран» снимает адрес, а не оставляет прежний', async (t) => {
  const srv = server({ saved: bot({ serviceChatId: OWNER, serviceChatTitle: 'Тестовый пользователь' }) });
  const { wrapper, flushPromises } = await mountView(t, { api: srv.api });

  assert.equal(select(wrapper).element.value, String(OWNER));
  await select(wrapper).setValue('');
  await saveBtn(wrapper).trigger('click');
  await settle(flushPromises);

  // null, а не пустая строка и не 0: сервер снимает привязку именно по нему.
  assert.equal(srv.posts[0].body.chatId, null);
  assert.equal(select(wrapper).element.value, '');
});

test('назначенный чат виден в селекте, даже если бот его больше не слышит', async (t) => {
  // Иначе селект показывал бы «не выбран» при работающей пересылке — и человек
  // назначил бы второй адрес, не понимая, куда уходит первый.
  const srv = server({
    saved: bot({ serviceChatId: 777000222, serviceChatTitle: 'Старая личка' }),
    chats: [CHATS[0]],
  });
  const { wrapper } = await mountView(t, { api: srv.api });

  assert.equal(select(wrapper).element.value, '777000222');
  assert.match(card(wrapper).text(), /Старая личка/);
  assert.equal(Boolean(saveBtn(wrapper)), false, 'показ сохранённого адреса выглядит как правка');
});

test('отказ сервера виден его текстом, а выбор откатывается к сохранённому', async (t) => {
  const srv = server({
    onPost() {
      throw apiError(400, {
        error: 'bad_service_chat',
        message: 'Служебным может быть только личка, из которой бот уже получал сообщения.',
      });
    },
  });
  const { wrapper, flushPromises } = await mountView(t, { api: srv.api });

  await select(wrapper).setValue(String(OWNER));
  await saveBtn(wrapper).trigger('click');
  await settle(flushPromises);

  assert.match(wrapper.get('.err').text(), /только личка/i);
  // На экране не должно остаться выбора, которого сервер не принял: иначе раздел
  // показывал бы настроенную пересылку, которой нет.
  assert.equal(select(wrapper).element.value, '');
  assert.equal(Boolean(saveBtn(wrapper)), false);
});

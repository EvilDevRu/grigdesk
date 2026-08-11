// Раздел «Телеграм»: подключение бота формой вместо терминала.
// Смысл проверок — цена ошибки здесь та же, что у файла с токеном: непроверенный
// токен не должен выглядеть подключённым, отказ обязан доехать до человека словами
// сервера, а «Отключить» (стирание рабочего ключа) — только после подтверждения.
import assert from 'node:assert/strict';
import test from 'node:test';
import { apiError, mountTelegramView, settle } from './helpers/telegram-view.js';

process.env.NODE_ENV = 'test';

const TOKEN = '8123456789:AAHrEaLLyLoNgSeCrEtPaRt_x1y2z3w4v5u6';
/** Дата сообщения — СЕКУНДЫ Bot API (в состоянии опроса те же времена в мс). */
const T0 = Date.UTC(2026, 7, 7, 10, 0, 0) / 1000;

/** Живой опрос: ошибок нет, последнее сообщение только что. */
const POLL_LIVE = {
  running: true,
  offset: 43,
  lastPollAt: Date.parse('2026-08-07T12:00:00Z'),
  lastMessageAt: T0 * 1000,
  conflict: false,
  lastError: null,
};

/** Ответ сервера про подключённого бота (форма — как у modules/telegram). */
function botView(over = {}) {
  return {
    configured: true,
    botId: 8123456789,
    username: 'example_inbox_bot',
    firstName: 'Кокпит · входящие',
    canReadAllGroupMessages: false,
    tokenHint: '…v5u6',
    connectedAt: Date.parse('2026-08-07T10:00:00Z'),
    privacyHint: 'В группах бот сейчас видит только сообщения, адресованные ему.',
    ...over,
  };
}

const EMPTY_BOT = { configured: false, botId: 0, username: '', tokenHint: '', privacyHint: '' };

const mountView = (t, opts) => mountTelegramView(t, { ...opts, prefix: 'connect' });

test('выключенный плагин: заглушка вместо формы, а 404 от сервера не показывается ошибкой', async (t) => {
  const calls = [];
  const api = {
    async get(url) {
      calls.push(['GET', url]);
      throw apiError(404, { error: 'plugin_disabled', message: 'Плагин «Телеграм» выключен.' });
    },
    async post() { assert.fail('выключенный раздел ничего не отправляет'); },
  };
  const { wrapper } = await mountView(t, { api, pluginEnabled: false });

  assert.match(wrapper.text(), /Настройки → Плагины/);
  assert.equal(wrapper.find('input').exists(), false, 'поле токена у выключенного плагина');
  // 404 plugin_disabled — это состояние, а не поломка: красную плашку показывать не за что.
  assert.equal(wrapper.find('.err').exists(), false);
});

test('форма подключает бота: пробелы срезаны, вместо инструкции — карточка, токен в поле не остаётся', async (t) => {
  const calls = [];
  const api = {
    async get(url) {
      calls.push(['GET', url]);
      if (url.endsWith('/chats')) return { chats: [] };
      if (url.endsWith('/rules')) return { rules: [], projects: [] };
      if (url.endsWith('/users')) return { users: [] };
      if (url.endsWith('/groups')) return { groups: [] };
      return { bot: { ...EMPTY_BOT }, poll: null };
    },
    async post(url, body) {
      calls.push(['POST', url, body]);
      return { ok: true, bot: url.endsWith('/connect') ? botView() : { ...EMPTY_BOT }, poll: null };
    },
  };
  const { wrapper, flushPromises } = await mountView(t, { api });

  // Первое знакомство не свалено в длинную инструкцию: действие в Телеграме и
  // действие в кокпите стоят двумя отдельными шагами, а следующий путь виден заранее.
  assert.equal(wrapper.findAll('.setup-card').length, 2);
  assert.match(wrapper.text(), /Что произойдёт после подключения/);
  assert.match(wrapper.get('[data-state="provider-disconnected"]').text(), /только для чтения/);

  const input = wrapper.get('input');
  const connectBtn = wrapper.findAll('button').find((b) => b.text() === 'Подключить');
  // Пустое поле — нечего проверять, и в сеть ходить незачем.
  assert.equal(connectBtn.attributes('disabled'), '');

  await input.setValue(`  ${TOKEN}  `);
  await connectBtn.trigger('click');
  await settle(flushPromises);

  // Пока бот не подключён, за чатами и правилами не ходим вовсе: их неоткуда
  // взять, а справочники портала нужны ровно карточке разрешённых чатов.
  assert.deepEqual(calls, [
    ['GET', '/api/telegram/status'],
    ['POST', '/api/telegram/connect', { token: TOKEN }],
    ['GET', '/api/telegram/chats'],
    ['GET', '/api/telegram/rules'],
    ['GET', '/api/b24/users'],
    ['GET', '/api/b24/groups'],
  ]);
  assert.match(wrapper.text(), /@example_inbox_bot/);
  assert.match(wrapper.text(), /…v5u6/);
  assert.match(wrapper.get('.ok').text(), /подключён/);
  assert.equal(wrapper.find('input').exists(), false, 'после подключения форма токена не нужна');

  // Проверенный токен уже на сервере, в браузере ему делать нечего: после
  // отключения поле возвращается пустым, а не с прежним секретом.
  await wrapper.findAll('button').find((b) => b.text() === 'Отключить').trigger('click');
  await settle(flushPromises);
  assert.equal(wrapper.get('input').element.value, '');
});

test('отказ Телеграма: текст сервера виден как есть, форма остаётся, «подключено» не показываем', async (t) => {
  const api = {
    async get() { return { bot: { ...EMPTY_BOT } }; },
    async post() {
      throw apiError(400, {
        error: 'telegram_rejected',
        message: 'Телеграм не принял токен …v5u6: Unauthorized.',
      });
    },
  };
  const { wrapper, flushPromises } = await mountView(t, { api });

  await wrapper.get('input').setValue(TOKEN);
  await wrapper.findAll('button').find((b) => b.text() === 'Подключить').trigger('click');
  await settle(flushPromises);

  // Формулировку придумывает сервер — он один знает, какой это был отказ.
  assert.equal(wrapper.get('.err').text(), 'Телеграм не принял токен …v5u6: Unauthorized.');
  assert.equal(wrapper.find('input').exists(), true, 'форма пропала после неудачи');
  assert.equal(wrapper.find('.ok').exists(), false);
});

test('включённый режим приватности виден предупреждением, «Проверить» переспрашивает Телеграм', async (t) => {
  const calls = [];
  const api = {
    async get(url) {
      calls.push(url);
      if (url.endsWith('/chats')) return { chats: [] };
      if (url.endsWith('/rules')) return { rules: [], projects: [] };
      if (url.endsWith('/users')) return { users: [] };
      if (url.endsWith('/groups')) return { groups: [] };
      return { bot: botView(), poll: POLL_LIVE };
    },
    async post(url) {
      calls.push(url);
      return { ok: true, bot: botView({ canReadAllGroupMessages: true, privacyHint: '' }), poll: POLL_LIVE };
    },
  };
  const { wrapper, flushPromises } = await mountView(t, { api });

  // Пока приватность включена, бот в группе не увидит ни одной жалобы — это должно
  // читаться сразу, а не быть галочкой в углу.
  const warn = wrapper.get('.state.warn');
  assert.match(warn.text(), /не видит переписку в группах/);
  assert.match(warn.text(), /адресованные ему/);

  await wrapper.findAll('button').find((b) => b.text() === 'Проверить').trigger('click');
  await settle(flushPromises);

  // Перепроверка правил не касается: они на сервере и с токеном не связаны —
  // поэтому после «Проверить» перечитываются только native-чаты. Общий Inbox
  // имеет свой API и с Telegram-страницы не читается.
  assert.deepEqual(calls, [
    '/api/telegram/status', '/api/telegram/chats', '/api/telegram/rules',
    '/api/b24/users', '/api/b24/groups',
    '/api/telegram/recheck', '/api/telegram/chats',
  ]);
  assert.equal(wrapper.find('.state.warn').exists(), false);
  assert.match(wrapper.get('.state.good').text(), /Режим приватности выключен/);
  assert.match(wrapper.get('.ok').text(), /целиком/);
});

test('подключённый бот показывает, что он уже слышал, и в каких это чатах', async (t) => {
  const api = {
    async get(url) {
      if (url.endsWith('/chats')) {
        return {
          chats: [
            { id: -1001000000042, title: 'Команда Альфа · разработка', type: 'supergroup', isForum: true, messages: 3, lastAt: T0 },
            { id: 5551234, title: '', type: 'private', isForum: false, messages: 1, lastAt: T0 - 3600 },
          ],
        };
      }
      return { bot: botView({ canReadAllGroupMessages: true, privacyHint: '' }), poll: POLL_LIVE };
    },
    async post() { assert.fail('просмотр списка ничего не отправляет'); },
  };
  const { wrapper } = await mountView(t, { api });

  // Telegram показывает только native provider/stores. Очередь вынесена на
  // отдельный маршрут общего Inbox, а короткий маршрут настройки остаётся.
  assert.equal(wrapper.findAll('.path-step').length, 3);
  assert.equal(wrapper.find('.tg-grid').exists(), true);
  assert.equal(wrapper.find('.inbox-card').exists(), false);
  assert.equal(wrapper.get('a[href="#/inbox"]').exists(), true);
  assert.equal(wrapper.find('.side-stack').exists(), true);
  assert.equal(wrapper.find('.rules-card').exists(), true);

  // Идущий опрос — не то же самое, что подключённый бот: токен может быть цел,
  // а апдейты забирать второй экземпляр. Поэтому про опрос сказано отдельно.
  assert.match(wrapper.text(), /Бот слушает Телеграм/);

  const rows = wrapper.findAll('.chat');
  assert.equal(rows.length, 2);
  assert.match(rows[0].text(), /Команда Альфа · разработка/);
  assert.match(rows[0].text(), /супергруппа, с темами/);
  assert.match(rows[0].text(), /3 сообщения/, 'счётчик со склонением, а не «3 сообщений»');
  // Безымянная личка не должна выглядеть пустой строкой — иначе непонятно, что это.
  assert.match(rows[1].text(), /чат 5551234/);
  assert.match(rows[1].text(), /1 сообщение/);
  // Список чатов и есть будущая привязка к проектам — об этом сказано прямо,
  // чтобы «а где настройка проекта?» не приходилось спрашивать у меня.
  assert.match(wrapper.text(), /чат или тема → проект/);
});

test('поллер молчит про ошибку, которой не было, и называет ту, что случилась', async (t) => {
  const conflict = {
    running: true,
    offset: 42,
    lastPollAt: Date.parse('2026-08-07T12:00:00Z'),
    lastMessageAt: null,
    conflict: true,
    lastError: {
      code: 'poll_conflict',
      message: 'Апдейты этого бота уже читает другой экземпляр — Телеграм отдаёт их только одному.',
    },
  };
  const api = {
    async get(url) {
      if (url.endsWith('/chats')) return { chats: [] };
      return { bot: botView({ canReadAllGroupMessages: true, privacyHint: '' }), poll: conflict };
    },
    async post() { assert.fail(''); },
  };
  const { wrapper } = await mountView(t, { api });

  // Молчащий бот при целом токене — самый неочевидный отказ раздела: причина
  // обязана быть на экране словами сервера, а не выводиться из пустого списка.
  const warns = wrapper.findAll('.state.warn').map((s) => s.text());
  assert.ok(warns.some((s) => /другой экземпляр/.test(s)), 'причина 409 не показана');
  // И одновременно с этим «бот слушает» показывать нельзя — он как раз не слышит.
  assert.doesNotMatch(wrapper.text(), /Бот слушает Телеграм/);
});

test('degraded provider показывает account namespace read-only и блокирует native writes', async (t) => {
  const api = {
    async get(url) {
      if (url.endsWith('/chats')) return { chats: [] };
      if (url.endsWith('/rules')) return { rules: [], projects: [] };
      if (url.endsWith('/users')) return { users: [] };
      if (url.endsWith('/groups')) return { groups: [] };
      return {
        bot: botView(), poll: { running: false },
        connection: 'degraded', reason: 'telegram_credentials_invalid',
      };
    },
    async post() { assert.fail('read-only экран не должен писать сам'); },
    async put() { assert.fail('read-only экран не должен писать правила'); },
  };
  const { wrapper } = await mountView(t, { api });
  assert.match(wrapper.get('[data-state="provider-read-only"]').text(), /только для чтения/);
  assert.equal(wrapper.get('.rules-editor').attributes('disabled'), '');
  assert.equal(wrapper.get('.service-card .native-editor').attributes('disabled'), '');
  assert.match(wrapper.text(), /telegram_credentials_invalid/);
});

test('«Отключить» стирает токен только после подтверждения', async (t) => {
  const posts = [];
  let answer = false;
  const asked = [];
  const api = {
    async get() { return { bot: botView() }; },
    async post(url, body) { posts.push([url, body]); return { ok: true, bot: { ...EMPTY_BOT } }; },
  };
  const { wrapper, flushPromises } = await mountView(t, {
    api,
    confirm: async (text, opts) => { asked.push({ text, opts }); return answer; },
  });
  const off = () => wrapper.findAll('button').find((b) => b.text() === 'Отключить');

  await off().trigger('click');
  await settle(flushPromises);
  assert.deepEqual(posts, [], 'токен стёрли без ответа человека');
  assert.equal(asked.length, 1);
  // Вопрос обязан называть цену: ключ пропадёт, вернуться можно только новым токеном.
  assert.match(asked[0].text, /@example_inbox_bot/);
  assert.match(asked[0].text, /стёрт/);
  assert.match(asked[0].text, /только для чтения/);
  assert.match(asked[0].text, /отдельно возобновить приём/);
  assert.equal(asked[0].opts.danger, true);

  answer = true;
  await off().trigger('click');
  await settle(flushPromises);
  assert.deepEqual(posts, [['/api/telegram/disconnect', {}]]);
  assert.equal(wrapper.find('input').exists(), true, 'после отключения возвращается форма токена');
  assert.match(wrapper.text(), /@BotFather/);
});

// Третий ряд правила «Разрешённые чаты» — автомат «заводить задачи без меня».
//
// Смысл проверок один: **стёртое поле не имеет права ослаблять автомат**. В полях
// ввода всё строки, очищенное поле приезжает пустой строкой, а `Number('')` — ноль;
// нулевой порог уверенности означает «заводи задачу по любому разбору». Поэтому
// пустота обязана падать на осторожный дефолт, а ноль, набранный руками, остаётся
// нулём — это разные вещи, и различать их должны обе половины проводки, серверная
// (tests/server/telegram-rules.test.js) и вот эта.
//
// Тумблер живёт у КАЖДОГО правила: чат с жалобами имеет смысл отдать роботу целиком,
// а чат с идеями оставить на кнопке.
//
// Проверено мутациями (14 из 15 ловятся). Единственный выживший — границы внутри
// `setPct`: они втройне дублируются прижатием при показе (`pctOf`) и при отправке
// (`payload`), поэтому их снятие наблюдаемого поведения не меняет. Дыры там нет,
// искать её не нужно.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compileTelegramView,
  installBrowser,
} from './helpers/telegram-view.js';

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
const POLICY_FINGERPRINT = `telegram-rules-v1:${'3'.repeat(64)}`;
const NEXT_POLICY_FINGERPRINT = `telegram-rules-v1:${'4'.repeat(64)}`;

/** Правило как его отдаёт сервер: половина автомата уже нормализована. */
function rule(extra = {}) {
  return {
    project: 'demo',
    chatId: -100123,
    username: null,
    title: 'Баги пользователей',
    threadId: null,
    kind: 'bug',
    b24: { responsibleId: null, groupId: null, priority: 1 },
    draft: 'manual',
    autoTask: { enabled: false, minConfidence: 0.7, maxPerDay: 10 },
    autoLaunch: { enabled: false, route: '', minConfidence: 0.8, maxPerDay: 3, vetoMinutes: 10 },
    ...extra,
  };
}

async function mountTelegram(t, { rules = [rule()] } = {}) {
  const browser = await installBrowser(t);
  const puts = [];
  globalThis.__tgApi = {
    async get(url) {
      if (url === '/api/telegram/status') return { bot: BOT, poll: { running: true } };
      if (url === '/api/telegram/chats') return { chats: [{ id: -100123, title: 'Баги пользователей', type: 'supergroup' }] };
      if (url === '/api/telegram/rules') {
        return {
          rules: JSON.parse(JSON.stringify(rules)),
          projects: ['demo'],
          policyFingerprint: POLICY_FINGERPRINT,
        };
      }
      if (url === '/api/tracker/users') {
        return { users: [] };
      }
      if (url === '/api/tracker/groups') {
        return { groups: [] };
      }
      return {};
    },
    async post() { return {}; },
    async put(url, body) {
      puts.push(JSON.parse(JSON.stringify(body)));
      // Сервер отвечает нормализованными правилами — форма берёт их, а не свою копию.
      return {
        rules: JSON.parse(JSON.stringify(body.rules)),
        policyFingerprint: NEXT_POLICY_FINGERPRINT,
      };
    },
  };
  globalThis.__tgPluginsStore = () => ({ loaded: true, enabled: () => true, async load() {} });
  globalThis.__tgConfirm = async () => true;
  const [{ mount, flushPromises }, TelegramView] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileTelegramView(),
  ]);
  const wrapper = mount(TelegramView, { attachTo: browser.document.querySelector('#mount') });
  t.after(() => {
    wrapper.unmount();
    delete globalThis.__tgApi;
    delete globalThis.__tgPluginsStore;
    delete globalThis.__tgConfirm;
  });
  for (let i = 0; i < 5; i += 1) await flushPromises();

  // Ряд автомата ищем по подписи, а не по номеру: рядов у правила три, и порядок
  // рядов — вещь, которую правят чаще всего.
  const autoRow = (n = 0) => wrapper.findAll('.rule').at(n)
    .findAll('.rrow')
    .find((row) => row.find('.lbl').text() === 'автомат');
  const toggle = async (n = 0, on = true) => {
    await autoRow(n).find('input[type="checkbox"]').setValue(on);
  };
  // UiNumberInput нормализует число и пустоту в одном месте; тест отправляет тот же
  // input-event, которым primitive обновляет model в браузере.
  const setNum = async (n, which, value) => {
    const input = autoRow(n).findAll('.num-f').at(which);
    input.element.value = value;
    await input.trigger('input');
  };
  const save = async () => {
    await wrapper.findAll('button').find((b) => b.text() === 'Сохранить').trigger('click');
    for (let i = 0; i < 5; i += 1) await flushPromises();
  };
  return { wrapper, puts, autoRow, toggle, setNum, save, flushPromises };
}

test('числа автомата видны только включённому — выключенному они ничего не значат', async (t) => {
  const { autoRow, toggle } = await mountTelegram(t);

  assert.equal(autoRow().findAll('.num-f').length, 0, 'у выключенного автомата полей быть не должно');
  await toggle(0, true);
  assert.deepEqual(
    autoRow().findAll('.num-f').map((i) => i.element.value),
    ['70', '10'],
    'включённый показывает порог процентами и потолок задачами',
  );
});

test('тумблер и числа уезжают на сервер', async (t) => {
  const { puts, toggle, setNum, save } = await mountTelegram(t);

  await toggle(0, true);
  await setNum(0, 0, '85');
  await setNum(0, 1, '3');
  await save();

  assert.equal(puts.length, 1);
  assert.equal(puts[0].botId, 42, 'provider identity служит CAS старой формы');
  assert.equal(puts[0].policyFingerprint, POLICY_FINGERPRINT, 'policy content тоже служит CAS');
  assert.deepEqual(puts[0].rules[0].autoTask, { enabled: true, minConfidence: 0.85, maxPerDay: 3 });
});

test('стёртый порог — это 70 %, а не «заводи задачу по любому разбору»', async (t) => {
  const { puts, toggle, setNum, save } = await mountTelegram(t);

  await toggle(0, true);
  await setNum(0, 0, '');
  await save();

  assert.equal(puts[0].rules[0].autoTask.minConfidence, 0.7, 'пустое поле обязано падать на дефолт');
});

test('стёртый потолок — это 10 задач, а не ноль', async (t) => {
  const { puts, toggle, setNum, save } = await mountTelegram(t);

  await toggle(0, true);
  await setNum(0, 1, '   ');
  await save();

  assert.equal(puts[0].rules[0].autoTask.maxPerDay, 10);
});

test('ноль, набранный руками, остаётся нулём', async (t) => {
  // Обратная сторона того же правила: человек мог осознанно поставить «0 задач в
  // сутки», чтобы приглушить автомат, не выключая его. Подменять это дефолтом —
  // значит молча включить обратно то, что он приглушил.
  const { puts, toggle, setNum, save } = await mountTelegram(t);

  await toggle(0, true);
  await setNum(0, 0, '0');
  await setNum(0, 1, '0');
  await save();

  assert.deepEqual(puts[0].rules[0].autoTask, { enabled: true, minConfidence: 0, maxPerDay: 0 });
});

test('процент за границами прижимается, а не уезжает на сервер как есть', async (t) => {
  const { puts, autoRow, toggle, setNum, save } = await mountTelegram(t);

  await toggle(0, true);
  await setNum(0, 0, '900');
  await setNum(0, 1, '1000');
  // Прижатие видно сразу в полях: человек должен понять, что 900 % и 1000 задач
  // не приняли, а не узнать об этом после сохранения из чужой цифры.
  assert.deepEqual(autoRow().findAll('.num-f').map((i) => i.element.value), ['100', '100']);
  await save();

  assert.deepEqual(puts[0].rules[0].autoTask, { enabled: true, minConfidence: 1, maxPerDay: 100 });
});

test('мусор из правленного руками файла прижимается перед отправкой', async (t) => {
  // Единственный путь мимо ввода: правила лежат обычным json, и человек мог
  // поправить их редактором. Отдавать на сервер «порог 5» форма не имеет права,
  // даже зная, что сервер это и сам прижмёт.
  const { puts, autoRow, toggle, save } = await mountTelegram(t, {
    rules: [rule({ autoTask: { enabled: false, minConfidence: 5, maxPerDay: 999 } })],
  });

  await toggle(0, true);
  assert.equal(autoRow().findAll('.num-f').at(0).element.value, '100', 'на экране 100 %, а не 500');
  await save();

  assert.deepEqual(puts[0].rules[0].autoTask, { enabled: true, minConfidence: 1, maxPerDay: 100 });
});

test('правило из старого файла (без автомата) рисуется выключенным и не портится', async (t) => {
  const bare = rule();
  delete bare.autoTask;
  const { wrapper, puts, autoRow, toggle, save } = await mountTelegram(t, { rules: [bare] });

  assert.equal(autoRow().find('input[type="checkbox"]').element.checked, false);
  assert.equal(autoRow().findAll('.num-f').length, 0);
  // Недостающую половину форма ЧИТАЕТ дефолтом, а не дописывает в правило: иначе
  // открытая страница сама превращалась бы в «есть несохранённое» и звала жать
  // «Сохранить» там, где человек ничего не трогал.
  assert.equal(wrapper.findAll('button').filter((b) => b.text() === 'Сохранить').length, 0,
    'простое открытие раздела не изменение');

  // А вот включение тумблера обязано дать полную половину: с порогом и потолком,
  // а не один `enabled: true` при пустых остальных — пустое поле «не больше ___
  // задач в сутки» человек прочитал бы как «сколько угодно».
  await toggle(0, true);
  assert.deepEqual(autoRow().findAll('.num-f').map((i) => i.element.value), ['70', '10']);
  await save();
  assert.deepEqual(puts[0].rules[0].autoTask, { enabled: true, minConfidence: 0.7, maxPerDay: 10 });
});

test('автомат каждого чата свой: «Баги» роботу, «Идеи» на кнопке', async (t) => {
  const { puts, toggle, save } = await mountTelegram(t, {
    rules: [rule(), rule({ chatId: -100999, title: 'Идеи', kind: 'wish' })],
  });

  await toggle(0, true);
  await save();

  assert.equal(puts[0].rules[0].autoTask.enabled, true);
  assert.equal(puts[0].rules[1].autoTask.enabled, false, 'сосед не должен включаться заодно');
});

test('после успешного сохранения «есть несохранённое» гаснет', async (t) => {
  // Порядок ключей в `payload()` обязан совпадать с ответом сервера, иначе слепок
  // не сойдётся строкой и кнопка «Сохранить» останется висеть на пустом месте.
  const { wrapper, toggle, save } = await mountTelegram(t);

  await toggle(0, true);
  await save();

  assert.equal(wrapper.findAll('button').filter((b) => b.text() === 'Сохранить').length, 0);
});

test('policy автомата ссылается на общую модель Inbox, а не на Telegram worker', async (t) => {
  const view = await mountTelegram(t, {
    rules: [rule({ autoTask: { enabled: true, minConfidence: 0.7, maxPerDay: 10 } })],
  });
  assert.match(view.wrapper.text(), /Настройки → Плагины → Входящие/);
  assert.doesNotMatch(view.wrapper.text(), /Автомат работает|Автомат молчит|споткнулся/);
});

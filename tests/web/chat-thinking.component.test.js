// Живая строка хода в окне: мозг вместо спиннера, меняющееся слово и только те числа,
// которые исполнитель действительно сообщил.
import assert from 'node:assert/strict';
import test from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';
import { THINKING_WORDS } from '../../web/src/views/chat/chatThinking.ts';

process.env.NODE_ENV = 'test';

const THINKING_PATH = webFile('src/views/chat/ChatThinking.vue');
let componentPromise;

function compileThinking() {
  componentPromise ||= compileVue(THINKING_PATH);

  return componentPromise;
}

async function mountThinking(t, props) {
  const browser = await installUiBrowser(t, 'http://cockpit.test/#/chats');
  const [{ mount }, ChatThinking] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileThinking(),
  ]);
  const wrapper = mount(ChatThinking, {
    attachTo: browser.document.querySelector('#mount'),
    props,
  });

  t.after(() => wrapper.unmount());

  return wrapper;
}

const flat = (wrapper) => wrapper.text().replace(/\u00a0/g, ' ');

test('LINE-01: идущий инструмент, время хода и расход вывода — в одной строке', async (t) => {
  const wrapper = await mountThinking(t, {
    steps: [{ k: 'tool', id: 't1', name: 'Bash', at: 1 }],
    tokens: 3000,
    startedAt: Date.now() - 125_000,
  });
  const text = flat(wrapper);

  assert.equal(wrapper.find('[data-role="chat-thinking"]').exists(), true);
  assert.equal(text.includes('Выполняю команду'), true, 'строка не назвала действие');
  assert.equal(text.includes('2:05'), true, 'время хода не показано');
  assert.equal(text.includes('3 000 ток.'), true, 'расход вывода не показан');
  // Знак хода — мозг, а не вертящийся спиннер.
  assert.equal(wrapper.find('svg.brain path').exists(), true, 'у строки нет знака мозга');
});

test('LINE-02: без начала хода время молчит, а оценка помечена «≈»', async (t) => {
  const wrapper = await mountThinking(t, {
    steps: [],
    tokens: 1500,
    tokensEstimate: true,
    startedAt: 0,
  });
  const text = flat(wrapper);

  assert.equal(text.includes('≈ 1 500 ток.'), true, 'оценка показана как точный замер');
  assert.equal(/\d:\d\d/.test(text), false, 'время показано без начала хода');
});

test('LINE-03: без расхода строка не рисует ноль токенов', async (t) => {
  const wrapper = await mountThinking(t, { steps: [], tokens: 0, startedAt: 0 });
  const text = flat(wrapper);

  assert.equal(text.includes('ток.'), false, 'ноль выдан за измеренный расход');
  // Первое слово хода случайное (порядок тасуется на монтирование), но всегда из списка.
  assert.ok(
    THINKING_WORDS.some((word) => text.includes(word)),
    `строка потеряла слово о занятии: ${text}`,
  );
});

test('LINE-04: троеточие — три точки в постоянной ширине', async (t) => {
  const wrapper = await mountThinking(t, { steps: [], tokens: 0, startedAt: 0 });

  // Из разметки точки не исчезают: их число меняет только прозрачность, поэтому время и
  // расход справа не дёргаются. Читать вслух их незачем — это знак «идёт», а не текст.
  assert.equal(wrapper.findAll('.dots .dot').length, 3, 'троеточие собрано не из трёх точек');
  assert.equal(wrapper.find('.said .word').exists(), true, 'слово потеряло свою ячейку');
  assert.equal(wrapper.find('.dots').attributes('aria-hidden'), 'true', 'точки читаются вслух');
});

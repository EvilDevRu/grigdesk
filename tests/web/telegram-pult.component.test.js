// Срез U телеграм-пульта: карточка «Пульт» раздела /telegram (план, §4/§8).
//
// Проверяется состояние и вызовы, не геометрия (happy-dom раскладку не считает):
//  - три состояния карточки: не настроен → ждёт код → включён;
//  - запрос кода и подтверждение уходят с botId (optimistic CAS формы);
//  - отказ сервера показывается словами; предупреждение о видимости содержимого
//    и подсказка про allowlist Входящих присутствуют в разметке;
//  - выключение — только после confirmDialog (системный confirm запрещён).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { apiError, mountTelegramView, settle } from './helpers/telegram-view.js';

const VIEW_PATH = fileURLToPath(new URL('../../web/src/views/TelegramView.vue', import.meta.url));

process.env.NODE_ENV = 'test';

const T0 = Date.UTC(2026, 7, 19, 10, 0, 0);

function botView() {
  return {
    configured: true,
    botId: 8123456789,
    username: 'example_pult_bot',
    canReadAllGroupMessages: true,
    tokenHint: '…v5u6',
    connectedAt: T0,
    serviceChatId: null,
    serviceChatTitle: '',
    privacyHint: '',
  };
}

const POLL = {
  running: true, offset: 1, lastPollAt: T0, lastMessageAt: T0, conflict: false, lastError: null,
};

const PULT_OFF = { configured: false, confirmed: false, pending: false, chatTitle: '', chatHint: '' };

function statusApi({ pult = PULT_OFF, onPost = null } = {}) {
  const calls = [];
  return {
    calls,
    async get(url) {
      calls.push(['GET', url]);
      if (url.endsWith('/chats')) {
        return { chats: [{ id: 555001, title: 'Аня', type: 'private', messages: 3, lastAt: T0 / 1000 }] };
      }
      if (url.endsWith('/rules')) return { rules: [], projects: [] };
      if (url.endsWith('/users')) return { users: [] };
      if (url.endsWith('/groups')) return { groups: [] };
      return { bot: botView(), poll: POLL, pult, connection: 'connected', reason: null };
    },
    async post(url, body) {
      calls.push(['POST', url, body]);
      if (onPost) return onPost(url, body);
      return { ok: true, pult: PULT_OFF };
    },
  };
}

const mountView = (t, opts) => mountTelegramView(t, { ...opts, prefix: 'pult' });

test('не настроен: селект лички + «Получить код»; запрос уходит с botId и chatId', async (t) => {
  const api = statusApi({
    onPost: (url) => {
      assert.equal(url, '/api/telegram/pult');
      return {
        ok: true,
        pult: { configured: false, confirmed: false, pending: true, chatTitle: 'Аня', chatHint: '…5001' },
      };
    },
  });
  const { wrapper, flushPromises } = await mountView(t, { api });

  const card = wrapper.get('#tg-pult');
  assert.match(card.text(), /Пульт/);
  assert.match(card.text(), /Выключен/);
  // Предупреждения безопасности — часть карточки, а не документации.
  assert.match(card.text(), /видит Telegram/);
  assert.match(card.text(), /страницы плана задачи/);
  assert.match(card.text(), /произвольные файлы/);
  assert.match(card.text(), /не привязывай правилом к проекту/);

  await card.get('select').setValue('555001');
  await card.findAll('button').find((b) => b.text() === 'Получить код').trigger('click');
  await settle(flushPromises);

  const post = api.calls.find(([method]) => method === 'POST');
  assert.deepEqual(post, ['POST', '/api/telegram/pult', { botId: 8123456789, chatId: 555001 }]);
  // Появился шаг кода.
  assert.equal(wrapper.find('[data-state="pult-pending"]').exists(), true);
});

test('ждёт код: ввод + «Включить» уходит в confirm; успех показывает «включён»', async (t) => {
  const api = statusApi({
    pult: { configured: false, confirmed: false, pending: true, chatTitle: 'Аня', chatHint: '…5001' },
    onPost: (url, body) => {
      assert.equal(url, '/api/telegram/pult/confirm');
      assert.deepEqual(body, { botId: 8123456789, code: '123456' });
      return {
        ok: true,
        pult: { configured: true, confirmed: true, pending: false, chatTitle: 'Аня', chatHint: '…5001' },
      };
    },
  });
  const { wrapper, flushPromises } = await mountView(t, { api });

  const card = wrapper.get('#tg-pult');
  await card.get('input.code-input').setValue(' 123456 ');
  await card.findAll('button').find((b) => b.text() === 'Включить').trigger('click');
  await settle(flushPromises);

  assert.match(wrapper.get('[data-state="pult-on"]').text(), /Аня/);
  assert.match(wrapper.get('#tg-pult').text(), /включён/);
});

test('неверный код: текст сервера виден словами, карточка не притворяется включённой', async (t) => {
  const api = statusApi({
    pult: { configured: false, confirmed: false, pending: true, chatTitle: 'Аня', chatHint: '…5001' },
    onPost: () => { throw apiError(400, { error: 'pult_code_mismatch', message: 'Код не совпал.' }); },
  });
  const { wrapper, flushPromises } = await mountView(t, { api });

  const card = wrapper.get('#tg-pult');
  await card.get('input.code-input').setValue('000000');
  await card.findAll('button').find((b) => b.text() === 'Включить').trigger('click');
  await settle(flushPromises);

  assert.match(wrapper.get('.err').text(), /Код не совпал/);
  assert.equal(wrapper.find('[data-state="pult-on"]').exists(), false);
});

test('контролы форм одной высоты, селект стилизованный — статическая проверка стилей', async () => {
  // Живого замера в офлайне нет (happy-dom раскладку не считает) — правило
  // стережётся чтением <style scoped>, как TG-UI-05 у разворота ссылок.
  const source = await readFile(VIEW_PATH, 'utf8');
  const style = source.slice(source.indexOf('<style'));
  // Селектор ищется с начала строки: голый indexOf('.sel {') совпадает внутри
  // общего правила `.inp, .sel {` и проверяет не тот блок.
  const rule = (selector) => {
    const at = style.indexOf(`\n${selector} {`);
    assert.ok(at > 0, `в <style scoped> нет правила ${selector}`);
    return style.slice(at, style.indexOf('}', at));
  };
  // Одна высота у селектов, инпутов и кнопок — переменной, а не совпадением padding-ов.
  assert.match(rule('.tg'), /--ctl-h:\s*\d+px/);
  assert.match(rule('.inp, .sel'), /height:\s*var\(--ctl-h\)/);
  assert.match(rule('.btn'), /min-height:\s*var\(--ctl-h\)/);
  assert.match(rule('.code-input'), /height:\s*var\(--ctl-h\)/);
  // Селект стилизованный, не нативный (правило проекта): свой шеврон с фиксированным
  // отступом от края, а не системная стрелка вплотную к рамке.
  assert.match(rule('.sel'), /appearance:\s*none/);
  assert.match(rule('.sel'), /background-position:\s*right\s+\d+px\s+center/);
});

test('включённый пульт выключается только после подтверждения', async (t) => {
  let confirmed = 0;
  const api = statusApi({
    pult: { configured: true, confirmed: true, pending: false, chatTitle: 'Аня', chatHint: '…5001' },
    onPost: (url) => {
      assert.equal(url, '/api/telegram/pult/disable');
      return {
        ok: true,
        pult: { configured: true, confirmed: false, pending: false, chatTitle: 'Аня', chatHint: '…5001' },
      };
    },
  });
  const { wrapper, flushPromises } = await mountView(t, {
    api,
    confirm: async () => { confirmed += 1; return confirmed > 1; },
  });

  const off = () => wrapper.get('#tg-pult').findAll('button').find((b) => b.text() === 'Выключить пульт');
  // Первый отказ подтверждения — ничего не отправлено.
  await off().trigger('click');
  await settle(flushPromises);
  assert.equal(api.calls.some(([method]) => method === 'POST'), false);

  await off().trigger('click');
  await settle(flushPromises);
  assert.equal(api.calls.filter(([method]) => method === 'POST').length, 1);
  // Выбор чата сохранён, но пульт выключен: карточка предлагает новый код.
  assert.match(wrapper.get('#tg-pult').text(), /Прежний выбор/);
});

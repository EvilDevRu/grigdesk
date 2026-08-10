import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { apiError, mountChannelView } from './helpers/channel-views.js';

process.env.NODE_ENV = 'test';

const REF_NEW = '[1,"item","github","acc","issue-9"]';
const REF_SKIPPED = '[1,"item","github","acc","issue-10"]';
const MESSAGE_A = '[1,"message","github","acc","repo","9:a"]';
const MESSAGE_B = '[1,"message","github","acc","repo","9:b"]';
const MESSAGE_SKIPPED = '[1,"message","github","acc","repo","10"]';
const MESSAGE_TASK = '[1,"message","github","acc","repo","11"]';

const channel = (over = {}) => ({
  id: 'github', label: 'GitHub', plugin: 'enabled', connection: 'connected',
  participation: 'active', readOnly: false, activationVersion: 3, ...over,
});

const message = (messageRef, over = {}) => ({
  messageRef,
  occurredAt: 1_786_172_300,
  editedAt: null,
  author: { name: 'Алиса' },
  text: 'Проверьте точный subset',
  attachments: [],
  decision: null,
  ...over,
});

const item = (over = {}) => ({
  ref: REF_NEW,
  revision: `v1_${'a'.repeat(43)}`,
  channel: { id: 'github', label: 'GitHub' },
  source: { title: 'EvilDevRu/ai-cockpit #9', url: 'https://github.com/EvilDevRu/ai-cockpit/issues/9' },
  project: 'cockpit',
  kind: 'bug',
  status: 'new',
  decision: null,
  firstAt: 1_786_172_300,
  lastAt: 1_786_172_301,
  cold: true,
  autoTask: { enabled: true, readyAtMs: 1_786_172_301_000 },
  title: 'Ошибка Inbox',
  description: 'Два сообщения',
  truncated: false,
  messages: [message(MESSAGE_A), message(MESSAGE_B, { author: { name: 'Боб' } })],
  attachments: [],
  ...over,
});

function response(over = {}) {
  return {
    items: [item()], channels: [channel()], errors: [], truncated: false,
    worker: { running: true, readiness: 'ready', lastReason: '', lastError: null },
    ...over,
  };
}

function button(wrapper, text) {
  const found = wrapper.findAll('button').find((entry) => entry.text() === text);
  assert.ok(found, `не найдена кнопка «${text}»`);
  return found;
}

test('Inbox показывает source/channel/status и отправляет exact message subset', async (t) => {
  const calls = [];
  const api = {
    async get(url) { calls.push(['GET', url]); return response(); },
    async post(url, body) { calls.push(['POST', url, body]); return { ok: true }; },
  };
  const { wrapper, settle } = await mountChannelView(t, 'inbox', { api });

  const card = wrapper.get('[data-status="new"]');
  assert.match(card.text(), /GitHub/);
  assert.match(card.text(), /EvilDevRu\/ai-cockpit #9/);
  assert.match(card.text(), /К разбору/);
  const checks = card.findAll('input[type="checkbox"]');
  assert.equal(checks.length, 2);
  assert.equal(checks.every((entry) => entry.element.checked), true, 'по умолчанию выбран весь new item');
  await checks[1].setValue(false);
  await button(card, 'Создать задачу').trigger('click');
  await settle();

  assert.deepEqual(calls[1], [
    'POST',
    `/api/inbox/items/${encodeURIComponent(REF_NEW)}/task`,
    { revision: `v1_${'a'.repeat(43)}`, messageRefs: [MESSAGE_A] },
  ]);
});

test('выбор new/skipped не смешивается, действия контекстны, вложения и message taskUrl видны', async (t) => {
  const skippedDecision = {
    decisionId: 'decision_0000000000000002', version: 2, status: 'skipped',
    taskId: null, taskUrl: '', by: 'human', note: null, decidedAtMs: 1_786_172_400_000,
  };
  const taskDecision = {
    decisionId: 'decision_0000000000000003', version: 1, status: 'task',
    taskId: '501', taskUrl: 'https://example.test/tasks/501', by: 'human', note: null,
    decidedAtMs: 1_786_172_500_000,
  };
  const mixed = item({
    status: 'mixed',
    decision: null,
    messages: [
      message(MESSAGE_A, {
        attachments: [{
          kind: 'voice', displayLabel: 'голосовое сообщение', name: '', size: 2048,
          attachmentAnalysis: { status: 'processing' },
        }],
      }),
      message(MESSAGE_B, { decision: skippedDecision }),
      message(MESSAGE_TASK, { decision: taskDecision }),
    ],
  });
  const calls = [];
  const api = {
    async get() { return response({ items: [mixed] }); },
    async post(url, body) { calls.push([url, body]); return { ok: true }; },
  };
  const { wrapper, settle } = await mountChannelView(t, 'inbox', { api });
  const card = wrapper.get('[data-status="mixed"]');
  const checks = card.findAll('input[type="checkbox"]');

  assert.equal(checks.length, 2, 'task message не выбирается для повторного решения');
  assert.equal(checks[0].element.checked, true);
  assert.equal(checks[1].element.checked, false);
  assert.ok(button(card, 'Создать задачу'));
  assert.ok(button(card, 'Пропустить'));
  assert.equal(card.findAll('a').some((entry) => entry.attributes('href') === taskDecision.taskUrl), true);
  assert.match(card.get('.attachment-chip').text(), /голосовое сообщение · 2 КБ/);
  assert.match(card.get('.attachment-chip').text(), /Разбирается/);
  assert.match(card.get('.attachment-note').text(), /Без полного разбора автозадача не создастся/);

  await checks[1].setValue(true);
  assert.equal(checks[0].element.checked, false, 'выбор skipped очищает несовместимый new');
  assert.equal(checks[1].element.checked, true);
  assert.equal(card.findAll('button').some((entry) => entry.text() === 'Создать задачу'), false);
  assert.equal(card.findAll('button').some((entry) => entry.text() === 'Пропустить'), false);
  await button(card, 'Вернуть на разбор').trigger('click');
  await settle();

  assert.deepEqual(calls[0], [
    `/api/inbox/items/${encodeURIComponent(REF_NEW)}/reset`,
    {
      revision: `v1_${'a'.repeat(43)}`,
      messageRefs: [MESSAGE_B],
      decisionId: skippedDecision.decisionId,
      decisionVersion: skippedDecision.version,
    },
  ]);
});

test('переключатель отделяет историю, reset передаёт decision CAS, inbox-changed перечитывает API', async (t) => {
  const decision = {
    decisionId: 'decision_0000000000000001', version: 4, status: 'skipped',
    taskId: null, taskUrl: '', by: 'manual', note: null, decidedAtMs: 1_786_172_400_000,
  };
  const skipped = item({
    ref: REF_SKIPPED,
    revision: `v1_${'b'.repeat(43)}`,
    status: 'skipped',
    title: 'Уже решено',
    decision,
    messages: [message(MESSAGE_SKIPPED, { decision })],
  });
  const offline = item({
    ref: `${REF_NEW}-offline`,
    status: 'mixed',
    channel: { id: 'telegram', label: 'Telegram' },
    source: { title: 'Чат поддержки', url: '' },
  });
  const data = response({
    items: [offline, skipped],
    channels: [channel(), channel({ id: 'telegram', label: 'Telegram', connection: 'disconnected', readOnly: true })],
  });
  const calls = [];
  const api = {
    async get(url) { calls.push(['GET', url]); return data; },
    async post(url, body) { calls.push(['POST', url, body]); return { ok: true }; },
  };
  const { wrapper, emitSse, settle } = await mountChannelView(t, 'inbox', { api });

  assert.match(wrapper.get('[data-section="review"]').text(), /К разбору\s+1/u);
  assert.match(wrapper.get('[data-section="history"]').text(), /История\s+1/u);
  const mixed = wrapper.get('[data-status="mixed"]');
  assert.match(mixed.text(), /Частично разобрано/);
  assert.match(mixed.text(), /только для чтения/);
  assert.equal(mixed.get('input[type="checkbox"]').attributes('disabled'), '');
  assert.equal(wrapper.find('[data-status="skipped"]').exists(), false, 'история скрыта по умолчанию');
  await wrapper.get('[data-section="history"]').trigger('click');
  const skippedCard = wrapper.get('[data-status="skipped"]');
  assert.match(skippedCard.text(), /Пропущено/);
  assert.match(skippedCard.text(), /Созданные задачи не изменятся/);
  assert.equal(wrapper.text().includes('Снять решение'), false);
  await button(skippedCard, 'Вернуть на разбор').trigger('click');
  await settle();
  assert.deepEqual(calls[1], [
    'POST', `/api/inbox/items/${encodeURIComponent(REF_SKIPPED)}/reset`, {
      revision: `v1_${'b'.repeat(43)}`,
      messageRefs: [MESSAGE_SKIPPED],
      decisionId: decision.decisionId,
      decisionVersion: 4,
    },
  ]);

  const reads = () => calls.filter(([method, url]) => method === 'GET' && url === '/api/inbox').length;
  const before = reads();
  emitSse('inbox-changed', { channel: 'github' });
  await settle();
  assert.equal(reads(), before + 1);
});

test('разобранная по частям карточка уходит в историю, а не висит в очереди', async (t) => {
  const taskDecision = {
    decisionId: 'decision_0000000000000010', version: 1, status: 'task',
    taskId: '8300', taskUrl: 'https://portal.test/task/8300', by: 'auto', note: null,
    decidedAtMs: 1_786_172_400_000,
  };
  const skipDecision = {
    ...taskDecision, decisionId: 'decision_0000000000000011', status: 'skipped',
    taskId: null, taskUrl: '',
  };
  // Итог автоматического разбиения: одно сообщение стало задачей, другое пропущено.
  const split = item({
    status: 'mixed',
    decision: null,
    messages: [
      message(MESSAGE_A, { decision: taskDecision }),
      message(MESSAGE_B, { decision: skipDecision }),
    ],
  });
  const api = { async get() { return response({ items: [split] }); } };
  const { wrapper } = await mountChannelView(t, 'inbox', { api });

  assert.match(wrapper.get('[data-section="review"]').text(), /К разбору\s+0/u);
  assert.match(wrapper.get('[data-section="history"]').text(), /История\s+1/u);
  assert.equal(wrapper.find('[data-status="mixed"]').exists(), false, 'очередь пуста');

  await wrapper.get('[data-section="history"]').trigger('click');
  const card = wrapper.get('[data-status="mixed"]');
  assert.match(card.text(), /Разобрано по частям/);
  assert.doesNotMatch(card.text(), /Частично разобрано/);
  assert.doesNotMatch(card.text(), /Выберите новые сообщения/);
});

test('task в истории показывает ссылку и никогда не предлагает возврат', async (t) => {
  const decision = {
    decisionId: 'decision_0000000000000004', version: 1, status: 'task',
    taskId: '777', taskUrl: 'https://example.test/tasks/777', by: 'auto', note: null,
    decidedAtMs: 1_786_172_600_000,
  };
  const taskItem = item({
    ref: `${REF_NEW}-task`,
    status: 'task',
    decision,
    messages: [message(MESSAGE_TASK, {
      decision,
      attachments: [{
        kind: 'video', displayLabel: 'видео', name: 'bug.mp4', size: 4096,
      }],
    })],
  });
  const api = {
    async get() { return response({ items: [taskItem] }); },
    async post() { assert.fail('созданная задача не допускает повторного решения'); },
  };
  const { wrapper } = await mountChannelView(t, 'inbox', { api });

  assert.match(wrapper.get('[data-state="section-empty"]').text(), /Всё разобрано/);
  await wrapper.get('[data-section="history"]').trigger('click');
  const card = wrapper.get('[data-status="task"]');
  assert.match(card.text(), /Задача создана/);
  assert.equal(card.get('a.task-link').attributes('href'), decision.taskUrl);
  assert.match(card.get('.attachment-chip').text(), /Содержимое разобрано/u);
  assert.equal(card.get('.attachment-chip').attributes('data-analysis'), 'ready');
  assert.equal(card.text().includes('Вернуть на разбор'), false);
  assert.equal(card.find('input[type="checkbox"]').exists(), false);
});

test('stale decision перечитывает карточку, сообщает об обновлении и не повторяет POST', async (t) => {
  let reads = 0;
  const updated = item({
    revision: `v1_${'c'.repeat(43)}`,
    title: 'Обновлённое обращение',
  });
  const calls = [];
  const api = {
    async get(url) {
      calls.push(['GET', url]);
      reads += 1;
      return reads === 1 ? response() : response({ items: [updated] });
    },
    async post(url, body) {
      calls.push(['POST', url, body]);
      throw apiError(409, {
        error: 'stale_decision',
        message: 'Решение изменилось; перечитайте Inbox.',
      });
    },
  };
  const { wrapper, settle } = await mountChannelView(t, 'inbox', { api });

  await button(wrapper.get('[data-status="new"]'), 'Создать задачу').trigger('click');
  await settle();

  assert.equal(calls.filter(([method]) => method === 'POST').length, 1);
  assert.equal(calls.filter(([method]) => method === 'GET').length, 2);
  const card = wrapper.get('[data-status="new"]');
  assert.match(card.text(), /Обновлённое обращение/);
  assert.match(card.get('.item-alert').text(), /Обращение изменилось — данные обновлены/);
});

test('смена аккаунта во время действия тоже обновляет карточку без повторного POST', async (t) => {
  let reads = 0;
  const calls = [];
  const api = {
    async get(url) {
      calls.push(['GET', url]);
      reads += 1;
      return response({ items: [item({ title: reads === 1 ? 'Старые данные' : 'Новый аккаунт' })] });
    },
    async post(url, body) {
      calls.push(['POST', url, body]);
      throw apiError(409, {
        error: 'account_changed',
        message: 'Подключённый аккаунт канала изменился.',
      });
    },
  };
  const { wrapper, settle } = await mountChannelView(t, 'inbox', { api });

  await button(wrapper.get('[data-status="new"]'), 'Пропустить').trigger('click');
  await settle();

  assert.equal(calls.filter(([method]) => method === 'POST').length, 1);
  assert.equal(calls.filter(([method]) => method === 'GET').length, 2);
  assert.match(wrapper.get('[data-status="new"]').text(), /Новый аккаунт/);
});

test('незавершённый авторазбор вложений виден человеку и блокирует обещание автозадачи', async (t) => {
  const media = item({
    messages: [message(MESSAGE_A, {
      attachments: [{
        kind: 'voice', displayLabel: 'голосовое сообщение', name: '', size: 4096,
      }],
    })],
  });
  const api = {
    async get() {
      return response({
        items: [media],
        worker: {
          running: true,
          readiness: 'ready',
          lastReason: '',
          lastError: null,
          analysisRequired: [{
            ref: media.ref,
            code: 'speech_unavailable',
            retryAtMs: Date.now() + 60_000,
          }],
        },
      });
    },
    async post() { assert.fail('действие не ожидалось'); },
  };
  const { wrapper } = await mountChannelView(t, 'inbox', { api });
  const card = wrapper.get('[data-status="new"]');

  assert.match(card.get('.auto-state').text(), /Вложения не удалось полностью разобрать/u);
  assert.match(card.get('.auto-state').text(), /Автозадача не создастся/u);
  assert.match(card.get('.attachment-chip').text(), /Не удалось разобрать/u);
});

test('неполный разбор вложений просит у человека пояснение и отправляет его задачей', async (t) => {
  for (const failureCode of ['attachment_analysis_required', 'attachments_skipped']) {
    await t.test(failureCode, async (subtest) => {
      const posts = [];
      const prompts = [];
      const api = {
        async get() { return response(); },
        async post(url, body) {
          posts.push([url, body]);
          if (posts.length === 1) {
            throw apiError(409, {
              error: failureCode,
              message: 'Содержимое вложений разобрано не полностью.',
              attachments: [
                { label: 'видео · bug.mp4', reason: 'файл 53 МБ — бот не может скачать больше 20 МБ' },
              ],
            });
          }
          return { ok: true };
        },
      };
      const { wrapper, settle } = await mountChannelView(subtest, 'inbox', {
        api,
        prompt: async (options) => {
          prompts.push(options);
          return 'На видео чекбокс появляется через две секунды.';
        },
      });
      const card = wrapper.get('[data-status="new"]');

      await button(card, 'Создать задачу').trigger('click');
      await settle();

      // Отдельной кнопки «Создать без разбора» больше нет: отказ сервера сразу
      // открывает поле пояснения — решение о постановке человек уже принял.
      assert.equal(prompts.length, 1);
      assert.match(prompts[0].text, /Содержимое вложений разобрано не полностью/u);
      // Человек обязан видеть, ЧТО описывать и лечится ли это ожиданием.
      assert.match(prompts[0].text, /видео · bug\.mp4/u);
      assert.match(prompts[0].text, /больше 20 МБ/u);
      assert.equal(posts.length, 2);
      assert.deepEqual(posts[1], [
        `/api/inbox/items/${encodeURIComponent(REF_NEW)}/task`,
        {
          revision: `v1_${'a'.repeat(43)}`,
          messageRefs: [MESSAGE_A, MESSAGE_B],
          operatorNote: 'На видео чекбокс появляется через две секунды.',
        },
      ]);
    });
  }
});

test('пустое пояснение задачу не создаёт, а отмена модалки ничего не отправляет', async (t) => {
  const failing = (posts) => ({
    async get() { return response(); },
    async post(url, body) {
      posts.push([url, body]);
      throw apiError(409, {
        error: 'attachment_analysis_required',
        message: 'Содержимое вложений разобрано не полностью.',
        attachments: [],
      });
    },
  });

  await t.test('пустая строка', async (subtest) => {
    const posts = [];
    const { wrapper, settle } = await mountChannelView(subtest, 'inbox', {
      api: failing(posts),
      prompt: async () => '   ',
    });
    const card = wrapper.get('[data-status="new"]');
    await button(card, 'Создать задачу').trigger('click');
    await settle();
    assert.equal(posts.length, 1, 'пустое пояснение не уходит на сервер');
    assert.match(card.get('.item-alert').text(), /Без пояснения задача потеряет суть/u);
  });

  await t.test('отмена', async (subtest) => {
    const posts = [];
    const { wrapper, settle } = await mountChannelView(subtest, 'inbox', {
      api: failing(posts),
      prompt: async () => null,
    });
    const card = wrapper.get('[data-status="new"]');
    await button(card, 'Создать задачу').trigger('click');
    await settle();
    assert.equal(posts.length, 1);
  });
});

test('карточка называет неразобранные вложения автоматического блока поимённо', async (t) => {
  const { wrapper } = await mountChannelView(t, 'inbox', {
    api: {
      async get() {
        return response({
          worker: {
            running: true,
            readiness: 'ready',
            lastReason: '',
            lastError: null,
            analysisRequired: [{
              ref: REF_NEW,
              code: 'attachment_analysis_required',
              attachments: [
                { label: 'видео · bug.mp4', reason: 'файл 53 МБ — бот не может скачать больше 20 МБ' },
              ],
              checkedAtMs: 1_786_172_400_000,
              retryAtMs: 1_786_194_000_000,
            }],
          },
        });
      },
      async post() { return { ok: true }; },
    },
  });
  const card = wrapper.get('[data-status="new"]');
  const blocked = card.get('.blocked-attachments');
  assert.match(blocked.text(), /видео · bug\.mp4/u);
  assert.match(blocked.text(), /больше 20 МБ/u);
});

test('activation CAS передаёт только version, deactivate явно предупреждает о gap', async (t) => {
  const prompts = [];
  const calls = [];
  const data = response({
    items: [],
    channels: [
      channel({ id: 'github', participation: 'never_activated', activationVersion: 0 }),
      channel({ id: 'telegram', label: 'Telegram', participation: 'active', activationVersion: 7 }),
    ],
  });
  const api = {
    async get() { return data; },
    async post(url, body) { calls.push([url, body]); return { ok: true }; },
  };
  const { wrapper, settle } = await mountChannelView(t, 'inbox', {
    api,
    confirm: async (text) => { prompts.push(text); return true; },
  });
  const githubCard = wrapper.get('[data-channel="github"]');
  assert.match(githubCard.text(), /Подключение/);
  assert.match(githubCard.text(), /Приём новых/);
  await button(wrapper, 'Начать принимать новые').trigger('click');
  await settle();
  await button(wrapper, 'Остановить приём').trigger('click');
  await settle();
  assert.deepEqual(calls, [
    ['/api/inbox/channels/github/activate', { activationVersion: 0 }],
    ['/api/inbox/channels/telegram/deactivate', { activationVersion: 7 }],
  ]);
  assert.match(prompts[0], /не попадут в очередь/);
});

test('Inbox объясняет окно тишины, отсутствие модели и выключенный autoTask', async (t) => {
  const readyAtMs = Date.now() + 65_000;
  const waiting = item({ autoTask: { enabled: true, readyAtMs } });
  const manual = item({
    ref: `${REF_NEW}-manual`,
    autoTask: { enabled: false, readyAtMs },
  });
  const api = {
    async get() {
      return response({
        items: [waiting, manual],
        worker: { running: true, readiness: 'no_model', lastReason: 'no_model' },
      });
    },
    async post() { assert.fail('тест состояния ничего не меняет'); },
  };
  const { wrapper } = await mountChannelView(t, 'inbox', { api });

  const notice = wrapper.get('[data-state="automation-notice"]');
  assert.match(notice.text(), /не выбрана модель/);
  assert.match(wrapper.get(`[data-status="new"] .auto-state`).text(), /Авторазбор через/);
  assert.ok(wrapper.findAll('.auto-state').some((entry) => /Автосоздание выключено/.test(entry.text())));

  await notice.get('a').trigger('click');
  assert.equal(localStorage.getItem('cockpit-settings-tab'), 'plugins');
});

test('Inbox явно показывает несовместимую с безопасным разбором модель', async (t) => {
  const api = {
    async get() {
      return response({
        worker: { running: true, readiness: 'unsafe_model_provider', lastReason: '' },
      });
    },
    async post() { assert.fail('тест состояния ничего не меняет'); },
  };
  const { wrapper } = await mountChannelView(t, 'inbox', { api });
  assert.match(
    wrapper.get('[data-state="automation-notice"]').text(),
    /не поддерживает безопасный разбор входящих/u,
  );
});

test('404 plugin_disabled при version skew — состояние, а не красная ошибка', async (t) => {
  const api = {
    async get() { throw apiError(404, { error: 'plugin_disabled', message: 'Плагин выключен.' }); },
    async post() { assert.fail('недоступный Inbox ничего не меняет'); },
  };
  const { wrapper } = await mountChannelView(t, 'inbox', { api });
  assert.equal(wrapper.get('[data-state="plugin-disabled"]').exists(), true);
  assert.match(wrapper.text(), /Настройки → Плагины/);
  assert.equal(wrapper.find('[role="alert"]').exists(), false);
});

test('router регистрирует lazy /inbox и /github', async () => {
  const source = await readFile(new URL('../../web/src/router.js', import.meta.url), 'utf8');
  assert.match(source, /path: '\/inbox'.*InboxView\.vue/);
  assert.match(source, /path: '\/github'.*GitHubView\.vue/);
});

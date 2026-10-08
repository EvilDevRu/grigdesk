import assert from 'node:assert/strict';
import test from 'node:test';

import { compileTaskModal } from './helpers/task-modal.js';

process.env.NODE_ENV = 'test';

let nonce = 0;

function triageDetail() {
  return {
    analysis: {
      complexity: 3,
      risk: 2,
      diff_size: 'M',
      route_guess: 'feature',
      confidence: 'low',
      questions: [
        {
          id: 'q-mode',
          text: 'Какой режим оставить?',
          options: [
            {
              id: 'o-auto',
              label: 'Автоматический',
              description: 'Система выбирает режим сама.',
            },
            {
              id: 'o-manual',
              label: 'Ручной',
              description: 'Человек подтверждает режим перед запуском.',
            },
          ],
          recommendation: { option: 'o-manual', reason: 'Безопаснее для старых задач' },
        },
        {
          id: 'q-label',
          text: 'Как подписать кнопку?',
          options: [],
          recommendation: null,
        },
      ],
      meta: {
        provider: 'claude',
        model: 'claude-opus-5',
        effort: 'high',
        duration_ms: 60_000,
      },
    },
    note: '',
    stale: [],
    status: { state: 'done' },
  };
}

// Сохранённый ответ приходит с копией вопроса: карточка ищет его и по идентификатору,
// и по смыслу текста, потому что следующий заход триажа переписывает вопросы заново.
function triageClarifications() {
  return {
    text: '## Разбор арбитра — машинный — Как подписать кнопку?\nПоле уже есть в форме.',
    entries: [{
      id: 'answer-1',
      questionId: 'q-label',
      questionText: 'Как подписать кнопку?',
      actor: 'cockpit-arbiter',
      status: 'answered',
      selection: [],
      selectionLabels: [],
      text: 'Поле уже есть в форме.',
      attachments: [],
      proof: [],
    }],
  };
}

async function mountTriage(t, {
  enabled = true,
  detail = triageDetail(),
  clarifications = triageClarifications(),
  speechMode = 'unavailable',
  holdPost = false,
} = {}) {
  nonce += 1;
  const prefix = `__taskModalAnalysis${nonce}`;
  const { Window } = await import('../../web/node_modules/happy-dom/lib/index.js');
  const browser = new Window({ url: 'http://cockpit.test/#/board' });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    location: browser.location,
    FormData: browser.FormData,
    Node: browser.Node,
    Element: browser.Element,
    HTMLElement: browser.HTMLElement,
    SVGElement: browser.SVGElement,
    Event: browser.Event,
    CustomEvent: browser.CustomEvent,
    getComputedStyle: browser.getComputedStyle.bind(browser),
  })) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  browser.document.body.innerHTML = '<div id="mount"></div>';

  const [{ mount, flushPromises }, { createPinia, defineStore }] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
  ]);
  const posts = [];
  const analyzed = [];
  let leases = 0;
  let releases = 0;
  let cancels = 0;
  let resumePost = null;
  globalThis[`${prefix}Api`] = {
    async get(url) {
      if (url.endsWith('/clarifications')) {
        return clarifications;
      }
      if (url === '/api/tasks') return { tasks: [] };
      return {};
    },
    async post(url, body) {
      posts.push({ url, body: structuredClone(body) });
      if (holdPost) {
        await new Promise((resolve) => { resumePost = resolve; });
      }
      return { text: 'сохранено', entries: [] };
    },
    async upload() { return {}; },
  };
  globalThis[`${prefix}UiStore`] = defineStore(`${prefix}-ui`, {
    state: () => ({ taskId: 42, launchRequested: false }),
    actions: { close() {}, consumeTaskLaunch() {} },
  });
  globalThis[`${prefix}TasksStore`] = defineStore(`${prefix}-tasks`, {
    actions: {
      async load() { return { id: 42, title: 'Задача 42', description: '' }; },
      async timer() {},
      async complete() {},
      async comment() {},
      async launch() { return {}; },
    },
  });
  globalThis[`${prefix}BoardStore`] = defineStore(`${prefix}-board`, {
    state: () => ({
      data: { tasks: [], toReview: [], created: [], accomplice: [], auditor: [] },
    }),
    actions: { async load() {} },
  });
  globalThis[`${prefix}AnalysisStore`] = defineStore(`${prefix}-analysis`, {
    actions: {
      async detail() { return structuredClone(detail); },
      async analyze(id) { analyzed.push(String(id)); },
    },
  });
  globalThis[`${prefix}FavoritesStore`] = defineStore(`${prefix}-favorites`, {
    state: () => ({ loaded: true, error: null }),
    getters: { isFavorite: () => () => false, isPending: () => () => false },
    actions: { async load() {}, async toggle() {} },
  });
  globalThis[`${prefix}SeenStore`] = defineStore(`${prefix}-seen`, {
    state: () => ({ loaded: true, initialized: true, error: null }),
    getters: { ready: () => true, isSeen: () => () => true },
    actions: { async markSeen() {} },
  });
  globalThis[`${prefix}PluginsStore`] = defineStore(`${prefix}-plugins`, {
    state: () => ({
      loaded: true,
      list: [{ id: 'analysis', enabled, values: { autoArbitrate: false } }],
    }),
    getters: {
      enabled: (state) => (id) => state.list.find((item) => item.id === id)?.enabled ?? false,
      byId: (state) => (id) => state.list.find((item) => item.id === id) || null,
    },
  });
  globalThis[`${prefix}DictationController`] = {
    acquire(_owner, handlers = {}) {
      leases += 1;
      return {
        state: { phase: 'idle', busy: false, prompt: null, notice: '' },
        async start() {
          if (speechMode === 'commit') {
            handlers.onCommit?.('Ответ голосом');
            return true;
          }
          throw new Error('microphone_unavailable');
        },
        async stop() {},
        async cancel() { cancels += 1; },
        async release() { releases += 1; },
      };
    },
  };

  const TaskModal = await compileTaskModal(prefix);
  const wrapper = mount(TaskModal, {
    attachTo: browser.document.querySelector('#mount'),
    global: { plugins: [createPinia()], stubs: { teleport: true } },
  });
  t.after(() => {
    wrapper.unmount();
    browser.close();
    for (const suffix of [
      'Api',
      'UiStore',
      'TasksStore',
      'BoardStore',
      'AnalysisStore',
      'FavoritesStore',
      'SeenStore',
      'PluginsStore',
      'DictationController',
    ]) {
      delete globalThis[`${prefix}${suffix}`];
    }
  });
  await flushPromises();
  await flushPromises();

  return {
    wrapper,
    flushPromises,
    posts,
    analyzed,
    releasePost: () => resumePost?.(),
    speech: () => ({ leases, releases, cancels }),
  };
}

test('каждый вопрос получает независимую карточку ответа и рекомендацию', async (t) => {
  const { wrapper } = await mountTriage(t);

  assert.deepEqual({
    fields: wrapper.findAll('[data-role="task-clarification"]').length,
    attachmentPickers: wrapper.findAll('[data-role="task-attachment"]').length,
    choiceLists: wrapper.findAll('[data-role="task-clarification-options"]').length,
    descriptions: [
      'Система выбирает режим сама.',
      'Человек подтверждает режим перед запуском.',
    ].every((description) => wrapper.text().includes(description)),
    recommendation: wrapper.text().includes('Ручной')
      && wrapper.text().includes('Безопаснее для старых задач'),
    rawRecommendationId: wrapper.text().includes('o-manual'),
    collapsedOptionalAnswer: wrapper.findAll('.clarify-answer')[0].isVisible(),
  }, {
    fields: 2,
    attachmentPickers: 2,
    choiceLists: 1,
    descriptions: true,
    recommendation: true,
    rawRecommendationId: false,
    collapsedOptionalAnswer: false,
  });
});

test('вариант выбирается как option, а необязательное пояснение раскрывается отдельно', async (t) => {
  const { wrapper } = await mountTriage(t);
  const manualChoice = wrapper.findAll('[role="option"]')
    .find((option) => option.text().includes('Ручной'));
  await manualChoice.trigger('click');
  const disclosure = wrapper.findAll('button')
    .find((button) => button.text().includes('Добавить пояснение'));
  await disclosure.trigger('click');

  assert.deepEqual({
    selected: manualChoice.attributes('aria-selected'),
    expanded: disclosure.attributes('aria-expanded'),
    answerVisible: wrapper.findAll('.clarify-answer')[0].isVisible(),
  }, {
    selected: 'true',
    expanded: 'true',
    answerVisible: true,
  });
});

test('квадратная кнопка вложения показывает иконку и называет себя', async (t) => {
  const { wrapper } = await mountTriage(t);
  const picker = wrapper.get('[data-role="task-attachment"]');

  assert.deepEqual({
    icon: picker.find('.ui-button__leading svg').exists(),
    label: picker.text().includes('Приложить фото'),
    title: picker.attributes('data-ui-tooltip'),
  }, {
    icon: true,
    label: true,
    title: 'Приложить фото к ответу',
  });
});

test('строковый вопрос старой оценки получает обычную карточку без вариантов', async (t) => {
  const detail = triageDetail();
  detail.analysis.questions = ['Нужно ли сохранить старую подпись?'];
  const { wrapper, flushPromises, posts, analyzed } = await mountTriage(t, { detail });
  const field = wrapper.get('[data-role="task-clarification"]');
  await field.setValue('Да, сохранить');
  const submit = wrapper.findAll('button')
    .find((button) => button.text().includes('Уточнить и переоценить'));
  if (submit) {
    await submit.trigger('click');
    await flushPromises();
  }
  const answer = posts.find((entry) => entry.url.endsWith('/clarifications'))
    ?.body?.answers?.[0];

  assert.deepEqual({
    fields: wrapper.findAll('[data-role="task-clarification"]').length,
    text: wrapper.text().includes('Нужно ли сохранить старую подпись?'),
    objectView: wrapper.text().includes('[object Object]'),
    freeAnswer: answer?.text,
    questionId: typeof answer?.questionId === 'string' && answer.questionId.length > 0,
    analyzed,
  }, {
    fields: 1,
    text: true,
    objectView: false,
    freeAnswer: 'Да, сохранить',
    questionId: true,
    analyzed: ['42'],
  });
});

test('ответы отправляются одним structured batch и запускают одну переоценку', async (t) => {
  const { wrapper, flushPromises, posts, analyzed } = await mountTriage(t);
  const fields = wrapper.findAll('[data-role="task-clarification"]');
  for (const [index, field] of fields.entries()) {
    await field.setValue(index === 0 ? 'Оставить ручной' : 'Назвать «Проверить»');
  }
  const manualChoice = wrapper.findAll('button')
    .find((button) => button.text().includes('Ручной'));
  if (manualChoice) await manualChoice.trigger('click');
  const submit = wrapper.findAll('button')
    .find((button) => button.text().includes('Уточнить и переоценить'));
  await submit.trigger('click');
  await flushPromises();

  assert.deepEqual({
    clarificationPosts: posts.filter((entry) => entry.url.endsWith('/clarifications')),
    analyzed,
  }, {
    clarificationPosts: [{
      url: '/api/tasks/42/clarifications',
      body: {
        answers: [
          {
            questionId: 'q-mode',
            optionIds: ['o-manual'],
            text: 'Оставить ручной',
            attachments: [],
          },
          {
            questionId: 'q-label',
            optionIds: [],
            text: 'Назвать «Проверить»',
            attachments: [],
          },
        ],
        text: 'Оставить ручной\n\nНазвать «Проверить»',
      },
    }],
    analyzed: ['42'],
  });
});

test('идущий заход триажа оставляет на панели только прогресс', async (t) => {
  const detail = triageDetail();
  detail.status = { state: 'running', startedAt: Date.now() - 95_000 };
  const { wrapper } = await mountTriage(t, { detail });

  assert.deepEqual({
    fields: wrapper.findAll('[data-role="task-clarification"]').length,
    question: wrapper.text().includes('Какой режим оставить?'),
    chips: wrapper.text().includes('сложность'),
    reanalyze: wrapper.findAll('button').some((button) => /Переоценить/u.test(button.text())),
    progress: wrapper.text().includes('переоценка идёт'),
    elapsed: /01:3\d/u.test(wrapper.text()),
  }, {
    fields: 0,
    question: false,
    chips: false,
    reanalyze: false,
    progress: true,
    elapsed: true,
  });
});

// Кнопку жмёт человек, а статус захода приходит от сервера позже: панель обязана
// очиститься уже на отправке ответов, иначе «нажал — и ничего не изменилось».
test('нажатое уточнение убирает вопросы и оценку сразу, ещё до ответа сервера', async (t) => {
  const { wrapper, flushPromises, releasePost } = await mountTriage(t, { holdPost: true });
  const field = wrapper.get('[data-role="task-clarification"]');
  await field.setValue('Оставить ручной');
  const submit = wrapper.findAll('button')
    .find((button) => button.text().includes('Уточнить и переоценить'));
  await submit.trigger('click');
  await flushPromises();
  const onSend = {
    fields: wrapper.findAll('[data-role="task-clarification"]').length,
    chips: wrapper.text().includes('сложность'),
    progress: wrapper.text().includes('уточнения сохраняются'),
  };
  releasePost();
  await flushPromises();

  assert.deepEqual({
    onSend,
    fieldsAfter: wrapper.findAll('[data-role="task-clarification"]').length,
  }, {
    onSend: { fields: 0, chips: false, progress: true },
    fieldsAfter: 2,
  });
});

test('карточка задачи берёт ровно один lease общего speech controller', async (t) => {
  const { speech } = await mountTriage(t);

  assert.equal(speech().leases, 1);
});

test('машинный ответ и фактические provider/model/effort отличимы в карточке', async (t) => {
  const { wrapper } = await mountTriage(t);

  assert.equal(wrapper.find('#task-analysis-details').exists(), false);
  await wrapper.get('[aria-controls="task-analysis-details"]').trigger('click');

  assert.deepEqual({
    machine: /арбитр[^\n]*машин/iu.test(wrapper.text()),
    provider: wrapper.text().includes('claude'),
    model: wrapper.text().includes('claude-opus-5'),
    effort: wrapper.text().includes('high'),
  }, {
    machine: true,
    provider: true,
    model: true,
    effort: true,
  });
});

test('подробности оценки называют код, по которому она шла', async (t) => {
  const detail = triageDetail();

  detail.analysis.repos = {
    be: {
      sha: '62addc56aa11bb22cc33dd44ee55ff6677889900',
      ref: 'origin/master',
    },
    fe: {
      sha: '3b5adc1aee455a6c19ab85844aab6dedbedd28fb',
      note: 'у репозитория нет origin/HEAD, origin/master или origin/main',
    },
  };

  const { wrapper } = await mountTriage(t, { detail });

  await wrapper.get('[aria-controls="task-analysis-details"]').trigger('click');

  assert.deepEqual(
    wrapper.findAll('[data-role="task-analysis-source"]').map((row) => row.text()),
    [
      'be: origin/master @ 62addc5',
      'fe: рабочая копия @ 3b5adc1 — у репозитория нет origin/HEAD, origin/master или origin/main',
    ],
  );
});

test('неизвестная оценка не становится нулевой, а уверенность и тип работы читаются по-русски', async (t) => {
  const detail = triageDetail();
  detail.analysis.complexity = null;
  detail.analysis.risk = undefined;
  detail.analysis.confidence = 'medium';
  detail.analysis.route_depth = 'full';
  const { wrapper } = await mountTriage(t, { detail });

  assert.equal(wrapper.get('[data-metric="complexity"] dd').text(), '—');
  assert.equal(wrapper.get('[data-metric="risk"] dd').text(), '—');
  assert.equal(wrapper.get('[data-metric="confidence"] dd').text(), 'Средняя');
  assert.match(wrapper.get('.triage-route').text(), /Новая функциональность.*полный маршрут/);
});

test('сохранённые уточнения раскрываются отдельно и сохраняют предупреждение о локальной видимости', async (t) => {
  const { wrapper } = await mountTriage(t);

  assert.equal(wrapper.find('#task-triage-history').exists(), false);
  await wrapper.get('[aria-controls="task-triage-history"]').trigger('click');

  assert.match(wrapper.get('#task-triage-history').text(), /Заказчик их не видит/);
  assert.match(wrapper.get('#task-triage-history').text(), /Поле уже есть в форме/);
  await wrapper.get('[aria-controls="task-triage-history"]').trigger('click');

  assert.equal(wrapper.find('#task-triage-history').exists(), false);
});

test('ручная кнопка арбитра видна при выключенном автоматическом режиме', async (t) => {
  const { wrapper } = await mountTriage(t);

  assert.equal(
    wrapper.findAll('button').some((button) => /Разобрать арбитром/u.test(button.text())),
    true,
  );
});

test('выключенный плагин показывает штатную заглушку вместо действий триажа', async (t) => {
  const { wrapper } = await mountTriage(t, { enabled: false });

  assert.deepEqual({
    placeholder: /Триаж выключен/u.test(wrapper.text()),
    hasAnalyzeAction: wrapper.findAll('button')
      .some((button) => /Оценить|Переоценить/u.test(button.text())),
  }, {
    placeholder: true,
    hasAnalyzeAction: false,
  });
});

test('ошибка микрофона не блокирует обычный текстовый ответ', async (t) => {
  const { wrapper, flushPromises } = await mountTriage(t);
  const mic = wrapper.findAll('button')
    .find((button) => /Начать диктовку/u.test(button.attributes('aria-label') || ''));
  if (mic) {
    await mic.trigger('click');
    await flushPromises();
  }
  const field = wrapper.find('[data-role="task-clarification"]');
  await field.setValue('Ответ с клавиатуры');

  assert.deepEqual({
    mic: Boolean(mic),
    text: field.element.value,
  }, {
    mic: true,
    text: 'Ответ с клавиатуры',
  });
});

test('успешная диктовка дописывает активный ответ и освобождает lease при закрытии', async (t) => {
  const { wrapper, flushPromises, speech } = await mountTriage(t, { speechMode: 'commit' });
  const fields = wrapper.findAll('[data-role="task-clarification"]');
  await fields[0].setValue('Начало');
  const microphones = wrapper.findAll('button')
    .filter((button) => /Начать диктовку/u.test(button.attributes('aria-label') || ''));
  if (microphones[0]) {
    await microphones[0].trigger('click');
    await flushPromises();
  }
  if (microphones[1]) {
    await microphones[1].trigger('click');
    await flushPromises();
  }
  const values = fields.map((field) => field.element?.value);
  wrapper.unmount();
  await flushPromises();

  assert.deepEqual({
    microphones: microphones.length,
    first: values[0],
    second: values[1],
    speech: speech(),
  }, {
    microphones: 2,
    first: 'Начало Ответ голосом',
    second: 'Ответ голосом',
    speech: { leases: 1, releases: 1, cancels: 1 },
  });
});

// Заход триажа переписывает questions[] целиком, и id вопроса меняется вместе с его
// формулировкой. Пока карточка искала ответ строго по id, уже данный ответ пропадал
// с экрана — и человек отвечал второй раз на то же самое.
test('ответ остаётся виден, когда триаж переформулировал тот же вопрос', async (t) => {
  const detail = triageDetail();
  detail.analysis.questions = [{
    id: 'q-label-2',
    text: 'Как подписать кнопку',
    options: [],
    recommendation: null,
  }];

  const { wrapper } = await mountTriage(t, { detail });

  assert.deepEqual({
    status: wrapper.text().includes('Арбитр — машинный ответ'),
    answered: wrapper.findAll('.clarify-card.is-answered').length,
  }, {
    status: true,
    answered: 1,
  });
});

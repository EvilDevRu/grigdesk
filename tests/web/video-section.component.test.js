// Раздел «Видео → задачи»: что человек видит после распознавания и с чем уезжает задача.
//
// Обещания:
//  - загрузка, разбор и постановка разведены по шагам, одновременно виден один;
//  - расшифровку можно прочитать целиком, а не только построчно: сплошной текст
//    режется на абзацы по паузам, потому что голосов распознавание не различает;
//  - разбор моделью ДОПОЛНЯЕТ уже набранные черновики, а не затирает их;
//  - без выбранной модели раздел работает как раньше и объясняет, где её включить;
//  - задача уезжает с исполнителем, проектом и приоритетом, а пустой выбор идёт как
//    null: нулевой responsibleId портал понимает буквально и отвечает ошибкой;
//  - поставленная задача открывается общей карточкой GrigDesk прямо из черновика.
//
// Состояние `<script setup>` наружу не выдаётся (`inlineTemplate` держит биндинги в
// замыкании), и это к лучшему: проверяем тот же путь, что проходит человек — загрузка
// файла, вкладки, кнопки, — а не внутренние ref.
import assert from 'node:assert/strict';
import test from 'node:test';

import { compileVue, singletonUrl, webFile } from './helpers/compile-vue.js';
import { installBrowser, settle } from './helpers/telegram-view.js';

process.env.NODE_ENV = 'test';

const VIEW_PATH = webFile('src/views/VideoView.vue');
const TEST_UTILS = '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs';

const SEGMENTS = [
  { start: 0, end: 3.2, text: 'Привет, все на месте?' },
  { start: 3.4, end: 6, text: 'Да, начинаем.' },
  // Пауза больше 2.5 с — новая мысль, а значит новый абзац.
  { start: 271.5, end: 275, text: 'Надо добавить время забора в комментарий.' },
  { start: 275.4, end: 279, text: 'И вторым номером приоритет.' },
];

// Длительность нулевая: сервер всегда её присылает, но у части без явной длительности
// она честно равна нулю — и раздел тогда не выдумывает строку про запись.
const DONE_JOB = {
  status: 'done',
  progress: null,
  error: null,
  result: { duration: 0, transcript: { segments: SEGMENTS } },
};

const PLAN_TASKS = [
  {
    title: 'Время забора',
    description: 'Добавить в комментарий.\n\nНа записи: 04:31',
    confidence: 0.9,
    reason: 'прямая просьба',
    at: null,
    frame: null,
  },
  {
    title: 'Приоритет вторым номером',
    description: 'Указывать приоритет.',
    confidence: 0.4,
    reason: 'сказано вскользь',
    at: null,
    frame: null,
  },
];

/** Роутер api раздела: ростер и проекты портала плюс подставные ответы. */
function fakeApi({ users = [], groups = [], job = DONE_JOB, storage = null, post = async () => ({ id: 1234 }) } = {}) {
  const calls = [];
  return {
    calls,
    posted: (url) => calls.filter(([method, target]) => method === 'POST' && target === url).map(([, , body]) => body),
    async get(url) {
      calls.push(['GET', url]);
      if (url.endsWith('/api/b24/users')) return { users };
      if (url.endsWith('/api/b24/groups')) return { groups };
      if (url.endsWith('/api/media/doctor')) return { ok: true, storage };
      if (url.startsWith('/api/media/ingest/')) return job;
      return {};
    },
    async post(url, body) {
      calls.push(['POST', url, body]);
      return post(url, body);
    },
  };
}

async function mountVideoView(t, { api, planModel = null, confirmAnswer = true, restore = null } = {}) {
  const browser = await installBrowser(t);
  // Снимок прошлого сеанса кладём ДО монтирования: так же его видит вью после F5 или
  // обновления PWA — на сервере разбор уже идёт, а у браузера остался только jobId.
  if (restore) {
    browser.localStorage.setItem('grigdesk-video-session', JSON.stringify(restore));
  }
  globalThis.__vidApi = api;
  const preview = { calls: [], showImage(v) { this.calls.push(['image', v]); }, showVideo(v) { this.calls.push(['video', v]); } };
  const confirms = [];
  globalThis.__vidConfirm = async (...args) => { confirms.push(args); return confirmAnswer; };
  globalThis.__vidPreviewStore = () => preview;
  const openedTasks = [];
  globalThis.__vidUiStore = () => ({
    openTask(id) {
      openedTasks.push(String(id));
    },
  });
  globalThis.__vidPluginsStore = () => ({
    loaded: true,
    enabled: () => true,
    byId: (id) => (id === 'video' ? { id, values: { triageModel: planModel } } : null),
    async load() {},
  });

  // Загрузка файла и поллинг статуса: сеть подделываем, а интервал сводим к одному
  // немедленному вызову — ждать реальные 2 секунды в офлайн-наборе незачем.
  const realFetch = globalThis.fetch;
  const realSetInterval = globalThis.setInterval;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ jobId: 'job-1' }) });
  globalThis.setInterval = (fn) => { fn(); return 1; };
  t.after(() => {
    globalThis.fetch = realFetch;
    globalThis.setInterval = realSetInterval;
  });

  const VideoView = await compileVue(VIEW_PATH, {
    stubs: {
      '../shared/apiClient.ts': 'export const api = globalThis.__vidApi;',
      // Транспорт раздела зовёт общий клиент своим путём: заглушка сопоставляется по
      // точной строке импорта, и у shared/mediaApi.ts она отдельная.
      './apiClient.ts': `export const api = {
        url: (path) => path,
        get: (...args) => globalThis.__vidApi.get(...args),
        post: (...args) => globalThis.__vidApi.post(...args),
      };`,
      '../shared/clipboard.ts': 'export const writeClipboardText = async () => true;',
      '../stores/plugins.js': `
        export const usePluginsStore = (...args) => globalThis.__vidPluginsStore(...args);
      `,
      // Тот же стор реестра плагинов, но импортированный ИЗ стора сеанса: заглушка
      // ищется по точной строке импорта, и второго пути к ней у бандлера нет.
      './plugins.js': `
        export const usePluginsStore = (...args) => globalThis.__vidPluginsStore(...args);
      `,
      '../stores/documentPreview.ts': `
        export const useDocumentPreviewStore = (...args) => globalThis.__vidPreviewStore(...args);
      `,
      '../stores/ui.js': `
        export const useUiStore = (...args) => globalThis.__vidUiStore(...args);
      `,
      './services/dialogs': `
        export const confirmDialog = (...args) => globalThis.__vidConfirm(...args);
        export const alertDialog = async () => undefined;
        export const promptDialog = async () => null;
      `,
    },
  });

  // Сеанс разбора живёт в сторе, а не во вью: своя pinia на тест, иначе разбор
  // одной встречи протёк бы в соседний тест вместе с черновиками. Импорт ленивый:
  // pinia тянет за собой vue, а тот запоминает глобальный `document` в момент
  // загрузки — статический импорт забрал бы его ДО подъёма happy-dom.
  const { createPinia, setActivePinia } = await import(singletonUrl('pinia'));
  setActivePinia(createPinia());

  const { mount, flushPromises } = await import(TEST_UTILS);
  const target = browser.document.querySelector('#mount');
  let wrapper = mount(VideoView, { attachTo: target });
  t.after(() => {
    wrapper.unmount();
    delete globalThis.__vidApi;
    delete globalThis.__vidPluginsStore;
    delete globalThis.__vidPreviewStore;
    delete globalThis.__vidUiStore;
    delete globalThis.__vidConfirm;
  });
  await settle(flushPromises);

  const run = (n) => settle(flushPromises, n);
  const button = (label) => wrapper.findAll('button').find((b) => b.text().includes(label));

  /** Перейти к экрану мастера тем же табом, который нажимает человек. */
  async function openStep(label) {
    const tab = wrapper.findAll('[role="tab"]').find((candidate) => candidate.text().includes(label));

    assert.ok(tab, `шаг «${label}» доступен`);
    await tab.trigger('click');
    await run();
  }

  /** Уход в другой раздел и возврат: тот же путь, что у человека, — вью пересоздаётся. */
  async function remount() {
    wrapper.unmount();
    wrapper = mount(VideoView, { attachTo: target });
    await settle(flushPromises);
    return wrapper;
  }

  /** Тот же путь, что у человека: выбрал файл → загрузка → поллинг → готовая расшифровка. */
  async function upload({ step = 'tasks' } = {}) {
    const input = wrapper.find('input[type="file"]');
    Object.defineProperty(input.element, 'files', {
      value: [new browser.File(['видео'], 'встреча.mp4', { type: 'video/mp4' })],
      configurable: true,
    });
    await input.trigger('change');
    await run();

    if (step === 'tasks') {
      await openStep('Задачи');
    } else if (step === 'record') {
      await openStep('Запись');
    }
  }

  /**
   * Черновик через интерфейс: кнопка, заголовок и, если нужно, свои селекты.
   * Порядок селектов один и тот же в черновике и в общем блоке — «от кого», «кому»,
   * проект, приоритет: сначала источник задачи, потом адресат.
   */
  async function addDraft({ title, createdById, responsibleId, groupId, priority } = {}) {
    if (!wrapper.find('#video-step-tasks-panel').exists()) {
      await openStep('Задачи');
    }

    await button('+ ещё задача').trigger('click');
    const drafts = wrapper.findAll('.draft');
    const draft = drafts[drafts.length - 1];
    if (title !== undefined) await draft.find('.dtitle').setValue(title);
    const selects = draft.findAll('select');
    if (createdById !== undefined) await selects[0].setValue(createdById);
    if (responsibleId !== undefined) await selects[1].setValue(responsibleId);
    if (groupId !== undefined) await selects[2].setValue(groupId);
    if (priority !== undefined) await selects[3].setValue(priority);
    return draft;
  }

  // wrapper переприсваивается при remount, поэтому наружу отдаём геттер: иначе тест
  // продолжил бы искать кнопки в уже размонтированной разметке.
  return {
    browser,
    get wrapper() { return wrapper; },
    run,
    button,
    openStep,
    upload,
    addDraft,
    remount,
    preview,
    confirms,
    openedTasks,
  };
}

test('мастер разделяет запись, разбор и постановку на отдельные экраны', async (t) => {
  const view = await mountVideoView(t, { api: fakeApi() });

  assert.ok(view.wrapper.find('#video-step-record-panel').exists());
  assert.equal(view.wrapper.findAll('[role="tabpanel"]').length, 1, 'на экране только текущий шаг');
  assert.equal(view.wrapper.get('#video-step-review').attributes('disabled'), '');
  assert.equal(view.wrapper.get('#video-step-tasks').attributes('disabled'), '');

  await view.upload({ step: 'review' });

  assert.ok(view.wrapper.find('#video-step-review-panel').exists());
  assert.ok(view.wrapper.find('.plan').exists(), 'разбор модели относится ко второму шагу');
  assert.ok(view.wrapper.find('.transcript').exists(), 'исходник относится ко второму шагу');
  assert.equal(view.wrapper.find('.common').exists(), false, 'настройки постановки ещё не мешают');

  await view.openStep('Задачи');

  assert.ok(view.wrapper.find('#video-step-tasks-panel').exists());
  assert.ok(view.wrapper.find('.common').exists(), 'поля Битрикс24 находятся на финальном шаге');
  assert.equal(view.wrapper.find('.plan').exists(), false);
  assert.equal(view.wrapper.find('.transcript').exists(), false);
});

test('сплошной текст собирается абзацами по паузам, реплики остаются отдельным видом', async (t) => {
  const view = await mountVideoView(t, { api: fakeApi() });
  await view.upload({ step: 'review' });

  // Расшифровка свёрнута: раздел отвечает на «какие задачи», а реплики нужны, когда
  // формулировку сверяют с записью. Само число реплик видно и в свёрнутом виде.
  assert.equal(view.wrapper.findAll('.seg').length, 0, 'реплики не разворачиваются сами');
  assert.match(view.wrapper.find('.transcript').text(), /4 реплик/u);

  await view.button('Расшифровка').trigger('click');
  await view.run();
  // Развернули — вид по умолчанию реплики: у каждой свой таймкод и клик в черновик.
  assert.equal(view.wrapper.findAll('.seg').length, 4);
  const firstSegment = view.wrapper.findAll('.seg')[0];
  assert.equal(firstSegment.element.tagName, 'BUTTON');
  assert.equal(firstSegment.attributes('type'), 'button');
  assert.match(firstSegment.attributes('aria-label'), /Добавить реплику 00:00/u);
  await firstSegment.trigger('click');

  await view.wrapper.get('[data-option-value="text"]').trigger('click');
  const paragraphs = view.wrapper.findAll('.para');
  assert.equal(paragraphs.length, 2, 'пауза 265 с обязана разделить абзацы');
  assert.match(paragraphs[0].text(), /Привет, все на месте\?\s+Да, начинаем\./u);
  assert.match(paragraphs[1].text(), /04:31/u);
  assert.match(paragraphs[1].text(), /Надо добавить время забора.*И вторым номером приоритет/u);

  await view.openStep('Задачи');
  assert.match(view.wrapper.get('.draft textarea').element.value, /\[00:00\] Привет/u);
});

test('без выбранной модели раздел объясняет себя и не предлагает разбор', async (t) => {
  const view = await mountVideoView(t, { api: fakeApi() });
  await view.upload({ step: 'review' });

  assert.match(view.wrapper.text(), /Настройки → Плагины/u);
  assert.equal(Boolean(view.button('Разобрать на задачи')), false);
  // Ручной разбор при этом на месте — раздел не становится бесполезным.
  await view.openStep('Задачи');
  assert.ok(view.button('+ ещё задача'));
});

test('разбор моделью дополняет черновики, а не затирает набранное вручную', async (t) => {
  const api = fakeApi({
    post: async (url) => (url === '/api/media/plan-tasks'
      ? { ok: true, model: 'claude/claude-opus-5', count: 4, truncated: false, tasks: PLAN_TASKS }
      : { id: 7 }),
  });
  const view = await mountVideoView(t, {
    api,
    planModel: { provider: 'claude', model: 'claude-opus-5' },
  });
  await view.upload({ step: 'review' });

  // Разбор запускается САМ по готовности расшифровки: человек пришёл за задачами.
  assert.deepEqual(api.posted('/api/media/plan-tasks'), [{ jobIds: ['job-1'], hint: '' }],
    'части встречи уезжают одной посылкой — сервер склеит их со сквозными таймкодами');
  await view.openStep('Задачи');
  assert.equal(view.wrapper.findAll('.draft').length, 2, 'задачи модели уже на экране');

  // Человек начал разбирать сам — эта работа не должна пропасть при повторе.
  await view.addDraft({ title: 'Своя задача' });
  await view.openStep('Разбор');
  await view.button('Разобрать на задачи').trigger('click');
  await view.run();
  assert.match(view.wrapper.text(), /предложила задач: 2/u);
  await view.openStep('Задачи');

  const drafts = view.wrapper.findAll('.draft');
  assert.equal(drafts.length, 5, 'повтор дополняет, а не затирает набранное');
  assert.match(drafts[0].find('.ptitle').text(), /Время забора/u);
  assert.equal(drafts[2].find('.dtitle').element.value, 'Своя задача');
  // Уверенность видна человеку: формулировку собрала модель, проверять её ему.
  assert.match(view.wrapper.text(), /модель: 90%/u);
  assert.match(view.wrapper.text(), /модель: 40%/u);
});

test('задача модели открывается ПРЕВЬЮ, а не формой', async (t) => {
  // Её пришли прочитать перед постановкой: поля формы заставляли вычитывать заголовок
  // из инпута, а описание — из textarea со своей полосой прокрутки.
  const api = fakeApi({
    post: async (url) => (url === '/api/media/plan-tasks'
      ? { ok: true, model: 'claude/claude-opus-5', count: 4, truncated: false, tasks: PLAN_TASKS }
      : { id: 7 }),
  });
  const view = await mountVideoView(t, {
    api, planModel: { provider: 'claude', model: 'claude-opus-5' },
  });
  await view.upload();

  const draft = view.wrapper.findAll('.draft')[0];
  assert.equal(draft.find('.ptitle').text(), 'Время забора');
  assert.match(draft.find('.pdesc').text(), /Добавить в комментарий/u);
  assert.equal(draft.find('.dtitle').exists(), false, 'форма не открыта сама');

  // Правка — по кнопке, и тогда появляются поля.
  await draft.findAll('button').find((b) => b.text() === 'Править').trigger('click');
  await view.run();
  const editing = view.wrapper.findAll('.draft')[0];
  assert.equal(editing.find('.dtitle').element.value, 'Время забора');
  assert.equal(editing.find('.ptitle').exists(), false);
});

test('разобранный файл назван поимённо — с размером и длительностью', async (t) => {
  // «Я выбирал другой файл» и «раздел обрезал» иначе неотличимы: записи называются
  // почти одинаково и лежат рядом. Живой случай — встреча в двух файлах, 17:04 и 1:18.
  const api = fakeApi({
    job: {
      status: 'done',
      progress: null,
      error: null,
      result: { duration: 78.89, transcript: { segments: SEGMENTS } },
    },
  });
  const view = await mountVideoView(t, { api });
  await view.upload({ step: 'review' });

  const note = view.wrapper.find('.filenote').text();
  assert.match(note, /встреча\.mp4/u);
  assert.match(note, /запись 01:18/u);
  assert.match(note, /4 реплик/u);
});

test('отказ разбора объясняется словами, а не машинным кодом', async (t) => {
  const api = fakeApi({
    post: async () => {
      const err = new Error('no_model');
      err.status = 409;
      err.data = { error: 'no_model' };
      throw err;
    },
  });
  const view = await mountVideoView(t, {
    api,
    planModel: { provider: 'claude', model: 'claude-opus-5' },
  });
  await view.upload({ step: 'review' });
  await view.button('Разобрать на задачи').trigger('click');
  await view.run();

  assert.match(view.wrapper.find('.plan .err').text(), /Модель для разбора не выбрана/u);
});

test('задача уезжает с исполнителем и проектом, а пустой выбор идёт как null', async (t) => {
  const api = fakeApi({
    users: [{ id: 42, name: 'Иванов Иван' }, { id: 43, name: 'Петров Пётр' }],
    groups: [{ id: 7, name: 'Проект А' }],
  });
  const view = await mountVideoView(t, { api });
  await view.upload({ step: 'review' });

  await view.addDraft({ title: 'Первая', createdById: '43', responsibleId: '42', groupId: '7', priority: '2' });
  await view.addDraft({ title: 'Вторая' });
  // Черновик без заголовка не создаётся вовсе: задача без названия смысла не имеет.
  await view.addDraft({ title: '   ' });

  await view.button('Поставить все').trigger('click');
  await view.run();

  const posted = api.posted('/api/b24/tasks');
  assert.equal(posted.length, 2);
  assert.deepEqual(posted[0], {
    title: 'Первая', description: '', createdById: 43, responsibleId: 42, groupId: 7, priority: 2,
    // Ручной черновик не привязан к месту записи, поэтому у него нет ни кадра, ни куска.
    frames: [],
    clips: [],
  });
  // Ноль портал понимает буквально и отвечает ошибкой о несуществующем пользователе —
  // поэтому именно null, а не 0 (docs/grigdesk/b24.md).
  assert.equal(posted[1].createdById, null, 'пусто — значит от владельца сессии, CREATED_BY не уезжает');
  assert.equal(posted[1].responsibleId, null);
  assert.equal(posted[1].groupId, null);
  assert.equal(view.wrapper.findAll('.draft .ok').length, 2, 'номер задачи показывается у своего черновика');
});

test('общий выбор догоняет нетронутые черновики, но не переписывает правку человека', async (t) => {
  const api = fakeApi({ users: [{ id: 42, name: 'Иванов Иван' }, { id: 43, name: 'Петров Пётр' }] });
  const view = await mountVideoView(t, { api });
  await view.upload();

  await view.addDraft({ title: 'A' });
  await view.addDraft({ title: 'B', responsibleId: '43' });

  // Общий выбор на всю встречу: второй селект блока — исполнитель (первый — постановщик).
  await view.wrapper.findAll('.common select')[1].setValue('42');
  await view.run();

  const drafts = view.wrapper.findAll('.draft');
  assert.equal(drafts[0].findAll('select')[1].element.value, '42', 'нетронутый черновик берёт общий выбор');
  assert.equal(drafts[1].findAll('select')[1].element.value, '43', 'явный выбор человека сильнее общего');
});

test('постановщик выбирается отдельно от исполнителя и уезжает как createdById', async (t) => {
  // На встрече поводы приносят разные люди: задача «от того, кто просил» читается
  // иначе, чем «от меня». Портал поле принимает, поэтому выбор отдан человеку.
  const api = fakeApi({ users: [{ id: 42, name: 'Иванов Иван' }, { id: 43, name: 'Петров Пётр' }] });
  const view = await mountVideoView(t, { api });
  await view.upload();

  await view.addDraft({ title: 'A' });
  // Общий постановщик — первый селект блока над черновиками.
  await view.wrapper.findAll('.common select')[0].setValue('43');
  await view.run();

  const draft = view.wrapper.findAll('.draft')[0];
  assert.equal(draft.findAll('select')[0].element.value, '43', 'общий постановщик догнал черновик');
  assert.equal(draft.findAll('select')[1].element.value, '', 'исполнителя он не трогает');

  await view.button('Поставить').trigger('click');
  await view.run();
  const [body] = api.posted('/api/b24/tasks');
  assert.equal(body.createdById, 43);
  assert.equal(body.responsibleId, null);
});

// ── Постановка по одной ─────────────────────────────────────────────────────
// Формулировку собрала модель по чужой речи, поэтому человек решает по КАЖДОЙ задаче
// отдельно. С одной общей кнопкой лишний черновик приходилось удалять только затем,
// чтобы уехал нужный.

/** Кнопка «Поставить» внутри конкретного черновика. */
function draftButton(draft) {
  return draft.findAll('button').find((b) => b.text().includes('Поставить'));
}

test('у каждой задачи своя кнопка, и она ставит только её', async (t) => {
  const api = fakeApi({ post: async () => ({ id: 5150 }) });
  const view = await mountVideoView(t, { api });
  await view.upload();

  await view.addDraft({ title: 'Нужная' });
  await view.addDraft({ title: 'Пока думаю' });

  const drafts = view.wrapper.findAll('.draft');
  await draftButton(drafts[0]).trigger('click');
  await view.run();

  const posted = api.posted('/api/b24/tasks');
  assert.equal(posted.length, 1, 'соседний черновик уехать не имеет права');
  assert.equal(posted[0].title, 'Нужная');

  const after = view.wrapper.findAll('.draft');
  assert.match(after[0].text(), /задача 5150/u, 'номер показан у своего черновика');
  assert.equal(Boolean(draftButton(after[0])), false, 'поставленную задачу нельзя поставить второй раз');
  assert.ok(draftButton(after[1]), 'у нерешённой кнопка остаётся');
});

test('поставленную задачу можно сразу открыть общей карточкой GrigDesk', async (t) => {
  const view = await mountVideoView(t, {
    api: fakeApi({ post: async () => ({ id: 5150 }) }),
  });
  await view.upload();
  await view.addDraft({ title: 'Проверить результат' });

  await draftButton(view.wrapper.find('.draft')).trigger('click');
  await view.run();

  const open = view.wrapper.findAll('.draft button').find((button) => button.text() === 'Открыть');
  assert.ok(open, 'после успешной постановки рядом с номером появляется действие');
  assert.equal(open.attributes('aria-label'), 'Открыть задачу 5150');

  await open.trigger('click');
  assert.deepEqual(view.openedTasks, ['5150'], 'используется единая TaskModal, а не новая вкладка');
});

test('черновик без заголовка поставить нечем', async (t) => {
  const view = await mountVideoView(t, { api: fakeApi() });
  await view.upload();
  await view.addDraft({ title: '   ' });

  const draft = view.wrapper.findAll('.draft')[0];
  assert.equal(draftButton(draft).attributes('disabled'), '', 'задача без названия смысла не имеет');
});

test('отказ портала остаётся у своей задачи, соседние не трогает', async (t) => {
  // При постановке пачкой общая плашка не сказала бы, какая именно задача не уехала.
  const api = fakeApi({
    post: async (url, body) => {
      if (body.title === 'Плохая') throw new Error('портал отказал');
      return { id: 77 };
    },
  });
  const view = await mountVideoView(t, { api });
  await view.upload({ step: 'review' });
  await view.addDraft({ title: 'Плохая' });
  await view.addDraft({ title: 'Хорошая' });

  await view.button('Поставить все').trigger('click');
  await view.run(3);

  const drafts = view.wrapper.findAll('.draft');
  assert.match(drafts[0].text(), /портал отказал/u);
  assert.match(drafts[1].text(), /задача 77/u, 'падение соседа не отменяет остальные');
  assert.ok(draftButton(drafts[0]), 'у неудавшейся задачи кнопка обязана остаться — это повтор');
});

// ── Длительность записи ─────────────────────────────────────────────────────

test('шапка называет длительность ЗАПИСИ, а не только число реплик', async (t) => {
  // Живой случай: вместо 17-минутной встречи уехал соседний ролик на 1:19, и короткий
  // разбор прочитался как «GrigDesk обрезал». Длительность отвечает на это сама.
  const api = fakeApi({
    job: {
      status: 'done',
      progress: null,
      error: null,
      result: { duration: 78.89, transcript: { segments: SEGMENTS } },
    },
  });
  const view = await mountVideoView(t, { api });
  await view.upload({ step: 'review' });

  assert.match(view.wrapper.find('.thead').text(), /запись 01:18/u);
});

test('длинный хвост тишины назван словами, но ошибкой не считается', async (t) => {
  const api = fakeApi({
    // Речь до 4:39, а запись на 20 минут: молчали в конце — законно, но объяснить надо.
    job: {
      status: 'done',
      progress: null,
      error: null,
      result: { duration: 1200, transcript: { segments: SEGMENTS } },
    },
  });
  const view = await mountVideoView(t, { api });
  await view.upload({ step: 'review' });

  const text = view.wrapper.text();
  assert.match(text, /Речь заканчивается на 04:39/u);
  assert.equal(view.wrapper.findAll('.err').length, 0, 'тишина в конце — не поломка');
});

test('без известной длительности ничего не выдумывается', async (t) => {
  const view = await mountVideoView(t, { api: fakeApi() });
  await view.upload({ step: 'review' });

  assert.doesNotMatch(view.wrapper.find('.thead').text(), /запись/u);
  assert.doesNotMatch(view.wrapper.text(), /Речь заканчивается/u);
});

// ── Встреча из нескольких файлов ────────────────────────────────────────────

test('несколько выбранных файлов разбираются как ОДНА встреча', async (t) => {
  // Инструменты записи режут длинный созвон на части; разбирать их порознь значит
  // терять поводы, начатые в одной части и договорённые в другой.
  const jobs = {
    'job-1': {
      status: 'done',
      progress: null,
      error: null,
      result: { duration: 300, transcript: { segments: [{ start: 10, end: 12, text: 'Часть один.' }] } },
    },
    'job-2': {
      status: 'done',
      progress: null,
      error: null,
      result: { duration: 80, transcript: { segments: [{ start: 5, end: 7, text: 'Часть два.' }] } },
    },
  };
  const api = fakeApi({ post: async () => ({ ok: true, model: 'm', count: 2, truncated: false, tasks: [] }) });
  api.get = async (url) => {
    if (url.startsWith('/api/media/ingest/')) return jobs[url.split('/').pop()];
    if (url.endsWith('/api/media/doctor')) return { ok: true, storage: null };
    return { users: [], groups: [] };
  };

  const view = await mountVideoView(t, {
    api, planModel: { provider: 'claude', model: 'claude-opus-5' },
  });
  // Каждая загрузка отвечает своим jobId, как настоящий сервер.
  let n = 0;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ jobId: `job-${++n}` }) });

  const input = view.wrapper.find('input[type="file"]');
  assert.equal(input.attributes('multiple'), '', 'выбрать несколько частей должно быть можно');
  Object.defineProperty(input.element, 'files', {
    // Порядок каталога у браузера произвольный, а части идут по времени файла.
    value: [
      new view.browser.File(['b'], 'встреча-2.webm', { type: 'video/webm', lastModified: 200 }),
      new view.browser.File(['a'], 'встреча-1.webm', { type: 'video/webm', lastModified: 100 }),
    ],
    configurable: true,
  });
  await input.trigger('change');
  await view.run(4);

  assert.deepEqual(api.posted('/api/media/plan-tasks'), [{ jobIds: ['job-1', 'job-2'], hint: '' }],
    'обе части уезжают одной посылкой');
  // Части названы поимённо и по порядку: склейка меняет таймкоды.
  const list = view.wrapper.findAll('.partlist li').map((li) => li.text());
  assert.match(list[0], /встреча-1\.webm/u);
  assert.match(list[1], /встреча-2\.webm/u);
  // Длительность — сумма, реплики — со сквозными таймкодами (300 + 5 = 05:05).
  assert.match(view.wrapper.find('.filenote').text(), /запись 06:20/u);
  await view.button('Расшифровка').trigger('click');
  await view.run();
  const segs = view.wrapper.findAll('.seg').map((s) => s.text());
  assert.match(segs[0], /00:10/u);
  assert.match(segs[1], /05:05/u);
});

// ── Кадр записи ─────────────────────────────────────────────────────────────
// Формулировку задачи собрала модель по чужой речи. Таймкод в описании отвечает на
// «откуда это взято», но требует открыть запись; кадр показывает то же место сразу —
// поэтому он и превью для решения, и вложение к задаче.

const FRAMED_TASKS = [{
  title: 'Время забора',
  description: 'Добавить в комментарий.\n\nНа записи: 04:31',
  confidence: 0.9,
  reason: 'прямая просьба',
  at: null,
  frame: { name: '0123456789abcdef/p0-00272s.jpg', at: 272 },
}];

async function mountWithFrames(t, { tasks = FRAMED_TASKS } = {}) {
  const api = fakeApi({
    post: async (url) => (url === '/api/media/plan-tasks'
      ? { ok: true, model: 'claude/claude-opus-5', count: 4, truncated: false, tasks }
      : { id: 8080 }),
  });
  const view = await mountVideoView(t, {
    api,
    planModel: { provider: 'claude', model: 'claude-opus-5' },
  });
  await view.upload();
  await view.run(3);
  return { api, view };
}

test('кадр виден в черновике до постановки и уезжает вместе с задачей', async (t) => {
  const { api, view } = await mountWithFrames(t);

  const shot = view.wrapper.find('.shot');
  assert.ok(shot.exists(), 'кадр показан рядом с задачей, а не только после постановки');
  // Байты тянутся отдельной ручкой по ИМЕНИ: путь на диске наружу не выходит вовсе.
  assert.equal(shot.find('img').attributes('src'), '/api/media/frame/0123456789abcdef/p0-00272s.jpg');
  // Таймкод кадра и ссылка в описании обязаны указывать на одно место записи.
  assert.match(shot.text(), /04:32/u);
  assert.match(view.wrapper.find('.pdesc').text(), /На записи: 04:31/u);

  await draftButton(view.wrapper.find('.draft')).trigger('click');
  await view.run();
  assert.deepEqual(api.posted('/api/b24/tasks')[0].frames, ['0123456789abcdef/p0-00272s.jpg']);
});

test('«не прикладывать» снимает кадр с задачи, но оставляет его на экране', async (t) => {
  const { api, view } = await mountWithFrames(t);

  const off = view.wrapper.findAll('button').find((b) => b.text().includes('Не прикладывать'));
  await off.trigger('click');
  await view.run();

  // Решение обратимо, поэтому кадр остаётся видимым и приглушённым, а не исчезает.
  assert.ok(view.wrapper.find('.shot').exists());
  assert.ok(view.wrapper.find('.shot').classes().includes('off'));
  assert.ok(view.wrapper.findAll('button').some((b) => b.text().includes('Приложить')));

  await draftButton(view.wrapper.find('.draft')).trigger('click');
  await view.run();
  assert.deepEqual(api.posted('/api/b24/tasks')[0].frames, [], 'отказ доезжает до портала');
});

test('без кадра черновик выглядит как раньше и ничего не обещает', async (t) => {
  // Аудиозапись или отказ ffmpeg: задачи разобраны, кадра просто нет.
  const { api, view } = await mountWithFrames(t, {
    tasks: [{ ...FRAMED_TASKS[0], frame: null }],
  });

  assert.equal(view.wrapper.find('.shot').exists(), false);
  await draftButton(view.wrapper.find('.draft')).trigger('click');
  await view.run();
  assert.deepEqual(api.posted('/api/b24/tasks')[0].frames, []);
});

test('запись видна в диалоге независимо от регистра расширения', async (t) => {
  const view = await mountVideoView(t, { api: fakeApi() });

  // `video/*` нативный диалог разворачивает в список расширений и сравнивает их
  // ПОБУКВЕННО, поэтому `IMG_4793.MOV` из Telegram оказывался серым: выбрать запись
  // было нечем, хотя ffmpeg и whisper разбирают её как любую другую. Отсюда явные
  // расширения в обоих регистрах — маски одни этого не обещают.
  const accept = view.wrapper.find('input[type="file"]').attributes('accept');

  assert.match(accept, /(^|,)video\/\*(,|$)/u, 'маска типа остаётся для браузеров, фильтрующих по типу');
  assert.match(accept, /(^|,)audio\/\*(,|$)/u);
  for (const ext of ['.mov', '.MOV', '.mp4', '.MP4', '.m4a', '.M4A']) {
    assert.ok(accept.split(',').includes(ext), `в accept нет ${ext}`);
  }
});

test('запись, брошенная на карточку, уходит в распознавание', async (t) => {
  const view = await mountVideoView(t, { api: fakeApi() });
  const card = view.wrapper.find('.upload-card');

  await card.trigger('dragenter', { dataTransfer: { types: ['Files'] } });
  await view.run();
  assert.ok(card.classes().includes('over'), 'карточка показывает, что примет файл');

  const file = new view.browser.File(['видео'], 'IMG_4793.MOV', { type: 'video/quicktime' });
  await card.trigger('drop', { dataTransfer: { files: [file] } });
  await view.run();

  // Перетаскивание — второй путь к тому же обработчику: если диалог всё-таки спрячет
  // запись, бросить её на карточку остаётся единственным способом отдать файл.
  assert.equal(card.classes().includes('over'), false, 'подсветка гаснет после броска');
  assert.match(view.wrapper.find('.filenote').text(), /IMG_4793\.MOV/u);
});

// ── Фрагмент записи: предпросмотр и вложение ────────────────────────────────

const CLIPPED_TASKS = [
  {
    ...PLAN_TASKS[0],
    at: 271,
    frame: { name: '0123456789abcdef/p0-00271s.jpg', at: 271 },
  },
];

/** Раздел с разобранной задачей, к которой сервер вырезал кусок записи. */
async function mountWithClip(t, { clip = undefined } = {}) {
  const made = clip === undefined
    ? { name: '0123456789abcdef/p0-00256-030s.mp4', at: 271, from: 256, to: 286, seconds: 30, bytes: 383371 }
    : clip;
  const api = fakeApi({
    post: async (url) => {
      if (url === '/api/media/plan-tasks') {
        return { ok: true, model: 'claude/claude-opus-5', count: 1, truncated: false, tasks: CLIPPED_TASKS };
      }
      if (url === '/api/media/clip') return { clip: made };
      return { id: 7 };
    },
  });
  const view = await mountVideoView(t, {
    api, planModel: { provider: 'claude', model: 'claude-opus-5' },
  });
  await view.upload();
  await view.run(3);
  return { api, view };
}

test('к разобранной задаче подтягивается кусок записи и его видно плеером', async (t) => {
  const { api, view } = await mountWithClip(t);

  // Кусок режется вокруг ТОЙ ЖЕ секунды, что кадр и ссылка в описании: у картинки,
  // у ссылки и у фрагмента должно быть одно место, иначе сверять их нечем.
  assert.deepEqual(api.posted('/api/media/clip'), [{ jobIds: ['job-1'], at: 271, window: 15 }]);

  const player = view.wrapper.find('video.clip-player');
  assert.equal(player.exists(), true, 'фрагмент показывается плеером, а не ссылкой на файл');
  assert.match(player.attributes('src'), /\/api\/media\/clip\/0123456789abcdef\/p0-00256-030s\.mp4$/u);
  // Байты кусков не тянем до нажатия «play»: их на экране столько же, сколько задач.
  assert.equal(player.attributes('preload'), 'metadata');
  assert.match(view.wrapper.find('.clip').text(), /04:16 – 04:46/u);
  assert.match(view.wrapper.find('.clip').text(), /приложится к задаче/u);
});

test('фрагмент уезжает к задаче именем, а отказ человека его снимает', async (t) => {
  const { api, view } = await mountWithClip(t);
  const draft = view.wrapper.find('.draft');

  const off = draft.findAll('button').filter((b) => b.text() === 'Не прикладывать');
  // Кадр и кусок — два разных решения человека, поэтому и кнопки у них свои.
  assert.equal(off.length, 2, 'у кадра и у фрагмента своё «не прикладывать»');
  await off[1].trigger('click');
  await view.run();

  await draft.findAll('button').find((b) => b.text().includes('Поставить')).trigger('click');
  await view.run();
  assert.deepEqual(api.posted('/api/b24/tasks')[0].clips, [], 'отказ снимает вложение');
  assert.deepEqual(api.posted('/api/b24/tasks')[0].frames, ['0123456789abcdef/p0-00271s.jpg']);
});

test('окно фрагмента расширяется кнопкой — единственная ручка у фиксированного куска', async (t) => {
  const { api, view } = await mountWithClip(t);

  await view.wrapper.findAll('button').find((b) => b.text() === 'Шире').trigger('click');
  await view.run(2);

  assert.deepEqual(api.posted('/api/media/clip').at(-1), { jobIds: ['job-1'], at: 271, window: 30 });
});

test('запись без видеодорожки оставляет задачу без фрагмента и без плашки', async (t) => {
  // Аудиовстреча или отказ ffmpeg: задача уже разобрана, и терять её из-за куска нельзя.
  const { api, view } = await mountWithClip(t, { clip: null });

  assert.equal(view.wrapper.find('video.clip-player').exists(), false);
  assert.equal(view.wrapper.find('.clip').exists(), false, 'пустой блок не занимает место');

  await view.wrapper.findAll('button').find((b) => b.text().includes('Поставить')).trigger('click');
  await view.run();
  assert.deepEqual(api.posted('/api/b24/tasks')[0].clips, []);
});

test('кадр и фрагмент открываются просмотрщиком GrigDesk, а не новой вкладкой', async (t) => {
  const { view } = await mountWithClip(t);

  // Разбор встречи — работа в одном экране: уход на соседнюю вкладку ради картинки
  // уносит из виду набранные черновики, а возвращаться приходится руками.
  assert.equal(view.wrapper.find('.shot a[target="_blank"]').exists(), false);

  await view.wrapper.find('.shot-open').trigger('click');
  await view.run();
  assert.deepEqual(view.preview.calls.at(-1), ['image', {
    src: '/api/media/frame/0123456789abcdef/p0-00271s.jpg',
    name: 'Кадр записи на 04:31',
    mime: 'image/jpeg',
  }]);

  await view.wrapper.findAll('button').find((b) => b.text() === 'Крупнее').trigger('click');
  await view.run();
  assert.deepEqual(view.preview.calls.at(-1), ['video', {
    src: '/api/media/clip/0123456789abcdef/p0-00256-030s.mp4',
    name: 'Фрагмент 04:16 – 04:46',
    mime: 'video/mp4',
  }]);
});

test('переход в другой раздел и возврат не теряют разбор', async (t) => {
  // Раздел — обычная страница, и до переноса сеанса в стор её размонтирование уносило
  // id идущего распознавания: работа на сервере продолжалась, а вернуться к ней было
  // нечем. Проверяем ровно этот путь: разобрал, ушёл, вернулся.
  const api = fakeApi();
  const view = await mountVideoView(t, { api });
  await view.upload();
  await view.addDraft({ title: 'Своя задача' });

  await view.remount();

  assert.ok(view.wrapper.find('#video-step-tasks-panel').exists(),
    'возврат продолжает работу с уже набранными задачами');
  assert.equal(view.wrapper.findAll('.draft').length, 1, 'набранный черновик не пропал');
  assert.equal(view.wrapper.find('.draft .dtitle').element.value, 'Своя задача');

  await view.openStep('Разбор');
  assert.match(view.wrapper.text(), /Распознавание завершено/u, 'расшифровка на месте');
  assert.match(view.wrapper.text(), /4 реплик/u);
  // Файл заново не грузится: разбор уже лежит на сервере, у части есть свой jobId.
  assert.equal(api.calls.filter(([m, url]) => m === 'POST' && url === '/api/media/upload').length, 0);
});

test('кнопка «Убрать разбор» спрашивает про черновики и очищает экран', async (t) => {
  const view = await mountVideoView(t, { api: fakeApi(), confirmAnswer: false });
  await view.upload();
  await view.addDraft({ title: 'Своя задача' });

  // Сеанс липкий: он переживает и переход, и перезагрузку. Значит уносить набранное
  // молча нельзя — сначала вопрос.
  await view.button('Убрать разбор').trigger('click');
  await view.run();
  assert.equal(view.confirms.length, 1, 'непоставленный черновик спрашивают');
  assert.equal(view.wrapper.findAll('.draft').length, 1, 'отказ ничего не тронул');

  globalThis.__vidConfirm = async () => true;
  await view.button('Убрать разбор').trigger('click');
  await view.run();
  assert.equal(view.wrapper.find('.result').exists(), false, 'разбор ушёл с экрана');
  assert.equal(view.wrapper.findAll('.draft').length, 0);
});

/** Снимок сеанса, каким его оставляет прошлое открытие раздела. */
function savedSession() {
  return {
    v: 1,
    savedAt: Date.now(),
    parts: [{ name: 'встреча.mp4', size: 2048, jobId: 'job-1' }],
    uploaded: { name: 'встреча.mp4', size: 2048 },
    drafts: [{ title: 'Своя задача' }],
  };
}

test('после перезагрузки страницы разбор возвращается с сервера, а не начинается заново', async (t) => {
  const api = fakeApi();
  const view = await mountVideoView(t, { api, restore: savedSession() });

  assert.ok(view.wrapper.find('#video-step-tasks-panel').exists(),
    'сохранённый черновик возвращает на последний осмысленный этап');
  assert.equal(view.wrapper.find('.draft .dtitle').element.value, 'Своя задача');

  await view.openStep('Разбор');
  assert.match(view.wrapper.text(), /Распознавание завершено/u);
  assert.match(view.wrapper.text(), /4 реплик/u, 'расшифровка дочитана по jobId');

  await view.openStep('Запись');
  assert.equal(view.wrapper.find('input[type="file"]').element.value, '', 'файл заново не выбирают');
});

test('пока сервер не ответил, видно, что разбор возвращается, а не пропал', async (t) => {
  const api = fakeApi();
  // Ответ статуса подвешен: между открытием страницы и первым ответом раздел не имеет
  // права выглядеть пустой формой — разбор в это время идёт на сервере.
  api.get = async (url) => {
    if (url.startsWith('/api/media/ingest/')) return new Promise(() => {});
    if (url.endsWith('/api/media/doctor')) return { ok: true, storage: null };
    return {};
  };
  const view = await mountVideoView(t, { api, restore: savedSession() });

  assert.match(view.wrapper.find('.progress').text(), /Возвращаюсь к разбору/u);
  assert.equal(view.wrapper.find('.result').exists(), false);
});

test('раздел говорит, сколько записей лежит на диске и когда они уйдут', async (t) => {
  // Исходники раздел хранит ради кадров и фрагментов, поэтому рост виден только по
  // свободному месту на диске — то есть слишком поздно. Живой замер: 1,4 ГБ за неделю.
  const view = await mountVideoView(t, {
    api: fakeApi({ storage: { files: 12, bytes: 1503238553, ttlMs: 7 * 24 * 60 * 60 * 1000 } }),
  });

  const note = view.wrapper.find('.storage-note').text();
  assert.match(note, /удаляются через 7 дн/u);
  assert.match(note, /12 на диске/u);
  assert.match(note, /1\.4 ГБ/u);
});

test('пустое хранилище строкой не отчитывается', async (t) => {
  const view = await mountVideoView(t, { api: fakeApi({ storage: { files: 0, bytes: 0, ttlMs: 0 } }) });

  assert.equal(view.wrapper.find('.storage-note').exists(), false);
});

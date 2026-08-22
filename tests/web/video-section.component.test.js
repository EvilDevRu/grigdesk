// Раздел «Видео → задачи»: что человек видит после распознавания и с чем уезжает задача.
//
// Обещания:
//  - расшифровку можно прочитать целиком, а не только построчно: сплошной текст
//    режется на абзацы по паузам, потому что голосов распознавание не различает;
//  - разбор моделью ДОПОЛНЯЕТ уже набранные черновики, а не затирает их;
//  - без выбранной модели раздел работает как раньше и объясняет, где её включить;
//  - задача уезжает с исполнителем, проектом и приоритетом, а пустой выбор идёт как
//    null: нулевой responsibleId портал понимает буквально и отвечает ошибкой.
//
// Состояние `<script setup>` наружу не выдаётся (`inlineTemplate` держит биндинги в
// замыкании), и это к лучшему: проверяем тот же путь, что проходит человек — загрузка
// файла, вкладки, кнопки, — а не внутренние ref.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { installBrowser, settle } from './helpers/telegram-view.js';

process.env.NODE_ENV = 'test';

const VIEW_PATH = fileURLToPath(new URL('../../web/src/views/VideoView.vue', import.meta.url));
const VUE_URL = pathToFileURL(fileURLToPath(
  new URL('../../web/node_modules/vue/index.mjs', import.meta.url),
)).href;
const TEST_UTILS = '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs';
const COMPILER_SFC = '../../web/node_modules/@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js';

let compileNonce = 0;

const SEGMENTS = [
  { start: 0, end: 3.2, text: 'Привет, все на месте?' },
  { start: 3.4, end: 6, text: 'Да, начинаем.' },
  // Пауза больше 2.5 с — новая мысль, а значит новый абзац.
  { start: 271.5, end: 275, text: 'Надо добавить время забора в комментарий.' },
  { start: 275.4, end: 279, text: 'И вторым номером приоритет.' },
];

const DONE_JOB = { status: 'done', result: { transcript: { segments: SEGMENTS } } };

const PLAN_TASKS = [
  {
    title: 'Время забора',
    description: 'Добавить в комментарий.\n\nНа записи: 04:31',
    confidence: 0.9,
    reason: 'прямая просьба',
  },
  {
    title: 'Приоритет вторым номером',
    description: 'Указывать приоритет.',
    confidence: 0.4,
    reason: 'сказано вскользь',
  },
];

/** Роутер api раздела: ростер и проекты портала плюс подставные ответы. */
function fakeApi({ users = [], groups = [], job = DONE_JOB, post = async () => ({ id: 1234 }) } = {}) {
  const calls = [];
  return {
    calls,
    posted: (url) => calls.filter(([method, target]) => method === 'POST' && target === url).map(([, , body]) => body),
    async get(url) {
      calls.push(['GET', url]);
      if (url.endsWith('/api/b24/users')) return { users };
      if (url.endsWith('/api/b24/groups')) return { groups };
      if (url.endsWith('/api/media/doctor')) return { ok: true };
      if (url.startsWith('/api/media/ingest/')) return job;
      return {};
    },
    async post(url, body) {
      calls.push(['POST', url, body]);
      return post(url, body);
    },
  };
}

async function mountVideoView(t, { api, planModel = null } = {}) {
  const browser = await installBrowser(t);
  globalThis.__vidApi = api;
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

  const { parse, compileScript } = await import(COMPILER_SFC);
  const source = await readFile(VIEW_PATH, 'utf8');
  const { descriptor, errors } = parse(source, { filename: VIEW_PATH });
  assert.deepEqual(errors, []);
  const code = compileScript(descriptor, {
    id: `data-v-video-${compileNonce}`,
    inlineTemplate: true,
  }).content
    .replaceAll('from "vue"', `from "${VUE_URL}"`)
    .replaceAll("from 'vue'", `from "${VUE_URL}"`)
    // У data:-модуля нет ни базового пути, ни сборщика, поэтому подстановки Vite
    // до него не доезжают: `import.meta.env` здесь просто undefined.
    .replaceAll('import.meta.env.VITE_BRAIN_URL', "''")
    .replace("import { api } from '../shared/api-client.js';", 'const api = globalThis.__vidApi;')
    .replace(
      "import { usePluginsStore } from '../stores/plugins.js';",
      'const usePluginsStore = globalThis.__vidPluginsStore;',
    )
    // HelpTip — обычный компонент, заглушке достаточно занять его место.
    .replace(
      "import HelpTip from '../shared/ui/HelpTip.vue';",
      'const HelpTip = { name: "HelpTip", props: ["text"], template: "<i/>" };',
    );
  const nonce = compileNonce++;
  const VideoView = (await import(
    `data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${nonce}`
  )).default;

  const { mount, flushPromises } = await import(TEST_UTILS);
  const wrapper = mount(VideoView, { attachTo: browser.document.querySelector('#mount') });
  t.after(() => {
    wrapper.unmount();
    delete globalThis.__vidApi;
    delete globalThis.__vidPluginsStore;
  });
  await settle(flushPromises);

  const run = (n) => settle(flushPromises, n);
  const button = (label) => wrapper.findAll('button').find((b) => b.text().includes(label));

  /** Тот же путь, что у человека: выбрал файл → загрузка → поллинг → готовая расшифровка. */
  async function upload() {
    const input = wrapper.find('input[type="file"]');
    Object.defineProperty(input.element, 'files', {
      value: [new browser.File(['видео'], 'встреча.mp4', { type: 'video/mp4' })],
      configurable: true,
    });
    await input.trigger('change');
    await run();
  }

  /**
   * Черновик через интерфейс: кнопка, заголовок и, если нужно, свои селекты.
   * Порядок селектов один и тот же в черновике и в общем блоке — «от кого», «кому»,
   * проект, приоритет: сначала источник задачи, потом адресат.
   */
  async function addDraft({ title, createdById, responsibleId, groupId, priority } = {}) {
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

  return { browser, wrapper, run, button, upload, addDraft };
}

test('сплошной текст собирается абзацами по паузам, реплики остаются отдельным видом', async (t) => {
  const view = await mountVideoView(t, { api: fakeApi() });
  await view.upload();

  // Расшифровка свёрнута: раздел отвечает на «какие задачи», а реплики нужны, когда
  // формулировку сверяют с записью. Само число реплик видно и в свёрнутом виде.
  assert.equal(view.wrapper.findAll('.seg').length, 0, 'реплики не разворачиваются сами');
  assert.match(view.wrapper.find('.transcript').text(), /4 реплик/u);

  await view.button('Расшифровка').trigger('click');
  await view.run();
  // Развернули — вид по умолчанию реплики: у каждой свой таймкод и клик в черновик.
  assert.equal(view.wrapper.findAll('.seg').length, 4);

  await view.wrapper.findAll('.tab')[1].trigger('click');
  const paragraphs = view.wrapper.findAll('.para');
  assert.equal(paragraphs.length, 2, 'пауза 265 с обязана разделить абзацы');
  assert.match(paragraphs[0].text(), /Привет, все на месте\?\s+Да, начинаем\./u);
  assert.match(paragraphs[1].text(), /04:31/u);
  assert.match(paragraphs[1].text(), /Надо добавить время забора.*И вторым номером приоритет/u);
});

test('без выбранной модели раздел объясняет себя и не предлагает разбор', async (t) => {
  const view = await mountVideoView(t, { api: fakeApi() });
  await view.upload();

  assert.match(view.wrapper.text(), /Настройки → Плагины/u);
  assert.equal(view.button('Разобрать на задачи'), undefined);
  // Ручной разбор при этом на месте — раздел не становится бесполезным.
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
  await view.upload();

  // Разбор запускается САМ по готовности расшифровки: человек пришёл за задачами.
  assert.deepEqual(api.posted('/api/media/plan-tasks'), [{ jobIds: ['job-1'], hint: '' }],
    'части встречи уезжают одной посылкой — сервер склеит их со сквозными таймкодами');
  assert.equal(view.wrapper.findAll('.draft').length, 2, 'задачи модели уже на экране');

  // Человек начал разбирать сам — эта работа не должна пропасть при повторе.
  await view.addDraft({ title: 'Своя задача' });
  await view.button('Разобрать на задачи').trigger('click');
  await view.run();

  const drafts = view.wrapper.findAll('.draft');
  assert.equal(drafts.length, 5, 'повтор дополняет, а не затирает набранное');
  assert.match(drafts[0].find('.ptitle').text(), /Время забора/u);
  assert.equal(drafts[2].find('.dtitle').element.value, 'Своя задача');
  // Уверенность видна человеку: формулировку собрала модель, проверять её ему.
  assert.match(view.wrapper.text(), /модель: 90%/u);
  assert.match(view.wrapper.text(), /модель: 40%/u);
  assert.match(view.wrapper.text(), /предложила задач: 2/u);
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
    job: { status: 'done', result: { duration: 78.89, transcript: { segments: SEGMENTS } } },
  });
  const view = await mountVideoView(t, { api });
  await view.upload();

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
  await view.upload();
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
  await view.upload();

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
    // Ручной черновик кадра не имеет: он не привязан к месту записи.
    frames: [],
  });
  // Ноль портал понимает буквально и отвечает ошибкой о несуществующем пользователе —
  // поэтому именно null, а не 0 (docs/cockpit/b24.md).
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
  assert.equal(draftButton(after[0]), undefined, 'поставленную задачу нельзя поставить второй раз');
  assert.ok(draftButton(after[1]), 'у нерешённой кнопка остаётся');
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
  await view.upload();
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
  // разбор прочитался как «кокпит обрезал». Длительность отвечает на это сама.
  const api = fakeApi({
    job: { status: 'done', result: { duration: 78.89, transcript: { segments: SEGMENTS } } },
  });
  const view = await mountVideoView(t, { api });
  await view.upload();

  assert.match(view.wrapper.find('.thead').text(), /запись 01:18/u);
});

test('длинный хвост тишины назван словами, но ошибкой не считается', async (t) => {
  const api = fakeApi({
    // Речь до 4:39, а запись на 20 минут: молчали в конце — законно, но объяснить надо.
    job: { status: 'done', result: { duration: 1200, transcript: { segments: SEGMENTS } } },
  });
  const view = await mountVideoView(t, { api });
  await view.upload();

  const text = view.wrapper.text();
  assert.match(text, /Речь заканчивается на 04:39/u);
  assert.equal(view.wrapper.findAll('.err').length, 0, 'тишина в конце — не поломка');
});

test('без известной длительности ничего не выдумывается', async (t) => {
  const view = await mountVideoView(t, { api: fakeApi() });
  await view.upload();

  assert.doesNotMatch(view.wrapper.find('.thead').text(), /запись/u);
  assert.doesNotMatch(view.wrapper.text(), /Речь заканчивается/u);
});

// ── Встреча из нескольких файлов ────────────────────────────────────────────

test('несколько выбранных файлов разбираются как ОДНА встреча', async (t) => {
  // Инструменты записи режут длинный созвон на части; разбирать их порознь значит
  // терять поводы, начатые в одной части и договорённые в другой.
  const jobs = {
    'job-1': { status: 'done', result: { duration: 300, transcript: { segments: [{ start: 10, end: 12, text: 'Часть один.' }] } } },
    'job-2': { status: 'done', result: { duration: 80, transcript: { segments: [{ start: 5, end: 7, text: 'Часть два.' }] } } },
  };
  const api = fakeApi({ post: async () => ({ ok: true, model: 'm', count: 2, truncated: false, tasks: [] }) });
  api.get = async (url) => {
    if (url.startsWith('/api/media/ingest/')) return jobs[url.split('/').pop()];
    if (url.endsWith('/api/media/doctor')) return { ok: true };
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

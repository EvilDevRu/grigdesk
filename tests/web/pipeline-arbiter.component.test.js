// Кнопка арбитра в плашке затыка.
//
// Арбитр — единственное действие GrigDesk, которое двигает курсор чужой задачи по решению
// модели. Поэтому здесь проверяется прежде всего ГЕЙТ: он обязан читать машинный вид
// остановки (`stall.stop`), а не заголовок. Заголовок пишется человеку и меняется вместе
// с формулировками движка; привяжи кнопку к нему — и она однажды появится над остановкой,
// решение для которой из вердиктов дуги не выводится вовсе.
import assert from 'node:assert/strict';
import test from 'node:test';
import { compilePipelineView } from './helpers/pipeline-view.js';

process.env.NODE_ENV = 'test';

function makeFixture({ stall, result = null, arbitrating = null } = {}) {
  const factoryTask = {
    arbitrating,
    task: 42,
    profile: 'project-alpha',
    route: 'feature',
    readOnly: false,
    workspaceMode: 'isolated',
    daemonAlive: false,
    attempt: 'a_0ec48def',
    result,
    stall,
  };
  const graph = {
    route: 'feature',
    readOnly: false,
    fePort: null,
    sandbox: null,
    daemonAlive: false,
    nodes: { plan: [0, '📋 План'], skeptic: [1, '🕵 Скептик'] },
    pos: { plan: 0, skeptic: 1 },
    keys: { plan: 'PLAN', skeptic: 'SKEPTIC' },
    statuses: { plan: 'done', skeptic: 'fail' },
    nodeMeta: {},
    progress: { done: 1, total: 2, current: 'skeptic' },
  };
  return { factoryTask, graph };
}

const NO_PROGRESS_STALL = {
  kind: 'human',
  stop: 'no-progress',
  // Признак считает СЕРВЕР одним правилом (`stopIsArbitrable`) вместе с гейтом самого
  // арбитра; карточка его только читает. Раньше здесь стояла своя копия сравнения с
  // `no-progress`, и после расширения арбитра на вызов человека узлом она бы разошлась.
  arbitrable: true,
  stage: 'SKEPTIC',
  title: 'SKEPTIC: замкнутый набор замечаний расширен новыми id: shared-module',
  hint: 'блокирующие замечания пережили ремонт',
  since: '17:55',
  comment: null,
};

async function mountPipeline(t, { factoryTask, graph }, { response, compact = true } = {}) {
  const { Window } = await import('../../web/node_modules/happy-dom/lib/index.js');
  const browser = new Window({ url: 'http://grigdesk.test/#/pipeline' });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    location: browser.location,
    localStorage: browser.localStorage,
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
  // Свёрнутая карточка показывает плашку затыка целиком, развёрнутая — только её
  // действенную часть: заголовок и подсказку там уже говорит плашка над схемой.
  if (compact) browser.localStorage.setItem('grigdesk-compact', '1');
  browser.document.body.innerHTML = '<div id="mount"></div>';

  const [{ mount, flushPromises }, { createPinia, defineStore }] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
  ]);
  const posts = [];
  const bodies = [];
  globalThis.__pipelineArbiterDialogs = [];
  globalThis.__pipelineArbiterConfirmDialog = async (text) => {
    globalThis.__pipelineArbiterDialogs.push(text);
    return true;
  };
  globalThis.__pipelineArbiterAlertDialog = async (text) => {
    globalThis.__pipelineArbiterDialogs.push(text);
  };
  globalThis.__pipelineArbiterApiCalls = [];
  globalThis.__pipelineArbiterApi = {
    async get(url) {
      globalThis.__pipelineArbiterApiCalls.push(url);
      if (url === '/api/tasks') return { tasks: [factoryTask] };
      if (url === `/api/tasks/${factoryTask.task}/graph`) return graph;
      if (url === '/api/factory/runners') return { runners: [] };
      return {};
    },
    async post(url, body) {
      posts.push(url);
      bodies.push({ url, body: body || null });
      return response || { ok: true, resolved: true };
    },
  };
  globalThis.__pipelineArbiterFactoryGraph = {
    name: 'FactoryGraph',
    props: ['graph', 'loopsOn'],
    emits: ['node'],
    template: '<div class="fg-stub"></div>',
  };
  globalThis.__pipelineArbiterUiStore = defineStore('pipeline-arbiter-ui', { actions: { openTask() {} } });
  globalThis.__pipelineArbiterTasksStore = defineStore('pipeline-arbiter-tasks', {
    actions: { async load() { return {}; }, title() { return 'Задача'; } },
  });
  globalThis.__pipelineArbiterBoardStore = defineStore('pipeline-arbiter-board', {
    state: () => ({ data: null }), actions: { async load() {} },
  });
  const wrapper = mount(await compilePipelineView('__pipelineArbiter'), {
    attachTo: browser.document.querySelector('#mount'),
    global: { plugins: [createPinia()], stubs: { teleport: true } },
  });
  t.after(() => {
    wrapper.unmount();
    browser.close();
    for (const key of [
      '__pipelineArbiterApi', '__pipelineArbiterApiCalls', '__pipelineArbiterDialogs', '__pipelineArbiterConfirmDialog',
      '__pipelineArbiterAlertDialog', '__pipelineArbiterFactoryGraph', '__pipelineArbiterUiStore',
      '__pipelineArbiterTasksStore', '__pipelineArbiterBoardStore',
    ]) delete globalThis[key];
  });
  await flushPromises();
  return {
    wrapper, flushPromises, posts, bodies, dialogs: globalThis.__pipelineArbiterDialogs,
  };
}

const arbiterButton = (wrapper) => wrapper.findAll('.stalled button')
  .find((button) => /разобрать остановку/.test(button.text()));
const openAnswerButton = (wrapper) => wrapper.find('[data-role="pipeline-stall-answer-open"]');
const sendButton = (wrapper) => wrapper.find('[data-role="pipeline-arbiter-send"]');
const answerField = (wrapper) => wrapper.find('[data-role="pipeline-arbiter-answer"]');
const openStageNode = async (wrapper, flushPromises, node) => {
  wrapper.findComponent(globalThis.__pipelineArbiterFactoryGraph).vm.$emit('node', node);
  await flushPromises();
};

// Разбор арбитра заканчивается словами «решать тебе» — и до 28.08.2026 отправить это
// решение было нечем: плашка предлагала только позвать арбитра ещё раз либо продолжить
// прогон той же попыткой без указания, то есть заехать в ту же остановку. Пишется оно в
// СВОЕЙ модалке: узел отвечает на другой вопрос — чем занят исполнитель и чем кончился
// заход, — и вместе с четырьмя абзацами разбора на один экран они не поместились.
test('кнопка плашки открывает исторический разбор в том же окне узла без применения', async (t) => {
  const { wrapper, flushPromises, bodies } = await mountPipeline(t, makeFixture({
    stall: { ...NO_PROGRESS_STALL, arbiter: ARBITER_CARD },
  }));

  await openAnswerButton(wrapper).trigger('click');
  await flushPromises();
  const block = wrapper.get('[data-role="arbiter-conversation"]');

  assert.match(block.text(), /удешевить рендер строки/);
  assert.match(block.text(), /оба измеренных рычага/);
  assert.equal(wrapper.find('.smodal').exists(), true);
  assert.equal(wrapper.find('[data-role="pipeline-arbiter-decision"]').exists(), false);
  assert.deepEqual(bodies, []);
});
// Модалка узла осталась про заход: разбор в ней — признак со входом, а не текст.
test('в модалке узла разбор занимает общий блок без второй формы возврата', async (t) => {
  const { wrapper, flushPromises } = await mountPipeline(t, makeFixture({
    stall: { ...NO_PROGRESS_STALL, arbiter: ARBITER_CARD },
  }), { compact: false });

  await openStageNode(wrapper, flushPromises, {
    id: 'skeptic', label: '🕵 Скептик', subtitle: '', status: 'stall',
  });

  assert.match(wrapper.get('.smodal [data-role="arbiter-conversation"]').text(), /оба измеренных рычага/);
  assert.equal(wrapper.find('.rewind-sect').exists(), false);
  assert.equal(wrapper.find('[data-role="pipeline-arbiter-decision"]').exists(), false);
});
// Кнопка обязана называть то, что за ней стоит: разбор, который человек ещё не читал.
test('новая остановка того же узла открывает текущий диалог вместо предыдущего', async (t) => {
  const fx = makeFixture({ stall: NO_PROGRESS_STALL });
  const oldId = `c_${'a'.repeat(32)}`;

  fx.graph.arbiterConversations = [{
    conversationId: oldId,
    identity: {
      task: '42',
      profile: 'project-alpha',
      attempt: `a_${'a'.repeat(32)}`,
      node: 'skeptic',
      stop: 'no-progress',
      stageSequence: 3,
      stageHeadHash: 'b'.repeat(64),
    },
    state: 'resolved',
  }];

  const { wrapper, flushPromises } = await mountPipeline(t, fx, { compact: false });

  await openStageNode(wrapper, flushPromises, {
    id: 'skeptic', label: 'Скептик', status: 'stall',
  });
  assert.equal(globalThis.__pipelineArbiterApiCalls
    .some((url) => url.includes(`/arbiter-conversations/${oldId}`)), false);
  assert.equal(wrapper.get('[data-role="arbiter-conversation"]').text().includes('Предыдущие разборы'), true);
});

test('вход в решение назван разбором, когда арбитр отдал вопрос человеку', async (t) => {
  const { wrapper } = await mountPipeline(t, makeFixture({
    stall: { ...NO_PROGRESS_STALL, arbiter: ARBITER_CARD },
  }));
  assert.equal(/разбор остановки/i.test(openAnswerButton(wrapper).text()), true);
});

// В ленте от разбора остаётся ОДНА строка-признак: четыре абзаца человек читает один
// раз, а лента конвейера отвечает на «где стоит и на ком».
test('в ленте от разбора остаётся строка-признак, а не весь текст', async (t) => {
  const { wrapper } = await mountPipeline(t, makeFixture({
    stall: { ...NO_PROGRESS_STALL, arbiter: ARBITER_CARD },
  }));

  const note = wrapper.get('.stalled .sarbnote');
  assert.equal(note.text().includes('решать тебе'), true);
  assert.equal(note.text().includes('оба измеренных рычага'), false);
  assert.equal(wrapper.find('.stalled .sarbiter').exists(), false);
});

// Карточка привязана к попытке, а не к узлу: после ответа маршрут может встать дальше,
// и прежний разбор остался бы на экране как свежий — то есть предложил бы ответить на
// вчерашний вопрос.
test('разбор чужого узла не выдаётся за разбор открытого', async (t) => {
  const { wrapper, flushPromises } = await mountPipeline(t, makeFixture({
    stall: { ...NO_PROGRESS_STALL, arbiter: { ...ARBITER_CARD, node: 'plan' } },
  }));

  assert.equal(/разбор остановки/i.test(openAnswerButton(wrapper).text()), true);
  await openAnswerButton(wrapper).trigger('click');
  await flushPromises();
  assert.equal(wrapper.find('.smodal .sarbopen').exists(), false);
  assert.equal(wrapper.get('.smodal [data-role="arbiter-conversation"]')
    .text().includes(ARBITER_CARD.card.what), false);
  assert.equal(wrapper.find('[data-role="pipeline-arbiter-decision"]').exists(), false);
});

// «Поехать дальше без слов» — это соседняя кнопка «продолжить прогон». Пустой возврат
// сбросил бы хвост маршрута, ничего не ответив на заданный арбитром вопрос.
test('у исторического разбора нет активного применения', async (t) => {
  const { wrapper, flushPromises } = await mountPipeline(t, makeFixture({
    stall: { ...NO_PROGRESS_STALL, arbiter: ARBITER_CARD },
  }));

  await openAnswerButton(wrapper).trigger('click');
  await flushPromises();
  assert.equal(wrapper.find('[data-role="arbiter-apply"]').exists(), false);
  assert.equal(wrapper.find('[data-role="arbiter-custom-apply"]').exists(), false);
});
// Оборвавшийся прогон узлом не лечится: там нужен resume той же попытки.
test('оборвавшемуся прогону вход в решение не предлагается', async (t) => {
  const { wrapper } = await mountPipeline(t, makeFixture({
    stall: {
      kind: 'crashed', stop: null, arbitrable: false, stage: 'SKEPTIC',
      title: 'прогон оборвался', hint: 'демон умер', since: '18:20', comment: null,
    },
  }));
  assert.equal(openAnswerButton(wrapper).exists(), false);
});


test('кнопка арбитра есть у остановки по отсутствию прогресса', async (t) => {
  const { wrapper } = await mountPipeline(t, makeFixture({ stall: NO_PROGRESS_STALL }));
  assert.ok(arbiterButton(wrapper), 'кнопка показана');
});

test('гейт читает признак сервера, а не заголовок остановки', async (t) => {
  // Исчерпанный лимит возвратов — та же дуга и почти тот же текст, но решение там
  // принимает человек: набор замечаний мог и не расширяться, круги просто кончились.
  const { wrapper } = await mountPipeline(t, makeFixture({
    stall: {
      ...NO_PROGRESS_STALL,
      stop: 'rewind-limit',
      arbitrable: false,
      title: 'SKEPTIC: исчерпан лимит возвратов',
    },
  }));

  assert.equal(Boolean(arbiterButton(wrapper)), false);
});

// Узел, сам позвавший человека, — самая частая объявленная остановка маршрутов, и часть
// её случаев решается чтением кода. Сервер отдаёт такую задачу арбитру тем же признаком.
test('вызов человека узлом тоже получает кнопку арбитра', async (t) => {
  const { wrapper } = await mountPipeline(t, makeFixture({
    stall: {
      ...NO_PROGRESS_STALL,
      stop: 'human',
      arbitrable: true,
      title: 'SKEPTIC: узел вернул решение человеку',
    },
  }));
  assert.notEqual(arbiterButton(wrapper), undefined);
});

// А отказ среды или сборки — нет: он не становится решаемым оттого, что его прочитали.
test('вызов человека по отказу среды кнопки не даёт', async (t) => {
  const { wrapper } = await mountPipeline(t, makeFixture({
    stall: {
      ...NO_PROGRESS_STALL, stop: 'human', arbitrable: false, title: 'BUILD: стенд не поднялся',
    },
  }));

  assert.equal(Boolean(arbiterButton(wrapper)), false);
});

test('затык без машинного вида арбитру не отдаётся', async (t) => {
  // Упавший стенд, нехватка прав, оборванный демон: вердиктов дуги там нет вовсе,
  // и выводить решение не из чего.
  const { wrapper } = await mountPipeline(t, makeFixture({
    stall: {
      kind: 'human', stage: 'SANDBOX', title: 'стенд не поднялся', hint: 'смотри журнал', since: null,
    },
  }));

  assert.equal(Boolean(arbiterButton(wrapper)), false);
});

test('нажатие начинает читающий разбор и открывает узел без подтверждения движения', async (t) => {
  const { wrapper, flushPromises, posts, dialogs } = await mountPipeline(t,
    makeFixture({ stall: NO_PROGRESS_STALL }), {
      response: { conversationId: 'conversation', operationId: 'operation', revision: 1 },
    });

  await arbiterButton(wrapper).trigger('click');
  await flushPromises();

  assert.deepEqual(posts, ['/api/tasks/42/arbitrate']);
  assert.deepEqual(dialogs, []);
  assert.equal(wrapper.find('.smodal [data-role="arbiter-conversation"]').exists(), true);
});
test('короткий ответ запуска не выдаётся за принятое исправление', async (t) => {
  const { wrapper, flushPromises, posts, dialogs } = await mountPipeline(t,
    makeFixture({ stall: NO_PROGRESS_STALL }), {
      response: { conversationId: 'conversation', operationId: 'operation', revision: 1 },
    });

  await arbiterButton(wrapper).trigger('click');
  await flushPromises();

  assert.deepEqual(posts, ['/api/tasks/42/arbitrate']);
  assert.equal(dialogs.some((text) => /Арбитр вернул узел|исправлено/.test(text)), false);
});
// Разбор арбитра — единственное место, где машинный жаргон вердиктов («Д9/T1 опровергнут»,
// «П1 вычитает ноль кадров») превращается в человеческую формулировку. Раньше он
// показывался одноразовым диалогом нажавшему кнопку, а у автоматического пути пропадал
// вовсе: ход живого агента тратился, понятный ответ писался и терялся.
const ARBITER_CARD = {
  verdict: 'human',
  scopeChange: true,
  model: 'claude/claude-opus-5',
  node: 'skeptic',
  stop: 'human',
  at: '2026-08-28T14:00:00Z',
  card: {
    what: 'решать тебе: удешевить рендер строки либо закрыть как косметику',
    why: 'оба измеренных рычага дают доли процента при дефиците кадров',
    proof: 'прочитал замеры узла и сверил с кодом прокрутки',
    risk: 'выбор не проверяется автоматически — ошибка вылезет на приёмке',
  },
};

test('разбор целиком показан внутри проблемного узла', async (t) => {
  const { wrapper, flushPromises } = await mountPipeline(t, makeFixture({
    stall: { ...NO_PROGRESS_STALL, arbiter: ARBITER_CARD },
  }));

  await openAnswerButton(wrapper).trigger('click');
  await flushPromises();

  const block = wrapper.get('.smodal [data-role="arbiter-conversation"]');
  assert.equal(block.text().includes('удешевить рендер строки'), true);
  assert.equal(block.text().includes('оба измеренных рычага'), true);
  assert.equal(block.text().includes('прочитал замеры узла'), true);
  assert.equal(block.text().includes('вылезет на приёмке'), true);
});

// Решение, оставленное человеку, — ожидание его хода, а не готовый ответ: тон другой.
test('разбор, отданный человеку, помечен отдельно от снятого тупика', async (t) => {
  const { wrapper } = await mountPipeline(t, makeFixture({
    stall: { ...NO_PROGRESS_STALL, arbiter: ARBITER_CARD },
  }));
  // В ленте это тон строки-признака, в модалке — тон самого разбора.
  assert.equal(wrapper.get('.stalled .sarbnote').classes().includes('human'), true);
  assert.equal(wrapper.get('.stalled .sarbnote').text().includes('решать тебе'), true);
});

test('снятый арбитром тупик назван своими словами', async (t) => {
  const { wrapper } = await mountPipeline(t, makeFixture({
    stall: {
      ...NO_PROGRESS_STALL,
      arbiter: { ...ARBITER_CARD, verdict: 'resolve', scopeChange: false },
    },
  }));
  assert.equal(wrapper.get('.stalled .sarbnote').text().includes('снял тупик'), true);
  assert.equal(wrapper.get('.stalled .sarbnote').classes().includes('human'), false);
});


test('без разбора блок не рисуется', async (t) => {
  const { wrapper } = await mountPipeline(t, makeFixture({ stall: NO_PROGRESS_STALL }));
  assert.equal(wrapper.find('.stalled .sarbnote').exists(), false);
});

// Пока арбитр читает код, задача снаружи неотличима от вставшей: та же плашка затыка, та
// же кнопка. Человек читает это как «стоит на мне» и берётся за работу руками — параллельно
// с арбитром, который в этот момент её и делает. Признак живёт на СЕРВЕРЕ: прежний
// `arbiterBusy` был локальным Set нажавшего окна, поэтому автоматический обход вотчера не
// показывался нигде и вообще ни в одном окне.
test('идущий разбор виден плашкой и убирает кнопку', async (t) => {
  const { wrapper } = await mountPipeline(t, makeFixture({
    stall: NO_PROGRESS_STALL,
    arbitrating: { actor: 'auto', model: 'claude/claude-opus-5', startedAt: Date.now(), elapsedSec: 95 },
  }));

  const run = wrapper.get('.sarbrun');
  assert.equal(run.text().includes('Арбитр разбирает остановку'), true);
  // «сам» отвечает на вопрос «почему задача едет без меня»: нажатую кнопку человек помнит,
  // а обход вотчера выглядит самодвижением конвейера.
  assert.equal(run.text().includes('сам'), true);
  assert.equal(run.text().includes('1 мин'), true);
  const arbiterButton = wrapper.findAll('.sbretry')
    .find((button) => button.text().includes('разобрать остановку'));

  assert.equal(Boolean(arbiterButton), false, 'второй арбитраж спорил бы за исполнителя');
});

test('разбор по кнопке называет себя иначе, чем обход вотчера', async (t) => {
  const { wrapper } = await mountPipeline(t, makeFixture({
    stall: NO_PROGRESS_STALL,
    arbitrating: { actor: 'human', model: null, startedAt: Date.now(), elapsedSec: 12 },
  }));

  const run = wrapper.get('.sarbrun');
  assert.equal(run.text().includes('по кнопке'), true);
  assert.equal(run.text().includes('12 с'), true);
});

// Разбор не меняет файлы состояния, поэтому `state-change` его не приносит: у начала и
// конца хода своё событие шины. Без подписки окно узнавало бы о работающем арбитре только
// на следующем перечитывании — то есть когда всё уже кончилось.
test('событие шины arbiter-live перечитывает задачи', async (t) => {
  const { wrapper } = await mountPipeline(t, makeFixture({ stall: NO_PROGRESS_STALL }));
  const before = globalThis.__pipelineArbiterApiCalls?.length ?? null;

  globalThis.__pipelineArbiterSseHandler('arbiter-live', { task: '42' });
  await new Promise((resolve) => { setTimeout(resolve, 900); });

  assert.notEqual(before, null, 'harness обязан считать обращения к API');
  assert.equal(globalThis.__pipelineArbiterApiCalls.length > before, true);
  assert.equal(wrapper.exists(), true);
});

// Развёрнутая карточка показывает схему, и до 28.08.2026 `isCollapsed` уносил из неё всю
// плашку затыка — вместе с законченным разбором арбитра и всеми кнопками действия.
// Человек с открытым графом видел красный узел и ничего больше: разбор, объясняющий
// остановку человеческими словами, был ему недоступен, и это читалось как «арбитр молчит».
test('признак разбора и вход в решение видны и в развёрнутой карточке', async (t) => {
  const { wrapper } = await mountPipeline(
    t,
    makeFixture({ stall: { ...NO_PROGRESS_STALL, arbiter: ARBITER_CARD } }),
    { compact: false },
  );

  assert.equal(wrapper.find('.gwrap').exists(), true, 'карточка развёрнута — схема на месте');

  assert.equal(wrapper.get('.stalled .sarbnote').text().includes('решать тебе'), true);
  assert.equal(openAnswerButton(wrapper).exists(), true, 'вход в решение доступен и здесь');
  // Причина теперь принадлежит единственной панели карточки.
  // Вход в отдельное решение арбитра остаётся в той же панели.
  assert.match(wrapper.get('.stalled').text(), /замкнутый набор|исправления|замечани/);
});

// Кнопки действия — та же потеря: развернув карточку, человек лишался и «разобрать и
// продолжить», и «продолжить прогон», то есть всех выходов из затыка разом.
test('кнопка арбитра доступна в развёрнутой карточке', async (t) => {
  const { wrapper } = await mountPipeline(
    t,
    makeFixture({ stall: NO_PROGRESS_STALL }),
    { compact: false },
  );

  assert.notEqual(arbiterButton(wrapper), undefined, 'кнопка разбора на месте');
});

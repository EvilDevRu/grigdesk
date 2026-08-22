// Срез F телеграм-пульта: тексты карточек и callback_data.
//
// Правила, которые здесь стерегутся (docs/plans/telegram-pult-plan.md, §4/§6):
//  - недоверенное содержимое (названия задач, вопросы агента, команды) схлопывается
//    в одну строку: управляющие символы → пробел, разметка не отправляется вовсе;
//  - лимиты: заголовок 200, карточка 1000, вопрос 1500, превью команды ~300;
//    усечение честное — с «…», а не молчаливым обрезком;
//  - номер задачи/этап не отбрасываются никогда: режется тело, не шапка;
//  - callback_data всех форм ≤ 64 байт на предельных входах; переполнение — ошибка,
//    а не тихая обрезка (обрезанный callback нажал бы не то).
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LIMITS,
  collapseLine,
  clipText,
  gateCard,
  questionCard,
  permissionCard,
  planPageCard,
  planPages,
  stallCard,
  silenceCard,
  statusListCard,
  statusListKeyboard,
  taskNodesCard,
  taskNodesKeyboard,
  taskNodesPage,
  taskStatusCard,
  taskStatusKeyboard,
  planPageKeyboard,
  activityLine,
  chatSubject,
  questionKeyboard,
  finishedCard,
  formatDuration,
  liveCard,
  liveSignature,
  runResult,
  gateKeyboard,
  cbData,
  encodeCb,
  parseCallback,
} from '../../server/src/lib/telegram/pult/format.js';

import * as format from '../../server/src/lib/telegram/pult/format.js';

test('постоянная клавиатура содержит четыре точные подписи навигации', () => {
  const markup = format.pultReplyKeyboard?.();
  assert.deepEqual(markup?.keyboard, [
    [{ text: '📋 Конвейер' }, { text: '💬 Агент' }],
    [{ text: '📥 Задачи' }, { text: '⚙️ Ещё' }],
  ]);
});

test('постоянная клавиатура остаётся раскрытой и компактной', () => {
  const markup = format.pultReplyKeyboard?.();
  assert.deepEqual(
    { is_persistent: markup?.is_persistent, resize_keyboard: markup?.resize_keyboard },
    { is_persistent: true, resize_keyboard: true },
  );
});

test('итог без правок не выдумывает число файлов', () => {
  assert.equal(format.turnSummary?.({ files: [], tokens: 12_400 }), '— 12.4k ток.');
});

test('пустой итог не оставляет разделитель', () => {
  assert.equal(format.turnSummary?.({}), '');
});

test('итог склоняет только фактически изменённые файлы', () => {
  assert.deepEqual([1, 2, 5].map((count) => format.turnSummary?.({
    files: Array.from({ length: count }, (_, index) => `src/${index}.js`),
  })), [
    '— 1 файл',
    '— 2 файла',
    '— 5 файлов',
  ]);
});

test('порог автосжатия становится знаменателем заполненности контекста', () => {
  assert.equal(format.turnSummary?.({
    contextTokens: 165_172,
    contextWindow: 1_000_000,
    compactWindow: 200_000,
  }), '— контекст 83%');
});

test('без автосжатия заполненность считается до 80% проверенного окна', () => {
  assert.equal(format.turnSummary?.({
    contextTokens: 165_172,
    contextWindow: 1_000_000,
    compactWindow: 0,
  }), '— контекст 21%');
});

test('без проверенного окна процент контекста не показывается', () => {
  assert.equal(format.turnSummary?.({ contextTokens: 165_172 }), '');
});

// ---------------------------------------------------------------- схлопывание

test('collapseLine: управляющие символы и переносы схлопываются в пробел', () => {
  assert.equal(collapseLine('план\r\nработ\tbutton ok'), 'план работ button ok');
  assert.equal(collapseLine('до\u202Eпосле'), 'до после', 'bidi-control не меняет видимый порядок');
  assert.equal(collapseLine('  много   пробелов  '), 'много пробелов');
  assert.equal(collapseLine(null), '');
});

test('clipText: честное усечение с «…», код-пойнты не рвутся', () => {
  const long = 'д'.repeat(250);
  const cut = clipText(long, 200);
  assert.equal([...cut].length <= 200, true);
  assert.equal(cut.endsWith('…'), true);
  assert.equal(clipText('короткий', 200), 'короткий');
  // Суррогатная пара (эмодзи) на границе не режется пополам.
  const emoji = clipText('🙂'.repeat(300), 200);
  assert.equal(emoji.endsWith('…'), true);
  assert.doesNotThrow(() => encodeURIComponent(emoji));
});

// ------------------------------------------------------------------ карточки

test('карточка ворот: шапка с номером, причина в теле', () => {
  const text = gateCard({ subject: '#4187', reason: 'утвердить план работ' });
  assert.equal(text, '⏳ #4187 ждёт тебя\nВорота: утвердить план работ');
});

test('карточка ворот: длинная причина режется, номер задачи не отбрасывается', () => {
  const text = gateCard({ subject: '#4187', reason: 'п'.repeat(5000) });
  assert.equal([...text].length <= LIMITS.card, true);
  assert.equal(text.startsWith('⏳ #4187 ждёт тебя\n'), true);
  assert.equal(text.includes('…'), true);
});

test('карточка вопроса: свой лимит 1500 и схлопнутый текст вопроса', () => {
  const text = questionCard({ subject: '#4187', question: 'Какой\nспособ\tвыбрать?' });
  assert.equal(text, '❓ #4187 — вопрос агента\nКакой способ выбрать?');
  const long = questionCard({ subject: '#4187', question: 'в'.repeat(4000) });
  assert.equal([...long].length <= LIMITS.question, true);
  assert.equal(long.startsWith('❓ #4187 — вопрос агента\n'), true);
});

test('карточка разрешения: имя инструмента, превью ~300 и отсылка в кокпит', () => {
  const text = permissionCard({
    subject: '#4187',
    tool: 'Bash',
    preview: 'npm run build && bash tests/run-all.sh',
  });
  assert.equal(text.startsWith('🔐 #4187 — агент просит разрешение\n'), true);
  assert.equal(text.includes('Bash: npm run build && bash tests/run-all.sh'), true);
  assert.equal(text.includes('кокпит'), true);

  const long = permissionCard({ subject: '#1', tool: 'Bash', preview: 'x'.repeat(2000) });
  const line = long.split('\n')[1];
  assert.equal([...line].length <= LIMITS.preview + 'Bash: '.length, true);
  assert.equal(line.endsWith('…'), true);
});

test('карточка затыка: этап в шапке не отбрасывается даже при длинной причине', () => {
  const text = stallCard({ subject: '#4188', stage: 'SANDBOX', reason: 'подъём песочницы упал' });
  assert.equal(text, '🛑 #4188 встал: подъём песочницы упал (SANDBOX)');
  const long = stallCard({ subject: '#4188', stage: 'SANDBOX', reason: 'р'.repeat(5000) });
  assert.equal([...long].length <= LIMITS.card, true);
  assert.equal(long.startsWith('🛑 #4188 встал: '), true);
  assert.equal(long.endsWith(' (SANDBOX)'), true);
});

test('карточка молчания: схлопнутый текст с именем висящего вызова', () => {
  assert.equal(
    silenceCard({ subject: '#4189', text: 'build: молчит 28 мин, висит mcp__playwright__browser_click' }),
    '💤 #4189: build: молчит 28 мин, висит mcp__playwright__browser_click',
  );
});

test('статус задачи показывает название, текущий узел и честный прогресс маршрута', () => {
  const task = {
    task: '4187',
    title: 'Починить экспорт CSV\n<script>',
    daemonAlive: true,
    graph: {
      route: 'feature',
      pos: { plan: [0, 0], build: [1, 0], review: [2, 0] },
      nodes: { plan: ['agent', '📋 План'], build: ['agent', '🛠 Реализация'], review: ['agent', '🔬 Ревью'] },
      statuses: { plan: 'done', build: 'run', review: 'pending' },
      progress: { done: 2, total: 3, current: 'build' },
    },
  };
  const card = taskStatusCard(task);
  assert.match(card, /#4187 — Починить экспорт CSV <script>/u);
  assert.match(card, /Сейчас: 🛠 Реализация · выполняется/u);
  assert.match(card, /Прогресс маршрута: 2\/3 · 66%/u);

  const list = statusListCard({ tasks: [task], totalTasks: 1, page: 0, totalPages: 1 });
  assert.match(list, /Конвейер · 1 задача/u);
  assert.match(list, /2\/3 · 66% · 🛠 Реализация/u);

  const nodes = taskNodesCard(task);
  assert.match(nodes, /✓ 📋 План/u);
  assert.match(nodes, /▸ 🛠 Реализация/u);
  assert.match(nodes, /○ 🔬 Ревью/u);

  const quietList = statusListCard({
    tasks: [{ ...task, quiet: { text: 'молчит' } }], totalTasks: 1, page: 0, totalPages: 1,
  });
  assert.match(quietList, /💤 #4187/u, 'молчащий ход не выглядит нормально работающим');
});

test('длинный список узлов листается без молчаливого отбрасывания хвоста', () => {
  const ids = Array.from({ length: 25 }, (_, index) => `node_${String(index).padStart(2, '0')}`);
  const graph = {
    pos: Object.fromEntries(ids.map((id, index) => [id, [index, 0]])),
    nodes: Object.fromEntries(ids.map((id, index) => [id, ['agent', `Узел ${index}`]])),
    statuses: {},
  };
  const middle = taskNodesPage({ task: '4187', graph }, 1);
  assert.equal(middle.page, 1);
  assert.equal(middle.totalPages, 3);
  assert.match(middle.text, /Узлы #4187 · 2\/3/u);
  assert.match(middle.text, /Узел 12/u);
  assert.doesNotMatch(middle.text, /Узел 0(?:\D|$)/u);
});

test('план сохраняет переносы, чистит control chars и делится на bounded-страницы', () => {
  const pages = planPages(`# Цель\nстрока\u0000 с control\u202E\n${'абзац '.repeat(1200)}`);
  assert.equal(pages.length > 1, true);
  assert.equal(pages[0].includes('\u0000'), false);
  assert.equal(pages[0].includes('\u202E'), false);
  assert.equal(pages[0].startsWith('# Цель\nстрока'), true);
  for (const page of pages) assert.equal([...page].length <= LIMITS.planPage, true);
  const card = planPageCard({ taskId: '4187', pages, page: 999 });
  assert.equal(card.page, pages.length - 1, 'номер страницы клампится');
  assert.match(card.text, new RegExp(`План #4187 · ${pages.length}/${pages.length}`, 'u'));

  const truncated = planPages('x'.repeat(LIMITS.planPage * 33));
  assert.equal(truncated.length, 32);
  assert.match(truncated.at(-1), /План длиннее лимита Telegram-пульта/u);
  assert.equal([...truncated.at(-1)].length <= LIMITS.planPage, true);
});

test('только ворота плана получают кнопку просмотра allowlisted plan.md', () => {
  assert.deepEqual(
    gateKeyboard('4187', 'GATE_PLAN').flat().map((button) => button.callback_data),
    ['po:4187', 'g:4187:GATE_PLAN:a', 'g:4187:GATE_PLAN:r'],
  );
  assert.deepEqual(
    gateKeyboard('4187', 'GATE_ACCEPT').flat().map((button) => button.callback_data),
    ['g:4187:GATE_ACCEPT:a', 'g:4187:GATE_ACCEPT:r'],
  );
});

// -------------------------------------------------------------- callback_data

test('callback_data всех форм ≤ 64 байт на предельных входах', () => {
  const task = '1234567890123456789'; // строковый id, не приводим к Number
  const pid = '01234567-89ab-4def-8abc-0123456789ab'; // uuid, 36 символов
  const gateKey = 'GATE_BROWSER_ACCEPT_CHANGE'; // длинный ключ ворот
  const forms = [
    cbData.gateApprove(task, gateKey),
    cbData.gateReject(task, gateKey),
    cbData.gateRejectPlain(task, gateKey),
    cbData.question(pid, 9),
    cbData.questionText(pid),
    cbData.permissionAllow(pid),
    cbData.permissionDeny(pid),
    cbData.permissionDenyComment(pid),
    cbData.resume(task),
    cbData.resumeYes(task),
    cbData.sandboxRetry(task),
    cbData.sandboxRetryYes(task),
    cbData.statusList(1234),
    cbData.statusTask(task, 1234),
    cbData.statusNodes(task, 1234, 1234),
    cbData.statusNodesNew(task),
    cbData.planOpen(task),
    cbData.planPage(task, 1234),
    cbData.dismiss(),
  ];
  for (const data of forms) {
    assert.equal(typeof data, 'string');
    assert.equal(Buffer.byteLength(data, 'utf8') <= 64, true, `слишком длинно: ${data}`);
  }
});

test('encodeCb: переполнение — ошибка, а не тихая обрезка', () => {
  assert.throws(() => encodeCb('g', '1'.repeat(40), 'GATE_' + 'X'.repeat(40), 'a'), /64/);
});

test('parseCallback: круговой разбор всех форм', () => {
  assert.deepEqual(parseCallback('g:4187:GATE_PLAN:a'), {
    kind: 'gate', taskId: '4187', gateKey: 'GATE_PLAN', decision: 'approve', withComment: false,
  });
  assert.deepEqual(parseCallback('g:4187:GATE_PLAN:r'), {
    kind: 'gate', taskId: '4187', gateKey: 'GATE_PLAN', decision: 'reject', withComment: true,
  });
  assert.deepEqual(parseCallback('g:4187:GATE_PLAN:rn'), {
    kind: 'gate', taskId: '4187', gateKey: 'GATE_PLAN', decision: 'reject', withComment: false,
  });
  const pid = '01234567-89ab-4def-8abc-0123456789ab';
  assert.deepEqual(parseCallback(`q:${pid}:2`), { kind: 'question', pid, index: 2 });
  assert.deepEqual(parseCallback(`q:${pid}:txt`), { kind: 'question-free', pid });
  assert.deepEqual(parseCallback(`p:${pid}:a`), { kind: 'permission', pid, action: 'allow' });
  assert.deepEqual(parseCallback(`p:${pid}:d`), { kind: 'permission', pid, action: 'deny' });
  assert.deepEqual(parseCallback(`p:${pid}:c`), { kind: 'permission', pid, action: 'deny-comment' });
  assert.deepEqual(parseCallback('r:4187'), { kind: 'resume', taskId: '4187', step: 'ask' });
  assert.deepEqual(parseCallback('r:4187:y'), { kind: 'resume', taskId: '4187', step: 'yes' });
  assert.deepEqual(parseCallback('r:4187:n'), { kind: 'resume', taskId: '4187', step: 'no' });
  assert.deepEqual(parseCallback('sb:4188'), { kind: 'sandbox-retry', taskId: '4188', step: 'ask' });
  assert.deepEqual(parseCallback('sb:4188:y'), { kind: 'sandbox-retry', taskId: '4188', step: 'yes' });
  assert.deepEqual(parseCallback('sl:2'), { kind: 'status-list', page: 2 });
  assert.deepEqual(parseCallback('sd:4187:2'), { kind: 'status-task', taskId: '4187', page: 2 });
  assert.deepEqual(parseCallback('sn:4187:2'), {
    kind: 'status-nodes', taskId: '4187', page: 2, nodePage: 0,
  });
  assert.deepEqual(parseCallback('sn:4187:2:3'), {
    kind: 'status-nodes', taskId: '4187', page: 2, nodePage: 3,
  });
  assert.deepEqual(parseCallback('sm:4187'), { kind: 'status-nodes-new', taskId: '4187' });
  assert.deepEqual(parseCallback('po:4187'), { kind: 'plan-open', taskId: '4187' });
  assert.deepEqual(parseCallback('pp:4187:3'), { kind: 'plan-page', taskId: '4187', page: 3 });
  assert.deepEqual(parseCallback('x'), { kind: 'dismiss' });
});

test('parseCallback: мусор, чужие формы и сверхдлинное — null, без исключений', () => {
  const bad = [
    '', 'unknown', 'g:abc:GATE_PLAN:a', 'g:4187:gate_plan:a', 'g:4187:GATE_PLAN:zz',
    'q:пид:1', 'p:x y:a', 'r:', 'sl:-1', 'sd:4187:x',
    'sn:abc:0', 'sn:4187:0:x', 'po:abc', 'pp:4187:x', 'sm:abc',
    // Снятые формы мусорных команд: старая кнопка обязана стать неизвестной,
    // а не запустить прогон или создать задачу.
    'l:4201:3', 'l:4201:3:y', 'st:0', 'st:0:y', 'tk:y', 'tk:n',
    'g:4187:GATE_PLAN:a:extra', 'x:extra', 'sc:extra', 'q:' + 'a'.repeat(80) + ':1',
    null, undefined, 42,
  ];
  for (const data of bad) {
    assert.equal(parseCallback(data), null, `должен быть null: ${String(data)}`);
  }
});

// --------------------------------------- экран навигации: кнопка закрытия (t91001)

test('cbData.screenClose: форма sc разбирается в закрытие экрана', () => {
  assert.deepEqual(parseCallback(cbData.screenClose()), { kind: 'screen-close' });
});

const hasCloseButton = (rows) => (rows || []).flat()
  .some((button) => button.callback_data === 'sc' && button.text === '✕ Закрыть');

test('клавиатура списка задач несёт кнопку закрытия экрана', () => {
  assert.equal(hasCloseButton(statusListKeyboard([{ task: '4187' }], 0, 1)), true);
});

test('клавиатура карточки задачи несёт кнопку закрытия экрана', () => {
  assert.equal(hasCloseButton(taskStatusKeyboard('4187', 0)), true);
});

test('клавиатура страниц узлов несёт кнопку закрытия экрана', () => {
  assert.equal(hasCloseButton(taskNodesKeyboard('4187', 0, 0, 1)), true);
});

test('клавиатура страниц плана несёт кнопку закрытия экрана', () => {
  assert.equal(hasCloseButton(planPageKeyboard('4187', 0, 1)), true);
});

test('helpKeyboard: подсказка закрывается одной кнопкой', () => {
  assert.deepEqual(format.helpKeyboard?.(), [[{ text: '✕ Закрыть', callback_data: 'sc' }]]);
});

test('resolvedCard больше не экспортируется: итог — всплывашка, карточка удаляется', () => {
  assert.equal(format.resolvedCard, undefined);
});

// ------------------------------------------------- живая карточка и исход прогона

const liveTask = (over = {}) => ({
  task: '4190',
  title: 'Экспорт CSV',
  daemonAlive: true,
  silence: { stage: 'BUILD', sec: 12, tool: null },
  graph: {
    route: 'feature',
    pos: { plan: [0, 0], build: [1, 0] },
    nodes: { plan: ['agent', '📋 План'], build: ['agent', '🔨 Сборка'] },
    statuses: { plan: 'done', build: 'run' },
    progress: { done: 1, total: 2, current: 'build' },
    timing: { workSec: 4_200, approximate: true },
  },
  ...over,
});

test('activityLine: правило «пишет или висит» берётся из общего agent-activity', () => {
  assert.equal(activityLine(liveTask()), 'Агент: агент пишет');
  assert.equal(
    activityLine(liveTask({ silence: { stage: 'BUILD', sec: 1_680, tool: 'mcp__playwright__browser_click' } })),
    'Агент: нет событий 28 мин (mcp__playwright__browser_click)',
    'имя висящего вызова важнее цифры: сборка и мёртвый браузер выглядят по-разному',
  );
  assert.equal(activityLine(liveTask({ silence: null })), '', 'активного хода нет — строки нет, а не «0 мин»');
});

test('formatDuration: секунды, минуты и часы словами', () => {
  assert.equal(formatDuration(45), '45 с');
  assert.equal(formatDuration(12 * 60), '12 мин');
  assert.equal(formatDuration(4_200), '1 ч 10 мин');
  assert.equal(formatDuration(7_200), '2 ч');
  assert.equal(formatDuration(-5), '0 с', 'мусорный замер не превращается в отрицательное время');
});

test('runResult: терминальные исходы названы поимённо, незнакомый не выдумывается', () => {
  assert.equal(runResult('completed').text, 'маршрут завершён');
  assert.equal(runResult('abandoned').text, 'попытка закрыта');
  assert.equal(runResult(''), null);
  assert.equal(runResult('какой-то\nновый').text, 'какой-то новый', 'незнакомый код схлопывается, но не теряется');
});

test('liveCard: узел, прогресс, активность и приписка про самообновление', () => {
  const text = liveCard(liveTask());
  assert.match(text, /🔵 #4190 — Экспорт CSV/u);
  assert.match(text, /Маршрут: feature/u);
  assert.match(text, /Сейчас: 🔨 Сборка · выполняется/u);
  assert.match(text, /Прогресс маршрута: 1\/2 · 50%/u);
  assert.match(text, /Работа: ≈1 ч 10 мин/u, 'приблизительный замер помечен, а не выдан за точный');
  assert.match(text, /Карточка обновляется сама\./u);
});

test('liveCard завершённого прогона — это уже итог, а не состояние', () => {
  const text = liveCard(liveTask({ result: 'completed', daemonAlive: false }));
  assert.match(text, /✅ #4190 — Экспорт CSV: маршрут завершён/u);
  assert.equal(/Карточка обновляется сама/u.test(text), false);
});

test('finishedCard: исход, маршрут, пройденные узлы и время работы', () => {
  const text = finishedCard(liveTask({
    result: 'completed',
    daemonAlive: false,
    graph: { ...liveTask().graph, progress: { done: 2, total: 2, current: null } },
  }));
  assert.match(text, /✅ #4190 — Экспорт CSV: маршрут завершён/u);
  assert.match(text, /Прошло узлов: 2\/2 · 100%/u);
  assert.match(text, /Работа: ≈1 ч 10 мин/u);
});

test('liveSignature: смена узла/статуса/исхода значима, тикающие секунды — нет', () => {
  const base = liveSignature(liveTask());
  assert.equal(
    liveSignature(liveTask({ silence: { stage: 'BUILD', sec: 900, tool: 'Bash' } })),
    base,
    'молчание в подпись не входит: иначе каждая минута била бы правкой в Telegram',
  );
  assert.notEqual(liveSignature(liveTask({ result: 'completed' })), base);
  assert.notEqual(liveSignature(liveTask({ stall: { stage: 'BUILD', title: 'встал' } })), base);
  assert.notEqual(
    liveSignature(liveTask({
      graph: { ...liveTask().graph, progress: { done: 2, total: 2, current: 'build' } },
    })),
    base,
  );
});

test('taskStatusCard показывает ту же активность, что живая карточка', () => {
  assert.match(taskStatusCard(liveTask()), /Агент: агент пишет/u);
});

// ------------------------------------------------- контекст вопроса из чата

test('chatSubject: имя разговора и задача вместо безымянного «чат»', () => {
  assert.equal(chatSubject({ chatTitle: 'Телеграм-пульт мусор' }), 'Телеграм-пульт мусор');
  assert.equal(chatSubject({ taskId: '4187' }), '#4187');
  assert.equal(chatSubject({ chatTitle: 'Экспорт CSV', taskId: '4187' }), '#4187 — Экспорт CSV');
  assert.equal(chatSubject({}), 'чат', 'нечего показать — честное «чат», а не выдуманное имя');
  assert.equal(chatSubject(null), 'чат', 'закрытый спрос не роняет карточку');
  assert.equal(
    chatSubject({ chatTitle: 'до\nпосле' }), 'до после',
    'название чата — недоверенный текст: схлопывается в строку',
  );
});

test('карточка вопроса несёт тему и пояснения вариантов под номерами кнопок', () => {
  const options = [
    { label: 'Контракт + фикстуры, план оставить', description: 'Убираем только контрактные тесты.' },
    { label: 'Всё, включая план и критику', description: 'Полное удаление вместе с разделом плана.' },
    { label: 'Только ссылки в документации' },
  ];
  const text = questionCard({
    subject: 'Телеграм-пульт мусор',
    header: 'Объём',
    question: 'Что именно выпиливаем?',
    options,
  });
  assert.match(text, /❓ Телеграм-пульт мусор — вопрос агента/u);
  assert.match(text, /Тема: Объём/u, 'header AskUserQuestion ради этого и существует');
  assert.match(text, /Что именно выпиливаем\?/u);
  assert.match(text, /1\) Контракт \+ фикстуры, план оставить\n {3}Убираем только контрактные тесты\./u);
  assert.match(text, /3\) Только ссылки в документации/u, 'вариант без пояснения остаётся строкой');

  const buttons = questionKeyboard('p1', options).flat().map((b) => b.text);
  assert.equal(buttons[0].startsWith('1) '), true, 'номер кнопки совпадает с номером пояснения');
  assert.equal(buttons[2].startsWith('3) '), true);
  assert.equal(buttons.at(-1), '✍ Свой ответ');
});

test('карточка вопроса без вариантов и темы не выдумывает пустых строк', () => {
  assert.equal(
    questionCard({ subject: 'чат', question: 'Продолжать?' }),
    '❓ чат — вопрос агента\nПродолжать?',
  );
  // Варианты отделены от вопроса пустой строкой: без неё список слипается с текстом.
  assert.match(
    questionCard({ subject: 'чат', question: 'Как?', options: [{ label: 'Так' }] }),
    /Как\?\n\n1\) Так/u,
  );
});

test('длинные пояснения вариантов не выносят карточку за лимит вопроса', () => {
  const options = Array.from({ length: 8 }, (_, i) => ({
    label: `вариант ${i + 1} ${'д'.repeat(200)}`,
    description: 'о'.repeat(1000),
  }));
  const text = questionCard({ subject: '#1', header: 'т'.repeat(200), question: 'в'.repeat(500), options });
  assert.equal([...text].length <= LIMITS.question, true);
  assert.equal(text.startsWith('❓ #1 — вопрос агента\n'), true, 'шапка не отбрасывается никогда');
});

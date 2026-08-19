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
  resolvedCard,
  statusListCard,
  taskNodesCard,
  taskNodesPage,
  taskStatusCard,
  gateKeyboard,
  cbData,
  encodeCb,
  parseCallback,
} from '../../server/src/lib/telegram/pult/format.js';

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
  assert.equal(text, '❓ #4187, вопрос агента\nКакой способ выбрать?');
  const long = questionCard({ subject: '#4187', question: 'в'.repeat(4000) });
  assert.equal([...long].length <= LIMITS.question, true);
  assert.equal(long.startsWith('❓ #4187, вопрос агента\n'), true);
});

test('карточка разрешения: имя инструмента, превью ~300 и отсылка в кокпит', () => {
  const text = permissionCard({
    subject: '#4187',
    tool: 'Bash',
    preview: 'npm run build && bash tests/run-all.sh',
  });
  assert.equal(text.startsWith('🔐 #4187, агент просит разрешение\n'), true);
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

test('карточка молчания и «решено»', () => {
  assert.equal(
    silenceCard({ subject: '#4189', text: 'build: молчит 28 мин, висит mcp__playwright__browser_click' }),
    '💤 #4189: build: молчит 28 мин, висит mcp__playwright__browser_click',
  );
  assert.equal(resolvedCard({ subject: '#4187' }), '✓ #4187: решено');
  assert.equal(
    resolvedCard({ subject: '#4187', note: 'принято, прогон продолжен' }),
    '✓ #4187: принято, прогон продолжен',
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
    cbData.launchPick(task, 12),
    cbData.launchYes(task, 12),
    cbData.stopPick(12),
    cbData.stopYes(12),
    cbData.statusList(1234),
    cbData.statusTask(task, 1234),
    cbData.statusNodes(task, 1234, 1234),
    cbData.planOpen(task),
    cbData.planPage(task, 1234),
    cbData.taskCreate(),
    cbData.taskCancel(),
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
  assert.deepEqual(parseCallback('l:4201:3'), { kind: 'launch', taskId: '4201', index: 3, step: 'ask' });
  assert.deepEqual(parseCallback('l:4201:3:y'), { kind: 'launch', taskId: '4201', index: 3, step: 'yes' });
  assert.deepEqual(parseCallback('st:0'), { kind: 'stop', index: 0, step: 'ask' });
  assert.deepEqual(parseCallback('st:0:y'), { kind: 'stop', index: 0, step: 'yes' });
  assert.deepEqual(parseCallback('sl:2'), { kind: 'status-list', page: 2 });
  assert.deepEqual(parseCallback('sd:4187:2'), { kind: 'status-task', taskId: '4187', page: 2 });
  assert.deepEqual(parseCallback('sn:4187:2'), {
    kind: 'status-nodes', taskId: '4187', page: 2, nodePage: 0,
  });
  assert.deepEqual(parseCallback('sn:4187:2:3'), {
    kind: 'status-nodes', taskId: '4187', page: 2, nodePage: 3,
  });
  assert.deepEqual(parseCallback('po:4187'), { kind: 'plan-open', taskId: '4187' });
  assert.deepEqual(parseCallback('pp:4187:3'), { kind: 'plan-page', taskId: '4187', page: 3 });
  assert.deepEqual(parseCallback('tk:y'), { kind: 'task-create', confirmed: true });
  assert.deepEqual(parseCallback('tk:n'), { kind: 'task-create', confirmed: false });
  assert.deepEqual(parseCallback('x'), { kind: 'dismiss' });
});

test('parseCallback: мусор, чужие формы и сверхдлинное — null, без исключений', () => {
  const bad = [
    '', 'unknown', 'g:abc:GATE_PLAN:a', 'g:4187:gate_plan:a', 'g:4187:GATE_PLAN:zz',
    'q:пид:1', 'p:x y:a', 'r:', 'l:4201:x', 'st:-1', 'sl:-1', 'sd:4187:x',
    'sn:abc:0', 'sn:4187:0:x', 'po:abc', 'pp:4187:x', 'tk:maybe',
    'g:4187:GATE_PLAN:a:extra', 'x:extra', 'q:' + 'a'.repeat(80) + ':1',
    null, undefined, 42,
  ];
  for (const data of bad) {
    assert.equal(parseCallback(data), null, `должен быть null: ${String(data)}`);
  }
});

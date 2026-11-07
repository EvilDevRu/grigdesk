// Арбитр типизированной остановки конвейера.
//
// Механизм действует САМ: двигает курсор чужой задачи по решению модели. Поэтому здесь
// проверяются не «счастливые» пути, а границы — что арбитр разбирать не берётся, чего он
// решать не вправе и чем его решение отличается в журнале от человеческого.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  ARBITER_ACTOR,
  ARBITER_MAX_PER_ATTEMPT,
  arbitrationGate,
  buildArbiterPrompt,
  formatArbiterReason,
  normalizeArbiterSettings,
  parseArbiterDecision,
  readArbitrationContext,
  stallIsArbitrable,
  stopIsArbitrable,
} from '../../server/src/lib/factoryArbiter.ts';
import { routeGotoArgs } from '../../server/src/lib/factoryRouteCli.ts';
import { LEGACY_VALUES } from '../../shared/runtime/legacyBrand.ts';
import { ARBITER_TURN_LIMIT_MS, buildConversationPrompt } from '../../server/src/lib/arbiterConversationRunner.ts';

const TASK = '900022';
const ATTEMPT = 'a_0123456789abcdef0123456789abcdef';

async function ledger(events) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'arbiter-'));
  const dir = path.join(root, 'protocol-v2', 'tasks', `t${TASK}`, 'attempts', ATTEMPT, 'stage-results');
  await mkdir(dir, { recursive: true });
  let sequence = 0;
  for (const event of events) {
    sequence += 1;
    const hash = createHash('sha256').update(String(sequence)).digest('hex');
    const name = `event.${String(sequence).padStart(20, '0')}.${hash}.json`;
    await writeFile(path.join(dir, name), JSON.stringify(event), 'utf8');
  }
  return root;
}

const failedCommit = (node, target, findings, reviewed = []) => ({
  kind: 'commit',
  node,
  outcome: 'failed',
  action: { rewind: target },
  verdict: { owner: target, findings, reviewed },
});

const noProgress = (node, target, reason, findings = null) => ({
  kind: 'no-progress',
  node,
  outcome: 'failed',
  action: { rewind: target },
  reason,
  ...(findings ? { verdict: { owner: target, findings, reviewed: [] } } : {}),
});

const cursorStopped = (stop) => ({ state: 'stopped', currentNode: null, stop });

// Остановку, объявленную САМИМ маршрутом (`on`/`onFailure` узла), движок пишет обычным
// коммитом с `action.stop` — у движковых `no-progress`/`rewind-limit` для этого свой
// `kind`. Класс владельца провала называет агент, и он же решает, есть ли что разбирать.
const humanStop = (node, owner, findings) => ({
  kind: 'commit',
  node,
  outcome: 'failed',
  action: { stop: 'human' },
  verdict: { owner, findings, reviewed: [] },
});

const finding = (id, summary) => ({ id, summary, severity: 'blocking' });

test('вызов человека узлом разбирается, и возврат ведёт в тот же узел', async () => {
  const controlDir = await ledger([
    humanStop('skeptic', 'human', [finding('unproven', 'утверждение не проверено')]),
  ]);
  const context = await readArbitrationContext({ controlDir, task: TASK, attempt: ATTEMPT });

  assert.equal(context.stop, 'human');
  assert.equal(context.node, 'skeptic');
  // Точки возврата маршрут для такой остановки не предлагает, и придумывать её нельзя:
  // узел не проиграл спор соседу, а сам позвал человека — переигрывать надо его же.
  assert.equal(context.target, 'skeptic');
  assert.equal(context.series.length, 1);
  assert.equal(arbitrationGate(context, cursorStopped('human')).ok, true);
});

// Класс владельца отделяет спор о коде от беды среды. Упавший стенд не становится
// решаемым оттого, что его прочитали, и звать на него живого агента — трата денег.
test('остановка по отказу среды или сборки арбитру не отдаётся', async () => {
  for (const owner of ['environment', 'build', 'tests']) {
    const controlDir = await ledger([
      humanStop('build', owner, [finding('broken', 'сборка не поднялась')]),
    ]);
    const context = await readArbitrationContext({ controlDir, task: TASK, attempt: ATTEMPT });
    const gate = arbitrationGate(context, cursorStopped('human'));

    assert.equal(gate.ok, false, `класс ${owner} не должен разбираться`);
    assert.equal(gate.error, 'not_arbitrable');
    assert.equal(gate.message.includes(owner), true, 'класс назван человеку словами');
  }
});

// Класс не назван — 9 остановок и 5 часов простоя по замеру, в том числе на `ship`,
// `skeptic` и `review`. Отказ по формальному признаку стоил дороже попытки: содержимое
// вердикта у арбитра перед глазами, и если разбирать нечего, он скажет это сам.
test('остановка без объявленного класса владельца разбирается', async () => {
  const controlDir = await ledger([humanStop('skeptic', null, [finding('x', 'что-то')])]);
  const context = await readArbitrationContext({ controlDir, task: TASK, attempt: ATTEMPT });
  const gate = arbitrationGate(context, cursorStopped('human'));

  assert.equal(gate.ok, true);
});

// Завершение маршрута приезжает тем же событием с `action.stop`, и принять его за
// разбираемую остановку нельзя: работа сделана, разбирать нечего.
test('успешное завершение маршрута остановкой для арбитра не является', async () => {
  const controlDir = await ledger([
    { kind: 'commit', node: 'ship', outcome: 'done', action: { stop: 'done' }, verdict: { owner: 'human', findings: [], reviewed: [] } },
  ]);
  const context = await readArbitrationContext({ controlDir, task: TASK, attempt: ATTEMPT });

  assert.equal(context.stop, 'done');
  assert.equal(arbitrationGate(context, cursorStopped('done')).ok, false);
});

// Правило одно на всех: гейт арбитра, кнопка карточки и автоматический вотчер.
test('правило арбитрабельности одно и учитывает класс владельца', () => {
  assert.equal(stopIsArbitrable('no-progress', null), true);
  assert.equal(stopIsArbitrable('human', 'human'), true);
  // Принятый план не выдержал проверки — ответом служит новая гипотеза, а она собирается
  // из отчёта узла и кода, то есть чтением (замер 8507).
  assert.equal(stopIsArbitrable('human', 'plan'), true);
  assert.equal(stopIsArbitrable('human', null), true);
  // Тот же счётчик топтания, только кончился он у движка, а не у набора замечаний.
  assert.equal(stopIsArbitrable('rewind-limit', 'human'), true);
  assert.equal(stopIsArbitrable('rewind-limit', null), true);

  // Осталось запретным: упавший стенд и несобравшаяся сборка чтением кода не лечатся, а
  // запускать команды арбитр не умеет — он ходит в режиме `plan`.
  assert.equal(stopIsArbitrable('human', 'environment'), false);
  assert.equal(stopIsArbitrable('human', 'build'), false);
  assert.equal(stopIsArbitrable('human', 'tests'), false);
  assert.equal(stopIsArbitrable('done', 'human'), false);
});

// Остановка `human` без вердикта — исчерпанный бюджет повторов, а не «класс не назван»:
// ни один заход результата не зафиксировал, разбирать нечего, гейт ответил бы `arc_unknown`.
// Кнопка карточки и вотчер считают признак по вердикту целиком (t7989: «отдать арбитру»
// рядом с «раннер не получил результат»).
test('остановка human без вердикта арбитру не предлагается', () => {
  assert.equal(stallIsArbitrable('human', null), false);
  assert.equal(stallIsArbitrable('human', { owner: null }), true);
  assert.equal(stallIsArbitrable('human', { owner: 'human' }), true);
  assert.equal(stallIsArbitrable('human', { owner: 'environment' }), true);
  // Остановки движка вердикта в событии остановки могут и не нести — правило прежнее.
  assert.equal(stallIsArbitrable('no-progress', null), true);
  assert.equal(stallIsArbitrable('rewind-limit', null), true);
  assert.equal(stallIsArbitrable('done', null), false);
});

// Вводная промпта у двух остановок разная по существу: в одной спорят два узла, в другой
// узел никому не проиграл и вопрос ровно один — точно ли это выбор человека.
test('промпт вызова человека говорит о переигрывании того же узла', () => {
  const args = {
    task: TASK,
    node: 'skeptic',
    target: 'skeptic',
    reason: null,
    series: [{ node: 'skeptic', owner: 'human', findings: [finding('x', 'нужна рамка')], reviewed: [] }],
    stateDir: '/state',
  };

  const human = buildArbiterPrompt({ ...args, stop: 'human' });
  assert.equal(human.includes('САМ вернул решение человеку'), true);
  assert.equal(human.includes('это тот же узел'), true);
  // Частая причина такой остановки — узлу не дали проверить факт правами, а не спор по существу.
  assert.equal(human.includes('state-only'), true);

  const arc = buildArbiterPrompt({ ...args, target: 'build', stop: 'no-progress' });
  assert.equal(arc.includes('несколько раз подряд возвращал'), true);
  assert.equal(arc.includes('это тот же узел'), false);
});


test('журнал попытки разбирается в дугу возвратов', async () => {
  const root = await ledger([
    { kind: 'init', node: 'plan', action: { next: 'plan' } },
    { kind: 'commit', node: 'plan', outcome: 'done', action: { next: 'skeptic' } },
    failedCommit('skeptic', 'plan', [{ id: 'first', summary: 'раз' }], ['core/a.py']),
    { kind: 'commit', node: 'plan', outcome: 'done', action: { next: 'skeptic' } },
    noProgress('skeptic', 'plan', 'замкнутый набор замечаний расширен новыми id: second'),
  ]);
  const context = await readArbitrationContext({ controlDir: root, task: TASK, attempt: ATTEMPT });
  assert.equal(context.ok, true);
  assert.equal(context.stop, 'no-progress');
  assert.equal(context.node, 'skeptic');
  assert.equal(context.target, 'plan');
  assert.equal(context.series.length, 1);
  assert.equal(context.series[0].findings[0].id, 'first');
  assert.deepEqual(context.series[0].reviewed, ['core/a.py']);
  assert.equal(context.arbitrations, 0);
});

test('вердикт, на котором маршрут встал, попадает в разбор', async () => {
  // Самая важная реплика спора: её замечания и остались открытыми. Событие остановки
  // несёт вердикт так же, как обычный коммит; без этой ветки арбитр разбирал бы спор
  // без последнего слова проверяющего.
  const root = await ledger([
    failedCommit('skeptic', 'plan', [{ id: 'first', summary: 'раз' }], ['core/a.py']),
    { kind: 'commit', node: 'plan', outcome: 'done', action: { next: 'skeptic' } },
    noProgress('skeptic', 'plan', 'расширен новыми id: second', [
      { id: 'second', summary: 'два', anchor: 'core/b.py' },
    ]),
  ]);
  const context = await readArbitrationContext({ controlDir: root, task: TASK, attempt: ATTEMPT });
  assert.equal(context.series.length, 2);
  assert.equal(context.series[1].findings[0].id, 'second');
});

test('решение человека начинает новую серию, а арбитражи считаются', async () => {
  // Серия обязана считаться так же, как её считает движок: иначе арбитр разбирал бы
  // вердикты, уже отменённые чьим-то решением, и предъявлял выводы по снятому спору.
  const root = await ledger([
    failedCommit('skeptic', 'plan', [{ id: 'old', summary: 'до решения' }]),
    { kind: 'human-rewind', node: 'plan', action: { rewind: 'plan' }, reason: 'решение человека' },
    failedCommit('skeptic', 'plan', [{ id: 'fresh', summary: 'после решения' }]),
    {
      kind: 'human-rewind', node: 'plan', action: { rewind: 'plan' }, actor: ARBITER_ACTOR, reason: 'арбитр',
    },
    failedCommit('skeptic', 'plan', [{ id: 'latest', summary: 'после арбитража' }]),
    noProgress('skeptic', 'plan', 'повторяется тот же набор открытых замечаний'),
  ]);
  const context = await readArbitrationContext({ controlDir: root, task: TASK, attempt: ATTEMPT });
  assert.equal(context.series.length, 1, 'до решения вердикты в серию не входят');
  assert.equal(context.series[0].findings[0].id, 'latest');
  assert.equal(context.arbitrations, 1, 'возврат арбитра отличается от человеческого полем actor');
});

test('арбитр берётся за оба вида топтания и не берётся за идущий маршрут', async () => {
  const root = await ledger([
    failedCommit('skeptic', 'plan', [{ id: 'a', summary: 'раз' }]),
    noProgress('skeptic', 'plan', 'причина'),
  ]);
  const context = await readArbitrationContext({ controlDir: root, task: TASK, attempt: ATTEMPT });

  assert.equal(arbitrationGate(context, cursorStopped('no-progress')).ok, true);
  // Тот же спор, но счётчик автоматических возвратов кончился у движка: 4 остановки и
  // 8.7 часа простоя по замеру уходили человеку только из-за вида остановки.
  assert.equal(arbitrationGate(context, cursorStopped('rewind-limit')).ok, true);
  // Идущий маршрут не арбитрируют: возврат курсора отменил бы работу, которая идёт.
  assert.equal(arbitrationGate(context, { state: 'ready', currentNode: 'plan' }).error, 'not_arbitrable');
});

test('потолок арбитражей на попытку не обходится', async () => {
  // Возврат арбитра, как и человеческий, обнуляет замкнутый набор дуги. Без своего
  // потолка арбитр съел бы весь общий бюджет возвратов, и человеку досталась бы уже
  // исчерпанная попытка.
  const spent = [];
  for (let index = 0; index < ARBITER_MAX_PER_ATTEMPT; index += 1) {
    spent.push({
      kind: 'human-rewind', node: 'plan', action: { rewind: 'plan' }, actor: ARBITER_ACTOR, reason: 'арбитр',
    });
  }
  const root = await ledger([
    ...spent,
    failedCommit('skeptic', 'plan', [{ id: 'a', summary: 'раз' }]),
    noProgress('skeptic', 'plan', 'причина'),
  ]);
  const context = await readArbitrationContext({ controlDir: root, task: TASK, attempt: ATTEMPT });
  const gate = arbitrationGate(context, cursorStopped('no-progress'));
  assert.equal(gate.ok, false);
  assert.equal(gate.error, 'arbiter_budget_spent');
});

test('дуга без вердиктов арбитражу не подлежит', async () => {
  const root = await ledger([noProgress('skeptic', 'plan', 'причина')]);
  const context = await readArbitrationContext({ controlDir: root, task: TASK, attempt: ATTEMPT });
  assert.equal(arbitrationGate(context, cursorStopped('no-progress')).error, 'arc_unknown');
});

test('нечитаемый журнал не превращается в разрешение', async () => {
  const gate = arbitrationGate({ ok: false, error: 'ledger_unreadable' }, cursorStopped('no-progress'));
  assert.equal(gate.ok, false);
  assert.equal(gate.error, 'ledger_unreadable');
});

test('решение арбитра разбирается строго', () => {
  const card = {
    what: 'что', why: 'почему', proof: 'чем доказал', risk: 'чем грозит',
  };
  const good = parseArbiterDecision(`пояснение\n\`\`\`json\n${JSON.stringify({
    verdict: 'resolve', scope_change: false, card, instruction: 'делай так',
  })}\n\`\`\``);
  assert.equal(good.ok, true);
  assert.equal(good.verdict, 'resolve');
  assert.equal(good.instruction, 'делай так');

  // Пустое поле карточки означает, что предъявлять человеку нечего. Молча пропустить
  // такой ответ нельзя: журнал утверждал бы, что решение обосновано.
  const holed = parseArbiterDecision(JSON.stringify({
    verdict: 'resolve', card: { ...card, proof: '   ' }, instruction: 'делай',
  }));
  assert.equal(holed.ok, false);
  assert.match(holed.message, /proof/);

  // Указание — единственное, что доезжает до узла. Пустое означает пустое задание.
  const mute = parseArbiterDecision(JSON.stringify({ verdict: 'resolve', card, instruction: '' }));
  assert.equal(mute.ok, false);

  assert.equal(parseArbiterDecision('вообще не json').ok, false);
  assert.equal(parseArbiterDecision(JSON.stringify({ card, instruction: 'x' })).ok, false);
});

// Решение, задевающее границу задачи, больше не останавливает конвейер: у развилки часто
// есть минимальный вариант (не расширять объём, не снимать проверок, не добавлять нового
// элемента), и проверить такой выбор человек всё равно может только на воротах — там он и
// так принимает план и результат. Будильник посреди работы за это не платит.
test('решение о границе задачи едет с пометкой, а не останавливает конвейер', () => {
  const card = {
    what: 'что', why: 'почему', proof: 'чем доказал', risk: 'чем грозит',
  };
  const declared = parseArbiterDecision(JSON.stringify({
    verdict: 'resolve', scope_change: true, card, instruction: 'оставить как есть',
  }));
  assert.equal(declared.verdict, 'deferred', 'пометка отличает такое решение от обычного');
  assert.equal(declared.scopeChange, true);
  assert.equal(declared.instruction, 'оставить как есть', 'указание доезжает до узла');

  // Остановка осталась ровно одна: её объявляет САМ арбитр, когда минимального варианта
  // нет и любой его выбор пришлось бы переделывать.
  const chosen = parseArbiterDecision(JSON.stringify({ verdict: 'human', card, instruction: '' }));
  assert.equal(chosen.verdict, 'human');
  assert.equal(chosen.instruction, '', 'отказ узлу ничего не доставляет');
});

// Пустое указание при `resolve` по-прежнему означает «решения нет»: узел получил бы пустое
// задание, а журнал утверждал бы, что решение принято и обосновано.
test('решение о границе задачи без указания узлу не принимается', () => {
  const card = {
    what: 'что', why: 'почему', proof: 'чем доказал', risk: 'чем грозит',
  };
  const empty = parseArbiterDecision(JSON.stringify({
    verdict: 'resolve', scope_change: true, card, instruction: '   ',
  }));
  assert.equal(empty.ok, false);
});

test('карточка решения подписана машиной и читается сверху вниз', () => {
  const reason = formatArbiterReason({
    card: {
      what: 'выбрал аудит вместо общего модуля',
      why: 'общий модуль ломает плоский каталог',
      proof: 'запустил импорт обеими формами',
      risk: 'замер покажет ноль дублей там, где их не считали',
    },
    instruction: 'перепиши план',
  });
  assert.match(reason, /^РЕШЕНИЕ АРБИТРА КОНВЕЙЕРА \(принято автоматически/);
  const order = ['Что решил:', 'Почему:', 'Чем доказал:', 'Чем грозит ошибка:', 'Что делать:']
    .map((label) => reason.indexOf(label));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'порядок карточки фиксирован');
  assert.ok(order.every((index) => index >= 0));
});

test('промпт арбитра называет обе стороны спора и место артефактов', () => {
  const prompt = buildArbiterPrompt({
    task: TASK,
    node: 'skeptic',
    target: 'plan',
    reason: 'замкнутый набор замечаний расширен новыми id: shared-module',
    series: [{
      node: 'skeptic',
      owner: 'plan',
      findings: [{ id: 'shared-module', summary: 'форма импорта не названа', anchor: 'core/metrics.sh' }],
      reviewed: ['core/metrics.sh'],
    }],
    stateDir: '/state',
  });
  assert.match(prompt, /skeptic/);
  assert.match(prompt, /plan/);
  assert.match(prompt, /shared-module/);
  assert.match(prompt, /core\/metrics\.sh/);
  assert.match(prompt, /\/state/);
  // Инвариант, ради которого арбитр и существует: он обязан проверить, а не рассудить.
  assert.match(prompt, /проверь ПО КОДУ/);
  // И обязан знать границу своих возможностей. Она проходит не там, где её долго
  // описывал промпт: замер живым CLI показал, что plan разрешает read-only Bash и
  // блокирует только нативные правки и запись перенаправлением. Настоящая граница —
  // рабочее дерево остановленной попытки, и держится она прямым запретом.
  assert.match(prompt, /ЗАПУСКАТЬ КОМАНДЫ/);
  assert.match(prompt, /рабочее дерево задачи менять НЕЛЬЗЯ ВООБЩЕ/i);
});

test('настройка арбитра отвергает мусор и по умолчанию выключена', () => {
  const empty = normalizeArbiterSettings(undefined);
  assert.deepEqual(empty, { modelRef: null, effort: '', auto: false });
  // Полупустая ссылка обещала бы выбор, которого нет: ход всё равно уйдёт дефолтом.
  assert.equal(normalizeArbiterSettings({ modelRef: { provider: 'claude' } }).modelRef, null);
  assert.equal(normalizeArbiterSettings({ auto: 'да' }).auto, false, 'auto включается только булевым true');
  const good = normalizeArbiterSettings({
    modelRef: { provider: 'Claude', model: 'claude-opus-5' }, effort: 'HIGH', auto: true,
  });
  assert.deepEqual(good, {
    modelRef: { provider: 'claude', model: 'claude-opus-5' }, effort: 'high', auto: true,
  });
});

test('возврат курсора называет исполнителя только когда решал не человек', () => {
  const config = {};
  const base = {
    task: TASK, profile: 'demo', attempt: ATTEMPT, node: 'plan', reason: 'причина',
  };
  const human = routeGotoArgs(config, base);
  assert.equal(human.includes('--actor'), false, 'обычный goto остаётся прежним байт в байт');
  const machine = routeGotoArgs(config, { ...base, actor: ARBITER_ACTOR });
  assert.equal(machine[machine.indexOf('--actor') + 1], ARBITER_ACTOR);
});

// --- автоматический разбор ---
// Он действует без человека, поэтому проверяется прежде всего то, чего он НЕ делает:
// не работает при выключенной настройке, не заводит вторую копию правил и не долбит
// задачу, которую только что не смог разобрать.

async function watcher({ auto = true, tasks = [], arbitrate } = {}) {
  const { FactoryArbiterWatch } = await import('../../server/src/lib/factoryArbiterWatch.ts');
  const calls = [];
  const notes = [];
  const instance = new FactoryArbiterWatch({
    sse: { subscribe: () => () => {} },
    prefs: { read: () => ({ arbiter: { auto } }) },
    listTasks: async () => tasks,
    arbitrate: async (id, reply) => {
      calls.push(id);
      return arbitrate ? arbitrate(id, reply) : { ok: true, resolved: true, node: 'plan' };
    },
    log: { warn() {}, info(fields, message) { notes.push(message); } },
  });
  return { instance, calls, notes };
}

// Признак «за это берётся арбитр» считает сервер одним правилом вместе с гейтом самого
// арбитра (`stopIsArbitrable`), а вотчер и кнопка его только читают. Своя копия сравнения
// с `no-progress` разъехалась бы с ними при первом расширении набора остановок — оно и
// случилось 28.08.2026, когда арбитру отдали вызов человека узлом.
const stalledTask = (task) => ({
  task, readOnly: false, daemonAlive: false, stall: { stop: 'no-progress', arbitrable: true },
});

test('выключенная настройка означает полное бездействие', async () => {
  const { instance, calls } = await watcher({ auto: false, tasks: [stalledTask(1)] });
  await instance.tick();
  assert.deepEqual(calls, [], 'автомат не ходит, пока человек его не включил');
});

test('автомат берёт только остановленную задачу с типизированным затыком', async () => {
  const { instance, calls } = await watcher({
    tasks: [
      { ...stalledTask(1), daemonAlive: true },
      { ...stalledTask(2), readOnly: true },
      { task: 3, readOnly: false, daemonAlive: false, stall: { stop: 'rewind-limit' } },
      { task: 4, readOnly: false, daemonAlive: false, stall: null },
      // Остановка на человеке, которую сервер разбирать не дал: класс владельца — отказ
      // среды или сборки, а он чтением кода не снимается.
      { task: 6, readOnly: false, daemonAlive: false, stall: { stop: 'human', arbitrable: false } },
      stalledTask(5),
    ],
  });
  await instance.tick();
  assert.deepEqual(calls, ['5']);
});

test('одна задача за обход: арбитраж занимает минуты живого агента', async () => {
  const { instance, calls } = await watcher({ tasks: [stalledTask(1), stalledTask(2)] });
  await instance.tick();
  assert.deepEqual(calls, ['1'], 'вторая дождётся следующего события шины');
});

test('дешёвый отказ не прерывает обход и уходит в cooldown', async () => {
  const { instance, calls } = await watcher({
    tasks: [stalledTask(1), stalledTask(2)],
    // Не выбрана модель: отказ случился ДО обращения к ней и ничего не стоил. Десять
    // задач без модели — это десять дешёвых отказов, а не повод закончить обход на первой.
    arbitrate: (id, reply) => {
      reply.code(409).send({ error: 'no_model' });
      return null;
    },
  });
  await instance.tick();
  assert.deepEqual(calls, ['1', '2'], 'дешёвый отказ обход не прерывает');
  await instance.tick();
  assert.deepEqual(calls, ['1', '2'], 'повторного захода в том же часе нет');
});

test('провал ПОСЛЕ обращения к модели заканчивает обход', async () => {
  // Такой отказ обошёлся в минуты живого агента (ход упал или ответ не разобрался).
  // Пойти дальше по списку значило бы сжечь десяток таких ходов за один обход.
  const { instance, calls } = await watcher({
    tasks: [stalledTask(1), stalledTask(2)],
    arbitrate: (id, reply) => {
      reply.code(409).send({ error: 'arbiter_run_failed' });
      return null;
    },
  });
  await instance.tick();
  assert.deepEqual(calls, ['1'], 'вторая задача дождётся следующего события шины');
});

test('решение о границе задачи автомат не повторяет', async () => {
  const { instance, calls } = await watcher({
    tasks: [stalledTask(1)],
    arbitrate: () => ({ ok: true, resolved: false, verdict: 'human', card: {} }),
  });
  await instance.tick();
  await instance.tick();
  assert.deepEqual(calls, ['1'], 'карточка уже у человека, второй раз спрашивать нечего');
});

// Тот же запрет, но через ЕДИНСТВЕННЫЙ путь, которым он работает в бою: карточка приезжает
// со сводкой задачи, а не остаётся в памяти вотчера. Прежний тест этого не проверял — оба
// его прогона попадали в часовой cooldown, и запрет мог не работать вовсе. Так и вышло:
// сводка `/api/tasks` узла не несла, сравнение с `decided.node` не совпадало никогда, и в
// живом прогоне 28.08.2026 арбитр через час взял ту же остановку и решил её сам.
test('сохранённый разбор запрещает повтор и после перезапуска сервера', async () => {
  const decided = { verdict: 'human', node: 'build', stop: 'human' };
  const { instance, calls } = await watcher({
    tasks: [{
      task: 7,
      readOnly: false,
      daemonAlive: false,
      stall: { stop: 'human', arbitrable: true, node: 'build', arbiter: decided },
    }],
  });
  await instance.tick();
  assert.deepEqual(calls, [], 'вопрос уже задан человеку — второй ответ отменял бы первый');
});

// Человек ответил, маршрут поехал и встал в другом месте. Это другая остановка: запрет
// привязан к той, которую арбитр уже разбирал, а не ко всей попытке.
test('остановка на другом узле разбирается несмотря на прежний отказ', async () => {
  const decided = { verdict: 'human', node: 'build', stop: 'human' };
  const { instance, calls } = await watcher({
    tasks: [{
      task: 8,
      readOnly: false,
      daemonAlive: false,
      stall: { stop: 'human', arbitrable: true, node: 'review', arbiter: decided },
    }],
  });
  await instance.tick();
  assert.deepEqual(calls, ['8']);
});

// Узел известен не всегда: старые записи движка называли остановку без него. Тогда
// запрет остаётся в силе — лишний запрет стоит нажатия кнопки, лишний разбор стоит часа
// живого агента и решения, принятого за человека.
test('неизвестный узел не снимает запрет', async () => {
  const { instance, calls } = await watcher({
    tasks: [{
      task: 9,
      readOnly: false,
      daemonAlive: false,
      stall: {
        stop: 'human',
        arbitrable: true,
        node: null,
        arbiter: { verdict: 'human', node: 'build', stop: 'human' },
      },
    }],
  });
  await instance.tick();
  assert.deepEqual(calls, [], 'сравнить нечем — считаем остановку той же');
});

test('падение разбора не роняет обход', async () => {
  const { instance, calls } = await watcher({
    tasks: [stalledTask(1)],
    arbitrate: () => { throw new Error('исполнитель недоступен'); },
  });
  await instance.tick();
  assert.deepEqual(calls, ['1']);
  await instance.tick();
  assert.deepEqual(calls, ['1'], 'после падения задача тоже под cooldown');
});

// Молчащий вотчер неотличим от неработающего. 28.08.2026 остановка задачи была для
// арбитра подходящей, автомат включён, а в журнале сервера не нашлось ни строки —
// установить постфактум, дошло ли до разбора, оказалось нечем.
test('взятие остановки в разбор и отказ в пользу человека видны в журнале', async () => {
  const { instance, notes } = await watcher({
    tasks: [stalledTask(1)],
    arbitrate: () => ({ ok: true, resolved: false, verdict: 'human', card: {} }),
  });
  await instance.tick();
  assert.equal(notes.length, 2, 'вход в разбор и его исход — две отдельные строки');
  assert.match(notes[0], /беру остановку в разбор/);
  assert.match(notes[1], /отдано человеку/);
});

test('снятый тупик тоже называет себя одной строкой', async () => {
  const { instance, notes } = await watcher({ tasks: [stalledTask(1)] });
  await instance.tick();
  assert.match(notes[0], /беру остановку в разбор/);
  assert.match(notes[1], /тупик снят/);
});

// Промпт утверждал «запускать команды ты НЕ можешь — режим только для чтения», а замер
// живым CLI показал обратное: plan разрешает read-only Bash (34 успешные команды в одном
// разборе) и блокирует лишь нативные правки и перенаправление в файл. Ложное ограничение
// прямо сужало арбитра — он отказывался от проверок, которые ему доступны.
test('промпт не врёт про возможности и называет бюджет времени', async () => {
  const { buildArbiterPrompt } = await import('../../server/src/lib/factoryArbiter.ts');
  const prompt = buildArbiterPrompt({
    task: '8507',
    node: 'build',
    target: 'build',
    reason: 'узел вернул решение человеку',
    series: [{
      node: 'build',
      owner: 'plan',
      findings: [{ id: 'x', summary: 'принятый план опровергнут' }],
      reviewed: [],
    }],
    stateDir: '/tmp/state',
    stop: 'human',
    budgetMin: 20,
  });

  assert.equal(prompt.includes('Запускать команды ты НЕ'), false, 'ложный запрет снят');
  assert.match(prompt, /ЗАПУСКАТЬ КОМАНДЫ/);
  // Запись через запущенную программу режимом НЕ блокируется (замер: node -e writeFileSync
  // создал файл), поэтому единственная защита рабочего дерева — прямой запрет в промпте.
  assert.match(prompt, /рабочее дерево задачи менять НЕЛЬЗЯ ВООБЩЕ/i);
  // Оборванный по времени ход не даёт ничего: потраченные минуты живого агента пропадают
  // целиком, а задача уходит в часовой cooldown. Знающий бюджет закругляется сам.
  assert.match(prompt, /У тебя 20 минут/);
  assert.match(prompt, /verdict = "human" с тем, что успел/);
});

// Число живёт в одном месте (`ARBITER_TURN_LIMIT_MS` рядом с самим таймаутом): вторая
// копия в тексте промпта разошлась бы с резаком, и агент планировал бы не тот бюджет.
test('бюджет промпта берётся из лимита хода, а не из второй копии числа', async () => {
  const prompt = buildConversationPrompt({
    messages: [],
    result: null,
    operations: [],
  },
    { identity: {}, evidence: {}, targets: [], policies: [] }, 'start');

  assert.equal(ARBITER_TURN_LIMIT_MS, 20 * 60_000);
  assert.equal(prompt.includes(`У тебя ${ARBITER_TURN_LIMIT_MS / 60_000} минут`), true);
});

test('возврат арбитра со старым actor тоже считается', async () => {
  const root = await ledger([
    failedCommit('skeptic', 'plan', [{ id: 'fresh', summary: 'до арбитража' }]),
    {
      kind: 'human-rewind',
      node: 'plan',
      action: { rewind: 'plan' },
      actor: LEGACY_VALUES.arbiterActor,
      reason: 'арбитр',
    },
    failedCommit('skeptic', 'plan', [{ id: 'latest', summary: 'после арбитража' }]),
  ]);
  const context = await readArbitrationContext({ controlDir: root, task: TASK, attempt: ATTEMPT });

  assert.equal(context.arbitrations, 1, 'иначе старые возвраты не входят в лимит арбитража');
});

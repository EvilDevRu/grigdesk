// Арбитр типизированной остановки конвейера.
//
// Механизм действует САМ: двигает курсор чужой задачи по решению модели. Поэтому здесь
// проверяются не «счастливые» пути, а границы — что арбитр разбирать не берётся, чего он
// решать не вправе и чем его решение отличается в журнале от человеческого.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
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
} from '../../server/src/lib/factory-arbiter.js';
import { routeGotoArgs } from '../../server/src/lib/factory-route-cli.js';

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

test('арбитр берётся только за остановку по отсутствию прогресса', async () => {
  const root = await ledger([
    failedCommit('skeptic', 'plan', [{ id: 'a', summary: 'раз' }]),
    noProgress('skeptic', 'plan', 'причина'),
  ]);
  const context = await readArbitrationContext({ controlDir: root, task: TASK, attempt: ATTEMPT });

  assert.equal(arbitrationGate(context, cursorStopped('no-progress')).ok, true);
  // `human` — прямой вызов человека (упал стенд, не хватило прав): решение оттуда не
  // выводится из вердиктов дуги, и подставлять туда модель нечем.
  assert.equal(arbitrationGate(context, cursorStopped('human')).error, 'not_arbitrable');
  assert.equal(arbitrationGate(context, cursorStopped('rewind-limit')).error, 'not_arbitrable');
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

test('границу задачи арбитр не решает', () => {
  const card = {
    what: 'что', why: 'почему', proof: 'чем доказал', risk: 'чем грозит',
  };
  // Признака два, и проверяются оба: объявленный самим арбитром `scope_change` честнее
  // (он видел контекст), а вердикт страхует ответ, где поле забыли.
  const declared = parseArbiterDecision(JSON.stringify({
    verdict: 'resolve', scope_change: true, card, instruction: 'снять критерий 5',
  }));
  assert.equal(declared.verdict, 'human');
  assert.equal(declared.instruction, '', 'указание с изменением границы до узла не едет');

  const chosen = parseArbiterDecision(JSON.stringify({ verdict: 'human', card, instruction: '' }));
  assert.equal(chosen.verdict, 'human');
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
  // И обязан знать границу своих возможностей: режим только для чтения команд не запускает,
  // а вопрос, который без запуска не решается, — законный повод отдать решение человеку.
  assert.match(prompt, /Запускать команды ты НЕ/);
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
  const { FactoryArbiterWatch } = await import('../../server/src/lib/factory-arbiter-watch.js');
  const calls = [];
  const instance = new FactoryArbiterWatch({
    sse: { subscribe: () => () => {} },
    prefs: { read: () => ({ arbiter: { auto } }) },
    listTasks: async () => tasks,
    arbitrate: async (id, reply) => {
      calls.push(id);
      return arbitrate ? arbitrate(id, reply) : { ok: true, resolved: true, node: 'plan' };
    },
    log: { warn() {}, info() {} },
  });
  return { instance, calls };
}

const stalledTask = (task) => ({
  task, readOnly: false, daemonAlive: false, stall: { stop: 'no-progress' },
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

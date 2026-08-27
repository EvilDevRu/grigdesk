// Подтверждение запуска resume. `systemd-run` возвращает 0 сразу после регистрации
// юнита, поэтому «прогон продолжен» раньше означало лишь «юнит зарегистрирован»:
// В регрессионном сценарии юнит умирал через две секунды на разошедшемся контракте профиля (код 75),
// а кокпит четыре раза подряд отвечал успехом.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  confirmRouteResume, logLength, readLogSince, routeFailure,
} from '../../server/src/lib/factory-route-cli.js';

const ATTEMPT = 'a_00112233445566778899aabbccddeeff';

test('живой юнит и совпавшая попытка — прогон подтверждён', async () => {
  let polls = 0;
  const res = await confirmRouteResume({
    attempt: ATTEMPT,
    identity: async () => ({ attempt: ATTEMPT, alive: true }),
    unitAlive: async () => { polls += 1; return true; },
    reason: async () => '',
    settleMs: 12, stepMs: 4,
  });
  assert.deepEqual(res, { ok: true, outcome: 'running' });
  assert.ok(polls >= 2, 'окно быстрых отказов опрашивается несколько раз');
});

test('юнит, умерший в окне, — отказ с причиной из журнала этапов', async () => {
  let polls = 0;
  const res = await confirmRouteResume({
    attempt: ATTEMPT,
    identity: async () => { throw new Error('реестр не должен решать за мёртвый юнит'); },
    unitAlive: async () => { polls += 1; return polls < 2; },
    reason: async () => 'контракт попытки разошёлся с профилем — project-context: guardrails',
    settleMs: 200, stepMs: 4,
  });
  assert.equal(res.ok, false);
  assert.equal(res.outcome, 'exited');
  assert.match(res.message, /project-context: guardrails/);
});

// Одного живого ORCH_PID мало: движок пишет его ДО проверки контракта, поэтому
// «жив» держится ровно те же секунды, что и обречённый процесс.
test('живой юнит с ЧУЖОЙ попыткой в реестре не считается продолжением', async () => {
  const res = await confirmRouteResume({
    attempt: ATTEMPT,
    identity: async () => ({ attempt: 'a_ffffffffffffffffffffffffffffffff', alive: true }),
    unitAlive: async () => true,
    reason: async () => '',
    settleMs: 8, stepMs: 4,
  });
  assert.equal(res.ok, false);
  assert.equal(res.outcome, 'unconfirmed');
  assert.equal(res.message, 'оркестратор не подтвердил запуск попытки');
});

// Ложная тревога, ради которой окно подтверждения и появилось: реестр не успевал
// получить ATTEMPT_ID/ORCH_PID за окно быстрых отказов, и кокпит писал «прогон не
// поехал» над идущим прогоном. Живой замер: возврат курсора в 10:55:14, заход узла
// в 10:55:33 — девятнадцать секунд, львиная доля на preflight исполнителей.
test('поздняя запись реестра — не отказ: identity опрашивается после окна', async () => {
  let reads = 0;
  const res = await confirmRouteResume({
    attempt: ATTEMPT,
    identity: async () => {
      reads += 1;
      // Первые снимки — движок ещё не дописал реестр.
      if (reads < 4) return { attempt: '', alive: false };
      return { attempt: ATTEMPT, alive: true };
    },
    unitAlive: async () => true,
    reason: async () => 'причины нет, прогон идёт',
    settleMs: 8, stepMs: 2, confirmMs: 400,
  });
  assert.deepEqual(res, { ok: true, outcome: 'running' });
  assert.ok(reads >= 4, 'реестр перечитывается, а не снимается один раз');
});

test('нечитаемый реестр в окне подтверждения тоже дожидается движка', async () => {
  let reads = 0;
  const res = await confirmRouteResume({
    attempt: ATTEMPT,
    identity: async () => {
      reads += 1;
      return reads < 3 ? null : { attempt: ATTEMPT, alive: true };
    },
    unitAlive: async () => true,
    reason: async () => '',
    settleMs: 8, stepMs: 2, confirmMs: 400,
  });
  assert.equal(res.ok, true);
});

test('чужая попытка отвечает сразу, не выбирая окно подтверждения', async () => {
  // Ждать тут нечего: реестр назвал ДРУГУЮ попытку, и от времени это не изменится.
  const started = Date.now();
  const res = await confirmRouteResume({
    attempt: ATTEMPT,
    identity: async () => ({ attempt: 'a_ffffffffffffffffffffffffffffffff', alive: true }),
    unitAlive: async () => true,
    reason: async () => '',
    settleMs: 8, stepMs: 2, confirmMs: 5000,
  });
  assert.equal(res.outcome, 'unconfirmed');
  assert.ok(Date.now() - started < 2000, 'авторитетный ответ не ждёт окна подтверждения');
});

test('юнит, умерший уже в окне подтверждения, — отказ с причиной', async () => {
  let polls = 0;
  const res = await confirmRouteResume({
    attempt: ATTEMPT,
    identity: async () => ({ attempt: '', alive: false }),
    unitAlive: async () => { polls += 1; return polls < 4; },
    reason: async () => 'route: контракт попытки разошёлся с профилем',
    settleMs: 8, stepMs: 2, confirmMs: 5000,
  });
  assert.equal(res.ok, false);
  assert.equal(res.outcome, 'exited');
  assert.match(res.message, /контракт попытки разошёлся/);
});

test('мёртвый оркестратор при живом юните — тоже не подтверждение', async () => {
  const res = await confirmRouteResume({
    attempt: ATTEMPT,
    identity: async () => ({ attempt: ATTEMPT, alive: false }),
    unitAlive: async () => true,
    reason: async () => 'route: прогон завершён',
    settleMs: 8, stepMs: 4, confirmMs: 20,
  });
  assert.equal(res.ok, false);
  assert.equal(res.outcome, 'unconfirmed');
  assert.equal(res.message, 'route: прогон завершён');
});

test('в причину попадает только дописанное после запуска, и не в байтах', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cockpit-resume-log-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 't42.stages.log');
  const before = 'старая строка про узел diagnose\n';
  await writeFile(file, before, 'utf8');

  const from = await logLength(file);
  assert.equal(from, before.length, 'точка отсчёта — символы, а не байты utf-8');

  await writeFile(file, `${before}контракт попытки разошёлся с профилем\nкод 75\n`, 'utf8');
  const reason = await readLogSince(file, from);
  assert.equal(reason, 'контракт попытки разошёлся с профилем; код 75');
  assert.ok(!reason.includes('старая строка'), 'чужие строки журнала в причину не попадают');
});

test('typed preflight прошлого запуска не типизирует новый несвязанный отказ', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cockpit-launch-log-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 't43.launch.log');
  await writeFile(file,
    'FACTORY_ERROR=runner_preflight_unavailable RUNNERS=kimi\n', 'utf8');
  const from = await logLength(file);
  await writeFile(file,
    'FACTORY_ERROR=runner_preflight_unavailable RUNNERS=kimi\nновый отказ контракта\n',
    'utf8');
  const current = await readLogSince(file, from, { lines: 10, limit: 2000 });
  assert.equal(current, 'новый отказ контракта');
  assert.equal(routeFailure(current), null);
});

test('пустой журнал не оставляет отказ без текста', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cockpit-resume-log-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const res = await confirmRouteResume({
    attempt: ATTEMPT,
    identity: async () => null,
    unitAlive: async () => false,
    reason: () => readLogSince(path.join(dir, 'нет-такого.log'), 0),
    settleMs: 20, stepMs: 4,
  });
  assert.equal(res.ok, false);
  assert.equal(res.message, 'прогон вышел сразу после запуска');
});

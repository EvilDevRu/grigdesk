// Журнал заданий раздела: повтор, поздние отчёты, терминальность и сверка после
// перезапуска.
//
// Задание переживает перезапуск кокпита, поэтому проверяется то, из-за чего оно
// врёт чаще всего: двойной клик не должен заводить второй прогон, отчёт прошлой
// попытки не должен возвращать старый статус, а мёртвый процесс — оставаться
// вечно идущим.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createShowcaseJobs, isTerminal, toPublicJob } from '../../server/src/lib/showcase/jobs.ts';

async function fixture(t, limits = { maxQueued: 4, jobTimeoutMs: 30 * 60_000 }) {
  const jobsDir = await mkdtemp(path.join(os.tmpdir(), 'showcase-jobs-'));

  t.after(() => rm(jobsDir, { recursive: true, force: true }));

  const events = [];
  const jobs = createShowcaseJobs({
    jobsDir,
    broadcast: (name, data) => events.push([name, data]),
    limits: () => limits,
  });

  await jobs.recover();

  return { jobs, jobsDir, events };
}

function enqueueInput(overrides = {}) {
  return {
    projectId: 'project-1',
    kind: 'record',
    idempotencyKey: 'inputs-v1',
    inputHashes: { scenes: 'hash-1' },
    inputRevision: 3,
    ...overrides,
  };
}

test('очередь не выдаёт заданий, пока журнал не сверен с процессами', async (t) => {
  const jobsDir = await mkdtemp(path.join(os.tmpdir(), 'showcase-jobs-'));

  t.after(() => rm(jobsDir, { recursive: true, force: true }));

  const jobs = createShowcaseJobs({
    jobsDir,
    broadcast: () => {},
    limits: () => ({ maxQueued: 4, jobTimeoutMs: 60_000 }),
  });

  await assert.rejects(
    () => jobs.enqueue(enqueueInput()),
    (error) => error.code === 'not_recovered' && error.status === 503,
  );
});

test('повтор с теми же входами возвращает то же задание', async (t) => {
  const { jobs } = await fixture(t);
  const first = await jobs.enqueue(enqueueInput());
  const second = await jobs.enqueue(enqueueInput());

  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.record.id, first.record.id);
  assert.equal(jobs.active().length, 1);
});

test('изменённые входы заводят новое задание', async (t) => {
  const { jobs } = await fixture(t);
  const first = await jobs.enqueue(enqueueInput());
  const second = await jobs.enqueue(enqueueInput({ idempotencyKey: 'inputs-v2' }));

  assert.notEqual(second.record.id, first.record.id);
  assert.equal(jobs.active().length, 2);
});

test('очередь ограничена: лишняя заявка получает отказ, а не молча встаёт', async (t) => {
  const { jobs } = await fixture(t, { maxQueued: 2, jobTimeoutMs: 60_000 });

  await jobs.enqueue(enqueueInput({ idempotencyKey: 'a' }));
  await jobs.enqueue(enqueueInput({ idempotencyKey: 'b' }));

  await assert.rejects(
    () => jobs.enqueue(enqueueInput({ idempotencyKey: 'c' })),
    (error) => error.code === 'queue_full' && error.status === 429,
  );
});

test('поздний отчёт прошлой попытки не подменяет статус новой', async (t) => {
  const { jobs } = await fixture(t);
  const { record } = await jobs.enqueue(enqueueInput());

  await jobs.progress(record.id, { sequence: 5, label: 'пишем сцену 2' });

  const late = await jobs.progress(record.id, { sequence: 2, label: 'пишем сцену 1' });

  assert.equal(late.sequence, 5);
  assert.equal(late.progress.label, 'пишем сцену 2');
});

test('терминальное состояние окончательно и обратно в работу не возвращается', async (t) => {
  const { jobs } = await fixture(t);
  const { record } = await jobs.enqueue(enqueueInput());

  await jobs.finish(record.id, { state: 'failed', error: 'сцена не записалась' });

  const afterProgress = await jobs.progress(record.id, { sequence: 99, label: 'снова идёт' });

  assert.equal(afterProgress.state, 'failed');
  assert.equal(afterProgress.error, 'сцена не записалась');
  assert.ok(isTerminal(afterProgress.state));

  const afterFinish = await jobs.finish(record.id, { state: 'succeeded' });

  assert.equal(afterFinish.state, 'failed');
});

test('ожидание решения закрывает исполнитель и не занимает очередь', async (t) => {
  const { jobs } = await fixture(t, { maxQueued: 1, jobTimeoutMs: 60_000 });
  const { record } = await jobs.enqueue(enqueueInput());
  const review = await jobs.finish(record.id, {
    state: 'awaiting_review',
    error: 'Привязка сцены устарела.',
  });

  assert.equal(review.state, 'awaiting_review');
  assert.ok(isTerminal(review.state));
  await assert.doesNotReject(() => jobs.enqueue(enqueueInput({ idempotencyKey: 'after-review' })));
});

test('отмена идущей работы ждёт исполнителя, а не объявляет её завершённой', async (t) => {
  const { jobs } = await fixture(t);
  const { record } = await jobs.enqueue(enqueueInput());

  await jobs.progress(record.id, {
    sequence: 2,
    label: 'пишем сцену',
    identity: { pid: process.pid, starttime: null, cmdline: null },
  });

  const cancelling = await jobs.cancel(record.id);

  assert.equal(cancelling.state, 'cancelling');
  assert.ok(!isTerminal(cancelling.state), 'дерево процессов ещё живо, задание не закрыто');

  const late = await jobs.finish(record.id, { state: 'succeeded', label: 'поздний успех' });

  assert.equal(late.state, 'cancelled', 'сохранённая отмена сильнее позднего успеха функции');
  assert.ok(isTerminal(late.state));
});

test('устойчивый ключ этапа находит child после окна сбоя записи ссылки', async (t) => {
  const { jobs } = await fixture(t);
  const first = await jobs.withStageKey('build:run:voice:1', () => jobs.enqueue(enqueueInput()));
  const joined = await jobs.withStageKey('build:run:voice:joined', () => jobs.enqueue(enqueueInput()));

  assert.equal(joined.reused, true);
  assert.equal(joined.record.id, first.record.id);
  assert.equal(jobs.findByStageKey('build:run:voice:1')?.id, first.record.id);
  assert.equal(jobs.findByStageKey('build:run:voice:joined')?.id, first.record.id);
  assert.deepEqual(joined.record.stageKeys, [
    'build:run:voice:1',
    'build:run:voice:joined',
  ]);
});

test('заявка в очереди отменяется сразу: останавливать ещё некого', async (t) => {
  const { jobs } = await fixture(t);
  const { record } = await jobs.enqueue(enqueueInput());
  const cancelled = await jobs.cancel(record.id);

  assert.equal(cancelled.state, 'cancelled');
});

test('после перезапуска задание мёртвого процесса становится оборванным', async (t) => {
  const { jobs, jobsDir, events } = await fixture(t);
  const { record } = await jobs.enqueue(enqueueInput());

  // Задание пережило перезапуск с записанной identity процесса, которого уже нет:
  // одного pid мало, поэтому в журнале лежит и время старта, и командная строка.
  const file = path.join(jobsDir, record.id, 'job.json');
  const stored = JSON.parse(await readFile(file, 'utf8'));

  await writeFile(file, JSON.stringify({
    ...stored,
    state: 'running',
    heartbeatAt: new Date().toISOString(),
    identity: { pid: 999_999, starttime: '111', cmdline: 'showcaseWorker' },
  }), 'utf8');

  const fresh = createShowcaseJobs({
    jobsDir,
    broadcast: (name, data) => events.push([name, data]),
    limits: () => ({ maxQueued: 4, jobTimeoutMs: 60_000 }),
  });
  const result = await fresh.recover();

  assert.equal(result.interrupted, 1);
  assert.equal(fresh.read(record.id).state, 'interrupted');
  assert.match(fresh.read(record.id).error, /не пережил перезапуск/);
});

test('живой процесс после перезапуска остаётся под наблюдением', async (t) => {
  const { jobs, jobsDir } = await fixture(t);
  const { record } = await jobs.enqueue(enqueueInput());
  const file = path.join(jobsDir, record.id, 'job.json');
  const stored = JSON.parse(await readFile(file, 'utf8'));
  const identity = await import('../../server/src/lib/speech/modelJobsProcess.ts')
    .then((module) => module.readProcessIdentity(process.pid));

  await writeFile(file, JSON.stringify({
    ...stored,
    state: 'running',
    heartbeatAt: new Date().toISOString(),
    identity,
  }), 'utf8');

  const fresh = createShowcaseJobs({
    jobsDir,
    broadcast: () => {},
    limits: () => ({ maxQueued: 4, jobTimeoutMs: 60_000 }),
  });
  const result = await fresh.recover();

  assert.equal(result.alive, 1);
  assert.equal(result.interrupted, 0);
  assert.equal(fresh.read(record.id).state, 'running');
});

test('просроченное задание становится видимой причиной, а не вечным «идёт»', async (t) => {
  const { jobs } = await fixture(t, { maxQueued: 4, jobTimeoutMs: -1 });
  const { record } = await jobs.enqueue(enqueueInput());
  const stopped = await jobs.sweepExpired();

  assert.equal(stopped.length, 1);
  assert.equal(stopped[0].id, record.id);
  assert.equal(stopped[0].state, 'interrupted');
  assert.match(stopped[0].error, /не уложилось в отведённый срок/);
});

test('наружу уходит только сводка задания', async (t) => {
  const { jobs } = await fixture(t);
  const { record } = await jobs.enqueue(enqueueInput());
  const serialized = JSON.stringify(toPublicJob(record));

  assert.ok(!serialized.includes('inputs-v1'), 'ключ повтора остаётся на сервере');
  assert.ok(!serialized.includes('hash-1'), 'хеши входов остаются на сервере');
  assert.ok(!serialized.includes('identity'), 'identity процесса наружу не уходит');
  assert.ok(serialized.includes('project-1'), 'ролик задания человеку показать нужно');
});

test('прогресс уходит в общий поток событий сводкой', async (t) => {
  const { jobs, events } = await fixture(t);
  const { record } = await jobs.enqueue(enqueueInput());

  await jobs.progress(record.id, { sequence: 3, label: 'пишем сцену', index: 2, total: 6 });

  const progress = events.filter(([name]) => name === 'showcase-progress');
  const last = progress[progress.length - 1][1];

  assert.equal(last.jobId, record.id);
  assert.equal(last.sequence, 3);
  assert.equal(last.label, 'пишем сцену');
  assert.equal(last.index, 2);
  assert.equal(last.total, 6);
  assert.equal(last.error, null);
  assert.ok(!('inputHashes' in last), 'в событие не попадают входы задания');

  // Причина отказа едет в той же сводке: интерфейсу не нужно перечитывать обзор,
  // чтобы показать, почему задание встало.
  await jobs.finish(record.id, { state: 'failed', error: 'вход на стенд не удался' });

  const failed = events.filter(([name]) => name === 'showcase-progress').at(-1)[1];

  assert.equal(failed.state, 'failed');
  assert.equal(failed.error, 'вход на стенд не удался');
});

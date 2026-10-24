import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { ArbiterCardsStore } from '../../server/src/lib/arbiterCards.ts';
import { buildTicket, validateTicket } from '../../server/src/lib/factoryTicket.ts';
import { parseSurfaceTarget } from '../../shared/desktop/surfaceContract.ts';
import { ownTask, seedTasks, tasksFixture } from './helpers/grigdesk-tasks.js';

const FIRST = 100000000000;

test('NUMBER-01: каждый технический корень и служебный диапазон занимают номер', async (t) => {
  const fx = await tasksFixture(t, {
    configured: true,
    configure(config) {
      config.sandboxManualRange = { from: FIRST + 8, to: FIRST + 9 };
    },
  });
  const sources = [
    [fx.config.stateDir, 't<ID>.pipeline'],
    [path.join(fx.config.stateDir, 'archive'), 't<ID>.pipeline'],
    [fx.config.analysisDir, 't<ID>.analysis.json'],
    [fx.config.ticketsDir, 't<ID>.ticket.json'],
    [fx.config.sandboxJournalDir, 't<ID>.json'],
    [path.join(fx.config.stateDir, 'slots'), 't<ID>.slot'],
    [path.join(fx.config.factoryControlDir, 'protocol-v2', 'tasks'), 't<ID>'],
    [fx.config.artifactsDir, 'review-<ID>'],
  ];

  for (const [index, [directory, pattern]] of sources.entries()) {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, pattern.replace('<ID>', String(FIRST + index))), 'занято');
  }

  fx.presence.set(String(FIRST + 10), 'exists');
  await seedTasks(fx.config, [ownTask(String(FIRST + 11))], String(FIRST));

  const response = await fx.create();

  assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.json().task.id, String(FIRST + 12));
  assert.deepEqual(fx.probes, [String(FIRST + 10), String(FIRST + 12)]);
});

test('NUMBER-02: независимые экземпляры и ручной wx не получают один номер', async (t) => {
  const first = await tasksFixture(t);
  const second = await tasksFixture(t, { root: first.root });

  await seedTasks(first.config, [], String(FIRST));

  const manualPath = path.join(first.config.analysisDir, `t${FIRST}.status.json`);
  const manual = writeFile(manualPath, 'ручной захват\n', { flag: 'wx' });
  const [firstResponse, secondResponse, claim] = await Promise.allSettled([
    first.create(), second.create(), manual,
  ]);
  const responses = [firstResponse, secondResponse];

  for (const response of responses) {
    assert.equal(response.status, 'fulfilled');
    assert.equal(response.value.statusCode, 201, response.value.body);
  }

  const ids = responses.map((response) => response.value.json().task.id);

  assert.equal(new Set(ids).size, 2);

  if (claim.status === 'fulfilled') {
    assert.ok(ids.every((id) => Number(id) > FIRST));
    assert.equal(await readFile(manualPath, 'utf8'), 'ручной захват\n');
  } else {
    assert.equal(claim.reason.code, 'EEXIST');
    assert.ok(ids.includes(String(FIRST)));
  }
});

test('NUMBER-03: рестарт не повторяет номер, corrupt и сбой записи не выдают задачу', async (t) => {
  const fx = await tasksFixture(t);
  const first = await fx.create();

  assert.equal(first.statusCode, 201, first.body);

  const restarted = await tasksFixture(t, { root: fx.root });
  const second = await restarted.create();

  assert.equal(second.statusCode, 201, second.body);
  assert.notEqual(first.json().task.id, second.json().task.id);
  await writeFile(fx.config.grigdeskTasksPath, '{повреждено');

  const corrupt = await fx.create();

  assert.equal(corrupt.statusCode, 503, corrupt.body);
  assert.equal(await readFile(fx.config.grigdeskTasksPath, 'utf8'), '{повреждено');

  const locked = await tasksFixture(t);

  await seedTasks(locked.config, []);

  const protectedBytes = await readFile(locked.config.grigdeskTasksPath, 'utf8');

  await chmod(locked.config.grigdeskTasksPath, 0);
  t.after(() => chmod(locked.config.grigdeskTasksPath, 0o600).catch(() => {}));

  const denied = await locked.create();

  assert.equal(denied.statusCode, 503, denied.body);
  await chmod(locked.config.grigdeskTasksPath, 0o600);
  assert.equal(await readFile(locked.config.grigdeskTasksPath, 'utf8'), protectedBytes);

  const unwritable = await tasksFixture(t, { configured: true });

  await seedTasks(unwritable.config, []);

  const before = await readFile(unwritable.config.grigdeskTasksPath, 'utf8');

  unwritable.moduleOptions.b24.probeTaskNumber = async () => {
    await chmod(unwritable.root, 0o500);

    return 'absent';
  };

  let refused;

  try {
    refused = await unwritable.create();
  } finally {
    await chmod(unwritable.root, 0o700);
  }

  assert.equal(refused.statusCode, 503, refused.body);
  assert.equal(await readFile(unwritable.config.grigdeskTasksPath, 'utf8'), before);
});

test('NUMBER-04: границы проходят настоящие контракты, резерв не является оценкой', async (t) => {
  const fx = await tasksFixture(t);
  const cards = new ArbiterCardsStore(path.join(fx.root, 'cards.json'));

  for (const id of ['100000000000', '999999999999']) {
    const ticket = buildTicket({
      task: id,
      title: 'Граница номера',
      description: '',
      sourceUrl: `http://client.test/#/board?openTask=${id}`,
      acceptanceCriteria: [],
    });

    assert.equal(validateTicket(ticket, id), ticket);
    assert.equal(String(ticket.taskId), id);
    assert.deepEqual(parseSurfaceTarget({ kind: 'task', id }), { kind: 'task', id });
    await cards.save(id, { verdict: 'human', card: { what: 'Проверить границу' } });
    assert.ok(cards.read(id));
  }

  const response = await fx.create();

  assert.equal(response.statusCode, 201, response.body);

  const files = await readdir(fx.config.analysisDir);

  assert.deepEqual(files, [`t${response.json().task.id}.status.json`]);
  assert.equal(await readFile(path.join(fx.config.analysisDir, files[0]), 'utf8'), 'null\n');
});

test('NUMBER-01: неизвестный ответ подключённого портала запрещает выдачу номера', async (t) => {
  const fx = await tasksFixture(t, { configured: true });

  await seedTasks(fx.config, [], String(FIRST));
  fx.presence.set(String(FIRST), 'unknown');

  const response = await fx.create();

  assert.equal(response.statusCode, 503, response.body);
  assert.equal(response.json().error, 'task_number_unverified');
  assert.deepEqual(JSON.parse(await readFile(fx.config.grigdeskTasksPath, 'utf8')).tasks, []);
});

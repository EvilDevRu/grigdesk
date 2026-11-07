// Действия профиля на поднятом стенде: манифест `profiles/<профиль>/actions.json`,
// запуск скрипта из карточки и его журнал.
//
// GrigDesk знает про действие ровно то, что объявил профиль: подпись, аргументы и путь
// скрипта внутри каталога профиля. Аргументы уходят argv в порядке объявления,
// прогон идёт под shared-арендой стенда (снос ждёт его конца), а итог — код выхода
// скрипта и хвост его вывода. Стенду конвейера действия тоже доступны: на воротах
// приёмки человек гоняет его руками.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createSandboxService } from '../../server/src/lib/sandboxes/service.ts';
import {
  readProfileActions,
  validateActionArgs,
} from '../../server/src/lib/sandboxes/actions.ts';
import { createSandboxActivityGuard } from '../../server/src/lib/sandboxes/activityGuard.ts';

const SLOTS_STUB = `#!/usr/bin/env bash
echo '{"range":[0,5],"used":[],"free":[0,1,2,3,4,5]}'
`;

const DOWN_STUB = `#!/usr/bin/env bash
set -euo pipefail
rm -f "$STATE_DIR/t$1.env"
echo "снесено"
`;

// Скрипт действия печатает шаги и записывает то, что получил: номер стенда и argv.
const ACTION_STUB = `#!/usr/bin/env bash
set -euo pipefail
TASK=$1
shift
echo "=== 1. старт ==="
printf '%s\\n' "task=$TASK" "args=$*" > "$STATE_DIR/t\${TASK}.action-args"
echo "=== 2. сверка ==="
echo "набор проходов: СОВПАДАЕТ"
`;

const SLOW_ACTION_STUB = `#!/usr/bin/env bash
set -euo pipefail
echo "жду отмашки"
while [[ ! -f "$STATE_DIR/t$1.action-continue" ]]; do
  sleep 0.02
done
echo "готово"
`;

const FAILING_ACTION_STUB = `#!/usr/bin/env bash
echo "ИТОГ: есть РАСХОЖДЕНИЯ с расписанием"
exit 1
`;

const MANIFEST = [
  {
    id: 'scan-schedule',
    label: 'Плановый съём',
    description: 'Гонит плановый съём проекта целиком.',
    script: 'actions/scan-schedule.sh',
    args: [
      {
        key: 'project', label: 'Номер проекта', type: 'number', required: true, hint: 'из песочницы',
      },
      {
        key: 'note', label: 'Пометка', type: 'text', required: false,
      },
    ],
    confirm: 'Спишет лимиты пользователя песочницы.',
  },
];

async function script(file, body) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body, 'utf8');
  await chmod(file, 0o755);
}

/** Реестр стенда, как его пишет подъём профиля: GrigDesk нужен только номер и порты. */
async function registryEntry(stateDir, task, extra = '') {
  await writeFile(path.join(stateDir, `t${task}.env`), [
    `TASK=${task}`,
    'SB_K=1',
    'API_PORT=8091',
    'FE_PORT=5191',
    'WORKSPACE_MODE=isolated',
    'STAND_OWNERSHIP=task',
    'REPO_COUNT=1',
    'REPO_0_NAME=backend',
    'REPO_0_SOURCE=/srv/source/backend',
    `REPO_0_WT=/srv/worktrees/backend-t${task}`,
    `REPO_0_BRANCH=route-task-${task}`,
    extra,
  ].join('\n'), 'utf8');
}

/**
 * Профиль-двойник с манифестом действий и скриптами-заглушками. Настоящих
 * контейнеров нет: проверяется то, чем управляет GrigDesk, — argv, аренда и журнал.
 */
async function fixture(t, { action = ACTION_STUB, manifest = MANIFEST } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-sandbox-actions-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const stateDir = path.join(root, 'state');
  const journalDir = path.join(root, 'journal');
  const profilesDir = path.join(root, 'profiles');
  const profileDir = path.join(profilesDir, 'demo-profile');
  const factoryBin = path.join(root, 'factory');

  await mkdir(stateDir, { recursive: true });
  await mkdir(profileDir, { recursive: true });
  await writeFile(path.join(profileDir, 'graph.json'), '{"capabilities":["route-v2"]}', 'utf8');
  await script(factoryBin, SLOTS_STUB);
  await script(path.join(profileDir, 'up.sh'), '#!/usr/bin/env bash\nexit 1\n');
  await script(path.join(profileDir, 'down.sh'), DOWN_STUB);
  await script(path.join(profileDir, 'actions', 'scan-schedule.sh'), action);

  if (manifest) {
    await writeFile(path.join(profileDir, 'actions.json'), JSON.stringify(manifest), 'utf8');
  }

  const warnings = [];
  const events = [];
  const service = createSandboxService({
    stateDir,
    journalDir,
    profilesDir,
    factoryBin,
    manualRange: { from: 990000, to: 990004 },
    sweepMs: 20,
    probe: async () => false,
    log: { warn: (fields, message) => warnings.push([fields, message]) },
    broadcast: (event, data) => events.push([event, data]),
  });
  t.after(() => service.stop());

  return {
    root, stateDir, journalDir, profilesDir, profileDir, service, warnings, events,
  };
}

async function settled(service, task, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const overview = await service.overview();
    const job = overview.jobs.find((item) => item.task === task);

    if (job && job.state !== 'running') {
      return job;
    }

    if (Date.now() > deadline) {
      throw new Error(`задание по стенду ${task} не завершилось за ${timeoutMs} мс: ${JSON.stringify(job)}`);
    }

    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
}

test('манифест действий читается по контракту, а кривой — отбрасывается с причиной', async (t) => {
  const { profilesDir, profileDir } = await fixture(t);

  const actions = await readProfileActions(profilesDir, 'demo-profile');

  assert.equal(actions.length, 1);
  assert.equal(actions[0].id, 'scan-schedule');
  assert.equal(actions[0].script, path.join(profileDir, 'actions', 'scan-schedule.sh'));
  assert.deepEqual(actions[0].args.map((arg) => arg.key), ['project', 'note']);
  assert.equal(actions[0].args[1].hint, null);

  assert.deepEqual(await readProfileActions(profilesDir, 'no-such-profile'), []);

  for (const [reason, broken] of [
    [/относительным путём/, [{ ...MANIFEST[0], script: '/usr/bin/env' }]],
    [/за каталог профиля/, [{ ...MANIFEST[0], script: '../../evil.sh' }]],
    [/недопустимый id/, [{ ...MANIFEST[0], id: 'Bad Id' }]],
    [/ключи аргументов повторяются/, [{ ...MANIFEST[0], args: [MANIFEST[0].args[0], MANIFEST[0].args[0]] }]],
    [/массивом/, { id: 'x' }],
  ]) {
    await writeFile(path.join(profileDir, 'actions.json'), JSON.stringify(broken), 'utf8');
    await assert.rejects(() => readProfileActions(profilesDir, 'demo-profile'), reason);
  }

  await writeFile(path.join(profileDir, 'actions.json'), '{нет', 'utf8');
  await assert.rejects(() => readProfileActions(profilesDir, 'demo-profile'), /JSON/);
});

test('аргументы проверяются по объявлению и уходят в argv в порядке объявления', () => {
  const args = MANIFEST[0].args.map((arg) => ({ hint: null, ...arg }));

  assert.deepEqual(validateActionArgs(args, { note: 'проба', project: ' 389 ', extra: 'x' }), {
    values: { project: '389', note: 'проба' },
    argv: ['389', 'проба'],
    error: null,
  });
  assert.deepEqual(validateActionArgs(args, { project: '389' }).argv, ['389', '']);
  assert.match(validateActionArgs(args, {}).error, /не задан аргумент «Номер проекта»/);
  assert.match(validateActionArgs(args, { project: '38a' }).error, /целым числом/);
  assert.match(validateActionArgs(args, { project: '1', note: 'a\nb' }).error, /одна строка/);
  assert.match(validateActionArgs(args, { project: '1', note: 'x'.repeat(201) }).error, /до 200/);
});

test('прогон уходит скриптом профиля с argv, пишет журнал и заканчивается итогом', async (t) => {
  const {
    service, stateDir, events,
  } = await fixture(t);

  await registryEntry(stateDir, '990001');

  const overview = await service.overview();
  const entry = overview.sandboxes.find((item) => item.task === '990001');

  assert.deepEqual(entry.actions.map((action) => action.id), ['scan-schedule']);
  assert.equal('script' in entry.actions[0], false);

  const started = await service.run({
    task: '990001', action: 'scan-schedule', args: { project: '389', note: 'проба' },
  });

  assert.equal(started.job.action, 'run');
  assert.equal(started.job.actionId, 'scan-schedule');
  assert.equal(started.job.actionLabel, 'Плановый съём');
  assert.equal(started.job.state, 'running');

  const job = await settled(service, '990001');

  assert.equal(job.state, 'done');
  assert.equal(job.label, 'прогон выполнен');
  assert.match(job.message, /набор проходов: СОВПАДАЕТ/);

  const { readFile } = await import('node:fs/promises');

  assert.equal(
    await readFile(path.join(stateDir, 't990001.action-args'), 'utf8'),
    'task=990001\nargs=389 проба\n',
  );

  const log = await service.jobLog('990001');

  assert.equal(log.action, 'run');
  assert.equal(log.state, 'done');
  assert.equal(log.truncated, false);
  assert.match(log.text, /=== 1\. старт ===[\s\S]*=== 2\. сверка ===/);
  assert.ok(events.some(([name, data]) => name === 'sandbox-progress' && data.action === 'run'));
});

test('идущий прогон показывает последнюю строку вывода шагом и держит снос', async (t) => {
  const { service, stateDir } = await fixture(t, { action: SLOW_ACTION_STUB });
  const guard = createSandboxActivityGuard({ stateDir, timeoutMs: 10 });

  await registryEntry(stateDir, '990001');
  await service.run({ task: '990001', action: 'scan-schedule', args: { project: '1' } });

  // Шаг подхватывается обходом живых заданий: ждём, пока он прочитает журнал.
  const deadline = Date.now() + 5000;

  for (;;) {
    const job = (await service.overview()).jobs.find((item) => item.task === '990001');

    if (job.label === 'жду отмашки') {
      break;
    }

    assert.ok(Date.now() < deadline, `шаг не подхвачен: ${JSON.stringify(job)}`);
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }

  await assert.rejects(
    () => service.dismantle({ task: '990001' }),
    (error) => error.code === 'job_running' || error.code === 'sandbox_busy',
  );
  await assert.rejects(
    () => guard.acquireLifecycle('990001'),
    (error) => error.code === 'SANDBOX_ACTIVITY_BUSY',
  );
  await assert.rejects(
    () => service.run({ task: '990001', action: 'scan-schedule', args: { project: '1' } }),
    (error) => error.code === 'job_running',
  );

  const overview = await service.overview();

  assert.equal(overview.sandboxes[0].removableReason, 'job_running');

  await writeFile(path.join(stateDir, 't990001.action-continue'), '', 'utf8');

  const job = await settled(service, '990001');

  assert.equal(job.state, 'done');

  const lease = await guard.acquireLifecycle('990001');

  await lease.release();
});

test('упавший скрипт — отказ с хвостом вывода, а не «выполнено»', async (t) => {
  const { service, stateDir } = await fixture(t, { action: FAILING_ACTION_STUB });

  await registryEntry(stateDir, '990001');
  await service.run({ task: '990001', action: 'scan-schedule', args: { project: '1' } });

  const job = await settled(service, '990001');

  assert.equal(job.state, 'failed');
  assert.match(job.message, /РАСХОЖДЕНИЯ/);
});

test('отказы: чужое действие, кривые аргументы, стенд без реестра', async (t) => {
  const { service, stateDir } = await fixture(t);

  await registryEntry(stateDir, '990001');

  await assert.rejects(
    () => service.run({ task: '990001', action: 'no-such', args: {} }),
    (error) => error.code === 'action_unknown' && error.status === 404,
  );
  await assert.rejects(
    () => service.run({ task: '990001', action: 'scan-schedule', args: {} }),
    (error) => error.code === 'bad_args' && error.status === 400,
  );
  await assert.rejects(
    () => service.run({ task: '990001', action: 'Bad Id', args: {} }),
    (error) => error.code === 'bad_action',
  );
  await assert.rejects(
    () => service.run({ task: '990009', action: 'scan-schedule', args: { project: '1' } }),
    (error) => error.code === 'sandbox_missing' && error.status === 404,
  );
  await assert.rejects(
    () => service.jobLog('990009'),
    (error) => error.code === 'job_missing',
  );
});

test('стенд конвейера получает действия профиля из реестра попытки', async (t) => {
  const { service, stateDir } = await fixture(t);

  await registryEntry(stateDir, '4242');
  await writeFile(path.join(stateDir, 't4242.pipeline'), 'PROFILE=demo-profile\nGATE_ACCEPT=waiting\n', 'utf8');

  const overview = await service.overview();
  const entry = overview.sandboxes.find((item) => item.task === '4242');

  assert.equal(entry.owner, 'pipeline');
  assert.equal(entry.profile, 'demo-profile');
  assert.equal(entry.removable, false);
  assert.deepEqual(entry.actions.map((action) => action.id), ['scan-schedule']);

  const started = await service.run({ task: '4242', action: 'scan-schedule', args: { project: '7' } });

  assert.equal(started.job.profile, 'demo-profile');

  const job = await settled(service, '4242');

  assert.equal(job.state, 'done');
});

test('кривой манифест не закрывает раздел: действий нет, причина — в журнале сервера', async (t) => {
  const { service, stateDir, profileDir, warnings } = await fixture(t);

  await registryEntry(stateDir, '990001');
  await writeFile(path.join(profileDir, 'actions.json'), '[{"id":"x"}]', 'utf8');

  const overview = await service.overview();

  assert.deepEqual(overview.sandboxes[0].actions, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0].reason, /манифеста/);
});

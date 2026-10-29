// Жизненный цикл ручной песочницы: подъём, слежение за прогрессом и снос.
//
// Подъём профиля закрыт fail-closed гардом (`FACTORY_WORKSPACE_MODE=isolated` и
// `FACTORY_REQUIRE_NEW_SANDBOX=1` ставит только движок), поэтому раздел обязан
// снимать его ЯВНО и только по действию человека. Стенд, которым владеет попытка
// конвейера, разделу не принадлежит вовсе.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createSandboxService } from '../../server/src/lib/sandboxes/service.ts';
import { writeSandboxJournalRecord } from '../../server/src/lib/sandboxes/registry.ts';
import { createSandboxActivityGuard } from '../../server/src/lib/sandboxes/activityGuard.ts';

const UP_STUB = `#!/usr/bin/env bash
set -euo pipefail
TASK=$1
: "\${STATE_DIR:?нет STATE_DIR}"
if [[ "\${FACTORY_WORKSPACE_MODE:-}" != isolated || "\${FACTORY_REQUIRE_NEW_SANDBOX:-}" != 1 ]]; then
  echo "ОШИБКА: dynamic up разрешён только isolated route engine" >&2
  exit 1
fi
mkdir -p "$STATE_DIR"
{
  echo "WORKSPACE_MODE=\${FACTORY_WORKSPACE_MODE}"
  echo "REQUIRE_NEW=\${FACTORY_REQUIRE_NEW_SANDBOX}"
  echo "SB_K=\${FACTORY_SB_K:-нет}"
  echo "STATE_DIR=\${STATE_DIR}"
} > "$STATE_DIR/t\${TASK}.upenv"
printf '10:00:00|0/11|старт (гарды пройдены)\\n' >> "$STATE_DIR/t\${TASK}.stage"
printf '10:00:01|4/11|клон db: данные\\n' >> "$STATE_DIR/t\${TASK}.stage"
cat > "$STATE_DIR/t\${TASK}.env" <<ENV
TASK=\${TASK}
SB_K=\${FACTORY_SB_K:-0}
API_PORT=8092
FE_PORT=5192
WORKSPACE_MODE=isolated
STAND_OWNERSHIP=task
REPO_COUNT=1
REPO_0_NAME=backend
REPO_0_SOURCE=/srv/source/backend
REPO_0_WT=/srv/worktrees/backend-t\${TASK}
REPO_0_BRANCH=route-task-\${TASK}
ENV
printf '10:00:02|DONE\\n' >> "$STATE_DIR/t\${TASK}.stage"
echo "стенд поднят"
`;

const DOWN_STUB = `#!/usr/bin/env bash
set -euo pipefail
TASK=$1
echo "worktree: \${FACTORY_DOWN_WORKTREE:-keep}" > "$STATE_DIR/t\${TASK}.downenv"
rm -f "$STATE_DIR/t\${TASK}.env"
echo "ВНИМАНИЕ: в worktree есть незакоммиченные изменения — worktree ОСТАВЛЕН"
`;

const WAITING_DOWN_STUB = `#!/usr/bin/env bash
set -euo pipefail
TASK=$1
echo ready > "$STATE_DIR/t\${TASK}.down-ready"
while [[ ! -f "$STATE_DIR/t\${TASK}.down-continue" ]]; do
  sleep 0.02
done
rm -f "$STATE_DIR/t\${TASK}.env"
`;

const FAILING_UP_STUB = `#!/usr/bin/env bash
echo "ОШИБКА: схема уже существует (недоснесённая песочница?)" >&2
exit 1
`;

const SLOTS_STUB = `#!/usr/bin/env bash
echo '{"range":[0,5],"used":[],"free":[0,1,2,3,4,5]}'
`;

async function script(file, body) {
  await writeFile(file, body, 'utf8');
  await chmod(file, 0o755);
}

/**
 * Стенд для службы: каталог состояния фабрики, журнал GrigDesk и профиль-двойник со
 * скриптами подъёма и сноса. Настоящих контейнеров и БД здесь нет — проверяется
 * ровно то, чем GrigDesk управляет сам: окружение запуска, журнал и реестр.
 */
async function serviceFixture(t, {
  up = UP_STUB,
  down = DOWN_STUB,
  withScripts = true,
  manualRange = { from: 990000, to: 990004 },
  probe = async () => false,
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-sandbox-life-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const stateDir = path.join(root, 'state');
  const journalDir = path.join(root, 'journal');
  const profilesDir = path.join(root, 'profiles');
  const factoryBin = path.join(root, 'factory');

  await mkdir(stateDir, { recursive: true });
  await mkdir(path.join(profilesDir, 'demo-profile'), { recursive: true });
  await mkdir(path.join(profilesDir, 'plain-profile'), { recursive: true });
  const graph = '{"capabilities":["route-v2"]}';

  await writeFile(path.join(profilesDir, 'demo-profile', 'graph.json'), graph, 'utf8');
  await writeFile(path.join(profilesDir, 'plain-profile', 'graph.json'), graph, 'utf8');
  await script(factoryBin, SLOTS_STUB);

  if (withScripts) {
    await script(path.join(profilesDir, 'demo-profile', 'up.sh'), up);
    await script(path.join(profilesDir, 'demo-profile', 'down.sh'), down);
  }

  const events = [];
  const service = createSandboxService({
    stateDir,
    journalDir,
    profilesDir,
    factoryBin,
    manualRange,
    sweepMs: 20,
    // Настоящих стендов в тесте нет, поэтому и портов быть не может: проба портов
    // подменена, иначе проверка ходила бы на живые сокеты машины.
    probe,
    broadcast: (event, data) => events.push([event, data]),
  });
  t.after(() => service.stop());

  return {
    root, stateDir, journalDir, profilesDir, factoryBin, service, events,
  };
}

/** Ждёт, пока задание перестанет быть running: подъём и снос — фоновые процессы. */
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

test('подъём без задачи берёт номер из служебного диапазона и снимает гард профиля', async (t) => {
  const { service, stateDir, profilesDir, events } = await serviceFixture(t);

  await writeFile(path.join(profilesDir, 'demo-profile', 'profile.sh'), 'PROFILE_SERVICE_HOST="localhost"\n');

  const started = await service.raise({ profile: 'demo-profile', task: null });

  assert.match(started.task, /^99000[0-4]$/);
  assert.equal(started.job.state, 'running');

  const job = await settled(service, started.task);

  assert.equal(job.state, 'done');
  assert.equal(job.action, 'up');

  const passed = await readFile(path.join(stateDir, `t${started.task}.upenv`), 'utf8');

  assert.match(passed, /WORKSPACE_MODE=isolated/);
  assert.match(passed, /REQUIRE_NEW=1/);
  assert.match(passed, /SB_K=0/);
  assert.match(passed, new RegExp(`STATE_DIR=${stateDir}`));

  const overview = await service.overview();
  const entry = overview.sandboxes.find((item) => item.task === started.task);

  assert.equal(entry.owner, 'manual');
  assert.equal(entry.profile, 'demo-profile');
  assert.equal(entry.fePort, 5192);
  assert.equal(entry.apiPort, 8092);
  assert.equal(entry.serviceHost, 'localhost');
  assert.equal(entry.feAlive, false);
  assert.equal(entry.profileBinding, 'verified');
  assert.deepEqual(entry.repos.map((repo) => repo.branch), [`route-task-${started.task}`]);
  assert.ok(events.some(([name]) => name === 'sandboxes-changed'));
});

test('обзор отделяет живость FE от ответа API-порта', async (t) => {
  const { service, stateDir } = await serviceFixture(t, {
    probe: async (port) => port === 8092,
  });

  await writeFile(path.join(stateDir, 't990000.env'), [
    'TASK=990000',
    'SB_K=2',
    'API_PORT=8092',
    'FE_PORT=5192',
    'WORKSPACE_MODE=isolated',
    'STAND_OWNERSHIP=task',
    '',
  ].join('\n'), 'utf8');

  const overview = await service.overview();
  const entry = overview.sandboxes.find((item) => item.task === '990000');

  assert.equal(entry.standAlive, true);
  assert.equal(entry.feAlive, false);
  assert.equal(entry.profile, 'demo-profile');
  assert.equal(entry.profileBinding, 'inferred');
});

test('старый успешный up не доказывает профиль нового поколения стенда', async (t) => {
  const { service, stateDir, journalDir } = await serviceFixture(t);

  await writeSandboxJournalRecord(journalDir, {
    task: '990001',
    profile: 'demo-profile',
    action: 'up',
    state: 'done',
    index: 11,
    total: 11,
    label: 'готово',
    message: '',
    pid: null,
    starttime: null,
    cmdline: null,
    log: path.join(journalDir, 't990001.up.log'),
    startedAt: '2026-01-01T10:00:00.000Z',
    finishedAt: '2026-01-01T10:10:00.000Z',
  });
  await writeFile(path.join(stateDir, 't990001.env'), [
    'TASK=990001',
    'API_PORT=8092',
    'FE_PORT=5192',
    'WORKSPACE_MODE=isolated',
    'STAND_OWNERSHIP=task',
    '',
  ].join('\n'), 'utf8');

  const overview = await service.overview();
  const entry = overview.sandboxes.find((item) => item.task === '990001');

  assert.equal(entry.profile, 'demo-profile');
  assert.equal(entry.profileBinding, 'inferred');
});

test('номер занятой задачи и повторный подъём того же стенда отклоняются', async (t) => {
  const { service } = await serviceFixture(t);

  const started = await service.raise({ profile: 'demo-profile', task: '990000' });
  await settled(service, started.task);

  await assert.rejects(
    () => service.raise({ profile: 'demo-profile', task: '990000' }),
    (error) => error.code === 'sandbox_exists' && error.status === 409,
  );
});

test('стенд конвейера разделу не принадлежит: ни подъём, ни снос', async (t) => {
  const { service, stateDir } = await serviceFixture(t);

  await writeFile(path.join(stateDir, 't4242.env'), 'TASK=4242\nWORKSPACE_MODE=isolated\n', 'utf8');
  await writeFile(path.join(stateDir, 't4242.pipeline'), 'ROUTE=feature\nATTEMPT_ID=a_1\n', 'utf8');

  await assert.rejects(
    () => service.raise({ profile: 'demo-profile', task: '4242' }),
    (error) => error.code === 'pipeline_owned' && error.status === 409,
  );
  await assert.rejects(
    () => service.dismantle({ task: '4242' }),
    (error) => error.code === 'pipeline_owned' && error.status === 409,
  );

  const overview = await service.overview();
  const entry = overview.sandboxes.find((item) => item.task === '4242');

  assert.equal(entry.owner, 'pipeline');
  assert.equal(entry.removable, false);
  assert.equal(entry.removableReason, 'pipeline_owned');
});

test('снос зовёт down.sh профиля, бережёт незакоммиченное и снимает резервацию слота', async (t) => {
  const { service, stateDir } = await serviceFixture(t);

  const started = await service.raise({ profile: 'demo-profile', task: '990001' });
  await settled(service, started.task);

  const removal = await service.dismantle({ task: '990001' });

  assert.equal(removal.job.action, 'down');

  const job = await settled(service, '990001');

  assert.equal(job.state, 'done');
  assert.match(job.message, /worktree ОСТАВЛЕН/);
  assert.equal(await readFile(path.join(stateDir, 't990001.downenv'), 'utf8'), 'worktree: keep\n');
  await assert.rejects(() => stat(path.join(stateDir, 'slots', 't990001.json')));

  const overview = await service.overview();

  assert.equal(overview.sandboxes.some((item) => item.task === '990001'), false);
});

test('Showcase и lifecycle атомарно делят аренду стенда между процессами', async (t) => {
  const { service, stateDir } = await serviceFixture(t, { down: WAITING_DOWN_STUB });
  const guard = createSandboxActivityGuard({ stateDir, timeoutMs: 10 });
  const started = await service.raise({ profile: 'demo-profile', task: '990003' });

  await settled(service, started.task);

  const showcase = await guard.acquireShowcase(started.task);

  await assert.rejects(
    () => service.dismantle({ task: started.task }),
    (error) => error.code === 'sandbox_busy' && error.status === 409,
  );
  await showcase.release();

  await service.dismantle({ task: started.task });

  await assert.rejects(
    () => guard.acquireShowcase(started.task),
    (error) => error.code === 'SANDBOX_ACTIVITY_BUSY',
  );

  await writeFile(path.join(stateDir, `t${started.task}.down-continue`), '', 'utf8');
  await settled(service, started.task);

  const after = await guard.acquireShowcase(started.task);

  await after.release();
});

test('снос с явным «вместе с незакоммиченным» передаёт профилю force', async (t) => {
  const { service, stateDir } = await serviceFixture(t);

  const started = await service.raise({ profile: 'demo-profile', task: '990002' });
  await settled(service, started.task);
  await service.dismantle({ task: '990002', force: true });
  await settled(service, '990002');

  assert.equal(await readFile(path.join(stateDir, 't990002.downenv'), 'utf8'), 'worktree: force\n');
});

test('профиль без скриптов песочницы не предлагается и не поднимается', async (t) => {
  const { service } = await serviceFixture(t, { withScripts: false });

  const overview = await service.overview();
  const demo = overview.profiles.find((item) => item.id === 'demo-profile');

  assert.equal(demo.canRaise, false);
  assert.match(demo.reason, /up\.sh/);

  await assert.rejects(
    () => service.raise({ profile: 'demo-profile', task: null }),
    (error) => error.code === 'sandbox_unsupported' && error.status === 409,
  );
  await assert.rejects(
    () => service.raise({ profile: 'ghost-profile', task: null }),
    (error) => error.code === 'profile_unknown' && error.status === 404,
  );
  await assert.rejects(
    () => service.raise({ profile: '../../etc', task: null }),
    (error) => error.code === 'bad_profile' && error.status === 400,
  );
});

test('упавший подъём остаётся видимым отказом с хвостом вывода', async (t) => {
  const { service } = await serviceFixture(t, { up: FAILING_UP_STUB });

  const started = await service.raise({ profile: 'demo-profile', task: '990003' });
  const job = await settled(service, started.task);

  assert.equal(job.state, 'failed');
  assert.match(job.message, /недоснесённая песочница/);

  const overview = await service.overview();

  assert.equal(overview.sandboxes.some((item) => item.task === '990003'), false);
});

test('свободных служебных номеров нет — отказ вместо занятия чужого стенда', async (t) => {
  const { service, stateDir } = await serviceFixture(t, { manualRange: { from: 990000, to: 990001 } });

  await writeFile(path.join(stateDir, 't990000.env'), 'TASK=990000\nWORKSPACE_MODE=isolated\n', 'utf8');
  await writeFile(path.join(stateDir, 't990001.env'), 'TASK=990001\nWORKSPACE_MODE=isolated\n', 'utf8');

  await assert.rejects(
    () => service.raise({ profile: 'demo-profile', task: null }),
    (error) => error.code === 'no_free_task' && error.status === 409,
  );
});

// Подъём идёт минутами и запускается отдельным процессом, поэтому перезапуск сервера
// не должен ни убивать его, ни оставлять в журнале вечное «идёт подъём».
test('после перезапуска служба доводит журнал до правды об исчезнувшем процессе', async (t) => {
  const { service, journalDir } = await serviceFixture(t);

  await mkdir(journalDir, { recursive: true });
  await writeFile(path.join(journalDir, 't990004.json'), JSON.stringify({
    task: '990004',
    profile: 'demo-profile',
    action: 'up',
    state: 'running',
    index: 3,
    total: 11,
    label: 'клон db',
    message: '',
    pid: 2147483646,
    starttime: '999999999',
    cmdline: 'bash up.sh 990004',
    log: path.join(journalDir, 't990004.log'),
    startedAt: '2026-09-07T10:00:00.000Z',
    finishedAt: null,
  }), 'utf8');

  await service.resume();

  const overview = await service.overview();
  const job = overview.jobs.find((item) => item.task === '990004');

  assert.equal(job.state, 'failed');
  assert.equal(job.state, 'failed');
});

// Журнал GrigDesk — история запусков и не чистится, но обзор не обязан возить её всю:
// показывать нужно задания живых стендов, незавершённые и свежие.
test('обзор не возит задания давно снесённых стендов', async (t) => {
  const { service, journalDir } = await serviceFixture(t);
  const old = {
    task: '990003',
    profile: 'demo-profile',
    action: 'down',
    state: 'done',
    index: 0,
    total: 0,
    label: 'снос стенда',
    message: 'стенд снесён',
    pid: null,
    starttime: null,
    cmdline: null,
    log: path.join(journalDir, 't990003.down.log'),
    startedAt: '2020-01-01T10:00:00.000Z',
    finishedAt: '2020-01-01T10:05:00.000Z',
  };

  await mkdir(journalDir, { recursive: true });
  await writeFile(path.join(journalDir, 't990003.json'), JSON.stringify(old), 'utf8');

  const started = await service.raise({ profile: 'demo-profile', task: '990002' });
  await settled(service, started.task);

  const overview = await service.overview();

  assert.deepEqual(overview.jobs.map((job) => job.task), ['990002']);
});

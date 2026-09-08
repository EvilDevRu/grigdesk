// Реестр песочниц глазами кокпита: t<номер>.env фабрики + собственный журнал подъёмов.
// Раздел «Песочницы» не имеет своего источника правды о стендах: он читает тот же
// каталог состояния, в который пишет подъём профиля, и отделяет стенд конвейера
// (есть t<номер>.pipeline) от поднятого руками.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  readSandboxJournal,
  readSandboxRegistry,
  readSandboxStage,
  writeSandboxJournalRecord,
} from '../../server/src/lib/sandboxes/registry.ts';

async function stateFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-sandboxes-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const stateDir = path.join(root, 'state');
  const journalDir = path.join(root, 'journal');
  await mkdir(stateDir, { recursive: true });

  return { root, stateDir, journalDir };
}

function envText(task, extra = {}) {
  const base = {
    TASK: String(task),
    SB_K: '2',
    API_PORT: '8092',
    FE_PORT: '5192',
    WORKSPACE_MODE: 'isolated',
    STAND_OWNERSHIP: 'task',
    REPO_COUNT: '1',
    REPO_0_NAME: 'backend',
    REPO_0_SOURCE: '/srv/source/backend',
    REPO_0_WT: `/srv/worktrees/backend-t${task}`,
    REPO_0_BRANCH: `route-task-${task}`,
    ...extra,
  };

  return `${Object.entries(base).map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
}

test('реестр читает поднятые стенды и отделяет стенд конвейера от ручного', async (t) => {
  const { stateDir } = await stateFixture(t);

  await writeFile(path.join(stateDir, 't990001.env'), envText(990001), 'utf8');
  await writeFile(path.join(stateDir, 't4242.env'), envText(4242, { SB_K: '0' }), 'utf8');
  await writeFile(path.join(stateDir, 't4242.pipeline'), 'ROUTE=feature\n', 'utf8');

  const entries = await readSandboxRegistry(stateDir);
  const byTask = new Map(entries.map((entry) => [entry.task, entry]));

  assert.deepEqual(entries.map((entry) => entry.task), ['4242', '990001']);
  assert.equal(byTask.get('4242').pipeline, true);
  assert.equal(byTask.get('990001').pipeline, false);
  assert.equal(byTask.get('990001').slot, 2);
  assert.equal(byTask.get('990001').fePort, 5192);
  assert.equal(byTask.get('990001').apiPort, 8092);
  assert.equal(byTask.get('990001').workspaceMode, 'isolated');
  assert.deepEqual(byTask.get('990001').repos, [{
    name: 'backend',
    path: '/srv/worktrees/backend-t990001',
    branch: 'route-task-990001',
  }]);
});

// Профиль движка кладёт ссылку на реестр ДО подъёма, и все минуты провижининга она
// висит битой. Обрыв чтения на такой ссылке уже ронял status.sh, поэтому реестр
// кокпита обязан её просто пропускать.
test('битая ссылка и мусорный env не роняют чтение реестра', async (t) => {
  const { stateDir, journalDir } = await stateFixture(t);

  await writeFile(path.join(stateDir, 't990002.env'), envText(990002), 'utf8');
  await symlink(path.join(stateDir, 'nowhere.env'), path.join(stateDir, 't990003.env'));
  await writeFile(path.join(stateDir, 't990004.env'), 'сломанный файл без ключей\n', 'utf8');
  await writeFile(path.join(stateDir, 'notes.txt'), 'посторонний файл\n', 'utf8');

  const entries = await readSandboxRegistry(stateDir);

  assert.deepEqual(entries.map((entry) => entry.task), ['990002']);
  assert.equal(await readSandboxJournal(journalDir).then((items) => items.length), 0);
});

test('прогресс подъёма читается по последней строке журнала этапов', async (t) => {
  const { stateDir } = await stateFixture(t);

  await writeFile(
    path.join(stateDir, 't990005.stage'),
    '10:00:00|0/11|старт (гарды пройдены)\n10:04:00|4/11|клон db: данные\n',
    'utf8',
  );
  await writeFile(path.join(stateDir, 't990006.stage'), '10:00:00|1/11|worktree\n10:20:00|DONE\n', 'utf8');
  await writeFile(
    path.join(stateDir, 't990007.stage'),
    '10:00:00|1/11|worktree\n10:02:00|FAILED|подъём упал (код 1)\n',
    'utf8',
  );

  const running = await readSandboxStage(stateDir, '990005');
  const done = await readSandboxStage(stateDir, '990006');
  const failed = await readSandboxStage(stateDir, '990007');

  assert.deepEqual(running, { state: 'running', at: '10:04:00', index: 4, total: 11, label: 'клон db: данные' });
  assert.equal(done.state, 'done');
  assert.equal(failed.state, 'failed');
  assert.equal(failed.label, 'подъём упал (код 1)');
  assert.equal(await readSandboxStage(stateDir, '990008'), null);
});

test('журнал кокпита переживает перезапись и отбрасывает повреждённую запись', async (t) => {
  const { journalDir } = await stateFixture(t);
  const record = {
    task: '990009',
    profile: 'demo-profile',
    action: 'up',
    state: 'running',
    index: 0,
    total: 11,
    label: 'старт',
    message: '',
    pid: 4242,
    starttime: '123456',
    cmdline: 'bash /profiles/demo/up.sh 990009',
    log: path.join(journalDir, 't990009.log'),
    startedAt: '2026-09-07T10:00:00.000Z',
    finishedAt: null,
  };

  await writeSandboxJournalRecord(journalDir, record);
  await writeSandboxJournalRecord(journalDir, { ...record, state: 'done', finishedAt: '2026-09-07T10:15:00.000Z' });
  await writeFile(path.join(journalDir, 't990010.json'), '{ не json', 'utf8');

  const journal = await readSandboxJournal(journalDir);

  assert.equal(journal.length, 1);
  assert.equal(journal[0].task, '990009');
  assert.equal(journal[0].state, 'done');
  assert.equal(journal[0].finishedAt, '2026-09-07T10:15:00.000Z');
});

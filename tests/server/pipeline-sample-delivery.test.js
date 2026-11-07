import assert from 'node:assert/strict';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { TASK, ATTEMPT, fixture, saveProject, hook, context, put, run, ok }
  from '../fixtures/pipelineSample.mjs';

const ACTIONS = {
  commit: ['commit'],
  merge: ['commit', 'merge'],
  'pull-request': ['commit', 'push', 'pull-request'],
};

/**
 * Создаёт локальную Git-копию и bare remote, никогда не обращаясь в сеть.
 * Контекст ограничивает сдачу одним явно названным путём из принятой задачи.
 */
async function delivery(t, strategy) {
  const f = await fixture(t);
  const remote = path.join(f.root, 'remote.git');

  ok(run('git', ['init', '--bare', '-q', remote]));
  ok(run('git', ['-C', f.source, 'remote', 'add', 'origin', remote]));
  ok(run('git', ['-C', f.source, 'push', '-q', 'origin', 'main']));
  f.project.delivery.strategy = strategy;
  await saveProject(f);
  ok(run('bash', [path.join(f.profile, 'up.sh'), TASK], { env: f.env }));

  const workspace = ok(hook(f, 'profile_repositories', [TASK])).split('\n')[0].split('\t')[2];
  const value = await context(f, 'small', workspace);

  value.delivery.strategy = strategy;
  value.delivery.actions = ACTIONS[strategy];
  value.stage = { id: 'ship', runKey: 'SHIP' };

  const attemptDir = path.join(f.control, 'protocol-v2/tasks', `t${TASK}`, 'attempts', ATTEMPT);
  const pin = await put(attemptDir, 'artifacts/delivery.tsv', [
    `strategy\t${strategy}`,
    ...ACTIONS[strategy].map((action) => `action\t${action}`),
    'target\tapp=main',
  ].sort().join('\n') + '\n');

  await chmod(pin, 0o400);
  f.env.ROUTE_V2_ATTEMPT_DIR = attemptDir;
  await put(workspace, 'app.mjs', 'export const answer = 43;\n');
  await put(workspace, 'foreign.txt', 'Чужая правка не входит в named paths\n');

  const file = await put(f.root, 'context.json', JSON.stringify(value));
  const deliver = () => run('python3', [path.join(f.profile, 'deliver.py'), '--context', file,
    '--path', 'app:app.mjs'], { env: f.env, cwd: f.root });

  return {
    f,
    workspace,
    remote,
    value,
    file,
    deliver,
  };
}

test('SAMPLE-SHIP-01: commit makes only local commit and is idempotent', async (t) => {
  const { f, workspace, remote, deliver } = await delivery(t, 'commit');
  const beforeSource = ok(run('git', ['-C', f.source, 'rev-parse', 'HEAD']));
  const beforeRemote = ok(run('git', ['--git-dir', remote, 'show-ref']));

  ok(deliver());

  const result = ok(run('git', ['-C', workspace, 'rev-parse', 'HEAD']));

  assert.notEqual(result, beforeSource);
  assert.equal(ok(run('git', ['-C', f.source, 'rev-parse', 'HEAD'])), beforeSource);
  assert.equal(ok(run('git', ['--git-dir', remote, 'show-ref'])), beforeRemote);
  assert.equal(ok(run('git', ['-C', workspace, 'show', '--format=', '--name-only', 'HEAD'])), 'app.mjs');
  assert.match(ok(run('git', ['-C', workspace, 'status', '--porcelain'])), /\?\? foreign\.txt/);
  await assert.rejects(readFile(path.join(f.root, 'pr.calls')), { code: 'ENOENT' });
  ok(deliver());
  assert.equal(ok(run('git', ['-C', workspace, 'rev-parse', 'HEAD'])), result);

  const report = await readFile(path.join(f.state, `t${TASK}.ship.md`), 'utf8');

  assert.ok(report.includes(result));
  assert.ok(report.includes(workspace));
});

test('SAMPLE-SHIP-02: merge makes no push or PR', async (t) => {
  const { f, workspace, remote, deliver } = await delivery(t, 'merge');
  const beforeRemote = ok(run('git', ['--git-dir', remote, 'show-ref']));

  ok(deliver());

  assert.equal(ok(run('git', ['-C', f.source, 'branch', '--show-current'])), 'main');
  assert.equal(ok(run('git', ['-C', f.source, 'rev-parse', 'HEAD'])),
    ok(run('git', ['-C', workspace, 'rev-parse', 'HEAD'])));
  assert.equal(ok(run('git', ['-C', f.source, 'status', '--porcelain'])), '');
  assert.equal(ok(run('git', ['--git-dir', remote, 'show-ref'])), beforeRemote);
  await assert.rejects(readFile(path.join(f.root, 'pr.calls')), { code: 'ENOENT' });
});

test('SAMPLE-SHIP-03: pull-request pushes and requests PR once', async (t) => {
  const { f, workspace, remote, deliver } = await delivery(t, 'pull-request');

  ok(deliver());

  const result = ok(run('git', ['-C', workspace, 'rev-parse', 'HEAD']));

  assert.equal(ok(run('git', ['--git-dir', remote, 'rev-parse', `refs/heads/task-${TASK}`])), result);
  assert.equal(await readFile(path.join(f.root, 'pr.calls'), 'utf8'), 'PR\n');
  ok(deliver());
  assert.equal(await readFile(path.join(f.root, 'pr.calls'), 'utf8'), 'PR\n');
});

test('SAMPLE-SHIP-04: unapproved/dirty foreign target makes no delivery changes', async (t) => {
  const { f, workspace, remote, value, file, deliver } = await delivery(t, 'merge');
  const original = structuredClone(value);
  const before = ok(run('git', ['-C', workspace, 'rev-parse', 'HEAD']));
  const beforeRemote = ok(run('git', ['--git-dir', remote, 'show-ref']));
  const mutations = [
    (v) => {
      v.decisions.acceptance.status = 'pending';
    },
    (v) => {
      v.delivery.actions.push('push');
    },
    (v) => {
      v.delivery.targetBranches.unknown = 'main';
    },
    (v) => {
      v.delivery.strategy = 'unknown';
    },
  ];

  for (const mutate of mutations) {
    const invalid = structuredClone(original);

    mutate(invalid);
    await writeFile(file, JSON.stringify(invalid));
    assert.notEqual(deliver().status, 0);
    assert.equal(ok(run('git', ['-C', workspace, 'rev-parse', 'HEAD'])), before);
    assert.equal(ok(run('git', ['--git-dir', remote, 'show-ref'])), beforeRemote);
  }

  await writeFile(file, JSON.stringify(original));
  await put(f.source, 'owner.txt', 'Работа владельца\n');
  assert.notEqual(deliver().status, 0);
  assert.equal(ok(run('git', ['-C', workspace, 'rev-parse', 'HEAD'])), before);
  assert.equal(await readFile(path.join(f.source, 'owner.txt'), 'utf8'), 'Работа владельца\n');
});

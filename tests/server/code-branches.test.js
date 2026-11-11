import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import test from 'node:test';

import { shellQuote } from '../../shared/lib/shellQuote.ts';
import {
  DEFAULT_CODE_BRANCH_SETTINGS, parseCodeBranchOverview,
} from '../../shared/plugins/code/codeBranchContracts.ts';
import { CodeBranchRuns } from '../../server/src/lib/codeBranchRuns.ts';
import { git, reviewFixture, success } from './code-review-fixture.js';

/**
 * Команды-двойники пишут только во внешний trace: настоящих сборок и стендов нет.
 * Две ветки меняют один файл, поэтому тест доказывает реальное переключение checkout.
 */
async function fixture(t, options = {}) {
  const item = await reviewFixture(t, { branchRuntime: true, ...options });

  await git(item.root, ['branch', '-m', 'dev']);
  await git(item.root, ['switch', '-qc', 'feature/demo']);
  await item.write('app.txt', 'feature\n');
  await git(item.root, ['commit', '-qam', 'Функция']);
  await git(item.root, ['switch', '-q', 'dev']);

  const trace = path.join(item.temp, 'trace');
  const settings = { ...DEFAULT_CODE_BRANCH_SETTINGS };

  for (const step of ['stop', 'prepare', 'build', 'start', 'check']) {
    settings[step] = `printf '%s\\n' ${shellQuote(step)} >> ${shellQuote(trace)}`;
  }

  const overview = async () => parseCodeBranchOverview(success(await item.request('branches'), 'ветки'));
  const run = async (ref = 'refs/heads/feature/demo', extra = {}) => {
    const state = await overview();

    return item.request('switch-branch', {
      ref,
      confirmed: true,
      expectedCommit: state.branches.find((branch) => branch.ref === ref)?.commit || '',
      expectedHead: state.actualCommit,
      ...extra,
    });
  };
  /**
   * Ожидает устойчивый итог worker-а, а не угадывает время его выполнения.
   * Короткий предел относится только к локальным командам-двойникам.
   */
  const wait = async () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const state = await overview();

      if (state.job && state.job.status !== 'running' && !await item.app.codeBranchBusy(item.root)) {
        return state;
      }

      await pause(25);
    }

    throw new Error('Worker не завершил команды-двойники за 5 секунд');
  };

  success(await item.request('branch-settings', settings), 'настройки');

  return {
    ...item,
    settings,
    trace,
    overview,
    run,
    wait,
  };
}

test('CODE-BRANCH-RUNTIME: переключает основную папку и возвращает dev по тем же этапам', async (t) => {
  const item = await fixture(t);

  success(await item.run(), 'запуск');

  const result = await item.wait();

  assert.equal(result.job.status, 'succeeded', result.log);
  assert.equal(result.actualBranch, 'feature/demo');
  assert.equal(result.actualCommit, result.job.commit);
  assert.equal(await readFile(path.join(item.root, 'app.txt'), 'utf8'), 'feature\n');
  assert.equal(await readFile(item.trace, 'utf8'), 'stop\nprepare\nbuild\nstart\ncheck\n');

  success(await item.run('refs/heads/dev'), 'возврат');

  const returned = await item.wait();

  assert.equal(returned.actualBranch, 'dev');
  assert.equal(returned.job.status, 'succeeded');
  assert.equal(await readFile(path.join(item.root, 'app.txt'), 'utf8'), 'a\nb\nc\nd\n');
});

test('CODE-BRANCH-REMOTE: различает remotes, исключает HEAD, создаёт tracking-ветку', async (t) => {
  const item = await fixture(t);
  const feature = (await git(item.root, ['rev-parse', 'feature/demo'])).trim();

  await git(item.root, ['update-ref', 'refs/remotes/team/topic/demo', feature]);
  await git(item.root, ['symbolic-ref', 'refs/remotes/team/HEAD', 'refs/remotes/team/topic/demo']);
  await git(item.root, ['config', 'remote.team.url', path.join(item.temp, 'unused')]);
  await git(item.root, ['config', 'remote.team.fetch', '+refs/heads/*:refs/remotes/team/*']);

  const state = await item.overview();

  assert.equal(state.branches.some((branch) => branch.name === 'team/HEAD'), false);
  assert.equal(state.branches.find((branch) => branch.name === 'team/topic/demo').kind, 'remote');
  success(await item.run('refs/remotes/team/topic/demo'), 'удалённая ветка');

  const result = await item.wait();

  assert.equal(result.job.status, 'succeeded', result.log);
  assert.equal(result.actualBranch, 'topic/demo');
  assert.equal((await git(item.root, ['config', 'branch.topic/demo.remote'])).trim(), 'team');
});

test('CODE-BRANCH-DIRTY: индекс, локальные и новые файлы запрещают остановку стенда', async (t) => {
  for (const kind of ['work', 'staged', 'untracked']) {
    await t.test(kind, async (subtest) => {
      const item = await fixture(subtest);
      const file = kind === 'untracked' ? 'new.txt' : 'app.txt';

      await item.write(file, 'unsaved\n');

      if (kind === 'staged') {
        await git(item.root, ['add', file]);
      }

      const before = await git(item.root, ['rev-parse', 'HEAD']);
      const response = await item.run();

      assert.equal(response.statusCode, 409, response.body);
      assert.equal(response.json().error, 'branch_switch_refused');
      assert.equal(await git(item.root, ['rev-parse', 'HEAD']), before);
      assert.equal(await readFile(path.join(item.root, file), 'utf8'), 'unsaved\n');
      await assert.rejects(readFile(item.trace), { code: 'ENOENT' });
    });
  }
});

test('CODE-BRANCH-OCCUPIED: занятая worktree ветка и remote с коллизией отклоняются заранее', async (t) => {
  const item = await fixture(t);

  await git(item.root, ['worktree', 'add', '-q', path.join(item.temp, 'other'), 'feature/demo']);

  const occupied = await item.run();

  assert.equal(occupied.statusCode, 409);
  await git(item.root, ['update-ref', 'refs/remotes/team/dev', 'HEAD']);

  const collision = await item.run('refs/remotes/team/dev');

  assert.equal(collision.statusCode, 409);
  await assert.rejects(readFile(item.trace), { code: 'ENOENT' });
});

test('CODE-BRANCH-AGENTS: агент в папке не даёт остановить стенд', async (t) => {
  const item = await fixture(t, { agentsBusy: async () => true });
  const response = await item.run();

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error, 'agents_busy');
  await assert.rejects(readFile(item.trace), { code: 'ENOENT' });
});

test('CODE-BRANCH-FAIL: неудачная сборка останавливает последовательность до start/check', async (t) => {
  const item = await fixture(t);

  success(await item.request('branch-settings', { ...item.settings, build: 'exit 17' }), 'настройки');
  success(await item.run(), 'запуск');

  const state = await item.wait();

  assert.equal(state.job.status, 'failed');
  assert.equal(state.job.step, 'build');
  assert.equal(state.actualBranch, 'feature/demo');
  assert.equal(await readFile(item.trace, 'utf8'), 'stop\nprepare\n');
  assert.match(state.log, /17/);
});

test('CODE-BRANCH-STALE: подтверждение относится к показанным target и HEAD', async (t) => {
  const item = await fixture(t);
  const response = await item.run('refs/heads/feature/demo', { expectedCommit: '0'.repeat(40) });

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error, 'branch_changed');
  await assert.rejects(readFile(item.trace), { code: 'ENOENT' });
});

test('CODE-BRANCH-LOCK: worker исключает второй запуск и обычные мутации Git', async (t) => {
  const item = await fixture(t);
  const hold = path.join(item.temp, 'hold');

  await writeFile(hold, 'held');
  success(await item.request('branch-settings', {
    ...item.settings, build: `while test -e ${shellQuote(hold)}; do sleep 0.05; done`,
  }), 'настройки');
  success(await item.run(), 'первый запуск');

  try {
    assert.equal((await item.run()).statusCode, 409);
    assert.equal((await item.request('fetch', {})).statusCode, 409);
    assert.equal(await item.app.codeBranchBusy(item.root), true);

    const recovered = new CodeBranchRuns(path.join(item.temp, 'state'));

    assert.equal(await recovered.busy(item.root), true);
    assert.equal((await recovered.overview(item.root)).job.status, 'running');
  } finally {
    await import('node:fs/promises').then((fs) => fs.unlink(hold));
  }

  assert.equal((await item.wait()).job.status, 'succeeded');
});

test('CODE-BRANCH-CHECK: отказ готовности не сообщает об успешном запуске', async (t) => {
  const item = await fixture(t);

  success(await item.request('branch-settings', {
    ...item.settings,
    check: 'exit 23',
    url: 'http://127.0.0.1:3000',
  }), 'настройки');
  success(await item.run(), 'запуск');

  const state = await item.wait();

  assert.equal(state.job.status, 'failed');
  assert.equal(state.job.step, 'check');
  assert.match(state.log, /23/);
});

test('CODE-BRANCH-HEAD-CHANGED: изменившая Git сборка не допускает start', async (t) => {
  const item = await fixture(t);

  success(await item.request('branch-settings', {
    ...item.settings,
    build: 'git switch --quiet dev',
  }), 'настройки');
  success(await item.run(), 'запуск');

  const state = await item.wait();

  assert.equal(state.job.status, 'failed');
  assert.equal(state.actualBranch, 'dev');
  assert.equal(await readFile(item.trace, 'utf8'), 'stop\nprepare\n');
});

test('CODE-BRANCH-SETTINGS-VALIDATION: схема и безопасный адрес проверяются до сохранения', async (t) => {
  const item = await fixture(t);

  for (const settings of [{ build: 'true' }, { ...item.settings, url: 'javascript:alert(1)' }]) {
    const response = await item.request('branch-settings', settings);

    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error, 'bad_branch_settings');
  }

  assert.deepEqual((await item.overview()).settings, item.settings);
});

test('CODE-BRANCH-GATE: сессия, основная папка, подтверждение и включённый плагин обязательны', async (t) => {
  const item = await fixture(t);
  const remote = await item.app.inject({
    method: 'GET',
    url: '/api/code/demo/branches?repo=main',
    headers: { 'x-test-auth': 'cli' },
  });

  assert.equal(remote.statusCode, 403);
  assert.equal(remote.json().error, 'session_required');
  assert.equal((await item.request('switch-branch', { ref: 'refs/heads/feature/demo' })).statusCode, 400);
  await git(item.root, ['worktree', 'add', '-q', path.join(item.temp, 'other'), 'feature/demo']);

  const other = await item.request('branches', undefined, { root: path.join(item.temp, 'other') });

  assert.equal(other.statusCode, 409);
  assert.equal(other.json().error, 'main_checkout_required');
  item.disable();
  assert.equal((await item.request('branches')).statusCode, 403);
});

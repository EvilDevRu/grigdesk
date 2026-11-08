import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { parseCodePullResponse } from '../../shared/plugins/code/codeContracts.ts';
import { git, reviewFixture } from './code-review-fixture.js';

/**
 * Настоящий локальный remote отстаёт от второй копии на один коммит.
 * Имена remote и upstream отличаются от origin/main, чтобы проверить выбор именно связи ветки.
 */
async function pullFixture(t) {
  const fixture = await reviewFixture(t);
  const remote = path.join(fixture.temp, 'remote');
  const other = path.join(fixture.temp, 'other');

  await mkdir(remote);
  await git(remote, ['init', '--bare', '-q']);
  await git(fixture.root, ['remote', 'add', 'team', remote]);
  await git(fixture.root, ['push', '-qu', 'team', 'HEAD:refs/heads/release/test']);
  await git(fixture.root, ['clone', '-q', '-b', 'release/test', remote, other]);
  await git(other, ['config', 'user.email', 'test@example.com']);
  await git(other, ['config', 'user.name', 'test']);
  await writeFile(path.join(other, 'app.txt'), 'remote change\n');
  await git(other, ['commit', '-qam', 'Удалённое изменение']);
  await git(other, ['push', '-q']);

  return {
    ...fixture,
    remote,
    other,
  };
}

test('CODE-PULL-FF: получает upstream в файлы и HEAD, независимо от rebase-настроек', async (t) => {
  const fixture = await pullFixture(t);
  const { root, other, request } = fixture;

  await git(root, ['config', 'pull.rebase', 'true']);
  await git(root, ['config', 'merge.ff', 'false']);
  await git(root, ['config', 'merge.autoStash', 'true']);
  await git(root, ['config', 'branch.main.mergeOptions', '--squash']);

  const response = await request('pull', {});

  assert.equal(response.statusCode, 200, response.body);

  const result = parseCodePullResponse(response.json());

  assert.equal(result.branch, 'main');
  assert.equal(result.updated, true);
  assert.equal(result.tracking.upstream, 'team/release/test');
  assert.equal(result.tracking.behind, 0);
  assert.equal(result.tracking.ahead, 0);
  assert.equal(await git(root, ['rev-parse', 'HEAD']), await git(other, ['rev-parse', 'HEAD']));
  assert.equal(await readFile(path.join(root, 'app.txt'), 'utf8'), 'remote change\n');
  assert.equal((await git(root, ['rev-list', '--count', 'HEAD'])).trim(), '2');
  assert.equal(await git(root, ['status', '--porcelain']), '');

  const repeated = await request('pull', {});

  assert.equal(repeated.statusCode, 200, repeated.body);
  assert.equal(parseCodePullResponse(repeated.json()).updated, false);
});

test('CODE-PULL-DIVERGED: отказ сохраняет локальный коммит, индекс и файлы', async (t) => {
  const { root, write, request } = await pullFixture(t);

  await write('app.txt', 'local change\n');
  await git(root, ['commit', '-qam', 'Локальное изменение']);

  const before = await git(root, ['rev-parse', 'HEAD']);
  const index = await git(root, ['write-tree']);
  const response = await request('pull', {});

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error, 'pull_diverged');
  assert.match(response.json().message, /Fast-forward/);
  assert.equal(await git(root, ['rev-parse', 'HEAD']), before);
  assert.equal(await git(root, ['write-tree']), index);
  assert.equal(await readFile(path.join(root, 'app.txt'), 'utf8'), 'local change\n');
  assert.equal(await git(root, ['status', '--porcelain']), '');
  assert.equal(await git(root, ['stash', 'list']), '');
});

test('CODE-PULL-DIRTY: staged, рабочие и новые файлы сохраняются без autostash', async (t) => {
  for (const kind of ['work', 'staged', 'untracked']) {
    await t.test(kind, async (subtest) => {
      const { root, write, request } = await pullFixture(subtest);
      const file = kind === 'untracked' ? 'new.txt' : 'app.txt';

      await git(root, ['config', 'merge.autoStash', 'true']);
      await write(file, 'local edits\n');

      if (kind === 'staged') {
        await git(root, ['add', file]);
      }

      const before = await git(root, ['rev-parse', 'HEAD']);
      const index = await git(root, ['write-tree']);
      const response = await request('pull', {});

      assert.equal(response.statusCode, 409);
      assert.equal(response.json().error, 'dirty_worktree');
      assert.equal(await git(root, ['rev-parse', 'HEAD']), before);
      assert.equal(await git(root, ['write-tree']), index);
      assert.equal(await readFile(path.join(root, file), 'utf8'), 'local edits\n');
      assert.equal(await git(root, ['stash', 'list']), '');
    });
  }
});

test('CODE-PULL-CONTEXT: без upstream и при detached HEAD получение запрещено', async (t) => {
  const { root, request } = await reviewFixture(t);
  const before = await git(root, ['rev-parse', 'HEAD']);
  const missing = await request('pull', {});

  assert.equal(missing.statusCode, 409);
  assert.equal(missing.json().error, 'no_upstream');
  await git(root, ['checkout', '--detach', '-q']);

  const detached = await request('pull', {});

  assert.equal(detached.statusCode, 409);
  assert.equal(detached.json().error, 'detached_head');
  assert.equal(await git(root, ['rev-parse', 'HEAD']), before);
});

test('CODE-PULL-ACCESS: ошибка сети не раскрывает remote URL и не меняет HEAD', async (t) => {
  const { root, request } = await pullFixture(t);
  const before = await git(root, ['rev-parse', 'HEAD']);

  await git(root, ['remote', 'set-url', 'team', 'https://secret-user:secret-pass@127.0.0.1:1/repo']);

  const response = await request('pull', {});

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error, 'fetch_failed');
  assert.doesNotMatch(response.body, /secret-user|secret-pass|127\.0\.0\.1/);
  assert.equal(await git(root, ['rev-parse', 'HEAD']), before);
});

test('CODE-PULL-GATE: выключенный плагин и запрос без входа не запускают получение', async (t) => {
  const fixture = await reviewFixture(t);

  fixture.disable();
  assert.equal((await fixture.request('pull', {})).statusCode, 403);

  const protectedFixture = await reviewFixture(t, { auth: true });

  assert.equal((await protectedFixture.request('pull', {})).statusCode, 401);
});

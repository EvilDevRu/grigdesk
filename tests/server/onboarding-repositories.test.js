import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  atProject, git, onboardingFixture, repository, request, token,
} from './helpers/onboardingFixture.js';

/**
 * Снимок включает индекс, HEAD, tracked и untracked, а не только git status.
 * Так проверка обнаруживает даже незаметную перезапись пользовательских данных.
 */
async function gitSnapshot(dir) {
  return {
    head: git(dir, 'rev-parse', 'HEAD'),
    status: git(dir, 'status', '--porcelain=v1'),
    index: (await readFile(path.join(dir, '.git', 'index'))).toString('hex'),
    tracked: await readFile(path.join(dir, 'tracked.txt'), 'utf8'),
    untracked: await readFile(path.join(dir, 'untracked.txt'), 'utf8'),
  };
}

test('ONB-GIT-01: repo и worktree возвращают локальные ветки и текущую', async (t) => {
  const f = await onboardingFixture(t);
  const dir = await repository(f.root);
  const worktree = path.join(f.root, 'linked');

  git(dir, 'worktree', 'add', worktree, 'feature');

  for (const source of [dir, worktree]) {
    const result = await request(f.app, 'POST', '/repository', { dir: source });
    const expected = git(source, 'for-each-ref', '--format=%(refname:strip=2)', 'refs/heads').split('\n');

    assert.deepEqual(result.branches.map((branch) => branch.name).sort(), expected.sort());
    assert.equal(result.currentBranch, git(source, 'symbolic-ref', '--short', 'HEAD'));
    assert.ok(result.branches.every((branch) => branch.compatible));
    assert.equal(result.branches.some((branch) => branch.name.includes('remote-only')), false);
  }
});

test('ONB-GIT-02: plain, missing, file и ложный .git отвергнуты', async (t) => {
  const f = await onboardingFixture(t);
  const plain = path.join(f.root, 'plain');
  const file = path.join(f.root, 'file');
  const fake = path.join(f.root, 'fake');

  await mkdir(plain);
  await writeFile(file, 'не каталог');
  await mkdir(fake);
  await mkdir(path.join(fake, '.git'));

  for (const dir of [plain, file, fake, path.join(f.root, 'missing')]) {
    const result = await request(f.app, 'POST', '/repository', { dir });

    assert.notEqual(result.state, 'ok');
    assert.deepEqual(result.branches, []);
    assert.ok(result.reason || result.code, 'ошибка объяснена кодом');
  }
});

test('ONB-GIT-02: detached требует выбора, unborn объясняет первый коммит', async (t) => {
  const f = await onboardingFixture(t);
  const dir = await repository(f.root);
  const empty = await repository(f.root, 'unborn', true);

  git(dir, 'checkout', '--detach');

  const detached = await request(f.app, 'POST', '/repository', { dir });
  const unborn = await request(f.app, 'POST', '/repository', { dir: empty });

  assert.equal(detached.currentBranch, null);
  assert.equal(detached.state, 'detached');
  assert.ok(detached.branches.length > 0);
  assert.equal(unborn.state, 'unborn');
  assert.deepEqual(unborn.branches, []);
  assert.ok(unborn.reason || unborn.code);
});

for (const code of ['EACCES', 'ETIMEDOUT']) {
  test(`ONB-GIT-02: отказ порта Git ${code} объяснён без записи`, async (t) => {
    const f = await onboardingFixture(t);
    const dir = await repository(f.root);
    const url = new URL('../../server/src/lib/onboarding/repositories.ts', import.meta.url);

    assert.ok(existsSync(url), 'Нет read-only inspectRepository');

    const { inspectRepository } = await import(url.href);
    const before = await gitSnapshot(dir);
    const result = await inspectRepository(dir, {
      git: async () => {
        throw Object.assign(new Error('Отказ фикстуры Git'), { code });
      },
    });

    assert.notEqual(result.state, 'ok');
    assert.ok(result.reason || result.code);
    assert.deepEqual(await gitSnapshot(dir), before);
  });
}

test('ONB-GIT-03: удалённая и несовместимая ветки не сохраняются, Git неизменен', async (t) => {
  const f = await onboardingFixture(t);
  const state = await atProject(f);
  const dir = await repository(f.root);

  git(dir, 'branch', 'ветка');

  const inspection = await request(f.app, 'POST', '/repository', { dir });

  assert.equal(inspection.branches.find((branch) => branch.name === 'ветка').compatible, false);
  git(dir, 'branch', '-D', 'feature');

  const before = await gitSnapshot(dir);

  for (const baseBranch of ['feature', 'ветка', 'origin/remote-only']) {
    const draft = {
      title: 'Проект',
      repositories: [{
        name: 'repo1',
        source: dir,
        baseBranch,
      }],
      workspace: { mode: 'isolated' },
    };
    const saved = await request(f.app, 'PATCH', '', { ...token(await request(f.app)), draft });
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/onboarding/advance',
      payload: token(saved),
    });

    assert.equal(response.statusCode, 400, response.body);
    assert.equal((await f.app.projects.list()).length, 0);
    assert.deepEqual(await gitSnapshot(dir), before);
  }

  assert.equal(state.active.step, 'project');
});

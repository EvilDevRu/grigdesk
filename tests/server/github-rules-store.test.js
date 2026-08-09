import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { GitHubRulesStore } from '../../server/src/lib/github/rules-store.js';

const ACCOUNT = 'acc_CCCCCCCCCCCCCCCCCCCCCC';
const REPOSITORY = '777';

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'github-rules-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, 'rules.json') };
}

const rule = (overrides = {}) => ({
  repositoryId: REPOSITORY,
  project: 'demo',
  ...overrides,
});

test('новый account закрыт пустым allowlist, а новое правило имеет auto off', async (t) => {
  const { file } = await fixture(t);
  const store = new GitHubRulesStore({
    file,
    accountRef: ACCOUNT,
    repositoryId: REPOSITORY,
    now: () => 1_786_172_400_000,
  });
  assert.deepEqual(await store.read(), []);
  assert.equal(await store.ruleFor(REPOSITORY), null);

  const [saved] = await store.write([rule()]);
  assert.deepEqual(saved, {
    repositoryId: REPOSITORY,
    project: 'demo',
    kind: 'bug',
    b24: { responsibleId: null, groupId: null, priority: 1 },
    autoTask: { enabled: false, minConfidence: 0.7, maxPerDay: 10 },
  });
  assert.equal((await store.ruleFor(REPOSITORY)).autoTask.enabled, false);
  assert.equal(await store.ruleFor('778'), null);
});

test('rules сохраняют exact owner, читаются cold и пишутся 0600 atomically', async (t) => {
  const { dir, file } = await fixture(t);
  const store = new GitHubRulesStore({
    file,
    accountRef: ACCOUNT,
    repositoryId: REPOSITORY,
    now: () => 100,
  });
  const configured = rule({
    kind: 'wish',
    b24: { responsibleId: 17, groupId: 3, priority: 2 },
    autoTask: { enabled: true, minConfidence: 0.9, maxPerDay: 4 },
  });
  await store.write([configured], { projects: ['demo'] });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith('.tmp')), []);

  const raw = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(raw.channel, 'github');
  assert.equal(raw.accountRef, ACCOUNT);
  assert.equal(raw.repositoryId, REPOSITORY);
  assert.equal(raw.rules[0].autoTask.enabled, true);

  const cold = new GitHubRulesStore({ file, accountRef: ACCOUNT, repositoryId: REPOSITORY });
  assert.deepEqual(await cold.read(), [configured]);
});

test('другой account/repository не может прочитать или записать чужой allowlist', async (t) => {
  const { file } = await fixture(t);
  const owner = new GitHubRulesStore({ file, accountRef: ACCOUNT, repositoryId: REPOSITORY, now: () => 100 });
  await owner.write([rule()]);

  const otherAccount = new GitHubRulesStore({
    file,
    accountRef: 'acc_DDDDDDDDDDDDDDDDDDDDDD',
    repositoryId: REPOSITORY,
  });
  await assert.rejects(() => otherAccount.read(), (err) => err.code === 'github_rules_owner_mismatch');
  await assert.rejects(
    () => owner.write([rule({ repositoryId: '778' })]),
    (err) => err.code === 'github_rules_owner_mismatch',
  );
  assert.equal((await owner.read())[0].project, 'demo');
});

test('правила strict: один repository, без чужих полей и опасных auto defaults', async (t) => {
  const { file } = await fixture(t);
  const store = new GitHubRulesStore({ file, accountRef: ACCOUNT, repositoryId: REPOSITORY, now: () => 100 });
  await assert.rejects(() => store.write([rule(), rule()]), (err) => err.code === 'github_rules_invalid');
  await assert.rejects(
    () => store.write([rule({ token: 'secret' })]),
    (err) => err.code === 'github_rules_invalid',
  );
  await assert.rejects(
    () => store.write([rule({ autoTask: { enabled: true, minConfidence: 42, maxPerDay: 1 } })]),
    (err) => err.code === 'github_rules_invalid',
  );
  await assert.rejects(
    () => store.write([rule({ project: 'typo' })], { projects: ['demo'] }),
    (err) => err.code === 'github_rules_invalid',
  );
  assert.deepEqual(await store.read(), []);
});

test('invalid update не портит сохранённое, empty write снова закрывает allowlist', async (t) => {
  const { file } = await fixture(t);
  let now = 100;
  const store = new GitHubRulesStore({
    file,
    accountRef: ACCOUNT,
    repositoryId: REPOSITORY,
    now: () => now++,
  });
  await store.write([rule()]);
  await assert.rejects(() => store.write([rule({ kind: 'feature' })]));
  assert.equal((await store.read()).length, 1);
  await store.write([]);
  assert.deepEqual(await store.read(), []);
});

test('битая schema и symlink fail-closed вместо пустого allowlist', async (t) => {
  const { dir, file } = await fixture(t);
  await writeFile(file, `${JSON.stringify({
    schemaVersion: 1,
    channel: 'github',
    accountRef: ACCOUNT,
    repositoryId: REPOSITORY,
    updatedAtMs: 1,
    rules: [],
    unknown: true,
  })}\n`, { mode: 0o600 });
  const store = new GitHubRulesStore({ file, accountRef: ACCOUNT, repositoryId: REPOSITORY });
  await assert.rejects(() => store.read(), (err) => err.code === 'github_rules_invalid');

  const outside = path.join(dir, 'outside.json');
  await writeFile(outside, '{}\n', { mode: 0o600 });
  await rm(file);
  await symlink(outside, file);
  await assert.rejects(() => store.read(), (err) => err.code === 'github_store_unsafe');
});

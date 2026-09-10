import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { GitHubRulesStore } from '../../server/src/lib/github/rulesStore.ts';

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
    agentSearch: false,
  });
  assert.equal((await store.ruleFor(REPOSITORY)).autoTask.enabled, false);
  assert.equal((await store.ruleFor(REPOSITORY)).agentSearch, false);
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
  assert.equal(raw.rules[0].agentSearch, false);

  const cold = new GitHubRulesStore({ file, accountRef: ACCOUNT, repositoryId: REPOSITORY });
  assert.deepEqual(await cold.read(), [{ ...configured, agentSearch: false }]);
});

test('legacy rule без agentSearch читается default-deny и получает canonical fingerprint', async (t) => {
  const { file } = await fixture(t);
  await writeFile(file, `${JSON.stringify({
    schemaVersion: 1,
    channel: 'github',
    accountRef: ACCOUNT,
    repositoryId: REPOSITORY,
    updatedAtMs: 100,
    rules: [{
      repositoryId: REPOSITORY,
      project: 'demo',
      kind: 'bug',
      b24: { responsibleId: null, groupId: null, priority: 1 },
      autoTask: { enabled: false, minConfidence: 0.7, maxPerDay: 10 },
    }],
  })}\n`, { mode: 0o600 });

  const store = new GitHubRulesStore({ file, accountRef: ACCOUNT, repositoryId: REPOSITORY });
  const policy = await store.readPolicy();
  assert.equal(policy.rules[0].agentSearch, false);
  assert.match(policy.policyFingerprint, /^ghpol1:[0-9a-f]{64}$/u);

  const cold = new GitHubRulesStore({ file, accountRef: ACCOUNT, repositoryId: REPOSITORY });
  assert.equal((await cold.readPolicy()).policyFingerprint, policy.policyFingerprint);
});

test('agentSearch меняется только отдельным CAS и входит в policy fingerprint', async (t) => {
  const { file } = await fixture(t);
  let now = 100;
  const store = new GitHubRulesStore({
    file,
    accountRef: ACCOUNT,
    repositoryId: REPOSITORY,
    now: () => now++,
  });
  await store.write([rule()]);
  const before = await store.readPolicy();

  const enabled = await store.setAgentSearch({
    enabled: true,
    expectedPolicyFingerprint: before.policyFingerprint,
  });
  assert.equal(enabled.rules[0].agentSearch, true);
  assert.notEqual(enabled.policyFingerprint, before.policyFingerprint);

  await assert.rejects(
    () => store.setAgentSearch({
      enabled: false,
      expectedPolicyFingerprint: before.policyFingerprint,
    }),
    (err) => err.code === 'github_rules_stale_policy' && err.statusCode === 409,
  );
  assert.equal((await store.ruleFor(REPOSITORY)).agentSearch, true);

  await store.write([rule({ kind: 'wish' })]);
  const afterHumanEdit = await store.readPolicy();
  assert.equal(afterHumanEdit.rules[0].agentSearch, true, 'обычная форма не снимает и не включает opt-in');
  assert.notEqual(afterHumanEdit.policyFingerprint, enabled.policyFingerprint);

  await store.write([rule({ project: 'other' })], { projects: ['demo', 'other'] });
  assert.equal(
    (await store.ruleFor(REPOSITORY)).agentSearch,
    false,
    'project move не должен молча переносить opt-in на агентов другого проекта',
  );
});

test('обычный rules write не принимает agentSearch из untrusted payload', async (t) => {
  const { file } = await fixture(t);
  const store = new GitHubRulesStore({ file, accountRef: ACCOUNT, repositoryId: REPOSITORY, now: () => 100 });
  await assert.rejects(
    () => store.write([rule({ agentSearch: true })]),
    (err) => err.code === 'github_rules_invalid',
  );
  assert.deepEqual(await store.read(), []);
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

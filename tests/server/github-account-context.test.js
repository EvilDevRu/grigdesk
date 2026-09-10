import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createGitHubAccountContextFactory,
  normalizeGitHubRepositoryFullName,
} from '../../server/src/lib/github/accountContext.ts';
import { githubIssueSemanticKey } from '../../server/src/lib/github/archiveStore.ts';

const ACCOUNT = 'acc_github_context_0001';
const REPOSITORY = '123456';
const FULL_NAME = 'acme/support';

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'github-account-context-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, metadata: path.join(dir, 'accounts', ACCOUNT, 'account.json') };
}

test('online context атомарно сохраняет owner metadata и собирает все per-account stores', async (t) => {
  const { dir, metadata } = await fixture(t);
  const factory = createGitHubAccountContextFactory({ dir, now: () => 1_786_172_400_000 });
  const context = await factory({
    accountRef: ACCOUNT,
    repositoryId: REPOSITORY,
    repositoryFullName: FULL_NAME,
    token: 'github_pat_must_be_ignored',
  });
  const accountDir = path.join(dir, 'accounts', ACCOUNT);

  assert.equal(context.repositoryId, REPOSITORY);
  assert.equal(context.repositoryFullName, FULL_NAME);
  assert.equal(context.archive.file, path.join(accountDir, 'archive', 'issues.ndjson'));
  assert.equal(context.rules.file, path.join(accountDir, 'rules.json'));
  assert.equal(context.inboxState.file, path.join(accountDir, 'inbox-state.json'));
  assert.equal(context.ingressState.file, path.join(accountDir, 'ingress-state.json'));
  assert.equal(context.inboxState.refCodec.accountRef, ACCOUNT);
  assert.equal(context.inboxState.refCodec.channel, 'github');
  assert.equal((await stat(metadata)).mode & 0o777, 0o600);

  const raw = JSON.parse(await readFile(metadata, 'utf8'));
  assert.deepEqual(raw, {
    schemaVersion: 1,
    channel: 'github',
    accountRef: ACCOUNT,
    repositoryId: REPOSITORY,
    repositoryFullName: FULL_NAME,
    updatedAtMs: 1_786_172_400_000,
  });
  assert.doesNotMatch(JSON.stringify(raw), /github_pat|token|secret/u);
  assert.equal(context.archive.file.includes(REPOSITORY), false,
    'provider id не участвует в filesystem namespace');
});

test('cold factory после restart читает durable fullName и тот же archive без credentials', async (t) => {
  const { dir, metadata } = await fixture(t);
  const online = createGitHubAccountContextFactory({ dir, now: () => 100 });
  const first = await online({
    accountRef: ACCOUNT,
    repositoryId: REPOSITORY,
    repositoryFullName: FULL_NAME,
  });
  await first.archive.append({
    transport: { kind: 'webhook', id: 'delivery-context-0001' },
    repositoryId: REPOSITORY,
    issueId: '501',
    semanticKey: githubIssueSemanticKey(REPOSITORY, '501'),
    occurredAt: 1_786_172_400,
    snapshot: { id: 501, number: 7, title: 'Persisted issue' },
  });
  const before = await readFile(metadata, 'utf8');

  const afterRestart = createGitHubAccountContextFactory({
    dir,
    now() { throw new Error('offline read не должен писать metadata'); },
  });
  const offline = await afterRestart({ accountRef: ACCOUNT, repositoryId: REPOSITORY });

  assert.equal(offline.repositoryFullName, FULL_NAME);
  assert.equal((await offline.archive.list())[0].snapshot.title, 'Persisted issue');
  assert.equal(await readFile(metadata, 'utf8'), before);
});

test('rename обновляет только display metadata того же immutable repository owner', async (t) => {
  const { dir } = await fixture(t);
  let now = 100;
  const factory = createGitHubAccountContextFactory({ dir, now: () => now++ });
  await factory({
    accountRef: ACCOUNT,
    repositoryId: REPOSITORY,
    repositoryFullName: FULL_NAME,
  });
  await factory({
    accountRef: ACCOUNT,
    repositoryId: REPOSITORY,
    repositoryFullName: 'new-owner/new-name',
  });
  const cold = await factory({ accountRef: ACCOUNT, repositoryId: REPOSITORY });
  assert.equal(cold.repositoryFullName, 'new-owner/new-name');
  assert.equal(cold.archive.accountRef, ACCOUNT);
  assert.equal(cold.archive.repositoryId, REPOSITORY);
});

test('online context не переписывает metadata другого owner поверх существующих stores', async (t) => {
  const { dir, metadata: metadataFile } = await fixture(t);
  const factory = createGitHubAccountContextFactory({ dir, now: () => 100 });
  await factory({
    accountRef: ACCOUNT,
    repositoryId: REPOSITORY,
    repositoryFullName: FULL_NAME,
  });
  const before = await readFile(metadataFile, 'utf8');

  await assert.rejects(
    () => factory({
      accountRef: ACCOUNT,
      repositoryId: '999999',
      repositoryFullName: 'attacker/repository',
    }),
    (error) => error.code === 'github_metadata_owner_mismatch',
  );
  assert.equal(await readFile(metadataFile, 'utf8'), before);
});

test('offline metadata fail-closed не угадывает fullName и не принимает другого owner', async (t) => {
  const { dir, metadata } = await fixture(t);
  const factory = createGitHubAccountContextFactory({ dir, now: () => 100 });
  await assert.rejects(
    () => factory({ accountRef: ACCOUNT, repositoryId: REPOSITORY }),
    (error) => error.code === 'github_metadata_missing',
  );
  await factory({
    accountRef: ACCOUNT,
    repositoryId: REPOSITORY,
    repositoryFullName: FULL_NAME,
  });
  await assert.rejects(
    () => factory({ accountRef: ACCOUNT, repositoryId: '999999' }),
    (error) => error.code === 'github_metadata_owner_mismatch',
  );

  const corrupt = JSON.parse(await readFile(metadata, 'utf8'));
  corrupt.extra = 'not schema';
  await writeFile(metadata, `${JSON.stringify(corrupt)}\n`, { mode: 0o600 });
  await assert.rejects(
    () => factory({ accountRef: ACCOUNT, repositoryId: REPOSITORY }),
    (error) => error.code === 'github_metadata_invalid',
  );
});

test('metadata symlink не читается и online rewrite не затрагивает target', async (t) => {
  const { dir, metadata } = await fixture(t);
  const accountDir = path.dirname(metadata);
  await mkdir(accountDir, { recursive: true });
  const target = path.join(dir, 'outside.json');
  await writeFile(target, '{"outside":true}\n', { mode: 0o600 });
  await symlink(target, metadata);
  const factory = createGitHubAccountContextFactory({ dir, now: () => 100 });

  await assert.rejects(
    () => factory({ accountRef: ACCOUNT, repositoryId: REPOSITORY }),
    (error) => error.code === 'github_store_unsafe',
  );
  await assert.rejects(
    () => factory({
      accountRef: ACCOUNT,
      repositoryId: REPOSITORY,
      repositoryFullName: FULL_NAME,
    }),
    (error) => error.code === 'github_store_unsafe',
  );
  assert.equal(await readFile(target, 'utf8'), '{"outside":true}\n');
});

test('accounts/account directory symlink не уводит namespace за trusted root', async (t) => {
  const { dir } = await fixture(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'github-context-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, path.join(dir, 'accounts'));
  const factory = createGitHubAccountContextFactory({ dir, now: () => 100 });

  await assert.rejects(
    () => factory({
      accountRef: ACCOUNT,
      repositoryId: REPOSITORY,
      repositoryFullName: FULL_NAME,
    }),
    (error) => error.code === 'github_store_unsafe',
  );
  await assert.rejects(
    () => stat(path.join(outside, ACCOUNT, 'account.json')),
    (error) => error.code === 'ENOENT',
  );

  await rm(path.join(dir, 'accounts'));
  await mkdir(path.join(dir, 'accounts'), { mode: 0o700 });
  await symlink(outside, path.join(dir, 'accounts', ACCOUNT));
  await assert.rejects(
    () => factory({
      accountRef: ACCOUNT,
      repositoryId: REPOSITORY,
      repositoryFullName: FULL_NAME,
    }),
    (error) => error.code === 'github_store_unsafe',
  );
  await assert.rejects(
    () => stat(path.join(outside, 'account.json')),
    (error) => error.code === 'ENOENT',
  );
});

test('fullName, trusted root и timestamp проверяются до появления partial metadata', async (t) => {
  const { dir, metadata } = await fixture(t);
  for (const bad of [
    '', 'owner', 'owner/repo/extra', '../repo', 'owner/..', 'owner/name.git',
    'owner?query/repo',
  ]) assert.throws(() => normalizeGitHubRepositoryFullName(bad));
  assert.equal(normalizeGitHubRepositoryFullName('owner/repo_name-1.2'), 'owner/repo_name-1.2');
  assert.throws(() => createGitHubAccountContextFactory({ dir: 'relative' }), /абсолют/u);

  const factory = createGitHubAccountContextFactory({ dir, now: () => 0 });
  await assert.rejects(
    () => factory({
      accountRef: ACCOUNT,
      repositoryId: REPOSITORY,
      repositoryFullName: FULL_NAME,
    }),
    (error) => error.code === 'github_metadata_invalid',
  );
  await assert.rejects(() => stat(metadata), (error) => error.code === 'ENOENT');
});

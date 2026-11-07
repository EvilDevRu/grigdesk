import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  GitHubAccountBindings,
  GitHubStoreError,
  githubRepositoryIdentity,
} from '../../server/src/lib/github/accountBindings.ts';
import { GitHubCredentialsStore } from '../../server/src/lib/github/credentialsStore.ts';

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'github-bindings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, 'account-bindings.json') };
}

function deterministicRandom() {
  let value = 0;
  const fn = () => {
    value += 1;
    return Buffer.alloc(24, value);
  };
  fn.calls = () => value;
  return fn;
}

test('same repository переиспользует случайный accountRef, другой id получает отдельный namespace', async (t) => {
  const { file } = await fixture(t);
  const randomBytes = deterministicRandom();
  const store = new GitHubAccountBindings({ file, randomBytes, now: () => 1_786_172_400_000 });

  const first = await store.resolveOrCreate(githubRepositoryIdentity('101'));
  const same = await store.resolveOrCreate(githubRepositoryIdentity(101));
  const other = await store.resolveOrCreate(githubRepositoryIdentity('102'));

  assert.equal(first.created, true);
  assert.equal(first.selected, true);
  assert.equal(same.created, false);
  assert.equal(same.binding.accountRef, first.binding.accountRef);
  assert.notEqual(other.binding.accountRef, first.binding.accountRef);
  assert.equal(randomBytes.calls(), 2, 'same provider identity не расходует новый random accountRef');
  assert.deepEqual(other.binding.providerIdentity, [1, 'github.com', 'repository', '102']);

  const cold = new GitHubAccountBindings({ file });
  assert.equal((await cold.lookup(githubRepositoryIdentity('101'))).accountRef, first.binding.accountRef);
  assert.equal((await cold.selected()).accountRef, other.binding.accountRef);
});

test('параллельный resolve одного repository создаёт один binding и один accountRef', async (t) => {
  const { file } = await fixture(t);
  const randomBytes = deterministicRandom();
  const store = new GitHubAccountBindings({ file, randomBytes, now: () => 1_786_172_400_000 });

  const results = await Promise.all(Array.from(
    { length: 40 },
    () => store.resolveOrCreate(githubRepositoryIdentity('500')),
  ));
  assert.equal(new Set(results.map((result) => result.binding.accountRef)).size, 1);
  assert.equal(results.filter((result) => result.created).length, 1);
  assert.equal((await store.read()).bindings.length, 1);
  assert.equal(randomBytes.calls(), 1);
});

test('selected pointer переключается только на verified binding и переживает очистку credentials', async (t) => {
  const { dir, file } = await fixture(t);
  const randomBytes = deterministicRandom();
  const bindings = new GitHubAccountBindings({ file, randomBytes, now: () => 1_786_172_400_000 });
  const one = (await bindings.resolveOrCreate(githubRepositoryIdentity('700'))).binding;
  const two = (await bindings.resolveOrCreate(githubRepositoryIdentity('701'))).binding;
  assert.equal((await bindings.selected()).accountRef, two.accountRef);
  await bindings.select(one.accountRef);
  assert.equal((await bindings.selected()).accountRef, one.accountRef);
  await assert.rejects(() => bindings.select('acc_unknown_account'), (err) => err.code === 'github_binding_missing');

  const credentials = new GitHubCredentialsStore({
    file: path.join(dir, 'credentials.json'),
    now: () => 1_786_172_400_001,
  });
  await credentials.write({
    state: 'cleanup_pending',
    token: 'github_pat_cleanup_private_value',
    secret: 'webhook-secret',
    ingressRef: 'ingress_reference_01',
    callbackUrl: 'https://grigdesk.example.test/hooks/github/ingress_reference_01',
    hookId: '900',
    generation: 3,
    accountRef: one.accountRef,
    repositoryId: '700',
    fullName: 'owner/repository',
    connectedAt: 1_786_172_300_000,
  });
  await credentials.clear({ cleanupComplete: true });

  const cold = new GitHubAccountBindings({ file });
  assert.equal((await cold.selected()).accountRef, one.accountRef,
    'disconnect очищает credentials, но не last selected account для offline list');
  assert.equal((await cold.byAccountRef(one.accountRef)).providerIdentity[3], '700');

  assert.equal(await cold.clearSelection(), true);
  assert.equal(await cold.selected(), null);
});

test('identity принимает только exact immutable tuple без owner/name и numeric aliases', async (t) => {
  const { file } = await fixture(t);
  const store = new GitHubAccountBindings({ file });
  for (const invalid of [
    'owner/repository',
    [1, 'github.com', 'repository', 123],
    [1, 'github.com', 'repository', '00123'],
    [1, 'github.com', 'repo', '123'],
    [2, 'github.com', 'repository', '123'],
  ]) {
    await assert.rejects(
      () => store.resolveOrCreate(invalid),
      (err) => err instanceof GitHubStoreError && err.code === 'github_identity_invalid',
    );
  }
});

test('duplicate identity/accountRef и dangling selected pointer fail-closed', async (t) => {
  const { file } = await fixture(t);
  const binding = {
    accountRef: 'acc_AAAAAAAAAAAAAAAAAAAAAA',
    providerIdentity: [1, 'github.com', 'repository', '1'],
    createdAtMs: 1,
  };
  await writeFile(file, `${JSON.stringify({
    schemaVersion: 1,
    channel: 'github',
    selectedAccountRef: 'acc_missing_account_01',
    updatedAtMs: 1,
    bindings: [binding],
  })}\n`, { mode: 0o600 });
  const store = new GitHubAccountBindings({ file });
  await assert.rejects(() => store.read(), (err) => err.code === 'github_binding_conflict');

  await writeFile(file, `${JSON.stringify({
    schemaVersion: 1,
    channel: 'github',
    selectedAccountRef: binding.accountRef,
    updatedAtMs: 1,
    bindings: [binding, { ...binding, providerIdentity: [1, 'github.com', 'repository', '2'] }],
  })}\n`, { mode: 0o600 });
  await assert.rejects(() => store.read(), (err) => err.code === 'github_binding_conflict');
});

test('binding store пишет 0600 через unique temp+rename и отвергает symlink', async (t) => {
  const { dir, file } = await fixture(t);
  const store = new GitHubAccountBindings({
    file,
    randomBytes: deterministicRandom(),
    now: () => 10,
  });
  await store.resolveOrCreate(githubRepositoryIdentity('42'));
  const info = await import('node:fs/promises').then(({ stat }) => stat(file));
  assert.equal(info.mode & 0o777, 0o600);
  assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith('.tmp')), []);

  const target = path.join(dir, 'elsewhere.json');
  await writeFile(target, '{}\n', { mode: 0o600 });
  await rm(file);
  await symlink(target, file);
  await assert.rejects(() => store.read(), (err) => err.code === 'github_store_unsafe');
  await assert.rejects(
    () => store.resolveOrCreate(githubRepositoryIdentity('43')),
    (err) => err.code === 'github_store_unsafe',
  );
  assert.equal(await readFile(target, 'utf8'), '{}\n');
  await chmod(target, 0o600);
});

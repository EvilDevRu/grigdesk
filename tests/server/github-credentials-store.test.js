import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { GitHubCredentialsStore } from '../../server/src/lib/github/credentials-store.js';

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'github-credentials-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, 'credentials.json') };
}

const pending = (overrides = {}) => ({
  state: 'pending',
  token: 'github_pat_private_value',
  secret: 'webhook-secret-private-value',
  ingressRef: 'ingress_reference_0001',
  callbackUrl: 'https://cockpit.example.test/hooks/github/ingress_reference_0001',
  hookId: null,
  generation: 1,
  accountRef: null,
  repositoryId: null,
  fullName: null,
  connectedAt: null,
  ...overrides,
});

const connected = (overrides = {}) => pending({
  state: 'connected',
  hookId: '987654',
  generation: 2,
  accountRef: 'acc_AAAAAAAAAAAAAAAAAAAAAA',
  repositoryId: '123456',
  fullName: 'owner/repository',
  connectedAt: 1_786_172_300_000,
  ...overrides,
});

const waitingPing = (overrides = {}) => pending({
  hookId: '987654',
  generation: 2,
  accountRef: 'acc_AAAAAAAAAAAAAAAAAAAAAA',
  repositoryId: '123456',
  fullName: 'owner/repository',
  ...overrides,
});

const verifiedNoHook = (overrides = {}) => pending({
  accountRef: 'acc_AAAAAAAAAAAAAAAAAAAAAA',
  repositoryId: '123456',
  fullName: 'owner/repository',
  ...overrides,
});

test('credentials сохраняют lifecycle и секреты только в owner-only файле', async (t) => {
  const { dir, file } = await fixture(t);
  const store = new GitHubCredentialsStore({ file, now: () => 1_786_172_400_000 });
  const saved = await store.write(pending());
  assert.equal(saved.token, 'github_pat_private_value');
  assert.equal(saved.secret, 'webhook-secret-private-value');
  assert.equal(saved.updatedAtMs, 1_786_172_400_000);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith('.tmp')), []);

  const cold = new GitHubCredentialsStore({ file });
  assert.deepEqual(await cold.read(), saved);
});

test('publicView рекурсивно не отдаёт token, secret и internal routing handles', async (t) => {
  const { file } = await fixture(t);
  const store = new GitHubCredentialsStore({ file, now: () => 100 });
  await store.write(connected());
  const view = await store.publicView();
  assert.deepEqual(view, {
    configured: true,
    state: 'connected',
    repositoryId: '123456',
    fullName: 'owner/repository',
    connectedAt: 1_786_172_300_000,
    hasToken: true,
  });
  const publicJson = JSON.stringify(view);
  assert.doesNotMatch(
    publicJson,
    /github_pat|webhook-secret|accountRef|acc_|ingress_reference|callbackUrl|hookId|generation/u,
  );
});

test('pending durable проходит WAL draft → verified_no_hook → waiting-ping → connected', async (t) => {
  const { file } = await fixture(t);
  let now = 100;
  const store = new GitHubCredentialsStore({ file, now: () => now++ });
  await store.write(pending());

  const verified = await store.update({
    generation: 2,
    accountRef: 'acc_AAAAAAAAAAAAAAAAAAAAAA',
    repositoryId: '123456',
    fullName: 'owner/repository',
  });
  assert.equal(verified.state, 'pending');
  assert.equal(verified.hookId, null);
  assert.equal(verified.connectedAt, null);

  const waiting = await store.update({ hookId: '987654' });
  assert.equal(waiting.state, 'pending');
  assert.equal(waiting.hookId, '987654');
  assert.deepEqual(await store.publicView(), {
    configured: true,
    state: 'pending',
    repositoryId: '123456',
    fullName: 'owner/repository',
    connectedAt: null,
    hasToken: true,
  });
  assert.doesNotMatch(
    JSON.stringify(await store.publicView()),
    /github_pat|webhook-secret|accountRef|acc_|ingress_reference|callbackUrl|hookId|generation/u,
  );

  const active = await store.update({
    state: 'connected',
    connectedAt: 1_786_172_300_000,
  });
  assert.equal(active.connectedAt, 1_786_172_300_000);
  assert.equal((await store.publicView()).state, 'connected');
});

test('update сохраняет exact остальные поля и сериализует lifecycle queue', async (t) => {
  const { file } = await fixture(t);
  let now = 100;
  const store = new GitHubCredentialsStore({ file, now: () => now++ });
  await store.write(pending());
  const verified = await store.update({
    state: 'connected',
    hookId: '77',
    generation: 2,
    accountRef: 'acc_BBBBBBBBBBBBBBBBBBBBBB',
    repositoryId: '44',
    fullName: 'new-owner/new-repository',
    connectedAt: 90,
  });
  assert.equal(verified.token, pending().token);
  assert.equal(verified.secret, pending().secret);
  assert.equal(verified.state, 'connected');
  assert.equal(verified.updatedAtMs, 101);

  await assert.rejects(() => store.update({}), (err) => err.code === 'github_credentials_invalid');
  await assert.rejects(
    () => store.update({ token: 'safe', surprise: true }),
    (err) => err.code === 'github_credentials_invalid',
  );
});

test('clear требует cleanup_pending и явное подтверждение законченной очистки', async (t) => {
  const { file } = await fixture(t);
  let now = 100;
  const store = new GitHubCredentialsStore({ file, now: () => now++ });
  await store.write(connected());
  await assert.rejects(() => store.clear({ cleanupComplete: true }), (err) => err.code === 'github_cleanup_required');

  await store.update({ state: 'cleanup_pending', generation: 3 });
  await assert.rejects(() => store.clear(), (err) => err.code === 'github_cleanup_required');
  assert.equal(await store.clear({ cleanupComplete: true }), true);
  assert.equal(await store.read(), null);
  assert.equal(await store.clear({ cleanupComplete: true }), false, 'повторная очистка идемпотентна');
  assert.equal((await store.publicView()).configured, false);
});

test('lifecycle identity не бывает частичной, schema и secret strict', async (t) => {
  const { file } = await fixture(t);
  const store = new GitHubCredentialsStore({ file, now: () => 100 });
  for (const invalid of [
    pending({ repositoryId: '1' }),
    verifiedNoHook({ accountRef: null }),
    verifiedNoHook({ connectedAt: 10 }),
    waitingPing({ connectedAt: 10 }),
    connected({ accountRef: null }),
    connected({ hookId: null }),
    connected({ connectedAt: null }),
    pending({ state: 'cleanup_pending', connectedAt: 10 }),
    waitingPing({ state: 'cleanup_pending', repositoryId: null }),
    pending({ secret: 'bad\nsecret' }),
    pending({ token: null }),
    connected({ token: null }),
    pending({ ingressRef: '../route' }),
    pending({ callbackUrl: 'http://cockpit.example.test/hooks/github/ingress_reference_0001' }),
    pending({ callbackUrl: 'https://cockpit.example.test/hooks/github/another_ingress_ref' }),
    pending({ generation: 0 }),
  ]) {
    await assert.rejects(() => store.write(invalid), (err) => err.code === 'github_credentials_invalid');
  }
  await assert.rejects(
    () => store.write({ ...pending(), unknown: 'secret' }),
    (err) => err.code === 'github_credentials_invalid',
  );
  assert.equal(await store.read(), null, 'invalid write не оставляет partial credential');
});

test('cleanup_pending принимает draft, verified_no_hook, waiting-ping и connected snapshot', async (t) => {
  const { file } = await fixture(t);
  let now = 100;
  const store = new GitHubCredentialsStore({ file, now: () => now++ });

  await store.write(pending({ state: 'cleanup_pending' }));
  assert.equal((await store.read()).connectedAt, null);
  await store.write(verifiedNoHook({ state: 'cleanup_pending' }));
  assert.equal((await store.read()).hookId, null);
  await store.write(waitingPing({ state: 'cleanup_pending' }));
  assert.equal((await store.read()).hookId, '987654');
  await store.write(connected({ state: 'cleanup_pending' }));
  assert.equal((await store.read()).connectedAt, 1_786_172_300_000);
});

test('read fail-closed отвергает symlink и слишком широкие права', async (t) => {
  const { dir, file } = await fixture(t);
  const target = path.join(dir, 'target.json');
  await writeFile(target, `${JSON.stringify({ secret: 'outside' })}\n`, { mode: 0o600 });
  await symlink(target, file);
  const store = new GitHubCredentialsStore({ file });
  await assert.rejects(() => store.read(), (err) => err.code === 'github_store_unsafe');
  await assert.rejects(() => store.write(pending()), (err) => err.code === 'github_store_unsafe');
  assert.match(await readFile(target, 'utf8'), /outside/);

  await rm(file);
  const good = new GitHubCredentialsStore({ file, now: () => 100 });
  await good.write(pending());
  await chmod(file, 0o644);
  await assert.rejects(() => good.read(), (err) => err.code === 'github_store_permissions');
});

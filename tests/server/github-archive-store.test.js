import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  GitHubArchiveStore,
  githubIssueSemanticKey,
} from '../../server/src/lib/github/archive-store.js';

const ACCOUNT = 'acc_EEEEEEEEEEEEEEEEEEEEEE';
const REPOSITORY = '1001';

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'github-archive-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, 'archive', 'issues.ndjson') };
}

const snapshot = (overrides = {}) => ({
  id: '501',
  number: 7,
  title: 'Падает сохранение',
  body: 'Шаги воспроизведения',
  author: { id: '91', login: 'reporter' },
  ...overrides,
});

const appendInput = (overrides = {}) => {
  const repositoryId = overrides.repositoryId ?? REPOSITORY;
  const issueId = overrides.issueId ?? '501';
  return {
    transport: { kind: 'webhook', id: 'delivery-0001' },
    repositoryId,
    issueId,
    semanticKey: githubIssueSemanticKey(repositoryId, issueId),
    occurredAt: 1_786_172_400,
    snapshot: snapshot({ id: issueId }),
    ...overrides,
  };
};

test('append пишет owner-owned immutable snapshot с монотонным seq и 0600', async (t) => {
  const { dir, file } = await fixture(t);
  const store = new GitHubArchiveStore({ dir, accountRef: ACCOUNT, repositoryId: REPOSITORY });
  const input = appendInput();
  const result = await store.append(input);
  input.snapshot.title = 'клиент мутировал объект после append';

  assert.equal(result.appended, true);
  assert.equal(result.inserted, true);
  assert.equal(result.duplicate, false);
  assert.equal(result.seq, 1);
  assert.equal(await store.head(), 1);
  assert.equal((await stat(file)).mode & 0o777, 0o600);

  const [row] = await store.list();
  assert.equal(row.accountRef, ACCOUNT);
  assert.equal(row.repositoryId, REPOSITORY);
  assert.equal(row.seq, 1);
  assert.equal(row.firstSeq, 1);
  assert.equal(row.duplicateOfSeq, null);
  assert.equal(row.snapshot.title, 'Падает сохранение');
  assert.equal(row.snapshotJson, undefined, 'внутренний fingerprint не входит в row API');
});

test('transport retry идемпотентен, semantic duplicate получает durable receipt без второго issue', async (t) => {
  const { dir } = await fixture(t);
  const store = new GitHubArchiveStore({ dir, accountRef: ACCOUNT, repositoryId: REPOSITORY });
  const first = appendInput();
  await store.append(first);
  const retry = await store.append(first);
  assert.deepEqual(
    { appended: retry.appended, inserted: retry.inserted, duplicate: retry.duplicate, seq: retry.seq },
    { appended: false, inserted: false, duplicate: true, seq: 1 },
  );

  const rest = appendInput({ transport: { kind: 'rest', id: 'rest:1001:501' } });
  const duplicate = await store.append(rest);
  assert.deepEqual(
    { appended: duplicate.appended, inserted: duplicate.inserted, duplicate: duplicate.duplicate, seq: duplicate.seq },
    { appended: true, inserted: false, duplicate: true, seq: 2 },
  );
  assert.equal(await store.head(), 2, 'receipt тоже двигает ingestion boundary');
  assert.equal((await store.list()).length, 1, 'semantic issue выдаётся один раз');
  assert.equal((await store.receipt(rest.transport)).duplicateOfSeq, 1);

  const cold = new GitHubArchiveStore({ dir, accountRef: ACCOUNT, repositoryId: REPOSITORY });
  assert.equal(await cold.head(), 2);
  assert.equal((await cold.list()).length, 1);
  assert.equal((await cold.receipt(rest.transport)).firstSeq, 1);
});

test('redelivery после boundary не воскрешает semantic issue из закрытого gap', async (t) => {
  const { dir } = await fixture(t);
  const store = new GitHubArchiveStore({ dir, accountRef: ACCOUNT, repositoryId: REPOSITORY });
  await store.append(appendInput()); // впервые принят в старой/gap sequence 1
  const boundary = await store.head();
  await store.append(appendInput({ transport: { kind: 'webhook', id: 'delivery-redelivery-02' } }));
  assert.equal(await store.head(), 2);
  assert.deepEqual(await store.list({ afterSeq: boundary }), [],
    'поздний receipt не превращается в новый первый snapshot');
});

test('один semantic key или transport key с другим immutable snapshot fail-closed', async (t) => {
  const { dir } = await fixture(t);
  const store = new GitHubArchiveStore({ dir, accountRef: ACCOUNT, repositoryId: REPOSITORY });
  await store.append(appendInput());

  await assert.rejects(
    () => store.append(appendInput({
      transport: { kind: 'webhook', id: 'delivery-0002' },
      snapshot: snapshot({ id: '501', title: 'Переписанный title' }),
    })),
    (err) => err.code === 'github_archive_conflict',
  );
  await assert.rejects(
    () => store.append(appendInput({
      issueId: '502',
      semanticKey: githubIssueSemanticKey(REPOSITORY, '502'),
      snapshot: snapshot({ id: '502' }),
    })),
    (err) => err.code === 'github_archive_conflict',
  );
  assert.equal(await store.head(), 1);
  assert.equal((await store.list()).length, 1);
});

test('REST edit того же issue — idempotent no-op, первый snapshot остаётся immutable после restart', async (t) => {
  const { dir } = await fixture(t);
  const transport = { kind: 'rest', id: 'rest:1001:501' };
  const store = new GitHubArchiveStore({ dir, accountRef: ACCOUNT, repositoryId: REPOSITORY });
  await store.append(appendInput({ transport }));

  const edited = appendInput({
    transport,
    snapshot: snapshot({
      id: '501',
      title: 'Заголовок исправлен после открытия',
      updated_at: '2026-08-09T17:00:00Z',
    }),
  });
  const duplicate = await store.append(edited);
  assert.deepEqual(
    { appended: duplicate.appended, inserted: duplicate.inserted, duplicate: duplicate.duplicate, seq: duplicate.seq },
    { appended: false, inserted: false, duplicate: true, seq: 1 },
  );
  assert.equal(await store.head(), 1);
  assert.equal((await store.list())[0].snapshot.title, 'Падает сохранение');

  const cold = new GitHubArchiveStore({ dir, accountRef: ACCOUNT, repositoryId: REPOSITORY });
  const afterRestart = await cold.append({
    ...edited,
    snapshot: snapshot({ id: '501', title: 'Ещё одно обычное редактирование' }),
  });
  assert.equal(afterRestart.appended, false);
  assert.equal(await cold.head(), 1);
  assert.equal((await cold.list())[0].snapshot.title, 'Падает сохранение');
});

test('100 parallel append проходят одну queue без duplicate seq и переживают restart', async (t) => {
  const { dir, file } = await fixture(t);
  const store = new GitHubArchiveStore({ dir, accountRef: ACCOUNT, repositoryId: REPOSITORY });
  const results = await Promise.all(Array.from({ length: 100 }, (_, index) => {
    const issueId = String(10_000 + index);
    return store.append(appendInput({
      transport: { kind: index % 2 ? 'rest' : 'webhook', id: `transport-${index}` },
      issueId,
      semanticKey: githubIssueSemanticKey(REPOSITORY, issueId),
      occurredAt: 1_786_172_400 + index,
      snapshot: snapshot({ id: issueId, number: index + 1, title: `Issue ${index}` }),
    }));
  }));
  assert.deepEqual(results.map((result) => result.seq), Array.from({ length: 100 }, (_, index) => index + 1));
  assert.equal((await readFile(file, 'utf8')).trim().split('\n').length, 100);

  const cold = new GitHubArchiveStore({ dir, accountRef: ACCOUNT, repositoryId: REPOSITORY });
  assert.equal(await cold.head(), 100);
  assert.equal((await cold.list({ limit: 10_000 })).length, 100);
});

test('owner, semantic key, input schema и transport bounded fail-closed до append', async (t) => {
  const { dir } = await fixture(t);
  const store = new GitHubArchiveStore({ dir, accountRef: ACCOUNT, repositoryId: REPOSITORY });
  for (const invalid of [
    appendInput({ repositoryId: '2002' }),
    appendInput({ semanticKey: githubIssueSemanticKey(REPOSITORY, '999') }),
    appendInput({ transport: { kind: 'mail', id: 'delivery' } }),
    { ...appendInput(), secret: 'must-not-be-stored' },
  ]) {
    await assert.rejects(() => store.append(invalid));
  }
  assert.equal(await store.head(), 0);
});

test('partial/corrupt/wrong-owner archive и symlink не читаются как пустой', async (t) => {
  const { dir, file } = await fixture(t);
  await import('node:fs/promises').then(({ mkdir }) => mkdir(path.dirname(file), { recursive: true }));
  await writeFile(file, '{"partial":true}', { mode: 0o600 });
  let store = new GitHubArchiveStore({ dir, accountRef: ACCOUNT, repositoryId: REPOSITORY });
  await assert.rejects(() => store.head(), (err) => err.code === 'github_archive_invalid');

  await writeFile(file, `${JSON.stringify({
    schemaVersion: 1,
    channel: 'github',
    accountRef: 'acc_FFFFFFFFFFFFFFFFFFFFFF',
    seq: 1,
    transport: { kind: 'webhook', id: 'delivery' },
    semanticKey: githubIssueSemanticKey(REPOSITORY, '1'),
    repositoryId: REPOSITORY,
    issueId: '1',
    occurredAt: 1,
    firstSeq: 1,
    duplicateOfSeq: null,
    snapshot: {},
  })}\n`, { mode: 0o600 });
  store = new GitHubArchiveStore({ dir, accountRef: ACCOUNT, repositoryId: REPOSITORY });
  await assert.rejects(() => store.list(), (err) => err.code === 'github_archive_owner_mismatch');

  const outside = path.join(dir, 'outside.ndjson');
  await writeFile(outside, '', { mode: 0o600 });
  await rm(file);
  await symlink(outside, file);
  store = new GitHubArchiveStore({ dir, accountRef: ACCOUNT, repositoryId: REPOSITORY });
  await assert.rejects(() => store.head(), (err) => err.code === 'github_store_unsafe');
});

test('external file mutation и слишком широкие права обнаруживаются fail-closed', async (t) => {
  const { dir, file } = await fixture(t);
  const store = new GitHubArchiveStore({ dir, accountRef: ACCOUNT, repositoryId: REPOSITORY });
  await store.append(appendInput());
  const replacement = `${file}.replacement`;
  await writeFile(replacement, await readFile(file, 'utf8'), { mode: 0o600 });
  await rename(replacement, file);
  await assert.rejects(() => store.head(), (err) => err.code === 'github_store_changed');

  const cold = new GitHubArchiveStore({ dir, accountRef: ACCOUNT, repositoryId: REPOSITORY });
  await chmod(file, 0o644);
  await assert.rejects(() => cold.head(), (err) => err.code === 'github_store_permissions');
});

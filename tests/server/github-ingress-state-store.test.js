import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { GitHubIngressStateStore } from '../../server/src/lib/github/ingress-state-store.js';

const ACCOUNT = 'acc_github_ingress_state_01';
const REPOSITORY = '123456';
const BOUNDARY = { createdAt: '2026-08-09T12:00:00Z', issueId: '77' };
const diagnostics = (over = {}) => ({
  initialBaseline: false,
  baselineTruncated: false,
  boundaryReached: true,
  exhausted: false,
  limitReached: false,
  pages: 1,
  rows: 2,
  issues: 2,
  pullRequests: 0,
  appended: 1,
  duplicates: 1,
  archiveHeadBefore: 10,
  archiveHead: 11,
  ...over,
});

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'github-ingress-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'ingress-state.json');
  let nowMs = 1_800_000_000_000;
  const store = new GitHubIngressStateStore({
    file,
    accountRef: ACCOUNT,
    repositoryId: REPOSITORY,
    now: () => nowMs++,
  });
  return { file, store };
}

test('missing store не создаёт файл; успешный run атомарно сохраняет exact boundary', async (t) => {
  const { file, store } = await fixture(t);
  const empty = await store.read();
  assert.equal(empty.boundary, null);
  await assert.rejects(readFile(file), (err) => err.code === 'ENOENT');

  const saved = await store.record({ boundary: BOUNDARY, degraded: null, diagnostics: diagnostics() });
  assert.deepEqual(saved.boundary, BOUNDARY);
  assert.equal(saved.lastRunAtMs, 1_800_000_000_000);
  assert.equal((await readFile(file, 'utf8')).includes('secret'), false);
  assert.deepEqual((await store.read()).diagnostics, diagnostics());
});

test('degraded run сохраняет диагностику, но не может продвинуть cursor', async (t) => {
  const { store } = await fixture(t);
  await store.record({ boundary: BOUNDARY, degraded: null, diagnostics: diagnostics() });
  const degraded = await store.record({
    boundary: BOUNDARY,
    degraded: 'reconcile_truncated',
    diagnostics: diagnostics({ boundaryReached: false, limitReached: true }),
  });
  assert.equal(degraded.degraded, 'reconcile_truncated');

  await assert.rejects(store.record({
    boundary: { createdAt: '2026-08-09T13:00:00Z', issueId: '88' },
    degraded: 'reconcile_truncated',
    diagnostics: diagnostics({ boundaryReached: false, limitReached: true }),
  }), (err) => err.code === 'github_ingress_state_cursor_unsafe');
});

test('owner mismatch, partial diagnostics и unknown keys fail closed', async (t) => {
  const { file, store } = await fixture(t);
  await store.record({ boundary: BOUNDARY, degraded: null, diagnostics: diagnostics() });
  const raw = JSON.parse(await readFile(file, 'utf8'));

  await writeFile(file, `${JSON.stringify({ ...raw, accountRef: 'acc_other_owner_0001' })}\n`);
  await assert.rejects(store.read(), (err) => err.code === 'github_ingress_state_owner_mismatch');

  await writeFile(file, `${JSON.stringify({ ...raw, surprise: true })}\n`);
  await assert.rejects(store.read(), (err) => err.code === 'github_ingress_state_invalid');

  await writeFile(file, `${JSON.stringify({ ...raw, diagnostics: { pages: 1 } })}\n`);
  await assert.rejects(store.read(), (err) => err.code === 'github_ingress_state_invalid');
});

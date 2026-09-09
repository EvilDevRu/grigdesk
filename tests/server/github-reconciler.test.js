// Один bounded reconciliation run: реального GitHub, таймеров и файлов здесь нет.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  GitHubArchiveStore,
  githubIssueSemanticKey,
} from '../../server/src/lib/github/archiveStore.ts';
import {
  GitHubReconcileError,
  run,
} from '../../server/src/lib/github/reconciler.ts';

const TOKEN = 'github_pat_test_reconcile_9876';
const OWNER = 'acme';
const REPO = 'support';
const REPOSITORY_ID = '123456';
const ACCOUNT_REF = 'acc_github_7f3a';

function issue(id, createdAt, overrides = {}) {
  return {
    id,
    number: id,
    title: `Issue ${id}`,
    body: `Описание ${id}`,
    created_at: createdAt,
    updated_at: createdAt,
    user: { id: id + 10_000, login: `user-${id}` },
    ...overrides,
  };
}

function pullRequest(id, createdAt) {
  return {
    id,
    number: id,
    created_at: createdAt,
    pull_request: { url: `https://api.github.com/repos/${OWNER}/${REPO}/pulls/${id}` },
  };
}

const boundary = (row) => ({ createdAt: row.created_at, issueId: String(row.id) });

function jsonResponse(rows, link = null) {
  return new Response(JSON.stringify(rows), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      ...(link === null ? {} : { Link: link }),
    },
  });
}

function archiveStub(initialIssueIds = []) {
  const knownSemantic = new Set(initialIssueIds.map(String));
  const knownTransport = new Set();
  const calls = [];
  let seq = knownSemantic.size;
  let headCalls = 0;
  return {
    calls,
    get headCalls() { return headCalls; },
    async head() {
      headCalls += 1;
      return seq;
    },
    async append(entry) {
      calls.push(entry);
      assert.deepEqual(Object.keys(entry).sort(), [
        'issueId', 'occurredAt', 'repositoryId', 'semanticKey', 'snapshot', 'transport',
      ]);
      const transportKey = JSON.stringify(entry.transport);
      const id = String(entry.issueId);
      if (knownTransport.has(transportKey)) {
        return { appended: false, inserted: false, duplicate: true, seq };
      }
      knownTransport.add(transportKey);
      seq += 1;
      if (knownSemantic.has(id)) {
        return { appended: true, inserted: false, duplicate: true, seq };
      }
      knownSemantic.add(id);
      return { appended: true, inserted: true, duplicate: false, seq };
    },
  };
}

function runOptions(overrides = {}) {
  return {
    token: TOKEN,
    owner: OWNER,
    repo: REPO,
    repositoryId: REPOSITORY_ID,
    accountRef: ACCOUNT_REF,
    archive: archiveStub(),
    boundary: null,
    ...overrides,
  };
}

test('идёт по exact Link, фильтрует PR и достигает старую boundary с overlap', async () => {
  const newest = issue(103, '2026-08-09T12:03:00Z');
  const pr = pullRequest(102, '2026-08-09T12:02:00Z');
  const duplicate = issue(101, '2026-08-09T12:01:00Z');
  const old = issue(100, '2026-08-09T12:00:00Z');
  const nextUrl = 'https://api.github.com/repositories/123456/issues?state=all&sort=created&direction=desc&per_page=100&page=2';
  const calls = [];
  const responses = [
    jsonResponse([newest, pr, duplicate], `<${nextUrl}>; rel="next"`),
    jsonResponse([old]),
  ];
  const fetchImpl = async (url) => {
    calls.push(url);
    return responses.shift();
  };
  const archive = archiveStub([100, 101]);

  const result = await run(runOptions({
    archive,
    boundary: boundary(old),
    apiOptions: { fetchImpl },
  }));

  assert.deepEqual(result, {
    boundary: boundary(newest),
    advanced: true,
    degraded: null,
    diagnostics: {
      initialBaseline: false,
      baselineTruncated: false,
      boundaryReached: true,
      exhausted: false,
      limitReached: false,
      pages: 2,
      rows: 4,
      issues: 3,
      pullRequests: 1,
      appended: 1,
      duplicates: 2,
      archiveHeadBefore: 2,
      archiveHead: 5,
    },
  });
  assert.equal(calls[1], nextUrl, 'вторая страница взята из Link, а не вычислена локально');
  assert.deepEqual(archive.calls.map((entry) => ({
    transport: entry.transport,
    repositoryId: entry.repositoryId,
    issueId: entry.issueId,
    semanticKey: entry.semanticKey,
    occurredAt: entry.occurredAt,
    snapshotId: entry.snapshot.id,
  })), [
    {
      transport: { kind: 'rest', id: `rest:${REPOSITORY_ID}:103` },
      repositoryId: REPOSITORY_ID,
      issueId: '103',
      semanticKey: githubIssueSemanticKey(REPOSITORY_ID, '103'),
      occurredAt: Date.parse(newest.created_at) / 1000,
      snapshotId: 103,
    },
    {
      transport: { kind: 'rest', id: `rest:${REPOSITORY_ID}:101` },
      repositoryId: REPOSITORY_ID,
      issueId: '101',
      semanticKey: githubIssueSemanticKey(REPOSITORY_ID, '101'),
      occurredAt: Date.parse(duplicate.created_at) / 1000,
      snapshotId: 101,
    },
    {
      transport: { kind: 'rest', id: `rest:${REPOSITORY_ID}:100` },
      repositoryId: REPOSITORY_ID,
      issueId: '100',
      semanticKey: githubIssueSemanticKey(REPOSITORY_ID, '100'),
      occurredAt: Date.parse(old.created_at) / 1000,
      snapshotId: 100,
    },
  ]);
});

test('limit до старой boundary даёт reconcile_truncated и не продвигает cursor', async () => {
  const newest = issue(103, '2026-08-09T12:03:00Z');
  const middle = issue(102, '2026-08-09T12:02:00Z');
  const old = issue(100, '2026-08-09T12:00:00Z');
  const nextUrl = 'https://api.github.com/repositories/123456/issues?page=2';
  const archive = archiveStub([100]);

  const first = await run(runOptions({
    archive,
    boundary: boundary(old),
    maxPages: 1,
    apiOptions: {
      fetchImpl: async () => jsonResponse([newest, middle], `<${nextUrl}>; rel="next"`),
    },
  }));
  assert.equal(first.degraded, 'reconcile_truncated');
  assert.deepEqual(first.boundary, boundary(old));
  assert.equal(first.advanced, false);
  assert.equal(first.diagnostics.appended, 2);
  assert.equal(first.diagnostics.limitReached, true);

  const responses = [
    jsonResponse([newest, middle], `<${nextUrl}>; rel="next"`),
    jsonResponse([old]),
  ];
  const second = await run(runOptions({
    archive,
    boundary: first.boundary,
    maxPages: 2,
    apiOptions: { fetchImpl: async () => responses.shift() },
  }));
  assert.equal(second.degraded, null);
  assert.deepEqual(second.boundary, boundary(newest));
  assert.equal(second.diagnostics.appended, 0);
  assert.equal(second.diagnostics.duplicates, 3, 'retry безопасно проходит semantic dedupe');
});

test('initial bounded baseline может продвинуться без старой boundary', async () => {
  const newest = issue(200, '2026-08-09T13:00:00Z');
  const next = issue(199, '2026-08-09T12:59:00Z');
  const nextUrl = 'https://api.github.com/repositories/123456/issues?page=2';
  const archive = archiveStub();
  let requestedUrl = '';

  const result = await run(runOptions({
    archive,
    maxRows: 2,
    apiOptions: {
      fetchImpl: async (url) => {
        requestedUrl = url;
        return jsonResponse([newest, next], `<${nextUrl}>; rel="next"`);
      },
    },
  }));

  assert.deepEqual(result.boundary, boundary(newest));
  assert.equal(result.advanced, true);
  assert.equal(result.degraded, null);
  assert.equal(result.diagnostics.initialBaseline, true);
  assert.equal(result.diagnostics.baselineTruncated, true);
  assert.equal(result.diagnostics.limitReached, true);
  assert.equal(result.diagnostics.appended, 2);
  assert.match(requestedUrl, /per_page=2/u, 'первый API page не просит больше maxRows');
});

test('исчерпанный stream без прежней boundary fail-closed не двигает cursor', async () => {
  const newest = issue(103, '2026-08-09T12:03:00Z');
  const missing = { createdAt: '2026-08-09T11:00:00Z', issueId: '50' };
  const archive = archiveStub();
  const result = await run(runOptions({
    archive,
    boundary: missing,
    apiOptions: { fetchImpl: async () => jsonResponse([newest]) },
  }));

  assert.equal(result.degraded, 'reconcile_boundary_missing');
  assert.deepEqual(result.boundary, missing);
  assert.equal(result.advanced, false);
  assert.equal(result.diagnostics.exhausted, true);
  assert.equal(result.diagnostics.appended, 1);
});

test('PR rows участвуют в cursor, но никогда не попадают в archive', async () => {
  const newestPr = pullRequest(301, '2026-08-09T14:01:00Z');
  const oldPr = pullRequest(300, '2026-08-09T14:00:00Z');
  const archive = archiveStub();
  const result = await run(runOptions({
    archive,
    boundary: boundary(oldPr),
    apiOptions: { fetchImpl: async () => jsonResponse([newestPr, oldPr]) },
  }));

  assert.deepEqual(result.boundary, boundary(newestPr));
  assert.equal(result.degraded, null);
  assert.equal(result.diagnostics.boundaryReached, true);
  assert.equal(result.diagnostics.pullRequests, 2);
  assert.equal(result.diagnostics.issues, 0);
  assert.deepEqual(archive.calls, []);
});

test('ошибка одной REST row останавливает run без cursor result', async () => {
  const valid = issue(401, '2026-08-09T15:01:00Z');
  const invalid = issue(400, '2026-08-09T15:00:00Z', { title: '' });
  const archive = archiveStub();

  await assert.rejects(
    () => run(runOptions({
      archive,
      boundary: { createdAt: '2026-08-09T14:00:00Z', issueId: '399' },
      apiOptions: { fetchImpl: async () => jsonResponse([valid, invalid]) },
    })),
    (error) => error.code === 'github_payload_invalid',
  );
  assert.deepEqual(archive.calls.map((entry) => entry.snapshot.id), [401]);
  assert.equal(archive.headCalls, 1, 'финальный head не читается: вызывающий не получает новый cursor');
});

test('reconciliation пишет exact contract настоящего GitHubArchiveStore', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'github-reconciler-archive-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const archive = new GitHubArchiveStore({
    dir,
    accountRef: ACCOUNT_REF,
    repositoryId: REPOSITORY_ID,
  });
  const opened = issue(501, '2026-08-09T16:00:00Z');

  const result = await run(runOptions({
    archive,
    apiOptions: { fetchImpl: async () => jsonResponse([opened]) },
  }));
  const [stored] = await archive.list();

  assert.equal(result.diagnostics.archiveHeadBefore, 0);
  assert.equal(result.diagnostics.archiveHead, 1);
  assert.equal(stored.transport.kind, 'rest');
  assert.equal(stored.transport.id, `rest:${REPOSITORY_ID}:501`);
  assert.equal(stored.repositoryId, REPOSITORY_ID);
  assert.equal(stored.issueId, '501');
  assert.equal(stored.semanticKey, githubIssueSemanticKey(REPOSITORY_ID, '501'));
  assert.equal(stored.occurredAt, Date.parse(opened.created_at) / 1000);
  assert.deepEqual(stored.snapshot, opened);
});

test('повторная reconciliation после edit issue сохраняет первый snapshot и двигает cursor без conflict', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'github-reconciler-edit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const original = issue(601, '2026-08-09T17:00:00Z');
  const firstStore = new GitHubArchiveStore({
    dir,
    accountRef: ACCOUNT_REF,
    repositoryId: REPOSITORY_ID,
  });
  const first = await run(runOptions({
    archive: firstStore,
    apiOptions: { fetchImpl: async () => jsonResponse([original]) },
  }));

  const edited = {
    ...original,
    title: 'Обычное редактирование заголовка',
    body: 'Текст тоже изменился',
    updated_at: '2026-08-09T17:05:00Z',
  };
  const coldStore = new GitHubArchiveStore({
    dir,
    accountRef: ACCOUNT_REF,
    repositoryId: REPOSITORY_ID,
  });
  const second = await run(runOptions({
    archive: coldStore,
    boundary: first.boundary,
    apiOptions: { fetchImpl: async () => jsonResponse([edited]) },
  }));

  assert.equal(second.degraded, null);
  assert.equal(second.advanced, false);
  assert.equal(second.diagnostics.duplicates, 1);
  assert.equal(second.diagnostics.appended, 0);
  assert.equal(second.diagnostics.archiveHead, 1);
  const [stored] = await coldStore.list();
  assert.equal(stored.snapshot.title, original.title);
  assert.equal(stored.snapshot.body, original.body);
  assert.equal(stored.snapshot.updated_at, original.updated_at);
});

test('corrupt boundary и reserved apiOptions отвергаются до archive/network', async (t) => {
  for (const overrides of [
    { boundary: { createdAt: '2026-08-09T12:00:00Z', issueId: 100 } },
    { apiOptions: { page: 9 } },
  ]) {
    await t.test(JSON.stringify(overrides), async () => {
      let headCalled = false;
      let fetched = false;
      await assert.rejects(
        () => run(runOptions({
          ...overrides,
          archive: {
            async head() { headCalled = true; },
            async append() {},
          },
          apiOptions: Object.hasOwn(overrides, 'apiOptions')
            ? overrides.apiOptions
            : { fetchImpl: async () => { fetched = true; } },
        })),
        (error) => error instanceof GitHubReconcileError
          && error.code === 'github_reconcile_invalid',
      );
      assert.equal(headCalled, false);
      assert.equal(fetched, false);
    });
  }
});

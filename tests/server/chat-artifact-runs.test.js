import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CHAT_ARTIFACT_RETENTION_MS, ChatArtifactRuns,
} from '../../server/src/lib/chat/artifactRuns.ts';
import { DocumentReader } from '../../server/src/lib/documents/reader.ts';
import { cleanupArtifacts } from '../../shared/node/artifactsCleanup.ts';
import { acquireDirectoryLock } from '../../shared/node/directoryLock.ts';
import { CHAT_IMAGE_FIXTURES } from '../fixtures/chatImages.mjs';
import {
  chatAppFixture, controlledExecutor, TEST_MODEL_REF, turnBody, waitFor,
} from './helpers/chat-turns.js';

const linux = { skip: process.platform !== 'linux' };
const runId = () => `run-${randomUUID()}`;

test('ARTIFACT-RUN: срок от конца хода, занятость, закрепление и старые темы', linux, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-artifact-runs-'));
  const shared = path.join(root, 'shared');
  const index = path.join(root, 'index');
  const runs = new ChatArtifactRuns(index, shared);

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const completed = await runs.begin('chat', runId(), null);
  const running = await runs.begin('chat', runId(), null);
  const saved = await runs.begin('chat', runId(), null);
  const now = Date.now();
  const expires = now + CHAT_ARTIFACT_RETENTION_MS;

  await fs.writeFile(path.join(saved.directory, '.keep'), '');
  await completed.finish(now);
  await saved.finish(now);
  await fs.mkdir(path.join(shared, 'old-theme'));

  const manual = await cleanupArtifacts({
    root: shared,
    scope: 'artifacts',
    now: expires + CHAT_ARTIFACT_RETENTION_MS,
    dryRun: true,
  });

  assert.equal(manual.entries.find((entry) => entry.path === 'chat-runs').status, 'skipped');
  assert.equal(await new ChatArtifactRuns(index, shared).sweep(expires - 1), 0);
  await fs.access(completed.directory);

  const lock = await acquireDirectoryLock(completed.directory + '.lock', { waitMs: 0 });

  try {
    assert.equal(await runs.sweep(expires), 0);
    await fs.access(completed.directory);
  } finally {
    await lock.release();
  }

  assert.equal(await runs.sweep(expires), 0);
  await assert.rejects(fs.access(completed.directory), { code: 'ENOENT' });
  await fs.access(running.directory);
  await fs.access(saved.directory);
  await fs.access(path.join(shared, 'old-theme'));
  assert.deepEqual(await runs.roots('another-chat'), []);
});

test('ARTIFACT-RUN: замена зарегистрированной папки ссылкой сохраняет цель', linux, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-artifact-link-'));
  const runs = new ChatArtifactRuns(path.join(root, 'index'), path.join(root, 'shared'));
  const outside = path.join(root, 'outside');

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(outside);

  await assert.rejects(runs.begin('chat', runId(), '../outside'), /формат идентификатора проекта/u);

  const output = await runs.begin('chat', runId(), 'project');
  const now = Date.now();

  await output.finish(now);
  await fs.rename(output.directory, output.directory + '-moved');
  await fs.symlink(outside, output.directory);
  await fs.writeFile(path.join(outside, 'important.txt'), 'Сохранить');

  assert.deepEqual(await runs.roots('chat'), []);
  assert.equal(await runs.sweep(now + CHAT_ARTIFACT_RETENTION_MS), 0);
  assert.equal(await fs.readFile(path.join(outside, 'important.txt'), 'utf8'), 'Сохранить');
});

test('ARTIFACT-RUN: общее хранилище проекта и чтение после удаления рабочей копии', linux, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-project-artifact-'));
  const project = path.join(root, 'project');
  const worktree = path.join(root, 'worktree');
  const state = path.join(root, 'state');
  const artifacts = path.join(root, 'artifacts');
  const runs = new ChatArtifactRuns(path.join(state, 'chat-artifact-runs'), artifacts);
  const control = controlledExecutor();
  const reader = new DocumentReader();

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(project);
  await fs.mkdir(worktree);
  control.executor.workdir = { switch: 'resume', roots: 'multi' };

  const expired = await runs.begin('artifact-old-chat', runId(), null);

  await expired.finish(Date.now() - CHAT_ARTIFACT_RETENTION_MS - 1000);

  const { app } = await chatAppFixture(t, {
    root,
    executor: control.executor,
    configOverrides: { dataStateDir: state },
    syntheticPorts: { documentReader: reader },
    prefs: {
      projects: {
        'artifact-project': {
          defaultRepoKey: 'main',
          repos: [
            { key: 'main', dir: project },
            { key: 'worktree', dir: worktree },
          ],
        },
      },
    },
  });
  const id = 'artifact-chat';
  const saved = await app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: {
      chat: {
        id,
        modelRef: TEST_MODEL_REF,
        workdir: {
          kind: 'project',
          projectId: 'artifact-project',
          repoKey: 'worktree',
        },
        messages: [],
        createdAt: Date.now(),
      },
    },
  });

  assert.equal(saved.statusCode, 200, saved.body);
  await waitFor(() => fs.access(expired.directory).then(() => false, (error) => error.code === 'ENOENT'));

  const accepted = await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: turnBody(id, 'artifact-turn-0001', 'Сохрани отчёт'),
  });

  assert.equal(accepted.statusCode, 202, accepted.body);

  const [run] = await control.waitForRuns(1);
  const active = (await app.inject('/api/chat/active')).json().active[0];
  const base = path.join(artifacts, 'chat-runs', 'projects', 'artifact-project');
  const directory = path.join(base, active.runId);
  const frame = path.join(directory, 'frame.png');
  const report = path.join(directory, 'report.md');

  assert.equal(run.options.cwd, worktree);
  assert.ok(run.options.extraDirs.includes(artifacts));
  assert.ok(run.message.includes(directory + '/.'));
  assert.deepEqual(await fs.readdir(project), []);
  assert.deepEqual(await fs.readdir(worktree), []);
  await fs.writeFile(frame, CHAT_IMAGE_FIXTURES.png);
  await fs.writeFile(report, '# Отчёт\n');
  run.release('Готово');
  await waitFor(async () => (await app.inject('/api/chat/active')).json().active.length === 0);

  await fs.rmdir(worktree);

  const response = await app.inject(`/api/chat/${id}/image?path=${encodeURIComponent(frame)}`);

  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.rawPayload, CHAT_IMAGE_FIXTURES.png);

  const resolved = await reader.resolveAbsolute(report, `chat:${id}`);

  assert.equal(resolved.ref.source, `chat:${id}:${active.runId}`);
  assert.equal((await reader.read(resolved.ref)).content, '# Отчёт\n');
});

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, lstat, symlink, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createBrowserEvidence } from '../../server/src/lib/browser/browserEvidence.ts';
import { browserToolResult } from '../../server/src/lib/executors/work-tools/browser.ts';

const proof = {
  task: '7',
  stage: 'CHECK',
  runId: 'run-a',
  epoch: '1',
  attemptId: 'a_' + '1'.repeat(32),
  token: 'synthetic-only',
};
const shot = {
  format: 'grigdesk-work-content-v1',
  content: [{
    type: 'image',
    mimeType: 'image/jpeg',
    data: Buffer.from('jpeg fixture').toString('base64')
  }],
};

test('E01: собственный bounded JPEG path, богатый MCP ответ и очищенный chat ответ', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'browser-evidence-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  const save = createBrowserEvidence(root);
  const prepared = await save.prepare(proof);

  assert.deepEqual(await readdir(prepared), []);

  const result = await save(proof, shot) as typeof shot & { imagePath: string };

  assert.equal(path.dirname(result.imagePath), path.join(root, 'browser-workspace/pipeline',
    proof.task, proof.attemptId, proof.runId));
  assert.equal((await lstat(result.imagePath)).mode & 0o777, 0o600);
  assert.equal(await readFile(result.imagePath, 'utf8'), 'jpeg fixture');
  assert.deepEqual(result.content, shot.content);
  assert.equal(Object.hasOwn(browserToolResult(result, 'screenshot'), 'imagePath'), false);
  await assert.rejects(() => save({ ...proof, runId: '../foreign' }, shot), /browser_/u);

  const invalid = { ...shot, content: [{ ...shot.content[0], data: 'x'.repeat(3 * 1024 * 1024) }] };

  await assert.rejects(() => save(proof, invalid), /browser_result_invalid/u);
});

test('E02: symlink parent и параллельное превышение квоты не создают чужие файлы', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'browser-evidence-guard-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  const foreign = path.join(root, 'foreign');

  await mkdir(foreign);
  await symlink(foreign, path.join(root, 'browser-workspace'));
  await assert.rejects(() => createBrowserEvidence(root)(proof, shot), /browser_evidence_invalid/u);
  await rm(path.join(root, 'browser-workspace'));

  const save = createBrowserEvidence(root);
  const results = await Promise.allSettled(Array.from({ length: 33 }, () => save(proof, shot)));

  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 32);
  assert.equal(results.filter((item) => item.status === 'rejected').length, 1);
});

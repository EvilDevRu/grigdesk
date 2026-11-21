// Контракт GLM host-wrapper в отдельном временном каталоге.
// Ответы модели задаёт локальная HTTP-фикстура.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { testFactoryBinary } from '../helpers/factoryBinary.mjs';
import { fileURLToPath } from 'node:url';

import { normalizeProviderUsage } from '../../server/src/lib/analytics/normalizers.ts';
import { runGlmFactory } from '../../server/scripts/glmRunner.mts';
import { glmCompatibilityIdentity } from '../../server/src/lib/glm/contract.ts';
import { GLM_FACTORY_STATUS_TOOLS } from '../../server/src/lib/glm/factoryPolicy.ts';
import { runGlmTurn } from '../../server/src/lib/glm/runtime.ts';
import { ensureTestDeepSeekBinary } from '../helpers/deepseekBinary.mts';
import { createGlmBinaryFixtureRoot } from '../helpers/glmBinary.mts';
import { startGlmLoopback } from '../helpers/glmLoopback.mts';
import {
  GLM_SERVICE_KEY,
  glmTextReply,
  glmToolCall,
  writeGlmEgressGuard,
} from '../helpers/glmProductionFixture.mts';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

test('SB12c: расход GLM — unavailable, а не нулевой billing', () => {
  const raw = [
    '{"event":"glm_start","mode":"read-only","model":"[\\"zai\\",\\"glm-5.3\\"]"}',
    '{"event":"result","stopReason":"end_turn"}',
  ].join('\n');
  const usage = normalizeProviderUsage({
    provider: 'glm',
    dialect: 'glm-jsonl-unknown',
    rawText: raw,
  });

  assert.equal(usage.source, 'unavailable');
  assert.equal(usage.completeness, 'missing');
  assert.deepEqual(usage.usageSegments, []);
  assert.deepEqual(usage.samples, []);
});

test('state-only: ELF пишет артефакты любого узла в STATE_DIR и отказывает вне корня', {
  timeout: 180_000,
}, async (t) => {
  const candidate = await ensureTestDeepSeekBinary();
  const identity = glmCompatibilityIdentity(candidate.info.glm.inputs, 'api');

  for (const stage of ['DIAGNOSE', 'HYPOSKEPTIC']) {
    await t.test(stage, async (sub) => {
      const root = await createGlmBinaryFixtureRoot('glm-factory-state-');
      const stateDir = path.join(root, 'state with spaces');
      const project = path.join(root, 'project');
      const runDir = path.join(stateDir, 'logs/runs/t42', stage, 'fixture');
      const requestDir = path.join(runDir, 'control-requests');
      const promptFile = path.join(runDir, 'prompt.md');
      const artifact = path.join(stateDir, `t42.${stage.toLowerCase()}.md`);
      const source = path.join(project, 'source.txt');
      const calls = [
        ['read', { file_path: source }],
        ['write', { file_path: artifact, content: 'before' }],
        ['edit', {
          file_path: artifact,
          old_string: 'before',
          new_string: 'diagnosis',
        }],
        ['write', { file_path: source, content: 'forbidden' }],
        ['edit', {
          file_path: source,
          old_string: 'source',
          new_string: 'forbidden',
        }],
        ['write', { file_path: `${stateDir}-other/outside.md`, content: 'forbidden' }],
        ['write', { file_path: path.join(stateDir, 'escape/outside.md'), content: 'forbidden' }],
        ['bash', { command: `echo forbidden > '${project}/shell.txt'`, description: 'outside' }],
        ['bash', { command: 'echo allowed > shell.txt', description: 'inside' }],
        [GLM_FACTORY_STATUS_TOOLS[1], { result: 'done', comment: 'artifact saved' }],
      ];
      const mock = await startGlmLoopback({
        expectedKey: GLM_SERVICE_KEY,
        respond: (_payload, index) => index < calls.length
          ? glmToolCall(calls[index][0], calls[index][1], `call-${index}`)
          : glmTextReply('stage-done'),
      });

      sub.after(async () => {
        await mock.stop();
        await rm(root, { recursive: true, force: true });
      });
      await mkdir(requestDir, { recursive: true, mode: 0o700 });
      await mkdir(project);
      await mkdir(`${stateDir}-other`);
      await writeFile(source, 'source');
      await symlink(project, path.join(stateDir, 'escape'));
      await writeFile(promptFile, 'fixture-stage', { mode: 0o600 });

      const env = {
        PATH: process.env.PATH,
        GRIGDESK_GLM_API_MODE: 'api',
        ZAI_API_KEY: GLM_SERVICE_KEY,
        FACTORY_RUN_TASK: '42',
        FACTORY_RUN_STAGE: stage,
        FACTORY_RUN_ATTEMPT: `a_${'1'.repeat(32)}`,
        FACTORY_STATUS_ENGINE_PROTOCOL: 'go-v1',
        FACTORY_STATUS_ENGINE_HOME: path.join(ROOT, 'engine'),
        FACTORY_STATUS_BIN: testFactoryBinary(),
        FACTORY_RUN_ID: 'fixture',
        FACTORY_RUN_EPOCH: '1',
        FACTORY_STATUS_MODE: 'request',
        FACTORY_STATUS_REQUEST_DIR: requestDir,
        FACTORY_STATE: stateDir,
        STATE_DIR: stateDir,
      };
      const egressGuard = await writeGlmEgressGuard(root);

      await runGlmFactory([
        '--bin', candidate.binary,
        '--cache-dir', candidate.cacheDir,
        '--cwd', stateDir,
        '--mode', 'state-only',
        '--run-dir', runDir,
        '--runtime-home', path.join(runDir, 'glm/runtime'),
        '--prompt-file', promptFile,
        '--model', '["zai","glm-5.3"]',
      ], env, {
        emit: () => {},
        runTurn: (options) => runGlmTurn({ ...options, signal: AbortSignal.timeout(60_000) }, {
          env,
          admission: [{ mode: 'api', compatibility: identity }],
          modelEndpoint: mock.endpoint,
          egressGuard,
          catalog: [{ id: '["zai","glm-5.3"]', efforts: ['low', 'high', 'max'] }],
        }),
      });

      assert.equal(await readFile(artifact, 'utf8'), 'diagnosis');
      assert.equal(await readFile(source, 'utf8'), 'source');
      assert.equal(await readFile(path.join(stateDir, 'shell.txt'), 'utf8'), 'allowed\n');
      assert.deepEqual(await readdir(project), ['source.txt']);
      assert.deepEqual(await readdir(`${stateDir}-other`), []);
      assert.equal(await readFile(path.join(runDir, 'last.md'), 'utf8'), 'stage-done');
      assert.equal(mock.requests.length, calls.length + 1);
      assert.match(JSON.stringify(mock.requests[1].payload.messages.at(-1)), /source/u,
        'исходник вне STATE_DIR доступен для чтения');

      const requests = await readdir(requestDir);

      assert.equal(requests.length, 1, 'stage-result сохранил запрос результата');
      assert.match(await readFile(path.join(requestDir, requests[0]), 'utf8'), /^RESULT=done$/mu);
    });
  }
});

test('SB12a: tripwire glm не даёт случайному живому вызову пройти незамеченным', async () => {
  const code = await new Promise((resolve) => {
    execFile(path.join(ROOT, 'tests/engine/fakes/bin/glm'), ['--version'], (error) => {
      resolve(error ? error.code : 0);
    });
  });

  assert.equal(code, 97);
});

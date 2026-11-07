// Контракт GLM-раннера движка: настоящие shell-тесты движка в собственном TEST_ROOT
// под offline guard. Ответы модели задаёт loopback; реальные ключи и внешняя сеть не участвуют.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
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
const OFFLINE = path.join(ROOT, 'tests/engine/run-offline.sh');

/**
 * Запускает один shell-тест движка штатным воркером run-offline: свой TEST_ROOT,
 * `env -i` и FACTORY_FORBID_LIVE=1. Возвращает код и TAP-вывод для разбора отказа.
 */
async function runEngineTest(t, file) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'glm-runner-contract-'));
  const lock = path.join(directory, 'out.lock');

  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(lock, '');

  return new Promise((resolve) => {
    execFile('bash', [OFFLINE, '--one', path.join(ROOT, file)], {
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        OFFLINE_OUT_LOCK: lock,
      },
      timeout: 300000,
      maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;

      resolve({ code, output: `${stdout}${stderr}` });
    });
  });
}

/**
 * Каждый файл обязан завершиться нулём без единого `not ok`: пустой вывод или
 * обрыв до finish_tests не считается зелёным результатом.
 */
async function assertEngineTests(t, files) {
  for (const file of files) {
    const { code, output } = await runEngineTest(t, file);
    const failures = output.split('\n').filter((line) => line.startsWith('not ok'));

    assert.deepEqual(failures, [], `${file}\n${output}`);
    assert.equal(code, 0, `${file}\n${output}`);
    assert.match(output, /^1\.\.[1-9][0-9]*$/mu, `${file} не дошёл до finish_tests\n${output}`);
  }
}

test('SB12a: GLM-раннер проходит общий контракт, probe и каталог без ключа', async (t) => {
  await assertEngineTests(t, [
    'tests/engine/unit/glm-runner.sh',
    'tests/engine/contract/runner-contract.sh',
    'tests/engine/contract/classifier-fixtures.sh',
  ]);
});

test('GLM modelRef проходит строгую lifecycle-схему на всех границах записи', async (t) => {
  await assertEngineTests(t, ['tests/engine/contract/lifecycle-model-id.sh']);
});

test('SB12b: запуск, классификация, делегирование и остановка этапа GLM', async (t) => {
  await assertEngineTests(t, [
    'tests/engine/unit/glm-runner-launch.sh',
    'tests/engine/contract/classifier-fixtures.sh',
    'tests/engine/integration/glm-runtime-stop.sh',
    'tests/engine/integration/symmetric-failover.sh',
    'tests/engine/integration/runtime-switch.sh',
  ]);
});

test('SB12c: отказ wrapper-а GLM виден в карточке остановки, класс остаётся unknown', async (t) => {
  await assertEngineTests(t, [
    'tests/engine/integration/runner-failure-detail.sh',
    'tests/engine/unit/routes-editor-capabilities.sh',
  ]);
});

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
      await mkdir(requestDir, { recursive: true });
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

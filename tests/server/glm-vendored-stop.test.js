import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createGlmAdapter } from '../../server/src/lib/executors/glm.ts';
import { glmCompatibilityIdentity } from '../../server/src/lib/glm/contract.ts';
import { describeGlmGeneration } from '../../server/src/lib/glm/generation.ts';
import { artifactsPath } from '../../shared/runtime/dataHome.ts';
import { ensureTestDeepSeekArtifact } from '../helpers/deepseekRuntimeArtifact.mts';
import { startGlmLoopback } from '../helpers/glmLoopback.mts';
import {
  GLM_SERVICE_KEY,
  glmTextReply,
  glmToolCall,
  writeGlmEgressGuard,
} from '../helpers/glmProductionFixture.mts';

const ARTIFACTS = path.join(artifactsPath({ env: process.env, home: os.homedir() }), 'glm/G10/fixtures');
const MODEL = '["zai","glm-5.3"]';

/**
 * Ожидание состояния коротким опросом с пределом попыток.
 * Предел превращает зависание в понятный провал теста.
 */
async function waitFor(probe, attempts = 1500) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await probe();

    if (value) {
      return value;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error('ожидаемое состояние не наступило');
}

/**
 * Стенд остановки: настоящая generation, фейк Z.ai, DI-адаптер; процессы запуска видны тесту,
 * чтобы «уронить» runtime посреди хода. Эффекты инструментов — строки в файле маркера.
 */
async function fixture(t, loopbackOptions) {
  const artifact = await ensureTestDeepSeekArtifact();

  await fs.mkdir(ARTIFACTS, { recursive: true });

  const root = await fs.mkdtemp(path.join(ARTIFACTS, 'stop-'));
  const project = path.join(root, 'project');
  const mock = await startGlmLoopback({
    expectedKey: GLM_SERVICE_KEY,
    ...loopbackOptions,
  });
  const children = [];
  const config = {
    rootDir: root,
    deepseekArtifactDir: artifact,
    deepseekRuntimeMode: 'embedded',
    glmRuntimeHome: path.join(root, 'glm-home'),
  };
  const identity = glmCompatibilityIdentity(describeGlmGeneration(config).runtime, 'api');
  const adapter = createGlmAdapter({
    env: {
      PATH: process.env.PATH,
      HOME: root,
      GRIGDESK_GLM_API_MODE: 'api',
      ZAI_API_KEY: GLM_SERVICE_KEY,
    },
    admission: [{ mode: 'api', compatibility: identity }],
    catalog: [{ id: MODEL, efforts: ['low', 'high', 'max'] }],
    modelEndpoint: mock.endpoint,
    egressGuard: await writeGlmEgressGuard(path.join(root, 'guard')),
    spawn: (...args) => {
      const child = spawn(...args);

      children.push(child);

      return child;
    },
  });

  await fs.mkdir(path.join(project, '.git'), { recursive: true });
  t.after(async () => {
    for (const child of children) {
      child.kill('SIGKILL');
    }

    await fs.rm(root, { recursive: true, force: true });
    await mock.stop();
  });

  return {
    root,
    project,
    mock,
    children,
    marker: async () => (await fs.readFile(path.join(project, 'marker.log'), 'utf8').catch(() => ''))
      .split('\n').filter(Boolean).length,
    run: (options = {}) => adapter.run({
      config,
      cwd: project,
      chatKey: 'fixture-chat',
      message: 'fixture-prompt',
      model: MODEL,
      onSessionCreated: async () => {},
      ...options,
    }),
  };
}

function exists(file) {
  return fs.stat(file).then(() => true, () => false);
}

test('настоящий стоп во время инструмента и во время ожидания approval', async (t) => {
  await t.test('инструмент', async (sub) => {
    const f = await fixture(sub, { respond: (_payload, index) => index === 0
      ? glmToolCall('bash', {
        command: 'echo started > started.txt; sleep 30; echo done > after.txt',
        description: 'long',
      })
      : glmTextReply() });
    const controller = new AbortController();
    const running = f.run({ signal: controller.signal });

    await waitFor(() => exists(path.join(f.project, 'started.txt')));
    controller.abort();
    await assert.rejects(running, (error) => error.stopped === true);
    await new Promise((resolve) => setTimeout(resolve, 1000));

    assert.equal(await exists(path.join(f.project, 'after.txt')), false);
    assert.ok(f.children.every((child) => child.exitCode !== null || child.signalCode !== null));
    assert.equal(f.mock.requests.length, 1);
  });

  await t.test('approval', async (sub) => {
    let target;
    const asked = Promise.withResolvers();
    const f = await fixture(sub, { respond: (_payload, index) => index === 0
      ? glmToolCall('write', {
        file_path: target,
        content: 'late',
        sandbox_permissions: 'danger-full-access',
        justification: 'запись вне проекта',
      })
      : glmTextReply() });
    const controller = new AbortController();

    target = path.join(f.root, 'late.txt');

    const running = f.run({
      signal: controller.signal,
      onPermission: () => {
        asked.resolve();

        return new Promise(() => {});
      },
    });

    await asked.promise;
    controller.abort();
    await assert.rejects(running, (error) => error.stopped === true);

    assert.equal(await exists(target), false);
    assert.equal(f.mock.requests.length, 1);
  });
});

const KILL_TEST = 'настоящий kill после эффекта маркера до сохранения результата: '
  + 'следующий явный ход не повторяет эффект сам';
const RETRY_TEST = 'настоящий повторный вызов моделью после краша — '
  + 'новый callId и новый проход hook и approval';

/**
 * Первый ход: инструмент пишет строку маркера и зависает; runtime убивается после эффекта.
 * Возвращает ошибку прерванного хода с sessionId для следующего явного хода.
 */
async function crashAfterEffect(f) {
  const running = f.run();

  running.catch(() => {});
  await waitFor(async () => (await f.marker()) === 1);
  f.children[0].kill('SIGKILL');

  return running.then(() => assert.fail('ход после kill не должен завершиться успехом'), (error) => error);
}

test(KILL_TEST, async (t) => {
  const f = await fixture(t, { respond: (_payload, index) => index === 0
    ? glmToolCall('bash', { command: 'echo effect >> marker.log; sleep 30', description: 'effect' })
    : glmTextReply('continued') });
  const crashed = await crashAfterEffect(f);
  const next = await f.run({ sessionId: crashed.sessionId, message: 'continue-prompt' });
  const messages = JSON.stringify(f.mock.requests.at(-1).payload.messages);

  t.diagnostic(JSON.stringify({
    code: crashed.code,
    tail: f.mock.requests.at(-1).payload.messages.slice(-3),
  }));
  assert.equal(crashed.code, 'glm_ambiguous_outcome');
  assert.equal(next.reply, 'continued');
  assert.equal(await f.marker(), 1, 'эффект не повторён runtime');
  // Восстановление DSH дописывает модели исход «неизвестен» вместо повтора вызова.
  assert.match(messages, /outcome is unknown/u);
});

test(RETRY_TEST, async (t) => {
  const f = await fixture(t, { respond: (_payload, index) => [
    glmToolCall('bash', { command: 'echo effect >> marker.log; sleep 30', description: 'effect' }, 'call-1'),
    glmToolCall('bash', { command: 'echo effect >> marker.log', description: 'effect again' }, 'call-2'),
  ][index] ?? glmTextReply('retried') });
  const crashed = await crashAfterEffect(f);
  const steps = [];
  const next = await f.run({
    sessionId: crashed.sessionId,
    message: 'continue-prompt',
    onStep: (step) => steps.push(step),
  });

  assert.equal(next.reply, 'retried');
  assert.equal(await f.marker(), 2, 'повтор — только решением модели');
  assert.ok(steps.some((step) => step.k === 'tool' && step.id === 'call-2'));
  assert.ok(steps.some((step) => step.k === 'res'));
});

test('настоящее восстановление принятой очереди не отправляет старый prompt заново', async (t) => {
  const arrived = Promise.withResolvers();
  const f = await fixture(t, { respond: async (_payload, index) => {
    if (index === 0) {
      arrived.resolve();
      await new Promise(() => {});
    }

    return glmTextReply('fresh');
  } });
  const running = f.run({ message: 'old-prompt' });

  running.catch(() => {});
  await arrived.promise;
  f.children[0].kill('SIGKILL');

  const crashed = await running.then(() => null, (error) => error);
  const next = await f.run({ sessionId: crashed.sessionId, message: 'new-prompt' });
  // Фейк записывает запрос после ответа: зависший первый запрос в журнал не попал.
  const later = f.mock.requests.map((request) => JSON.stringify(request.payload.messages));

  assert.equal(next.reply, 'fresh');
  assert.equal(later.length, 1);
  assert.ok(later.every((text) => text.includes('new-prompt')));
  assert.ok(later.every((text) => text.split('old-prompt').length - 1 <= 1), 'старый prompt не повторён');
});

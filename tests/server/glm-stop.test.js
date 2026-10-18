import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { getEventListeners } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { createGlmAdapter } from '../../server/src/lib/executors/glm.ts';
import { glmCompatibilityIdentity } from '../../server/src/lib/glm/contract.ts';
import { describeGlmGeneration } from '../../server/src/lib/glm/generation.ts';
import { glmChatHome } from '../../server/src/lib/glm/launch.ts';
import { GLM_FIXTURE_PLUGIN, writeGlmArtifactFixture } from '../helpers/glmArtifactFixture.mts';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const FAKE_WEB = path.join(REPO_ROOT, 'tests/fixtures/deepseek-harness/fakeWeb.mjs');
const MODEL = '["zai","glm-5.3"]';
const TEXT = { updates: [{ sessionUpdate: 'agent_message_chunk', content: { text: 'ok' } }] };

/**
 * Ожидание состояния коротким опросом с пределом попыток.
 * Предел превращает зависание в понятный провал теста.
 */
async function waitFor(probe, attempts = 500) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await probe();

    if (value) {
      return value;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error('ожидаемое состояние не наступило');
}

/**
 * Стенд остановки: generation-фикстура с фейковым DSH web, журнал запросов и учёт процессов.
 * Проверки смотрят на prompt, на процессы своего дерева и на каталоги запуска.
 */
async function fixture(t, scenario = TEXT) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glm-stop-'));
  const project = path.join(root, 'project');
  const scenarioFile = path.join(root, 'scenario.json');
  const logFile = path.join(root, 'fake.ndjson');
  const children = [];

  await fs.mkdir(path.join(project, '.git'), { recursive: true });
  await fs.writeFile(scenarioFile, JSON.stringify(scenario));
  await fs.writeFile(logFile, '');
  await writeGlmArtifactFixture(path.join(root, 'generation'), {
    llmPiAi: GLM_FIXTURE_PLUGIN,
    entry: [
      'if (process.argv[2] === "-V") { console.log("0.1.5-rc.2"); process.exit(0); }',
      `process.argv.push("--scenario", ${JSON.stringify(scenarioFile)},`
        + ` "--log", ${JSON.stringify(logFile)});`,
      `await import(${JSON.stringify(pathToFileURL(FAKE_WEB).href)});`,
      '',
    ].join('\n'),
  });
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }

    await fs.rm(root, { recursive: true, force: true });
  });

  const config = {
    rootDir: root,
    deepseekArtifactDir: path.join(root, 'generation'),
    deepseekRuntimeMode: 'embedded',
    glmRuntimeHome: path.join(root, 'glm-home'),
  };
  const identity = glmCompatibilityIdentity(describeGlmGeneration(config).runtime, 'api');
  const adapter = createGlmAdapter({
    env: {
      PATH: process.env.PATH,
      GRIGDESK_GLM_API_MODE: 'api',
      ZAI_API_KEY: 'synthetic-zai-key',
    },
    admission: [{ mode: 'api', compatibility: identity }],
    spawn: (...args) => {
      const child = spawn(...args);

      children.push(child);

      return child;
    },
  });

  return {
    root,
    project,
    config,
    identity,
    children,
    log: async () => (await fs.readFile(logFile, 'utf8')).split('\n').filter(Boolean).map(JSON.parse),
    async methods() {
      return (await this.log()).map((entry) => entry.message?.method).filter(Boolean);
    },
    turns: () => path.join(config.glmRuntimeHome, identity.slice(0, 16), 'turns'),
    run(options = {}) {
      return adapter.run({
        config,
        cwd: project,
        chatKey: 'chat-a',
        message: 'fixture-prompt',
        model: MODEL,
        onSessionCreated: async () => {},
        ...options,
      });
    },
  };
}

test('стоп до spawn, во время binding и перед prompt — ни одного prompt', async (t) => {
  for (const stage of ['spawn', 'binding', 'prompt']) {
    await t.test(stage, async (sub) => {
      const f = await fixture(sub, { ...TEXT, delay: { 'session/follow': 1500 } });
      const controller = new AbortController();

      if (stage === 'spawn') {
        controller.abort();
      } else if (stage === 'prompt') {
        const opened = async () => (await f.log())
          .some((entry) => entry.message?.endpoint === 'session/follow');

        void waitFor(opened).then(() => controller.abort());
      }

      await assert.rejects(f.run({
        signal: controller.signal,
        onSessionCreated: async () => {
          if (stage === 'binding') {
            controller.abort();
          }
        },
      }), (error) => error.stopped === true);

      assert.equal((await f.methods()).includes('session/prompt'), false);
      assert.equal(f.children.length, stage === 'spawn' ? 0 : 1);
    });
  }
});

const HANG_TEST = 'зависший процесс получает cancel, ограниченное ожидание, '
  + 'затем kill только своего дерева';

test(HANG_TEST, async (t) => {
  const f = await fixture(t, {
    updates: [],
    waitForCancel: true,
    hang: true,
  });
  const bystander = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  const controller = new AbortController();

  t.after(() => bystander.kill('SIGKILL'));

  const running = f.run({ signal: controller.signal });

  await waitFor(async () => (await f.methods()).includes('session/prompt'));

  const started = Date.now();

  controller.abort();
  await assert.rejects(running, (error) => error.stopped === true);

  const elapsed = Date.now() - started;

  t.diagnostic(JSON.stringify({
    elapsed,
    exit: f.children.map((child) => [child.pid, child.exitCode, child.signalCode, child.killed]),
  }));
  assert.ok((await f.methods()).includes('session/cancel'), 'cancel отправлен');
  assert.equal(f.children[0].signalCode, 'SIGKILL');
  assert.ok(elapsed < 10_000, `ограниченное ожидание: ${elapsed} мс`);
  assert.equal(bystander.exitCode, null);
  assert.equal(bystander.signalCode, null, 'чужой процесс не тронут');
});

test('очистка идемпотентна: таймеры, слушатели, порты, одноразовые файлы; home сохраняется', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const result = await f.run({ signal: controller.signal });

  assert.equal(result.reply, 'ok');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0, 'слушатели abort сняты');
  assert.deepEqual(await fs.readdir(f.turns()), [], 'каталоги запуска удалены');
  assert.ok((await fs.stat(glmChatHome(f.config.glmRuntimeHome, f.identity, 'chat-a'))).isDirectory());
  assert.ok(f.children.every((child) => child.exitCode !== null || child.signalCode !== null));

  // Повторный ход в том же чате после очистки идёт штатно: ничего не осталось занятым.
  assert.equal((await f.run({ signal: controller.signal })).reply, 'ok');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { runtimeYaml } from '../../tools/runtimeComposition.ts';
import { ensureTestDeepSeekArtifact } from '../helpers/deepseekRuntimeArtifact.mts';
import { runGlmTurn } from '../helpers/glmDriver.mts';
import { startGlmLoopback } from '../helpers/glmLoopback.mts';
import {
  GLM_SERVICE_KEY,
  glmHookEntries,
  glmTextReply,
  glmToolCall,
  startGlmProductionProcess,
} from '../helpers/glmProductionFixture.mts';

const ARTIFACTS = path.resolve(import.meta.dirname, '../../.state/artifacts/glm/G4/fixtures');

/**
 * Стенд production-профиля: настоящая generation, фейк Z.ai и отдельные каталоги.
 * Процесс поднимает production launcher; тест подменяет только адрес модели (Р16).
 */
async function fixture(t, loopbackOptions = {}, { dirName = 'profile-' } = {}) {
  const artifact = await ensureTestDeepSeekArtifact();

  await fs.mkdir(ARTIFACTS, { recursive: true });

  const root = await fs.mkdtemp(path.join(ARTIFACTS, dirName));
  const cwd = path.join(root, 'project');
  const mock = await startGlmLoopback({
    expectedKey: GLM_SERVICE_KEY,
    ...loopbackOptions,
  });
  const started = [];

  await fs.mkdir(path.join(cwd, '.git'), { recursive: true });
  t.after(async () => {
    for (const item of started) {
      await item.server.stop();
    }

    await fs.rm(root, { recursive: true, force: true });
    await mock.stop();
  });

  return {
    artifact,
    root,
    cwd,
    mock,
    /**
     * Запуск процесса GLM; остановка регистрируется заранее.
     * Тест может подложить файлы до подготовки или передать окружение службы.
     */
    async start(options = {}) {
      const item = await startGlmProductionProcess({
        artifact,
        root,
        cwd,
        endpoint: mock.endpoint,
        ...options,
      });

      started.push(item);

      return item;
    },
  };
}

function replyText(turn) {
  return turn.chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('');
}

test('настоящий процесс GLM через production launcher отвечает через фейк Z.ai', async (t) => {
  const f = await fixture(t, { scenarios: [glmTextReply('glm-production-ok')] });
  const { server } = await f.start();
  const turn = await runGlmTurn(server, {
    cwd: f.cwd,
    message: 'production-prompt',
    model: 'glm-5.3',
    effort: 'high',
  });

  assert.equal(turn.turnEnd.data.reason.kind, 'completed');
  assert.equal(replyText(turn), 'glm-production-ok');
  assert.equal(f.mock.requests.length, 1);
  assert.equal(f.mock.requests[0].path, '/api/paas/v4/chat/completions');
  assert.equal(f.mock.requests[0].authorizationMatches, true);
  assert.deepEqual(f.mock.requests[0].thinking, { type: 'enabled', clear_thinking: false });
});

test('настоящий процесс GLM не берёт DEEPSEEK_API_KEY и ZAI_API_KEY из .env проекта', async (t) => {
  const f = await fixture(t, { scenarios: [glmTextReply()] });
  const dotenv = [
    'DEEPSEEK_API_KEY=dotenv-deepseek',
    'ZAI_API_KEY=dotenv-zai',
    'ZAI_CODING_API_KEY=dotenv-zai-coding',
    'COCKPIT_GLM_ROUTE_KEY=dotenv-route',
    '',
  ].join('\n');

  await fs.writeFile(path.join(f.cwd, '.env'), dotenv);

  const { server } = await f.start({
    beforeLaunch: ({ dshHome }) => fs.writeFile(path.join(dshHome, '.env'), dotenv),
  });

  await runGlmTurn(server, {
    cwd: f.cwd,
    message: 'dotenv',
    model: 'glm-5.3',
  });

  assert.equal(f.mock.requests.length, 1);
  assert.equal(f.mock.requests[0].authorizationMatches, true);
});

test('настоящий процесс GLM не применяет retryPolicy, baseURL и headers, подложенные в settings-документ',
  async (t) => {
    const other = await startGlmLoopback({ expectedKey: GLM_SERVICE_KEY, respond: () => glmTextReply() });
    const f = await fixture(t, { scenarios: [{
      kind: 'http-error',
      status: 429,
      code: '1302',
      message: 'Rate limit reached for requests',
    }] });

    t.after(() => other.stop());

    const { server, launch } = await f.start({
      beforeLaunch: ({ dshHome }) => fs.writeFile(path.join(dshHome, 'settings.yaml'), JSON.stringify({
        'llm-pi-ai': { providers: { zai: {
          baseURL: other.endpoint,
          retryPolicy: { mode: 'normal', maxRetries: 3 },
          headers: { 'x-cockpit-hijack': '1' },
        } } },
      })),
    });
    const turn = await runGlmTurn(server, {
    cwd: f.cwd,
    message: 'settings',
    model: 'glm-5.3',
  });

    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Факт G4: DSH сам сохраняет в документ выбор модели, но секции llm-pi-ai там нет.
    const document = runtimeYaml().load(await fs.readFile(launch.settingsDocument, 'utf8'));

    assert.equal(Object.hasOwn(document ?? {}, 'llm-pi-ai'), false);
    assert.equal(turn.turnEnd.data.reason.error.code, 'RATE_LIMIT');
    assert.equal(other.requests.length, 0);
    assert.equal(f.mock.requests.length, 1);
    assert.equal(f.mock.requests[0].headerNames.includes('x-cockpit-hijack'), false);
  });

test('настоящий hook процесса GLM не видит COCKPIT_GLM_ROUTE_KEY', async (t) => {
  const f = await fixture(t, { respond: (_payload, index) => index === 0
    ? glmToolCall('read', { file_path: 'note.txt' })
    : glmTextReply() });
  const { server } = await f.start({ source: { DEEPSEEK_API_KEY: 'synthetic-deepseek' } });
  const turn = await runGlmTurn(server, {
    cwd: f.cwd,
    message: 'hook-env',
    model: 'glm-5.3',
  });
  // Маркер политики несёт имена окружения hook (G6: полный hook вместо заглушки).
  const entries = glmHookEntries(turn.events).filter((entry) => entry.marker === 'hooks-alive');

  assert.equal(entries.length, 1);
  assert.ok(entries[0].envNames.includes('CLAUDE_PROJECT_DIR'), 'положительный контроль окружения hook');

  for (const name of ['COCKPIT_GLM_ROUTE_KEY', 'ZAI_API_KEY', 'ZAI_CODING_API_KEY', 'DEEPSEEK_API_KEY']) {
    assert.equal(entries[0].envNames.includes(name), false, name);
  }
});

test('настоящие инструкции AGENTS.md, CLAUDE.md и @CLAUDE.local.md попадают в запрос один раз и по порядку',
  async (t) => {
    const f = await fixture(t, { scenarios: [glmTextReply()] });

    await fs.writeFile(path.join(f.cwd, 'AGENTS.md'), 'GLM-AGENTS-MARK\n');
    await fs.writeFile(path.join(f.cwd, 'CLAUDE.md'), 'GLM-CLAUDE-MARK\n@CLAUDE.local.md\n');
    await fs.writeFile(path.join(f.cwd, 'CLAUDE.local.md'), 'GLM-LOCAL-MARK\n');

    const { server } = await f.start();

    await runGlmTurn(server, {
    cwd: f.cwd,
    message: 'instructions',
    model: 'glm-5.3',
  });

    const text = JSON.stringify(f.mock.requests[0].payload.messages);
    const positions = ['GLM-AGENTS-MARK', 'GLM-CLAUDE-MARK', 'GLM-LOCAL-MARK'].map((mark) => {
      assert.equal(text.split(mark).length - 1, 1, mark);

      return text.indexOf(mark);
    });

    assert.deepEqual([...positions].sort((left, right) => left - right), positions);
  });

test('настоящий ход делает только запросы хода: без заголовка и вспомогательных моделей', async (t) => {
  const f = await fixture(t, { scenarios: [glmTextReply()] });
  const { server } = await f.start();
  const turn = await runGlmTurn(server, {
    cwd: f.cwd,
    message: 'only-turn',
    model: 'glm-5.3',
  });

  await new Promise((resolve) => setTimeout(resolve, 1000));

  assert.equal(turn.turnEnd.data.reason.kind, 'completed');
  assert.equal(f.mock.requests.length, 1);
  assert.equal(f.mock.requests[0].model, 'glm-5.3');
});

test('настоящий запуск из пути с пробелами и чистка закрывают порт и процессы', async (t) => {
  const f = await fixture(t, { scenarios: [glmTextReply()] }, { dirName: 'path with spaces ' });
  const { server, launch, children } = await f.start();

  await runGlmTurn(server, {
    cwd: f.cwd,
    message: 'spaces',
    model: 'glm-5.3',
  });

  const address = server.client.baseUrl;

  await server.stop();

  await assert.rejects(fetch(address, { signal: AbortSignal.timeout(2000) }));
  assert.ok(children.length > 0);
  assert.ok(children.every((child) => child.exitCode !== null || child.signalCode !== null));
  await assert.rejects(fs.stat(launch.launchDir), { code: 'ENOENT' });
  assert.ok((await fs.stat(launch.dshHome)).isDirectory(), 'home чата сохраняется');
});

// С G6 заглушку заменил полный hook: проверяется отказ вне политики до эффекта.
test('настоящий hook политики запрещает инструменты вне политики до эффекта', async (t) => {
  const calls = [
    ['bash', { command: 'ssh -p 9 x@127.0.0.1; echo effect > bash-effect.txt', description: 'ssh' }],
    ['skill', { name: 'fixture-skill' }],
  ];
  const f = await fixture(t, { respond: (_payload, index) => index < calls.length
    ? glmToolCall(calls[index][0], calls[index][1], `call-${index}`)
    : glmTextReply() });
  const { server } = await f.start();
  const turn = await runGlmTurn(server, {
    cwd: f.cwd,
    message: 'stub',
    model: 'glm-5.3',
  });
  const entries = glmHookEntries(turn.events).filter((entry) => entry.point === 'PreToolUse');

  assert.deepEqual(entries.map((entry) => [entry.name, entry.decision, entry.exitCode]), [
    ['bash', 'deny', 2],
    ['skill', 'deny', 2],
  ]);
  await assert.rejects(fs.stat(path.join(f.cwd, 'bash-effect.txt')), { code: 'ENOENT' });
});

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { createGlmAdapter } from '../../server/src/lib/executors/glm.ts';
import { GLM_SEARCH_KEY_ENV } from '../../server/src/lib/glm/env.ts';
import { ensureTestDeepSeekBinary } from '../helpers/deepseekBinary.mts';
import { glmBinaryFixture } from '../helpers/glmBinary.mts';
import { glmTextReply, glmToolCall } from '../helpers/glmProductionFixture.mts';

test('Настоящий GLM видит цели только по явной команде и выполняет нативный раунд', {
  timeout: 900_000,
}, async (t) => {
  const candidate = await ensureTestDeepSeekBinary();
  const fixture = await glmBinaryFixture(t, {
    pair: { a: candidate, b: candidate },
    respond: (payload, index) => {
      const tools = JSON.stringify(payload.tools ?? []);

      assert.doesNotMatch(tools, /"(?:web_search|workflow)"/u);

      if (index === 0) {
        assert.doesNotMatch(tools, /"create_goal"/u);

        return glmTextReply('Обычный ход');
      }
      if (index === 1) {
        assert.match(tools, /"create_goal"/u);

        return glmToolCall('create_goal', { objective: 'Синтетическая цель', max_goal_rounds: 1 });
      }

      return glmTextReply(index === 2 ? 'Ответ до раунда' : 'Ответ раунда');
    },
  });

  const first = await fixture.run();
  const result = await fixture.run({
    sessionId: first.sessionId,
    message: '/goal Синтетическая цель',
    userMessage: '/goal Синтетическая цель',
  });

  assert.equal(result.sessionId, first.sessionId);
  assert.equal(result.reply, 'Ответ раунда');
  assert.equal(fixture.mock.requests.length, 4);
  assert.ok(result.steps?.some((step) => step.label === 'goalRound' && step.round === 1));
  assert.ok(result.steps?.some((step) => step.label === 'goalState' && step.phase === 'blocked'));
});

test('Стоп цели не запускает следующий раунд и требует явного возобновления', {
  timeout: 900_000,
}, async (t) => {
  const candidate = await ensureTestDeepSeekBinary();
  const controller = new AbortController();
  const fixture = await glmBinaryFixture(t, {
    pair: { a: candidate, b: candidate },
    respond: async (payload, index) => {
      if (index === 0) {
        return glmToolCall('create_goal', { objective: 'Остановить после старта', max_goal_rounds: 3 });
      }
      if (JSON.stringify(payload.messages).includes('<goal_round>')) {
        await pause(350);
      }

      return glmTextReply();
    },
  });
  let sessionId = '';
  let goalRounds = 0;

  await assert.rejects(fixture.run({
    message: '/goal Остановить после старта',
    userMessage: '/goal Остановить после старта',
    signal: controller.signal,
    onSessionCreated: (id) => {
      sessionId = id;
    },
    onStep: (step) => {
      if (step.label === 'goalRound') {
        goalRounds += 1;
        controller.abort();
      }
    },
  }), { stopped: true });

  const before = fixture.mock.requests.length;

  assert.equal(goalRounds, 1);
  assert.ok(sessionId);
  await fixture.run({ sessionId, message: 'Обычный ход.' });
  assert.equal(fixture.mock.requests.length, before + 1);

  const resumed = await fixture.run({ sessionId, message: '/goal resume', userMessage: '/goal resume' });

  assert.equal(resumed.sessionId, sessionId);
  assert.ok(resumed.steps?.some((step) => step.label === 'goalRound'));
});

test('Настоящий GLM запускает выбранный MCP и вызывает его только после двух решений', {
  timeout: 900_000,
}, async (t) => {
  const candidate = await ensureTestDeepSeekBinary();

  for (const allowCall of [false, true]) {
    await t.test(`вызов ${allowCall ? 'разрешён' : 'отклонён'}`, async (scenario) => {
      const fixture = await glmBinaryFixture(scenario, {
        pair: { a: candidate, b: candidate },
        respond: (payload, index) => {
          assert.match(JSON.stringify(payload.tools ?? []), /"mcp__fixture__echo"/u);

          return index === 0 ? glmToolCall('mcp__fixture__echo', { action: 'check' }) : glmTextReply();
        },
      });
      const marker = path.join(fixture.root, 'project-calls');
      const script = fileURLToPath(new URL('../fixtures/deepseek-harness/toolPermissionMcp.mjs', import.meta.url));
      const asked: unknown[] = [];

      await fs.writeFile(path.join(fixture.cwd, '.mcp.json'), JSON.stringify({
        mcpServers: { fixture: { command: process.execPath, args: [script, marker, 'echo'] } },
      }));
      await fixture.run({
        message: '/mcp fixture Выполни синтетическую проверку',
        userMessage: '/mcp fixture Выполни синтетическую проверку',
        permissionMode: 'auto',
        onPermission: async (question) => {
          assert.equal(question.requiresExplicitUser, true);
          asked.push(question.tool);

          return { allow: asked.length === 1 || allowCall };
        },
      });

      assert.deepEqual(asked, ['MCP: fixture', 'mcp__fixture__echo']);
      assert.equal(await fs.readFile(`${marker}.started`, 'utf8'), 'started\n');

      if (allowCall) {
        assert.deepEqual(JSON.parse(await fs.readFile(marker, 'utf8')), { action: 'check' });
      } else {
        await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
      }
    });
  }
});

test('Настоящий GLM видит настроенный поиск и получает источники от провайдера', {
  timeout: 900_000,
}, async (t) => {
  const candidate = await ensureTestDeepSeekBinary();
  const fixture = await glmBinaryFixture(t, {
    pair: { a: candidate, b: candidate },
    respond: (payload, index) => {
      assert.match(JSON.stringify(payload.tools ?? []), /"web_search"/u);

      return index === 0 ? glmToolCall('web_search', { queries: ['synthetic-query'] }) : glmTextReply();
    },
  });
  const guard = path.join(fixture.root, 'search-guard.mjs');

  await fs.writeFile(guard, `
    export const name = 'glm-search-test-guard';
    export function apply() {
      const fetchLoopback = globalThis.fetch;
      globalThis.fetch = (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
        if (url.hostname === '127.0.0.1') return fetchLoopback(input, init);
        if (url.hostname !== 'api.deepseek.com' || !url.pathname.endsWith('/messages')) {
          throw new Error('Внешние запросы стенда запрещены');
        }
        if (new Headers(init.headers).get('x-api-key') !== 'synthetic-search-key') {
          throw new Error('Поиск отправил неверный ключ');
        }
        return new Response(JSON.stringify({ content: [{ type: 'web_search_tool_result', content: [{
          type: 'web_search_result', url: 'https://search.example.test/result', title: 'Синтетический результат',
        }] }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      };
    }
  `);

  const adapter = createGlmAdapter({
    ...fixture.deps,
    env: { ...fixture.deps.env, [GLM_SEARCH_KEY_ENV]: 'synthetic-search-key' },
    egressGuard: guard,
  });
  const result = await adapter.run!({
    config: fixture.config,
    cwd: fixture.cwd,
    chatKey: 'search-fixture',
    model: fixture.model,
    message: 'Найди синтетический источник.',
    signal: AbortSignal.timeout(60_000),
    onSessionCreated: async () => {},
  });

  assert.ok(result.steps?.some((step) => step.k === 'res' && step.ok === true
    && String(step.text).includes('https://search.example.test/result')));
});

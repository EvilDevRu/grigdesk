import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { GLM_GOAL_ROUND_LIMIT } from '../../server/src/lib/glm/contract.ts';
import { GLM_SEARCH_KEY_ENV, buildGlmChildEnv } from '../../server/src/lib/glm/env.ts';
import { approveGlmProjectMcp, listGlmProjectMcpNames } from '../../server/src/lib/glm/mcp.ts';
import { decideGlmBaseTool, decideGlmTool, parseGlmToolPolicy } from '../../server/src/lib/glm/policy.ts';

const base = { workTools: ['grigdesk_help'], ssh: true, db: true, strictDb: true };

test('Цель, поиск и выбранный проектный MCP проверяются политикой текущего чата', () => {
  const chat = parseGlmToolPolicy({ ...base, delegation: 'foreground-v1', search: false });
  const selected = parseGlmToolPolicy({ ...chat, goal: true, search: true, projectMcp: 'fixture' });

  assert.equal(decideGlmTool('get_goal', {}, chat).allow, true);
  assert.equal(decideGlmTool('create_goal', {}, chat).allow, false);
  assert.equal(decideGlmTool('create_goal', { max_goal_rounds: GLM_GOAL_ROUND_LIMIT }, selected).allow, true);
  assert.equal(decideGlmTool('update_goal', { max_goal_rounds: GLM_GOAL_ROUND_LIMIT + 1 }, selected).allow, false);
  assert.equal(decideGlmTool('web_search', {}, chat).allow, false);
  assert.equal(decideGlmTool('web_search', {}, selected).allow, true);
  assert.equal(decideGlmTool('mcp__fixture__read', {}, selected).allow, true);
  assert.equal(decideGlmTool('mcp__fixture_extra__read', {}, selected).allow, false);
  assert.equal(decideGlmBaseTool('mcp__fixture__read', {}, selected).allow, false);
  assert.equal(decideGlmBaseTool('create_goal', {}, selected).allow, false);
});

test('Окружение поиска GLM получает только отдельный ключ для разрешённого поиска', () => {
  const source = { ZAI_API_KEY: 'synthetic-zai', DEEPSEEK_API_KEY: 'other', [GLM_SEARCH_KEY_ENV]: 'search-only' };
  const input = { source, dshHome: '/tmp/fixture', mode: 'api' as const };

  assert.equal(buildGlmChildEnv(input)[GLM_SEARCH_KEY_ENV], undefined);
  assert.equal(buildGlmChildEnv({ ...input, webSearch: true })[GLM_SEARCH_KEY_ENV], 'search-only');
  assert.equal(buildGlmChildEnv({ ...input, webSearch: true }).DEEPSEEK_API_KEY, undefined);
});

test('Проектный MCP выбирается из рабочего каталога и повторно проверяется после вопроса', async (t) => {
  const cwd = await fs.mkdtemp(path.join(tmpdir(), 'glm-project-mcp-'));
  const file = path.join(cwd, '.mcp.json');
  const write = (arg: string) => fs.writeFile(file, JSON.stringify({
    mcpServers: { fixture: { command: process.execPath, args: [arg] } },
  }));

  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await write('first.mjs');

  const options = { config: {}, userMessage: '/mcp fixture Прочитай справку' };

  assert.deepEqual(await listGlmProjectMcpNames(cwd), ['fixture']);
  assert.equal(await approveGlmProjectMcp(cwd, { ...options, userMessage: 'цитата: /mcp fixture' }), undefined);
  await assert.rejects(approveGlmProjectMcp(cwd, {
    ...options,
    onPermission: async () => ({ allow: false }),
  }), { code: 'glm_project_mcp_declined' });
  await assert.rejects(approveGlmProjectMcp(cwd, {
    ...options,
    onPermission: async (question) => {
      assert.equal(question.requiresExplicitUser, true);
      await write('changed.mjs');

      return { allow: true };
    },
  }), { code: 'glm_project_mcp_changed' });
  assert.deepEqual((await approveGlmProjectMcp(cwd, {
    ...options,
    onPermission: async () => ({ allow: true }),
  }))?.args, ['changed.mjs']);
});

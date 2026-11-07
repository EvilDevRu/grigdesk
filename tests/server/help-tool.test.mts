import assert from 'node:assert/strict';
import test from 'node:test';
import { compileHelpSources } from '../../shared/node/helpSources.ts';
import { queryHelp } from '../../shared/help/helpQuery.ts';
import { createWorkTools, withHelpToolPolicy } from '../../server/src/lib/executors/index.ts';
import { createWorkMcpHandler } from '../../server/src/lib/executors/work-mcp.js';
import { codexDynamicToolResponse } from '../../server/src/lib/executors/codex.ts';
import { deepSeekWorkActions } from '../../server/src/lib/deepseek/toolPermissionPolicy.ts';
import { withHelpHint } from '../../server/src/lib/chat/helpHint.ts';

test('HELP-T1: настоящий registry и два транспорта доставляют один текст/revision', async () => {
  const corpus = await compileHelpSources(new URL('../..', import.meta.url).pathname, {
    version: '0.1.0', commit: 'source'
  });
  const policy = withHelpToolPolicy({
    revision: 1, allowedActions: {
      supervised_ssh: ['list']
    }
  });
  const tools = createWorkTools({
    workToolPolicy: policy,
    helpInvoke: async (input: unknown) => queryHelp(corpus, input)
  });
  const descriptor = tools.descriptors.find((entry) => entry.name === 'grigdesk_help');

  assert.ok(descriptor);
  assert.deepEqual(policy?.allowedActions.supervised_ssh, ['list']);

  const result = await tools.invoke('grigdesk_help', {
    action: 'read', id: 'chats'
  });
  const handler = createWorkMcpHandler({
    workTools: tools
  });
  const response = await handler.request({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'grigdesk_help', arguments: {
        action: 'read', id: 'chats'
      }
    }
  });

  assert.ok('result' in response);
  assert.ok(Array.isArray(response.result.content));
  assert.deepEqual(JSON.parse(response.result.content[0].text), result);
  assert.equal(codexDynamicToolResponse(result).success, true);
  assert.deepEqual(await tools.invoke('grigdesk_help', {
    action: 'read',
    id: 'chats',
    path: '/etc/passwd'
  }), {
    ok: false, error: 'help_input_invalid'
  });
  assert.deepEqual(deepSeekWorkActions(tools)['mcp__grigdesk-work__grigdesk_help'], {
    index: 'read',
    search: 'read',
    read: 'read'
  });
  assert.equal(createWorkTools().descriptors.some((entry) => entry.name === 'grigdesk_help'), false);
  assert.ok(withHelpHint('x').startsWith('x\n'));
});


test('HELP-T5: отказ server-owned reader не выдаётся за ошибку аргументов модели', async () => {
  const tools = createWorkTools({
    helpInvoke: async () => {
      throw new Error('PRIVATE-SENTINEL');
    },
  });

  assert.deepEqual(await tools.invoke('grigdesk_help', { action: 'index' }), {
    ok: false,
    error: 'help_unavailable',
  });
});

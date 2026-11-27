import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { qwenPreviewToolAllowed } from '../../server/src/lib/qwen/previewPolicy.ts';

/**
 * Запрос воспроизводит дополнительные поля стандартного ACP Preview.2.
 * Заголовок намеренно отличается от имени инструмента и не влияет на допуск.
 */
function request(toolName, rawInput, sessionId = 'session') {
  return {
    sessionId,
    toolCall: {
      _meta: { qwen: { toolName } },
      rawInput,
      toolCallId: 'call',
      title: 'Показать подсказку',
    },
  };
}

test('Qwen Preview проверяет shell, MCP, запись и политику плана через ACP', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qwen-preview-policy-'));
  const cwd = path.join(root, 'workspace');
  const outside = path.join(root, 'outside');

  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(cwd);
  await mkdir(outside);
  await symlink(outside, path.join(cwd, 'linked'));

  const policy = {
    sessionId: 'session',
    promptId: 'prompt',
    cwd,
    mode: 'yolo',
    writableRoots: [cwd],
    readonlyRoots: [],
    mcpServers: [{
      name: 'grigdesk-work',
      command: '/bin/true',
      args: [],
    }],
    blockDirectSsh: true,
  };

  assert.equal(await qwenPreviewToolAllowed(request('Bash', { command: 'pwd' }), policy), true);
  assert.equal(await qwenPreviewToolAllowed(request('Bash', { command: 'ssh example.test' }), policy), false);
  assert.equal(await qwenPreviewToolAllowed(request('Write', { file_path: 'notes.txt' }), policy), true);
  assert.equal(await qwenPreviewToolAllowed(request('Write', { file_path: 'linked/notes.txt' }), policy),
    false);
  assert.equal(await qwenPreviewToolAllowed(request('CodeMode', {}), policy), false);
  assert.equal(await qwenPreviewToolAllowed(request('Agent', { run_in_background: true }), policy), false);
  assert.equal(await qwenPreviewToolAllowed(request('mcp__grigdesk-work__list', {}), policy), true);
  assert.equal(await qwenPreviewToolAllowed(request('mcp__other__list', {}), policy), false);
  assert.equal(await qwenPreviewToolAllowed(request('Write', {}, 'another-session'), policy), false);

  const plan = { ...policy, mode: 'plan' };

  assert.equal(await qwenPreviewToolAllowed(request('Read', { file_path: 'notes.txt' }), plan), true);
  assert.equal(await qwenPreviewToolAllowed(request('Write', { file_path: 'notes.txt' }), plan), false);
});

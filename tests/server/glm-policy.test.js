import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalGlmJson } from '../../server/src/lib/glm/contract.ts';
import { GLM_POLICY_HOOK_PATH } from '../../server/src/lib/glm/profile.ts';

const POLICY = {
  workTools: ['repo_history'],
  ssh: true,
  db: true,
  strictDb: true,
};

/**
 * Запуск hook политики как в DSH: stdin — JSON события, решение — код выхода.
 * stderr возвращается целиком: в нём дескриптор вызова и причина отказа.
 */
async function runHook(t, payload, { policy = POLICY, raw } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glm-policy-'));
  const policyFile = path.join(root, 'glm-policy.json');

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(policyFile, typeof policy === 'string' ? policy : JSON.stringify(policy));

  const child = spawn(process.execPath, [GLM_POLICY_HOOK_PATH, '--policy', policyFile], {
    env: { PATH: process.env.PATH },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';

  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  child.stdin.end(raw ?? JSON.stringify(payload));

  const code = await new Promise((resolve) => child.once('exit', resolve));

  return {
    code,
    stderr,
    descriptor: stderr.split('\n').filter((line) => line.startsWith('GLM-POLICY '))
      .map((line) => JSON.parse(line.slice('GLM-POLICY '.length)))[0],
  };
}

function preToolUse(name, input = {}, id = 'call-1') {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 'session-1',
    cwd: '/workspace',
    tool_name: name,
    tool_input: input,
    tool_use_id: id,
  };
}

test('неизвестное имя инструмента — exit 2', async (t) => {
  for (const name of ['unknown_tool', 'Bash', 'read ', '']) {
    assert.equal((await runHook(t, preToolUse(name))).code, 2, name);
  }
});

test('неразбираемый stdin — exit 2', async (t) => {
  for (const raw of ['', '{', 'null', '[]', '"text"']) {
    assert.equal((await runHook(t, null, { raw })).code, 2, JSON.stringify(raw));
  }
});

test('исключение внутри политики — exit 2', async (t) => {
  for (const policy of ['{', '{"workTools": "not-array"}', '{"workTools": [1]}']) {
    assert.equal((await runHook(t, preToolUse('read', { file_path: 'a' }), { policy })).code, 2, policy);
  }
});

test('делегирующие, субагентные, workflow, jobs и web-инструменты — exit 2', async (t) => {
  const forbidden = [
    'subagent', 'subagent_fork', 'send_message', 'interrupt_agent', 'list_agents', 'workflow', 'ralph',
    'job_kill', 'job_list', 'job_output', 'web_fetch', 'web_search', 'skill', 'present', 'create_goal',
    'exit_plan_mode', 'read_image',
  ];

  for (const name of forbidden) {
    assert.equal((await runHook(t, preToolUse(name))).code, 2, name);
  }

  for (const name of ['read', 'write', 'edit', 'glob', 'grep', 'todo_write']) {
    assert.equal((await runHook(t, preToolUse(name, { file_path: 'a' }))).code, 0, name);
  }
});

test('shell с ssh при blockDirectSsh — exit 2, при выключенном запрете — exit 0', async (t) => {
  const command = preToolUse('bash', { command: 'ssh -p 9 user@127.0.0.1', description: 'ssh' });

  assert.equal((await runHook(t, command)).code, 2);
  assert.equal((await runHook(t, command, { policy: { ...POLICY, ssh: false } })).code, 0);
  assert.equal((await runHook(t, preToolUse('bash', { command: 'ls', description: 'ls' }))).code, 0);
});

const DB_TEST = 'удалённый клиент БД при blockDirectDb и неизвестный клиент '
  + 'при strictUnknownDbClient — exit 2';

test(DB_TEST, async (t) => {
  const remote = preToolUse('bash', { command: 'mysql -h db.example -u root', description: 'db' });
  const unknown = preToolUse('bash', { command: 'mysql -h "$(cat host)"', description: 'db' });

  assert.equal((await runHook(t, remote)).code, 2);
  assert.equal((await runHook(t, unknown)).code, 2);
  assert.equal((await runHook(t, unknown, { policy: { ...POLICY, strictDb: false } })).code, 0);
  assert.equal((await runHook(t, remote, { policy: { ...POLICY, db: false } })).code, 0);
});

test('mcp__ сервера не из этого запуска — exit 2', async (t) => {
  for (const name of ['mcp__fixture__echo', 'mcp__grigdesk_work__repo_history', 'mcp__a__b__c']) {
    assert.equal((await runHook(t, preToolUse(name))).code, 2, name);
  }
});

test('инструмент grigdesk-work не из инвентаря — exit 2', async (t) => {
  assert.equal((await runHook(t, preToolUse('mcp__grigdesk-work__repo_history'))).code, 0);

  const outside = ['mcp__grigdesk-work__repo_historyx', 'mcp__grigdesk-work__other', 'mcp__grigdesk-work__'];

  for (const name of outside) {
    assert.equal((await runHook(t, preToolUse(name))).code, 2, name);
  }
});

test('инструмент вопросов агента — exit 0', async (t) => {
  const result = await runHook(t, preToolUse('ask_user_question', {
    questions: [{ id: 'q1', question: 'Продолжить?' }],
  }));

  assert.equal(result.code, 0);
  assert.equal(result.descriptor.kind, 'question');
});

test('hook пишет дескриптор с хэшем канонического JSON аргументов в stderr для hook/result', async (t) => {
  const input = {
    file_path: 'note.txt',
    content: 'text',
    nested: { b: 2, a: 1 },
  };
  const allowed = await runHook(t, preToolUse('write', input, 'call-42'));
  const denied = await runHook(t, preToolUse('web_fetch', { url: 'http://127.0.0.1/' }, 'call-43'));
  const hash = createHash('sha256').update(canonicalGlmJson(input)).digest('hex');

  assert.deepEqual(allowed.descriptor, {
    event: 'PreToolUse',
    tool_use_id: 'call-42',
    name: 'write',
    sha256: hash,
    kind: 'edit',
    decision: 'allow',
  });
  assert.equal(denied.descriptor.decision, 'deny');
  assert.equal(denied.descriptor.tool_use_id, 'call-43');
  assert.equal(allowed.stderr.includes('text'), false, 'аргументы в stderr не попадают');
});

test('UserPromptSubmit пишет маркер hooks-alive; номер хода несёт событие hook/result', async (t) => {
  const result = await runHook(t, {
    hook_event_name: 'UserPromptSubmit',
    session_id: 'session-1',
    cwd: '/workspace',
    prompt: 'secret-prompt-text',
  });

  assert.equal(result.code, 0);
  assert.equal(result.descriptor.event, 'UserPromptSubmit');
  assert.equal(result.descriptor.marker, 'hooks-alive');
  assert.deepEqual(result.descriptor.envNames, ['PATH']);
  assert.equal(result.stderr.includes('secret-prompt-text'), false);
});

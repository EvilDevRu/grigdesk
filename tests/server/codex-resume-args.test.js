import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCodexExecArgs } from '../../server/src/lib/executors/codex.js';

test('Codex first message keeps execution policy on exec', () => {
  assert.deepEqual(buildCodexExecArgs({
    message: 'first',
    cwd: '/work',
    extraDirs: [],
    model: 'gpt-test',
    effort: 'high',
    sessionId: null,
  }), [
    'exec',
    '--skip-git-repo-check',
    '--sandbox', 'workspace-write',
    '-c', 'sandbox_workspace_write.network_access=true',
    '-C', '/work',
    '-m', 'gpt-test',
    '-c', 'model_reasoning_effort="high"',
    '--json',
    'first',
  ]);
});

test('Codex second message puts exec-only sandbox and cwd before resume', () => {
  const args = buildCodexExecArgs({
    message: 'second',
    cwd: '/work',
    extraDirs: ['/repos/shared', '/repos/frontend'],
    model: 'gpt-test',
    effort: 'high',
    sessionId: 'thread-1',
  });

  assert.deepEqual(args, [
    'exec',
    '--skip-git-repo-check',
    '--sandbox', 'workspace-write',
    '-c', 'sandbox_workspace_write.network_access=true',
    '-C', '/work',
    '--add-dir', '/repos/shared',
    '--add-dir', '/repos/frontend',
    '-m', 'gpt-test',
    '-c', 'model_reasoning_effort="high"',
    'resume',
    '--json',
    'thread-1',
    'second',
  ]);
  assert.ok(args.indexOf('--sandbox') < args.indexOf('resume'));
  assert.ok(args.indexOf('-C') < args.indexOf('resume'));
  assert.ok(args.indexOf('--add-dir') < args.indexOf('resume'));
});

test('SEC-08: read-only ход отключает сетевые инструменты', () => {
  const args = buildCodexExecArgs({
    message: 'analyse',
    cwd: '/snapshot',
    extraDirs: [],
    model: 'gpt-test',
    effort: 'high',
    sessionId: null,
    sandbox: 'read-only',
    networkAccess: false,
  });

  assert.deepEqual(args, [
    'exec',
    '--skip-git-repo-check',
    '--sandbox', 'read-only',
    '-c', 'sandbox_workspace_write.network_access=false',
    '-C', '/snapshot',
    '-m', 'gpt-test',
    '-c', 'model_reasoning_effort="high"',
    '--json',
    'analyse',
  ]);
});

test('SEC-09: одноразовый модельный ход не загружает правила и отключает инструменты', () => {
  const args = buildCodexExecArgs({
    message: 'translate',
    cwd: '/empty',
    model: 'gpt-test',
    sandbox: 'read-only',
    networkAccess: false,
    ephemeral: true,
    ignoreUserConfig: true,
    ignoreRules: true,
    disabledFeatures: ['shell_tool', 'unified_exec', 'web_search_request'],
    messageViaStdin: true,
    configOverrides: [
      'shell_environment_policy.inherit="all"',
      'shell_environment_policy.include_only=["PATH","HOME"]',
    ],
  });

  assert.deepEqual(args, [
    'exec',
    '--skip-git-repo-check',
    '--sandbox', 'read-only',
    '-c', 'sandbox_workspace_write.network_access=false',
    '-C', '/empty',
    '-c', 'shell_environment_policy.inherit="all"',
    '-c', 'shell_environment_policy.include_only=["PATH","HOME"]',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--disable', 'shell_tool',
    '--disable', 'unified_exec',
    '--disable', 'web_search_request',
    '-m', 'gpt-test',
    '--json',
    '-',
  ]);
});

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

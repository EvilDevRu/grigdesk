import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deepSeekPermissionPresentation,
  permissionOutcome,
  resolveDeepSeekPermission,
} from '../../server/src/lib/deepseek/permissions.ts';

const params = {
  toolCall: { toolCallId: 'tool-1' },
  options: [
    { optionId: 'allow-once', kind: 'allow_once' },
    { optionId: 'reject-once', kind: 'reject_once' },
  ],
};
const selected = (optionId) => ({ outcome: { outcome: 'selected', optionId } });

test('native gate показывает точную правку и всегда требует разового решения человека', () => {
  const edit = deepSeekPermissionPresentation(params, {
    title: 'edit',
    rawInput: { file_path: 'src/a.ts', old_string: 'old', new_string: 'new' },
  }, true);

  assert.equal(edit.requiresExplicitUser, true);
  assert.equal(edit.canRemember, false);
  assert.deepEqual(edit.input.diff, { old: 'old', new: 'new' });
  const write = deepSeekPermissionPresentation(params, {
    title: 'write', rawInput: { file_path: 'new.ts', content: 'полный\nтекст' },
  }, true);

  assert.equal(write.input.details, 'полный\nтекст');
});

test('gated ACP не обходит человека по известному имени work MCP', async () => {
  let calls = 0;
  const result = await resolveDeepSeekPermission({
    params,
    context: { title: 'mcp__grigdesk-work__supervised_ssh', rawInput: { action: 'exec', command: 'true' } },
    mode: 'workspace-write', toolPermissions: true, workToolNames: new Set(['supervised_ssh']),
    onPermission: async (presentation) => {
      calls += 1;
      assert.equal(presentation.requiresExplicitUser, true);
      return { allow: false };
    },
  });

  assert.equal(calls, 1);
  assert.deepEqual(result, selected('reject-once'));
});

test('permissionOutcome сохраняет известный выбор и fail-closed отклоняет неизвестный optionId', () => {
  assert.deepEqual(permissionOutcome(params, selected('allow-once')), selected('allow-once'));
  assert.deepEqual(permissionOutcome(params, selected('reject-once')), selected('reject-once'));
  assert.deepEqual(permissionOutcome(params, { outcome: { outcome: 'cancelled' } }), {
    outcome: { outcome: 'cancelled' },
  });
  assert.deepEqual(permissionOutcome(params, selected('invented')), selected('reject-once'));
});

test('read-only и Factory отклоняют запрос без вызова UI', async () => {
  for (const variant of [
    { mode: 'read-only', factory: false },
    { mode: 'workspace-write', factory: true },
  ]) {
    let calls = 0;
    const outcome = await resolveDeepSeekPermission({
      params,
      context: { title: 'write', rawInput: { file_path: '/tmp/no' } },
      ...variant,
      onPermission: async () => { calls += 1; return { allow: true }; },
    });
    assert.deepEqual(outcome, selected('reject-once'));
    assert.equal(calls, 0);
  }
});

test('известный work MCP разрешается только в чате и только известным descriptor', async () => {
  const context = { title: 'mcp__grigdesk-work__supervised_ssh', rawInput: {} };
  const known = await resolveDeepSeekPermission({
    params,
    context,
    mode: 'workspace-write',
    workToolNames: new Set(['supervised_ssh']),
  });
  const unknown = await resolveDeepSeekPermission({
    params,
    context,
    mode: 'workspace-write',
    workToolNames: new Set(),
  });
  const factory = await resolveDeepSeekPermission({
    params,
    context,
    mode: 'workspace-write',
    factory: true,
    workToolNames: new Set(['supervised_ssh']),
  });
  assert.deepEqual(known, selected('allow-once'));
  assert.deepEqual(unknown, selected('reject-once'));
  assert.deepEqual(factory, selected('reject-once'));
});

test('danger-full-access и неизвестный инструмент требуют явного решения человека', () => {
  assert.equal(deepSeekPermissionPresentation(params, {
    title: 'bash',
    rawInput: { command: 'true', sandbox_permissions: 'danger-full-access' },
  }).requiresExplicitUser, true);
  assert.equal(deepSeekPermissionPresentation(params, {
    title: 'future-tool',
    rawInput: {},
  }).requiresExplicitUser, true);
  assert.equal(deepSeekPermissionPresentation(params, {
    title: 'bash',
    rawInput: { command: 'true' },
  }).requiresExplicitUser, false);
});

test('отмена до или после UI всегда заканчивается reject-once', async () => {
  let cancelled = false;
  const late = await resolveDeepSeekPermission({
    params,
    context: { title: 'bash', rawInput: { command: 'true' } },
    mode: 'workspace-write',
    cancelled: () => cancelled,
    onPermission: async () => {
      cancelled = true;
      return { allow: true };
    },
  });
  assert.deepEqual(late, selected('reject-once'));

  const early = await resolveDeepSeekPermission({
    params,
    context: { title: 'bash', rawInput: { command: 'true' } },
    mode: 'workspace-write',
    cancelled: () => true,
    onPermission: async () => assert.fail('UI не должен вызываться после cancel'),
  });
  assert.deepEqual(early, selected('reject-once'));
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { checkKimiNativeShellPolicy } from '../../server/src/lib/kimi/commandNativePolicy.ts';

/**
 * Подделывает только нативный readback, сохраняя реальную логику допуска.
 * Отсутствующее поле является повреждением контракта, а не пустым запретом.
 */
function clientFixture(patch = {}) {
  const values = {
    session: [],
    workspace: [],
    profile: { disallowedTools: [] },
    rules: [],
    hooks: {},
    state: { 'sessionActivity.folds': { main: {} } },
    ...patch,
  };

  return {
    settingsRequest: async (_method, url) => {
      if (url.endsWith('/externalHooksRunnerService/ready')) {
        return undefined;
      }
      if (url.endsWith('/externalHooksRunnerService/summary')) {
        return values.hooks;
      }
      if (url.endsWith('/agent/main/agentPermissionRulesService/rules')) {
        return values.rules;
      }
      if (url.endsWith('/sessionStateService/snapshot')) {
        return values.state;
      }
      if (url.endsWith('/sessionToolPolicy/disabledTools')) {
        return values.session;
      }
      if (url.endsWith('/workspaceToolPolicy/disabledTools')) {
        return values.workspace;
      }
      if (url.endsWith('/agent/main/agentProfileService/data')) {
        return values.profile;
      }

      throw new Error('Непредусмотренный RPC');
    },
  };
}

test('broker сохраняет ограничения сессии, workspace и профиля, неизвестное закрывается', async () => {
  assert.equal(await checkKimiNativeShellPolicy(clientFixture(), 'fixture'), true);
  assert.equal(await checkKimiNativeShellPolicy(clientFixture({ hooks: { Stop: 1 } }), 'fixture'), true);

  for (const patch of [
    { rules: [{
      decision: 'deny',
      scope: 'session-runtime',
      pattern: 'Bash',
    }] },
    { rules: null },
    { hooks: { PreToolUse: 1 } },
    { hooks: { PreToolUse: '0' } },
    { hooks: null },
    { session: ['Bash'] },
    { workspace: ['Bash'] },
    { profile: { disallowedTools: ['Bash'] } },
    { profile: { disallowedTools: [], activeToolNames: ['Read', 'mcp__grigdesk-command__run_command'] } },
    { profile: { disallowedTools: [], activeToolNames: [] } },
    { profile: {} },
    { session: null },
    { state: {} },
    { state: { 'sessionActivity.folds': {} } },
    { state: { 'sessionActivity.folds': { main: {}, background: {} } } },
    { state: { 'sessionActivity.folds': { main: {}, detached: {} } } },
    { state: { 'sessionActivity.folds': { main: {}, nestedChildWithoutParent: {} } } },
  ]) {
    assert.equal(await checkKimiNativeShellPolicy(clientFixture(patch), 'fixture'), false);
  }

  const finishedButLive = clientFixture({
    state: { 'sessionActivity.folds': { main: {}, child: { turnActive: false, background: 0 } } },
  });

  assert.equal(await checkKimiNativeShellPolicy(finishedButLive, 'fixture'), false);
  assert.equal(await checkKimiNativeShellPolicy({
    settingsRequest: async () => {
      throw new Error('Нет RPC');
    },
  }, 'fixture'), false);
});

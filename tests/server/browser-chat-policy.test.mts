import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkTools, withBrowserToolPolicy } from '../../server/src/lib/executors/index.ts';
import { browserActions } from '../../shared/browser/browserActions.ts';
import { deepSeekWorkActions } from '../../server/src/lib/deepseek/toolPermissionPolicy.ts';

const READ = ['list', 'snapshot', 'screenshot', 'console'];

test('BR-C03: общий readonly enum и raw dispatch не допускают mutation', async () => {
    for (const mode of ['plan', 'read-only']) {
      const calls: unknown[] = [];
      const tools = createWorkTools({
        permissionMode: mode,
        browserOwner: '["chat",null,"own",null]',
        browserAvailable: () => true,
        browserInvoke: async (...args: unknown[]) => {
          calls.push(args);

          return { ok: true, tabs: [] };
        },
        workToolPolicy: withBrowserToolPolicy(undefined, mode),
      });
      const descriptor = tools.descriptors.find((row) => row.name === 'grigdesk_browser')!;
      const schema = descriptor.inputSchema as { properties: { action: { enum: unknown } } };

      assert.deepEqual(schema.properties.action.enum, READ);

      for (const action of ['open', 'click', 'fill', 'scroll', 'close']) {
        assert.deepEqual(await tools.invoke('grigdesk_browser', { action }),
          { ok: false, error: 'action_not_allowed' });
      }

      assert.equal(calls.length, 0);
      await tools.invoke('grigdesk_browser', { action: 'list' });
      assert.equal(calls.length, 1);
    }
});

test('BR-C04: default actions полны, прежний Codex plan SSH/DB policy сохраняется', () => {
  const base = {
    revision: 1,
    allowedActions: { supervised_ssh: ['list'], supervised_db: ['list', 'schema'] },
  };
  const policy = withBrowserToolPolicy(base, 'plan');

  assert.deepEqual(policy.allowedActions, { ...base.allowedActions, grigdesk_browser: READ });
  assert.equal(policy.revision, 2);
  assert.equal(Object.hasOwn(base.allowedActions, 'grigdesk_browser'), false);
  assert.deepEqual(withBrowserToolPolicy(undefined, 'auto').allowedActions.grigdesk_browser,
    browserActions('default'));
  assert.deepEqual(withBrowserToolPolicy({ revision: 4, allowedActions: { grigdesk_browser: ['list'] } },
    'auto').allowedActions.grigdesk_browser, ['list']);
});

test('BR-C05: DS классификация browser actions из shared table и exact descriptor only', () => {
  const tools = createWorkTools({
    browserAvailable: () => true,
    browserOwner: 'own',
    browserInvoke: async () => ({ ok: true })
  });
  const classified = deepSeekWorkActions(tools);

  for (const action of browserActions('default')) {
    assert.equal(classified.mcp__grigdesk_work__grigdesk_browser, undefined);
    assert.equal(classified['mcp__grigdesk-work__grigdesk_browser']?.[action],
      READ.includes(action) ? 'read' : 'broker');
  }

  assert.equal(deepSeekWorkActions({ descriptors: [{ name: 'grigdesk_browser_extra' }] })
    ['mcp__grigdesk-work__grigdesk_browser_extra'], undefined);
});

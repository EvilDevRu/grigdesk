import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { factoryStatusEnvironment } from '../../server/src/lib/factoryProviderRunner.ts';
import { assertGlmFactoryContext } from '../../server/src/lib/glm/factoryContext.ts';
import {
  GLM_FACTORY_STATUS_TOOLS,
  glmFactoryToolInventory,
  glmFactoryToolPolicy,
  parseGlmFactoryToolPolicy,
  decideGlmFactoryTool,
} from '../../server/src/lib/glm/factoryPolicy.ts';
import { createGlmTurnGuard } from '../../server/src/lib/glm/permissions.ts';
import { buildGlmLaunchFiles } from '../../server/src/lib/glm/profile.ts';

const BROWSER = 'mcp__factory-status__grigdesk_browser';
const NONCE = 'cd'.repeat(32);

/**
 * Context повторяет host wrapper и не читает состояние работающей фабрики.
 * Public status env — единственный источник optional browser marker.
 */
function context(stateDir: string, browser: boolean) {
  const source = {
    FACTORY_RUN_TASK: '77',
    FACTORY_RUN_STAGE: 'CHECK',
    FACTORY_RUN_ID: 'run-one',
    FACTORY_RUN_EPOCH: '1',
    FACTORY_STATUS_MODE: 'request',
    FACTORY_STATE: stateDir,
    FACTORY_STATUS_REQUEST_DIR: path.join(stateDir, 'logs/runs/t77/CHECK/run-one/control-requests'),
    FACTORY_BROWSER_ENABLED: browser ? '1' : '0',
    FACTORY_ROUTE_BROWSER_POLICY: browser ? 'allow' : 'forbid',
    FACTORY_BROWSER_NONCE: NONCE,
  };

  return {
    task: '77',
    stage: 'CHECK',
    runId: 'run-one',
    epoch: '1',
    filesystem: 'state-only' as const,
    stateDir,
    statusServer: {
      name: 'factory-status',
      command: process.execPath,
      args: ['/fixture/factory-status-mcp.mjs'],
      env: factoryStatusEnvironment(source),
    },
  };
}

test('BR-G01: conditional inventory даёт ровно третий tool и сохраняет legacy форму', () => {
  const off = glmFactoryToolPolicy('workspace-write');
  const on = glmFactoryToolPolicy('workspace-write', undefined, true);

  assert.deepEqual(off.rawTools, [...GLM_FACTORY_STATUS_TOOLS]);
  assert.equal(Object.hasOwn(off, 'browser'), false);
  assert.deepEqual(on.rawTools, [...GLM_FACTORY_STATUS_TOOLS, BROWSER]);
  assert.equal(on.browser, true);
  assert.deepEqual(glmFactoryToolInventory(true), on.rawTools);

  for (const policy of [off, on]) {
    assert.equal(decideGlmFactoryTool(BROWSER, {}, policy).allow, policy.browser === true);
    assert.equal(decideGlmFactoryTool('mcp__factory-status-extra__grigdesk_browser', {}, policy).allow,
      false);
    assert.equal(decideGlmFactoryTool('mcp__factory-status__grigdesk_browser_extra', {}, policy).allow,
      false);
  }
});

test('BR-G02: parser отклоняет wildcard/duplicate и tool без правильного marker', () => {
  const on = glmFactoryToolPolicy('workspace-write', undefined, true);
  const off = glmFactoryToolPolicy('workspace-write');

  for (const value of [
    { ...on, browser: false },
    { ...on, rawTools: [...GLM_FACTORY_STATUS_TOOLS] },
    { ...on, rawTools: [...GLM_FACTORY_STATUS_TOOLS, 'mcp__factory-status__*'] },
    { ...on, rawTools: [...GLM_FACTORY_STATUS_TOOLS, BROWSER, BROWSER] },
    { ...off, rawTools: [...GLM_FACTORY_STATUS_TOOLS, BROWSER] },
  ]) {
    assert.throws(() => parseGlmFactoryToolPolicy(value), { code: 'glm_factory_policy_invalid' });
  }
});

test('BR-G03: actual turn guard получает точный inventory, без prefix trust', () => {
  const off = createGlmTurnGuard({
    workTools: [],
    rawMcpTools: glmFactoryToolInventory(false),
    hostServer: 'factory-status'
  });
  const on = createGlmTurnGuard({
    workTools: [],
    rawMcpTools: glmFactoryToolInventory(true),
    hostServer: 'factory-status'
  });

  assert.equal(off.autoApprove(BROWSER), false);
  assert.equal(on.autoApprove(BROWSER), true);
  assert.equal(on.autoApprove('mcp__factory-status-extra__grigdesk_browser'), false);
  assert.equal(on.autoApprove('mcp__project__grigdesk_browser'), false);
});

test('BR-G04: context выводит browser из safe env, но не принимает explicit nonce', () => {
  const off = assertGlmFactoryContext(context('/fixture/state', false));
  const on = assertGlmFactoryContext(context('/fixture/state', true));

  assert.equal(off.browser, undefined);
  assert.equal(on.browser, true);

  const forged = context('/fixture/state', false);

  assert.throws(() => assertGlmFactoryContext({ ...forged, browser: true }),
    { code: 'glm_factory_context_invalid' });
  forged.statusServer.env.push({ name: 'FACTORY_BROWSER_NONCE', value: NONCE });
  assert.throws(() => assertGlmFactoryContext(forged), { code: 'glm_factory_context_invalid' });
});

test('BR-G05: настоящие profile files без nonce и с прежним STATE_DIR workspace', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'factory-browser-glm-'));
  const project = path.join(root, 'project');
  const stateDir = path.join(project, 'state');

  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(root, 'settings.yaml'), '', { mode: 0o600 });

  for (const browser of [false, true]) {
    const validated = assertGlmFactoryContext(context(stateDir, browser));
    const files = await buildGlmLaunchFiles({
      launchDir: path.join(root, browser ? 'on' : 'off'),
      cwd: stateDir,
      workspaceRoot: stateDir,
      projectRoot: project,
      accessMode: 'api',
      model: 'glm-5.3',
      transport: 'web',
      settingsDocument: path.join(root, 'settings.yaml'),
      hooks: {
        ssh: true,
        db: true,
        strictDb: true
      },
      mcpServers: [validated.statusServer],
      factory: { filesystem: 'state-only', ...(validated.browser ? { browser: true as const } : {}) },
    });
    const overlay = await readFile(files.overlayPath, 'utf8');
    const policy = JSON.parse(await readFile(path.join(path.dirname(files.overlayPath), 'glm-policy.json'),
      'utf8'));
    const hooks = await readFile(files.hooksPath, 'utf8');

    assert.equal(overlay.includes(NONCE), false);
    assert.equal(overlay.includes('FACTORY_BROWSER_NONCE'), false);
    assert.equal(hooks.includes(NONCE), false);
    assert.equal(policy.stateDir, stateDir);
    assert.equal(policy.filesystem, 'state-only');
    assert.equal(policy.browser, browser ? true : undefined);
    assert.deepEqual(policy.rawTools, [...glmFactoryToolInventory(browser)]);
  }
});

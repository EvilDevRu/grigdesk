import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { factoryBrowserChildEnv } from '../../server/src/lib/browser/factoryBrowserEnvironment.ts';
import { buildLaunchFiles } from '../../server/src/lib/deepseek/profile.ts';
import { DEEPSEEK_BASH_TOOL } from '../../server/src/lib/deepseek/contract.ts';
import {
  FACTORY_STATUS_ENV_NAMES, factoryStatusEnvironment,
} from '../../server/src/lib/factoryProviderRunner.ts';
import { ensureTestDeepSeekArtifact } from '../helpers/deepseekRuntimeArtifact.mts';

const NONCE = '0123456789abcdef'.repeat(4);
const ARTIFACT = await ensureTestDeepSeekArtifact();
const SOURCE = {
  FACTORY_BROWSER_NONCE: NONCE,
  FACTORY_BROWSER_ENABLED: '1',
  FACTORY_ROUTE_BROWSER_POLICY: 'allow',
  FACTORY_RUN_TASK: '77',
  FACTORY_RUN_STAGE: 'CHECK',
  FACTORY_RUN_ID: 'run-a',
  FACTORY_RUN_EPOCH: '2',
  FACTORY_STATUS_MODE: 'request',
};

interface StdioTransport {
  onmessage?: (message: Record<string, unknown>) => void;
  onerror?: (error: Error) => void;
  start(): Promise<void>;
  close(): Promise<void>;
}

test('BR9-E1: nonce только у enabled factory allow, без расширения общего env allowlist', () => {
  const base = { PATH: '/fixture/bin', FACTORY_BROWSER_NONCE: 'stale' };

  assert.deepEqual(factoryBrowserChildEnv(base, SOURCE, true), { PATH: '/fixture/bin',
    FACTORY_BROWSER_NONCE: NONCE });

  for (const [factory, patch] of [
    [false, {}], [true, { FACTORY_BROWSER_ENABLED: '0' }],
    [true, { FACTORY_ROUTE_BROWSER_POLICY: 'forbid' }],
    [true, { FACTORY_BROWSER_NONCE: 'malformed' }],
  ] as const) {
    assert.deepEqual(factoryBrowserChildEnv(base, { ...SOURCE, ...patch }, factory),
      { PATH: '/fixture/bin' });
  }

  assert.equal(FACTORY_STATUS_ENV_NAMES.includes('FACTORY_BROWSER_NONCE'), false);
  assert.equal(factoryStatusEnvironment(SOURCE).some((row) => row.name === 'FACTORY_BROWSER_NONCE'), false);
});

test('BR9-E2: настоящий profile overlay/hooks не содержит credential и его имени', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'browser-env-overlay-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  const cwd = path.join(root, 'project');

  await mkdir(cwd);

  const files = await buildLaunchFiles({
    launchDir: path.join(root, 'launch'),
    cwd,
    workspaceRoot: cwd,
    mode: 'read-only',
    approval: 'never',
    transport: 'web',
    hooks: {
      bashToolName: DEEPSEEK_BASH_TOOL,
      ssh: true,
      db: true,
      strictDb: true,
      instructions: { projectRoot: cwd }
    },
    mcpServers: [{
      name: 'factory-status',
      command: process.execPath,
      args: ['/fixture/status.mjs'],
      env: factoryStatusEnvironment(SOURCE)
    }],
  });

  for (const file of [files.overlayPath, files.hooksPath]) {
    const text = await readFile(file, 'utf8');

    assert.equal(text.includes(NONCE), false);
    assert.equal(text.includes('FACTORY_BROWSER_NONCE'), false);
  }
});

test('BR9-E3: pinned MCP stdio child получает ambient nonce при пустом config.env',
  { timeout: 30000 }, async (t) => {
    const source = path.join(ARTIFACT, 'packages/mcp/mcp-client/src/transport.ts');
    const bytes = await readFile(source);

    assert.equal(createHash('sha256').update(bytes).digest('hex'),
      '07f977e2fa72f1c11f7a45621e6d20e04a1bee1e73168974860b860e75ea6be6');

    const transportModule = await import(pathToFileURL(path.join(ARTIFACT,
      'packages/mcp/mcp-client/lib/types/transport.js')).href) as {
      createTransport(config: Record<string, unknown>): StdioTransport;
    };
    const root = await mkdtemp(path.join(os.tmpdir(), 'browser-env-stdio-'));

    t.after(() => rm(root, { recursive: true, force: true }));

    const child = path.join(root, 'child.mjs');

    await writeFile(child, [
      'process.stdout.write(JSON.stringify({jsonrpc:"2.0",method:"fixture/env",params:{',
      ' nonce:process.env.FACTORY_BROWSER_NONCE??null,',
      ' secret:process.env.FIXTURE_TOKEN??null}})+"\\n");',
      'process.stdin.resume();',
    ].join('\n'));

    const previousNonce = process.env.FACTORY_BROWSER_NONCE;
    const previousToken = process.env.FIXTURE_TOKEN;

    process.env.FACTORY_BROWSER_NONCE = factoryBrowserChildEnv({}, SOURCE, true).FACTORY_BROWSER_NONCE;
    process.env.FIXTURE_TOKEN = 'synthetic-secret-must-be-scrubbed';
    t.after(() => {
      if (previousNonce === undefined) {
        delete process.env.FACTORY_BROWSER_NONCE;
      } else {
        process.env.FACTORY_BROWSER_NONCE = previousNonce;
      }

      if (previousToken === undefined) {
        delete process.env.FIXTURE_TOKEN;
      } else {
        process.env.FIXTURE_TOKEN = previousToken;
      }
    });

    const transport = transportModule.createTransport({
      transport: 'stdio',
      serverName: 'factory-status',
      command: process.execPath,
      args: [child],
      env: {},
      cwd: root,
      toolCallTimeoutMs: 1000,
      failOnStartupError: true,
    });

    t.after(() => transport.close());

    let timer: ReturnType<typeof setTimeout> | undefined;
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('MCP fixture deadline')), 5000);
      transport.onerror = reject;
      transport.onmessage = (message) => {
        if (message.method === 'fixture/env') {
          resolve(message);
        }
      };
    });

    t.after(() => clearTimeout(timer));

    const started = transport.start();
    const pending = Promise.all([started, response]);
    const [, message] = await pending;

    clearTimeout(timer);
    assert.deepEqual(message.params, { nonce: NONCE, secret: null });
    await transport.close();
  });

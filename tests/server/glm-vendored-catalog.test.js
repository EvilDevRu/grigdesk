import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createGlmAdapter } from '../../server/src/lib/executors/glm.ts';
import { artifactsPath } from '../../shared/runtime/dataHome.ts';
import { ensureGlmTestRuntime } from '../helpers/glmTestRuntime.mts';
import { startGlmLoopback } from '../helpers/glmLoopback.mts';
import { GLM_SERVICE_KEY } from '../helpers/glmProductionFixture.mts';

const ARTIFACTS = path.join(artifactsPath({ env: process.env, home: os.homedir() }), 'glm/G8/fixtures');
const pair = (model) => JSON.stringify(['zai', model]);

test('настоящий ACP-каталог GLM без prompt и без проектных MCP отдаёт efforts каждой модели', async (t) => {
  const { config: runtimeConfig, identity } = await ensureGlmTestRuntime();

  await fs.mkdir(ARTIFACTS, { recursive: true });

  const root = await fs.mkdtemp(path.join(ARTIFACTS, 'catalog-'));
  const marker = path.join(root, 'project-mcp.log');
  const mock = await startGlmLoopback({ expectedKey: GLM_SERVICE_KEY, scenarios: [] });

  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await mock.stop();
  });

  // Проектный MCP в корне GrigDesk: каталог не должен его запускать.
  await fs.writeFile(path.join(root, 'project-mcp.mjs'),
    `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(marker)}, "spawn\\n");\n`);
  await fs.writeFile(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: {
    project: { command: process.execPath, args: [path.join(root, 'project-mcp.mjs')] },
  } }));

  const config = {
    rootDir: root,
    ...runtimeConfig,
    glmRuntimeHome: path.join(root, 'glm-home'),
  };
  const adapter = createGlmAdapter({
    env: {
      PATH: process.env.PATH,
      HOME: root,
      GRIGDESK_GLM_API_MODE: 'api',
      ZAI_API_KEY: GLM_SERVICE_KEY,
    },
    admission: [{ mode: 'api', compatibility: identity }],
    modelEndpoint: mock.endpoint,
  });
  const models = await adapter.catalog(config);
  const efforts = Object.fromEntries(models.map((model) => [model.id, model.efforts]));
  const launches = path.join(config.glmRuntimeHome, identity.slice(0, 16), 'catalog-launch');

  assert.deepEqual(efforts, {
    [pair('glm-4.7')]: [],
    [pair('glm-5-turbo')]: [],
    [pair('glm-5.2')]: ['off', 'high', 'max'],
    [pair('glm-5.2-highspeed')]: ['off', 'high', 'max'],
    [pair('glm-5.3')]: ['low', 'high', 'max'],
    [pair('glm-5.3-flash')]: ['low', 'high', 'max'],
    [pair('glm-5.3-highspeed')]: ['low', 'high', 'max'],
  });
  assert.equal(mock.requests.length, 0);
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(launches), []);
});

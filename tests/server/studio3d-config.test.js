import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import os from 'node:os';
import Fastify from '../../server/node_modules/fastify/fastify.js';
import codeModule from '../../server/src/modules/code/index.ts';

const execute = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

test('LB-07 раздел 3D сохраняет параллельность общего безопасного прогона', async () => {
  const server = JSON.parse(await fs.readFile(path.join(projectRoot, 'server/package.json'), 'utf8'));
  const web = JSON.parse(await fs.readFile(path.join(projectRoot, 'web/package.json'), 'utf8'));

  assert.match(server.scripts.test, /NODE_TEST_MAX_RSS_MB=4096\b/);
  assert.match(server.scripts.test, /--test-concurrency=2\b/);
  assert.match(web.scripts['test:components'], /NODE_TEST_MAX_RSS_MB=4096\b/);
  assert.match(web.scripts['test:components'], /--test-concurrency=2\b/);
});

test('LB-01 библиотека по умолчанию находится в dataHome/3d, env выбирает другой путь', async () => {
  const expression = "import { config } from './server/src/config.ts'; "
    + 'console.log(JSON.stringify({dir:config.studio3dDir,root:config.dataHome}))';
  const run = async (extra = {}) => {
    const result = await execute(process.execPath, ['--input-type=module', '-e', expression], {
      cwd: projectRoot,
      env: {
        PATH: process.env.PATH,
        HOME: '/tmp',
        ...extra
      }
    });

    return JSON.parse(result.stdout);
  };
  const defaults = await run();
  const custom = await run({ GRIGDESK_3D_DIR: '/tmp/studio3d-config-fixture' });

  assert.equal(defaults.dir, path.join(defaults.root, '3d'));
  assert.equal(custom.dir, '/tmp/studio3d-config-fixture');
});

test('LB-02 папка библиотеки скрыта из «Кода» конфигом, как папки чатов', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-hidden-'));
  const repo = path.join(root, 'repo');

  await fs.mkdir(path.join(repo, 'custom-library'), { recursive: true });
  await fs.writeFile(path.join(repo, 'custom-library/model.glb'), 'fixture');
  await execute('git', ['-C', repo, 'init', '-q']);

  const app = Fastify();
  const stored = { projects: { fixture: { repos: [{ key: 'main', dir: repo }] } }, pluginSettings: {} };

  t.after(async () => {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  app.decorate('pluginEnabled', () => true);
  await app.register(codeModule, {
    config: { profilesDir: path.join(root, 'profiles'), studio3dDir: path.join(repo, 'custom-library') },
    prefs: { read: () => stored },
  });
  await app.ready();

  const response = await app.inject({ url: '/api/code/fixture/ls?repo=main' });
  const file = await app.inject({ url: '/api/code/fixture/file?repo=main&path=custom-library/model.glb' });

  assert.equal(response.json().entries.some((item) => item.name === 'custom-library'), false);
  assert.equal(file.statusCode, 404);
});

test('LB-02 код, inventory и boot fixture отделяют библиотеку от обычных файлов', async () => {
  const files = await Promise.all([
    fs.readFile(path.join(projectRoot, 'server/src/modules/code/index.ts'), 'utf8'),
    fs.readFile(path.join(projectRoot, 'tools/migrationInventory.mts'), 'utf8'),
    fs.readFile(path.join(projectRoot, 'tests/server/app-boot-smoke.test.js'), 'utf8'),
  ]);

  assert.match(files[0], /hiddenDirs[\s\S]*config\.studio3dDir/);
  assert.match(files[1], /SKIP_DIRS = new Set\(\[[\s\S]*'3d'/);
  assert.match(files[2], /GRIGDESK_3D_DIR:\s*path\.join\(root, '3d'\)/);
});

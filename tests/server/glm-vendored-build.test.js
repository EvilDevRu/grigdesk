import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { sha256 } from '../../shared/node/hash.ts';

import { buildLaunchFiles } from '../../server/src/lib/deepseek/profile.ts';
import {
  probeDeepSeekRuntime,
  resolveDeepSeekRuntime,
} from '../../server/src/lib/deepseek/runtimeProcess.ts';
import { startDeepSeekServer } from '../../server/src/lib/deepseek/serverRuntime.ts';
import { artifactsPath } from '../../shared/runtime/dataHome.ts';
import { testDeepSeekBinarySelection } from '../helpers/deepseekBinary.mts';
import { readWorkerArtifact } from '../../deepseek/src/runtime/artifact.ts';

const exec = promisify(execFile);
const ARTIFACTS = path.join(artifactsPath({ env: process.env, home: os.homedir() }), 'glm/G1');
const PLUGIN = '@deepseek-ai/dsh-llm-pi-ai';
const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

/**
 * Регистратор загрузок пишет каждый модуль LLM-провайдеров во внешний журнал.
 * Синхронные hooks видят и ESM import, и CommonJS require всех процессов Node дерева.
 */
const LOAD_RECORDER = `
  import { appendFileSync } from 'node:fs';
  import { registerHooks } from 'node:module';

  registerHooks({
    load(url, context, next) {
      if (/llm-deepseek|llm-pi-ai|pi-ai/u.test(url)) {
        appendFileSync(process.env.GLM_LOAD_JOURNAL, url + '\\n');
      }

      return next(url, context);
    },
  });
`;

/**
 * Импорт compiled-плагина и встроенного маршрута zai идёт отдельным процессом без сети.
 * Окружение синтетическое: ни ключей, ни настоящего home в процесс не попадает.
 */
async function importZaiRoute(artifact, home, worker) {
  const plugin = pathToFileURL(path.join(artifact, 'packages/llm/llm-pi-ai/lib/index.js')).href;
  const provider = pathToFileURL(path.join(artifact,
    'node_modules/@earendil-works/pi-ai/dist/providers/zai.js')).href;
  const script = `
    globalThis.fetch = () => {
      throw new Error('Внешний fetch запрещён в проверке импорта');
    };
    const plugin = await import(process.argv[1]);
    const { zaiProvider } = await import(process.argv[2]);
    const route = zaiProvider();
    console.log(JSON.stringify({
      adapter: typeof plugin.PiAiAdapter,
      id: route.id,
      baseUrl: route.baseUrl,
      models: route.getModels().map((model) => model.id),
    }));
  `;
  const result = await exec(worker, ['--input-type=module', '-e', script, plugin, provider], {
    cwd: home,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      DSH_HOME: home,
      DSH_TELEMETRY_DISABLED: '1',
    },
    timeout: 15_000,
  });

  return JSON.parse(result.stdout);
}

test('настоящая generation содержит llm-pi-ai и загружает маршрут zai без сети', async (t) => {
  const { generation: artifact, worker, config, candidate } = await testDeepSeekBinarySelection();
  const composition = JSON.parse(await fs.readFile(path.join(artifact, 'composition.json'), 'utf8'));

  assert.ok(composition.packages.some((item) => item.name === PLUGIN), 'llm-pi-ai отсутствует в generation');
  await fs.mkdir(ARTIFACTS, { recursive: true });

  const home = await fs.mkdtemp(path.join(ARTIFACTS, 'import-home-'));

  t.after(() => fs.rm(home, { recursive: true, force: true }));

  const route = await importZaiRoute(artifact, home, worker);

  assert.equal(route.adapter, 'function');
  assert.equal(route.id, 'zai');
  assert.equal(route.baseUrl, 'https://api.z.ai/api/coding/paas/v4');
  assert.equal(route.models.length, 7);
  assert.ok(route.models.includes('glm-4.7'));
});

const DEEPSEEK_MOUNT_TEST = 'настоящий процесс DeepSeek не монтирует llm-pi-ai, '
  + 'и его settings/describe не содержит llm-pi-ai';

test(DEEPSEEK_MOUNT_TEST, async (t) => {
  const { generation: artifact, worker, config, candidate } = await testDeepSeekBinarySelection();

  await fs.mkdir(ARTIFACTS, { recursive: true });

  const root = await fs.mkdtemp(path.join(ARTIFACTS, 'deepseek-mount-'));
  const cwd = path.join(root, 'project');
  const home = path.join(root, 'home');
  const journal = path.join(root, 'loads.log');
  const recorder = path.join(root, 'recorder.mjs');
  let server;

  t.after(async () => {
    await server?.stop();
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(cwd);
  await fs.mkdir(home);
  await fs.writeFile(journal, '');
  await fs.writeFile(recorder, LOAD_RECORDER);

  const launch = await buildLaunchFiles({
    launchDir: path.join(root, 'launch'),
    cwd,
    workspaceRoot: cwd,
    mode: 'workspace-write',
    approval: 'ask',
    transport: 'web',
    hooks: {
      bashToolName: 'bash',
      ssh: true,
      db: false,
      strictDb: false,
      instructions: { projectRoot: cwd },
    },
  });

  server = await startDeepSeekServer({
    bin: worker,
    spawnProcess: (_command, args, settings) => spawn(worker,
      ['--import', recorder, path.join(artifact, 'entry.mjs'), ...args], settings),
    overlayPath: launch.overlayPath,
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      DSH_HOME: home,
      DSH_TELEMETRY_DISABLED: '1',
      NO_COLOR: '1',
      GLM_LOAD_JOURNAL: journal,
    },
  });

  const description = await server.client.rpc('settings/describe');
  const namespaces = description.namespaces.map((namespace) => namespace.ns);
  const loads = (await fs.readFile(journal, 'utf8')).split('\n').filter(Boolean);

  // Положительный контроль: регистратор действительно видит загрузку провайдера DeepSeek.
  assert.ok(loads.some((url) => url.includes('llm-deepseek')), 'регистратор не увидел llm-deepseek');
  assert.ok(namespaces.includes('llm-deepseek'));
  assert.equal(namespaces.includes('llm-pi-ai'), false);
  assert.deepEqual(loads.filter((url) => /llm-pi-ai|\/pi-ai\//u.test(url)), []);
  await server.stop();

  // NODE_OPTIONS намеренно не проходит launcher; mounting дополнительно проверяется на самом ELF.
  // Closure recorder выше запускает реальный bundled Node явно, не маскируясь binary descriptor.
  server = await startDeepSeekServer({
    runtime: resolveDeepSeekRuntime(config),
    bin: candidate.binary,
    overlayPath: launch.overlayPath,
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      DSH_HOME: home,
      DSH_TELEMETRY_DISABLED: '1',
    },
  });

  const binaryDescription = await server.client.rpc('settings/describe');
  const binaryNamespaces = binaryDescription.namespaces.map((namespace) => namespace.ns);

  assert.ok(binaryNamespaces.includes('llm-deepseek'));
  assert.equal(binaryNamespaces.includes('llm-pi-ai'), false);
});

const RELOCATION_TEST = 'настоящая generation проходит полную проверку payload и ABI '
  + 'после переноса в путь с пробелами';

test(RELOCATION_TEST, async (t) => {
  const { generation: artifact, worker, config, candidate } = await testDeepSeekBinarySelection();

  await fs.mkdir(ARTIFACTS, { recursive: true });

  const root = await fs.mkdtemp(path.join(ARTIFACTS, 'relocated-'));
  const relocated = path.join(root, 'runtime with spaces');
  const home = path.join(root, 'home');

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.cp(artifact, relocated, { recursive: true, verbatimSymlinks: true });
  await fs.mkdir(home);
  await readWorkerArtifact(relocated, {
    nodeVersion: candidate.info.workerNode.version,
    nativeAbi: candidate.info.workerNode.abi,
    platform: candidate.info.platform,
    arch: candidate.info.arch,
  });

  const binary = path.join(root, 'deepseek with spaces');

  await fs.copyFile(candidate.binary, binary);
  await fs.chmod(binary, 0o555);

  const probe = await probeDeepSeekRuntime({ ...config, deepseekBin: binary });
  const route = await importZaiRoute(relocated, home, worker);
  // Native addon грузится по-настоящему: flock на файле внутри перенесённой generation.
  const addon = await exec(worker, ['--input-type=module', '-e', `
    import { openSync, closeSync } from 'node:fs';
    import { createRequire } from 'node:module';

    const load = createRequire(process.argv[1]);
    const { tryLockExclusive } = await import(load.resolve('@deepseek-ai/node-addon-system/flock'));
    const fd = openSync(process.argv[1], 'r');

    await tryLockExclusive(fd);
    closeSync(fd);
    console.log('locked');
  `, path.join(relocated, 'package.json')], {
    cwd: home,
    env: {
      PATH: process.env.PATH,
      HOME: home,
    },
    timeout: 15_000,
  });

  assert.equal(probe.ok, true);
  assert.equal(route.id, 'zai');
  assert.equal(route.models.length, 7);
  assert.equal(addon.stdout.trim(), 'locked');
});

/**
 * Исходники плагина перечисляются из самой generation: build outputs и links исключены.
 * Tsconfig переписывается сборкой, поэтому не входит ни сюда, ни в хэш runtime.json.
 */
async function pluginSources(artifact) {
  const root = path.join(artifact, 'packages/llm/llm-pi-ai');
  const result = [];

  /**
   * Обход идёт в лексикографическом порядке путей, как список файлов manifest.
   * Каталоги lib и node_modules созданы сборкой и в исходники не входят.
   */
  const visit = async (relative) => {
    const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });

    for (const entry of entries) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;

      if (name === 'lib' || name === 'node_modules' || /^tsconfig[^/]*\.json$/u.test(entry.name)) {
        continue;
      }

      if (entry.isDirectory()) {
        await visit(name);
      } else if (entry.isFile()) {
        result.push({
          path: `packages/llm/llm-pi-ai/${name}`,
          sha256: sha256(await fs.readFile(path.join(root, name))),
        });
      }
    }
  };

  await visit('');

  return result.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

test('настоящий runtime.json содержит версию и integrity pi-ai и хэш исходников llm-pi-ai', async () => {
  const { generation: artifact, worker, config, candidate } = await testDeepSeekBinarySelection();
  const metadata = JSON.parse(await fs.readFile(path.join(artifact, 'runtime.json'), 'utf8'));
  const lockFile = path.join(REPO_ROOT, 'deepseek/build/runtime-deps/package-lock.json');
  const lock = JSON.parse(await fs.readFile(lockFile, 'utf8'));
  const patchesDir = path.join(REPO_ROOT, 'deepseek/vendor/deepseek-harness/patches');
  const patches = await Promise.all((await fs.readdir(patchesDir)).sort().map(async (name) => ({
    path: name,
    sha256: sha256(await fs.readFile(path.join(patchesDir, name))),
  })));
  const pinned = lock.packages['node_modules/@earendil-works/pi-ai'];
  const sources = await pluginSources(artifact);

  assert.deepEqual(metadata.llmPiAi?.piAi, {
    version: '0.85.1',
    integrity: pinned.integrity,
  });
  assert.ok(sources.length > 0);
  assert.equal(metadata.llmPiAi.sourceHash, sha256(JSON.stringify(sources)));
  assert.deepEqual(metadata.llmPiAi.patches, patches);
  assert.deepEqual(metadata.inputIdentity.contract.llmPiAi, metadata.llmPiAi);
});

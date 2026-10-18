import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { createGlmAdapter } from '../../server/src/lib/executors/glm.ts';
import {
  GLM_ADMISSION,
  GLM_POLICY_REVISION,
  GLM_PROFILE_REVISION,
  buildGlmRoute,
  glmCompatibilityIdentity,
} from '../../server/src/lib/glm/contract.ts';
import { describeGlmGeneration } from '../../server/src/lib/glm/generation.ts';
import { runtimeYaml } from '../../tools/runtimeComposition.ts';
import { GLM_FIXTURE_PLUGIN, writeGlmArtifactFixture } from '../helpers/glmArtifactFixture.mts';

const exec = promisify(execFile);
const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const FAKE_WEB = path.join(REPO_ROOT, 'tests/fixtures/deepseek-harness/fakeWeb.mjs');
const MODEL = '["zai","glm-5.3"]';
const KEYS = {
  api: 'synthetic-zai-api-key',
  'coding-plan': 'synthetic-zai-coding-key',
};

/**
 * Generation-фикстура с фейковым DSH web; запуск процесса перехватывается, чтобы прочитать
 * overlay и окружение ровно того процесса, который адаптер поднимает для хода.
 */
async function fixture(t, plugin = GLM_FIXTURE_PLUGIN, dependencyLock) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glm-admission-'));
  const project = path.join(root, 'project');
  const scenario = path.join(root, 'scenario.json');
  const log = path.join(root, 'fake.ndjson');
  const launches = [];

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(project, '.git'), { recursive: true });
  await fs.writeFile(scenario, JSON.stringify({
    updates: [{ sessionUpdate: 'agent_message_chunk', content: { text: 'ok' } }],
  }));
  await fs.writeFile(log, '');
  await writeGlmArtifactFixture(path.join(root, 'generation'), {
    llmPiAi: plugin,
    dependencyLock,
    entry: [
      'if (process.argv[2] === "-V") { console.log("0.1.5-rc.2"); process.exit(0); }',
      `process.argv.push("--scenario", ${JSON.stringify(scenario)}, "--log", ${JSON.stringify(log)});`,
      `await import(${JSON.stringify(pathToFileURL(FAKE_WEB).href)});`,
      '',
    ].join('\n'),
  });

  const config = {
    rootDir: project,
    deepseekArtifactDir: path.join(root, 'generation'),
    deepseekRuntimeMode: 'embedded',
    glmRuntimeHome: path.join(root, 'glm-home'),
  };

  return {
    root,
    project,
    config,
    launches,
    identity: (mode) => glmCompatibilityIdentity(describeGlmGeneration(config).runtime, mode),
    /**
     * DI-адаптер: окружение службы режима и запись допуска; spawn читает overlay запуска.
     */
    adapter(mode, admission) {
      return createGlmAdapter({
        env: {
          PATH: process.env.PATH,
          GRIGDESK_GLM_API_MODE: mode,
          ZAI_API_KEY: KEYS.api,
          ZAI_CODING_API_KEY: KEYS['coding-plan'],
        },
        admission,
        spawn: (command, args, options) => {
          const overlay = args[args.indexOf('--patch') + 1];

          launches.push({
            overlay: runtimeYaml().load(readFileSync(overlay, 'utf8')),
            env: options.env,
          });

          return spawn(command, args, options);
        },
      });
    },
    run(adapter) {
      return adapter.run({
        config,
        cwd: project,
        chatKey: 'admission-chat',
        message: 'x',
        model: MODEL,
        onSessionCreated: async () => {},
      });
    },
  };
}

test('недопущенный режим с ключом: у адаптера нет run, процесса нет', async (t) => {
  const f = await fixture(t);

  // Поставка допускает только api; coding-plan без подтверждения права подписки закрыт.
  assert.deepEqual(GLM_ADMISSION.map((entry) => entry.mode), ['api']);

  for (const mode of ['api', 'coding-plan']) {
    assert.equal(f.adapter(mode, []).run, undefined, mode);
    assert.equal(f.adapter(mode, [{ mode: mode === 'api' ? 'coding-plan' : 'api', compatibility: 'x' }]).run,
      undefined, mode);
  }

  assert.equal(f.launches.length, 0);
});

test('допущенный режим с другой identity generation — glm_runtime_not_admitted до процесса', async (t) => {
  const f = await fixture(t);
  const adapter = f.adapter('api', [{ mode: 'api', compatibility: 'f'.repeat(64) }]);

  assert.equal(typeof adapter.run, 'function');
  await assert.rejects(f.run(adapter), { code: 'glm_runtime_not_admitted' });
  assert.equal(f.launches.length, 0);
});

test('загрузчик в новом процессе видит run только у допущенного режима', async (t) => {
  const f = await fixture(t);
  const script = [
    `const { getProviderAdapters, getExecutor } = await import(${JSON.stringify(pathToFileURL(
      path.join(REPO_ROOT, 'server/src/lib/executors/index.ts')).href)});`,
    'const card = (await getProviderAdapters()).get("glm");',
    'const executor = Boolean(await getExecutor("glm"));',
    'console.log(JSON.stringify({ card: Boolean(card), run: typeof card?.run, executor }));',
  ].join('\n');

  for (const mode of ['api', 'coding-plan']) {
    const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', script], {
      cwd: REPO_ROOT,
      env: {
        PATH: process.env.PATH,
        HOME: f.root,
        GRIGDESK_GLM_API_MODE: mode,
        ZAI_API_KEY: KEYS.api,
        ZAI_CODING_API_KEY: KEYS['coding-plan'],
      },
      timeout: 60_000,
    });

    // Поставка допускает только api: в новом процессе run и исполнитель есть только у него.
    assert.deepEqual(JSON.parse(stdout.trim().split('\n').at(-1)), {
      card: true,
      run: mode === 'api' ? 'function' : 'undefined',
      executor: mode === 'api',
    }, mode);
  }

  assert.equal(typeof f.adapter('api', [{ mode: 'api', compatibility: f.identity('api') }]).run, 'function');
  assert.equal(f.adapter('coding-plan', [{ mode: 'api', compatibility: f.identity('api') }]).run, undefined);
});

test('допущенный режим использует ровно свой маршрут', async (t) => {
  const f = await fixture(t);

  for (const mode of ['api', 'coding-plan']) {
    const result = await f.run(f.adapter(mode, [{ mode, compatibility: f.identity(mode) }]));
    const launch = f.launches.at(-1);
    const insert = launch.overlay.find((row) => Array.isArray(row.insert)).insert;
    const providers = insert.find((row) => row.id === 'llm-pi-ai').config.providers;

    assert.equal(result.reply, 'ok');
    assert.deepEqual(providers, { zai: buildGlmRoute(mode) });
    assert.equal(launch.env.GRIGDESK_GLM_ROUTE_KEY, KEYS[mode]);

    for (const name of ['ZAI_API_KEY', 'ZAI_CODING_API_KEY']) {
      assert.equal(Object.hasOwn(launch.env, name), false, `${mode} ${name}`);
    }
  }

  assert.notEqual(f.identity('api'), f.identity('coding-plan'));
});

test('смена патча, lock сборки или GLM_PROFILE_REVISION снимает допуск', async (t) => {
  const base = await fixture(t);
  const admitted = [{ mode: 'api', compatibility: base.identity('api') }];
  const patched = await fixture(t, {
    ...GLM_FIXTURE_PLUGIN,
    patches: [{ path: 'synthetic.patch', sha256: 'd'.repeat(64) }],
  });
  const relocked = await fixture(t, GLM_FIXTURE_PLUGIN, 'e'.repeat(64));

  for (const changed of [patched, relocked]) {
    assert.notEqual(changed.identity('api'), base.identity('api'));
    await assert.rejects(changed.run(changed.adapter('api', admitted)), { code: 'glm_runtime_not_admitted' });
    assert.equal(changed.launches.length, 0);
  }

  const runtime = describeGlmGeneration(base.config).runtime;

  assert.notEqual(glmCompatibilityIdentity(runtime, 'api', {
    profile: `${GLM_PROFILE_REVISION}-next`,
    policy: GLM_POLICY_REVISION,
  }), base.identity('api'));
  assert.equal((await base.run(base.adapter('api', admitted))).reply, 'ok');
});

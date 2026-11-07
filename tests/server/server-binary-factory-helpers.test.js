import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildHelper, loadHelpers } from '../../server/scripts/sea/helpers.mts';
import { writeCompatibility } from '../../server/scripts/sea/compatibility.mts';
import { bundlePayloadServer } from '../../server/scripts/sea/bundle.mts';
import { runtimeInfoFixture } from '../helpers/deepseekMetadataFixture.mts';
import { writeDeepSeekBinaryStub } from '../helpers/deepseekBinaryStub.mts';

const SOURCE = fileURLToPath(new URL('../../', import.meta.url));
const MANIFEST = path.join(SOURCE, 'server/build/helpers.json');

test('SB08: runtime-info, runner и status MCP зарегистрированы с явным entry', async () => {
  const catalog = await loadHelpers(MANIFEST, SOURCE);

  for (const [id, kind] of [
    ['deepseek-runtime-info', 'script'], ['deepseek-runner', 'main'], ['factory-status-mcp', 'script'],
    ['factory-browser', 'main'],
  ]) {
    assert.equal(catalog.helpers.find((helper) => helper.id === id)?.entryKind, kind, id);
  }

  assert.deepEqual(catalog.helpers.find((helper) => helper.id === 'factory-browser').exports, ['main']);

  assert.ok(catalog.helpers.find((helper) => helper.id === 'deepseek-runner').exports
    .includes('runDeepSeekFactory'));
});

test('SB08: настоящий Bash runner вызывает relocated metadata wrappers без server sources',
  { timeout: 15_000 }, async (t) => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-factory-helpers-'));
    const root = path.join(base, 'R with spaces');
    const helpers = path.join(root, 'server/runtime/helpers');
    const home = path.join(base, 'home');
    const data = path.join(base, 'data');
    const info = runtimeInfoFixture();
    const { binary } = await writeDeepSeekBinaryStub(t, [
      'if (!process.argv.includes("--runtime-info")) throw new Error("Metadata only");',
      `process.stdout.write(${JSON.stringify(JSON.stringify(info))});`,
    ].join('\n'));
    const catalog = await loadHelpers(MANIFEST, SOURCE);
    const compatibility = JSON.parse(await fs.readFile(path.join(SOURCE, 'server/build/compatibility.json')));

    t.after(() => fs.rm(base, { recursive: true, force: true }));
    await fs.mkdir(helpers, { recursive: true });
    await fs.mkdir(home);
    await fs.mkdir(path.join(root, 'runtime/node/bin'), { recursive: true });
    await fs.symlink(process.execPath, path.join(root, 'runtime/node/bin/node'));
    await fs.cp(path.join(SOURCE, 'engine'), path.join(root, 'engine'), { recursive: true });
    await fs.cp(path.join(SOURCE, 'schemas'), path.join(root, 'schemas'), { recursive: true });
    await fs.copyFile(path.join(SOURCE, 'server/deepseek-host-contract.json'),
      path.join(root, 'server/deepseek-host-contract.json'));
    await fs.writeFile(path.join(helpers, 'helpers.json'), await fs.readFile(MANIFEST));

    for (const id of ['deepseek-runtime-info', 'deepseek-runner', 'factory-status-mcp', 'factory-browser']) {
      await buildHelper({
        root: SOURCE,
        manifest: catalog,
        id,
        outDir: helpers,
        workDir: path.join(base, 'build'),
      });
    }

    const selected = {
      ...compatibility,
      wrappers: compatibility.wrappers.filter((wrapper) => wrapper.helper.startsWith('deepseek-')),
    };

    assert.equal(selected.wrappers.length, 2);
    await writeCompatibility(root, selected, catalog);

    const output = execFileSync('bash', ['-c', [
      'source "$FACTORY_HOME/lib/runners/deepseek.sh"',
      'runner_deepseek_probe || exit $?',
      'runner_deepseek_catalog || exit $?',
    ].join('\n')], {
      env: {
        PATH: '/usr/bin:/bin',
        HOME: home,
        GRIGDESK_HOME: data,
        FACTORY_HOME: path.join(root, 'engine'),
        GRIGDESK_DEEPSEEK_RUNTIME_MODE: 'binary',
        GRIGDESK_DEEPSEEK_BIN: binary,
        GRIGDESK_DEEPSEEK_NODE_BIN: path.join(root, 'runtime/node/bin/node'),
        GRIGDESK_DEEPSEEK_CACHE_DIR: path.join(base, 'cache'),
        FACTORY_FORBID_LIVE: '0',
      },
      encoding: 'utf8',
      timeout: 10_000,
    });
    const rows = output.trim().split('\n');

    assert.equal(rows.length, 5);
    assert.ok(rows.every((row) => row.includes(info.packageId)));
    await assert.rejects(fs.stat(path.join(root, 'server/src')), { code: 'ENOENT' });

    const runDir = path.join(base, 'run');
    const prompt = path.join(runDir, 'prompt.md');
    const outfile = path.join(root, 'server/capture.cjs');
    const args = [
      '--bin', binary, '--cache-dir', path.join(base, 'cache'),
      '--cwd', home, '--run-dir', runDir, '--runtime-home', path.join(runDir, 'runtime-home'),
      '--prompt-file', prompt, '--model', '["deepseek-official","deepseek-v4-flash"]',
      '--effort', 'off', '--mode', 'workspace-write',
    ];
    const env = {
      HOME: home,
      GRIGDESK_HOME: data,
      GRIGDESK_PROVIDER_PREFS_PATH: path.join(base, 'prefs.json'),
      DEEPSEEK_API_KEY: 'synthetic-do-not-pass-to-status',
      FACTORY_RUN_TASK: '123',
      FACTORY_RUN_STAGE: 'BUILD',
      FACTORY_RUN_ID: 'fixture',
      FACTORY_RUN_EPOCH: '1',
      FACTORY_STATUS_MODE: 'request',
      FACTORY_STATUS_REQUEST_DIR: path.join(base, 'state/logs/runs/t123/BUILD/fixture/control-requests'),
      FACTORY_STATE: path.join(base, 'state'),
      FACTORY_LOOP_ROLE: 'lead',
    };

    await fs.symlink(path.join(SOURCE, 'server/node_modules'), path.join(root, 'server/node_modules'));
    await fs.mkdir(runDir, { mode: 0o700 });
    await fs.writeFile(prompt, 'fixture', { mode: 0o600 });
    await bundlePayloadServer({
      sourceRoot: SOURCE,
      workDir: path.join(base, 'build'),
      outfile,
      plugins: [{
        name: 'fixture-runner-capture',
        setup(builder) {
          builder.onLoad({ filter: /server\/src\/app\.ts$/ }, () => ({
            contents: [
              'import { runDeepSeekFactory } from "../scripts/deepseekRunner.mts";',
              `runDeepSeekFactory(${JSON.stringify(args)}, ${JSON.stringify(env)}, {`,
              '  emit: () => {},',
              '  runTurn: async (options) => {',
              '    process.stdout.write(JSON.stringify(options.mcpServers));',
              '    return { reply: "ok", stopReason: "end_turn" };',
              '  },',
              '}).catch((error) => { console.error(error); process.exitCode = 1; });',
            ].join('\n'),
            resolveDir: path.join(SOURCE, 'server/src'),
            loader: 'ts',
          }));
        },
      }],
    });

    const captured = execFileSync(process.execPath, [
      '-e', 'require(process.argv[1]).startPayloadServer(process.argv[2]);', outfile, binary,
    ], {
      env: {
        HOME: home,
        GRIGDESK_HOME: data,
        PATH: '',
      },
      encoding: 'utf8',
      timeout: 10_000,
    });
    const [status] = JSON.parse(captured);

    assert.equal(status.name, 'factory-status');
    assert.equal(status.command, path.join(root, 'runtime/node/bin/node'));
    assert.deepEqual(status.args, [path.join(helpers, 'factory-status-mcp.mjs')]);
    assert.ok(status.env.some((entry) => entry.name === 'FACTORY_LOOP_ROLE' && entry.value === 'lead'));
    assert.ok(status.env.every((entry) => entry.name !== 'DEEPSEEK_API_KEY'));
  });

test('SB08: compiled status MCP проводит настоящие границы стадий через route loop',
  { timeout: 90_000 }, async (t) => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-status-loop-'));
    const root = path.join(base, 'payload');
    const work = path.join(base, 'fixture');
    const output = path.join(root, 'server/runtime/helpers');

    t.after(() => fs.rm(base, { recursive: true, force: true }));

    for (const name of ['home', 'state', 'config', 'profiles', 'xdg-config', 'xdg-state', 'xdg-cache']) {
      await fs.mkdir(path.join(work, name), { recursive: true });
    }

    await fs.cp(path.join(SOURCE, 'engine'), path.join(root, 'engine'), { recursive: true });
    await fs.cp(path.join(SOURCE, 'schemas'), path.join(root, 'schemas'), { recursive: true });
    await fs.mkdir(path.join(root, 'runtime/node/bin'), { recursive: true });
    await fs.symlink(process.execPath, path.join(root, 'runtime/node/bin/node'));

    const helper = await buildHelper({
      root: SOURCE,
      manifestPath: MANIFEST,
      id: 'factory-status-mcp',
      outDir: output,
      workDir: path.join(base, 'build'),
    });
    let result;

    try {
      result = execFileSync('bash', [path.join(SOURCE, 'tests/fixtures/serverBinary/routeLoopMcp.sh')], {
        env: {
          PATH: '/usr/bin:/bin',
          HOME: path.join(work, 'home'),
          GRIGDESK_HOME: path.join(work, 'data'),
          FACTORY_HOME: path.join(SOURCE, 'engine'),
          FACTORY_TESTS_HOME: path.join(SOURCE, 'tests/engine'),
          FACTORY_TESTING: '1',
          FACTORY_FORBID_LIVE: '1',
          FACTORY_STATE: path.join(work, 'state'),
          STATE_DIR: path.join(work, 'state'),
          FACTORY_CONTROL_ROOT: path.join(work, 'control'),
          FACTORY_CONFIG_ROOT: path.join(work, 'config'),
          FACTORY_PROFILES_DIR: path.join(work, 'profiles'),
          XDG_CONFIG_HOME: path.join(work, 'xdg-config'),
          XDG_STATE_HOME: path.join(work, 'xdg-state'),
          XDG_CACHE_HOME: path.join(work, 'xdg-cache'),
          TEST_ROOT: work,
          NODE_BIN: process.execPath,
          SERVER_BINARY_STATUS_MCP: helper.file,
          SERVER_BINARY_STATUS_QUICK: '1',
          PYTHONDONTWRITEBYTECODE: '1',
        },
        encoding: 'utf8',
        timeout: 80_000,
        maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      const artifact = path.join(process.env.GRIGDESK_ARTIFACTS_DIR ?? os.tmpdir(), 's08-loop-failure');

      await fs.cp(work, artifact, { recursive: true });

      const detail = `${String(error.stdout).slice(0, 1600)} ${String(error.stderr).slice(0, 800)}`;

      assert.fail(`Route MCP fixture: ${detail}`);
    }

    assert.match(result, /признаны три границы этапа/);
    assert.doesNotMatch(result, /not ok/);
  });

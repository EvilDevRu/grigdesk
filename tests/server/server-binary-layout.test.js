import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createRuntimeContextPlugin } from '../../server/scripts/sea/context.mts';
import { createModuleUrlsPlugin } from '../../server/scripts/sea/moduleUrls.mts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(new URL('../../server/package.json', import.meta.url));
const { build } = require('esbuild');

/**
 * Реальный compiled helper живёт внутри D, а внешний ELF — в отдельной установке.
 * HOME, данные, Node link и все probes принадлежат одноразовой фикстуре.
 */
async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-binary-layout-'));
  const home = path.join(base, 'home');
  const data = path.join(base, 'data');
  const root = path.join(data, 'runtimes/server/packages', 'a'.repeat(64));
  const installation = path.join(base, 'installation');
  const binary = path.join(installation, 'bin/grigdesk-server');

  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.mkdir(home);
  await fs.mkdir(path.join(root, 'server/runtime/helpers'), { recursive: true });
  await fs.mkdir(path.join(root, 'runtime/node/bin'), { recursive: true });
  await fs.mkdir(path.dirname(binary), { recursive: true });
  await fs.writeFile(binary, 'ELF');
  await fs.symlink(process.execPath, path.join(root, 'runtime/node/bin/node'));

  return {
    root,
    installation,
    data,
    home,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: home,
      GRIGDESK_HOME: data,
      GRIGDESK_SERVER_BINARY: binary,
    },
  };
}

/**
 * Сборка использует настоящие URL/context plugins, без замены проверяемого guard.
 * Source fixture меняет только build context и сохраняет прежний запрет пересечения с кодом.
 */
async function compile(input, contents, source = false) {
  const file = path.join(input.root, 'server/runtime/helpers', source ? 'source.mjs' : 'packaged.mjs');
  const urls = createModuleUrlsPlugin({
    root: ROOT,
    runtimeModule: path.join(ROOT, 'server/src/lib/runtimePaths.ts'),
  });
  const context = source ? {
    name: 'fixture-source-context',
    setup(builder) {
      builder.onLoad({ filter: /runtimeBuildContext\.ts$/ }, () => ({
        contents: `export const runtimeBuildContext = () => (${JSON.stringify({
          mode: 'source',
          root: input.root,
          execPath: process.execPath,
        })});`,
        loader: 'ts',
      }));
    },
  } : createRuntimeContextPlugin(ROOT, 'helper');
  const result = await build({
    stdin: {
      contents,
      resolveDir: ROOT,
      loader: 'ts',
    },
    outfile: file,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    plugins: [context, urls.plugin],
    logLevel: 'silent',
  });

  assert.deepEqual(result.warnings, []);

  return file;
}

test('SB06: compiled R внутри D проходит boot guard, lock хранит фактический R', async (t) => {
  const input = await fixture(t);
  const entry = await compile(input, [
    'import "./server/src/startDataHome.ts";',
    'import fs from "node:fs";',
    'process.stdout.write(fs.readFileSync(process.env.GRIGDESK_HOME + "/state/server.lock", "utf8"));',
  ].join('\n'));
  const result = spawnSync(process.execPath, [entry], { env: input.env, encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).root, input.root);
});

test('SB06: source в D и данные внутри I сохраняют отказ 78', async (t) => {
  const input = await fixture(t);
  const source = await compile(input, 'import "./server/src/startDataHome.ts";', true);
  const packaged = await compile(input, 'import "./server/src/startDataHome.ts";');

  for (const [entry, data] of [[source, input.data], [packaged, path.join(input.installation, 'data')]]) {
    const result = spawnSync(process.execPath, [entry], {
      env: { ...input.env, GRIGDESK_HOME: data },
      encoding: 'utf8',
    });

    assert.equal(result.status, 78, result.stderr);
    assert.match(result.stderr, /Папка данных/);
  }
});

test('SB06: dataHomeCheck по умолчанию проверяет I, явный code-root сохраняет source guard', async (t) => {
  const input = await fixture(t);
  const entry = await compile(input, 'import "./server/scripts/dataHomeCheck.mts";');
  const result = spawnSync(process.execPath, [entry], { env: input.env, encoding: 'utf8' });
  const source = spawnSync(process.execPath, [entry, '--code-root', input.root], {
    env: input.env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(source.status, 78, source.stderr);
});

test('SB06: внешние defaults и PATH используют I/bin, явный DeepSeek override сохраняется', async (t) => {
  const input = await fixture(t);
  const entry = await compile(input, [
    'import { config } from "./server/src/config.ts";',
    'import { grigDeskCliPath } from "./server/src/lib/cliPath.ts";',
    'import { selectedDeepSeekBinary } from "./server/src/lib/deepseek/distribution.ts";',
    'process.stdout.write(JSON.stringify({',
    '  bin: config.installationBin, selected: selectedDeepSeekBinary({}),',
    '  deepseek: config.deepseekBin,',
    '  path: grigDeskCliPath(config.rootDir, "/usr/bin", config.installationBin),',
    '}));',
  ].join('\n'));

  for (const override of [undefined, '/explicit/deepseek']) {
    const result = spawnSync(process.execPath, [entry], {
      env: {
        ...input.env,
        ...(override ? { GRIGDESK_DEEPSEEK_BIN: override } : {}),
      },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      bin: path.join(input.installation, 'bin'),
      selected: path.join(input.installation, 'bin/deepseek'),
      deepseek: override ?? path.join(input.installation, 'bin/deepseek'),
      path: `${path.join(input.installation, 'bin')}:/usr/bin`,
    });
  }
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { bundlePayloadServer } from '../../server/scripts/sea/bundle.mts';

const SOURCE = fileURLToPath(new URL('../../', import.meta.url));

test('SB07: relocated CJS использует свой require и ленивый entry ровно один раз', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-payload-bundle-'));
  const root = path.join(base, 'payload with space');
  const outfile = path.join(root, 'server/payload.cjs');
  const binary = path.join(base, 'installation/bin/grigdesk-server');
  const foreign = path.join(base, 'foreign');

  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'server/node_modules/fixture-package'), { recursive: true });
  await fs.mkdir(path.dirname(binary), { recursive: true });
  await fs.mkdir(foreign);
  await fs.writeFile(binary, 'ELF');
  await fs.writeFile(path.join(root, 'server/node_modules/fixture-package/index.js'), 'module.exports = 42;');

  const result = await bundlePayloadServer({
    sourceRoot: SOURCE,
    workDir: base,
    outfile,
    plugins: [{
      name: 'fixture-app',
      setup(builder) {
        builder.onLoad({ filter: /server\/src\/app\.ts$/ }, () => ({
          contents: [
            'import { runtimeRoot, runtimeInstallationBin } from "./lib/runtimePaths.ts";',
            'globalThis.boots = (globalThis.boots ?? 0) + 1;',
            'globalThis.details = { root: runtimeRoot(), bin: runtimeInstallationBin(),',
            '  dependency: require("fixture-package") };',
          ].join('\n'),
          loader: 'ts',
          resolveDir: path.join(SOURCE, 'server/src'),
        }));
      },
    }],
  });
  const script = [
    `const entry = require(${JSON.stringify(outfile)});`,
    'const before = globalThis.boots ?? 0;',
    '(async () => {',
    `  await entry.startPayloadServer(${JSON.stringify(binary)});`,
    `  await entry.startPayloadServer(${JSON.stringify(binary)});`,
    '  const details = { before, boots: globalThis.boots ?? 0, ...globalThis.details };',
    '  process.stdout.write(JSON.stringify(details));',
    '})().catch((error) => { console.error(error); process.exitCode = 1; });',
  ].join('\n');
  const output = execFileSync(process.execPath, ['-e', script], {
    cwd: foreign,
    env: { PATH: '' },
    encoding: 'utf8',
    timeout: 10_000,
  });

  assert.deepEqual(JSON.parse(output), {
    before: 0,
    boots: 1,
    root,
    bin: path.dirname(binary),
    dependency: 42,
  });
  assert.deepEqual(result.warnings, []);
  assert.equal((await fs.readFile(outfile, 'utf8')).includes(SOURCE), false);
});

test('SB07: payload context требует configure и запрещает смену физического binary', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-payload-context-'));
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  const bundleFile = path.join(root, 'payload.cjs');

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await Promise.all([first, second, bundleFile].map((file) => fs.writeFile(file, 'fixture')));

  const module = await import(pathToFileURL(path.join(SOURCE, 'server/src/binary/payloadContext.ts')).href);

  assert.throws(module.runtimeBuildContext, { code: 'server_payload_context_missing' });
  module.configurePayloadContext({
    mode: 'payload',
    bundleFile,
    binary: first,
  });
  module.configurePayloadContext({
    mode: 'payload',
    bundleFile,
    binary: first,
  });

  const context = module.runtimeBuildContext();

  context.binary = second;
  assert.equal(module.runtimeBuildContext().binary, first);
  assert.throws(() => module.configurePayloadContext({
    mode: 'payload',
    bundleFile,
    binary: second,
  }), {
    code: 'server_payload_context_changed',
  });
  assert.throws(() => module.configurePayloadContext({
    mode: 'payload',
    bundleFile,
    binary: 'relative',
  }), {
    code: 'server_payload_context_invalid',
  });
});

test('SB11-verification: payload отдаёт compiled adapters и wrappers без загрузки app',
  { timeout: 120_000 }, async (t) => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-payload-verification-'));
    const root = path.join(base, 'payload with space');
    const outfile = path.join(root, 'server/payload.cjs');
    const binary = path.join(base, 'installation/bin/grigdesk-server');

    t.after(() => fs.rm(base, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, 'server'), { recursive: true });
    await fs.mkdir(path.dirname(binary), { recursive: true });
    await fs.writeFile(binary, 'ELF');
    // Внешние npm-зависимости compiled graph R разрешает из своего server/node_modules,
    // каталог helper-ов и свой Node payload читает при инициализации модулей политики.
    await fs.mkdir(path.join(root, 'runtime/node/bin'), { recursive: true });
    await fs.symlink(process.execPath, path.join(root, 'runtime/node/bin/node'));
    await fs.symlink(path.join(SOURCE, 'server/node_modules'), path.join(root, 'server/node_modules'));
    await fs.mkdir(path.join(root, 'server/runtime/helpers'), { recursive: true });
    await fs.copyFile(path.join(SOURCE, 'server/build/helpers.json'),
      path.join(root, 'server/runtime/helpers/helpers.json'));

    const result = await bundlePayloadServer({
      sourceRoot: SOURCE,
      workDir: base,
      outfile,
      plugins: [{
        name: 'fixture-app',
        setup(builder) {
          builder.onLoad({ filter: /server\/src\/app\.ts$/ }, () => ({
            contents: 'globalThis.boots = (globalThis.boots ?? 0) + 1;',
            loader: 'ts',
            resolveDir: path.join(SOURCE, 'server/src'),
          }));
        },
      }],
    });
    const script = [
      `const entry = require(${JSON.stringify(outfile)});`,
      '(async () => {',
      '  if (typeof entry.loadPackagedVerification !== "function") {',
      '    process.stdout.write(JSON.stringify({ missing: true }));',
      '    return;',
      '  }',
      `  const api = await entry.loadPackagedVerification(${JSON.stringify(binary)});`,
      '  const kinds = Object.fromEntries(Object.entries(api).map(([name, value]) => [name, typeof value]));',
      '  process.stdout.write(JSON.stringify({ boots: globalThis.boots ?? 0, kinds }));',
      '})().catch((error) => { console.error(error); process.exitCode = 1; });',
    ].join('\n');
    const output = JSON.parse(execFileSync(process.execPath, ['-e', script], {
      cwd: base,
      env: {
        PATH: '',
        HOME: base,
        GRIGDESK_HOME: path.join(base, 'data'),
      },
      encoding: 'utf8',
      timeout: 60_000,
    }));

    assert.deepEqual(result.warnings, []);
    assert.deepEqual(output, {
      boots: 0,
      kinds: {
        createGlmAdapter: 'function',
        runGlmTurn: 'function',
        runDeepSeekWebTurn: 'function',
        runDeepSeekTurn: 'function',
        prepareDeepSeekLaunch: 'function',
        startDeepSeekServer: 'function',
        glmCompatibilityIdentity: 'function',
        runDeepSeekFactory: 'function',
        runGlmFactory: 'function',
      },
    });
  });

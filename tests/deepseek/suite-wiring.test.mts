import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runPackageTests } from '../../shared/node/packageTests.ts';

const repository = path.resolve(import.meta.dirname, '../..');

/**
 * Проверка shell-проводки дополняет поведенческую проверку runner ниже.
 * Удаление любой ступени нового пакета обязано ломать общий gate ещё до дорогой parity.
 */
test('проводка run-all содержит отдельные unit и SEA ступени DeepSeek', async () => {
  const source = await fs.readFile(path.join(repository, 'tests/run-all.sh'), 'utf8');

  assert.match(source, /npm --prefix "\$PROJECT_ROOT\/deepseek" test/u);
  assert.match(source, /npm --prefix "\$PROJECT_ROOT\/deepseek" run test:sea/u);
  assert.match(source, /GRIGDESK_TEST_DEEPSEEK_BINARY/u);
  assert.match(source, /GRIGDESK_RELEASE_PUBLISH_CONTRACT=2/u);
});

/**
 * Stub только фиксирует argv вместо исполнения вложенного набора; внешний тест под guard.
 * Произвольные имена SEA файлов и код отказа runner наблюдаются через настоящий subprocess.
 */
test('общий runner выбирает все имена SEA без фильтра «настоящ» и возвращает отказ ступени', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'suite-wiring-'));
  const unit = path.join(root, 'unit');
  const sea = path.join(root, 'sea');
  const runner = path.join(root, 'runner.sh');
  const report = path.join(root, 'args.txt');
  const before = process.env.SUITE_WIRING_REPORT;

  t.after(async () => {
    if (before === undefined) {
      delete process.env.SUITE_WIRING_REPORT;
    } else {
      process.env.SUITE_WIRING_REPORT = before;
    }

    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(unit);
  await fs.mkdir(sea);
  await fs.writeFile(path.join(unit, 'unit.test.mts'), '');
  await fs.writeFile(path.join(sea, 'arbitrary-new-name.test.mts'), '');
  await fs.writeFile(path.join(sea, 'another.test.mts'), '');
  await fs.writeFile(path.join(sea, 'ignored.txt'), '');
  await fs.writeFile(runner, 'printf "%s\\n" "$@" > "$SUITE_WIRING_REPORT"\nexit 7\n');
  process.env.SUITE_WIRING_REPORT = report;

  const code = await runPackageTests({
    root,
    runner,
    directory: sea,
    sea: true
  });
  const argumentsList = (await fs.readFile(report, 'utf8')).trim().split('\n');

  assert.equal(code, 7, 'Отказ новой ступени нельзя поглотить');
  assert.deepEqual(argumentsList, [
    '--test',
    '--test-concurrency=1',
    path.join(sea, 'another.test.mts'),
    path.join(sea, 'arbitrary-new-name.test.mts'),
  ]);
  assert.equal(await runPackageTests({
    root,
    runner,
    directory: unit,
    sea: false
  }), 7);
  assert.deepEqual((await fs.readFile(report, 'utf8')).trim().split('\n'), [
    '--test',
    '--test-concurrency=2',
    path.join(unit, 'unit.test.mts'),
  ]);
});

import { runDeepSeekCandidateGate } from '../../server/scripts/deepSeekCandidateGate.ts';

/**
 * Stub run фиксирует source builder argv и единый binary для обеих ступеней пакета и host parity.
 * Ошибка unit/SEA не даёт source-sync продолжить gate; фильтр имён не используется.
 */
test('candidate gate передаёт vendor builder-у и не пропускает отказ unit или SEA', async () => {
  const options = {
    repository: '/fixture/repository',
    vendorDir: '/fixture/changed-vendor',
    outputDir: '/fixture/output',
    nodeCacheDir: '/fixture/node-cache',
  };
  const calls: {
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
  }[] = [];
  const run = async (command: string, args: string[], env: NodeJS.ProcessEnv) => {
    calls.push({
      command,
      args,
      env,
    });

    return { code: 0, stdout: JSON.stringify({ payload: { sha256: 'a'.repeat(64) } }) };
  };

  await runDeepSeekCandidateGate(options, run);
  assert.ok(calls[0]!.args.includes(options.vendorDir));
  assert.ok(calls[0]!.args.includes('--vendor-dir'));
  assert.ok(calls.some((call) => call.args.at(-1) === 'test'));
  assert.ok(calls.some((call) => call.args.at(-1) === 'test:sea'));
  assert.ok(calls.at(-1)!.args.some((arg) => arg.endsWith('deepseek-acp-settings.test.js')));
  assert.ok(calls.every((call) => !call.args.some((arg) => arg.startsWith('--test-name-pattern'))));

  for (const call of calls.slice(1)) {
    assert.equal(call.env.GRIGDESK_TEST_DEEPSEEK_BINARY, '/fixture/output/deepseek');
    assert.equal(call.env.GRIGDESK_TEST_DEEPSEEK_PAYLOAD,
      `/fixture/node-cache/payloads/${'a'.repeat(64)}/payload.zip`);
  }

  for (const failure of ['test', 'test:sea']) {
    const visited: string[] = [];

    await assert.rejects(runDeepSeekCandidateGate(options, async (_command, args) => {
      visited.push(args.at(-1)!);

      return {
        code: args.at(-1) === failure ? 7 : 0,
        stdout: JSON.stringify({ payload: { sha256: 'a'.repeat(64) } }),
      };
    }), /7/u);
    assert.equal(visited.at(-1), failure, 'После отказа ступени другие не запускаются');
  }
});

/**
 * Настоящий ELF одинаково отвечает из корня и server; отсутствующий override не подменяется.
 * Source builder с отсутствующим explicit vendor обязан отказать, даже при готовом default vendor.
 */
test('реальные CLI: root/server эквивалентны, missing binary и explicit vendor не имеют fallback', {
  timeout: 900000,
}, async (t) => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { ensureTestDeepSeekBinary } = await import('../helpers/deepseekBinary.mts');
  const execute = promisify(execFile);
  const candidate = await ensureTestDeepSeekBinary();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'suite-cli-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const replies = await Promise.all([repository, path.join(repository, 'server')].map(async (cwd) => {
    const result = await execute(candidate.binary, ['--runtime-info', '--json'], {
      cwd,
      env: { PATH: '' },
    });

    assert.equal(result.stderr, '');

    return JSON.parse(result.stdout);
  }));

  assert.deepEqual(replies[0], replies[1]);
  assert.equal(replies[0].packageId, candidate.info.packageId);
  await assert.rejects(execute(process.execPath, [
    path.join(repository, 'server/scripts/prepareDeepSeekRuntime.mts'),
  ], {
    cwd: path.join(repository, 'server'),
    env: {
      PATH: process.env.PATH,
      HOME: root,
      GRIGDESK_HOME: root,
      GRIGDESK_DEEPSEEK_BIN: path.join(root, 'missing-binary'),
    },
  }), (error: unknown) => {
    const failed = error as { code: number; stderr: string };

    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /install:binary/u);

    return true;
  });

  const missingVendor = path.join(root, 'missing-explicit-vendor');
  const nodeCache = path.dirname(path.dirname(path.dirname(candidate.payloadFile)));

  await assert.rejects(execute(process.execPath, [
    path.join(repository, 'deepseek/scripts/buildBinary.mts'),
    '--vendor-dir', missingVendor,
    '--node-cache-dir', nodeCache,
    '--out-dir', path.join(root, 'output'),
  ], { env: { PATH: process.env.PATH }, maxBuffer: 65536 }), (error: unknown) => {
    const failed = error as { code: number; stderr: string };

    assert.equal(failed.code, 1);
    assert.ok(failed.stderr.includes(missingVendor), failed.stderr);

    return true;
  });
});

/**
 * Чистая consumer-копия действительно исполняет проводку run-all с подменёнными дорогими наборами.
 * Producer helper и metadata consumers настоящие: отсутствие root/bin/deepseek не скрывается.
 * Набор многократно выполняет полный verify; его deadline не измеряет скорость startup.
 * Запас на дисковую нагрузку не меняет отдельный предел быстрого отказа missing candidate.
 */
test('чистый run-all передаёт один ELF всем наборам и вложенному candidate gate', {
  timeout: 900000,
}, async (t) => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { ensureTestDeepSeekBinary } = await import('../helpers/deepseekBinary.mts');
  const { removePrivateTree } = await import('../../shared/node/files.ts');
  const execute = promisify(execFile);
  const candidate = await ensureTestDeepSeekBinary();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'suite-clean-'));
  const report = path.join(root, 'observed.jsonl');
  const prepares = path.join(root, 'prepared.txt');

  t.after(() => removePrivateTree(root));

  for (const relative of ['server/src', 'server/scripts', 'shared', 'tests/helpers', 'deepseek']) {
    await fs.cp(path.join(repository, relative), path.join(root, relative), {
      recursive: true,
      filter: (file) => !['node_modules', '.cache', 'upstream'].includes(path.basename(file)),
    });
  }

  for (const name of ['package.json', 'deepseek-host-contract.json', 'deepseek-runtime-contract.json']) {
    await fs.copyFile(path.join(repository, 'server', name), path.join(root, 'server', name));
  }

  await fs.symlink(path.join(repository, 'server/node_modules'), path.join(root, 'server/node_modules'));
  await fs.symlink(path.join(repository, 'deepseek/node_modules'), path.join(root, 'deepseek/node_modules'));
  await fs.mkdir(path.join(root, 'bin'));
  await fs.mkdir(path.join(root, 'tests/engine'), { recursive: true });
  await fs.copyFile(path.join(repository, 'tests/run-all.sh'), path.join(root, 'tests/run-all.sh'));

  const observeSuite = 'exec "$SUITE_NODE" "$SUITE_PROBE"\n';

  await fs.writeFile(path.join(root, 'tests/layout.sh'), observeSuite);
  await fs.writeFile(path.join(root, 'tests/engine/run-offline.sh'), observeSuite);
  // Только producer получает выбранную fixture через seam своего subprocess.
  // Потребители стартуют без override и зависят от настоящих export в run-all.
  await fs.writeFile(path.join(root, 'tests/run-node-tests-safe.sh'), [
    '#!/bin/bash',
    'case "$1" in',
    '  */deepseekBinary.mts)',
    '    printf "%s\\n" "$*" >> "$SUITE_PREPARES"',
    '    export GRIGDESK_TEST_DEEPSEEK_BINARY="${GRIGDESK_TEST_DEEPSEEK_BINARY:-$SUITE_INPUT_BINARY}"',
    '    export GRIGDESK_TEST_DEEPSEEK_CACHE_DIR="$SUITE_INPUT_CACHE"',
    '    export GRIGDESK_TEST_DEEPSEEK_PAYLOAD="$SUITE_INPUT_PAYLOAD"',
    '    exec "$SUITE_NODE" "$@" ;;',
    '  */deepseekRuntimeArtifact.mts) printf "%s\\n" "$SUITE_LEGACY" ;;',
    '  *) exec "$SUITE_NODE" "$SUITE_PROBE" ;;',
    'esac',
  ].join('\n'));

  const probe = path.join(root, 'probe.mjs');
  const npm = path.join(root, 'bin/npm');

  await fs.writeFile(probe, [
    'import assert from "node:assert/strict";',
    'import fs from "node:fs/promises";',
    'import { ensureGlmTestRuntime } from "./tests/helpers/glmTestRuntime.mts";',
    'assert.ok(process.env.GRIGDESK_TEST_DEEPSEEK_BINARY, "run-all обязан передать candidate");',
    'const runtime = await ensureGlmTestRuntime();',
    'assert.equal(runtime.config.deepseekBin, process.env.GRIGDESK_TEST_DEEPSEEK_BINARY);',
    'assert.equal(runtime.config.deepseekCacheDir, process.env.GRIGDESK_TEST_DEEPSEEK_CACHE_DIR);',
    'assert.equal(process.env.GRIGDESK_TEST_GLM_DELIVERY, "binary");',
    'await assert.rejects(fs.access(new URL("./bin/deepseek", import.meta.url)), {code:"ENOENT"});',
    'await fs.appendFile(process.env.SUITE_REPORT,',
    '  JSON.stringify({binary:runtime.config.deepseekBin})+"\\n");',
  ].join('\n'));
  await fs.writeFile(npm, [
    `#!${process.execPath}`,
    'const {execFileSync}=require("node:child_process");',
    'const fs=require("node:fs"); const path=require("node:path");',
    'execFileSync(process.execPath,[process.env.SUITE_PROBE],{stdio:"inherit"});',
    'if (process.argv[3].endsWith("/server") && process.argv.at(-1)==="test") {',
    '  (async()=>{',
    '    const {runDeepSeekCandidateGate}=await import(process.env.SUITE_GATE);',
    '    const output=path.join(process.env.SUITE_ROOT,"nested");',
    '    fs.mkdirSync(output);',
    '    await runDeepSeekCandidateGate({repository:process.env.SUITE_ROOT,',
    '      vendorDir:path.join(process.env.SUITE_ROOT,"deepseek/vendor/deepseek-harness"),',
    '      outputDir:output,nodeCacheDir:process.env.GRIGDESK_DEEPSEEK_NODE_CACHE},',
    '      async (_command,args,env)=>{',
    '        if(args.includes("--vendor-dir")){',
    '          fs.copyFileSync(process.env.GRIGDESK_TEST_DEEPSEEK_BINARY,path.join(output,"deepseek"));',
    '          return {code:0,stdout:JSON.stringify({payload:{sha256:process.env.SUITE_PAYLOAD_SHA}})};',
    '        }',
    '        execFileSync(process.execPath,[process.env.SUITE_PROBE],{env,stdio:"inherit"});',
    '        return {code:0,stdout:""};',
    '      });',
    '  })().catch(error=>{console.error(error);process.exitCode=1});',
    '}',
  ].join('\n'), { mode: 0o755 });

  const nodeCache = path.dirname(path.dirname(path.dirname(candidate.payloadFile)));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${path.join(root, 'bin')}:${process.env.PATH}`,
    SUITE_INPUT_BINARY: candidate.binary,
    SUITE_INPUT_CACHE: candidate.cacheDir,
    SUITE_INPUT_PAYLOAD: candidate.payloadFile,
    GRIGDESK_DEEPSEEK_NODE_CACHE: nodeCache,
    GRIGDESK_RUN_ALL_LOCK: path.join(root, 'run-all.lock'),
    SUITE_NODE: process.execPath,
    SUITE_ROOT: root,
    SUITE_PROBE: probe,
    SUITE_REPORT: report,
    SUITE_PREPARES: prepares,
    SUITE_GATE: path.join(root, 'server/scripts/deepSeekCandidateGate.ts'),
    SUITE_PAYLOAD_SHA: path.basename(path.dirname(candidate.payloadFile)),
    SUITE_LEGACY: path.join(root, 'legacy-stub'),
  };

  delete env.NODE_TEST_CONTEXT;
  delete env.GRIGDESK_TEST_DEEPSEEK_BINARY;
  delete env.GRIGDESK_TEST_DEEPSEEK_CACHE_DIR;
  delete env.GRIGDESK_TEST_DEEPSEEK_PAYLOAD;
  delete env.GRIGDESK_TEST_GLM_DELIVERY;
  await execute('bash', [path.join(root, 'tests/run-all.sh')], {
    cwd: root,
    env,
    timeout: 600000,
  });

  const observed = (await fs.readFile(report, 'utf8')).trim().split('\n')
    .map((line) => JSON.parse(line).binary);

  const nestedBinary = path.join(root, 'nested/deepseek');

  // Группа браузера добавляет одного потребителя к прежней фиксированной описи.
  // Остальные ступени этого ожидания здесь не пересматриваются.
  assert.equal(observed.filter((binary) => binary === candidate.binary).length, 15);
  assert.equal(observed.filter((binary) => binary === nestedBinary).length, 5);
  assert.ok(observed.every((binary) => binary === candidate.binary || binary === nestedBinary));

  const preparations = (await fs.readFile(prepares, 'utf8')).trim().split('\n');

  assert.equal(preparations.length, 1, 'Один full run подготавливает candidate один раз');
  assert.ok(preparations[0]!.endsWith('--prepare-suite'));
  await fs.writeFile(report, '');
  await assert.rejects(execute('bash', [path.join(root, 'tests/run-all.sh')], {
    cwd: root,
    env: { ...env, GRIGDESK_TEST_DEEPSEEK_BINARY: path.join(root, 'missing-candidate') },
    timeout: 10000,
  }));
  assert.equal(await fs.readFile(report, 'utf8'), '', 'Нет candidate — ни один набор не начинается');
});

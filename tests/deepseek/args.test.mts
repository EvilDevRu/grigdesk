import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

import { build } from '../../deepseek/node_modules/esbuild/lib/main.js';

import {
  launcherFailure,
  LauncherArgumentError,
  parseLauncherArgs,
} from '../../deepseek/src/launcher/args.ts';
import { artifactsPath } from '../../shared/runtime/dataHome.ts';

test('launcher разбирает metadata-флаги и абсолютный cache-dir без запуска Harness', () => {
  const value = parseLauncherArgs(['--runtime-info', '--json', '--cache-dir', '/tmp/unused cache']);

  assert.deepEqual(value, {
    mode: 'runtime-info',
    json: true,
    cacheDir: '/tmp/unused cache',
    expectedPackageId: null,
    harnessArgs: [],
  });
});

test('повторы, пропуски, неизвестные metadata-аргументы и конфликты дают код ошибки аргументов', () => {
  for (const args of [
    ['--runtime-info', '--json', '--json'],
    ['--version', '-V'],
    ['--help', '--version'],
    ['--cache-dir', '/a', '--cache-dir', '/b'],
    ['--expect-package-id', 'a'.repeat(64), '--expect-package-id', 'b'.repeat(64)],
    ['--cache-dir'],
    ['--cache-dir', '--runtime-info', '--json'],
    ['--expect-package-id'],
    ['--expect-package-id', 'bad-id'],
    ['--cache-dir', 'relative'],
    ['--runtime-info', '--json', '--unknown'],
    ['--runtime-info', '--json', '--profile', 'acp'],
    ['--help', '--profile', 'web'],
    ['--runtime-info'],
    ['--verify'],
    ['--json'],
    ['--version', '--json'],
  ]) {
    assert.throws(() => parseLauncherArgs(args), { code: 'deepseek_arguments_invalid' }, args.join(' '));
  }
});

test('все аргументы после первого Harness-аргумента передаются без изменений', () => {
  const harnessArgs = [
    '--profile', 'acp', '--unknown', '--cache-dir', 'relative', '--runtime-info', '--json',
  ];
  const value = parseLauncherArgs(['--cache-dir', '/tmp/cache', '--expect-package-id',
    'a'.repeat(64), ...harnessArgs]);

  assert.equal(value.mode, 'run');
  assert.equal(value.json, false);
  assert.equal(value.cacheDir, '/tmp/cache');
  assert.equal(value.expectedPackageId, 'a'.repeat(64));
  assert.deepEqual(value.harnessArgs, harnessArgs);
  assert.deepEqual(parseLauncherArgs(['--unknown', '--help']).harnessArgs, ['--unknown', '--help']);
});

test('короткие metadata-команды и verify распознаются без Harness', () => {
  for (const [flag, mode] of [['--help', 'help'], ['-V', 'version'], ['--version', 'version'],
    ['--license', 'license']] as const) {
    assert.equal(parseLauncherArgs([flag]).mode, mode);
  }

  assert.equal(parseLauncherArgs(['--verify', '--json']).mode, 'verify');
  assert.equal(parseLauncherArgs([]).mode, 'run');
});

test('metadata-отказ оставляет stdout пустым и различает коды 2 и 1 безопасным stderr', () => {
  const argumentFailure = launcherFailure(new LauncherArgumentError('Неверные аргументы', true));
  const runtimeFailure = launcherFailure(new Error('SECRET_KEY=do-not-print'), true);

  assert.equal(argumentFailure.exitCode, 2);
  assert.equal(argumentFailure.stdout, '');
  assert.deepEqual(JSON.parse(argumentFailure.stderr), {
    code: 'deepseek_arguments_invalid',
    message: 'Неверные аргументы',
  });
  assert.equal(runtimeFailure.exitCode, 1);
  assert.equal(runtimeFailure.stdout, '');
  assert.deepEqual(JSON.parse(runtimeFailure.stderr), {
    code: 'deepseek_launcher_failed',
    message: 'Не удалось запустить DeepSeek',
  });
  assert.doesNotMatch(runtimeFailure.stderr, /SECRET_KEY|do-not-print/u);
});

test('source CLI проверяет stderr/exit code и не создаёт metadata cache', async (t) => {
  const scratch = path.join(artifactsPath({ env: process.env, home: os.homedir() }), 'deepseek-args-tests');

  await mkdir(scratch, { recursive: true });

  const temporary = await mkdtemp(path.join(scratch, 'fixture-'));

  t.after(() => rm(temporary, { recursive: true, force: true }));

  const fixture = path.join(temporary, 'cli.mts');
  const cache = path.join(temporary, 'absent-cache');
  const home = path.join(temporary, 'absent-home');
  const moduleUrl = new URL('../../deepseek/src/launcher/args.ts', import.meta.url).href;

  await writeFile(fixture, `
import { parseLauncherArgs, launcherFailure } from ${JSON.stringify(moduleUrl)};

try {
  if (process.argv[2] === '--probe-failure') {
    throw new Error('SECRET_KEY=do-not-print');
  }

  process.stdout.write(JSON.stringify(parseLauncherArgs(process.argv.slice(2))) + '\\n');
} catch (error) {
  const result = launcherFailure(error, process.argv[2] === '--probe-failure');

  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
`);

  const options = {
    env: {
      PATH: '',
      HOME: home,
      NODE_NO_WARNINGS: '1',
    },
    encoding: 'utf8' as const,
    timeout: 10000,
  };
  const metadata = spawnSync(process.execPath, [fixture, '--runtime-info', '--json', '--cache-dir', cache],
    options);

  assert.equal(metadata.status, 0, metadata.stderr);
  assert.equal(metadata.stderr, '');
  assert.equal(JSON.parse(metadata.stdout).mode, 'runtime-info');
  await assert.rejects(access(cache), { code: 'ENOENT' });
  await assert.rejects(access(home), { code: 'ENOENT' });

  for (const [args, exitCode, json] of [
    [['--runtime-info', '--json', '--unknown'], 2, true],
    [['--cache-dir', '--runtime-info', '--json'], 2, true],
    [['--cache-dir', 'relative'], 2, false],
    [['--probe-failure'], 1, true],
  ] as const) {
    const failure = spawnSync(process.execPath, [fixture, ...args], options);

    assert.equal(failure.status, exitCode, failure.stderr);
    assert.equal(failure.stdout, '');
    assert.ok(failure.stderr.trim());
    assert.doesNotMatch(failure.stderr, /SECRET_KEY|do-not-print/u);

    if (json) {
      assert.equal(typeof JSON.parse(failure.stderr).code, 'string');
      assert.equal(typeof JSON.parse(failure.stderr).message, 'string');
    }
  }
});

test('metadata-парсер работает без доступа к env, HOME и файловым API', async () => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../../deepseek/src/launcher/args.ts', import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  });
  const exported = { exports: {} as { parseLauncherArgs?: typeof parseLauncherArgs } };
  const forbidden = () => {
    throw new Error('Metadata обращается к окружению или файлам');
  };
  const sandbox = {
    module: exported,
    require: (name: string) => name === 'node:path' ? path : forbidden(),
  };

  Object.defineProperty(sandbox, 'process', { get: forbidden });
  runInNewContext(bundle.outputFiles[0]!.text, sandbox);

  for (const flags of [['--help'], ['-V'], ['--license'], ['--runtime-info', '--json']]) {
    const result = exported.exports.parseLauncherArgs!(['--cache-dir', '/unread/cache', ...flags]);

    assert.equal(result.cacheDir, '/unread/cache');
    assert.notEqual(result.mode, 'run');
  }
});

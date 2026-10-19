import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  SEA_REQUIRE_BANNER,
  buildSeaBinary,
} from '../../../server/scripts/sea/buildSteps.mts';
import type { NodeRuntime } from '../../../shared/node/nodeRuntime.ts';
import { nodeArchive } from '../../../shared/node/seaBuild.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const FIXTURES = path.join(ROOT, 'tests/server/sea/fixtures/mechanism');
const run = promisify(execFile);

/**
 * Отдельный временный корень прогона: в нём живут кэш, R с пробелом в пути
 * и результаты пробы. Настоящий сервер и его папка данных не затрагиваются.
 */
async function scratch(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-sea-mechanism-'));

  t.after(() => rm(root, {
    recursive: true,
    force: true
  }));

  return root;
}

/**
 * Читает закреплённый runtime сервера и проверяет, что архив уже есть в кэше.
 * Отсутствие архива — отказ, а не skip: механизм обязан проверяться на нём.
 */
async function pinnedRuntime(): Promise<{ runtime: NodeRuntime; archive: string }> {
  const runtime = JSON.parse(
    await readFile(path.join(ROOT, 'server/build/node-runtime.json'), 'utf8'),
  ) as NodeRuntime;
  const { name } = nodeArchive(runtime);

  for (const cache of ['b24/.cache', 'relay/.cache']) {
    const archive = path.join(ROOT, cache, name);

    try {
      if ((await stat(archive)).isFile()) {
        return { runtime, archive };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  throw new Error(`Нет проверенного архива ${name}: сначала положите его в b24/.cache`);
}

/**
 * Собирает минимальный layout R с пробелом в пути.
 * Внешние npm-пакеты берутся из установленного server/node_modules по ссылке,
 * а вложенный Node — из того же проверенного архива, что и SHA256-манифест.
 */
async function prepareLayout(root: string, runtime: NodeRuntime, archive: string):
  Promise<{ R: string; out: string }> {
  const R = path.join(root, 'R with space');
  const out = path.join(root, 'probe out');
  const nodeDirectory = path.join(R, 'runtime/node');

  await mkdir(path.join(R, 'server/runtime/helpers'), {
    recursive: true
  });
  await mkdir(nodeDirectory, {
    recursive: true
  });
  await mkdir(path.join(R, 'plugin ext/lib'), {
    recursive: true
  });
  await mkdir(out, {
    recursive: true
  });

  await copyFile(path.join(ROOT, 'server/package.json'), path.join(R, 'server/package.json'));
  await symlink(
    path.join(ROOT, 'server/node_modules'),
    path.join(R, 'server/node_modules'),
    'dir',
  );
  await copyFile(path.join(FIXTURES, 'helper.mjs'),
    path.join(R, 'server/runtime/helpers/hello.mjs'));
  await copyFile(path.join(FIXTURES, 'esmBridge.cjs'),
    path.join(R, 'server/runtime/esmBridge.cjs'));
  await copyFile(path.join(FIXTURES, 'plugin/index.mjs'), path.join(R, 'plugin ext/index.mjs'));
  await copyFile(path.join(FIXTURES, 'plugin/lib/value.mjs'),
    path.join(R, 'plugin ext/lib/value.mjs'));

  const { directory } = nodeArchive(runtime);

  await run('tar', [
    '-xJf', archive, '-C', nodeDirectory, '--strip-components=1',
    `${directory}/bin/node`, `${directory}/LICENSE`,
  ]);

  return { R, out };
}

/**
 * Ждёт появления файла пробы, но не дольше указанного срока.
 * Отсутствие результата остаётся диагностируемым отказом теста.
 */
async function waitForFile(file: string, timeoutMs = 30000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      if ((await stat(file)).isFile()) {
        return true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    await sleep(50);
  }

  return false;
}

/**
 * Запускает готовый бинарник из временного пути рядом с целью, без системного
 * Node в PATH и с посторонним cwd. Проверяет протокол, затем останавливает SIGTERM.
 */
function probeFixture(R: string, out: string) {
  return async (binary: string): Promise<void> => {
    const reportFile = path.join(out, 'report.json');
    const child = spawn(binary, [], {
      cwd: '/',
      env: {
        PATH: '/nonexistent',
        PROBE_OUT: out,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let exited = false;

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('exit', () => {
      exited = true;
    });

    const appeared = await waitForFile(reportFile).then(async (ready) => {
      if (ready) {
        return true;
      }

      if (exited) {
        return false;
      }

      return waitForFile(reportFile, 1000);
    });

    if (!appeared) {
      child.kill('SIGKILL');
      await once(child, 'exit').catch(() => {});

      throw new Error(`SEA механизм не отдал отчёт: stdout=${stdout} stderr=${stderr}`);
    }

    child.kill('SIGTERM');

    const [code, signal] = await once(child, 'exit') as [number | null, string | null];

    assert.equal(signal, null, `SEA завершился сигналом ${signal}: ${stderr}`);
    assert.equal(code, 0, `SEA завершился кодом ${code}: ${stderr}`);
    assert.equal(await readFile(path.join(out, 'sigterm.txt'), 'utf8'), 'closed\n');

    const report = JSON.parse(await readFile(reportFile, 'utf8')) as {
      argv: string[];
      bridgeMarker: string;
      cwd: string;
      execPath: string;
      fastifyResolvedFrom: string;
      helper: {
        status: number;
        stdout: string;
        stderr: string;
      };
      httpPing: string;
      httpPlugin: string;
      isSea: boolean;
      packageJson: boolean;
      R: string;
    };

    assert.equal(report.isSea, true);
    assert.equal(report.R, R);
    assert.equal(report.cwd, '/');
    assert.equal(report.packageJson, true);
    assert.ok(path.isAbsolute(report.fastifyResolvedFrom));
    assert.match(report.fastifyResolvedFrom, /node_modules\/fastify\/fastify\.js$/);
    assert.equal(await stat(report.fastifyResolvedFrom).then((info) => info.isFile()), true);
    assert.equal(report.bridgeMarker, 'function relative-import+tla');
    assert.deepEqual(JSON.parse(report.httpPing), { ok: true });
    assert.deepEqual(JSON.parse(report.httpPlugin), {
      plugin: 'relative-import+tla',
      value: 'из соседнего файла',
    });
    assert.equal(report.helper.status, 0, report.helper.stderr);
    assert.equal(report.helper.stderr, '');

    const helper = JSON.parse(report.helper.stdout) as {
      abi: string;
      argv: string[];
      execPath: string;
      node: string;
    };

    assert.equal(helper.node, 'v24.21.0');
    assert.equal(helper.abi, '137');
    assert.deepEqual(helper.argv, ['a b', '']);
    assert.equal(helper.execPath, path.join(R, 'runtime/node/bin/node'));
  };
}

/**
 * Собирает настоящий SEA на закреплённом Node и проверяет механизм целиком.
 * Сеть не используется: архив берётся из кэша предыдущих выпусков.
 */
test('SEA-MECH-01: SEA отдаёт HTTP, грузит внешний ESM и helper и слушает SIGTERM', async (t) => {
  const root = await scratch(t);
  const { runtime, archive } = await pinnedRuntime();
  const { R, out } = await prepareLayout(root, runtime, archive);
  const cache = path.join(root, 'cache');
  const target = path.join(R, 'server/grigdesk-server');

  await mkdir(cache, {
    recursive: true
  });
  await symlink(archive, path.join(cache, nodeArchive(runtime).name), 'file');

  const result = await buildSeaBinary({
    packageDir: path.join(ROOT, 'server'),
    entryPoint: path.join(FIXTURES, 'main.mjs'),
    target,
    cacheDir: cache,
    banner: SEA_REQUIRE_BANNER,
    download: async () => {
      throw new Error('сеть запрещена: архив обязан браться из кэша');
    },
    probe: probeFixture(R, out),
  });

  assert.equal(result.binary, target);
  assert.ok((await stat(target)).size > 0);
  assert.equal((await readFile(target)).subarray(1, 4).toString(), 'ELF');
});

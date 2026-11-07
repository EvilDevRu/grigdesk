import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { SEA_REQUIRE_BANNER, buildSeaBinary } from '../../../server/scripts/sea/buildSteps.mts';
import type { NodeRuntime } from '../../../shared/node/nodeRuntime.ts';
import { nodeArchive } from '../../../shared/node/seaBuild.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const FIXTURES = path.join(ROOT, 'tests/server/sea/fixtures/plugins');
const run = promisify(execFile);

/**
 * Временный корень прогона; уборка удаляет только его.
 */
async function scratch(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-sea-plugins-'));

  t.after(() => rm(root, {
    recursive: true,
    force: true
  }));

  return root;
}

/**
 * Закреплённый runtime и проверенный архив из кэша выпусков.
 * Отсутствие архива — отказ, а не skip.
 */
async function pinnedRuntime(): Promise<{ runtime: NodeRuntime; archive: string }> {
  const runtime = JSON.parse(
    await readFile(path.join(ROOT, 'server/build/node-runtime.json'), 'utf8'),
  ) as NodeRuntime;
  const { name } = nodeArchive(runtime);

  for (const cache of ['tracker/.cache', 'relay/.cache']) {
    const archive = path.join(ROOT, cache, name);

    try {
      if ((await stat(archive)).isFile()) {
        return {
          runtime,
          archive
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  throw new Error(`Нет проверенного архива ${name}: сначала положите его в tracker/.cache`);
}

/**
 * Собирает layout R с пробелом в пути: bridge из шаблона сборщика, плагин в D/plugins,
 * внешний Fastify из server/node_modules и вложенный Node из архива.
 */
async function prepareLayout(root: string, runtime: NodeRuntime, archive: string, extension = 'js'):
  Promise<{ R: string; out: string }> {
  const R = path.join(root, 'R with space');
  const out = path.join(root, 'probe out');
  const nodeDirectory = path.join(R, 'runtime/node');

  await mkdir(path.join(R, 'server/runtime'), {
    recursive: true
  });
  await mkdir(path.join(R, 'plugins/demo plugin/lib'), {
    recursive: true
  });
  await mkdir(nodeDirectory, {
    recursive: true
  });
  await mkdir(out, {
    recursive: true
  });

  await copyFile(path.join(ROOT, 'server/package.json'), path.join(R, 'server/package.json'));
  await symlink(path.join(ROOT, 'server/node_modules'), path.join(R, 'server/node_modules'), 'dir');
  await copyFile(path.join(ROOT, 'server/build/esmBridge.cjs'),
    path.join(R, 'server/runtime/esmBridge.cjs'));
  await copyFile(path.join(FIXTURES, 'plugin/package.json'),
    path.join(R, 'plugins/demo plugin/package.json'));
  await copyFile(path.join(FIXTURES, `plugin/server.${extension}`),
    path.join(R, `plugins/demo plugin/server.${extension}`));
  await copyFile(path.join(FIXTURES, `plugin/lib/value.${extension}`),
    path.join(R, `plugins/demo plugin/lib/value.${extension}`));

  const { directory } = nodeArchive(runtime);

  await run('tar', [
    '-xJf', archive, '-C', nodeDirectory, '--strip-components=1',
    `${directory}/bin/node`, `${directory}/LICENSE`,
  ]);

  return {
    R,
    out
  };
}

/**
 * Ждёт файл результата не дольше указанного срока.
 * Отсутствие файла остаётся диагностируемым отказом теста, а не пустым успехом.
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
 * Запускает готовый бинарник из временного пути рядом с целью и проверяет плагин.
 * Системный Node в PATH недоступен, cwd посторонний; завершение — SIGTERM.
 */
function probeFixture(R: string, out: string, extension = 'js') {
  return async (binary: string): Promise<void> => {
    const reportFile = path.join(out, 'report.json');
    const child = spawn(binary, [], {
      cwd: '/',
      env: {
        PATH: '/nonexistent',
        PROBE_OUT: out,
        PROBE_ENTRY: `server.${extension}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let exited = false;

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('exit', () => {
      exited = true;
    });

    if (!await waitForFile(reportFile) || exited) {
      child.kill('SIGKILL');
      await once(child, 'exit').catch(() => {});

      throw new Error(`SEA не загрузил плагин: ${stderr}`);
    }

    child.kill('SIGTERM');

    const [code, signal] = await once(child, 'exit') as [number | null, string | null];

    assert.equal(signal, null, stderr);
    assert.equal(code, 0, stderr);
    assert.equal(await readFile(path.join(out, 'sigterm.txt'), 'utf8'), 'closed\n');

    const report = JSON.parse(await readFile(reportFile, 'utf8')) as {
      R: string;
      http: string;
      isSea: boolean;
      marker: string;
      relative: string;
    };

    assert.equal(report.isSea, true);
    assert.equal(report.R, R);
    assert.equal(report.relative, 'из плагина');
    assert.equal(report.marker, 'plugin-tla');
    assert.deepEqual(JSON.parse(report.http), {
      marker: 'plugin-tla',
      value: 'из плагина',
    });
  };
}

/**
 * Собирает SEA с настоящим внешним bridge и ESM-плагином из отдельного каталога.
 * Это медленная проверка: она поднимает HTTP и проходит полный путь плагина.
 */
async function checkSeaPlugin(t: TestContext, extension: string): Promise<void> {
  const root = await scratch(t);
  const { runtime, archive } = await pinnedRuntime();
  const { R, out } = await prepareLayout(root, runtime, archive, extension);
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
    probe: probeFixture(R, out, extension),
  });

  assert.equal(result.binary, target);
  assert.equal((await readFile(target)).subarray(1, 4).toString(), 'ELF');
}

test('SEA-PLUGIN-01: SEA грузит ESM-плагин через внешний bridge и отдаёт маршрут', async (t) => {
  await checkSeaPlugin(t, 'js');
});

test('SEA-PLUGIN-TS: SEA грузит native TS с относительным импортом и TLA', async (t) => {
  await checkSeaPlugin(t, 'ts');
});

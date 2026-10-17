import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  AnalysisError,
  inspectGlbFile,
  rewriteGlbFile,
} from '../../server/src/lib/studio3d/analysisProcess.ts';
import { makeGlb } from './helpers/studio3dGlb.js';

/**
 * Входы и выходы принадлежат только тесту; subprocess получает синтетическую модель.
 * Уборка не затрагивает живую библиотеку и чужие дочерние процессы.
 */
async function analysisFixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-studio-analysis-'));
  const input = path.join(dir, 'model.glb');

  await fs.writeFile(input, makeGlb({ triangles: 2, size: [1, 2, 1] }));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  return { dir, input };
}

test('FIX-04 анализ и rewrite действительно проходят дочерним процессом с heap 256 МиБ', async (t) => {
  const { dir, input } = await analysisFixture(t);
  const output = path.join(dir, 'rotated.glb');
  const launches = [];
  const deps = {
    spawnImpl: (command, args, options) => {
      launches.push({
        command,
        args,
        options
      });

      return spawn(command, args, options);
    }
  };
  const stats = await inspectGlbFile(input, deps);

  await rewriteGlbFile(input, output, { rotation: [0, 0, 1, 0], name: 'fixture-turn' }, deps);
  assert.deepEqual(stats.size, [1, 2, 1]);
  assert.equal(launches.length, 2);
  assert.equal(launches.every((item) => item.args.includes('--max-old-space-size=256')), true);
  assert.equal(launches.every((item) => item.command === process.execPath), true);
  assert.equal((await fs.stat(output)).size > 0, true);
});

test('FIX-04 предельный бинарный GLB не превышает RSS и анализируется без разбора геометрии', async (t) => {
  const { input } = await analysisFixture(t);
  const source = makeGlb({ triangles: 2, size: [1, 2, 1] });
  const maximum = 150 * 1024 * 1024;
  const jsonLength = source.readUInt32LE(12);
  const binaryHeader = 20 + jsonLength;
  const handle = await fs.open(input, 'w');

  try {
    const header = Buffer.from(source.subarray(0, binaryHeader + 8));

    header.writeUInt32LE(maximum, 8);
    header.writeUInt32LE(maximum - binaryHeader - 8, binaryHeader);
    await handle.write(header);
    await handle.truncate(maximum);
  } finally {
    await handle.close();
  }

  const samples = [];
  const stats = await inspectGlbFile(input, { onRss: (bytes) => samples.push(bytes) });

  assert.deepEqual(stats.size, [1, 2, 1]);
  assert.equal(samples.length > 0, true);
  assert.equal(Math.max(...samples) <= 512 * 1024 * 1024, true);
});

test('FIX-04 большой файл отвергается до запуска и выделения буфера', async (t) => {
  const { input } = await analysisFixture(t);
  const handle = await fs.open(input, 'r+');
  let launched = false;

  await handle.truncate(150 * 1024 * 1024 + 1);
  await handle.close();
  await assert.rejects(inspectGlbFile(input, {
    spawnImpl: () => {
      launched = true;

      throw new Error('worker не должен запускаться');
    }
  }), (error) => error instanceof AnalysisError && error.code === 'too-large');
  assert.equal(launched, false);
});

test('FIX-04 таймаут собственного процесса освобождает очередь для следующего анализа', async (t) => {
  const { input } = await analysisFixture(t);
  let child;

  await assert.rejects(inspectGlbFile(input, {
    timeoutMs: 30,
    spawnImpl: (_command, _args, options) => {
      child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);

      return child;
    }
  }), (error) => error instanceof AnalysisError && error.code === 'timeout');
  assert.equal(child.exitCode !== null || child.signalCode !== null, true);
  assert.deepEqual((await inspectGlbFile(input)).size, [1, 2, 1]);
});

test('JB-20 abort завершает только свой worker и освобождает очередь без публикации', async (t) => {
  const { dir, input } = await analysisFixture(t);
  const controller = new AbortController();
  const output = path.join(dir, 'aborted.glb');
  const timer = setTimeout(() => controller.abort(), 30);

  t.after(() => clearTimeout(timer));
  await assert.rejects(rewriteGlbFile(input, output, { scale: 2 }, {
    signal: controller.signal,
    timeoutMs: 300,
    spawnImpl: (_command, _args, options) => spawn(process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'], options)
  }), (error) => error.code === 'aborted');
  await assert.rejects(fs.stat(output));
  assert.equal((await inspectGlbFile(input)).triangles, 2);
});

test('FIX-04 несколько одновременных запросов анализа запускают только один worker', async (t) => {
  const { input } = await analysisFixture(t);
  let active = 0;
  let maximum = 0;
  const deps = {
    spawnImpl: (command, args, options) => {
      const child = spawn(command, args, options);

      active += 1;
      maximum = Math.max(maximum, active);
      child.once('close', () => {
        active -= 1;
      });

      return child;
    }
  };

  await Promise.all([inspectGlbFile(input, deps), inspectGlbFile(input, deps), inspectGlbFile(input, deps)]);
  assert.equal(maximum, 1);
  assert.equal(active, 0);
});

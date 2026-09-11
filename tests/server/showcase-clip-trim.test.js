// Обрезка клипа до готовности: длина результата и отказ от лишней работы.
//
// Исходник — синтетическая запись ffmpeg в том же контейнере, что у браузера:
// настоящей записи здесь не нужно, проверяется арифметика среза.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { probeDurationMs } from '../../server/src/lib/showcase/render/clipCheck.ts';
import { trimSceneClip } from '../../server/src/lib/showcase/render/clipTrim.ts';

const run = promisify(execFile);

async function ffmpegAvailable() {
  try {
    await run('ffmpeg', ['-version']);

    return true;
  } catch {
    return false;
  }
}

/** Три секунды тестовой картинки в VP8, как пишет браузер. */
async function makeRaw(dir) {
  const file = path.join(dir, 'raw.webm');

  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25:duration=3',
    '-c:v', 'libvpx', '-b:v', '200k',
    file,
  ]);

  return file;
}

test('обрезка отдаёт клип, начинающийся с указанного момента', async (t) => {
  if (!(await ffmpegAvailable())) {
    t.skip('ffmpeg не установлен: обрезку проверить нечем');

    return;
  }

  const dir = await mkdtemp(path.join(os.tmpdir(), 'showcase-trim-'));

  t.after(() => rm(dir, { recursive: true, force: true }));

  const raw = await makeRaw(dir);
  const outFile = path.join(dir, 'ready.webm');
  const trimmed = await trimSceneClip({ rawPath: raw, startMs: 1200, outFile });

  assert.equal(trimmed, outFile);

  const duration = await probeDurationMs(trimmed);

  assert.ok(Math.abs(duration - 1800) <= 80, `ожидали около 1800 мс, получили ${duration}`);
});

test('резать меньше кадра незачем: исходный файл отдаётся как есть', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'showcase-trim-'));
  const raw = path.join(dir, 'raw.webm');
  const outFile = path.join(dir, 'ready.webm');

  try {
    assert.equal(await trimSceneClip({ rawPath: raw, startMs: 0, outFile }), raw);
    assert.equal(await trimSceneClip({ rawPath: raw, startMs: 20, outFile }), raw);
    await assert.rejects(access(outFile), 'файл результата не должен появляться без обрезки');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

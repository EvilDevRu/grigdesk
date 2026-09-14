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
import {
  probeVideoFrames,
  trimSceneClip,
  trimSceneClipExact,
} from '../../server/src/lib/showcase/render/clipTrim.ts';

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

// Цепочка пишется одним видео: клип сцены — от её готовности до её конца, а хвост
// принадлежит следующим сценам. Конец задаётся длиной после перемотки: `-to` после
// `-ss` на входе считался бы от нуля вывода и попадал бы мимо.
test('срез с концом отдаёт ровно отрезок сцены из общей записи', async (t) => {
  if (!(await ffmpegAvailable())) {
    t.skip('ffmpeg не установлен: обрезку проверить нечем');

    return;
  }

  const dir = await mkdtemp(path.join(os.tmpdir(), 'showcase-trim-'));

  t.after(() => rm(dir, { recursive: true, force: true }));

  const raw = await makeRaw(dir);
  const middle = await trimSceneClip({
    rawPath: raw,
    startMs: 1000,
    endMs: 2200,
    outFile: path.join(dir, 'middle.webm'),
  });
  const middleMs = await probeDurationMs(middle);

  assert.ok(Math.abs(middleMs - 1200) <= 80, `ожидали около 1200 мс, получили ${middleMs}`);

  // Голова цепочки с концом режется даже без отступа в начале: конец — тоже срез.
  const head = await trimSceneClip({
    rawPath: raw,
    startMs: 0,
    endMs: 900,
    outFile: path.join(dir, 'head.webm'),
  });

  assert.equal(head, path.join(dir, 'head.webm'));

  const headMs = await probeDurationMs(head);

  assert.ok(Math.abs(headMs - 900) <= 80, `ожидали около 900 мс, получили ${headMs}`);

  await assert.rejects(
    () => trimSceneClip({ rawPath: raw, startMs: 1000, endMs: 1010, outFile: path.join(dir, 'x.webm') }),
    (error) => error.code === 'record_failed',
    'сцена короче кадра — отказ, а не пустой файл',
  );
});

test('точный off-grid срез сообщает первый source PTS и приводит клип к CFR', async (t) => {
  if (!(await ffmpegAvailable())) {
    t.skip('ffmpeg не установлен: обрезку проверить нечем');
    return;
  }

  const dir = await mkdtemp(path.join(os.tmpdir(), 'showcase-trim-exact-'));

  t.after(() => rm(dir, { recursive: true, force: true }));

  const raw = await makeRaw(dir);
  const rawFrames = await probeVideoFrames(raw);
  const result = await trimSceneClipExact({
    rawPath: raw,
    startPtsMs: 1017,
    endPtsMs: 2211,
    fps: 30,
    outFile: path.join(dir, 'exact.webm'),
  });
  const expectedFirst = rawFrames.find((frame) => frame.ptsMs >= 1017);
  const expectedEnd = rawFrames.find((frame) => frame.ptsMs >= 2211);
  const outputFrames = await probeVideoFrames(result.path);

  assert.equal(result.firstRetainedSourcePtsMs, expectedFirst.ptsMs);
  assert.equal(result.sourceEndExclusivePtsMs, expectedEnd.ptsMs);
  assert.equal(result.outputFirstPtsMs, 0);
  assert.equal(result.frameCount, outputFrames.length);
  assert.ok(Math.abs(result.durationMs / (1000 / 30) - result.frameCount) < 1e-9);

  for (const [index, frame] of outputFrames.entries()) {
    assert.ok(
      Math.abs(frame.ptsMs - index * 1000 / 30) <= 0.51,
      `кадр ${index}: ${frame.ptsMs} мс`,
    );
  }
});

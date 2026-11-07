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
  browserMonoToVideoPts,
  calibrateVideoTiming,
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

/**
 * Запись с калибровочными отметками, склеенная из цветных отрезков: голова из
 * четырёх цветов, «страница» между сериями и хвост. Длина guard-цвета каждой серии
 * задаётся в кадрах — так воспроизводится guard, попавший в запись одним кадром или
 * не попавший вовсе; `headCutMs` — сколько второго цвета головы прошло ДО первого
 * кадра записи: так выглядит видео, начавшееся с опозданием.
 */
async function makeMarkedRaw(dir, { headGuardFrames = 5, headCutMs = 0, tailGuardFrames = 5 }) {
  const file = path.join(dir, 'marked.webm');
  const fps = 25;
  const frame = 1 / fps;
  const rgb = [[255, 0, 255], [0, 255, 255], [255, 255, 0], [255, 0, 0]];
  const colors = ['0xFF00FF', '0x00FFFF', '0xFFFF00', '0xFF0000'];
  const holdMs = 200;
  const segments = [
    { color: colors[0], seconds: headGuardFrames * frame },
    { color: colors[1], seconds: (holdMs - headCutMs) / 1_000 },
    { color: colors[2], seconds: holdMs / 1_000 },
    { color: colors[3], seconds: holdMs / 1_000 },
    { color: '0x304050', seconds: 1 },
    { color: colors[0], seconds: tailGuardFrames * frame },
    { color: colors[1], seconds: holdMs / 1_000 },
    { color: colors[2], seconds: holdMs / 1_000 },
    { color: colors[3], seconds: holdMs / 1_000 },
  ].filter((segment) => segment.seconds > 0);
  const inputs = segments.flatMap((segment) => [
    '-f', 'lavfi', '-i', `color=c=${segment.color}:size=64x36:rate=${fps}:duration=${segment.seconds}`,
  ]);
  const chain = segments.map((_segment, index) => `[${index}:v]`).join('');

  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    ...inputs,
    '-filter_complex', `${chain}concat=n=${segments.length}:v=1:a=0[v]`,
    '-map', '[v]', '-c:v', 'libvpx', '-b:v', '200k',
    file,
  ]);

  // Монотонные метки страницы в миллисекундах видео: guard головы начался за
  // headGuardFrames кадров до второго цвета, второй цвет — за headCutMs до записи.
  const base = 10_000;
  const headSecondAt = base - headCutMs;
  const headStart = headSecondAt - headGuardFrames * frame * 1_000;
  const pageEndMs = headSecondAt + 3 * holdMs + 1_000;
  const tailSecondAt = pageEndMs + tailGuardFrames * frame * 1_000;
  const at = (phase, sequence) => {
    if (phase === 'head') {
      return sequence === 0 ? headStart : headSecondAt + (sequence - 1) * holdMs;
    }

    return sequence === 0 ? pageEndMs : tailSecondAt + (sequence - 1) * holdMs;
  };
  const samples = ['head', 'tail'].flatMap((phase) => rgb.map((color, sequence) => ({
    phase, sequence, browserMonoMs: at(phase, sequence), rgb: color,
  })));

  // Старт видео — начало guard головы, а без guard — момент base внутри второго цвета.
  const videoStart = headGuardFrames > 0 ? headStart : base;

  return { file, samples, fps, pageEndVideoMs: pageEndMs - videoStart };
}

test('guard-отметка хвоста в один кадр или без кадров не лишает сцену калибровки', async (t) => {
  if (!(await ffmpegAvailable())) {
    t.skip('ffmpeg не установлен');
    return;
  }

  const dir = await mkdtemp(path.join(os.tmpdir(), 'showcase-marker-guard-'));

  t.after(() => rm(dir, { recursive: true, force: true }));

  for (const tailGuardFrames of [5, 1, 0]) {
    const { file, samples, pageEndVideoMs } = await makeMarkedRaw(dir, { tailGuardFrames });
    const calibration = await calibrateVideoTiming(file, samples);

    assert.equal(calibration.status, 'calibrated', `guard ${tailGuardFrames}: ${calibration.reason ?? ''}`);

    // Граница служебных кадров — первый кадр хвоста, каким бы коротким ни был guard:
    // одиночный кадр guard тоже не должен попасть в клип.
    const frames = await probeVideoFrames(file);
    const tailFirst = frames.find((point) => point.ptsMs >= pageEndVideoMs - 1);

    assert.ok(tailFirst, 'в записи есть хвост');
    assert.ok(
      Math.abs(calibration.tailExcludedFromPtsMs - tailFirst.ptsMs) < 1,
      `guard ${tailGuardFrames}: граница ${calibration.tailExcludedFromPtsMs}, ожидалась ${tailFirst.ptsMs}`,
    );
  }
});

test('запись, начавшаяся без guard головы и посреди второго цвета, калибруется по хвосту', async (t) => {
  if (!(await ffmpegAvailable())) {
    t.skip('ffmpeg не установлен');
    return;
  }

  const dir = await mkdtemp(path.join(os.tmpdir(), 'showcase-marker-late-start-'));

  t.after(() => rm(dir, { recursive: true, force: true }));

  // Guard головы в запись не попал вовсе, а второй цвет начался за 80 мс до первого
  // кадра: прежний поиск вперёд уходил к одноимённому цвету хвоста и оставлял хвост
  // ни с чем, а «переключение» усечённого цвета на старте видео тянуло погрешность.
  const { file, samples } = await makeMarkedRaw(dir, { headGuardFrames: 0, headCutMs: 80 });
  const calibration = await calibrateVideoTiming(file, samples);

  assert.equal(calibration.status, 'calibrated', calibration.reason ?? '');
  assert.ok(calibration.errorMs <= 100, `погрешность ${calibration.errorMs}`);

  // Шкала верна: третий цвет головы (жёлтый) объявлен через 120 мс после старта
  // видео и ровно там же найден в кадрах.
  const frames = await probeVideoFrames(file);
  const yellowAt = browserMonoToVideoPts(calibration, samples[2].browserMonoMs);
  const yellowFrame = frames.find((point) => point.ptsMs >= 120 - 1);

  assert.ok(yellowFrame, 'в записи есть жёлтый');
  assert.ok(Math.abs(yellowAt - yellowFrame.ptsMs) <= 60, `жёлтый: ${yellowAt} против ${yellowFrame.ptsMs}`);
});

test('пропавшая не-guard отметка по-прежнему оставляет сцену без калибровки', async (t) => {
  if (!(await ffmpegAvailable())) {
    t.skip('ffmpeg не установлен');
    return;
  }

  const dir = await mkdtemp(path.join(os.tmpdir(), 'showcase-marker-missing-'));

  t.after(() => rm(dir, { recursive: true, force: true }));

  const { file, samples } = await makeMarkedRaw(dir, {});
  // Жёлтая отметка хвоста объявлена, но её цвет в записи подменён: такой хвост
  // не сопоставить, и честный отказ важнее выдуманной шкалы.
  const broken = samples.map((sample) => (
    sample.phase === 'tail' && sample.sequence === 2
      ? { ...sample, rgb: [0, 128, 0] }
      : sample
  ));
  const calibration = await calibrateVideoTiming(file, broken);

  assert.equal(calibration.status, 'unavailable');
  assert.match(calibration.reason, /tail:2/);
});

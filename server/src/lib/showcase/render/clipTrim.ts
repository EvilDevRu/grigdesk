// Обрезка записи до границ сцены.
//
// Видео контекста начинается вместе со страницей, и первые секунды в нём — белый
// лист и сборка каркаса. В ролике это выглядело как перезагрузка страницы на
// каждой сцене. Ключевой кадр у записи браузера один, в самом начале, поэтому
// вырезать начало копированием потока нельзя — клип перекодируется. VP9 в режиме
// реального времени укладывается в доли секунды на сцену, а замер PSNR против
// исходника (63 дБ) показывает, что картинка не страдает: сама запись браузера
// сделана с куда большими потерями.
//
// Цепочка сцен пишется одним видео, и тогда у среза есть и конец: клип сцены —
// от её готовности до её конца, а хвост записи принадлежит следующим сценам.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

import { ShowcaseError } from '../errors.ts';
import type { CalibrationMarkerSample } from './recorder.ts';

const run = promisify(execFile);

// Короче одного кадра резать нечего: такая запись отдаётся как есть.
const MIN_TRIM_MS = 40;
const MARKER_COLOR_DISTANCE = 70;
const CALIBRATION_METHOD = 'visual-marker-affine-v1' as const;
const CALIBRATION_LIMIT_MS = 100;

// Видео контекста начинается позже отсчёта готовности: между созданием страницы и
// первым кадром трансляции проходят сотни миллисекунд, и точный срез по часам
// исполнителя попадал уже на первое действие сцены — клип открывался раскрытым
// списком. Запас отступает назад в затишье перед готовностью, где кадр уже не
// меняется; вместе с паузой перед первым действием он перекрывает разброс старта.
export const READY_MARGIN_MS = 400;

export interface TrimInput {
  rawPath: string;
  startMs: number;
  // Конец клипа от начала записи. Без него клип идёт до конца файла: так режется
  // одиночная сцена и последняя сцена цепочки.
  endMs?: number;
  outFile: string;
  signal?: AbortSignal;
}

export interface VideoFramePoint {
  index: number;
  ptsMs: number;
  durationMs: number;
}

export interface CalibratedVideoTiming {
  status: 'calibrated';
  method: typeof CALIBRATION_METHOD;
  browserOriginMonoMs: number;
  videoOriginPtsMs: number;
  rate: number;
  errorMs: number;
  startErrorMs: number;
  endErrorMs: number;
  headExcludedBeforePtsMs: number;
  tailExcludedFromPtsMs: number;
}

export interface UnavailableVideoTiming {
  status: 'unavailable';
  method: typeof CALIBRATION_METHOD;
  reason: string;
}

export type VideoCalibration = CalibratedVideoTiming | UnavailableVideoTiming;

export interface ExactTrimInput {
  rawPath: string;
  startPtsMs: number;
  endPtsMs: number;
  fps: number;
  outFile: string;
  signal?: AbortSignal;
}

export interface ExactTrimResult {
  path: string;
  requestedStartPtsMs: number;
  requestedEndPtsMs: number;
  firstRetainedSourcePtsMs: number;
  sourceEndExclusivePtsMs: number;
  outputFirstPtsMs: number;
  frameCount: number;
  durationMs: number;
  fps: number;
}

export interface VideoFrameHash {
  index: number;
  ptsMs: number;
  hash: string;
}

function finite(value: number): boolean {
  return Number.isFinite(value);
}

/** PTS всех декодированных кадров, без догадки по format.duration. */
export async function probeVideoFrames(file: string): Promise<VideoFramePoint[]> {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'frame=best_effort_timestamp_time,pts_time,pkt_duration_time',
    '-of', 'json',
    file,
  ], { maxBuffer: 64 * 1024 * 1024 });
  const parsed = JSON.parse(stdout) as {
    frames?: Array<{
      best_effort_timestamp_time?: string;
      pts_time?: string;
      pkt_duration_time?: string;
    }>;
  };
  const source = parsed.frames ?? [];
  const result: VideoFramePoint[] = [];

  for (const [index, frame] of source.entries()) {
    const seconds = Number(frame.best_effort_timestamp_time ?? frame.pts_time);

    if (!finite(seconds)) {
      continue;
    }

    const nextSeconds = Number(source[index + 1]?.best_effort_timestamp_time
      ?? source[index + 1]?.pts_time);
    const declared = Number(frame.pkt_duration_time);
    const durationSeconds = finite(nextSeconds) && nextSeconds > seconds
      ? nextSeconds - seconds
      : finite(declared) && declared > 0
        ? declared
        : result.at(-1)?.durationMs
          ? (result.at(-1) as VideoFramePoint).durationMs / 1000
          : 0;

    result.push({ index: result.length, ptsMs: seconds * 1000, durationMs: durationSeconds * 1000 });
  }

  return result;
}

async function averageFrameColors(file: string): Promise<readonly [number, number, number][]> {
  const output = await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-i', file,
    '-map', '0:v:0',
    '-vf', 'scale=1:1:flags=area',
    '-vsync', '0',
    '-pix_fmt', 'rgb24',
    '-f', 'rawvideo',
    'pipe:1',
  ], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  const bytes = Buffer.isBuffer(output.stdout)
    ? output.stdout
    : Buffer.from(output.stdout as unknown as string, 'binary');
  const colors: [number, number, number][] = [];

  for (let offset = 0; offset + 2 < bytes.length; offset += 3) {
    colors.push([bytes[offset] as number, bytes[offset + 1] as number, bytes[offset + 2] as number]);
  }

  return colors;
}

function colorDistance(
  actual: readonly [number, number, number],
  expected: readonly [number, number, number],
): number {
  return Math.hypot(
    actual[0] - expected[0],
    actual[1] - expected[1],
    actual[2] - expected[2],
  );
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);

  return ordered.length % 2 === 0
    ? ((ordered[middle - 1] as number) + (ordered[middle] as number)) / 2
    : ordered[middle] as number;
}

/**
 * Находит видимые marker transitions и строит affine mapping browser-monotonic →
 * raw video PTS. Две группы нужны не для красоты: только хвост показывает drift
 * шкалы на длине реальной цепочки.
 */
export async function calibrateVideoTiming(
  file: string,
  samples: readonly CalibrationMarkerSample[],
): Promise<VideoCalibration> {
  const unavailable = (reason: string): UnavailableVideoTiming => ({
    status: 'unavailable', method: CALIBRATION_METHOD, reason,
  });
  const head = samples.filter((sample) => sample.phase === 'head');
  const tail = samples.filter((sample) => sample.phase === 'tail');

  if (head.length < 3 || tail.length < 3) {
    return unavailable('Браузер не зарегистрировал обе серии калибровочной отметки.');
  }

  const frames = await probeVideoFrames(file).catch(() => []);
  const colors = await averageFrameColors(file).catch(() => []);

  if (frames.length === 0 || colors.length !== frames.length) {
    return unavailable('Не удалось сопоставить кадры и PTS исходной записи.');
  }

  const orderedSamples = [...head, ...tail];
  const observations: Array<{
    sample: CalibrationMarkerSample;
    ptsMs: number;
    firstFrame: number;
    lastFrame: number;
  }> = [];
  let cursor = 0;

  for (const sample of orderedSamples) {
    let found = -1;

    for (let index = cursor; index + 1 < colors.length; index += 1) {
      if (
        colorDistance(colors[index] as [number, number, number], sample.rgb) <= MARKER_COLOR_DISTANCE
        && colorDistance(colors[index + 1] as [number, number, number], sample.rgb)
          <= MARKER_COLOR_DISTANCE
      ) {
        found = index;
        break;
      }
    }

    if (found < 0) {
      return unavailable(`В видео не найдена отметка ${sample.phase}:${sample.sequence}.`);
    }

    let lastFrame = found + 1;

    while (
      lastFrame + 1 < colors.length
      && colorDistance(colors[lastFrame + 1] as [number, number, number], sample.rgb)
        <= MARKER_COLOR_DISTANCE
    ) {
      lastFrame += 1;
    }

    const firstPtsMs = (frames[found] as VideoFramePoint).ptsMs;
    const previousPtsMs = found > 0
      ? (frames[found - 1] as VideoFramePoint).ptsMs
      : firstPtsMs;

    observations.push({
      sample,
      // Переключение лежит между последним старым и первым новым кадром. Середина
      // этого интервала не вносит систематический сдвиг на целый frame duration.
      ptsMs: (previousPtsMs + firstPtsMs) / 2,
      firstFrame: found,
      lastFrame,
    });
    cursor = lastFrame + 1;
  }

  // Первый цвет каждой серии будит/перекрывает compositor и не имеет наблюдаемого
  // предыдущего marker state. Он нужен как guard frame, но не как точка регрессии.
  const fittedObservations = observations.filter((entry) => entry.sample.sequence > 0);
  const origin = fittedObservations[0]?.sample.browserMonoMs;

  if (!finite(origin as number)) {
    return unavailable('Калибровочная отметка содержит неверное монотонное время.');
  }

  const relative = (sample: CalibrationMarkerSample) => sample.browserMonoMs - (origin as number);
  const headObservations = fittedObservations.filter((entry) => entry.sample.phase === 'head');
  const tailObservations = fittedObservations.filter((entry) => entry.sample.phase === 'tail');
  const headCenter = median(headObservations.map((entry) => relative(entry.sample)));
  const tailCenter = median(tailObservations.map((entry) => relative(entry.sample)));
  const headOffset = median(headObservations.map((entry) => entry.ptsMs - relative(entry.sample)));
  const tailOffset = median(tailObservations.map((entry) => entry.ptsMs - relative(entry.sample)));
  const span = tailCenter - headCenter;

  if (!(span > 0)) {
    return unavailable('Концевая отметка не следует за начальной в монотонной шкале.');
  }

  const rate = 1 + (tailOffset - headOffset) / span;

  if (!finite(rate) || rate < 0.98 || rate > 1.02) {
    return unavailable(`Скорость видеошкалы отличается от часов страницы: ${rate}.`);
  }

  const videoOriginPtsMs = median(fittedObservations.map((entry) => (
    entry.ptsMs - rate * relative(entry.sample)
  )));
  const residual = (entry: typeof observations[number]) => Math.abs(
    entry.ptsMs - (videoOriginPtsMs + rate * relative(entry.sample)),
  );
  const uncertaintyOf = (entry: typeof observations[number]) => Math.max(
    (frames[entry.firstFrame] as VideoFramePoint).durationMs / 2,
    entry.firstFrame > 0
      ? ((frames[entry.firstFrame] as VideoFramePoint).ptsMs
        - (frames[entry.firstFrame - 1] as VideoFramePoint).ptsMs) / 2
      : 0,
  );
  const groupError = (group: typeof observations) => Math.max(...group.map((entry) => (
    residual(entry) + uncertaintyOf(entry)
  )));
  const startErrorMs = groupError(headObservations);
  const endErrorMs = groupError(tailObservations);
  const errorMs = Math.max(startErrorMs, endErrorMs);

  if (!finite(errorMs) || errorMs > CALIBRATION_LIMIT_MS) {
    return unavailable(
      `Погрешность калибровки ${Math.round(errorMs)} мс превышает 100 мс `
      + `(начало ${Math.round(startErrorMs)}, конец ${Math.round(endErrorMs)}, rate ${rate.toFixed(6)}, `
      + `residual ${fittedObservations.map((entry) => Math.round(residual(entry))).join('/')}).`,
    );
  }

  const lastHead = observations.filter((entry) => entry.sample.phase === 'head').at(-1);
  const firstTail = observations.find((entry) => entry.sample.phase === 'tail');

  if (!lastHead || !firstTail) {
    return unavailable('В обнаруженных кадрах нет обеих фаз калибровки.');
  }
  const afterHead = frames[lastHead.lastFrame + 1];

  if (!afterHead) {
    return unavailable('После начальной отметки не осталось пользовательских кадров.');
  }

  return {
    status: 'calibrated',
    method: CALIBRATION_METHOD,
    browserOriginMonoMs: origin as number,
    videoOriginPtsMs,
    rate,
    errorMs,
    startErrorMs,
    endErrorMs,
    headExcludedBeforePtsMs: afterHead.ptsMs,
    tailExcludedFromPtsMs: (frames[firstTail.firstFrame] as VideoFramePoint).ptsMs,
  };
}

export function browserMonoToVideoPts(
  calibration: CalibratedVideoTiming,
  browserMonoMs: number,
): number {
  return calibration.videoOriginPtsMs
    + calibration.rate * (browserMonoMs - calibration.browserOriginMonoMs);
}

/** Полноэкранная marker-палитра не должна встретиться в готовом клипе. */
export async function videoContainsCalibrationMarker(
  file: string,
  samples: readonly CalibrationMarkerSample[],
): Promise<boolean> {
  const colors = await averageFrameColors(file);
  const expected = samples.map((sample) => sample.rgb);

  return colors.some((color, index) => (
    index + 1 < colors.length
    && expected.some((marker) => (
      colorDistance(color, marker) <= MARKER_COLOR_DISTANCE
      && colorDistance(colors[index + 1] as [number, number, number], marker)
        <= MARKER_COLOR_DISTANCE
    ))
  ));
}

/** Exact decoded-frame hashes for conservative stable-frame intervals. */
export async function probeVideoFrameHashes(file: string): Promise<VideoFrameHash[]> {
  const frames = await probeVideoFrames(file);
  const width = 64;
  const height = 36;
  const frameBytes = width * height;
  const output = await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-i', file,
    '-map', '0:v:0',
    '-vf', `scale=${width}:${height}:flags=area,format=gray`,
    '-vsync', '0', '-f', 'rawvideo', 'pipe:1',
  ], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  const bytes = Buffer.isBuffer(output.stdout)
    ? output.stdout
    : Buffer.from(output.stdout as unknown as string, 'binary');
  const count = Math.min(frames.length, Math.floor(bytes.length / frameBytes));
  const result: VideoFrameHash[] = [];

  for (let index = 0; index < count; index += 1) {
    const source = bytes.subarray(index * frameBytes, (index + 1) * frameBytes);
    const quantized = Buffer.allocUnsafe(frameBytes);

    // Lossy VP9 может на соседних статичных кадрах менять младшие биты. Низкое
    // разрешение и 16 уровней убирают codec noise, но сохраняют прокрутку/диалог.
    for (let offset = 0; offset < source.length; offset += 1) {
      quantized[offset] = Math.round((source[offset] as number) / 16);
    }

    result.push({
      index,
      ptsMs: (frames[index] as VideoFramePoint).ptsMs,
      hash: createHash('sha256').update(quantized).digest('hex').slice(0, 16),
    });
  }

  return result;
}

/**
 * Возвращает путь к клипу от `startMs` до `endMs`. Если резать нечего, это
 * исходный файл — лишнее перекодирование не делается.
 *
 * Длина задаётся как `-t` после `-ss`, а не как `-to`: после перемотки на входе
 * ffmpeg считает время вывода от нуля, и абсолютный конец попал бы мимо.
 */
export async function trimSceneClip(input: TrimInput): Promise<string> {
  const startMs = Math.max(0, input.startMs);
  const lengthMs = input.endMs === undefined ? null : input.endMs - startMs;

  if (!(startMs >= MIN_TRIM_MS) && lengthMs === null) {
    return input.rawPath;
  }

  if (lengthMs !== null && !(lengthMs >= MIN_TRIM_MS)) {
    throw new ShowcaseError(
      'record_failed',
      `Сцена в записи короче одного кадра: ${Math.round(lengthMs)} мс.`,
      500,
    );
  }

  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-ss', (startMs / 1000).toFixed(3),
    '-i', input.rawPath,
    ...(lengthMs === null ? [] : ['-t', (lengthMs / 1000).toFixed(3)]),
    '-an',
    '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '6', '-row-mt', '1',
    '-crf', '10', '-b:v', '0',
    input.outFile,
  ], { signal: input.signal });

  return input.outFile;
}

/**
 * Точная нарезка measured-пути. Окно сначала разрешается в номера настоящих raw
 * кадров, затем результат нормализуется в общий CFR проекта. Возвращаемая точка
 * первого source frame — единственная допустимая база для переноса событий в клип.
 */
export async function trimSceneClipExact(input: ExactTrimInput): Promise<ExactTrimResult> {
  if (
    !finite(input.startPtsMs)
    || !finite(input.endPtsMs)
    || !(input.endPtsMs > input.startPtsMs)
    || !Number.isSafeInteger(input.fps)
    || input.fps <= 0
  ) {
    throw new ShowcaseError('record_failed', 'Точные границы клипа некорректны.', 500);
  }

  const frames = await probeVideoFrames(input.rawPath);

  if (frames.length === 0) {
    throw new ShowcaseError('record_failed', 'В исходной записи нет кадров для нарезки.', 500);
  }

  const epsilon = 0.001;
  const startFrame = frames.findIndex((frame) => frame.ptsMs + epsilon >= input.startPtsMs);
  const resolvedStart = startFrame < 0 ? frames.length : startFrame;
  const endFrame = frames.findIndex((frame) => frame.ptsMs + epsilon >= input.endPtsMs);
  const resolvedEnd = endFrame < 0 ? frames.length : endFrame;

  if (resolvedStart >= frames.length || resolvedEnd <= resolvedStart) {
    throw new ShowcaseError(
      'record_failed',
      'Измеренные границы сцены не содержат ни одного кадра записи.',
      500,
    );
  }

  const firstRetained = frames[resolvedStart] as VideoFramePoint;
  const sourceEndExclusivePtsMs = resolvedEnd < frames.length
    ? (frames[resolvedEnd] as VideoFramePoint).ptsMs
    : (frames.at(-1) as VideoFramePoint).ptsMs + (frames.at(-1) as VideoFramePoint).durationMs;
  const filter = [
    `trim=start_frame=${resolvedStart}:end_frame=${resolvedEnd}`,
    'setpts=PTS-STARTPTS',
    `fps=fps=${input.fps}:start_time=0:round=near`,
  ].join(',');

  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', input.rawPath,
    '-an',
    '-vf', filter,
    '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '6', '-row-mt', '1',
    '-crf', '10', '-b:v', '0',
    input.outFile,
  ], { signal: input.signal });

  const outputFrames = await probeVideoFrames(input.outFile);

  if (outputFrames.length === 0) {
    throw new ShowcaseError('record_failed', 'После точной нарезки не осталось кадров.', 500);
  }

  const frameMs = 1000 / input.fps;

  for (const [index, frame] of outputFrames.entries()) {
    // WebM timebase — целая миллисекунда, поэтому 30 fps чередует PTS 33/34 мс.
    // Лог хранит точную CFR-сетку по frame index; контейнер допускает полмиллисекунды.
    if (Math.abs(frame.ptsMs - index * frameMs) > 0.51) {
      throw new ShowcaseError(
        'record_failed',
        `Нарезанный клип нарушил CFR на кадре ${index}.`,
        500,
      );
    }
  }

  return {
    path: input.outFile,
    requestedStartPtsMs: input.startPtsMs,
    requestedEndPtsMs: input.endPtsMs,
    firstRetainedSourcePtsMs: firstRetained.ptsMs,
    sourceEndExclusivePtsMs,
    outputFirstPtsMs: (outputFrames[0] as VideoFramePoint).ptsMs,
    frameCount: outputFrames.length,
    durationMs: outputFrames.length * frameMs,
    fps: input.fps,
  };
}

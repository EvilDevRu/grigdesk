// Сборка ролика: приведение сценовых клипов к одному формату и склейка.
//
// ffmpeg вызывается через `execFile` массивом аргументов, без оболочки: имена
// файлов и текст титров в командную строку не интерполируются. Команд от модели
// здесь нет и быть не может — она предлагает текст, а не вызовы.
//
// Склейка идёт копированием потоков: сценовые клипы уже приведены к общему формату,
// а перекодирование ради конкатенации ухудшило бы картинку второй раз и сдвинуло бы
// уже посчитанные таймкоды субтитров.
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import type { ShowcaseTiming } from '../../../../../shared/plugins/showcase/showcaseContracts.ts';
import { ShowcaseError } from '../errors.ts';
import type { RenderStyle } from '../artifacts.ts';
import type { ExactSyncPlan } from './syncPlan.ts';

const run = promisify(execFile);

export interface SceneClipInput {
  rawVideo: string;
  audio: string;
  timing: ShowcaseTiming;
  outFile: string;
  style: RenderStyle;
  signal?: AbortSignal;
}

export interface ProbeResult {
  video: {
    codec: string;
    width: number;
    height: number;
    frameRate: string;
  } | null;
  audio: {
    codec: string;
    sampleRate: number;
    channels: number;
  } | null;
  durationMs: number;
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(3);
}

// Точный путь не округляет внутренний план до целых миллисекунд. Шесть знаков
// после запятой дают ffmpeg микросекундную границу, а фактический результат всё
// равно проверяется по PTS кадров и декодированным отсчётам.
function exactSeconds(ms: number): string {
  return (ms / 1000).toFixed(6);
}

function frameNumber(ms: number, fps: number, label: string): number {
  ensureFinite(ms, label);
  const frame = Math.round(ms * fps / 1000);
  const frameMs = frame * 1000 / fps;

  if (!Number.isSafeInteger(frame) || Math.abs(frameMs - ms) > 0.01) {
    throw new ShowcaseError(
      'assemble_failed',
      `Граница «${label}» не лежит на CFR-сетке точного плана.`,
      500,
    );
  }

  return frame;
}

function rationalValue(value: string | undefined): number {
  if (!value) {
    return Number.NaN;
  }

  const [numeratorText, denominatorText] = value.split('/');
  const numerator = Number(numeratorText);
  const denominator = Number(denominatorText ?? 1);

  return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0
    ? numerator / denominator
    : Number.NaN;
}

export interface SyncAudioSourceProbe {
  sampleRate: number;
  sampleCount: number;
  durationMs: number;
}

interface SyncVideoSourceProbe {
  fps: number;
  frameCount: number;
  durationMs: number;
}

export async function probeSyncAudioSource(file: string): Promise<SyncAudioSourceProbe> {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=sample_rate,duration_ts,time_base:format=duration',
    '-of', 'json',
    file,
  ]);
  const parsed = JSON.parse(stdout) as {
    streams?: { sample_rate?: string; duration_ts?: string | number; time_base?: string }[];
    format?: { duration?: string };
  };
  const stream = parsed.streams?.[0];
  const sampleRate = Number(stream?.sample_rate ?? 0);
  const durationTicks = Number(stream?.duration_ts);
  const timeBase = rationalValue(stream?.time_base);
  const formatDuration = Number(parsed.format?.duration);
  const durationSeconds = Number.isFinite(durationTicks) && Number.isFinite(timeBase)
    ? durationTicks * timeBase
    : formatDuration;
  const sampleCount = Math.round(durationSeconds * sampleRate);

  if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0
    || !Number.isSafeInteger(sampleCount) || sampleCount <= 0
    || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new ShowcaseError(
      'assemble_failed',
      'Не удалось измерить PCM-профиль исходной реплики.',
      500,
    );
  }

  return { sampleRate, sampleCount, durationMs: durationSeconds * 1000 };
}

async function probeSyncVideoSource(file: string): Promise<SyncVideoSourceProbe> {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-count_frames',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=avg_frame_rate,duration,nb_frames,nb_read_frames:format=duration',
    '-of', 'json',
    file,
  ]);
  const parsed = JSON.parse(stdout) as {
    streams?: {
      avg_frame_rate?: string;
      duration?: string;
      nb_frames?: string;
      nb_read_frames?: string;
    }[];
    format?: { duration?: string };
  };
  const stream = parsed.streams?.[0];
  const fps = rationalValue(stream?.avg_frame_rate);
  const frameCount = Number(stream?.nb_read_frames ?? stream?.nb_frames);
  const streamDuration = Number(stream?.duration);
  const formatDuration = Number(parsed.format?.duration);
  const durationSeconds = Number.isFinite(streamDuration) && streamDuration > 0
    ? streamDuration
    : formatDuration;

  if (!Number.isFinite(fps) || fps <= 0
    || !Number.isSafeInteger(frameCount) || frameCount <= 0
    || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new ShowcaseError(
      'assemble_failed',
      'Не удалось измерить шкалу исходного видео.',
      500,
    );
  }

  return { fps, frameCount, durationMs: durationSeconds * 1000 };
}

function ensureFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new ShowcaseError(
      'assemble_failed',
      `Точный план содержит неверное значение «${label}».`,
      500,
    );
  }
}

/**
 * Приводит клип сцены к единому формату и точной длине расписания. Недостающая
 * картинка достраивается стоп-кадром последнего кадра, недостающий звук — тишиной;
 * речь под длину клипа не режется.
 */
export async function buildSceneClip(input: SceneClipInput): Promise<string> {
  const total = seconds(input.timing.totalMs);
  const videoFilter = [
    `fps=${input.style.fps}`,
    `scale=${input.style.width}:${input.style.height}:force_original_aspect_ratio=decrease`,
    `pad=${input.style.width}:${input.style.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    'setsar=1',
    `tpad=stop_mode=clone:stop_duration=${total}`,
    'format=yuv420p',
  ].join(',');
  const audioFilter = [
    'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo',
    `adelay=${input.timing.narrationStartMs}|${input.timing.narrationStartMs}`,
    'loudnorm=I=-16:TP=-1.5:LRA=11',
    'apad',
  ].join(',');

  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', input.rawVideo,
    '-i', input.audio,
    '-filter_complex', `[0:v]${videoFilter}[v];[1:a]${audioFilter}[a]`,
    '-map', '[v]', '-map', '[a]',
    '-t', total,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
    '-video_track_timescale', '30000',
    input.outFile,
  ], { signal: input.signal });

  return input.outFile;
}

export interface SyncedSceneClipInput {
  rawVideo: string;
  audio: string;
  plan: ExactSyncPlan;
  outFile: string;
  style: RenderStyle;
  signal?: AbortSignal;
}

/**
 * Исполняет уже проверенный точный план. Этот вход намеренно существует рядом с
 * legacy `buildSceneClip`: пользовательская сборка переключится на него лишь после
 * появления настоящих меток речи и записи. Здесь нет общего `-t`, способного
 * отрезать хвост реплики; обе дорожки строятся целиком из частей плана.
 */
export async function buildSyncedSceneClip(input: SyncedSceneClipInput): Promise<string> {
  if (input.plan.videoParts.length === 0 || input.plan.audioParts.length === 0) {
    throw new ShowcaseError('assemble_failed', 'Точный план не содержит дорожек.', 500);
  }

  ensureFinite(input.style.fps, 'style.fps');

  if (input.style.fps <= 0) {
    throw new ShowcaseError('assemble_failed', 'Частота кадров точного плана должна быть положительной.', 500);
  }

  if (!Number.isSafeInteger(input.plan.sourceAudio.sampleRate)
    || input.plan.sourceAudio.sampleRate <= 0
    || !Number.isSafeInteger(input.plan.sourceAudio.sampleCount)
    || input.plan.sourceAudio.sampleCount <= 0) {
    throw new ShowcaseError('assemble_failed', 'Точный план не содержит PCM-профиль реплики.', 500);
  }

  ensureFinite(input.plan.sourceAudio.durationMs, 'sourceAudio.durationMs');
  ensureFinite(input.plan.sourceVideo.durationMs, 'sourceVideo.durationMs');
  ensureFinite(input.plan.sourceVideo.fps, 'sourceVideo.fps');

  const plannedAudioDurationMs = input.plan.sourceAudio.sampleCount * 1000
    / input.plan.sourceAudio.sampleRate;

  if (input.plan.sourceAudio.durationMs <= 0
    || Math.abs(input.plan.sourceAudio.durationMs - plannedAudioDurationMs)
      > 1000 / input.plan.sourceAudio.sampleRate + 0.001
    || input.plan.sourceVideo.durationMs <= 0
    || input.plan.sourceVideo.fps <= 0
    || Math.abs(input.plan.sourceVideo.fps - input.style.fps) > 0.001) {
    throw new ShowcaseError(
      'assemble_failed',
      'Исходные шкалы точного плана не согласованы со стилем.',
      500,
    );
  }

  const [actualAudio, actualVideo] = await Promise.all([
    probeSyncAudioSource(input.audio),
    probeSyncVideoSource(input.rawVideo),
  ]);
  const frameMs = 1000 / input.plan.sourceVideo.fps;
  const plannedSourceFrameCount = frameNumber(
    input.plan.sourceVideo.durationMs,
    input.plan.sourceVideo.fps,
    'sourceVideo.durationMs',
  );

  if (actualAudio.sampleRate !== input.plan.sourceAudio.sampleRate
    || actualAudio.sampleCount !== input.plan.sourceAudio.sampleCount
    || Math.abs(actualAudio.durationMs - input.plan.sourceAudio.durationMs)
      > 1000 / input.plan.sourceAudio.sampleRate + 0.001) {
    throw new ShowcaseError(
      'assemble_failed',
      'Исходный WAV не совпадает с PCM-профилем точного плана.',
      500,
    );
  }

  if (actualVideo.frameCount !== plannedSourceFrameCount
    || Math.abs(actualVideo.fps - input.plan.sourceVideo.fps) > 0.001
    || Math.abs(actualVideo.durationMs - input.plan.sourceVideo.durationMs) > frameMs + 1) {
    throw new ShowcaseError(
      'assemble_failed',
      'Исходное видео не совпадает с временной шкалой точного плана.',
      500,
    );
  }

  const declaredVideoGaps = [...input.plan.removedWaits]
    .map((wait, index) => {
      ensureFinite(wait.sourceFromMs, `removedWaits[${index}].sourceFromMs`);
      ensureFinite(wait.sourceToMs, `removedWaits[${index}].sourceToMs`);
      ensureFinite(wait.removedMs, `removedWaits[${index}].removedMs`);

      if (wait.id.trim() === '' || wait.cueId.trim() === ''
        || wait.sourceToMs <= wait.sourceFromMs
        || Math.abs(wait.removedMs - (wait.sourceToMs - wait.sourceFromMs)) > 0.01) {
        throw new ShowcaseError(
          'assemble_failed',
          'Точный план содержит неверную запись удалённого ожидания.',
          500,
        );
      }

      frameNumber(wait.sourceFromMs, input.style.fps, `removedWaits[${index}].sourceFromMs`);
      frameNumber(wait.sourceToMs, input.style.fps, `removedWaits[${index}].sourceToMs`);

      return wait;
    })
    .sort((left, right) => left.sourceFromMs - right.sourceFromMs);
  const expectedVideoGaps: { sourceFromMs: number; sourceToMs: number }[] = [];

  for (const gap of declaredVideoGaps) {
    const previous = expectedVideoGaps.at(-1);

    if (previous && gap.sourceFromMs < previous.sourceToMs - 0.01) {
      throw new ShowcaseError(
        'assemble_failed',
        'Удаляемые ожидания точного плана пересекаются.',
        500,
      );
    }

    if (previous && Math.abs(gap.sourceFromMs - previous.sourceToMs) <= 0.01) {
      // В videoParts две соседние вырезки выглядят одним непрерывным gap. Для
      // исполнения объединяем только геометрию; исходные cue/id остаются в plan.
      previous.sourceToMs = gap.sourceToMs;
    } else {
      expectedVideoGaps.push({
        sourceFromMs: gap.sourceFromMs,
        sourceToMs: gap.sourceToMs,
      });
    }
  }
  let expectedGapIndex = 0;

  const consumeVideoGap = (fromMs: number, toMs: number): void => {
    if (toMs <= fromMs + 0.01) {
      return;
    }

    const expected = expectedVideoGaps[expectedGapIndex];

    if (!expected
      || Math.abs(expected.sourceFromMs - fromMs) > 0.01
      || Math.abs(expected.sourceToMs - toMs) > 0.01) {
      throw new ShowcaseError(
        'assemble_failed',
        'Видеокарта точного плана пропускает неотмеченную часть исходной записи.',
        500,
      );
    }

    expectedGapIndex += 1;
  };

  const graph: string[] = [];
  const normalizedVideo = [
    `fps=${input.style.fps}`,
    `scale=${input.style.width}:${input.style.height}:force_original_aspect_ratio=decrease`,
    `pad=${input.style.width}:${input.style.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    'setsar=1',
    'format=yuv420p',
  ].join(',');

  ensureFinite(input.plan.timing.totalMs, 'timing.totalMs');
  let videoOutputCursorMs = 0;
  let videoSourceCursorMs = 0;
  const videoHolds: { sourceFrame: number; frameCount: number }[] = [];

  for (const [index, part] of input.plan.videoParts.entries()) {
    ensureFinite(part.outputFromMs, `videoParts[${index}].outputFromMs`);
    ensureFinite(part.outputToMs, `videoParts[${index}].outputToMs`);

    const outputDurationMs = part.outputToMs - part.outputFromMs;

    if (!(outputDurationMs > 0)
      || Math.abs(part.outputFromMs - videoOutputCursorMs) > 0.01) {
      throw new ShowcaseError('assemble_failed', 'В точном плане есть пустая часть видео.', 500);
    }

    videoOutputCursorMs = part.outputToMs;

    if (part.kind === 'source') {
      ensureFinite(part.sourceFromMs, `videoParts[${index}].sourceFromMs`);
      ensureFinite(part.sourceToMs, `videoParts[${index}].sourceToMs`);

      if (part.sourceFromMs + 0.01 < videoSourceCursorMs
        || part.sourceToMs > input.plan.sourceVideo.durationMs + 0.01
        || Math.abs((part.sourceToMs - part.sourceFromMs) - outputDurationMs) > 0.01) {
        throw new ShowcaseError(
          'assemble_failed',
          'Точный план пытается изменить скорость или порядок исходного видео.',
          500,
        );
      }


      consumeVideoGap(videoSourceCursorMs, part.sourceFromMs);

      videoSourceCursorMs = part.sourceToMs;
      frameNumber(
        part.sourceFromMs,
        input.style.fps,
        `videoParts[${index}].sourceFromMs`,
      );
      frameNumber(
        part.sourceToMs,
        input.style.fps,
        `videoParts[${index}].sourceToMs`,
      );
      continue;
    }

    ensureFinite(part.sourceAtMs, `videoParts[${index}].sourceAtMs`);

    if (part.sourceAtMs + 0.01 < videoSourceCursorMs
      || part.sourceAtMs > input.plan.sourceVideo.durationMs + 0.01) {
      throw new ShowcaseError(
        'assemble_failed',
        'Точный план пытается вернуть видео к уже показанному состоянию.',
        500,
      );
    }


    consumeVideoGap(videoSourceCursorMs, part.sourceAtMs);

    videoSourceCursorMs = part.sourceAtMs;
    const sourceFrame = frameNumber(
      part.sourceAtMs,
      input.style.fps,
      `videoParts[${index}].sourceAtMs`,
    );
    const holdFrames = frameNumber(
      outputDurationMs,
      input.style.fps,
      `videoParts[${index}].durationMs`,
    );

    if (holdFrames <= 0) {
      throw new ShowcaseError('assemble_failed', 'Удержание не содержит целого кадра.', 500);
    }

    videoHolds.push({ sourceFrame, frameCount: holdFrames });
  }

  if (Math.abs(videoOutputCursorMs - input.plan.timing.totalMs) > 0.01) {
    throw new ShowcaseError(
      'assemble_failed',
      'Видеодорожка точного плана не покрывает его полную длительность.',
      500,
    );
  }

  consumeVideoGap(videoSourceCursorMs, input.plan.sourceVideo.durationMs);

  if (expectedGapIndex !== expectedVideoGaps.length) {
    throw new ShowcaseError(
      'assemble_failed',
      'Точный план заявляет удаление ожидания, которого нет в видеокарте.',
      500,
    );
  }

  const sourceFrameCount = frameNumber(
    input.plan.sourceVideo.durationMs,
    input.style.fps,
    'sourceVideo.durationMs',
  );
  const cutFrames = expectedVideoGaps.map((gap, index) => {
    const fromFrame = frameNumber(
      gap.sourceFromMs,
      input.style.fps,
      `removedWaits[${index}].sourceFromMs`,
    );
    const toFrame = frameNumber(
      gap.sourceToMs,
      input.style.fps,
      `removedWaits[${index}].sourceToMs`,
    );

    return { fromFrame, toFrame };
  });
  const removedFrameCount = cutFrames.reduce(
    (total, cut) => total + cut.toFrame - cut.fromFrame,
    0,
  );
  const holdFrameCount = videoHolds.reduce((total, hold) => total + hold.frameCount, 0);
  const plannedFrameCount = frameNumber(
    input.plan.timing.totalMs,
    input.style.fps,
    'timing.totalMs',
  );

  if (sourceFrameCount - removedFrameCount + holdFrameCount !== plannedFrameCount) {
    throw new ShowcaseError(
      'assemble_failed',
      'Кадровая карта точного плана не сходится с его общей длительностью.',
      500,
    );
  }

  for (const hold of videoHolds) {
    if (cutFrames.some((cut) => (
      hold.sourceFrame >= cut.fromFrame && hold.sourceFrame < cut.toFrame
    ))) {
      throw new ShowcaseError(
        'assemble_failed',
        'Точный план удерживает кадр внутри удалённого ожидания.',
        500,
      );
    }
  }

  const videoFilters = [normalizedVideo];

  if (cutFrames.length > 0) {
    const removedExpression = cutFrames
      .map((cut) => `between(n\\,${cut.fromFrame}\\,${cut.toFrame - 1})`)
      .join('+');

    videoFilters.push(`select='not(${removedExpression})'`, `setpts=N/${input.style.fps}/TB`);
  }

  let precedingHoldFrames = 0;

  for (const hold of videoHolds) {
    const precedingCutFrames = cutFrames.reduce((total, cut) => (
      cut.toFrame <= hold.sourceFrame ? total + cut.toFrame - cut.fromFrame : total
    ), 0);
    const outputFrame = hold.sourceFrame - precedingCutFrames + precedingHoldFrames;

    // Один глобальный поток важен: concat считает однокадровый сегмент нулевой
    // длиной и при серии коротких hold теряет кадры. `loop` дублирует выбранный
    // кадр прямо в общей CFR-последовательности и потому сохраняет каждый hold.
    // У ffmpeg `loop.start` с положительным значением адресует следующий за
    // повторяемым кадр (N повторяет N-1); сдвиг компенсирует это соглашение.
    videoFilters.push(`loop=loop=${hold.frameCount}:size=1:start=${outputFrame + 1}`);
    precedingHoldFrames += hold.frameCount;
  }

  videoFilters.push(`setpts=N/${input.style.fps}/TB`);
  graph.push(`[0:v]${videoFilters.join(',')}[video-concat]`);

  let currentVideoLabel = 'video-concat';

  for (const [index, highlight] of input.plan.highlights.entries()) {
    const values = [
      highlight.startMs,
      highlight.endMs,
      highlight.x,
      highlight.y,
      highlight.width,
      highlight.height,
    ];

    values.forEach((value, valueIndex) => ensureFinite(value, `highlights[${index}][${valueIndex}]`));

    if (highlight.endMs <= highlight.startMs || highlight.width <= 0 || highlight.height <= 0) {
      throw new ShowcaseError('assemble_failed', 'Точный план содержит пустую подсветку.', 500);
    }

    const nextLabel = `video-highlight-${index}`;
    const highlightFromFrame = Math.max(
      0,
      Math.floor(highlight.startMs * input.style.fps / 1000 + 1e-9),
    );
    const highlightToFrame = Math.max(
      highlightFromFrame,
      Math.ceil(highlight.endMs * input.style.fps / 1000 - 1e-9) - 1,
    );

    graph.push(
      `[${currentVideoLabel}]drawbox=x=${highlight.x}:y=${highlight.y}`
      + `:w=${highlight.width}:h=${highlight.height}:color=yellow@0.85:t=4`
      // Номер кадра не зависит от encoder delay/B-frames, в отличие от `t` внутри
      // фильтра. Поэтому рамка совпадает с отображаемыми PTS и на границе фразы.
      + `:enable='between(n\,${highlightFromFrame}\,${highlightToFrame})'`
      + `[${nextLabel}]`,
    );
    currentVideoLabel = nextLabel;
  }

  const sourceAudioParts = input.plan.audioParts
    .map((part, index) => ({ part, index }))
    .filter(({ part }) => part.kind === 'source');
  const audioSplitLabels = sourceAudioParts
    .map(({ index }) => `[audio-source-${index}]`)
    .join('');

  const onlySourceAudio = sourceAudioParts.length === 1 ? sourceAudioParts[0] : null;

  if (onlySourceAudio) {
    graph.push(`[1:a]anull[audio-source-${onlySourceAudio.index}]`);
  } else if (sourceAudioParts.length > 1) {
    graph.push(`[1:a]asplit=${sourceAudioParts.length}${audioSplitLabels}`);
  }

  let audioOutputCursorMs = 0;
  let audioSourceCursorSample = 0;

  for (const [index, part] of input.plan.audioParts.entries()) {
    ensureFinite(part.outputFromMs, `audioParts[${index}].outputFromMs`);
    ensureFinite(part.outputToMs, `audioParts[${index}].outputToMs`);

    if (!(part.outputToMs > part.outputFromMs)
      || Math.abs(part.outputFromMs - audioOutputCursorMs) > 0.01) {
      throw new ShowcaseError('assemble_failed', 'В точном плане есть пустая часть звука.', 500);
    }

    audioOutputCursorMs = part.outputToMs;

    if (part.kind === 'source') {
      if (!Number.isSafeInteger(part.sourceFromSample)
        || !Number.isSafeInteger(part.sourceToSample)
        || part.sourceFromSample < 0
        || part.sourceToSample <= part.sourceFromSample) {
        throw new ShowcaseError('assemble_failed', 'Точный план содержит неверный диапазон PCM.', 500);
      }

      if (part.sourceFromSample !== audioSourceCursorSample) {
        throw new ShowcaseError(
          'assemble_failed',
          'Точный план пытается вырезать или повторить часть речи.',
          500,
        );
      }

      const sourceDurationMs = (part.sourceToSample - part.sourceFromSample) * 1000
        / input.plan.sourceAudio.sampleRate;

      if (part.sourceToSample > input.plan.sourceAudio.sampleCount
        || Math.abs(sourceDurationMs - (part.outputToMs - part.outputFromMs)) > 0.01) {
        throw new ShowcaseError(
          'assemble_failed',
          'Длина PCM-части не совпадает с её выходным интервалом.',
          500,
        );
      }

      audioSourceCursorSample = part.sourceToSample;

      graph.push(
        `[audio-source-${index}]atrim=start_sample=${part.sourceFromSample}`
        + `:end_sample=${part.sourceToSample},asetpts=PTS-STARTPTS,`
        + 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo'
        + `[audio-part-${index}]`,
      );
      continue;
    }

    if (!Number.isSafeInteger(part.sampleCount) || part.sampleCount <= 0
      || !Number.isSafeInteger(part.sampleRate) || part.sampleRate <= 0) {
      throw new ShowcaseError('assemble_failed', 'Точный план содержит неверную вставку тишины.', 500);
    }


    const silenceDurationMs = part.sampleCount * 1000 / part.sampleRate;

    if (part.sampleRate !== input.plan.sourceAudio.sampleRate
      || Math.abs(silenceDurationMs - (part.outputToMs - part.outputFromMs)) > 0.01) {
      throw new ShowcaseError(
        'assemble_failed',
        'Вставка тишины не совпадает с PCM-шкалой точного плана.',
        500,
      );
    }

    graph.push(
      `anullsrc=r=${part.sampleRate}:cl=mono,atrim=end_sample=${part.sampleCount},`
      + 'asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo'
      + `[audio-part-${index}]`,
    );
  }

  if (Math.abs(audioOutputCursorMs - input.plan.timing.totalMs) > 0.01) {
    throw new ShowcaseError(
      'assemble_failed',
      'Звуковая дорожка точного плана не покрывает его полную длительность.',
      500,
    );
  }

  if (audioSourceCursorSample !== input.plan.sourceAudio.sampleCount) {
    throw new ShowcaseError(
      'assemble_failed',
      'Звуковая дорожка точного плана не сохраняет всю реплику.',
      500,
    );
  }

  const audioPartLabels = input.plan.audioParts
    .map((_, index) => `[audio-part-${index}]`)
    .join('');

  graph.push(
    `${audioPartLabels}concat=n=${input.plan.audioParts.length}:v=0:a=1[audio-concat]`,
  );

  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', input.rawVideo,
    '-i', input.audio,
    '-filter_complex', graph.join(';'),
    '-map', `[${currentVideoLabel}]`, '-map', '[audio-concat]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
    '-video_track_timescale', '30000', '-movflags', '+faststart',
    input.outFile,
  ], { signal: input.signal });

  return input.outFile;
}

/**
 * Список для конкатенации. Кавычка в пути экранируется по правилам самого списка —
 * это формат ffmpeg, а не оболочка, и правила у него свои.
 */
async function writeConcatList(files: string[], listFile: string): Promise<void> {
  const body = files.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join('\n');

  await fs.writeFile(listFile, `${body}\n`, 'utf8');
}

export interface ConcatInput {
  clips: string[];
  workDir: string;
  outFile: string;
  subtitles?: string | null;
  style: RenderStyle;
  signal?: AbortSignal;
}

/**
 * Итоговая склейка. Вжигание субтитров — отдельный проход и только по выбору стиля:
 * оно требует перекодирования, и делать его молча ради «красивее» значило бы каждый
 * раз пересчитывать весь ролик.
 */
export async function concatScenes(input: ConcatInput): Promise<string> {
  const listFile = path.join(input.workDir, 'concat.txt');

  await writeConcatList(input.clips, listFile);

  if (!input.style.burnSubtitles || !input.subtitles) {
    await run('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'concat', '-safe', '0', '-i', listFile,
      '-c', 'copy', '-movflags', '+faststart',
      input.outFile,
    ], { signal: input.signal });

    return input.outFile;
  }

  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-vf', `subtitles=${input.subtitles.replaceAll('\\', '\\\\').replaceAll(':', '\\:')}`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'copy', '-movflags', '+faststart',
    input.outFile,
  ], { signal: input.signal });

  return input.outFile;
}

/**
 * Проверка готового файла. Публиковать результат по факту «ffmpeg не упал» нельзя:
 * он молча выдаёт файл без звуковой дорожки, если фильтр не собрал вход, и такой
 * ролик выглядит успешным ровно до момента показа.
 */
export async function probeResult(file: string): Promise<ProbeResult> {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-show_entries',
    'stream=codec_name,codec_type,width,height,r_frame_rate,avg_frame_rate,sample_rate,channels:format=duration',
    '-of', 'json',
    file,
  ]);
  const parsed = JSON.parse(stdout) as {
    streams?: {
      codec_name?: string;
      codec_type?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
      avg_frame_rate?: string;
      sample_rate?: string;
      channels?: number;
    }[];
    format?: { duration?: string };
  };
  const video = parsed.streams?.find((stream) => stream.codec_type === 'video');
  const audio = parsed.streams?.find((stream) => stream.codec_type === 'audio');
  const duration = Number(parsed.format?.duration ?? 0);

  return {
    video: video
      ? {
        codec: video.codec_name ?? '',
        width: video.width ?? 0,
        height: video.height ?? 0,
        // r_frame_rate — объявленная CFR-сетка; avg_frame_rate у concat-copy
        // слегка плавает из-за единственного container tick на стыке сцен.
        frameRate: video.r_frame_rate ?? video.avg_frame_rate ?? '',
      }
      : null,
    audio: audio
      ? {
        codec: audio.codec_name ?? '',
        sampleRate: Number(audio.sample_rate ?? 0),
        channels: audio.channels ?? 0,
      }
      : null,
    durationMs: Number.isFinite(duration) ? Math.round(duration * 1000) : 0,
  };
}

/**
 * Приёмка итога перед публикацией: обе дорожки на месте, размеры и частота кадров
 * те, что объявлены стилем. Несовпадение — ошибка сборки, а не мелочь: ролик с
 * чужим размером кадра нельзя выдать за результат принятого стиля.
 */
export async function assertPlayable(file: string, style: RenderStyle): Promise<ProbeResult> {
  const probed = await probeResult(file);

  if (!probed.video || !probed.audio) {
    throw new ShowcaseError(
      'assemble_failed',
      'В собранном ролике нет видео- или звуковой дорожки.',
      500,
    );
  }

  if (probed.video.width !== style.width || probed.video.height !== style.height) {
    throw new ShowcaseError(
      'assemble_failed',
      `Размер кадра ${probed.video.width}×${probed.video.height} не совпадает с выбранным стилем.`,
      500,
    );
  }

  if (
    probed.video.codec !== 'h264'
    // concat demuxer может выразить среднюю частоту дробью из-за одного тика
    // границы MP4; допуск существенно меньше одного кадра на секунду.
    || Math.abs(rationalValue(probed.video.frameRate) - style.fps) > 0.01
    || probed.audio.codec !== 'aac'
    || probed.audio.sampleRate !== 48_000
    || probed.audio.channels !== 2
  ) {
    throw new ShowcaseError(
      'assemble_failed',
      'Потоки собранного ролика не совпадают с профилем '
        + `H.264/${style.fps} fps и AAC 48 кГц stereo: `
        + `${probed.video.codec}/${probed.video.frameRate}, `
        + `${probed.audio.codec}/${probed.audio.sampleRate}/${probed.audio.channels}.`,
      500,
    );
  }

  if (probed.durationMs <= 0) {
    throw new ShowcaseError('assemble_failed', 'Собранный ролик нулевой длины.', 500);
  }

  return probed;
}

/**
 * Импортированный звук приводится к общему PCM-профилю до всякой работы с ним:
 * дальше по конвейеру и таймлайн, и сведение считают частоту и число каналов
 * известными, а WAV человека приходит каким угодно.
 */
export async function normalizeImportedAudio(source: string, outFile: string): Promise<string> {
  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', source,
    '-map', '0:a:0',
    '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '1',
    outFile,
  ]);

  return outFile;
}

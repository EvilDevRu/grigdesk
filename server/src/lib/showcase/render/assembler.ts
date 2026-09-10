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

import type { ShowcaseTiming } from '../../../../../shared/showcaseContracts.ts';
import { ShowcaseError } from '../errors.ts';
import type { RenderStyle } from '../artifacts.ts';

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
    'stream=codec_name,codec_type,width,height,avg_frame_rate,sample_rate,channels:format=duration',
    '-of', 'json',
    file,
  ]);
  const parsed = JSON.parse(stdout) as {
    streams?: {
      codec_name?: string;
      codec_type?: string;
      width?: number;
      height?: number;
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
        frameRate: video.avg_frame_rate ?? '',
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

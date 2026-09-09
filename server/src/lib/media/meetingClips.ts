// Фрагмент записи к черновику задачи.
//
// Кадр отвечает на «о чём вообще шла речь», но не на «что именно человек сказал»:
// формулировку модели проверяют по звуку, а исполнитель задачи по нему же понимает
// интонацию просьбы и её условия. Поэтому рядом с кадром живёт вырезанный кусок
// записи — его смотрят до постановки и прикладывают к задаче файлом.
//
// Окно фиксированное и стоит ВОКРУГ того же таймкода, что кадр и ссылка в описании
// («На записи: 04:31»): у картинки, у ссылки и у фрагмента должно быть одно место,
// иначе сверять их между собой нечем. Длину человек при нужде расширяет сам.
//
// Наружу уходит только ИМЯ фрагмента (`<разбор>/<файл>`), как у кадров: путь из
// браузера означал бы «нарежь и покажи любой файл сервера», а вложение по такому
// пути — «залей любой файл на портал».
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';

import { locatePart, sweepRunDirs } from './meetingFrames.ts';
import type { MeetingPart, RunSweepOptions } from './meetingFrames.ts';

type LogPort = {
  info?: (details: unknown, message: string) => void;
};

// Куда ляжет фрагмент: часть записи, локальное окно внутри неё и те же секунды
// сквозной шкалой — ими то же место названо в описании задачи.
export interface MeetingClipRange {
  index: number;
  part: MeetingPart;
  from: number;
  seconds: number;
  at: number;
  fromAt: number;
  toAt: number;
}

// Готовый фрагмент в том виде, в каком его отдают браузеру: имя, а не путь.
export interface MeetingClip {
  name: string;
  at: number;
  from: number;
  to: number;
  seconds: number;
  bytes: number;
}

// Нарезка одного фрагмента. Подменяется в проверках, живой раздел отдаёт ffmpeg.
export type ClipCutter = (options: {
  filePath: string;
  from: number;
  seconds: number;
  run: string;
  part: number;
}) => Promise<{ path?: string; bytes?: number } | null>;

export const MEETING_CLIP_LIMITS = Object.freeze({
  // Полминуты вокруг таймкода: реплика повода вместе с тем, что её вызвало, и с
  // ответом на неё. Больше — уже пересказ соседних тем, меньше — обрывок фразы.
  windowSec: 15,
  minWindowSec: 5,
  maxWindowSec: 60,
  // Потолок самого фрагмента. Он уезжает на портал файлом, и «прикрепить встречу
  // целиком» не является ни задачей раздела, ни тем, что примет чужой почтовый ящик.
  maxSeconds: 180,
  // Фрагменты — производный артефакт, как и кадры: исходник записи остаётся на месте.
  ttlMs: 7 * 24 * 60 * 60 * 1000,
});

// Имя собирается сервером и проверяется буквально: ни точек, ни слэшей внутри частей,
// поэтому выйти таким именем из каталога фрагментов нечем.
const NAME_RE = /^[0-9a-f]{16}\/p\d{1,2}-\d{5}-\d{3}s\.mp4$/;

/** Имя фрагмента в том виде, в каком его отдали браузеру. */
export function isMeetingClipName(value: unknown): value is string {
  return typeof value === 'string' && NAME_RE.test(value);
}

/** Абсолютный путь фрагмента по его имени; `null` — имя не наше или файла нет. */
export function meetingClipPath(root: string, name: unknown): string | null {
  if (!root || !isMeetingClipName(name)) return null;
  const [run = '', file = ''] = name.split('/');
  const full = join(root, run, file);
  return existsSync(full) ? full : null;
}

/**
 * Идентификатор разбора для каталога фрагментов. Считается от самих частей встречи,
 * а не случайно: тот же разбор обязан попадать в тот же каталог, иначе повторный
 * просмотр резал бы файл заново и множил копии одного куска.
 */
export function meetingClipRun(jobIds: readonly unknown[] = []): string {
  const key = [...jobIds].map((id) => String(id)).sort().join('|');
  return createHash('sha1').update(key).digest('hex').slice(0, 16);
}

/** Окно в пределах допустимого: чужое число из браузера не должно резать полчаса. */
export function clipWindow(value: unknown): number {
  const { windowSec, minWindowSec, maxWindowSec } = MEETING_CLIP_LIMITS;
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return windowSec;
  return Math.min(maxWindowSec, Math.max(minWindowSec, Math.round(seconds)));
}

/**
 * Куда фактически ляжет фрагмент: часть встречи, локальное начало и длительность.
 * Начало клампится нулём, конец — длительностью части: `-ss`/`-t` за концом файла
 * дают пустой вывод и ненулевой код ffmpeg, то есть промах отменил бы фрагмент целиком.
 * Части встречи режутся по своей границе, а не склеиваются: у соседней части свой
 * файл и свой таймкод, и склейка выдала бы за один кусок два разных места записи.
 */
export function clipRange(
  at: number,
  parts: MeetingPart[] = [],
  window: number = MEETING_CLIP_LIMITS.windowSec,
): MeetingClipRange | null {
  const spot = locatePart(at, parts);
  if (!spot) return null;

  const half = clipWindow(window);
  const duration = Number(spot.part?.duration);
  const known = Number.isFinite(duration) && duration > 0;
  const from = Math.max(0, spot.seconds - half);
  const wanted = known ? Math.min(spot.seconds + half, Math.floor(duration)) : spot.seconds + half;
  const seconds = Math.min(MEETING_CLIP_LIMITS.maxSeconds, Math.max(1, Math.round(wanted - from)));

  return {
    index: spot.index,
    part: spot.part,
    from,
    seconds,
    // Сквозные секунды — то, что видит человек: таймкоды в описании тоже сквозные.
    at: Math.round(at),
    fromAt: Math.round(at) - (spot.seconds - from),
    toAt: Math.round(at) - spot.seconds + from + seconds,
  };
}

/**
 * Фрагмент вокруг секунды записи. `null` означает «фрагмента нет» — запись без
 * видеодорожки, исчезнувший файл или отказ ffmpeg; постановку задачи это не отменяет,
 * ровно как и отсутствие кадра.
 *
 * @param {{at:number, parts:Array, run:string, window?:number, cut:Function,
 *          log?:object}} opts
 */
export async function buildMeetingClip({
  at,
  parts = [],
  run,
  window = MEETING_CLIP_LIMITS.windowSec,
  cut,
  log = console,
}: {
  at?: number;
  parts?: MeetingPart[];
  run?: string;
  window?: number;
  cut?: ClipCutter;
  log?: LogPort;
} = {}): Promise<MeetingClip | null> {
  if (typeof cut !== 'function' || !run) return null;

  // Секунды без числа отсекает сам расчёт окна: `NaN` не попадает ни в одну часть,
  // и разбор задачи от этого не отменяется — фрагмента просто не будет.
  const range = clipRange(at ?? Number.NaN, parts, window);
  if (!range?.part?.filePath) return null;

  try {
    const made = await cut({
      filePath: range.part.filePath,
      from: range.from,
      seconds: range.seconds,
      run,
      part: range.index,
    });
    if (!made?.path) return null;
    return {
      name: `${run}/${basename(made.path)}`,
      at: range.at,
      from: range.fromAt,
      to: range.toAt,
      seconds: range.seconds,
      bytes: Number(made.bytes) || 0,
    };
  } catch (error) {
    // Аудиозапись без видеодорожки попадает сюда штатно — это не поломка раздела.
    log?.info?.({ err: error, at: range.at }, 'разбор встречи: фрагмент не вырезан');
    return null;
  }
}

/** Убирает фрагменты прошлых разборов; устроено так же, как уборка кадров. */
export function sweepMeetingClips(root: string, options: RunSweepOptions = {}): number {
  return sweepRunDirs(root, { ttlMs: MEETING_CLIP_LIMITS.ttlMs, ...options });
}

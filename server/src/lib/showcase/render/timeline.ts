// Таймлайн сцены и общий таймлайн ролика.
//
// Режим один — `voiceLeads`: сначала известна длительность звука, и только потом
// строится расписание. Обратный порядок заставлял бы резать речь под длину клипа,
// а показывать надо ровно то, что произносится.
//
// Конец сцены — максимум конца речи и конца действий плюс короткий хвост.
// Недостающая картинка добирается стоп-кадром, недостающий звук — тишиной.
import type { ShowcaseScene, ShowcaseTiming } from '../../../../../shared/showcaseContracts.ts';

export const PRE_ROLL_MS = 400;
export const POST_ROLL_MS = 600;

// Хвост тишины длиннее этого порога — повод предупредить человека: скорее всего
// действий в сцене больше, чем речи, и её стоит переписать. Звук при этом НЕ режется.
export const SILENT_TAIL_WARNING_MS = 3_000;

export interface ScenePlanInput {
  audioMs: number;
  clipMs: number;
}

/**
 * Расписание одной сцены. Общая длительность именно вычисляется, а не берётся у той
 * дорожки, которая длиннее случайно: план требует не обрезать звук ради клипа и не
 * обрывать показ ради звука.
 */
export function planScene({ audioMs, clipMs }: ScenePlanInput): ShowcaseTiming {
  const narrationStartMs = PRE_ROLL_MS;
  const speechEndMs = narrationStartMs + audioMs;
  const actionsEndMs = clipMs;

  return {
    preRollMs: PRE_ROLL_MS,
    narrationStartMs,
    speechEndMs,
    actionsEndMs,
    postRollMs: POST_ROLL_MS,
    totalMs: Math.max(speechEndMs, actionsEndMs) + POST_ROLL_MS,
  };
}

export function silentTailMs(timing: ShowcaseTiming): number {
  return timing.totalMs - timing.speechEndMs;
}

export interface SubtitleCue {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
}

export interface SceneSlice {
  scene: ShowcaseScene;
  timing: ShowcaseTiming;
  // Измеренная длина готового клипа сцены. Плановая сюда не годится: кодек
  // округляет длительность до кадра, и на трёх сценах опытного прогона плановая
  // сумма разошлась с файлом на 29 мс. Ошибка копится линейно, и к концу длинного
  // ролика субтитр уезжает с речи.
  measuredMs: number;
}

/**
 * Субтитры по общему таймлайну: смещение сцены плюс её собственная привязка речи.
 * Границы фраз внутри сцены не выдумываются — реплика одна на сцену, и она честно
 * накрывает интервал речи, а не подсвечивается по словам.
 */
export function buildSubtitles(slices: SceneSlice[]): { cues: SubtitleCue[]; totalMs: number } {
  const cues: SubtitleCue[] = [];
  let offsetMs = 0;

  for (const slice of slices) {
    const text = slice.scene.subtitleText.trim();

    if (text) {
      cues.push({
        index: cues.length + 1,
        startMs: offsetMs + slice.timing.narrationStartMs,
        endMs: offsetMs + slice.timing.speechEndMs,
        text,
      });
    }

    offsetMs += slice.measuredMs || slice.timing.totalMs;
  }

  return { cues, totalMs: offsetMs };
}

function srtTime(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const hours = String(Math.floor(total / 3_600_000)).padStart(2, '0');
  const minutes = String(Math.floor(total / 60_000) % 60).padStart(2, '0');
  const seconds = String(Math.floor(total / 1000) % 60).padStart(2, '0');
  const millis = String(total % 1000).padStart(3, '0');

  return `${hours}:${minutes}:${seconds},${millis}`;
}

/**
 * Файл субтитров. Реплики не пересекаются по построению — каждая живёт внутри своей
 * сцены, а сцены идут подряд, — но пустая реплика в файл не попадает: пустой блок
 * SRT некоторые плееры считают ошибкой формата.
 */
export function renderSrt(cues: SubtitleCue[]): string {
  return cues
    .map((cue) => `${cue.index}\n${srtTime(cue.startMs)} --> ${srtTime(cue.endMs)}\n${cue.text}\n`)
    .join('\n');
}

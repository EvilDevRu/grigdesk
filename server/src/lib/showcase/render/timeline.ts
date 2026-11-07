// Таймлайн сцены и общий таймлайн ролика.
//
// Расписание одной сцены живёт в общем модуле (`shared/plugins/showcase/showcaseTimeline.ts`): по той
// же формуле экран ролика считает, с какой секунды начинается сцена. Здесь остаётся
// то, что нужно только сборке, — субтитры по измеренным длинам готовых клипов и SRT.
import type {
  ShowcaseScene,
  ShowcaseTiming,
} from '../../../../../shared/plugins/showcase/showcaseContracts.ts';
import {
  planScene,
  POST_ROLL_MS,
  PRE_ROLL_MS,
} from '../../../../../shared/plugins/showcase/showcaseTimeline.ts';
import type { ScenePlanInput } from '../../../../../shared/plugins/showcase/showcaseTimeline.ts';

export { planScene, POST_ROLL_MS, PRE_ROLL_MS };
export type { ScenePlanInput };

// Хвост тишины длиннее этого порога — повод предупредить человека: скорее всего
// действий в сцене больше, чем речи, и её стоит переписать. Звук при этом НЕ режется.
export const SILENT_TAIL_WARNING_MS = 3_000;

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

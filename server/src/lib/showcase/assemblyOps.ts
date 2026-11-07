// Сборка ролика из готовых сцен.
//
// Собирается ровно то, что уже записано и озвучено: сборка ничего не пересчитывает
// и не переснимает. Если входы сцены разошлись с её артефактами, задание отказывает
// до первого вызова ffmpeg — «собрать из чего есть» дало бы ролик, который человек
// принял бы за свежий.
//
// Итог проверяется по самому файлу: длительность и дорожки читаются ffprobe, а
// границы субтитров считаются по ИЗМЕРЕННОЙ длине готовых клипов — кодек округляет
// длительность до кадра, и плановая сумма расходится с файлом.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { jsonHash32 } from '../../../../shared/node/hash.ts';

import {
  artifactFile,
  finalInputHash,
  publishArtifact,
  sceneFreshness,
} from './artifacts.ts';
import type { ArtifactInputs } from './artifacts.ts';
import { ShowcaseError } from './errors.ts';
import { PRODUCER_VERSIONS, RENDER_STYLE } from './formats.ts';
import {
  assertPlayable,
  buildSceneClip,
  buildSyncedSceneClip,
  concatScenes,
  probeSyncAudioSource,
} from './render/assembler.ts';
import { probeDurationMs } from './render/clipCheck.ts';
import { planScene, renderSrt } from './render/timeline.ts';
import type {
  ShowcaseJob,
  ShowcaseProject,
  ShowcaseScene,
  ShowcaseTiming,
} from '../../../../shared/plugins/showcase/showcaseContracts.ts';
import { chainLineage } from '../../../../shared/plugins/showcase/showcaseChains.ts';
import { parseNarration } from '../../../../shared/plugins/showcase/showcaseNarration.ts';
import {
  SHOWCASE_MANIFEST_MEDIA_TOLERANCE_MS,
  SHOWCASE_MANIFEST_VERSION,
} from '../../../../shared/plugins/showcase/showcaseTimeline.ts';
import type {
  ShowcaseFinalManifest,
  ShowcaseManifestPhrase,
  ShowcaseManifestSubtitleCue,
} from '../../../../shared/plugins/showcase/showcaseTimeline.ts';
import { toPublicJob } from './jobs.ts';
import type { ShowcaseJobs } from './jobs.ts';
import { readRecordingTiming } from './recordingOps.ts';
import { planShowcaseSync } from './render/syncPlan.ts';
import type {
  ExactSyncPlan,
  ExactSyncTiming,
  RecordingFixtureTiming,
  SpeechFixtureTiming,
  SyncDiagnostic,
} from './render/syncPlan.ts';
import { syncActionsHash, syncTextHash } from './scenes.ts';
import {
  publishFinalManifest,
  publishSpeechAlignment,
  readSpeechAlignment,
  readSpeechTiming,
} from './syncStore.ts';
import { alignSpeechTiming, speechFixtureOf } from './voice/alignment.ts';
import type { ShowcaseStore } from './store.ts';

export interface AssemblyOpsDeps {
  assertEnabled: () => void;
  broadcast: (event: string, data: unknown) => void;
  inputsOf: (project: ShowcaseProject) => ArtifactInputs;
  jobs: ShowcaseJobs;
  limits: () => { maxSceneSeconds: number; maxTotalSeconds: number };
  readProject: (id: string) => Promise<ShowcaseProject>;
  store: ShowcaseStore;
}

type ScenePlanTiming = ShowcaseTiming | ExactSyncTiming;

interface AssemblySlice {
  scene: ShowcaseScene;
  file: string;
  measuredMs: number;
  timing: ScenePlanTiming;
  mode: 'exact' | 'legacy';
  quality: 'word-exact' | 'phrase' | 'approximate' | 'missing';
  planHash: string;
  phrases: ShowcaseManifestPhrase[];
  cues: ExactSyncPlan['cues'];
}

interface LoadedSpeech {
  fixture: SpeechFixtureTiming | null;
  quality: AssemblySlice['quality'];
  error: string | null;
}

interface LoadedRecording {
  fixture: RecordingFixtureTiming | null;
  error: string | null;
}

function sidecarDir(store: ShowcaseStore, projectId: string, sceneId: string): string {
  return path.join(store.namesOf(projectId).scenesDir, sceneId, 'artifacts');
}

function reviewReason(scene: ShowcaseScene, diagnostics: readonly SyncDiagnostic[]): string {
  const details = diagnostics.map((item) => item.message).join(' ');

  return `Сцена «${scene.title}» требует проверки синхронизации. ${details}`.trim();
}

function phrasesForManifest(
  scene: ShowcaseScene,
  source: readonly { id: string; from: number; to: number; startMs: number; endMs: number }[],
  offsetMs: number,
): ShowcaseManifestPhrase[] {
  const canonical = parseNarration(scene.narration).text;

  return source.map((phrase, index) => ({
    id: phrase.id,
    // Граница alignment заканчивается на последней лексеме. Пунктуация и пробел
    // до следующей измеренной фразы принадлежат текущему экранному субтитру.
    text: canonical.slice(phrase.from, source[index + 1]?.from ?? canonical.length).trim(),
    startMs: offsetMs + phrase.startMs,
    endMs: offsetMs + phrase.endMs,
  })).filter((phrase) => phrase.text.length > 0);
}

function buildManifestSubtitles(slices: readonly AssemblySlice[]): ShowcaseManifestSubtitleCue[] {
  const cues: ShowcaseManifestSubtitleCue[] = [];
  let sceneOffsetMs = 0;

  for (const slice of slices) {
    const subtitle = slice.scene.subtitleText.trim();
    const canonical = parseNarration(slice.scene.narration).text.trim();

    if (!subtitle) {
      sceneOffsetMs += slice.measuredMs;
      continue;
    }

    if (subtitle === canonical && slice.phrases.length > 0) {
      for (const phrase of slice.phrases) {
        cues.push({
          index: cues.length + 1,
          sceneId: slice.scene.id,
          startMs: sceneOffsetMs + phrase.startMs,
          endMs: sceneOffsetMs + phrase.endMs,
          text: phrase.text,
        });
      }
    } else {
      cues.push({
        index: cues.length + 1,
        sceneId: slice.scene.id,
        startMs: sceneOffsetMs + slice.timing.narrationStartMs,
        endMs: sceneOffsetMs + slice.timing.speechEndMs,
        text: subtitle,
      });
    }

    sceneOffsetMs += slice.measuredMs;
  }

  return cues;
}

export function createAssemblyOps(deps: AssemblyOpsDeps) {
  const {
    assertEnabled, broadcast, inputsOf, jobs, readProject, store,
  } = deps;

  /**
   * Alignment дешёв и детерминирован: если WAV уже распознан, правка текста
   * пересобирает только диапазоны по сохранённому raw timing и не запускает ASR.
   * Файлы публикуются раньше ссылки; callback ещё раз связывает их с теми же
   * байтами WAV, timing и редакцией канонической строки.
   */
  async function ensureSpeechAlignments(projectId: string): Promise<ShowcaseProject> {
    const snapshot = await readProject(projectId);
    const replacements: {
      sceneId: string;
      audioContentHash: string;
      timingContentHash: string;
      textHash: string;
      ref: NonNullable<ShowcaseScene['speechAlignment']>;
    }[] = [];

    for (const scene of snapshot.scenes) {
      if (!scene.audio || !scene.speechTiming) {
        continue;
      }

      const targetDir = sidecarDir(store, projectId, scene.id);
      const raw = await readSpeechTiming({
        ref: scene.speechTiming,
        sceneInputHash: scene.audio.inputHash,
        audioContentHash: scene.audio.contentHash,
        targetDir,
      });

      // Существующий, но битый raw timing разбирается в runAssemble как
      // awaiting_review. Повторный ASR внутри сборки запрещён.
      if (!raw) {
        continue;
      }

      const canonicalText = parseNarration(scene.narration).text;
      const textHash = syncTextHash(canonicalText);
      const current = scene.speechAlignment
        ? await readSpeechAlignment({
          ref: scene.speechAlignment,
          canonicalText,
          textHash,
          audioContentHash: scene.audio.contentHash,
          speechTimingContentHash: scene.speechTiming.contentHash,
          targetDir,
        })
        : null;

      if (current) {
        continue;
      }

      const ref = await publishSpeechAlignment({
        alignment: alignSpeechTiming({
          canonicalText,
          durationMs: raw.durationMs,
          timing: raw,
        }),
        canonicalText,
        textHash,
        audioContentHash: scene.audio.contentHash,
        speechTimingContentHash: scene.speechTiming.contentHash,
        targetDir,
      });

      if (ref) {
        replacements.push({
          sceneId: scene.id,
          audioContentHash: scene.audio.contentHash,
          timingContentHash: scene.speechTiming.contentHash,
          textHash,
          ref,
        });
      }
    }

    if (replacements.length === 0) {
      return snapshot;
    }

    return store.updateProject(projectId, null, (current) => ({
      ...current,
      scenes: current.scenes.map((scene) => {
        const replacement = replacements.find((item) => item.sceneId === scene.id);

        if (
          !replacement
          || !scene.audio
          || !scene.speechTiming
          || scene.audio.contentHash !== replacement.audioContentHash
          || scene.speechTiming.contentHash !== replacement.timingContentHash
          || syncTextHash(parseNarration(scene.narration).text) !== replacement.textHash
        ) {
          return scene;
        }

        return { ...scene, speechAlignment: replacement.ref };
      }),
    }));
  }

  async function loadSpeech(
    projectId: string,
    scene: ShowcaseScene,
    audioFile: string,
  ): Promise<LoadedSpeech> {
    if (!scene.speechTiming) {
      return scene.speechAlignment
        ? {
          fixture: null,
          quality: 'missing',
          error: 'Ссылка на сопоставление речи есть без исходных меток WAV.',
        }
        : { fixture: null, quality: 'missing', error: null };
    }

    if (!scene.audio) {
      return { fixture: null, quality: 'missing', error: 'У меток речи отсутствует WAV.' };
    }

    const targetDir = sidecarDir(store, projectId, scene.id);
    const raw = await readSpeechTiming({
      ref: scene.speechTiming,
      sceneInputHash: scene.audio.inputHash,
      audioContentHash: scene.audio.contentHash,
      targetDir,
    });

    if (!raw) {
      return {
        fixture: null,
        quality: 'missing',
        error: 'Сохранённые метки речи повреждены или относятся к другому WAV.',
      };
    }

    if (!scene.speechAlignment) {
      return {
        fixture: null,
        quality: raw.quality,
        error: 'Для сохранённых меток речи отсутствует актуальное сопоставление с текстом.',
      };
    }

    const canonicalText = parseNarration(scene.narration).text;
    const alignment = await readSpeechAlignment({
      ref: scene.speechAlignment,
      canonicalText,
      textHash: syncTextHash(canonicalText),
      audioContentHash: scene.audio.contentHash,
      speechTimingContentHash: scene.speechTiming.contentHash,
      targetDir,
    });

    if (!alignment || Math.abs(alignment.durationMs - raw.durationMs) > 0.01) {
      return {
        fixture: null,
        quality: raw.quality,
        error: 'Сопоставление речи повреждено, устарело или использует другую шкалу WAV.',
      };
    }

    const pcm = await probeSyncAudioSource(audioFile);

    if (Math.abs(pcm.durationMs - raw.durationMs) > 1000 / pcm.sampleRate + 1) {
      return {
        fixture: null,
        quality: alignment.quality,
        error: 'Длительность меток речи не совпадает с опубликованным WAV.',
      };
    }

    return {
      fixture: speechFixtureOf({
        canonicalText,
        durationMs: alignment.durationMs,
        quality: alignment.quality,
        spans: alignment.spans,
        phrases: alignment.phrases,
        safePauses: alignment.safePauses,
        reason: alignment.reason,
      }, pcm),
      quality: alignment.quality,
      error: null,
    };
  }

  async function loadRecording(
    projectId: string,
    scene: ShowcaseScene,
  ): Promise<LoadedRecording> {
    if (!scene.recordingTiming) {
      return { fixture: null, error: null };
    }

    if (!scene.clip) {
      return { fixture: null, error: 'У журнала записи отсутствует клип.' };
    }

    const timing = await readRecordingTiming({
      ref: scene.recordingTiming,
      sceneInputHash: scene.clip.inputHash,
      clipContentHash: scene.clip.contentHash,
      actions: scene.actions,
      targetDir: sidecarDir(store, projectId, scene.id),
    });

    if (!timing) {
      return {
        fixture: null,
        error: 'Журнал записи повреждён, устарел или относится к другому клипу.',
      };
    }

    // Калибровка уже была предпринята и честно не удалась. Это документированный
    // fallback, а не старый клип без журнала и не повод записывать цепочку снова.
    if (timing.status === 'unavailable') {
      return { fixture: null, error: null };
    }

    return {
      fixture: {
        durationMs: timing.durationMs,
        calibration: 'calibrated',
        calibrationErrorMs: timing.calibration.errorMs,
        actions: timing.actions,
        stableIntervals: timing.stableIntervals,
        removableWaits: timing.removableWaits,
        highlights: timing.highlights,
      },
      error: null,
    };
  }

  /**
   * Сборка ролика. Требует, чтобы у каждой сцены были свежие клип и звук: собирать
   * из наполовину устаревших частей значило бы выдать за готовый ролик смесь двух
   * редакций. Работа идёт в самом сервере — она локальная, конечная и не открывает
   * ни браузера, ни сети.
   */
  async function assemble(id: string): Promise<ShowcaseJob> {
    assertEnabled();

    const project = await ensureSpeechAlignments(id);
    const inputs = inputsOf(project);
    const ordered = [...project.scenes].sort((left, right) => left.order - right.order);

    if (ordered.length === 0) {
      throw new ShowcaseError('no_scenes', 'В ролике нет ни одной сцены.', 409);
    }

    for (const scene of ordered) {
      const fresh = sceneFreshness(scene, inputs, chainLineage(ordered, scene.id));

      if (!fresh.clip) {
        throw new ShowcaseError(
          'scene_not_ready',
          `Сцена «${scene.title}» ещё не записана или запись устарела.`,
          409,
        );
      }

      if (!fresh.audio) {
        throw new ShowcaseError(
          'scene_not_ready',
          `У сцены «${scene.title}» нет свежего звука.`,
          409,
        );
      }
    }

    const { record, reused } = await jobs.enqueue({
      projectId: id,
      kind: 'assemble',
      idempotencyKey: createHash('sha256')
        .update(`assemble:${id}:${finalInputHash(project, inputs)}`)
        .digest('hex')
        .slice(0, 32),
      inputHashes: { final: finalInputHash(project, inputs) },
      inputRevision: project.revision,
    });

    if (reused) {
      return toPublicJob(record);
    }

    void runAssemble(record.id, id).catch(async (error) => {
      await jobs.finish(record.id, {
        state: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    });

    return toPublicJob(record);
  }

  async function runAssemble(jobId: string, projectId: string): Promise<void> {
    const project = await readProject(projectId);
    const inputs = inputsOf(project);
    const names = store.namesOf(projectId);
    const workDir = path.join(store.jobsDir, jobId, 'work');
    const ordered = [...project.scenes].sort((left, right) => left.order - right.order);
    const slices: AssemblySlice[] = [];
    const inputHash = finalInputHash(project, inputs);
    const job = jobs.read(jobId);
    const configuredLimits = deps.limits();
    const maxSceneMs = configuredLimits.maxSceneSeconds * 1000;
    const maxFilmMs = configuredLimits.maxTotalSeconds * 1000;

    if (job.inputHashes.final !== inputHash) {
      throw new ShowcaseError(
        'assemble_inputs_changed',
        'Ролик изменился до начала сборки: устаревшее задание остановлено.',
        409,
      );
    }

    await fs.mkdir(workDir, { recursive: true, mode: 0o700 });

    let index = 0;
    let measuredTotalMs = 0;

    for (const scene of ordered) {
      index += 1;
      await jobs.progress(jobId, {
        sequence: jobs.read(jobId).sequence + 1,
        label: `сводим сцену «${scene.title}»`,
        index,
        total: ordered.length,
      });

      const clipFile = artifactFile(
        path.join(names.scenesDir, scene.id, 'artifacts'),
        scene.clip!.id,
        '.webm',
      );
      const audioFile = artifactFile(
        path.join(names.scenesDir, scene.id, 'artifacts'),
        scene.audio!.id,
        '.wav',
      );
      const [probedAudioMs, probedClipMs, speech, recording] = await Promise.all([
        probeDurationMs(audioFile),
        probeDurationMs(clipFile),
        loadSpeech(projectId, scene, audioFile),
        loadRecording(projectId, scene),
      ]);
      // Legacy сохраняет прежний контракт длительностей артефакта. Точный путь
      // всё равно сверяет decoded samples/frames внутри buildSyncedSceneClip.
      const audioMs = scene.audio!.durationMs ?? probedAudioMs;
      const clipMs = scene.clip!.durationMs ?? probedClipMs;

      if (speech.error || recording.error) {
        await jobs.finish(jobId, {
          state: 'awaiting_review',
          label: 'нужна проверка синхронизации',
          error: `Сцена «${scene.title}» требует проверки синхронизации. ${speech.error ?? recording.error}`,
        });

        return;
      }

      const result = planShowcaseSync({
        bindingInput: scene.syncBindings
          ? {
            bindings: scene.syncBindings,
            canonicalText: parseNarration(scene.narration).text,
            actions: scene.actions,
            expectedTextHash: syncTextHash(parseNarration(scene.narration).text),
            expectedActionsHash: syncActionsHash(scene.actions),
          }
          : null,
        speech: speech.fixture,
        recording: recording.fixture,
        legacy: { audioMs, clipMs },
        style: RENDER_STYLE,
        limits: {
          maxSceneMs,
          remainingFilmMs: Math.max(0, maxFilmMs - measuredTotalMs),
        },
      });
      const outFile = path.join(workDir, `${scene.id}.mp4`);

      if (result.status === 'conflict') {
        await jobs.finish(jobId, {
          state: 'awaiting_review',
          label: 'нужна проверка синхронизации',
          error: reviewReason(scene, result.diagnostics),
        });

        return;
      }

      const timing = result.status === 'exact' ? result.plan.timing : result.timing;

      if (
        timing.totalMs > maxSceneMs + 0.01
        || measuredTotalMs + timing.totalMs > maxFilmMs + 0.01
      ) {
        await jobs.finish(jobId, {
          state: 'awaiting_review',
          label: 'превышен предел длительности',
          error: `Сцена «${scene.title}» не помещается в установленный предел ролика.`,
        });

        return;
      }

      if (result.status === 'exact') {
        await buildSyncedSceneClip({
          rawVideo: clipFile,
          audio: audioFile,
          plan: result.plan,
          outFile,
          style: RENDER_STYLE,
        });
      } else {
        await buildSceneClip({
          rawVideo: clipFile,
          audio: audioFile,
          timing,
          outFile,
          style: RENDER_STYLE,
        });
      }

      const probedScene = await assertPlayable(outFile, RENDER_STYLE);

      if (
        Math.abs(probedScene.durationMs - timing.totalMs)
          > SHOWCASE_MANIFEST_MEDIA_TOLERANCE_MS
      ) {
        throw new ShowcaseError(
          'assemble_failed',
          `Измеренная длительность сцены «${scene.title}» не совпадает с её планом.`,
          500,
        );
      }

      const sourcePhrases = result.status === 'exact'
        ? result.plan.phrases
        : (speech.fixture?.phrases ?? []).map((phrase) => ({
          ...phrase,
          startMs: timing.narrationStartMs + phrase.startMs,
          endMs: timing.narrationStartMs + phrase.endMs,
        }));

      slices.push({
        scene,
        timing,
        measuredMs: probedScene.durationMs,
        file: outFile,
        mode: result.status === 'exact' ? 'exact' : 'legacy',
        quality: speech.quality,
        planHash: jsonHash32(result.status === 'exact' ? result.plan : {
          mode: 'legacy',
          timing: result.timing,
          diagnostics: result.diagnostics.map((item) => item.code),
        }),
        phrases: phrasesForManifest(scene, sourcePhrases, 0),
        cues: result.status === 'exact' ? result.plan.cues : [],
      });
      measuredTotalMs += probedScene.durationMs;
    }

    await jobs.progress(jobId, {
      sequence: jobs.read(jobId).sequence + 1,
      label: 'склеиваем ролик',
      index: ordered.length,
      total: ordered.length,
    });

    const subtitleCues = buildManifestSubtitles(slices);
    const srtFile = path.join(workDir, 'subtitles.srt');
    const finalFile = path.join(workDir, 'final.mp4');

    if (subtitleCues.length > 0) {
      await fs.writeFile(srtFile, renderSrt(subtitleCues), 'utf8');
    }

    await concatScenes({
      clips: slices.map((slice) => slice.file),
      workDir,
      outFile: finalFile,
      subtitles: subtitleCues.length > 0 ? srtFile : null,
      style: RENDER_STYLE,
    });

    const probed = await assertPlayable(finalFile, RENDER_STYLE);

    if (
      Math.abs(probed.durationMs - measuredTotalMs)
        > SHOWCASE_MANIFEST_MEDIA_TOLERANCE_MS
    ) {
      throw new ShowcaseError(
        'assemble_failed',
        'Длительность итогового MP4 не совпала с накопленной шкалой готовых сцен.',
        500,
      );
    }

    const video = await publishArtifact({
      file: finalFile,
      kind: 'final',
      inputHash,
      producerVersion: PRODUCER_VERSIONS.assembler,
      durationMs: probed.durationMs,
      targetDir: names.finalsDir,
    });
    const captions = subtitleCues.length > 0
      ? await publishArtifact({
        file: srtFile,
        kind: 'subtitles',
        inputHash,
        producerVersion: PRODUCER_VERSIONS.assembler,
        durationMs: null,
        targetDir: names.finalsDir,
      })
      : null;
    const exactScenes = slices.filter((slice) => slice.mode === 'exact').length;
    const mode = exactScenes === slices.length
      ? 'exact'
      : exactScenes === 0
        ? 'legacy'
        : 'mixed';
    let offsetMs = 0;
    const manifestScenes: ShowcaseFinalManifest['scenes'] = slices.map((slice, sceneIndex) => {
      const startMs = offsetMs;
      const endMs = startMs + slice.measuredMs;
      const sceneManifest: ShowcaseFinalManifest['scenes'][number] = {
        id: slice.scene.id,
        order: sceneIndex + 1,
        caption: slice.scene.caption,
        startMs,
        endMs,
        durationMs: slice.measuredMs,
        planHash: slice.planHash,
        mode: slice.mode,
        quality: slice.quality,
        phrases: slice.phrases.map((phrase) => ({
          ...phrase,
          startMs: startMs + phrase.startMs,
          endMs: startMs + phrase.endMs,
        })),
        cues: slice.cues.map((cue) => ({
          cueId: cue.cueId,
          kind: cue.kind,
          actionIndex: cue.actionIndex,
          speechStartMs: startMs + cue.speechStartMs,
          speechEndMs: startMs + cue.speechEndMs,
          eventMs: startMs + cue.eventMs,
          errorMs: cue.errorMs,
        })),
      };

      offsetMs = endMs;

      return sceneManifest;
    });
    const manifest: ShowcaseFinalManifest = {
      version: SHOWCASE_MANIFEST_VERSION,
      projectId,
      inputHash,
      mode,
      totalMs: measuredTotalMs,
      video: {
        id: video.id,
        contentHash: video.contentHash,
        byteSize: video.byteSize,
        durationMs: probed.durationMs,
      },
      subtitles: captions
        ? {
          id: captions.id,
          contentHash: captions.contentHash,
          byteSize: captions.byteSize,
        }
        : null,
      scenes: manifestScenes,
      subtitleCues,
    };
    const publishedManifest = await publishFinalManifest({
      manifest,
      targetDir: names.finalsDir,
    });

    // Последняя проверка находится ВНУТРИ очереди project-store. Иначе правка
    // могла вклиниться между внешним read и callback и получить старый final.
    const saved = await store.updateProject(projectId, null, (current) => {
      if (finalInputHash(current, inputsOf(current)) !== inputHash) {
        throw new ShowcaseError(
          'assemble_inputs_changed',
          'Ролик изменился, пока шла сборка: результат не принят как актуальный.',
          409,
        );
      }

      return {
        ...current,
        latestFinal: {
          video,
          subtitles: captions,
          manifestId: publishedManifest.id,
          manifestVersion: SHOWCASE_MANIFEST_VERSION,
          builtAt: new Date().toISOString(),
          current: true,
        },
      };
    });

    await jobs.finish(jobId, { state: 'succeeded', label: 'ролик собран' });
    broadcast('showcase-changed', { projectId, revision: saved.revision });
  }

  return { assemble, runAssemble };
}

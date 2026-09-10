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

import {
  artifactFile,
  finalInputHash,
  publishArtifact,
  sceneFreshness,
} from './artifacts.ts';
import type { ArtifactInputs } from './artifacts.ts';
import { ShowcaseError } from './errors.ts';
import { PRODUCER_VERSIONS, RENDER_STYLE } from './formats.ts';
import { assertPlayable, buildSceneClip, concatScenes } from './render/assembler.ts';
import { probeDurationMs } from './render/clipCheck.ts';
import { buildSubtitles, planScene, renderSrt } from './render/timeline.ts';
import type { ShowcaseJob, ShowcaseProject } from '../../../../shared/showcaseContracts.ts';
import { toPublicJob } from './jobs.ts';
import type { ShowcaseJobs } from './jobs.ts';
import type { ShowcaseStore } from './store.ts';

export interface AssemblyOpsDeps {
  assertEnabled: () => void;
  broadcast: (event: string, data: unknown) => void;
  inputsOf: (project: ShowcaseProject) => ArtifactInputs;
  jobs: ShowcaseJobs;
  limits: () => { maxTotalSeconds: number };
  readProject: (id: string) => Promise<ShowcaseProject>;
  store: ShowcaseStore;
}

export function createAssemblyOps(deps: AssemblyOpsDeps) {
  const {
    assertEnabled, broadcast, inputsOf, jobs, readProject, store,
  } = deps;

  /**
   * Сборка ролика. Требует, чтобы у каждой сцены были свежие клип и звук: собирать
   * из наполовину устаревших частей значило бы выдать за готовый ролик смесь двух
   * редакций. Работа идёт в самом сервере — она локальная, конечная и не открывает
   * ни браузера, ни сети.
   */
  async function assemble(id: string): Promise<ShowcaseJob> {
    assertEnabled();

    const project = await readProject(id);
    const inputs = inputsOf(project);
    const ordered = [...project.scenes].sort((left, right) => left.order - right.order);

    if (ordered.length === 0) {
      throw new ShowcaseError('no_scenes', 'В ролике нет ни одной сцены.', 409);
    }

    for (const scene of ordered) {
      const fresh = sceneFreshness(scene, inputs);

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
    const slices = [];

    await fs.mkdir(workDir, { recursive: true, mode: 0o700 });

    let index = 0;

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
      const timing = planScene({
        audioMs: scene.audio!.durationMs ?? await probeDurationMs(audioFile),
        clipMs: scene.clip!.durationMs ?? await probeDurationMs(clipFile),
      });
      const outFile = path.join(workDir, `${scene.id}.mp4`);

      await buildSceneClip({
        rawVideo: clipFile,
        audio: audioFile,
        timing,
        outFile,
        style: RENDER_STYLE,
      });

      slices.push({
        scene,
        timing,
        // Длина берётся у ГОТОВОГО файла: кодек округляет её до кадра, и плановая
        // сумма разошлась бы с роликом, уводя субтитры к концу записи.
        measuredMs: await probeDurationMs(outFile),
        file: outFile,
      });
    }

    await jobs.progress(jobId, {
      sequence: jobs.read(jobId).sequence + 1,
      label: 'склеиваем ролик',
      index: ordered.length,
      total: ordered.length,
    });

    const subtitles = buildSubtitles(slices);
    const srtFile = path.join(workDir, 'subtitles.srt');
    const finalFile = path.join(workDir, 'final.mp4');

    await fs.writeFile(srtFile, renderSrt(subtitles.cues), 'utf8');
    await concatScenes({
      clips: slices.map((slice) => slice.file),
      workDir,
      outFile: finalFile,
      subtitles: srtFile,
      style: RENDER_STYLE,
    });

    const probed = await assertPlayable(finalFile, RENDER_STYLE);
    const inputHash = finalInputHash(project, inputs);
    const video = await publishArtifact({
      file: finalFile,
      kind: 'final',
      inputHash,
      producerVersion: PRODUCER_VERSIONS.assembler,
      durationMs: probed.durationMs,
      targetDir: names.finalsDir,
    });
    const captions = await publishArtifact({
      file: srtFile,
      kind: 'subtitles',
      inputHash,
      producerVersion: PRODUCER_VERSIONS.assembler,
      durationMs: null,
      targetDir: names.finalsDir,
    });

    // Публикация идёт последней и только если входы не изменились: ролик, собранный
    // из прошлой редакции, не должен встать на место актуального.
    const fresh = await readProject(projectId);

    if (finalInputHash(fresh, inputsOf(fresh)) !== inputHash) {
      await jobs.finish(jobId, {
        state: 'failed',
        error: 'Ролик изменился, пока шла сборка: результат не принят как актуальный.',
      });

      return;
    }

    const saved = await store.updateProject(projectId, null, (current) => ({
      ...current,
      latestFinal: {
        video,
        subtitles: captions,
        manifestId: inputHash,
        builtAt: new Date().toISOString(),
        current: true,
      },
    }));

    await jobs.finish(jobId, { state: 'succeeded', label: 'ролик собран' });
    broadcast('showcase-changed', { projectId, revision: saved.revision });
  }

  return { assemble, runAssemble };
}

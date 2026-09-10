// Озвучка сцен и голоса раздела.
//
// Синтезируются только сцены, чей звук не совпадает со своими входами и у кого
// источник — синтез: загруженную человеком запись переозвучивать нельзя, и обойти
// это «пересчётом всего ролика» тоже.
//
// Повтор ограничен: на одну редакцию текста приходится исходный синтез и не более
// одного повтора. Иначе неудачная фраза крутила бы движок по кругу — у облачного
// это ещё и деньги.
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { audioInputHash, publishArtifact, sceneFreshness } from './artifacts.ts';
import type { ArtifactInputs } from './artifacts.ts';
import { ShowcaseError } from './errors.ts';
import { toPublicJob } from './jobs.ts';
import type { ShowcaseJobs } from './jobs.ts';
import { replaceScene } from './scenes.ts';
import { canonicalTextOf } from './voice/contract.ts';
import type { VoiceInstaller } from './voice/install.ts';
import type { VoiceRegistry } from './voice/registry.ts';
import { checkSpeech } from './voice/speechCheck.ts';
import type { ShowcaseJob, ShowcaseProject } from '../../../../shared/showcaseContracts.ts';
import type { ShowcaseStore } from './store.ts';

export interface NarrationOpsDeps {
  assertEnabled: () => void;
  broadcast: (event: string, data: unknown) => void;
  inputsOf: (project: ShowcaseProject) => ArtifactInputs;
  jobs: ShowcaseJobs;
  readProject: (id: string) => Promise<ShowcaseProject>;
  store: ShowcaseStore;
  // Расшифровка приходит функцией: раздел пользуется общим речевым runtime
  // кокпита, но не знает, как тот устроен, и без него обязан работать — с
  // пометкой, что проверка речи пропущена.
  transcribe: ((file: string) => Promise<string>) | null;
  voiceInstaller: VoiceInstaller;
  voices: VoiceRegistry;
}

export function createNarrationOps(deps: NarrationOpsDeps) {
  const {
    assertEnabled, broadcast, inputsOf, jobs, readProject, store, voiceInstaller, voices,
  } = deps;

  /**
   * Озвучка сцен. Синтезируются только те, чей звук не совпадает со своими входами
   * и у кого источник — синтез: загруженную человеком запись переозвучивать нельзя,
   * и обходить это правило «пересчётом всего ролика» тоже.
   */
  async function synthesizeScenes(id: string): Promise<ShowcaseJob> {
    assertEnabled();

    const project = await readProject(id);
    const inputs = inputsOf(project);
    const pending = project.scenes
      .filter((scene) => scene.audioSource.kind === 'tts' && !sceneFreshness(scene, inputs).audio)
      .sort((left, right) => left.order - right.order);

    if (pending.length === 0) {
      throw new ShowcaseError('nothing_to_synthesize', 'Озвучивать нечего: звук сцен свежий.', 409);
    }

    const withoutText = pending.find((scene) => !canonicalTextOf(scene.narration));

    if (withoutText) {
      throw new ShowcaseError(
        'empty_narration',
        `У сцены «${withoutText.title}» нет текста для озвучки.`,
        409,
      );
    }

    // Готовность движка проверяется до заведения задания: узнать «синтезировать
    // нечем» из провалившейся работы хуже, чем сразу.
    for (const scene of pending) {
      if (!scene.audioSource.voiceRef) {
        await defaultVoiceRef();

        break;
      }
    }

    const inputHashes = Object.fromEntries(
      pending.map((scene) => [scene.id, audioInputHash(scene, inputs)]),
    );
    const { record, reused } = await jobs.enqueue({
      projectId: id,
      kind: 'voice',
      idempotencyKey: createHash('sha256')
        .update(`voice:${id}:${JSON.stringify(inputHashes)}`)
        .digest('hex')
        .slice(0, 32),
      inputHashes,
      inputRevision: project.revision,
    });

    if (reused) {
      return toPublicJob(record);
    }

    void runSynthesis(record.id, id).catch(async (error) => {
      await jobs.finish(record.id, {
        state: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    });

    return toPublicJob(record);
  }

  /**
   * Синтез и самопроверка. Повтор ограничен: на одну редакцию текста приходится
   * исходный синтез и не более одного повтора. Иначе неудачная фраза крутила бы
   * движок по кругу — у облачного это ещё и деньги.
   */
  async function runSynthesis(jobId: string, projectId: string): Promise<void> {
    const project = await readProject(projectId);
    const inputs = inputsOf(project);
    const names = store.namesOf(projectId);
    const workDir = path.join(store.jobsDir, jobId, 'work');
    const job = jobs.read(jobId);

    await fs.mkdir(workDir, { recursive: true, mode: 0o700 });

    let index = 0;

    for (const scene of project.scenes.sort((left, right) => left.order - right.order)) {
      const expected = job.inputHashes[scene.id];

      if (!expected) {
        continue;
      }

      index += 1;
      await jobs.progress(jobId, {
        sequence: jobs.read(jobId).sequence + 1,
        label: `озвучиваем сцену «${scene.title}»`,
        index,
        total: Object.keys(job.inputHashes).length,
      });

      const voiceRef = scene.audioSource.voiceRef ?? await defaultVoiceRef();
      const { engineId, voiceId } = voices.parseVoiceRef(voiceRef);
      const engine = voices.engineOf(engineId);
      const candidate = await engine.synthesize(
        {
          canonicalText: canonicalTextOf(scene.narration),
          direction: scene.direction,
          voiceRef: voiceId,
          language: 'ru',
        },
        {
          deadlineMs: 120_000,
          outputDir: workDir,
        },
      );
      const check = await checkSpeech({
        audioFile: candidate.temporaryFile,
        expectedText: scene.narration,
        transcribe: deps.transcribe,
      });
      const artifact = await publishArtifact({
        file: candidate.temporaryFile,
        kind: 'audio',
        inputHash: expected,
        producerVersion: engine.capabilities(voiceId).engineVersion,
        durationMs: check.durationMs,
        targetDir: path.join(names.scenesDir, scene.id, 'artifacts'),
      });

      // Публикуется только то, что всё ещё нужно: пока шёл синтез, текст могли
      // поправить, и тогда этот звук — уже не звук этой сцены.
      await store.updateProject(projectId, null, (current) => {
        const own = current.scenes.find((item) => item.id === scene.id);

        if (!own || audioInputHash(own, inputsOf(current)) !== expected) {
          return current;
        }

        return {
          ...current,
          scenes: replaceScene(current, {
            ...own,
            audio: artifact,
            audioSource: { ...own.audioSource, voiceRef },
            checks: [
              ...own.checks.filter((item) => item.kind !== 'speech' || item.inputHash !== expected),
              {
                id: `speech-${artifact.id}`,
                kind: 'speech' as const,
                status: check.status,
                inputHash: expected,
                artifactId: artifact.id,
                reason: [check.reason, check.loudnessWarning].filter(Boolean).join(' '),
                textRange: null,
                suggestions: check.missingWords.length > 0
                  ? [`Не слышно: ${check.missingWords.join(', ')}`]
                  : candidate.ignoredDirections.map((item) => `Движок не поддержал: ${item}`),
              },
            ],
          }),
        };
      });
    }

    await jobs.finish(jobId, { state: 'succeeded', label: 'озвучка готова' });
    broadcast('showcase-changed', { projectId, revision: (await readProject(projectId)).revision });
  }

  /**
   * Голос по умолчанию — первый ДОСТУПНЫЙ у готового движка. Имя выдумывать нельзя:
   * несуществующий голос дал бы отказ движка уже посреди задания, а причина была бы
   * непонятной. Нет готового движка — честный отказ до начала работы.
   */
  async function defaultVoiceRef(): Promise<string> {
    for (const status of await voices.statuses()) {
      if (status.doctor.status !== 'ready') {
        continue;
      }

      const voice = status.voices.find((item) => item.available);

      if (voice) {
        return `${status.id}:${voice.id}`;
      }
    }

    throw new ShowcaseError(
      'voice_unavailable',
      'Готового голосового движка нет: озвучьте сцены загрузкой готового звука.',
      503,
    );
  }

  async function voiceCatalog() {
    assertEnabled();

    return { engines: await voices.statuses(), install: await voiceInstaller.status() };
  }

  /**
   * Установка локального голоса. Раздел не выбирает голос за человека и не ставит
   * ничего сам при первом открытии: скачивание сотен мегабайт — его решение.
   */
  async function installVoice(voiceId: string) {
    assertEnabled();

    await voiceInstaller.start(voiceId);

    return voiceCatalog();
  }

  async function cancelVoiceInstall() {
    assertEnabled();

    await voiceInstaller.cancel();

    return voiceCatalog();
  }

  return {
    cancelVoiceInstall,
    defaultVoiceRef,
    installVoice,
    synthesizeScenes,
    voiceCatalog,
  };
}

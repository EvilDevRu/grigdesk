// Озвучка сцен и голоса раздела.
//
// Синтезируются только сцены, чей звук не совпадает со своими входами и у кого
// источник — синтез: загруженную человеком запись переозвучивать нельзя, и обойти
// это «пересчётом всего ролика» тоже.
//
// Повтор ограничен: на одну редакцию текста приходится исходный синтез и не более
// одного повтора. Иначе неудачная фраза крутила бы движок по кругу — у облачного
// это ещё и деньги.
//
// Движок работает сеансом на задание: процесс с моделью поднимается один раз на
// все сцены, а не на каждую, и сцены подряд с одним движком уходят в него батчем,
// если движок батч умеет. Проверка речи и публикация идут по одной сцене после
// того, как сеанс закрыт.
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { audioInputHash, publishArtifact, sceneFreshness } from './artifacts.ts';
import type { ArtifactInputs } from './artifacts.ts';
import { ShowcaseError } from './errors.ts';
import { toPublicJob } from './jobs.ts';
import type { ShowcaseJobs } from './jobs.ts';
import { replaceScene, syncTextHash } from './scenes.ts';
import {
  publishSpeechAlignment,
  publishSpeechTiming,
  speechAlignmentInputHash,
  speechTimingFromTranscript,
  speechTimingInputHash,
} from './syncStore.ts';
import type { PublishableSpeechTiming } from './syncStore.ts';
import { alignSpeechTiming } from './voice/alignment.ts';
import { canonicalTextOf, openVoiceSession, unreadableFragments } from './voice/contract.ts';
import type {
  SynthesisInput,
  UnreadableKind,
  VoiceBatchLimit,
  VoiceCandidate,
  VoiceDirection,
  VoiceEngine,
  VoicePace,
  VoiceSession,
} from './voice/contract.ts';
import type { StressDictionaryStore } from './voice/dictionary.ts';
import type { VoiceInstaller } from './voice/install.ts';
import {
  alignmentToSource,
  createPronunciationOverrides,
  mergeStresses,
  prepareVoiceText,
} from './voice/preparation.ts';
import type {
  PreparedVoiceText,
  PronunciationOverrideInput,
} from './voice/preparation.ts';
import type { VoiceRegistry } from './voice/registry.ts';
import { checkSpeech } from './voice/speechCheck.ts';
import type { ShowcaseJob, ShowcaseProject } from '../../../../shared/showcaseContracts.ts';
import { SHOWCASE_NARRATION_MAX_CHARS } from '../../../../shared/showcaseNarration.ts';
import type { ShowcaseStore } from './store.ts';
import type { SpeechTranscript } from '../speech/transport.ts';

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
  transcribe: ((file: string) => Promise<string | SpeechTranscript>) | null;
  voiceInstaller: VoiceInstaller;
  voices: VoiceRegistry;
  // Образцы голосов лежат отдельно от роликов: они общие для всех и не стареют
  // вместе со сценами.
  previewDir: string;
  // Словарь ударений установки: его записи ложатся на слова без явного знака.
  // Без словаря озвучка обязана работать — тогда ударения только из текста.
  stressDictionary?: Pick<StressDictionaryStore, 'entries'>;
  withFreshness: (project: ShowcaseProject) => ShowcaseProject;
}

// Фраза образца. Она про сам раздел, а не про рабочую задачу: рабочий текст в
// общий кэш образцов попадать не должен.
const PREVIEW_PHRASE = 'Так будет звучать голос ролика: фильтр включается одним нажатием, '
  + 'а результат виден сразу на экране.';

const EMPTY_DIRECTION: ShowcaseProject['scenes'][number]['direction'] = {
  tone: null,
  pace: null,
  emphasis: [],
  pauses: [],
  stresses: [],
};

export interface VoiceChoice {
  voiceRef: string | null;
  pace: VoicePace | null;
}

export interface NarrationPreviewInput {
  voiceRef: string;
  narration: string;
  direction: VoiceDirection;
  pronunciationOverrides: PronunciationOverrideInput[];
  signal?: AbortSignal;
}

// Сцена задания с разобранным голосом и входом синтеза: считается один раз до
// начала работы, чтобы батч собирался из готовых реплик.
interface PendingScene {
  scene: ShowcaseProject['scenes'][number];
  expected: string;
  voiceRef: string;
  engineId: string;
  prepared: PreparedVoiceText;
  input: SynthesisInput;
}

// Срок одной реплики; у батча — сумма сроков его реплик.
const SCENE_DEADLINE_MS = 120_000;

/**
 * Батч с позиции `from`: сцены подряд с тем же движком, не больше предела по
 * числу и по сумме знаков. Первая сцена входит всегда — иначе длинная реплика не
 * попала бы ни в один батч. Без предела батч — одна сцена.
 */
export function takeBatch<T extends { engineId: string; input: { canonicalText: string } }>(
  pending: readonly T[],
  from: number,
  limit: VoiceBatchLimit | null,
): T[] {
  const first = pending[from];

  if (!first || !limit) {
    return first ? [first] : [];
  }

  const batch = [first];

  let chars = first.input.canonicalText.length;

  for (const next of pending.slice(from + 1)) {
    const grown = chars + next.input.canonicalText.length;

    if (
      next.engineId !== first.engineId
      || batch.length >= limit.items
      || grown > limit.chars
    ) {
      break;
    }

    batch.push(next);
    chars = grown;
  }

  return batch;
}

// Подпись хода: одна сцена — по имени, батч — от первой до последней.
function batchLabel(batch: readonly PendingScene[]): string {
  const titles = batch.map((item) => `«${item.scene.title}»`);

  return titles.length === 1
    ? `озвучиваем сцену ${titles[0]}`
    : `озвучиваем сцены с ${titles[0]} по ${titles.at(-1)}`;
}

const UNREADABLE_WORDS: Record<UnreadableKind, string> = {
  latin: 'латиница',
  digits: 'цифры',
};

// Старый публичный импорт тестов и адаптеров сохраняется; реализация теперь живёт
// рядом с единым preparer, чтобы preview и полная озвучка не разошлись.
export { mergeStresses };

export function createNarrationOps(deps: NarrationOpsDeps) {
  const {
    assertEnabled, broadcast, inputsOf, jobs, readProject, store, voiceInstaller, voices,
  } = deps;

  /**
   * Текст и указания сцены для движка: канонический текст без знаков и ударения из
   * текста, словаря и структуры. Считается в одном месте, потому что тот же набор
   * входит в хеш звука — расхождение означало бы «свежий» звук с другими ударениями.
   */
  function synthesisInputOf(
    scene: ShowcaseProject['scenes'][number],
    voiceRef: string,
  ): PreparedVoiceText {
    return prepareVoiceText({
      scene,
      voiceRef,
      stressDictionary: deps.stressDictionary?.entries() ?? [],
    });
  }

  /**
   * Сцена с КОНКРЕТНЫМ голосом для хеша звука. Голос по умолчанию записывается в
   * сцену вместе со звуком, поэтому хеш, посчитанный без него, разошёлся бы с
   * сохранённым сразу после первой озвучки — и следующая сборка переозвучила бы
   * сцену второй раз ни за что.
   */
  function withVoice(
    scene: ShowcaseProject['scenes'][number],
    voiceRef: string | null,
  ): ShowcaseProject['scenes'][number] {
    if (scene.audioSource.voiceRef || !voiceRef) {
      return scene;
    }

    return { ...scene, audioSource: { ...scene.audioSource, voiceRef } };
  }

  /**
   * Отказ до задания: движок не прочитает латиницу или цифры, и узнать об этом из
   * молча выпавшего слова хуже, чем сразу. Сцена и обрывки названы, чтобы человек
   * знал, ЧТО переписать словами.
   */
  function assertReadable(
    scene: Pick<ShowcaseProject['scenes'][number], 'title'>,
    engine: VoiceEngine,
    voiceId: string,
    spokenText: string,
  ): void {
    const unreadable = engine.capabilities(voiceId).unreadable;
    const fragments = unreadableFragments(spokenText, unreadable);

    if (fragments.length === 0) {
      return;
    }

    const kinds = (unreadable ?? []).filter(
      (kind) => unreadableFragments(spokenText, [kind]).length > 0,
    );
    const what = kinds.map((kind) => UNREADABLE_WORDS[kind]).join(' и ');

    throw new ShowcaseError(
      'unreadable_text',
      `У сцены «${scene.title}» в тексте ${what} (${fragments.join(', ')}): `
        + `${engine.name} этого не прочитает — напишите словами.`,
      409,
    );
  }

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

    // Готовность движка и читаемость текста проверяются до заведения задания:
    // узнать «синтезировать нечем» или «слово выпало» из провалившейся работы
    // хуже, чем сразу. Голос по умолчанию спрашивается один раз на все сцены.
    let fallbackRef: string | null = null;

    for (const scene of pending) {
      if (!scene.audioSource.voiceRef && !fallbackRef) {
        fallbackRef = await defaultVoiceRef();
      }

      const { engineId, voiceId } = voices.parseVoiceRef(
        scene.audioSource.voiceRef ?? (fallbackRef as string),
      );
      const voiceRef = scene.audioSource.voiceRef ?? (fallbackRef as string);
      const prepared = synthesisInputOf(scene, voiceRef);

      assertReadable(scene, voices.engineOf(engineId), voiceId, prepared.spokenText);
    }

    const inputHashes = Object.fromEntries(
      pending.map((scene) => [scene.id, audioInputHash(withVoice(scene, fallbackRef), inputs)]),
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

    void runSynthesis(record.id, id, fallbackRef).catch(async (error) => {
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
   *
   * Сначала синтез всех сцен сеансом движка, потом проверка и публикация по
   * одной. Сеанс закрывается до проверки — и после отказа тоже, иначе процесс с
   * моделью пережил бы задание.
   */
  async function runSynthesis(
    jobId: string,
    projectId: string,
    fallbackRef: string | null,
  ): Promise<void> {
    const project = await readProject(projectId);
    const names = store.namesOf(projectId);
    const workDir = path.join(store.jobsDir, jobId, 'work');
    const job = jobs.read(jobId);

    await fs.mkdir(workDir, { recursive: true, mode: 0o700 });

    const pending: PendingScene[] = [];

    for (const scene of project.scenes.sort((left, right) => left.order - right.order)) {
      const expected = job.inputHashes[scene.id];

      if (!expected) {
        continue;
      }

      // Голос по умолчанию — тот же, что вошёл в хеш при постановке задания.
      const voiceRef = scene.audioSource.voiceRef ?? fallbackRef ?? await defaultVoiceRef();
      const { engineId, voiceId } = voices.parseVoiceRef(voiceRef);
      const prepared = synthesisInputOf(scene, voiceRef);

      pending.push({
        scene,
        expected,
        voiceRef,
        engineId,
        prepared,
        input: {
          canonicalText: prepared.spokenText,
          direction: prepared.direction,
          voiceRef: voiceId,
          language: 'ru',
        },
      });
    }

    const sessions = new Map<string, VoiceSession>();

    async function sessionOf(engineId: string): Promise<VoiceSession> {
      const own = sessions.get(engineId);

      if (own) {
        return own;
      }

      const opened = await openVoiceSession(voices.engineOf(engineId));

      sessions.set(engineId, opened);

      return opened;
    }

    const produced: { item: PendingScene; candidate: VoiceCandidate }[] = [];

    let failure: unknown = null;

    try {
      while (produced.length < pending.length) {
        const head = pending[produced.length];

        if (!head) {
          break;
        }

        const session = await sessionOf(head.engineId);
        const batch = takeBatch(pending, produced.length, session.batch);

        await jobs.progress(jobId, {
          sequence: jobs.read(jobId).sequence + 1,
          label: batchLabel(batch),
          index: produced.length + 1,
          total: pending.length,
        });

        const candidates = await session.synthesize(
          batch.map((item) => item.input),
          { deadlineMs: SCENE_DEADLINE_MS, outputDir: workDir },
        );

        for (const [position, item] of batch.entries()) {
          const candidate = candidates[position];

          if (!candidate) {
            throw new ShowcaseError('voice_failed', 'Движок вернул меньше реплик, чем получил.', 500);
          }

          produced.push({ item, candidate });
        }
      }
    } catch (error) {
      failure = error;
    } finally {
      await Promise.all([...sessions.values()].map((session) => session.close()));
    }

    // Проверка речи идёт ПОСЛЕ закрытия сеансов: Whisper делит видеокарту с
    // моделью синтеза, и рядом с живым процессом Qwen ему не хватило бы памяти.
    // Уже синтезированное публикуется и после отказа — озвученные сцены годны.
    for (const [index, { item, candidate }] of produced.entries()) {
      await jobs.progress(jobId, {
        sequence: jobs.read(jobId).sequence + 1,
        label: `проверяем сцену «${item.scene.title}»`,
        index: index + 1,
        total: pending.length,
      });
      await publishScene(projectId, names.scenesDir, item, candidate);
    }

    if (failure) {
      throw failure;
    }

    await jobs.finish(jobId, { state: 'succeeded', label: 'озвучка готова' });
    broadcast('showcase-changed', { projectId, revision: (await readProject(projectId)).revision });
  }

  /**
   * Проверка речи и публикация звука одной сцены. Публикуется только то, что всё
   * ещё нужно: пока шёл синтез, текст могли поправить, и тогда этот звук — уже не
   * звук этой сцены.
   */
  async function publishScene(
    projectId: string,
    scenesDir: string,
    item: PendingScene,
    candidate: VoiceCandidate,
  ): Promise<void> {
    const { scene, expected, voiceRef } = item;
    const { engineId, voiceId } = voices.parseVoiceRef(voiceRef);
    const engine = voices.engineOf(engineId);
    const capabilities = engine.capabilities(voiceId);
    // Проверке речи — реально отправленная движку строка без служебных знаков.
    // Диапазоны результата затем возвращаются к экранному тексту явной картой.
    const check = await checkSpeech({
      audioFile: candidate.temporaryFile,
      expectedText: item.input.canonicalText,
      transcribe: deps.transcribe,
    });
    const targetDir = path.join(scenesDir, scene.id, 'artifacts');
    const artifact = await publishArtifact({
      file: candidate.temporaryFile,
      kind: 'audio',
      inputHash: expected,
      producerVersion: capabilities.engineVersion,
      durationMs: check.durationMs,
      targetDir,
    });
    let measuredTiming: PublishableSpeechTiming | null | undefined = candidate.speechTiming;
    let speechTiming = await publishSpeechTiming({
      timing: measuredTiming,
      sceneInputHash: expected,
      audioContentHash: artifact.contentHash,
      producerVersion: capabilities.modelRevision
        ? `${capabilities.engineVersion}:${capabilities.modelRevision}`
        : capabilities.engineVersion,
      durationMs: check.durationMs,
      targetDir,
    });

    // Локальные движки и старые адаптеры не дают provider metadata. Используем
    // уже выполненную самопроверку — второй ASR для той же дорожки запрещён.
    if (!speechTiming) {
      const recognizedTiming = speechTimingFromTranscript(check.transcript);

      measuredTiming = recognizedTiming;
      speechTiming = await publishSpeechTiming({
        timing: recognizedTiming,
        sceneInputHash: expected,
        audioContentHash: artifact.contentHash,
        producerVersion: recognizedTiming
          ? `whisper:${String(check.transcript?.model ?? 'unknown')}`
          : capabilities.engineVersion,
        durationMs: check.durationMs,
        targetDir,
      });
    }

    const textHash = syncTextHash(item.prepared.sourceText);
    const speechAlignment = speechTiming && measuredTiming
      ? await publishSpeechAlignment({
        alignment: alignmentToSource(
          alignSpeechTiming({
            canonicalText: item.prepared.spokenText,
            durationMs: check.durationMs,
            timing: measuredTiming,
          }),
          item.prepared,
        ),
        canonicalText: item.prepared.sourceText,
        textHash,
        audioContentHash: artifact.contentHash,
        speechTimingContentHash: speechTiming.contentHash,
        targetDir,
      })
      : null;

    await store.updateProject(projectId, null, (current) => {
      const own = current.scenes.find((entry) => entry.id === scene.id);
      const timingMatchesAudio = speechTiming === null
        || speechTiming.inputHash === speechTimingInputHash(expected, artifact.contentHash);
      const alignmentMatchesTiming = speechAlignment === null
        || speechTiming !== null
          && speechAlignment.inputHash === speechAlignmentInputHash(
            textHash,
            artifact.contentHash,
            speechTiming.contentHash,
          );

      if (
        !own
        || artifact.inputHash !== expected
        || !timingMatchesAudio
        || !alignmentMatchesTiming
        || audioInputHash(withVoice(own, voiceRef), inputsOf(current)) !== expected
      ) {
        return current;
      }

      return {
        ...current,
        scenes: replaceScene(current, {
          ...own,
          audio: artifact,
          // Новая озвучка всегда заменяет пару WAV+timing. Если движок не дал
          // валидных меток, прежняя ссылка не остаётся рядом с новым звуком.
          speechTiming,
          speechAlignment,
          audioSource: { ...own.audioSource, voiceRef },
          checks: [
            ...own.checks.filter((entry) => entry.kind !== 'speech' || entry.inputHash !== expected),
            {
              id: `speech-${artifact.id}`,
              kind: 'speech' as const,
              status: check.status,
              inputHash: expected,
              artifactId: artifact.id,
              reason: [check.reason, check.loudnessWarning].filter(Boolean).join(' '),
              textRange: null,
              suggestions: [
                ...(check.missingWords.length > 0
                  ? [`Не слышно: ${check.missingWords.join(', ')}`]
                  : []),
                ...candidate.ignoredDirections
                  .map((entry) => `Движок не поддержал: ${entry}`),
              ],
            },
          ],
        }),
      };
    });
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
   * Образец голоса: одна и та же фраза каждым голосом, синтезированная один раз.
   * Кэш привязан к версии движка — обновлённый движок звучит иначе, и старый
   * образец обманывал бы слух.
   */
  async function previewVoice(voiceRef: string): Promise<string> {
    assertEnabled();

    const { engineId, voiceId } = voices.parseVoiceRef(voiceRef);
    const engine = voices.engineOf(engineId);
    const version = engine.capabilities(voiceId).engineVersion;
    const name = `${engineId}-${voiceId}-${version}.wav`.replace(/[^\w.-]/g, '_');
    const file = path.join(deps.previewDir, name);

    if (await fs.stat(file).then(() => true, () => false)) {
      return file;
    }

    const candidate = await engine.synthesize(
      {
        canonicalText: PREVIEW_PHRASE,
        direction: EMPTY_DIRECTION,
        voiceRef: voiceId,
        language: 'ru',
      },
      {
        deadlineMs: 180_000,
        outputDir: deps.previewDir,
      },
    );

    await fs.rename(candidate.temporaryFile, file);

    return file;
  }

  /**
   * Предпрослушивание своей реплики. Текст не попадает в URL или имя файла:
   * кэш подписан полным подготовленным входом, тем же, что получит full job.
   */
  async function previewNarration(input: NarrationPreviewInput): Promise<string> {
    assertEnabled();

    if (input.signal?.aborted) {
      throw new ShowcaseError('voice_failed', 'Предпрослушивание отменено.', 499);
    }

    const { engineId, voiceId } = voices.parseVoiceRef(input.voiceRef);
    const engine = voices.engineOf(engineId);
    const pronunciationOverrides = createPronunciationOverrides(
      input.narration,
      input.pronunciationOverrides,
    );
    const prepared = prepareVoiceText({
      scene: {
        narration: input.narration,
        direction: input.direction,
        pronunciationOverrides,
      },
      voiceRef: input.voiceRef,
      stressDictionary: deps.stressDictionary?.entries() ?? [],
    });
    const capabilities = engine.capabilities(voiceId);

    if (!prepared.spokenText) {
      throw new ShowcaseError('empty_narration', 'Введите текст для предпрослушивания.', 400);
    }

    const maxChars = Math.min(capabilities.maxChars, SHOWCASE_NARRATION_MAX_CHARS);

    if (prepared.spokenText.length > maxChars) {
      throw new ShowcaseError(
        'text_too_long',
        `Реплика длиннее предела предпрослушивания: ${prepared.spokenText.length} из `
          + `${maxChars}.`,
        413,
      );
    }

    assertReadable(
      { title: 'Предпрослушивание' },
      engine,
      voiceId,
      prepared.spokenText,
    );

    const cacheKey = createHash('sha256').update(JSON.stringify({
      engineId,
      voiceId,
      engineVersion: capabilities.engineVersion,
      modelRevision: capabilities.modelRevision,
      spokenText: prepared.spokenText,
      direction: prepared.direction,
      pronunciationOverrides: prepared.overrides,
    })).digest('hex').slice(0, 32);
    const file = path.join(deps.previewDir, `narration-${cacheKey}.wav`);

    if (await fs.stat(file).then(() => true, () => false)) {
      return file;
    }

    await fs.mkdir(deps.previewDir, { recursive: true, mode: 0o700 });

    let candidate: VoiceCandidate | null = null;

    try {
      candidate = await engine.synthesize(
        {
          canonicalText: prepared.spokenText,
          direction: prepared.direction,
          voiceRef: voiceId,
          language: 'ru',
        },
        {
          signal: input.signal,
          deadlineMs: SCENE_DEADLINE_MS,
          outputDir: deps.previewDir,
        },
      );

      if (input.signal?.aborted) {
        throw new ShowcaseError('voice_failed', 'Предпрослушивание отменено.', 499);
      }

      await fs.rename(candidate.temporaryFile, file);

      return file;
    } catch (error) {
      if (candidate?.temporaryFile && candidate.temporaryFile !== file) {
        await fs.rm(candidate.temporaryFile, { force: true }).catch(() => null);
      }

      throw error;
    }
  }

  /**
   * Голос и темп ролика целиком. Меняются все синтезируемые сцены разом: ролик,
   * где сцены говорят разными голосами, читается как ошибка, а не как выбор.
   * Загруженные записи не трогаются. Свежесть звука после смены считается
   * заново хешами — переозвучка придёт со следующей сборкой.
   */
  async function setVoice(
    id: string,
    expectedRevision: number,
    choice: VoiceChoice,
  ): Promise<ShowcaseProject> {
    assertEnabled();

    if (choice.voiceRef) {
      const { engineId, voiceId } = voices.parseVoiceRef(choice.voiceRef);
      const known = await voices.engineOf(engineId).voices();
      const voice = known.find((item) => item.id === voiceId);

      if (!voice?.available) {
        throw new ShowcaseError(
          'voice_unavailable',
          voice?.reason || `Голос «${choice.voiceRef}» сейчас недоступен.`,
          409,
        );
      }
    }

    const saved = await store.updateProject(id, expectedRevision, (current) => ({
      ...current,
      scenes: current.scenes.map((scene) => ({
        ...scene,
        direction: { ...scene.direction, pace: choice.pace },
        audioSource: scene.audioSource.kind === 'tts'
          ? { ...scene.audioSource, voiceRef: choice.voiceRef }
          : scene.audioSource,
      })),
    }));

    broadcast('showcase-changed', { projectId: id, revision: saved.revision });

    return deps.withFreshness(saved);
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
    previewNarration,
    previewVoice,
    setVoice,
    synthesizeScenes,
    voiceCatalog,
  };
}

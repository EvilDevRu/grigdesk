// Служба раздела «Презентации»: жизненный цикл ролика, готовность операций и
// связь хранилища с журналом заданий.
//
// Служба — единственное место, где решается, можно ли начинать работу: цель
// перепроверяется перед каждым заданием, а решения человека привязаны к хешу
// того входа, на который они выданы. Изменился вход — решение недействительно,
// и подтверждать заново придётся именно его, а не «весь ролик целиком».
//
// Сами операции живут отдельными модулями рядом: сцены, запись, сборка, озвучка,
// сценарий, демо-данные и доставка. Здесь остаётся то, что общее для всех, —
// проекты, свежесть, опрос исполнителей и включение раздела.
import { createHash } from 'node:crypto';
import path from 'node:path';

import type {
  ShowcaseDoctor,
  ShowcaseJob,
  ShowcaseOverview,
  ShowcaseProject,
  ShowcaseProjectSummary,
  ShowcaseTarget,
  ShowcaseTargetRef,
} from '../../../../shared/showcaseContracts.ts';
import { SHOWCASE_SCHEMA_VERSION, toProjectSummary } from '../../../../shared/showcaseContracts.ts';
import { artifactFile, finalIsCurrent, sceneFreshness } from './artifacts.ts';
import type { ArtifactInputs } from './artifacts.ts';
import { notFound, ShowcaseError } from './errors.ts';
import { readProgressSince, readWorkerResult, stopWorker } from './render/runner.ts';
import type { WorkerHandle } from './render/runner.ts';
import type { DeliveryRecord } from './delivery.ts';
import type { DeliveryChannelDeps } from './deliveryChannels.ts';
import { createVoiceRegistry } from './voice/registry.ts';
import { createPiperEngine } from './voice/piper.ts';
import { createRhvoiceEngine } from './voice/rhvoice.ts';
import { createVoiceInstaller, voiceRuntimePaths } from './voice/install.ts';
import { createShowcaseJobs, toPublicJob } from './jobs.ts';
import { createShowcaseLoginStore } from './loginStore.ts';
import { createShowcaseStore, newShowcaseId } from './store.ts';
import { createShowcaseTargets } from './targets.ts';
import { createDoctorReport } from './doctorReport.ts';
import { extensionOf, PRODUCER_VERSIONS, RENDER_STYLE } from './formats.ts';
import { createAssemblyOps } from './assemblyOps.ts';
import { createDeliveryOps } from './deliveryOps.ts';
import { createNarrationOps } from './narrationOps.ts';
import { createRecordingOps } from './recordingOps.ts';
import { createSceneOps } from './sceneOps.ts';
import { createScriptOps } from './scriptOps.ts';
import { createSeedOps } from './seedOps.ts';

export interface ShowcaseLimits {
  maxScenes: number;
  maxSceneSeconds: number;
  maxTotalSeconds: number;
  retentionDays: number;
  maxQueued: number;
  jobTimeoutMs: number;
}

export interface ShowcaseServiceOptions {
  showcaseDir: string;
  authDir: string;
  profilesDir: string;
  stateDir: string;
  browserPath: string | null;
  // Каталог локального синтеза: отдельное python-окружение и скачанные голоса.
  // Он вынесен из showcaseDir настройкой, потому что весит сотни мегабайт и его
  // разумно держать там же, где остальные тяжёлые рантаймы установки.
  voiceDir?: string;
  bootstrapPython?: string;
  listProjects: () => Promise<string[]>;
  // Расшифровка приходит функцией: раздел пользуется общим речевым runtime кокпита,
  // но не знает, как тот устроен, и без него обязан работать — с пометкой, что
  // проверка речи пропущена.
  transcribe?: ((file: string) => Promise<string>) | null;
  // Модель для брифа и сценария приходит резолвером: раздел не знает, как устроен
  // выбор исполнителя, но обязан получить именно безопасный model-only режим.
  resolveScriptModel?: ((options: {
    modelRef: unknown;
    config: Record<string, unknown>;
    requireImages: false;
    log: { warn?: (data: unknown, message: string) => unknown };
  }) => Promise<unknown>) | null;
  scriptModelRef?: () => unknown;
  // Каналы доставки приходят снаружи: сессией портала и аккаунтом Telegram владеет
  // сервер, и раздел не заводит вторых.
  deliveryDeps?: DeliveryChannelDeps;
  broadcast: (event: string, data: unknown) => void;
  limits: () => ShowcaseLimits;
}

const DEFAULT_TITLE = 'Новый ролик';

/**
 * Состояние ролика для списка. Считается на сервере из фактов записи: список и
 * карточка не должны расходиться в оценке готовности, а у списка нет входов,
 * чтобы судить самостоятельно.
 */
function stateOf(project: ShowcaseProject, jobs: ShowcaseJob[]): ShowcaseProjectSummary['state'] {
  if (jobs.some((job) => job.state === 'running' || job.state === 'queued')) {
    return 'building';
  }

  if (project.target.status === 'blocked') {
    return 'blocked';
  }

  if (project.latestFinal?.current) {
    return 'done';
  }

  return project.scenes.length > 0 ? 'ready' : 'draft';
}

export function createShowcaseService(options: ShowcaseServiceOptions) {
  const store = createShowcaseStore({ showcaseDir: options.showcaseDir });
  const loginStore = createShowcaseLoginStore({ authDir: options.authDir });
  const jobs = createShowcaseJobs({
    jobsDir: store.jobsDir,
    broadcast: options.broadcast,
    limits: () => {
      const limits = options.limits();

      return { maxQueued: limits.maxQueued, jobTimeoutMs: limits.jobTimeoutMs };
    },
  });

  // Ревизия данных — отметка человека «данные обновлены». Внешнюю правку базы
  // плагин обнаружить не обещает, поэтому версия хранится рядом с роликами и
  // меняется только явным действием.
  const dataRevisions = new Map<string, string>();

  const targets = createShowcaseTargets({
    profilesDir: options.profilesDir,
    stateDir: options.stateDir,
    listProjects: options.listProjects,
    dataRevisionOf: async (ref) => dataRevisions.get(`${ref.kind}:${ref.id}`) ?? 'начальные',
  });

  const voiceDir = options.voiceDir || path.join(options.showcaseDir, 'voice');
  const voiceInstaller = createVoiceInstaller({
    voiceDir,
    bootstrapPython: options.bootstrapPython,
    broadcast: options.broadcast,
  });

  // Два локальных движка: системный RHVoice для установок, где пакет уже есть,
  // и Piper, который раздел ставит сам. Порядок задаёт и выбор по умолчанию —
  // первый ГОТОВЫЙ движок, а не первый в списке.
  const voices = createVoiceRegistry([
    createPiperEngine(voiceRuntimePaths(voiceDir)),
    createRhvoiceEngine(),
  ]);

  // Журнал доставок по ролику. Хранится отдельно от тяжёлых артефактов: он отвечает
  // на вопрос «что и куда ушло», и уборка файлов его не касается.
  const deliveries = new Map<string, DeliveryRecord[]>();

  // Снимки запущенных исполнителей: по ним читаются журнал попытки и её итог.
  // Переживать перезапуск им незачем — после него журнал сверяется заново.
  const attempts = new Map<string, WorkerHandle>();

  let enabled = true;

  function assertEnabled(): void {
    if (!enabled) {
      throw new ShowcaseError('plugin_disabled', 'Раздел «Презентации» выключен.', 403);
    }
  }

  /**
   * Цель перепроверяется при каждом чтении ролика, а не берётся из сохранённого
   * снимка: стенд мог исчезнуть, слот — достаться другой задаче, а объявление
   * профиля — измениться. Ролик хранит выбор человека, а не вывод о доступности.
   */
  async function resolveTarget(ref: ShowcaseTargetRef, profile: string): Promise<ShowcaseTarget> {
    try {
      return await targets.resolve(ref, profile);
    } catch (error) {
      if (error instanceof ShowcaseError) {
        return {
          status: 'blocked',
          ref,
          reason: error.message,
          nextAction: {
            kind: 'configure-profile',
            label: 'Проверить объявление профиля',
            hint: 'Раздел не запускает браузер, пока контракт профиля не читается.',
          },
        };
      }

      throw error;
    }
  }

  async function readProject(id: string): Promise<ShowcaseProject> {
    const stored = await store.readProject(id);
    const profile = stored.target.status === 'ready' ? stored.target.scope.profile : '';

    return withFreshness({ ...stored, target: await resolveTarget(stored.ref, profile) });
  }

  /**
   * Профили, пригодные для показа. Годность решает объявление профиля: без
   * target.json и screens.json браузер запускать не по чему, и форма создания
   * обязана сказать это до выбора, а не после.
   */
  async function listTargetProfiles(): Promise<ShowcaseOverview['profiles']> {
    const names = await options.listProjects();
    const profiles: ShowcaseOverview['profiles'] = [];

    for (const id of names) {
      try {
        const target = await targets.readContract(id, 'target.json', (value) => value);
        const screens = await targets.readContract(id, 'screens.json', (value) => value);

        profiles.push({
          id,
          ready: target !== null && screens !== null,
          reason: target === null
            ? 'Профиль не объявил контракт презентаций.'
            : (screens === null ? 'Профиль не объявил карту экранов.' : ''),
        });
      } catch (error) {
        profiles.push({
          id,
          ready: false,
          reason: error instanceof ShowcaseError ? error.message : 'Объявление профиля не читается.',
        });
      }
    }

    return profiles;
  }

  async function overview(): Promise<ShowcaseOverview> {
    assertEnabled();

    const { projects } = await store.listProjects();
    const limits = options.limits();
    const summaries: ShowcaseProjectSummary[] = [];

    for (const stored of projects) {
      const own = jobs.list(stored.id).map(toPublicJob);
      const profile = stored.target.status === 'ready' ? stored.target.scope.profile : '';
      const project = { ...stored, target: await resolveTarget(stored.ref, profile) };

      summaries.push(toProjectSummary(project, stateOf(project, own)));
    }

    return {
      profiles: await listTargetProfiles(),
      projects: summaries,
      jobs: jobs.list().slice(0, 50).map(toPublicJob),
      limits: {
        maxScenes: limits.maxScenes,
        maxSceneSeconds: limits.maxSceneSeconds,
        maxTotalSeconds: limits.maxTotalSeconds,
        retentionDays: limits.retentionDays,
      },
    };
  }

  /**
   * Новый ролик. Цель резолвится сразу и сохраняется вместе с записью: человек
   * должен видеть причину отказа в карточке, а не получать пустой ролик, который
   * необъяснимо ничего не умеет.
   */
  async function createProject(input: {
    ref: ShowcaseTargetRef;
    profile: string;
    title?: string;
  }): Promise<ShowcaseProject> {
    assertEnabled();
    await store.ensureDirs();

    const now = new Date().toISOString();
    const project: ShowcaseProject = {
      schemaVersion: SHOWCASE_SCHEMA_VERSION,
      id: newShowcaseId(),
      title: (input.title ?? '').trim() || DEFAULT_TITLE,
      revision: 1,
      ref: input.ref,
      target: await resolveTarget(input.ref, input.profile),
      brief: [],
      scenes: [],
      decisions: [],
      latestFinal: null,
      createdAt: now,
      updatedAt: now,
    };

    await store.createProject(project);
    options.broadcast('showcase-changed', { projectId: project.id, revision: project.revision });

    return project;
  }

  async function renameProject(
    id: string,
    expectedRevision: number,
    title: string,
  ): Promise<ShowcaseProject> {
    assertEnabled();

    const saved = await store.updateProject(id, expectedRevision, (project) => ({
      ...project,
      title: title.trim() || project.title,
    }));

    options.broadcast('showcase-changed', { projectId: id, revision: saved.revision });

    return saved;
  }

  /**
   * Отметка «данные обновлены». Она меняет ревизию данных цели, а значит делает
   * устаревшими кадры и клипы: показать свежий продукт старой записью нельзя.
   */
  async function markDataUpdated(ref: ShowcaseTargetRef): Promise<string> {
    assertEnabled();

    const revision = createHash('sha256')
      .update(`${ref.kind}:${ref.id}:${Date.now()}`)
      .digest('hex')
      .slice(0, 12);

    dataRevisions.set(`${ref.kind}:${ref.id}`, revision);

    return revision;
  }

  async function deleteProject(id: string): Promise<void> {
    assertEnabled();

    const project = await store.readProject(id).catch(() => null);

    if (!project) {
      throw notFound('Ролик не найден.');
    }

    // Сначала снимаются задания: удалять файлы, на которые ещё смотрит идущая
    // работа, — верный способ получить наполовину записанный ролик без владельца.
    for (const job of jobs.list(id)) {
      await jobs.cancel(job.id).catch(() => null);
    }

    await jobs.removeForProject(id);
    await store.removeProject(id);
    options.broadcast('showcase-changed', { projectId: id, revision: 0 });
  }

  /**
   * Отмена задания. Если у него есть отсоединённый исполнитель, сигнал уходит
   * всему его дереву: браузер переживает смерть родителя и держал бы цель занятой.
   * Завершённым задание станет, только когда исполнитель это подтвердит.
   */
  async function cancelJob(id: string): Promise<ShowcaseJob> {
    assertEnabled();

    const record = await jobs.cancel(id);
    const handle = attempts.get(id);

    if (handle) {
      stopWorker(handle.identity);
    }

    return toPublicJob(record);
  }

  /**
   * Готовность по операциям. Отсутствие одной возможности не закрывает раздел:
   * без голосового движка остаётся импорт звука, без браузера — подготовка
   * сценария. Проверки, которые ходят в сеть или стоят денег, помечены ручными
   * и сами не запускаются.
   */
  const doctorReport = createDoctorReport({
    browserPath: options.browserPath,
    showcaseDir: options.showcaseDir,
    voiceStatuses: () => voices.statuses(),
    transcribeAvailable: Boolean(options.transcribe),
    resolveTarget,
  });

  async function doctor(ref?: ShowcaseTargetRef, profile?: string): Promise<ShowcaseDoctor> {
    assertEnabled();

    return doctorReport.doctor(ref, profile);
  }

  /**
   * Выключение плагина прекращает приём новых шагов и снимает идущие задания.
   * Данные остаются на месте, но работающего конвейера после выключения быть
   * не должно: повторное включение не обязано продолжать чужую попытку.
   */
  async function disable(): Promise<void> {
    enabled = false;

    for (const job of jobs.active()) {
      const handle = attempts.get(job.id);

      if (handle) {
        stopWorker(handle.identity);
      }

      await jobs.cancel(job.id).catch(() => null);
    }

    attempts.clear();
  }

  function enable(): void {
    enabled = true;
  }

  /** Старт сервера: сверка журнала заданий с процессами до приёма новых работ. */
  async function recover(): Promise<{ alive: number; interrupted: number }> {
    await store.ensureDirs();
    await voiceInstaller.recover();

    return jobs.recover();
  }

  /**
   * Общие входы артефактов ролика: состояние цели, оформление и версии инструментов.
   * Заблокированная цель даёт пустые отпечатки — по ним всё содержимое ролика
   * считается устаревшим, и это правда: снимать нечего, пока цель недоступна.
   */
  function inputsOf(project: ShowcaseProject): ArtifactInputs {
    const scope = project.target.status === 'ready' ? project.target.scope : null;

    return {
      targetFingerprint: scope?.targetFingerprint ?? '',
      policyRevision: scope?.policyRevision ?? '',
      dataRevision: scope?.dataRevision ?? '',
      style: RENDER_STYLE,
      versions: PRODUCER_VERSIONS,
    };
  }

  /**
   * Пересчитывает свежесть перед показом. Флага «устарело» в хранилище нет: он
   * разошёлся бы с правдой при первой же правке, о которой забыли, — поэтому
   * состояние вычисляется из хешей входов при каждом чтении.
   */
  function withFreshness(project: ShowcaseProject): ShowcaseProject {
    const inputs = inputsOf(project);
    const scenes = project.scenes.map((scene) => ({
      ...scene,
      stale: sceneFreshness(scene, inputs).stale,
    }));
    const latestFinal = project.latestFinal
      ? { ...project.latestFinal, current: finalIsCurrent(project, inputs) }
      : null;

    return { ...project, scenes, latestFinal };
  }

  // Операции раздела живут отдельными модулями и собираются здесь: каждая получает
  // ровно те зависимости, которые ей нужны. Общего объекта «контекст» намеренно нет —
  // по списку зависимостей видно, что операция трогает, а чего не касается.
  const {
    addScene,
    deleteScene,
    importSceneAudio,
    reorder,
    screenOf,
    updateScene,
  } = createSceneOps({
    assertEnabled,
    broadcast: options.broadcast,
    limits: options.limits,
    readProject,
    store,
    targets,
    withFreshness,
  });

  const { publishRecording, startRecording } = createRecordingOps({
    assertEnabled,
    attempts,
    broadcast: options.broadcast,
    browserPath: options.browserPath,
    inputsOf,
    jobs,
    limits: options.limits,
    readProject,
    store,
    targets,
  });

  const { assemble, runAssemble } = createAssemblyOps({
    assertEnabled,
    broadcast: options.broadcast,
    inputsOf,
    jobs,
    limits: options.limits,
    readProject,
    store,
  });

  const {
    cancelVoiceInstall,
    installVoice,
    synthesizeScenes,
    voiceCatalog,
  } = createNarrationOps({
    assertEnabled,
    broadcast: options.broadcast,
    inputsOf,
    jobs,
    readProject,
    store,
    transcribe: options.transcribe ?? null,
    voiceInstaller,
    voices,
  });

  const { generateBrief, generateScript } = createScriptOps({
    assertEnabled,
    broadcast: options.broadcast,
    limits: options.limits,
    readProject,
    resolveScriptModel: options.resolveScriptModel ?? null,
    scriptModelRef: options.scriptModelRef ?? null,
    store,
    targets,
    withFreshness,
  });

  const { prepareData, seedStatus } = createSeedOps({
    assertEnabled,
    broadcast: options.broadcast,
    jobs,
    readProject,
    setDataRevision: (ref, revision) => {
      dataRevisions.set(`${ref.kind}:${ref.id}`, revision);
    },
    store,
    targets,
  });

  const { deliver, deliveryChannels, planDelivery } = createDeliveryOps({
    assertEnabled,
    channelDeps: () => options.deliveryDeps ?? {},
    deliveries,
    readProject,
  });

  /**
   * Наблюдение за отсоединёнными исполнителями. Сервер читает журнал попытки и её
   * итог, но сам в них не пишет: писатель журнала — worker, писатель ссылок ролика —
   * сервер, и пересечения нет ни в одну сторону.
   */
  async function pollWorkers(): Promise<void> {
    for (const job of jobs.active()) {
      const handle = attempts.get(job.id);

      if (!handle) {
        continue;
      }

      for (const line of await readProgressSince(handle.workDir, job.sequence)) {
        await jobs.progress(job.id, {
          sequence: line.sequence + job.sequence,
          label: line.label,
          index: line.index,
          total: line.total,
        });
      }

      const result = await readWorkerResult(handle.workDir);

      if (!result) {
        continue;
      }

      if (result.state === 'succeeded') {
        await publishRecording(job.id, result);
        await jobs.finish(job.id, { state: 'succeeded', label: 'запись завершена' });
      } else {
        await jobs.finish(job.id, { state: 'failed', error: result.error ?? 'запись не удалась' });
      }

      attempts.delete(job.id);
    }

    await voiceInstaller.poll();
    await jobs.sweepExpired();
  }

  /**
   * Файл артефакта для отдачи. Идентификатор проверяется по форме, а расширение
   * выбирается по виду артефакта: путь из запроса в файловую систему не попадает
   * ни одной своей частью.
   */
  async function artifactPath(projectId: string, artifactId: string): Promise<{
    file: string;
    byteSize: number;
  }> {
    assertEnabled();

    const project = await readProject(projectId);
    const names = store.namesOf(projectId);

    for (const scene of project.scenes) {
      for (const candidate of [scene.audio, scene.clip, scene.frame]) {
        if (candidate?.id === artifactId) {
          return {
            file: artifactFile(
              path.join(names.scenesDir, scene.id, 'artifacts'),
              artifactId,
              extensionOf(candidate.kind),
            ),
            byteSize: candidate.byteSize,
          };
        }
      }
    }

    for (const candidate of [project.latestFinal?.video, project.latestFinal?.subtitles]) {
      if (candidate?.id === artifactId) {
        return {
          file: artifactFile(names.finalsDir, artifactId, extensionOf(candidate.kind)),
          byteSize: candidate.byteSize,
        };
      }
    }

    throw notFound('Артефакт не найден.');
  }

  return {
    addScene,
    artifactPath,
    assemble,
    cancelJob,
    createProject,
    deleteProject,
    deleteScene,
    deliver,
    deliveryChannels,
    disable,
    doctor,
    enable,
    generateBrief,
    generateScript,
    importSceneAudio,
    jobs,
    loginStore,
    markDataUpdated,
    overview,
    planDelivery,
    prepareData,
    readProject,
    recover,
    renameProject,
    cancelVoiceInstall,
    installVoice,
    pollWorkers,
    reorder,
    seedStatus,
    startRecording,
    store,
    synthesizeScenes,
    targets,
    updateScene,
    voiceCatalog,
    withFreshness,
  };
}

export type ShowcaseService = ReturnType<typeof createShowcaseService>;

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
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type {
  ShowcaseDoctor,
  ShowcaseBuildRun,
  ShowcaseJob,
  ShowcaseOverview,
  ShowcaseProject,
  ShowcaseProjectSummary,
  ShowcaseTarget,
  ShowcaseTargetOption,
  ShowcaseTargetRef,
} from '../../../../shared/showcaseContracts.ts';
import type { SandboxOverview } from '../../../../shared/sandboxContracts.ts';
import type { PluginSetupItem, PluginSetupStatus } from '../../../../shared/pluginsContracts.ts';
import { SHOWCASE_SCHEMA_VERSION, toProjectSummary } from '../../../../shared/showcaseContracts.ts';
import { artifactFile, finalIsCurrent, hashFile, sceneFreshness } from './artifacts.ts';
import { chainLineage } from '../../../../shared/showcaseChains.ts';
import type { ArtifactInputs } from './artifacts.ts';
import { notFound, ShowcaseError } from './errors.ts';
import { readProgressSince, readWorkerResult, stopWorker } from './render/runner.ts';
import type { WorkerHandle } from './render/runner.ts';
import type { DeliveryRecord } from './delivery.ts';
import type { DeliveryChannelDeps } from './deliveryChannels.ts';
import { PROFILE_RE } from '../profiles.ts';
import { createVoiceRegistry } from './voice/registry.ts';
import { createStressDictionaryStore } from './voice/dictionary.ts';
import { createEdgeEngine } from './voice/edge.ts';
import type { EdgeEngineOptions } from './voice/edge.ts';
import { createPiperEngine } from './voice/piper.ts';
import { createQwenEngine } from './voice/qwen.ts';
import { createRhvoiceEngine } from './voice/rhvoice.ts';
import { createSileroEngine } from './voice/silero.ts';
import { createYandexEngine } from './voice/yandex.ts';
import {
  createVoiceInstaller,
  qwenRuntimePaths,
  sileroRuntimePaths,
  voiceRuntimePaths,
} from './voice/install.ts';
import { createBrowserInstaller } from './browserInstall.ts';
import { createShowcaseJobs, toPublicJob } from './jobs.ts';
import { createShowcaseLoginStore } from './loginStore.ts';
import { createShowcaseStore, newShowcaseId } from './store.ts';
import { createShowcaseTargets } from './targets.ts';
import { createDoctorReport } from './doctorReport.ts';
import { extensionOf, PRODUCER_VERSIONS, RENDER_STYLE } from './formats.ts';
import { createAssemblyOps } from './assemblyOps.ts';
import { createBuildOps } from './buildOps.ts';
import { createShowcaseBuildRuns, toPublicBuildRun } from './buildRuns.ts';
import type { BuildRunRecord } from './buildRuns.ts';
import { createDeliveryOps } from './deliveryOps.ts';
import { createNarrationOps } from './narrationOps.ts';
import { createRecordingOps, readRecordingTiming } from './recordingOps.ts';
import { createSceneOps } from './sceneOps.ts';
import { createScriptOps } from './scriptOps.ts';
import { readScriptProof } from './script/verification.ts';
import { createSeedOps } from './seedOps.ts';
import {
  createSandboxActivityGuard,
  SandboxActivityError,
} from '../sandboxes/activityGuard.ts';
import type {
  SandboxActivityGuard,
  SandboxActivityLease,
} from '../sandboxes/activityGuard.ts';
import type { SpeechTranscript } from '../speech/transport.ts';
import { readFinalManifest } from './syncStore.ts';
import type { ShowcaseFinalManifest } from '../../../../shared/showcaseTimeline.ts';

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
  // Каталог браузера, который раздел ставит сам из настроек плагина: сборка
  // Chromium под текущий playwright-core. Явный browserPath сильнее него.
  browserDir?: string;
  // Каталог локального синтеза: отдельное python-окружение и скачанные голоса.
  // Он вынесен из showcaseDir настройкой, потому что весит сотни мегабайт и его
  // разумно держать там же, где остальные тяжёлые рантаймы установки.
  voiceDir?: string;
  // Облачный голос Яндекса: ключ приходит из машинных настроек сервера. Без ключа
  // движок остаётся в списке заблокированным — с подсказкой, как его включить.
  yandexVoice?: { apiKey: string; folderId: string } | null;
  // Облачный голос Microsoft (Edge TTS): ключа у него нет, поэтому настройка —
  // выключатель. Без опции движок не подключается вовсе: тесты службы не должны
  // ходить в сеть, а боевой сервер передаёт её всегда.
  edgeVoice?: EdgeEngineOptions | null;
  bootstrapPython?: string;
  listProjects: () => Promise<string[]>;
  sandboxOverview?: () => Promise<Pick<SandboxOverview, 'sandboxes'>>;
  sandboxActivityGuard?: SandboxActivityGuard;
  // Расшифровка приходит функцией: раздел пользуется общим речевым runtime кокпита,
  // но не знает, как тот устроен, и без него обязан работать — с пометкой, что
  // проверка речи пропущена.
  transcribe?: ((file: string) => Promise<string | SpeechTranscript>) | null;
  // Модель для брифа и сценария приходит резолвером: раздел не знает, как устроен
  // выбор исполнителя, но обязан получить именно безопасный model-only режим.
  resolveScriptModel?: ((options: {
    modelRef: unknown;
    config: Record<string, unknown>;
    requireImages: boolean;
    log: { warn?: (data: unknown, message: string) => unknown };
  }) => Promise<unknown>) | null;
  scriptModelRef?: () => unknown;
  // Серверный config исполнителей и настройки провайдеров приходят снаружи: раздел
  // не читает ни config.ts, ни prefs напрямую, но без них модель не запустится.
  executorConfig?: () => Record<string, unknown>;
  providerSettings?: () => Record<string, unknown>;
  // Задача портала для стенда задачи: связь и сессию держит сервер, раздел просит
  // только текст. Без этой зависимости разбор идёт по diff и карте экранов.
  taskDetails?: (taskId: string) => Promise<{
    title?: unknown;
    description?: unknown;
  } | null>;
  // Каналы доставки приходят снаружи: сессией портала и аккаунтом Telegram владеет
  // сервер, и раздел не заводит вторых.
  deliveryDeps?: DeliveryChannelDeps;
  broadcast: (event: string, data: unknown) => void;
  limits: () => ShowcaseLimits;
}

const DEFAULT_TITLE = 'Новый ролик';

// Название задачи портала помнится недолго: список целей перечитывается при каждом
// открытии раздела, а ходить в портал за каждым стендом каждый раз незачем.
const TASK_TITLE_TTL_MS = 10 * 60_000;
const TASK_TITLE_MAX = 120;

/**
 * Имя ролика человек не придумывает: ролик всегда о конкретном стенде, и это же
 * стоит в списке. Стенд задачи называется её номером и названием из портала — по
 * одному номеру человек задачу не узнаёт; без портала остаётся профиль. Постоянный
 * стенд называется профилем. Переименовать вручную по-прежнему можно.
 */
function titleOf(ref: ShowcaseTargetRef, target: ShowcaseTarget, taskTitle: string): string {
  const profile = target.status === 'ready' ? target.scope.profile : '';

  if (ref.kind === 'project') {
    return profile ? `Проект ${profile}` : DEFAULT_TITLE;
  }

  if (taskTitle) {
    return `Задача ${ref.id} · ${taskTitle}`;
  }

  return profile ? `Задача ${ref.id} · ${profile}` : `Задача ${ref.id}`;
}

/**
 * Состояние ролика для списка. Считается на сервере из фактов записи: список и
 * карточка не должны расходиться в оценке готовности, а у списка нет входов,
 * чтобы судить самостоятельно.
 */
function stateOf(
  project: ShowcaseProject,
  jobs: ShowcaseJob[],
  runs: ShowcaseBuildRun[],
): ShowcaseProjectSummary['state'] {
  if (
    jobs.some((job) => (
      job.state === 'running' || job.state === 'queued' || job.state === 'cancelling'
    ))
    || runs.some((run) => (
      run.state === 'queued' || run.state === 'running' || run.state === 'cancelling'
    ))
  ) {
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
  const activityGuard = options.sandboxActivityGuard
    ?? createSandboxActivityGuard({ stateDir: options.stateDir });
  const jobs = createShowcaseJobs({
    jobsDir: store.jobsDir,
    broadcast: options.broadcast,
    limits: () => {
      const limits = options.limits();

      return { maxQueued: limits.maxQueued, jobTimeoutMs: limits.jobTimeoutMs };
    },
  });
  const buildRuns = createShowcaseBuildRuns({
    runsDir: path.join(options.showcaseDir, 'builds'),
    broadcast: options.broadcast,
    limits: () => ({
      retentionDays: options.limits().retentionDays,
      maxRuns: 200,
    }),
  });

  // Ревизия данных — отметка человека «данные обновлены». Внешнюю правку базы
  // плагин обнаружить не обещает, поэтому версия хранится рядом с роликами и
  // меняется только явным действием.
  const dataRevisions = new Map<string, string>();

  // Названия задач портала по номеру стенда: см. taskTitleOf.
  const taskTitles = new Map<string, { title: string; at: number }>();

  const targets = createShowcaseTargets({
    profilesDir: options.profilesDir,
    stateDir: options.stateDir,
    listProjects: options.listProjects,
    sandboxOverview: options.sandboxOverview,
    dataRevisionOf: async (ref) => dataRevisions.get(`${ref.kind}:${ref.id}`) ?? 'начальные',
  });

  const voiceDir = options.voiceDir || path.join(options.showcaseDir, 'voice');
  const voiceInstaller = createVoiceInstaller({
    voiceDir,
    bootstrapPython: options.bootstrapPython,
    broadcast: options.broadcast,
    onInstalled: () => {
      voices.forgetDoctors();
    },
  });

  // Браузер записи: явный путь из настроек машины, иначе установленный из
  // настроек плагина. Проверка готовности и запись читают его одной функцией.
  const browserInstaller = createBrowserInstaller({
    browserDir: options.browserDir ?? path.join(options.stateDir, 'showcase-browser'),
    broadcast: options.broadcast,
  });

  async function resolveBrowserPath(): Promise<string | null> {
    if (options.browserPath) {
      return options.browserPath;
    }

    return browserInstaller.installedExecutable();
  }

  // Четыре локальных движка и два облачных. Qwen3-TTS, Silero и Piper раздел
  // ставит сам, системный RHVoice остаётся для установок, где пакет уже есть.
  // Порядок задаёт и выбор по умолчанию — первый ГОТОВЫЙ движок, а не первый в
  // списке. Включённое облако Microsoft идёт первым: его утверждённым голосом
  // должен говорить новый ролик, а готовность у него честная — по живому списку
  // голосов, и без сети выбор переходит к следующему. Облако Яндекса с заданным
  // ключом идёт следом: ключ задают ради его голосов; без ключа оно замыкает
  // список, чтобы подсказка «чего не хватает» на чистой установке вела к кнопке,
  // а не в .env. Среди локальных Qwen первый: его ставят ради качества, и новый
  // ролик должен заговорить им, как только он установлен. Выключенное настройкой
  // облако Microsoft стоит последним — видимым, с подсказкой, как включить.
  const edge = options.edgeVoice ? createEdgeEngine(options.edgeVoice) : null;
  const yandex = createYandexEngine(options.yandexVoice ?? { apiKey: '', folderId: '' });
  const local = [
    createQwenEngine(qwenRuntimePaths(voiceDir)),
    createSileroEngine(sileroRuntimePaths(voiceDir)),
    createPiperEngine(voiceRuntimePaths(voiceDir)),
    createRhvoiceEngine(),
  ];
  const voices = createVoiceRegistry([
    ...(edge && options.edgeVoice?.enabled ? [edge] : []),
    ...(options.yandexVoice?.apiKey ? [yandex] : []),
    ...local,
    ...(options.yandexVoice?.apiKey ? [] : [yandex]),
    ...(edge && !options.edgeVoice?.enabled ? [edge] : []),
  ]);

  // Словарь ударений установки: общий для всех роликов, живёт рядом с ними и
  // читается при старте — его записи входят в хеш звука сцен.
  const stressDictionary = createStressDictionaryStore({
    file: path.join(options.showcaseDir, 'stress-dictionary.txt'),
  });

  // Журнал доставок по ролику. Хранится отдельно от тяжёлых артефактов: он отвечает
  // на вопрос «что и куда ушло», и уборка файлов его не касается.
  const deliveries = new Map<string, DeliveryRecord[]>();

  // Уборка по сроку хранения ходит по всему каталогу роликов, поэтому она отделена
  // от частого опроса заданий собственным окном.
  const RETENTION_SWEEP_MS = 60 * 60 * 1000;
  let lastRetentionSweep = 0;

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
   * Берёт shared-аренду для стенда песочницы — и ручного, и того, что держит
   * остановленная попытка. Permanent project не управляется lifecycle раздела
   * песочниц и потому в этом протоколе не участвует.
   */
  async function acquireTargetLease(
    ref: ShowcaseTargetRef,
  ): Promise<SandboxActivityLease | null> {
    if (ref.kind === 'project') {
      return null;
    }

    try {
      return await activityGuard.acquireShowcase(ref.id);
    } catch (error) {
      if (error instanceof SandboxActivityError && error.code === 'SANDBOX_ACTIVITY_BUSY') {
        throw new ShowcaseError(
          'target_busy',
          'Стенд сейчас поднимается или сносится. Повторите после завершения.',
          409,
        );
      }

      const reason = error instanceof Error ? error.message : 'kernel lock недоступен';

      throw new ShowcaseError('target_guard_unavailable', reason, 503);
    }
  }

  /**
   * Цель перепроверяется при каждом чтении ролика, а не берётся из сохранённого
   * снимка: стенд мог исчезнуть, слот — достаться другой задаче, а объявление
   * профиля — измениться. Ролик хранит выбор человека, а не вывод о доступности.
   */
  async function resolveTarget(
    ref: ShowcaseTargetRef,
    profile = '',
    catalog?: readonly ShowcaseTargetOption[],
  ): Promise<ShowcaseTarget> {
    try {
      return await targets.resolveSelected(ref, profile, catalog);
    } catch (error) {
      if (error instanceof ShowcaseError) {
        return {
          status: 'blocked',
          ref,
          profile: PROFILE_RE.test(profile) ? profile : null,
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

  /**
   * Сохранённая песочница связана не только номером и профилем, но и отпечатком
   * конкретного поколения стенда. Без него или при несовпадении ролик не должен
   * автоматически открыться на пересозданной sandbox с тем же task.
   */
  async function resolveStoredTarget(
    ref: ShowcaseTargetRef,
    stored: ShowcaseTarget,
    catalog?: readonly ShowcaseTargetOption[],
  ): Promise<ShowcaseTarget> {
    const profile = stored.status === 'ready'
      ? stored.scope.profile
      : (stored.profile ?? '');

    if (ref.kind !== 'project' && stored.status !== 'ready') {
      return {
        status: 'blocked',
        ref,
        profile: PROFILE_RE.test(profile) ? profile : null,
        reason: 'У ролика не сохранена привязка к конкретному стенду (отпечаток).',
        nextAction: {
          kind: 'open-sandboxes',
          label: 'Выбрать стенд заново',
          hint: 'Создайте новый ролик из текущей ручной песочницы.',
        },
      };
    }

    const current = await resolveTarget(ref, profile, catalog);

    if (
      ref.kind !== 'project'
      && stored.status === 'ready'
      && current.status === 'ready'
      && stored.scope.targetFingerprint !== current.scope.targetFingerprint
    ) {
      return {
        status: 'blocked',
        ref,
        profile,
        reason: 'Стенд пересоздан или изменился после выбора для этого ролика.',
        nextAction: {
          kind: 'open-sandboxes',
          label: 'Выбрать стенд заново',
          hint: 'Создайте новый ролик из текущего поколения ручной песочницы.',
        },
      };
    }

    return current;
  }

  /**
   * Ролик наружу — с ЖИВОЙ целью и свежестью сцен. В project.json цель лежит снимком
   * выбора (отпечаток, политика, ревизия карты на тот момент); ответ мутации с этим
   * снимком заставлял интерфейс сравнивать свежий сценарий со старой картой, и сразу
   * после «Разобрать заново» карточка просила разобрать заново ещё раз — пока
   * следующее чтение не приносило живую цель.
   */
  async function publish(project: ShowcaseProject): Promise<ShowcaseProject> {
    return withFreshness({
      ...project,
      target: await resolveStoredTarget(project.ref, project.target),
    });
  }

  async function readProject(id: string): Promise<ShowcaseProject> {
    return publish(await store.readProject(id));
  }

  /** Старый список профилей остаётся на проводе до миграции прежних клиентов. */
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

  /**
   * Название задачи портала по номеру стенда. Связь и сессию портала держит сервер,
   * поэтому спрашивается здесь, а не в браузере; любая беда портала — не отказ
   * раздела, а пустое название: стенд останется подписан номером.
   */
  async function taskTitleOf(taskId: string): Promise<string> {
    if (!options.taskDetails) {
      return '';
    }

    const cached = taskTitles.get(taskId);

    if (cached && Date.now() - cached.at < TASK_TITLE_TTL_MS) {
      return cached.title;
    }

    let title = '';

    try {
      const details = await options.taskDetails(taskId);

      title = String(details?.title ?? '').replace(/\s+/g, ' ').trim().slice(0, TASK_TITLE_MAX);
    } catch {
      title = '';
    }

    taskTitles.set(taskId, { title, at: Date.now() });

    return title;
  }

  // Стенды задач подписываются названием задачи: по номеру человек стенд не
  // узнаёт. Портал спрашивается параллельно и один раз на номер.
  async function withTaskTitles(catalog: ShowcaseTargetOption[]): Promise<ShowcaseTargetOption[]> {
    return Promise.all(catalog.map(async (choice) => {
      if (choice.ref.kind !== 'sandbox') {
        return choice;
      }

      const taskTitle = await taskTitleOf(choice.ref.id);

      return taskTitle ? { ...choice, taskTitle } : choice;
    }));
  }

  // Имена, которые ролик стенда задачи получает без названия из портала.
  function fallbackTaskTitles(id: string, profile: string): string[] {
    return profile ? [`Задача ${id}`, `Задача ${id} · ${profile}`] : [`Задача ${id}`];
  }

  /**
   * Имя ролика догоняет название задачи. Ролик, заведённый, пока портал молчал
   * (или раньше, чем раздел стал спрашивать название), носит имя по номеру; как
   * только название известно, сервер переименовывает его сам: имя по умолчанию —
   * его собственное решение, а не человека. Переименованный человеком ролик не
   * трогается: его имя с формой по умолчанию не совпадает. Вызывается только с
   * путей чтения для интерфейса — операции с ожидаемой редакцией читают ролик
   * через readProject и не должны получать чужой сдвиг редакции под правкой.
   */
  async function adoptTaskTitle(project: ShowcaseProject): Promise<ShowcaseProject> {
    if (project.ref.kind === 'project') {
      return project;
    }

    const profile = project.target.status === 'ready'
      ? project.target.scope.profile
      : project.target.profile ?? '';

    if (!fallbackTaskTitles(project.ref.id, profile).includes(project.title)) {
      return project;
    }

    const taskTitle = await taskTitleOf(project.ref.id);

    if (!taskTitle) {
      return project;
    }

    const saved = await store.updateProject(project.id, null, (current) => ({
      ...current,
      title: `Задача ${project.ref.id} · ${taskTitle}`,
    }));

    options.broadcast('showcase-changed', { projectId: project.id, revision: saved.revision });

    return {
      ...project,
      title: saved.title,
      revision: saved.revision,
      updatedAt: saved.updatedAt,
    };
  }

  // Ролик для экрана: то же чтение, но имя по умолчанию успевает догнать название задачи.
  async function openProject(id: string): Promise<ShowcaseProject> {
    return adoptTaskTitle(await readProject(id));
  }

  async function overview(): Promise<ShowcaseOverview> {
    assertEnabled();

    const [{ projects }, catalog] = await Promise.all([
      store.listProjects(),
      targets.choices().then(withTaskTitles),
    ]);
    const limits = options.limits();
    const summaries: ShowcaseProjectSummary[] = [];

    for (const stored of projects) {
      const own = jobs.list(stored.id).map(toPublicJob);
      const ownRuns = buildRuns.list(stored.id).map(toPublicBuildRun);
      const project = await adoptTaskTitle({
        ...stored,
        target: await resolveStoredTarget(stored.ref, stored.target, catalog),
      });

      summaries.push(toProjectSummary(project, stateOf(project, own, ownRuns)));
    }

    return {
      targets: catalog,
      profiles: await listTargetProfiles(),
      projects: summaries,
      jobs: jobs.list().slice(0, 50).map(toPublicJob),
      buildRuns: buildRuns.list().slice(0, 50).map(toPublicBuildRun),
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
    // Только старые библиотечные вызовы передают профиль. HTTP его не принимает;
    // новый путь всегда связывает цель с профилем на сервере.
    profile?: string;
    title?: string;
  }): Promise<ShowcaseProject> {
    assertEnabled();
    await store.ensureDirs();

    const target = await resolveTarget(input.ref, input.profile);

    if (!input.profile && target.status !== 'ready') {
      throw new ShowcaseError('target_unavailable', target.reason, 409);
    }

    const taskTitle = input.ref.kind === 'project' ? '' : await taskTitleOf(input.ref.id);
    const now = new Date().toISOString();
    const project: ShowcaseProject = {
      schemaVersion: SHOWCASE_SCHEMA_VERSION,
      id: newShowcaseId(),
      title: (input.title ?? '').trim() || titleOf(input.ref, target, taskTitle),
      revision: 1,
      ref: input.ref,
      target,
      brief: [],
      scenes: [],
      scriptGaps: [],
      scriptMapRevision: null,
      scriptProofHash: null,
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
    for (const run of buildRuns.active(id)) {
      await buildRuns.requestCancel(run.id).catch(() => null);
    }

    for (const job of jobs.list(id)) {
      await jobs.cancel(job.id).catch(() => null);
    }

    await jobs.removeForProject(id);
    await buildRuns.removeForProject(id);
    await store.removeProject(id);
    options.broadcast('showcase-changed', { projectId: id, revision: 0 });
  }

  /**
   * Отмена задания. Если у него есть отсоединённый исполнитель, сигнал уходит
   * всему его дереву: браузер переживает смерть родителя и держал бы цель занятой.
   * Завершённым задание станет, только когда исполнитель это подтвердит.
   */
  async function cancelJobInternal(id: string): Promise<ShowcaseJob> {
    const record = await jobs.cancel(id);
    const handle = attempts.get(id);

    if (handle) {
      stopWorker(handle.identity);
    }

    return toPublicJob(record);
  }

  async function cancelJob(id: string): Promise<ShowcaseJob> {
    assertEnabled();

    return cancelJobInternal(id);
  }

  /**
   * Готовность по операциям. Отсутствие одной возможности не закрывает раздел:
   * без голосового движка остаётся импорт звука, без браузера — подготовка
   * сценария. Проверки, которые ходят в сеть или стоят денег, помечены ручными
   * и сами не запускаются.
   */
  const doctorReport = createDoctorReport({
    resolveBrowserPath,
    showcaseDir: options.showcaseDir,
    voiceStatuses: () => voices.statuses(),
    transcribeAvailable: Boolean(options.transcribe),
    resolveTarget,
  });

  async function doctor(ref?: ShowcaseTargetRef, profile?: string): Promise<ShowcaseDoctor> {
    assertEnabled();

    return doctorReport.doctor(ref, profile);
  }

  const MEGABYTE = 1024 * 1024;
  const GIGABYTE = 1024 * MEGABYTE;

  // Пакет на гигабайты называется гигабайтами: «8100 МБ» человек прочитает хуже,
  // чем «7,9 ГБ», а размер он читает ДО нажатия.
  function sizeLabel(bytes: number): string {
    if (bytes >= GIGABYTE) {
      return `${(bytes / GIGABYTE).toFixed(1).replace('.', ',')} ГБ`;
    }

    return `${Math.round(bytes / MEGABYTE)} МБ`;
  }

  function setupJobOf(job: PluginSetupItem['job']): PluginSetupItem['job'] {
    return job ? { state: job.state, label: job.label, error: job.error } : null;
  }

  /**
   * Готовность плагина для его настроек: что нужно на машине и что раздел умеет
   * поставить сам. Пункты собираются из тех же проверок, что и готовность
   * раздела, плюс состояние установщиков: у требования одна строка и одна кнопка.
   */
  async function setupStatus(): Promise<PluginSetupStatus> {
    assertEnabled();

    const report = await doctorReport.doctor();
    const operationOf = (id: string) => report.operations.find((operation) => operation.id === id);
    const browser = await browserInstaller.status();
    const voiceStatus = await voiceInstaller.status();
    const engines = await voices.statuses();
    const items: PluginSetupItem[] = [];
    const browserOperation = operationOf('browser');
    const staleBrowser = browser.installed !== null && !browser.installed.current;

    items.push({
      id: 'browser',
      title: 'Браузер записи',
      status: browserOperation?.status ?? 'unknown',
      reason: staleBrowser
        ? `Chromium поставлен под Playwright ${browser.installed?.playwrightVersion}, а сейчас `
          + `нужен ${browser.playwrightVersion}: переустановите его.`
        : (browserOperation?.reason ?? ''),
      action: browserOperation?.status === 'ready'
        ? null
        : {
          label: staleBrowser ? 'Переустановить Chromium' : 'Установить Chromium',
          hint: 'Скачается сборка Chromium под текущий Playwright: около 170 МБ по сети, '
            + 'около 400 МБ на диске в каталоге кокпита.',
        },
      job: setupJobOf(browser.job),
    });

    const media = operationOf('media');

    items.push({
      id: 'media',
      title: 'Сборка видео',
      status: media?.status ?? 'unknown',
      reason: media?.status === 'ready'
        ? media.reason
        : `${media?.reason ?? ''} Ставится пакетом системы: sudo apt install ffmpeg.`.trim(),
      action: null,
      job: null,
    });

    for (const pack of voiceStatus.available) {
      const job = voiceStatus.job?.voiceId === pack.id ? voiceStatus.job : null;

      items.push({
        id: `voice:${pack.id}`,
        title: `Голос ${pack.name}`,
        status: pack.installed ? 'ready' : 'blocked',
        reason: `${pack.voices.join(', ')} · ${pack.license}. `
          + (pack.installed ? 'Установлен и говорит на этой машине.' : 'Не установлен.'),
        action: pack.installed
          ? null
          : { label: 'Установить', hint: `Скачается около ${sizeLabel(pack.byteSize)}: движок и модель.` },
        job: setupJobOf(job),
      });
    }

    // Облака ставятся не кнопкой, а настройкой сервера: у пункта только слова о
    // том, что задать. Порядок фиксированный, а не по реестру: пункт готовности
    // не должен прыгать по списку от того, задан ли ключ.
    const clouds: { id: string; title: string }[] = [
      { id: 'edge', title: 'Облачный голос Microsoft' },
      { id: 'yandex', title: 'Облачный голос Яндекса' },
    ];

    for (const cloud of clouds) {
      const engine = engines.find((entry) => entry.id === cloud.id);

      if (engine) {
        items.push({
          id: cloud.id,
          title: cloud.title,
          status: engine.doctor.status === 'ready' ? 'ready' : 'blocked',
          reason: `${engine.doctor.reason} ${engine.doctor.install}`.trim(),
          action: null,
          job: null,
        });
      }
    }

    const speech = operationOf('speech');

    items.push({
      id: 'speech',
      title: 'Проверка речи',
      status: speech?.status ?? 'unknown',
      reason: speech?.status === 'ready'
        ? speech.reason
        : `${speech?.reason ?? ''} Распознавание ставит deploy/install.sh вместе с остальным `
          + 'речевым runtime кокпита.',
      action: null,
      job: null,
    });

    const storage = operationOf('storage');

    items.push({
      id: 'storage',
      title: 'Хранилище',
      status: storage?.status ?? 'unknown',
      reason: storage?.reason ?? '',
      action: null,
      job: null,
    });

    return { items, checkedAt: report.checkedAt };
  }

  /**
   * Установка по пункту готовности. Ставится только то, у чего есть кнопка:
   * системные пакеты и ключи человек задаёт сам, и сервер не пытается это обойти.
   */
  async function runSetup(id: string): Promise<PluginSetupStatus> {
    assertEnabled();

    if (id === 'browser') {
      await browserInstaller.start();
    } else if (id.startsWith('voice:')) {
      await installVoice(id.slice('voice:'.length));
    } else {
      throw new ShowcaseError('unknown_setup', `Пункт «${id}» кнопкой не ставится.`, 400);
    }

    return setupStatus();
  }

  async function cancelSetup(id: string): Promise<PluginSetupStatus> {
    assertEnabled();

    if (id === 'browser') {
      await browserInstaller.cancel();
    } else if (id.startsWith('voice:')) {
      await cancelVoiceInstall();
    } else {
      throw new ShowcaseError('unknown_setup', `Пункт «${id}» кнопкой не ставится.`, 400);
    }

    return setupStatus();
  }

  /**
   * Выключение плагина прекращает приём новых шагов и снимает идущие задания.
   * Данные остаются на месте, но работающего конвейера после выключения быть
   * не должно: повторное включение не обязано продолжать чужую попытку.
   */
  async function disable(): Promise<void> {
    enabled = false;

    await buildOps.cancelActive().catch(() => null);

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

  /**
   * После jobs.recover живой detached recorder снова получает in-memory handle.
   * Attempt выбирается по task.json из сохранённой командной строки, а не просто
   * как последний каталог: рядом могут лежать файлы прошлой попытки.
   */
  async function recoverRecordingAttempts(): Promise<void> {
    for (const job of jobs.active().filter((record) => (
      record.kind === 'record' && record.identity.pid !== null
    ))) {
      const workRoot = path.join(store.jobsDir, job.id, 'work');
      const names = await fs.readdir(workRoot).catch(() => [] as string[]);
      const directories: string[] = [];

      for (const name of names) {
        const candidate = path.join(workRoot, name);
        const directory = await fs.stat(candidate).then((info) => info.isDirectory(), () => false);

        if (directory) {
          directories.push(name);
        }
      }

      const attemptId = directories.find((name) => (
        job.identity.cmdline?.includes(path.join(name, 'task.json'))
      )) ?? (directories.length === 1 ? directories[0] : null);

      if (!attemptId) {
        continue;
      }

      attempts.set(job.id, {
        attemptId,
        identity: job.identity,
        workDir: path.join(workRoot, attemptId),
        seenSequence: 0,
      });
    }
  }

  /** Старт сервера: сверка журнала заданий с процессами до приёма новых работ. */
  async function recover(): Promise<{ alive: number; interrupted: number }> {
    await store.ensureDirs();
    await stressDictionary.load();
    await voiceInstaller.recover();
    await browserInstaller.recover();

    const recovered = await jobs.recover();

    await recoverRecordingAttempts();
    await buildOps.recover();

    // Старт — первый удобный момент для уборки: кокпит мог простоять выключенным
    // дольше срока хранения, и тогда протухшие ролики ждут не следующего часа, а
    // именно этого прохода.
    await sweepRetention({ force: true });

    return recovered;
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
      scriptProofHash: project.scriptProofHash ?? undefined,
      dataRevision: scope?.dataRevision ?? '',
      style: RENDER_STYLE,
      versions: PRODUCER_VERSIONS,
      stressDictionary: stressDictionary.entries(),
    };
  }

  async function readDictionary() {
    assertEnabled();

    return stressDictionary.read();
  }

  /**
   * Сохранение словаря. Записи вступают в силу сразу: хеши звука считаются по
   * ним при следующем чтении ролика, и сцены с этими словами устареют сами.
   */
  async function saveDictionary(text: string) {
    assertEnabled();

    return stressDictionary.save(text);
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
      stale: sceneFreshness(scene, inputs, chainLineage(project.scenes, scene.id)).stale,
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
    transcribe: options.transcribe ?? null,
    publish,
  });

  const { publishRecording, startRecording } = createRecordingOps({
    acquireTargetLease,
    assertEnabled,
    attempts,
    broadcast: options.broadcast,
    resolveBrowserPath,
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
    previewNarration,
    previewVoice,
    setVoice,
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
    previewDir: path.join(voiceDir, 'previews'),
    stressDictionary,
    publish,
  });

  const { analyze, ensurePrepared, generateBindings, generateBrief, generateScript } = createScriptOps({
    acquireTargetLease,
    assertEnabled,
    broadcast: options.broadcast,
    limits: options.limits,
    resolveBrowserPath,
    readProject,
    resolveScriptModel: options.resolveScriptModel ?? null,
    scriptModelRef: options.scriptModelRef ?? null,
    executorConfig: options.executorConfig ?? null,
    providerSettings: options.providerSettings ?? null,
    taskDetails: options.taskDetails ?? null,
    store,
    targets,
    publish,
  });

  function voiceReady(project: ShowcaseProject): boolean {
    const inputs = inputsOf(project);

    return project.scenes.length > 0 && project.scenes.every((scene) => (
      sceneFreshness(scene, inputs, chainLineage(project.scenes, scene.id)).audio
    ));
  }

  /**
   * Для полного запуска старого свежего клипа недостаточно: точный путь требует
   * текущий journal. Его отсутствие запускает одну пересъёмку, но не старит сам
   * legacy-клип для ручного просмотра.
   */
  async function recordingReady(project: ShowcaseProject): Promise<boolean> {
    const inputs = inputsOf(project);
    const names = store.namesOf(project.id);

    for (const scene of project.scenes) {
      const clipCurrent = sceneFreshness(
        scene,
        inputs,
        chainLineage(project.scenes, scene.id),
      ).clip;

      if (!clipCurrent || !scene.clip || !scene.recordingTiming) {
        return false;
      }

      const timing = await readRecordingTiming({
        ref: scene.recordingTiming,
        sceneInputHash: scene.clip.inputHash,
        clipContentHash: scene.clip.contentHash,
        actions: scene.actions,
        targetDir: path.join(names.scenesDir, scene.id, 'artifacts'),
      });

      if (!timing) {
        return false;
      }
    }

    return project.scenes.length > 0;
  }

  function finalReady(project: ShowcaseProject): boolean {
    return Boolean(project.latestFinal && finalIsCurrent(project, inputsOf(project)));
  }

  /** Validate повторяет дешёвые инварианты после публикации, не собирая файл снова. */
  async function validateBuildFinal(project: ShowcaseProject): Promise<void> {
    if (!project.latestFinal || !finalReady(project)) {
      throw new ShowcaseError('final_not_current', 'Итоговый ролик не соответствует входам.', 409);
    }

    for (const artifact of [project.latestFinal.video, project.latestFinal.subtitles].filter(Boolean)) {
      const resolved = await artifactPath(project.id, artifact!.id);
      const info = await fs.stat(resolved.file);
      const contentHash = await hashFile(resolved.file);

      if (
        info.size !== artifact!.byteSize
        || resolved.byteSize !== artifact!.byteSize
        || contentHash !== artifact!.contentHash
      ) {
        throw new ShowcaseError(
          'final_corrupted',
          'Итоговый файл не совпадает с опубликованной ссылкой.',
          409,
        );
      }
    }

    if (project.latestFinal.manifestVersion === 1) {
      await finalManifest(project.id, project.latestFinal.manifestId);
    }
  }

  /**
   * In-process assemble может завершить запись уже после запроса отмены. Ждём его
   * терминального job и атомарно возвращаем предыдущую ссылку, только если новый
   * final относится к входам именно отменённого child.
   */
  async function restorePreviousFinal(run: BuildRunRecord): Promise<void> {
    const child = [...run.children].reverse().find((entry) => (
      entry.stage === 'timeline-and-assemble'
    ));
    const expected = child ? jobs.read(child.jobId).inputHashes.final : null;
    const current = await store.readProject(run.projectId);

    if (
      !expected
      || !current.latestFinal
      || current.latestFinal.video.inputHash !== expected
      || current.latestFinal.video.id === run.previousFinal?.video.id
    ) {
      return;
    }

    const saved = await store.updateProject(run.projectId, null, (project) => {
      if (project.latestFinal?.video.inputHash !== expected) {
        return project;
      }

      return { ...project, latestFinal: run.previousFinal };
    });

    options.broadcast('showcase-changed', { projectId: run.projectId, revision: saved.revision });
  }

  const manualScriptRequests = new Map<string, Promise<ShowcaseProject>>();

  /**
   * Вторая модель не должна менять бриф под уже идущей проверкой и срывать её
   * сохранение конфликтом ревизий. Проверка действует и для другой вкладки.
   */
  async function requestScript(
    id: string,
    operation: () => Promise<ShowcaseProject>,
  ): Promise<ShowcaseProject> {
    assertEnabled();

    if (buildRuns.active(id).length > 0 || manualScriptRequests.has(id)) {
      throw new ShowcaseError(
        'script_busy',
        'Сценарий этого ролика уже готовится. Дождитесь результата текущей сборки или отмените её.',
        409,
      );
    }

    const request = Promise.resolve().then(operation).finally(() => {
      manualScriptRequests.delete(id);
    });

    manualScriptRequests.set(id, request);

    return request;
  }

  /**
   * Если человек нажал сборку во время ручного разбора, она использует его
   * результат. Ожидание предшествует чтению редакции для проверки сценария.
   */
  async function prepareScript(
    id: string,
    onProgress?: (label: string) => Promise<void>,
  ): Promise<ShowcaseProject> {
    const pending = manualScriptRequests.get(id);

    if (pending) {
      await onProgress?.('Дожидаюсь уже запущенного разбора сценария.');
      await pending;
    }

    return ensurePrepared(id, onProgress);
  }

  const buildOps = createBuildOps({
    assertEnabled,
    buildRuns,
    jobs,
    limits: options.limits,
    readProject,
    analyze,
    prepareScript,
    scriptReady: async (project) => !manualScriptRequests.has(project.id)
      && Boolean(await readScriptProof(store.namesOf(project.id).dir, project)),
    generateBindings,
    synthesizeScenes,
    startRecording,
    assemble,
    cancelJob: cancelJobInternal,
    voiceReady,
    recordingReady,
    finalReady,
    validateFinal: validateBuildFinal,
    restorePreviousFinal,
  });

  const { prepareData, seedStatus } = createSeedOps({
    acquireTargetLease,
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

      // Строки журнала считаются в своей шкале, сообщения задания — в своей: каждая
      // новая строка даёт следующий номер сообщения, а порог чтения двигает только
      // номер строки.
      for (const line of await readProgressSince(handle.workDir, handle.seenSequence)) {
        await jobs.progress(job.id, {
          sequence: jobs.read(job.id).sequence + 1,
          label: line.label,
          index: line.index,
          total: line.total,
        });
        handle.seenSequence = line.sequence;
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
    await browserInstaller.poll();
    const expiredJobs = await jobs.sweepExpired();

    // sweepExpired переводит просроченное задание в terminal-state, но сам не
    // владеет отсоединённым процессом записи. Пока handle оставался в attempts,
    // Chromium и его дочерние процессы могли жить после timeout и держать память.
    for (const job of expiredJobs) {
      const handle = attempts.get(job.id);

      if (!handle) {
        continue;
      }

      stopWorker(handle.identity);
      attempts.delete(job.id);
    }

    await buildOps.poll();
    await sweepRetention();
  }

  /**
   * Уборка по сроку хранения. Ролики — тяжёлые файлы: клипы, звук и mp4 каждой
   * попытки. Держать их вечно нельзя, поэтому ролик, которого не касались дольше
   * срока, удаляется целиком вместе со своими артефактами. Срок считается от
   * последнего изменения: открытый и правленый ролик живёт дальше.
   *
   * Проверка редкая по своей природе, но сам опрос частый, поэтому она проходит
   * не чаще раза в час — иначе каждый тик читал бы весь каталог роликов.
   */
  async function sweepRetention({ force = false } = {}): Promise<void> {
    const days = options.limits().retentionDays;
    const tooSoon = Date.now() - lastRetentionSweep < RETENTION_SWEEP_MS;

    if (!Number.isFinite(days) || days <= 0 || (tooSoon && !force)) {
      return;
    }

    lastRetentionSweep = Date.now();

    const deadline = Date.now() - days * 24 * 60 * 60 * 1000;
    const { projects } = await store.listProjects();

    for (const project of projects) {
      const touched = Date.parse(project.updatedAt);

      // Задание по ролику ещё идёт — файлы под ним живые, и удалять их нельзя
      // именно сейчас: уборка вернётся к этому ролику на следующем часу.
      if (jobs.list().some((job) => job.projectId === project.id && (
        job.state === 'running' || job.state === 'queued' || job.state === 'cancelling'
      )) || buildRuns.active(project.id).length > 0) {
        continue;
      }

      if (Number.isFinite(touched) && touched < deadline) {
        await store.removeProject(project.id);
        options.broadcast('showcase-changed', { projectId: project.id, revision: 0 });
      } else {
        // Активный проект сохраняется, но заменённые immutable-артефакты не
        // копятся бесконечно. Тот же retention оставляет окно для отмены правки.
        await store.sweepUnreferencedArtifacts(project, deadline);
      }
    }
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

  /**
   * Публичный manifest выдаётся только через ссылку текущего final и только после
   * повторной проверки его media refs. Знание content-addressed ID чужого ролика
   * не даёт доступа к его шкале.
   */
  async function finalManifest(
    projectId: string,
    manifestId: string,
  ): Promise<ShowcaseFinalManifest> {
    assertEnabled();

    const project = await readProject(projectId);
    const final = project.latestFinal;

    if (
      !final
      || final.manifestVersion !== 1
      || final.manifestId !== manifestId
    ) {
      throw notFound('Manifest ролика не найден.');
    }

    const manifest = await readFinalManifest({
      manifestId,
      targetDir: store.namesOf(projectId).finalsDir,
      projectId,
    });
    const videoMatches = manifest
      && manifest.inputHash === final.video.inputHash
      && manifest.video.id === final.video.id
      && manifest.video.contentHash === final.video.contentHash
      && manifest.video.byteSize === final.video.byteSize
      && manifest.video.durationMs === final.video.durationMs;
    const subtitlesMatch = manifest && final.subtitles
      ? manifest.subtitles?.id === final.subtitles.id
        && manifest.subtitles.contentHash === final.subtitles.contentHash
        && manifest.subtitles.byteSize === final.subtitles.byteSize
      : manifest?.subtitles === null && final.subtitles === null;

    if (!manifest || !videoMatches || !subtitlesMatch) {
      throw new ShowcaseError(
        'manifest_unavailable',
        'Manifest текущего ролика повреждён или не совпадает с опубликованными файлами.',
        409,
      );
    }

    return manifest;
  }

  return {
    addScene,
    artifactPath,
    assemble,
    buildRuns,
    cancelBuild: buildOps.cancelBuild,
    cancelJob,
    cancelSetup,
    createProject,
    deleteProject,
    deleteScene,
    deliver,
    deliveryChannels,
    disable,
    doctor,
    enable,
    analyze: (id: string) => requestScript(id, () => analyze(id)),
    generateBindings: (id: string) => requestScript(id, () => generateBindings(id)),
    generateBrief: (id: string, taskText: string) => requestScript(id, () => generateBrief(id, taskText)),
    generateScript: (id: string, taskText: string) => requestScript(id, () => generateScript(id, taskText)),
    finalManifest,
    importSceneAudio,
    jobs,
    loginStore,
    markDataUpdated,
    openProject,
    overview,
    planDelivery,
    prepareData,
    readProject,
    recover,
    renameProject,
    cancelVoiceInstall,
    installVoice,
    pollWorkers,
    previewNarration,
    previewVoice,
    readDictionary,
    readBuild: buildOps.readBuild,
    reorder,
    runSetup,
    saveDictionary,
    seedStatus,
    setupStatus,
    setVoice,
    startRecording,
    startBuild: buildOps.startBuild,
    store,
    synthesizeScenes,
    targets,
    updateScene,
    voiceCatalog,
    withFreshness,
  };
}

export type ShowcaseService = ReturnType<typeof createShowcaseService>;

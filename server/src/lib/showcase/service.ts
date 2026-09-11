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
  ShowcaseTargetOption,
  ShowcaseTargetRef,
} from '../../../../shared/showcaseContracts.ts';
import type { SandboxOverview } from '../../../../shared/sandboxContracts.ts';
import type { PluginSetupItem, PluginSetupStatus } from '../../../../shared/pluginsContracts.ts';
import { SHOWCASE_SCHEMA_VERSION, toProjectSummary } from '../../../../shared/showcaseContracts.ts';
import { artifactFile, finalIsCurrent, sceneFreshness } from './artifacts.ts';
import type { ArtifactInputs } from './artifacts.ts';
import { notFound, ShowcaseError } from './errors.ts';
import { readProgressSince, readWorkerResult, stopWorker } from './render/runner.ts';
import type { WorkerHandle } from './render/runner.ts';
import type { DeliveryRecord } from './delivery.ts';
import type { DeliveryChannelDeps } from './deliveryChannels.ts';
import { PROFILE_RE } from '../profiles.ts';
import { createVoiceRegistry } from './voice/registry.ts';
import { createPiperEngine } from './voice/piper.ts';
import { createRhvoiceEngine } from './voice/rhvoice.ts';
import { createSileroEngine } from './voice/silero.ts';
import { createYandexEngine } from './voice/yandex.ts';
import { createVoiceInstaller, sileroRuntimePaths, voiceRuntimePaths } from './voice/install.ts';
import { createBrowserInstaller } from './browserInstall.ts';
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
import {
  createSandboxActivityGuard,
  SandboxActivityError,
} from '../sandboxes/activityGuard.ts';
import type {
  SandboxActivityGuard,
  SandboxActivityLease,
} from '../sandboxes/activityGuard.ts';

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
  bootstrapPython?: string;
  listProjects: () => Promise<string[]>;
  sandboxOverview?: () => Promise<Pick<SandboxOverview, 'sandboxes'>>;
  sandboxActivityGuard?: SandboxActivityGuard;
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

/**
 * Имя ролика человек не придумывает: ролик всегда о конкретном стенде, и это же
 * стоит в списке. Стенд задачи называется её номером, постоянный — профилем;
 * переименовать вручную по-прежнему можно, но пустая форма больше ничего не ждёт.
 */
function titleOf(ref: ShowcaseTargetRef, target: ShowcaseTarget): string {
  const profile = target.status === 'ready' ? target.scope.profile : '';

  if (ref.kind === 'project') {
    return profile ? `Проект ${profile}` : DEFAULT_TITLE;
  }

  return profile ? `Задача ${ref.id} · ${profile}` : `Задача ${ref.id}`;
}

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

  // Ревизия данных — отметка человека «данные обновлены». Внешнюю правку базы
  // плагин обнаружить не обещает, поэтому версия хранится рядом с роликами и
  // меняется только явным действием.
  const dataRevisions = new Map<string, string>();

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

  // Три локальных движка и один облачный. Silero и Piper раздел ставит сам,
  // системный RHVoice остаётся для установок, где пакет уже есть. Порядок задаёт
  // и выбор по умолчанию — первый ГОТОВЫЙ движок, а не первый в списке. Облако
  // Яндекса с заданным ключом идёт первым: его голоса звучат живее всех, и ключ
  // задают именно ради них; без ключа оно замыкает список, чтобы подсказка
  // «чего не хватает» на чистой установке вела к кнопке, а не в .env.
  const yandex = createYandexEngine(options.yandexVoice ?? { apiKey: '', folderId: '' });
  const local = [
    createSileroEngine(sileroRuntimePaths(voiceDir)),
    createPiperEngine(voiceRuntimePaths(voiceDir)),
    createRhvoiceEngine(),
  ];
  const voices = createVoiceRegistry(
    options.yandexVoice?.apiKey ? [yandex, ...local] : [...local, yandex],
  );

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

  async function readProject(id: string): Promise<ShowcaseProject> {
    const stored = await store.readProject(id);

    return withFreshness({
      ...stored,
      target: await resolveStoredTarget(stored.ref, stored.target),
    });
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

  async function overview(): Promise<ShowcaseOverview> {
    assertEnabled();

    const [{ projects }, catalog] = await Promise.all([
      store.listProjects(),
      targets.choices(),
    ]);
    const limits = options.limits();
    const summaries: ShowcaseProjectSummary[] = [];

    for (const stored of projects) {
      const own = jobs.list(stored.id).map(toPublicJob);
      const project = {
        ...stored,
        target: await resolveStoredTarget(stored.ref, stored.target, catalog),
      };

      summaries.push(toProjectSummary(project, stateOf(project, own)));
    }

    return {
      targets: catalog,
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

    const now = new Date().toISOString();
    const project: ShowcaseProject = {
      schemaVersion: SHOWCASE_SCHEMA_VERSION,
      id: newShowcaseId(),
      title: (input.title ?? '').trim() || titleOf(input.ref, target),
      revision: 1,
      ref: input.ref,
      target,
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
      const megabytes = Math.round(pack.byteSize / MEGABYTE);
      const job = voiceStatus.job?.voiceId === pack.id ? voiceStatus.job : null;

      items.push({
        id: `voice:${pack.id}`,
        title: `Голос ${pack.name}`,
        status: pack.installed ? 'ready' : 'blocked',
        reason: `${pack.voices.join(', ')} · ${pack.license}. `
          + (pack.installed ? 'Установлен и говорит на этой машине.' : 'Не установлен.'),
        action: pack.installed
          ? null
          : { label: 'Установить', hint: `Скачается около ${megabytes} МБ: движок и модель.` },
        job: setupJobOf(job),
      });
    }

    const yandex = engines.find((engine) => engine.id === 'yandex');

    if (yandex) {
      items.push({
        id: 'yandex',
        title: 'Облачный голос Яндекса',
        status: yandex.doctor.status === 'ready' ? 'ready' : 'blocked',
        reason: `${yandex.doctor.reason} ${yandex.doctor.install}`.trim(),
        action: null,
        job: null,
      });
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
    await browserInstaller.recover();

    const recovered = await jobs.recover();

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
    withFreshness,
  });

  const { analyze, generateBrief, generateScript } = createScriptOps({
    acquireTargetLease,
    assertEnabled,
    broadcast: options.broadcast,
    limits: options.limits,
    readProject,
    resolveScriptModel: options.resolveScriptModel ?? null,
    scriptModelRef: options.scriptModelRef ?? null,
    executorConfig: options.executorConfig ?? null,
    providerSettings: options.providerSettings ?? null,
    taskDetails: options.taskDetails ?? null,
    store,
    targets,
    withFreshness,
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
    await browserInstaller.poll();
    await jobs.sweepExpired();
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

      if (!Number.isFinite(touched) || touched >= deadline) {
        continue;
      }

      // Задание по ролику ещё идёт — файлы под ним живые, и удалять их нельзя
      // именно сейчас: уборка вернётся к этому ролику на следующем часу.
      if (jobs.list().some((job) => job.projectId === project.id && (
        job.state === 'running' || job.state === 'queued'
      ))) {
        continue;
      }

      await store.removeProject(project.id);
      options.broadcast('showcase-changed', { projectId: project.id, revision: 0 });
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

  return {
    addScene,
    artifactPath,
    assemble,
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
    analyze,
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
    previewVoice,
    reorder,
    runSetup,
    seedStatus,
    setupStatus,
    setVoice,
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

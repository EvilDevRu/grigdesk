// Состояние раздела «Презентации» и ничего больше: сюда попадает уже проверенный
// контрактом обзор, а как он добыт — дело слоя операций (`actions/showcase`).
// Стор не знает ни путей `/api`, ни событий сервера, ни текстов отказа: иначе
// смена транспорта тянула бы за собой правку состояния.
import { defineStore } from 'pinia';
import type {
  ShowcaseBuildProgressEvent,
  ShowcaseBuildRun,
  ShowcaseJob,
  ShowcaseOverview,
  ShowcaseProject,
  ShowcaseProjectSummary,
  ShowcaseVoiceCatalog,
  ShowcaseVoiceDictionary,
} from '../../../shared/plugins/showcase/showcaseContracts';
import type { ShowcaseFinalManifest } from '../../../shared/plugins/showcase/showcaseTimeline';

const ACTIVE_BUILD_STATES = new Set<ShowcaseBuildRun['state']>([
  'queued', 'running', 'cancelling',
]);

// Снимок заменяет известные элементы, только если его sequence не старее локального.
// Активные записи можно удержать при кратком overview, пока их не догонит сервер.
function mergeBySequence<Item extends { id: string; sequence: number }>(
  current: Item[],
  snapshot: Item[],
  keepMissing: (item: Item) => boolean = () => false,
): Item[] {
  const known = new Map(current.map((item) => [item.id, item]));
  const snapshotIds = new Set(snapshot.map((item) => item.id));
  const retained = current.filter((item) => !snapshotIds.has(item.id) && keepMissing(item));

  return [...snapshot.map((item) => {
    const newer = known.get(item.id);

    return newer && newer.sequence > item.sequence ? newer : item;
  }), ...retained];
}

interface ShowcaseState {
  targets: ShowcaseOverview['targets'];
  projects: ShowcaseProjectSummary[];
  jobs: ShowcaseJob[];
  buildRuns: ShowcaseBuildRun[];
  limits: ShowcaseOverview['limits'];
  opened: ShowcaseProject | null;
  manifest: ShowcaseFinalManifest | null;
  manifestProjectId: string;
  manifestId: string;
  manifestStatus: 'idle' | 'loading' | 'ready' | 'failed';
  loading: boolean;
  loaded: boolean;
  error: string;
  busyProjects: string[];
  // Голоса приходят отдельным снимком: они общие для всех роликов и меняются
  // редко — установкой, а не правкой сцен.
  voices: ShowcaseVoiceCatalog | null;
  voiceBusy: boolean;
  // Словарь ударений — тоже общий для всех роликов и меняется только рукой человека.
  dictionary: ShowcaseVoiceDictionary | null;
  // Ролик, по которому сейчас идёт разбор моделью. Живёт в состоянии, а не во
  // вкладке: разбор идёт минутами, и вернувшийся на страницу человек должен
  // увидеть «разбираю», а не пустой план.
  analyzing: string;
}

export const useShowcaseStore = defineStore('showcase', {
  state: (): ShowcaseState => ({
    targets: [],
    projects: [],
    jobs: [],
    buildRuns: [],
    limits: {
      maxScenes: 0,
      maxSceneSeconds: 0,
      maxTotalSeconds: 0,
      retentionDays: 0,
    },
    opened: null,
    manifest: null,
    manifestProjectId: '',
    manifestId: '',
    manifestStatus: 'idle',
    loading: false,
    loaded: false,
    error: '',
    busyProjects: [],
    voices: null,
    voiceBusy: false,
    dictionary: null,
    analyzing: '',
  }),

  getters: {
    // В форму попадают все известные цели, но выбрать можно только ту, которую
    // сервер уже связал с живым адресом и профилем.
    readyTargets(state): ShowcaseOverview['targets'] {
      return state.targets.filter((target) => target.status === 'ready');
    },

    // Задания, которые ещё идут: по ним показывается прогресс и кнопка отмены.
    activeJobs(state): ShowcaseJob[] {
      return state.jobs.filter((job) => (
        job.state === 'queued' || job.state === 'running' || job.state === 'cancelling'
      ));
    },

    jobsOf(state) {
      return (projectId: string): ShowcaseJob[] => state.jobs.filter(
        (job) => job.projectId === projectId,
      );
    },

    buildRunsOf(state) {
      return (projectId: string): ShowcaseBuildRun[] => state.buildRuns.filter(
        (run) => run.projectId === projectId,
      );
    },

    latestBuildOf(state) {
      return (projectId: string): ShowcaseBuildRun | null => [...state.buildRuns]
        .filter((run) => run.projectId === projectId)
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0] ?? null;
    },

    activeBuildOf(state) {
      return (projectId: string): ShowcaseBuildRun | null => state.buildRuns.find(
        (run) => run.projectId === projectId && ACTIVE_BUILD_STATES.has(run.state),
      ) ?? null;
    },

    currentManifest(state): ShowcaseFinalManifest | null {
      const final = state.opened?.latestFinal;

      if (
        state.manifestStatus !== 'ready'
        || final?.manifestVersion !== 1
        || state.manifestProjectId !== state.opened?.id
        || state.manifestId !== final.manifestId
      ) {
        return null;
      }

      return state.manifest;
    },

    // Ролики, которым нужен человек: цель отвалилась или задание встало. Их видно
    // в списке отдельно, потому что дальше без решения работа не пойдёт.
    blockedProjects(state): ShowcaseProjectSummary[] {
      return state.projects.filter((project) => project.state === 'blocked');
    },

    isBusy(state) {
      return (projectId: string): boolean => state.busyProjects.includes(projectId)
        || state.buildRuns.some((run) => (
          run.projectId === projectId && ACTIVE_BUILD_STATES.has(run.state)
        ));
    },
  },

  actions: {
    /**
     * Обзор заменяется целиком: пропавший из ответа ролик — это удалённый ролик,
     * и склейка со старым составом показывала бы призраков.
     */
    setOverview(overview: ShowcaseOverview) {
      this.targets = overview.targets;
      this.projects = overview.projects;
      this.jobs = mergeBySequence(this.jobs, overview.jobs);
      this.buildRuns = mergeBySequence(
        this.buildRuns,
        overview.buildRuns ?? [],
        (run) => ACTIVE_BUILD_STATES.has(run.state),
      );
      this.limits = overview.limits;
      this.loaded = true;
    },

    /**
     * Открытый проект может сменить финальный manifest после любого задания.
     * Кэш шкалы сохраняется только для ровно того же проекта и manifestId.
     */
    setOpened(project: ShowcaseProject | null) {
      this.opened = project;

      const final = project?.latestFinal;
      const sameManifest = final?.manifestVersion === 1
        && this.manifestProjectId === project?.id
        && this.manifestId === final.manifestId;

      if (!sameManifest) {
        this.manifest = null;
        this.manifestProjectId = '';
        this.manifestId = '';
        this.manifestStatus = 'idle';
      }
    },

    /**
     * Обновление задания по событию. Сообщение с меньшим номером — отчёт прошлой
     * попытки, доехавший позже: он не должен возвращать на экран старый статус.
     */
    applyJob(job: ShowcaseJob) {
      const known = this.jobs.find((item) => item.id === job.id);

      if (known && known.sequence >= job.sequence) {
        return true;
      }

      if (known && job.sequence !== known.sequence + 1) {
        return false;
      }

      const rest = this.jobs.filter((item) => item.id !== job.id);

      this.jobs = [job, ...rest];

      return true;
    },

    /** Полный snapshot запуска из POST/GET подчиняется тому же sequence, что SSE. */
    applyBuildRun(run: ShowcaseBuildRun) {
      const known = this.buildRuns.find((item) => item.id === run.id);

      if (known && known.sequence > run.sequence) {
        return;
      }

      this.buildRuns = [run, ...this.buildRuns.filter((item) => item.id !== run.id)];
    },

    /**
     * Краткое SSE-событие обновляет известный run и никогда не откатывает snapshot.
     * Дыра в sequence просит наблюдателя перечитать полный overview.
     */
    applyBuildProgress(event: ShowcaseBuildProgressEvent): boolean {
      const known = this.buildRuns.find((item) => item.id === event.runId);

      if (!known) {
        return false;
      }

      if (known.sequence >= event.sequence) {
        return true;
      }

      // Краткий SSE не содержит children, cancelRequested и времён. При дыре
      // склеивать новый state со старым snapshot нельзя — наблюдатель перечитает
      // полный overview.
      if (event.sequence !== known.sequence + 1) {
        return false;
      }

      this.applyBuildRun({
        ...known,
        state: event.state,
        sequence: event.sequence,
        stage: event.stage,
        error: event.error,
      });

      return true;
    },

    /**
     * Начало чтения очищает предыдущую шкалу до ответа сети. Идентификаторы не дают
     * запоздавшему ответу от прежнего ролика попасть в новый открытый проект.
     */
    beginManifestLoad(projectId: string, manifestId: string) {
      this.manifest = null;
      this.manifestProjectId = projectId;
      this.manifestId = manifestId;
      this.manifestStatus = 'loading';
    },

    setManifest(projectId: string, manifestId: string, manifest: ShowcaseFinalManifest) {
      if (this.manifestProjectId !== projectId || this.manifestId !== manifestId) {
        return;
      }

      this.manifest = manifest;
      this.manifestStatus = 'ready';
    },

    failManifestLoad(projectId: string, manifestId: string) {
      if (this.manifestProjectId !== projectId || this.manifestId !== manifestId) {
        return;
      }

      this.manifest = null;
      this.manifestStatus = 'failed';
    },

    setVoices(catalog: ShowcaseVoiceCatalog | null) {
      this.voices = catalog;
    },

    setVoiceBusy(value: boolean) {
      this.voiceBusy = value;
    },

    setDictionary(dictionary: ShowcaseVoiceDictionary | null) {
      this.dictionary = dictionary;
    },

    setAnalyzing(projectId: string) {
      this.analyzing = projectId;
    },

    setLoading(value: boolean) {
      this.loading = value;
    },

    setError(message: string) {
      this.error = message;
    },

    // Занятость ролика держит кнопки его карточки, пока идёт действие.
    setBusy(projectId: string, busy: boolean) {
      const rest = this.busyProjects.filter((item) => item !== projectId);

      this.busyProjects = busy ? [...rest, projectId] : rest;
    },
  },
});

export default useShowcaseStore;

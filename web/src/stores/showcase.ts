// Состояние раздела «Презентации» и ничего больше: сюда попадает уже проверенный
// контрактом обзор, а как он добыт — дело слоя операций (`actions/showcase`).
// Стор не знает ни путей `/api`, ни событий сервера, ни текстов отказа: иначе
// смена транспорта тянула бы за собой правку состояния.
import { defineStore } from 'pinia';
import type {
  ShowcaseJob,
  ShowcaseOverview,
  ShowcaseProject,
  ShowcaseProjectSummary,
  ShowcaseTargetProfile,
  ShowcaseVoiceCatalog,
} from '../../../shared/showcaseContracts';

interface ShowcaseState {
  profiles: ShowcaseTargetProfile[];
  projects: ShowcaseProjectSummary[];
  jobs: ShowcaseJob[];
  limits: ShowcaseOverview['limits'];
  opened: ShowcaseProject | null;
  loading: boolean;
  loaded: boolean;
  error: string;
  busyProjects: string[];
  // Голоса приходят отдельным снимком: они общие для всех роликов и меняются
  // редко — установкой, а не правкой сцен.
  voices: ShowcaseVoiceCatalog | null;
  voiceBusy: boolean;
}

export const useShowcaseStore = defineStore('showcase', {
  state: (): ShowcaseState => ({
    profiles: [],
    projects: [],
    jobs: [],
    limits: {
      maxScenes: 0,
      maxSceneSeconds: 0,
      maxTotalSeconds: 0,
      retentionDays: 0,
    },
    opened: null,
    loading: false,
    loaded: false,
    error: '',
    busyProjects: [],
    voices: null,
    voiceBusy: false,
  }),

  getters: {
    // Цель показа выбирается только среди профилей, объявивших контракт: остальные
    // видно в форме с причиной, но выбрать их нельзя.
    readyProfiles(state): ShowcaseTargetProfile[] {
      return state.profiles.filter((profile) => profile.ready);
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

    // Ролики, которым нужен человек: цель отвалилась или задание встало. Их видно
    // в списке отдельно, потому что дальше без решения работа не пойдёт.
    blockedProjects(state): ShowcaseProjectSummary[] {
      return state.projects.filter((project) => project.state === 'blocked');
    },

    isBusy(state) {
      return (projectId: string): boolean => state.busyProjects.includes(projectId);
    },
  },

  actions: {
    /**
     * Обзор заменяется целиком: пропавший из ответа ролик — это удалённый ролик,
     * и склейка со старым составом показывала бы призраков.
     */
    setOverview(overview: ShowcaseOverview) {
      this.profiles = overview.profiles;
      this.projects = overview.projects;
      this.jobs = overview.jobs;
      this.limits = overview.limits;
      this.loaded = true;
    },

    setOpened(project: ShowcaseProject | null) {
      this.opened = project;
    },

    /**
     * Обновление задания по событию. Сообщение с меньшим номером — отчёт прошлой
     * попытки, доехавший позже: он не должен возвращать на экран старый статус.
     */
    applyJob(job: ShowcaseJob) {
      const known = this.jobs.find((item) => item.id === job.id);

      if (known && known.sequence >= job.sequence) {
        return;
      }

      const rest = this.jobs.filter((item) => item.id !== job.id);

      this.jobs = [job, ...rest];
    },

    setVoices(catalog: ShowcaseVoiceCatalog | null) {
      this.voices = catalog;
    },

    setVoiceBusy(value: boolean) {
      this.voiceBusy = value;
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

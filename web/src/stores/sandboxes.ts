// Состояние раздела «Песочницы» и ничего больше: сюда попадает уже проверенный
// контрактом обзор, а как он добыт — дело слоя операций (`actions/sandboxes`).
// Стор не знает ни путей `/api`, ни событий сервера, ни текстов отказа: иначе
// смена транспорта тянула бы за собой правку состояния.
import { defineStore } from 'pinia';
import type {
  SandboxEntry,
  SandboxJob,
  SandboxOverview,
  SandboxProfile,
} from '../../../shared/plugins/sandboxes/sandboxContracts';

interface SandboxesState {
  profiles: SandboxProfile[];
  sandboxes: SandboxEntry[];
  jobs: SandboxJob[];
  manualRange: {
    from: number;
    to: number;
  };
  loading: boolean;
  loaded: boolean;
  error: string;
  busyTasks: string[];
}

export const useSandboxesStore = defineStore('sandboxes', {
  state: (): SandboxesState => ({
    profiles: [],
    sandboxes: [],
    jobs: [],
    manualRange: {
      from: 0,
      to: 0,
    },
    loading: false,
    loaded: false,
    error: '',
    busyTasks: [],
  }),

  getters: {
    // Поднять стенд можно только профилем, который объявил свои up.sh и down.sh.
    capableProfiles(state): SandboxProfile[] {
      return state.profiles.filter((profile) => profile.canRaise);
    },

    // Ручные стенды — то, чем этот раздел управляет; стенды конвейера показываются
    // отдельно и только для сведения.
    manualSandboxes(state): SandboxEntry[] {
      return state.sandboxes.filter((entry) => entry.owner === 'manual');
    },

    pipelineSandboxes(state): SandboxEntry[] {
      return state.sandboxes.filter((entry) => entry.owner === 'pipeline');
    },

    jobOf(state) {
      return (task: string): SandboxJob | null => state.jobs.find((job) => job.task === task) || null;
    },

    // Задания стендов, которых в реестре уже нет: итог сноса и причина упавшего
    // подъёма иначе исчезли бы с экрана вместе с карточкой.
    orphanJobs(state): SandboxJob[] {
      const known = new Set(state.sandboxes.map((entry) => entry.task));

      return state.jobs.filter((job) => !known.has(job.task));
    },

    isBusy(state) {
      return (task: string): boolean => state.busyTasks.includes(task);
    },
  },

  actions: {
    /**
     * Обзор заменяется целиком: пропавший из ответа стенд — это снесённый стенд,
     * и склейка со старым составом показывала бы призраков.
     */
    setOverview(overview: SandboxOverview) {
      this.profiles = overview.profiles;
      this.sandboxes = overview.sandboxes;
      this.jobs = overview.jobs;
      this.manualRange = overview.manualRange;
      this.loaded = true;
    },

    /**
     * Прогресс обновляет только своё задание: перечитывать весь обзор на каждый шаг
     * подъёма незачем, а шаги идут все пятнадцать минут.
     */
    applyJob(job: SandboxJob) {
      const rest = this.jobs.filter((item) => item.task !== job.task);

      this.jobs = [...rest, job].sort((left, right) => Number(left.task) - Number(right.task));
    },

    setLoading(value: boolean) {
      this.loading = value;
    },

    setError(message: string) {
      this.error = message;
    },

    // Занятость стенда держит кнопки его карточки, пока идёт подъём или снос.
    setBusy(task: string, busy: boolean) {
      const rest = this.busyTasks.filter((item) => item !== task);

      this.busyTasks = busy ? [...rest, task] : rest;
    },
  },
});

export default useSandboxesStore;

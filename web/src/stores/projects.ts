// Состояние раздела «Проекты» и ничего больше: сюда попадают уже проверенные
// контрактом сводки и паспорт, а как они добыты — дело слоя операций
// (`actions/projects`). Стор не знает ни путей `/api`, ни событий сервера, ни текстов
// отказа: иначе смена транспорта тянула бы за собой правку состояния.
import { defineStore } from 'pinia';
import type {
  ProjectDependencies,
  ProjectDetail,
  ProjectSummary,
} from '../../../shared/runtime/projectsContracts';
import type { ProjectDraft } from '../views/projects/projectDraft';

/** Расхождение ревизий: что показать человеку, прежде чем он решит, чья версия новее. */
export interface ProjectConflict {
  currentRevision: number;
  changedFields: string[];
}

/** Последняя проверка пути: состояние строки и текст для человека. */
export interface ProjectCheckState {
  state: string;
  message: string;
}

interface ProjectsState {
  items: ProjectSummary[];
  opened: ProjectDetail | null;
  draft: ProjectDraft | null;
  conflict: ProjectConflict | null;
  loading: boolean;
  error: string;
  checks: Record<string, ProjectCheckState>;
  // Связи открытого проекта: форма показывает их перед архивом.
  dependencies: ProjectDependencies | null;
}

export const useProjectsStore = defineStore('projects', {
  state: (): ProjectsState => ({
    items: [],
    opened: null,
    draft: null,
    conflict: null,
    loading: false,
    error: '',
    checks: {},
    dependencies: null,
  }),

  getters: {},

  actions: {
    setItems(items: ProjectSummary[]) {
      this.items = items;
    },

    setOpened(detail: ProjectDetail | null) {
      this.opened = detail;
    },

    setDraft(draft: ProjectDraft | null) {
      this.draft = draft;
    },

    setConflict(conflict: ProjectConflict | null) {
      this.conflict = conflict;
    },

    setLoading(loading: boolean) {
      this.loading = loading;
    },

    setError(message: string) {
      this.error = message;
    },

    setDependencies(dependencies: ProjectDependencies | null) {
      this.dependencies = dependencies;
    },

    setCheck(dir: string, check: ProjectCheckState) {
      this.checks = { ...this.checks, [dir]: check };
    },

    clearChecks() {
      this.checks = {};
    },
  },
});

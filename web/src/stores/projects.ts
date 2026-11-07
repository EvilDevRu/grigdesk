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
import { createDraft, isDirty } from '../views/projects/projectDraft';
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
  deletedIds: Set<string>;
  opened: ProjectDetail | null;
  draft: ProjectDraft | null;
  conflict: ProjectConflict | null;
  loaded: boolean;
  loading: boolean;
  error: string;
  checks: Record<string, ProjectCheckState>;
  // Связи открытого проекта: форма показывает их перед архивом.
  dependencies: ProjectDependencies | null;
}

export const useProjectsStore = defineStore('projects', {
  state: (): ProjectsState => ({
    items: [],
    deletedIds: new Set(),
    opened: null,
    draft: null,
    conflict: null,
    loaded: false,
    loading: false,
    error: '',
    checks: {},
    dependencies: null,
  }),

  getters: {},

  actions: {
    setItems(items: ProjectSummary[]) {
      this.items = items;
      this.loaded = true;
    },

    /**
     * Удалённый паспорт больше не служит выбором; локальные правки остаются для чтения.
     * Каталог и связанные проверки очищаются вместе, без обращения к сети.
     */
    removeRegistration(id: string) {
      this.deletedIds.add(id);
      this.items = this.items.filter((item) => item.id !== id);

      if (this.opened?.id !== id) {
        return;
      }

      const dirty = this.draft && isDirty(this.draft, createDraft(this.opened));

      this.opened = null;
      this.draft = dirty ? this.draft : null;
      this.dependencies = null;
      this.conflict = null;
      this.checks = {};
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

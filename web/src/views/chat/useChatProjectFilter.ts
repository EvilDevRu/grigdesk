import { computed, ref, watch, watchEffect } from 'vue';
import type { Ref } from 'vue';
import { useProjectsStore, loadProjects, watchProjects } from '../../actions/projects/index.ts';
import { useAuthStore } from '../../stores/auth.ts';
import { useShellStore } from '../../stores/shell.ts';

/**
 * Readiness следует принятому общему каталогу, а не завершению произвольного запроса.
 * Ошибка/вытеснение чтения не теряют автоматическое восстановление через общий SSE.
 */
export function useChatProjectFilter(supported: Ref<boolean>) {
  const projects = useProjectsStore();
  const auth = useAuthStore();
  const shell = useShellStore();
  const selectedProject = ref('');
  const ready = ref(false);
  const owner = computed(() => JSON.stringify([shell.profile?.id || 'origin', auth.clientScope]));
  const storageKey = computed(() => `chat.list.project:${owner.value}`);

  watchProjects();

  function allowed(value: string): boolean {
    return value === '' || value === '@none' || projects.items.some((item) => item.id === value);
  }

  /**
   * Восстанавливает выбор после принятия каталога для текущего подключения.
   * Повреждённое или недоступное хранилище оставляет общий список.
   */
  function read(): string {
    try {
      const value = localStorage.getItem(storageKey.value) || '';

      return allowed(value) ? value : '';
    } catch {
      return '';
    }
  }

  async function retryProjects(): Promise<void> {
    await loadProjects();
  }

  // Новый запрос синхронно повышает общий listRequest до возможного приёма старого ответа.
  // Наблюдатель ниже дождётся принятого снимка, даже если этот запрос вытеснит hello.
  watch([owner, supported], () => {
    ready.value = false;
    selectedProject.value = '';

    if (supported.value) {
      void retryProjects();
    }
  }, { immediate: true, flush: 'sync' });

  watchEffect(() => {
    if (!supported.value) {
      return;
    }

    if (projects.deletedIds.has(selectedProject.value)) {
      selectedProject.value = '';
    }

    if (!projects.loaded || projects.loading || projects.error) {
      return;
    }

    if (!ready.value) {
      ready.value = true;
      selectedProject.value = read();
    } else if (!allowed(selectedProject.value)) {
      selectedProject.value = '';
    }
  });

  watch(selectedProject, (value) => {
    if (!supported.value || !ready.value) {
      return;
    }

    try {
      localStorage.setItem(storageKey.value, value);
    } catch {
      // Закрытый storage не блокирует навигацию текущего окна.
    }
  });

  function selectProject(value: string): void {
    if (supported.value && ready.value && allowed(value)) {
      selectedProject.value = value;
    }
  }

  const projectItems = computed(() => ready.value ? [...projects.items].sort((left, right) =>
    Number(Boolean(left.archivedAt)) - Number(Boolean(right.archivedAt)) || left.id.localeCompare(right.id),
  ) : []);

  return {
    projects,
    projectItems,
    selectedProject,
    selectProject,
    retryProjects,
    ready,
  };
}

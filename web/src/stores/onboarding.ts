import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';

import type { OnboardingDraft, OnboardingState } from '../../../shared/runtime/onboardingContracts.ts';
import { useAuthStore } from './auth.ts';
import { useShellStore } from './shell.ts';
import { readOnboarding, writeOnboarding } from '../shared/onboardingApi.ts';

/**
 * Одна очередь объединяет свежие ответы за текущим PATCH и перед переходом ждёт ACK.
 * Поколение подключения отделяет владельцев и запрещает применение позднего ответа.
 */
export const useOnboardingStore = defineStore('onboarding', () => {
  const auth = useAuthStore();
  const shell = useShellStore();
  const snapshot = ref<OnboardingState | null>(null);
  const draft = ref<OnboardingDraft | null>(null);
  const dirty = ref(false);
  const saving = ref(false);
  const busy = ref(false);
  const error = ref<'read' | 'save' | null>(null);
  const scope = computed(() => auth.ready && auth.authenticated && shell.initialized
    && (!shell.present || (shell.profile && shell.status === 'online'))
    ? `${auth.clientScope}:${shell.profile?.id ?? 'browser'}` : '');
  let generation = 0;
  let edits = 0;
  let pending: Promise<void> | null = null;

  watch(scope, () => {
    generation += 1;
    edits = 0;
    pending = null;
    snapshot.value = null;
    draft.value = null;
    dirty.value = false;
    saving.value = false;
    busy.value = false;
    error.value = null;
  }, { flush: 'sync' });

  /**
   * Подтверждённая ревизия не откатывается ни GET, ни событием от другого окна.
   * Локальный черновик сохраняется, пока очередь не подтвердила последнюю правку.
   */
  function accept(value: OnboardingState, replaceDraft: boolean): void {
    if (snapshot.value && value.revision < snapshot.value.revision) {
      return;
    }

    snapshot.value = value;

    if (replaceDraft) {
      draft.value = value.active ? structuredClone(value.active.draft) : null;
    }
  }

  /**
   * Фоновое чтение допускается только в готовом scope, без перезаписи несохранённого.
   * Ошибка автопроверки хранится локально и не создаёт тост на обычной странице.
   */
  async function load(): Promise<OnboardingState | null> {
    const epoch = generation;

    if (!scope.value) {
      return null;
    }

    try {
      const state = await readOnboarding();

      if (epoch !== generation) {
        return null;
      }

      if (!dirty.value && !busy.value && !saving.value) {
        accept(state, true);
        error.value = null;
      }

      return state;
    } catch {
      if (epoch === generation) {
        error.value = 'read';
      }

      return null;
    }
  }

  /**
   * Изменения сразу ставятся в очередь; за текущим запросом остаётся свежий draft.
   * Отказ сохраняет ввод и прекращает переходы до явного перечитывания человеком.
   */
  function queueSave(): Promise<void> {
    if (pending) {
      return pending;
    }

    const epoch = generation;
    const run = (async () => {
      saving.value = true;

      try {
        while (epoch === generation && dirty.value && !error.value) {
          const state = snapshot.value;
          const version = edits;

          if (!state?.active || !draft.value || !scope.value) {
            return;
          }

          const saved = await writeOnboarding('', {
            expectedRevision: state.revision,
            sessionId: state.active.id,
            draft: JSON.parse(JSON.stringify(draft.value)),
          }, true);

          if (epoch !== generation) {
            return;
          }

          const latest = version === edits;

          accept(saved, latest);
          dirty.value = !latest;
        }
      } catch {
        if (epoch === generation) {
          error.value = 'save';
        }
      } finally {
        if (epoch === generation) {
          saving.value = false;
          pending = null;
        }
      }
    })();

    pending = run;

    return run;
  }

  /**
   * Форма передаёт копию всего draft, сохраняя поля соседних строк и режим.
   * Шаг и служебные идентификаторы никогда не изменяются оптимистически.
   */
  function update(value: OnboardingDraft): void {
    draft.value = value;
    dirty.value = true;
    edits += 1;

    if (!error.value) {
      void queueSave();
    }
  }

  /**
   * Flush служит барьером перед переходом, входом в CLI и выходом из мастера.
   * Ошибка либо смена подключения не выдают неподтверждённый draft за сохранённый.
   */
  async function flush(): Promise<boolean> {
    await pending;

    if (dirty.value && !error.value) {
      await queueSave();
    }

    return Boolean(scope.value) && !dirty.value && !error.value;
  }

  /**
   * Все переходы берут токен из последнего ACK после завершения очереди autosave.
   * Ответ старого scope не меняет страницу и не восстанавливает личные ответы.
   */
  async function transition(suffix: string, extra: Record<string, unknown> = {}): Promise<boolean> {
    if (busy.value || !await flush() || !snapshot.value?.active) {
      return false;
    }

    const epoch = generation;
    const state = snapshot.value;

    busy.value = true;

    try {
      const result = await writeOnboarding(suffix, {
        expectedRevision: state.revision,
        sessionId: state.active!.id,
        ...extra,
      });

      if (epoch !== generation) {
        return false;
      }

      accept(result, true);

      return true;
    } catch {
      if (epoch === generation) {
        error.value = 'save';
      }

      return false;
    } finally {
      if (epoch === generation) {
        busy.value = false;
      }
    }
  }

  /**
   * Автоматический start вызывается только host после явного серверного допуска.
   * Ручной start продолжает active или создаёт следующий проход после terminal.
   */
  async function start(mode: 'auto' | 'manual'): Promise<boolean> {
    const state = snapshot.value ?? await load();
    const epoch = generation;

    if (!state || !scope.value) {
      return false;
    }

    busy.value = true;

    try {
      const result = await writeOnboarding('/start', { expectedRevision: state.revision, mode });

      if (epoch !== generation) {
        return false;
      }

      accept(result, true);
      error.value = null;

      return result.open === true;
    } catch {
      if (epoch === generation) {
        error.value = 'read';
      }

      return false;
    } finally {
      if (epoch === generation) {
        busy.value = false;
      }
    }
  }

  /**
   * Явное перечитывание отбрасывает неподтверждённые правки по выбору человека.
   * Автоматическое событие этой операцией никогда не пользуется.
   */
  async function reload(): Promise<void> {
    await pending;
    dirty.value = false;
    error.value = null;
    await load();
  }

  return {
    snapshot,
    draft,
    dirty,
    saving,
    busy,
    error,
    scope,
    load,
    update,
    flush,
    transition,
    start,
    reload,
  };
});

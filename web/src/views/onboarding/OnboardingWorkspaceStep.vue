<template>
  <section v-if="store.draft" class="workspace-options">
    <h2>{{ t('core.onboardingChooseWorkspace') }}</h2>
    <UiRadioGroup :label="t('core.onboardingWorkspace')" @keydown="moveOption">
      <div v-for="mode in modes" :key="mode" class="workspace-option">
        <UiButton wrap role="radio" :aria-checked="store.draft.workspace.mode === mode"
          :tabindex="store.draft.workspace.mode === mode ? 0 : -1" variant="outline"
          :tone="store.draft.workspace.mode === mode ? 'accent' : 'neutral'"
          @click="setMode(mode)">
          {{ t(mode === 'isolated' ? 'core.onboardingIsolated' : 'core.onboardingShared') }}
        </UiButton>
        <p>{{ t(mode === 'isolated' ? 'core.onboardingIsolatedHelp' : 'core.onboardingSharedHelp') }}</p>
      </div>
    </UiRadioGroup>
    <template v-if="store.draft.workspace.mode === 'shared'">
      <UiInlineMessage v-for="repo in different" :key="repo.name" tone="warning">
        {{ t('core.onboardingBranchDifference', {
          selected: repo.baseBranch ?? '', current: currentBranches[repo.name] ?? '',
        }) }}
      </UiInlineMessage>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import { t, UiButton, UiRadioGroup, UiInlineMessage } from '../../ui';
import { useOnboardingStore } from '../../stores/onboarding.ts';
import { inspectOnboardingRepository } from '../../shared/onboardingApi.ts';

const store = useOnboardingStore();
const modes = ['isolated', 'shared'] as const;
const currentBranches = ref<Record<string, string | null>>({});
const different = computed(() => store.draft?.repositories.filter((repo) =>
  repo.name in currentBranches.value && currentBranches.value[repo.name] !== repo.baseBranch) ?? []);

/**
 * Выбор сохраняет лишь ответ будущего профиля и не переключает рабочую ветку.
 * Паспорт проекта остаётся редактируемым через прежнюю форму «Проекты».
 */
function setMode(mode: 'isolated' | 'shared'): void {
  if (store.draft) {
    store.update({ ...store.draft, workspace: { mode } });
  }
}

/**
 * Варианты образуют одну клавиатурную группу с единственной точкой входа Tab.
 * Стрелки выбирают соседний режим и сохраняют фокус на выбранном действии.
 */
function moveOption(event: KeyboardEvent): void {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
    return;
  }

  event.preventDefault();

  const mode = event.key === 'Home' ? 'isolated' : event.key === 'End' ? 'shared'
    : store.draft?.workspace.mode === 'isolated' ? 'shared' : 'isolated';

  setMode(mode);

  const group = event.currentTarget as HTMLElement;
  const buttons = group.querySelectorAll<HTMLButtonElement>('[role="radio"]');

  buttons[mode === 'isolated' ? 0 : 1]?.focus();
}

onMounted(async () => {
  const scope = store.scope;
  const session = store.snapshot?.active?.id;

  for (const repo of store.draft?.repositories ?? []) {
    try {
      const inspection = await inspectOnboardingRepository(repo.source);

      if (store.scope === scope && store.snapshot?.active?.id === session) {
        currentBranches.value[repo.name] = inspection.currentBranch;
      }
    } catch {
      // Ответы уже сохранены; отказ чтения не превращается в изменение Git.
      // Строгая проверка ветки выполнена перед созданием паспорта.
    }
  }
});
</script>

<style scoped>
.workspace-options {
  display: grid;
  gap: 16px;
}
</style>

<template>
  <section v-if="store.draft" class="workspace-options">
    <header class="onboarding-section-head">
      <h2 tabindex="-1">{{ t('core.onboardingChooseWorkspace') }}</h2>
      <p class="onboarding-description">{{ t('core.onboardingWorkspaceHelp') }}</p>
    </header>
    <UiInlineMessage v-if="!store.snapshot?.active?.projectSaved" tone="warning">
      {{ t('core.onboardingWorkspaceNeedsProject') }}
    </UiInlineMessage>
    <UiRadioGroup class="workspace-modes" :label="t('core.onboardingWorkspace')" @keydown="moveOption">
      <div v-for="mode in modes" :key="mode" class="workspace-option"
        :class="{ 'is-selected': store.draft.workspace.mode === mode }">
        <div class="workspace-option-heading">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path v-if="mode === 'isolated'" d="M9 3H4v5m5 13H4v-5M4 8h5v8H4M15 7h5v10h-5zM9 12h6" />
            <path v-else d="M3 7V5h7l2 2h9v12H3zM3 10h18" />
          </svg>
          <span v-if="mode === 'isolated'" class="workspace-recommended">
            {{ t('core.onboardingRecommended') }}
          </span>
        </div>
        <UiButton data-context="workspace-form-wrap" block role="radio" :aria-checked="store.draft.workspace.mode === mode"
          :aria-describedby="`workspace-${mode}-help`"
          :tabindex="store.draft.workspace.mode === mode ? 0 : -1" variant="outline"
          :tone="store.draft.workspace.mode === mode ? 'accent' : 'neutral'"
          @click="setMode(mode)">
          {{ t(mode === 'isolated' ? 'core.onboardingIsolated' : 'core.onboardingShared') }}
        </UiButton>
        <p :id="`workspace-${mode}-help`">{{ t(mode === 'isolated'
          ? 'core.onboardingIsolatedHelp' : 'core.onboardingSharedHelp') }}</p>
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
    if (!repo.source.trim()) {
      continue;
    }

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
  gap: 12px;
}

.workspace-modes {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr));
  gap: 12px;
}

.workspace-option {
  min-width: 0;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface);
}

.workspace-option.is-selected {
  border-color: color-mix(in srgb, var(--accent) 60%, var(--line));
}

.workspace-option-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  min-height: 20px;
  margin-bottom: 10px;
  color: var(--ink-mid);
}

.workspace-recommended {
  color: var(--accent);
  font-size: 12px;
}

.workspace-option p {
  margin: 8px 0 0;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.5;
}
</style>

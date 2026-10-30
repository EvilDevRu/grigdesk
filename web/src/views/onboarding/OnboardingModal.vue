<template>
  <UiDialog :open="store.isOpen" size="workspace" :label="t('core.onboardingOpen')"
    :body-inset="false" :busy="busy" data-role="onboarding-modal"
    data-ui-workspace @close="requestClose">
    <template #header>
      <div class="onboarding-heading">
        <h1>{{ t('core.onboardingOpen') }}</h1>
        <UiIconButton :label="t('core.close')" :disabled="busy" @click="requestClose">
          <span aria-hidden="true">×</span>
        </UiIconButton>
      </div>
    </template>
    <div class="onboarding-layout" :inert="busy || undefined">
      <aside class="onboarding-sidebar">
        <p class="onboarding-sidebar-title">{{ t('core.onboardingBaseGroup') }}</p>
        <ol class="onboarding-steps" :aria-label="t('core.onboardingSteps')">
          <li v-for="(label, index) in labels" :key="label"
            :class="{ 'is-complete': index < currentIndex, 'is-skipped': index === 0 && session?.aiSkipped }"
            :aria-current="index === currentIndex && index < 3 ? 'step' : undefined"
            :aria-disabled="index > 2 ? 'true' : undefined">
            <span v-if="index === 3" class="onboarding-future-heading">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="5" y="10" width="14" height="11" rx="2" />
                <path d="M8 10V7a4 4 0 0 1 8 0v3" />
              </svg>
              {{ t('core.onboardingNextGroup') }}
            </span>
            <span class="onboarding-step-number" aria-hidden="true">
              {{ index === 0 && session?.aiSkipped ? '−' : index < currentIndex ? '✓' : index + 1 }}
            </span>
            <span class="onboarding-step-copy">
              <span class="onboarding-step-label">{{ label }}<span v-if="index === 0 && session?.aiSkipped"
                class="onboarding-step-skipped"> — {{ t('core.onboardingSkipped') }}</span></span>
              <span v-if="index < 3" class="onboarding-step-detail">{{ descriptions[index] }}</span>
            </span>
          </li>
        </ol>
        <p class="onboarding-sidebar-note">{{ t('core.onboardingFutureHelp') }}</p>
      </aside>
      <div ref="content" class="onboarding-content">
        <p v-if="session" class="onboarding-progress">
          {{ session.step === 'summary' ? t('core.onboardingBaseComplete')
            : t('core.onboardingStepCount', { current: currentIndex + 1, total: 3 }) }}
        </p>
        <UiInlineMessage v-if="store.error" tone="warning">
          {{ t(store.error === 'save' ? 'core.onboardingSaveFailed' : 'core.onboardingReadFailed') }}
          <UiButton data-context="workspace-form-wrap" @click="store.reload()">
            {{ t('core.onboardingReload') }}
          </UiButton>
        </UiInlineMessage>
        <template v-if="!store.opening && session && store.draft">
          <OnboardingAiStep v-if="session.step === 'ai'" @ready="aiReady = $event" />
          <OnboardingProjectStep v-else-if="session.step === 'project'" @ready="projectReady = $event" />
          <OnboardingWorkspaceStep v-else-if="session.step === 'workspace'" />
          <OnboardingSummary v-else />
        </template>
        <UiLoadingState v-else-if="!store.error" variant="cards" :label="t('core.onboardingLoading')"
          show-label />
      </div>
    </div>
    <template #footer>
      <div class="onboarding-footer">
        <p v-if="session && store.draft && !store.error" class="onboarding-save"
          :class="{ 'is-saving': store.saving || store.dirty }" aria-live="polite">
          <span aria-hidden="true">{{ store.saving || store.dirty ? '·' : '✓' }}</span>
          {{ t(store.saving || store.dirty ? 'core.onboardingSaving' : 'core.onboardingSaved') }}
        </p>
        <div v-if="session && store.draft" class="onboarding-actions">
          <UiButton data-context="workspace-form-wrap" :disabled="busy" variant="ghost" @click="dismiss">
            {{ t('core.onboardingDismiss') }}
          </UiButton>
          <UiButton v-if="session.step === 'ai'" data-context="workspace-form-wrap"
            :disabled="busy || !!store.error" variant="ghost"
            @click="store.transition('/advance', { skipAi: true })">
            {{ t('core.onboardingSkip') }}
          </UiButton>
          <UiButton v-if="session.status === 'active'" data-context="workspace-form-wrap"
            :disabled="!canAdvance" variant="solid" tone="accent" @click="store.transition('/advance')">
            {{ t('core.onboardingNext') }}
          </UiButton>
          <template v-else>
            <UiButton data-context="workspace-form-wrap" :disabled="busy" @click="another">
              {{ t('core.onboardingAnother') }}
            </UiButton>
            <UiButton data-context="workspace-form-wrap" variant="solid" tone="accent" @click="finish">
              {{ t('core.onboardingDone') }}
            </UiButton>
          </template>
        </div>
        <UiButton v-else-if="!store.opening" data-context="workspace-form-wrap" :disabled="busy"
          @click="another">{{ t('core.onboardingAnother') }}</UiButton>
      </div>
    </template>
  </UiDialog>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useRouter } from 'vue-router';

import {
  t, UiButton, UiDialog, UiIconButton, UiInlineMessage, UiLoadingState, confirmDialog,
} from '../../ui';
import type { UiDialogCloseReason } from '../../ui';
import { useOnboardingStore } from '../../stores/onboarding.ts';
import { openSettings } from '../../shared/settingsNavigation.ts';
import OnboardingAiStep from './OnboardingAiStep.vue';
import OnboardingProjectStep from './OnboardingProjectStep.vue';
import OnboardingWorkspaceStep from './OnboardingWorkspaceStep.vue';
import OnboardingSummary from './OnboardingSummary.vue';

const store = useOnboardingStore();
const router = useRouter();
const content = ref<HTMLElement | null>(null);
const closing = ref(false);
const aiReady = ref(false);
const projectReady = ref(false);
const session = computed(() => store.snapshot?.active);
const busy = computed(() => store.busy || store.opening || closing.value);
const labels = computed(() => [
  t('core.onboardingAi'), t('core.onboardingProject'), t('core.onboardingWorkspace'),
  t('core.onboardingAnalysis'), t('core.onboardingRoutes'), t('core.onboardingPipeline'),
]);
const descriptions = computed(() => [
  t('core.onboardingAiDetail'), t('core.onboardingProjectDetail'), t('core.onboardingWorkspaceDetail'),
]);
const currentIndex = computed(() => ['ai', 'project', 'workspace', 'summary']
  .indexOf(session.value?.step ?? ''));
const projectRoute = computed(() => session.value?.projectSaved
  ? `/projects/${session.value.projectId}` : '/projects');
const canAdvance = computed(() => !store.error && !busy.value && (session.value?.step === 'ai'
  ? aiReady.value : session.value?.step === 'project'
    ? projectReady.value || !!session.value.projectIntent : true));

watch(() => session.value?.step, async (step, previous) => {
  if (!previous || !step || step === previous) {
    return;
  }

  await nextTick();
  content.value?.scrollTo({ top: 0 });
  content.value?.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
});

/**
 * Крестик и Escape сохраняют ответы и возвращают к исходному разделу без отказа от мастера.
 * Неподтверждённый ввод можно отбросить только после общего подтверждения.
 */
async function requestClose(reason: UiDialogCloseReason | MouseEvent = 'action'): Promise<void> {
  if (reason === 'backdrop' || busy.value) {
    return;
  }

  closing.value = true;

  try {
    if (await store.close()) {
      return;
    }
  } finally {
    closing.value = false;
  }

  if (await confirmDialog(t('core.onboardingLeaveUnsaved'))) {
    store.hide();
  }
}

async function another(): Promise<void> {
  await store.start('manual');
}

async function finish(): Promise<void> {
  if (await store.close()) {
    await router.push(projectRoute.value);
  }
}

/**
 * Отказ подтверждается сервером до закрытия, затем открывается обычное место настройки.
 * Неуспешная запись оставляет окно с прежними ответами и причиной ошибки.
 */
async function dismiss(): Promise<void> {
  const ai = session.value?.step === 'ai';

  if (!await store.transition('/dismiss')) {
    return;
  }

  store.hide();
  await router.push(projectRoute.value);

  if (ai) {
    openSettings({ pageId: 'agents.providers' });
  }
}
</script>

<style scoped>
.onboarding-heading,
.onboarding-footer,
.onboarding-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.onboarding-heading {
  justify-content: space-between;
  width: 100%;
}

.onboarding-heading h1 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.onboarding-layout {
  display: grid;
  grid-template-columns: 224px minmax(0, 1fr);
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  overflow-wrap: anywhere;
  container-type: inline-size;
}

.onboarding-sidebar {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 16px 12px;
  overflow-y: auto;
  border-right: 1px solid var(--line);
  background: var(--sidebar);
}

.onboarding-sidebar-title,
.onboarding-progress {
  margin: 0 0 12px;
  color: var(--ink-low);
  font-size: 12px;
  font-weight: 500;
}

.onboarding-sidebar-title {
  margin-left: 8px;
}

.onboarding-steps {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
  flex: none;
}

.onboarding-steps li {
  position: relative;
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr);
  align-items: center;
  gap: 0 10px;
  min-width: 0;
  min-height: 52px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
}

.onboarding-step-number {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border: 1px solid var(--line-2);
  border-radius: var(--radius-round);
  color: var(--ink-mid);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.onboarding-step-copy {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.onboarding-step-label {
  font-size: var(--workspace-text-size);
  font-weight: 500;
  line-height: 20px;
}

.onboarding-step-detail {
  color: var(--ink-low);
  font-size: 12px;
  line-height: 1.5;
}

.onboarding-steps [aria-current] {
  background: color-mix(in srgb, var(--accent) 9%, transparent);
  color: var(--accent);
}

.onboarding-steps [aria-current]::before {
  content: '';
  position: absolute;
  top: 8px;
  bottom: 8px;
  left: 0;
  width: 2px;
  border-radius: var(--radius-sm);
  background: var(--accent);
}

.onboarding-steps [aria-current] .onboarding-step-number {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--ground);
}

.onboarding-steps .is-complete .onboarding-step-number {
  color: var(--good);
  border-color: color-mix(in srgb, var(--good) 35%, var(--line));
}

.onboarding-steps .is-skipped .onboarding-step-number,
.onboarding-step-skipped {
  color: var(--ink-mid);
}

.onboarding-steps .is-skipped .onboarding-step-number {
  border-color: var(--line-2);
}

.onboarding-steps [aria-disabled] {
  min-height: 36px;
  color: var(--ink-low);
}

.onboarding-steps li:nth-child(4) {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--line);
  border-radius: 0;
}

.onboarding-future-heading {
  display: flex;
  align-items: center;
  grid-column: 1 / -1;
  gap: 6px;
  margin-bottom: 12px;
  color: var(--ink-low);
  font-size: 12px;
  font-weight: 500;
}

.onboarding-sidebar-note {
  margin: auto 8px 0;
  padding-top: 16px;
  color: var(--ink-low);
  font-size: 12px;
  line-height: 1.5;
}

.onboarding-content {
  min-width: 0;
  min-height: 0;
  padding: 16px;
  overflow-y: auto;
}

.onboarding-content :deep(.onboarding-section-head) {
  margin-bottom: 16px;
}

.onboarding-content :deep(h2) {
  margin: 0 0 6px;
  font-size: 15px;
  font-weight: 600;
  line-height: 1.4;
}

.onboarding-content :deep(.onboarding-description) {
  margin: 0;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.5;
}

.onboarding-footer {
  flex-wrap: wrap;
  justify-content: space-between;
  width: 100%;
}

.onboarding-save {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  color: var(--ink-mid);
  font-size: 12px;
}

.onboarding-save span {
  color: var(--good);
}

.onboarding-save.is-saving span {
  color: var(--accent);
}

.onboarding-actions {
  flex-wrap: wrap;
  justify-content: flex-end;
  margin-left: auto;
}

@container (max-width: 660px) {
  .onboarding-sidebar {
    padding: 10px 12px;
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }

  .onboarding-steps {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .onboarding-step-detail,
  .onboarding-sidebar-title,
  .onboarding-future-heading,
  .onboarding-sidebar-note {
    display: none;
  }

  .onboarding-steps li,
  .onboarding-steps li:nth-child(4) {
    margin: 0;
    min-height: 0;
    padding: 4px;
    border: 0;
  }

  .onboarding-steps [aria-current]::before {
    display: none;
  }

  .onboarding-step-label {
    line-height: 1.5;
  }
}

@media (max-width: 700px) {
  .onboarding-layout {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
  }
}

@media (max-width: 400px) {
  .onboarding-steps {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .onboarding-content {
    padding: 12px;
  }
}
</style>

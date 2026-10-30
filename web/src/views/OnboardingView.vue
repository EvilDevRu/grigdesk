<template>
  <div class="onboarding-page ui-page" data-ui-workspace>
    <header class="onboarding-header">
      <div>
        <p class="onboarding-eyebrow">{{ t('core.onboardingOpen') }}</p>
        <h1>{{ t('core.onboardingTitle') }}</h1>
        <p class="onboarding-intro">{{ t('core.onboardingIntro') }}</p>
      </div>
      <p v-if="!initializing && session && store.draft && !store.error"
        class="onboarding-save" :class="{ 'is-saving': store.saving || store.dirty }" aria-live="polite">
        <span aria-hidden="true">{{ store.saving || store.dirty ? '·' : '✓' }}</span>
        {{ t(store.saving || store.dirty ? 'core.onboardingSaving' : 'core.onboardingSaved') }}
      </p>
    </header>
    <div class="onboarding-layout">
      <aside class="onboarding-sidebar">
        <p class="onboarding-sidebar-title">{{ t('core.onboardingSteps') }}</p>
        <ol class="onboarding-steps" :aria-label="t('core.onboardingSteps')">
          <li v-for="(label, index) in labels" :key="label"
            :class="{ 'is-complete': index < currentIndex, 'is-skipped': index === 0 && session?.aiSkipped }"
            :aria-current="index === currentIndex && index < 3 ? 'step' : undefined"
            :aria-disabled="index > 2 ? 'true' : undefined">
            <span class="onboarding-step-number" aria-hidden="true">
              {{ index === 0 && session?.aiSkipped ? '−' : index < currentIndex ? '✓' : index + 1 }}
            </span>
            <span class="onboarding-step-copy">
              <span class="onboarding-step-label">{{ label }}<span v-if="index === 0 && session?.aiSkipped"
                class="onboarding-step-skipped"> — {{ t('core.onboardingSkipped') }}</span></span>
              <span class="onboarding-step-detail">{{ descriptions[index] }}</span>
            </span>
          </li>
        </ol>
        <p class="onboarding-sidebar-note">{{ t('core.onboardingFutureHelp') }}</p>
      </aside>
      <div class="onboarding-panel">
        <div ref="content" class="onboarding-content">
          <p v-if="session" class="onboarding-progress">
            {{ session.step === 'summary' ? t('core.onboardingBaseComplete')
              : t('core.onboardingStepCount', { current: currentIndex + 1, total: 3 }) }}
          </p>
          <UiInlineMessage v-if="store.error" tone="warning">
            {{ t(store.error === 'save' ? 'core.onboardingSaveFailed' : 'core.onboardingReadFailed') }}
            <UiButton wrap @click="store.reload()">{{ t('core.onboardingReload') }}</UiButton>
          </UiInlineMessage>
          <template v-if="!initializing && session && store.draft">
            <OnboardingAiStep v-if="session.step === 'ai'" @ready="aiReady = $event" />
            <OnboardingProjectStep v-else-if="session.step === 'project'" @ready="projectReady = $event" />
            <OnboardingWorkspaceStep v-else-if="session.step === 'workspace'" />
            <OnboardingSummary v-else />
          </template>
          <UiLoadingState v-else-if="!store.error" variant="cards" :label="t('core.onboardingLoading')"
            show-label />
        </div>
        <footer v-if="!initializing && session && store.draft" class="onboarding-actions">
          <UiButton wrap :disabled="store.busy" variant="ghost" @click="dismiss">
            {{ t('core.onboardingDismiss') }}
          </UiButton>
          <div class="onboarding-continue">
            <UiButton wrap v-if="session.step === 'ai'" :disabled="store.busy || !!store.error"
              variant="ghost" @click="store.transition('/advance', { skipAi: true })">
              {{ t('core.onboardingSkip') }}
            </UiButton>
            <UiButton wrap v-if="session.status === 'active'" :disabled="!canAdvance"
              variant="solid" tone="accent" @click="store.transition('/advance')">
              {{ t('core.onboardingNext') }}
              <template #trailing>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M4 12h16m-6-6 6 6-6 6" />
                </svg>
              </template>
            </UiButton>
            <template v-else>
              <UiButton wrap :disabled="store.busy" @click="another">
                {{ t('core.onboardingAnother') }}
              </UiButton>
              <UiButton wrap variant="solid" tone="accent" @click="router.push(projectRoute)">
                {{ t('core.onboardingDone') }}
              </UiButton>
            </template>
          </div>
        </footer>
        <UiButton wrap v-else-if="!initializing && !session" :disabled="store.busy" @click="another">
          {{ t('core.onboardingAnother') }}
        </UiButton>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router';

import { t, UiButton, UiInlineMessage, UiLoadingState, confirmDialog } from '../ui';
import { useOnboardingStore } from '../stores/onboarding.ts';
import { openSettings } from '../shared/settingsNavigation.ts';
import OnboardingAiStep from './onboarding/OnboardingAiStep.vue';
import OnboardingProjectStep from './onboarding/OnboardingProjectStep.vue';
import OnboardingWorkspaceStep from './onboarding/OnboardingWorkspaceStep.vue';
import OnboardingSummary from './onboarding/OnboardingSummary.vue';

const store = useOnboardingStore();
const router = useRouter();
const route = useRoute();
const initializing = ref(true);
const content = ref<HTMLElement | null>(null);
const aiReady = ref(false);
const projectReady = ref(false);
const session = computed(() => store.snapshot?.active);
const labels = computed(() => [
  t('core.onboardingAi'), t('core.onboardingProject'), t('core.onboardingWorkspace'),
  t('core.onboardingAnalysis'), t('core.onboardingRoutes'), t('core.onboardingPipeline'),
]);
const descriptions = computed(() => [
  t('core.onboardingAiDetail'), t('core.onboardingProjectDetail'), t('core.onboardingWorkspaceDetail'),
  t('core.onboardingAnalysisDetail'), t('core.onboardingRoutesDetail'), t('core.onboardingPipelineDetail'),
]);
const currentIndex = computed(() => ['ai', 'project', 'workspace', 'summary']
  .indexOf(session.value?.step ?? ''));
const projectRoute = computed(() => session.value?.projectSaved
  ? `/projects/${session.value.projectId}` : '/projects');
const canAdvance = computed(() => !store.error && !store.busy && (session.value?.step === 'ai'
  ? aiReady.value : session.value?.step === 'project'
    ? projectReady.value || !!session.value.projectIntent : true));

/**
 * После перехода человек начинает новый шаг с заголовка, даже если прежний список был длинным.
 * Первое открытие сохраняет положение страницы; смена шага также объявляется скринридеру.
 */
watch(() => session.value?.step, async (step, previous) => {
  if (!previous || !step || step === previous) {
    return;
  }

  await nextTick();
  content.value?.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
  content.value?.scrollIntoView({ block: 'start' });
});

/**
 * Ручной вход помечен одноразовым query; reload читает прежний проход без нового start.
 * Обычный адрес завершённого мастера показывает итог и не создаёт проект.
 */
async function another(): Promise<void> {
  if (await store.start('manual') && route.query.new) {
    await router.replace('/onboarding');
  }
}

/**
 * Отказ сначала подтверждается сервером, затем открывается обычное место настройки.
 * Неуспешная запись оставляет человека на прежнем шаге с его ответами.
 */
async function dismiss(): Promise<void> {
  const ai = session.value?.step === 'ai';

  if (!await store.transition('/dismiss')) {
    return;
  }

  await router.push(projectRoute.value);

  if (ai) {
    openSettings({ pageId: 'agents.providers' });
  }
}

onBeforeRouteLeave(async () => {
  if (!store.dirty) {
    return true;
  }

  if (await store.flush()) {
    return true;
  }

  return confirmDialog(t('core.onboardingLeaveUnsaved'));
});

onMounted(async () => {
  await store.load();

  if (route.query.new === '1') {
    await another();
  }

  // Поля доступны после удаления одноразового query: ранний reload не повторяет start.
  // Подтверждение сервера и завершение навигации образуют один начальный переход.
  initializing.value = false;
});
</script>

<style scoped>
.onboarding-page {
  width: 100%;
  max-width: 1160px;
  min-width: 0;
  margin: 0 auto;
  padding: clamp(16px, 3vw, 40px) clamp(12px, 2.5vw, 32px);
  overflow-wrap: anywhere;
  container-type: inline-size;
}

.onboarding-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 12px 24px;
  margin-bottom: 28px;
}

.onboarding-eyebrow,
.onboarding-sidebar-title,
.onboarding-progress {
  margin: 0 0 10px;
  color: var(--ink-low);
  font-size: 12px;
  font-weight: 500;
}

.onboarding-eyebrow {
  color: var(--accent);
}

.onboarding-header h1 {
  margin: 0;
  font-size: 24px;
  font-weight: 650;
  line-height: 1.3;
  letter-spacing: -0.4px;
}

.onboarding-intro {
  margin: 10px 0 0;
  color: var(--ink-mid);
  font-size: 13px;
}

.onboarding-save {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 6px 0 0;
  color: var(--ink-mid);
  font-size: 12px;
}

.onboarding-save span {
  color: var(--good);
}

.onboarding-save.is-saving span {
  color: var(--accent);
}

.onboarding-layout {
  display: grid;
  grid-template-columns: 224px minmax(0, 1fr);
  gap: 28px;
  align-items: start;
}

.onboarding-sidebar {
  padding-top: 4px;
  min-width: 0;
}

.onboarding-sidebar-title {
  padding: 0 10px;
}

.onboarding-steps {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.onboarding-steps li {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 10px;
  min-width: 0;
  border-radius: var(--radius-md);
}

.onboarding-step-number {
  display: grid;
  place-items: center;
  flex: 0 0 24px;
  height: 24px;
  border: 1px solid var(--line-2);
  border-radius: var(--radius-round);
  color: var(--ink-mid);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.onboarding-step-copy {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.onboarding-step-label {
  font-size: 13px;
  font-weight: 500;
  line-height: 24px;
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

.onboarding-steps [aria-current] .onboarding-step-number {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--ground);
  font-weight: 700;
}

.onboarding-steps .is-complete .onboarding-step-number {
  color: var(--good);
  border-color: color-mix(in srgb, var(--good) 35%, var(--line));
  background: color-mix(in srgb, var(--good) 7%, transparent);
}

.onboarding-steps .is-skipped .onboarding-step-number,
.onboarding-step-skipped {
  color: var(--ink-mid);
}

.onboarding-steps [aria-disabled] {
  color: var(--ink-low);
}

.onboarding-steps li:nth-child(4) {
  margin-top: 12px;
  border-top: 1px solid var(--line);
  border-radius: 0;
  padding-top: 20px;
}

.onboarding-sidebar-note {
  margin: 18px 10px 0;
  color: var(--ink-low);
  font-size: 12px;
  line-height: 1.65;
}

.onboarding-panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--sidebar);
}

.onboarding-content {
  min-width: 0;
  padding: 24px;
}

.onboarding-content :deep(.onboarding-section-head) {
  margin-bottom: 24px;
}

.onboarding-content :deep(h2) {
  margin: 0 0 8px;
  font-size: 19px;
  font-weight: 600;
  line-height: 1.4;
}

.onboarding-content :deep(.onboarding-description) {
  margin: 0;
  color: var(--ink-mid);
  font-size: 13px;
  line-height: 1.65;
}

.onboarding-actions,
.onboarding-continue {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.onboarding-actions {
  justify-content: space-between;
  padding: 16px 24px;
  border-top: 1px solid var(--line);
}

.onboarding-continue {
  margin-left: auto;
  justify-content: flex-end;
}

@container (max-width: 800px) {
  .onboarding-layout {
    grid-template-columns: minmax(0, 1fr);
    gap: 20px;
  }

  .onboarding-steps {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .onboarding-step-detail,
  .onboarding-sidebar-title,
  .onboarding-sidebar-note {
    display: none;
  }

  .onboarding-steps li {
    padding: 8px;
    gap: 8px;
  }

  .onboarding-steps li:nth-child(4) {
    margin-top: 0;
    padding-top: 8px;
    border-top: 0;
  }

  .onboarding-step-label {
    line-height: 1.5;
  }
}

@container (max-width: 460px) {
  .onboarding-header {
    margin-bottom: 20px;
  }

  .onboarding-header h1 {
    font-size: 21px;
  }

  .onboarding-steps {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .onboarding-content {
    padding: 18px 14px;
  }

  .onboarding-actions {
    padding: 12px 14px;
  }
}
</style>

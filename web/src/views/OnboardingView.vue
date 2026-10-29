<template>
  <div class="onboarding-page ui-page" data-ui-workspace>
    <h1>{{ t('core.onboardingTitle') }}</h1>
    <ol class="onboarding-steps" :aria-label="t('core.onboardingSteps')">
      <li v-for="(label, index) in labels" :key="label"
        :aria-current="index === currentIndex ? 'step' : undefined"
        :aria-disabled="index > 2 ? 'true' : undefined">
        <span aria-hidden="true">{{ index < currentIndex ? '✓' : index + 1 }}</span>
        <span>{{ label }}{{ index === 0 && session?.aiSkipped
          ? ` — ${t('core.onboardingSkipped')}` : '' }}</span>
      </li>
    </ol>
    <UiInlineMessage v-if="store.error" tone="warning">
      {{ t(store.error === 'save' ? 'core.onboardingSaveFailed' : 'core.onboardingReadFailed') }}
      <UiButton wrap @click="store.reload()">{{ t('core.onboardingReload') }}</UiButton>
    </UiInlineMessage>
    <template v-if="!initializing && session && store.draft">
      <p class="onboarding-save" aria-live="polite">
        {{ t(store.saving || store.dirty ? 'core.onboardingSaving' : 'core.onboardingSaved') }}
      </p>
      <OnboardingAiStep v-if="session.step === 'ai'" @ready="aiReady = $event" />
      <OnboardingProjectStep v-else-if="session.step === 'project'" @ready="projectReady = $event" />
      <OnboardingWorkspaceStep v-else-if="session.step === 'workspace'" />
      <OnboardingSummary v-else />
      <footer class="onboarding-actions">
        <UiButton wrap :disabled="store.busy" variant="ghost" @click="dismiss">
          {{ t('core.onboardingDismiss') }}
        </UiButton>
        <UiButton wrap v-if="session.step === 'ai'" :disabled="store.busy || !!store.error"
          variant="outline" @click="store.transition('/advance', { skipAi: true })">
          {{ t('core.onboardingSkip') }}
        </UiButton>
        <UiButton wrap v-if="session.status === 'active'" :disabled="!canAdvance"
          @click="store.transition('/advance')">
          {{ t('core.onboardingNext') }}
        </UiButton>
        <UiButton wrap v-else @click="router.push(projectRoute)">
          {{ t('core.onboardingDone') }}
        </UiButton>
      </footer>
    </template>
    <p v-else-if="!store.error">{{ t('core.onboardingLoading') }}</p>
    <UiButton wrap v-if="!initializing && session?.status !== 'active'"
      :disabled="store.busy" @click="another">
      {{ t('core.onboardingAnother') }}
    </UiButton>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router';

import { t, UiButton, UiInlineMessage, confirmDialog } from '../ui';
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
const aiReady = ref(false);
const projectReady = ref(false);
const session = computed(() => store.snapshot?.active);
const labels = computed(() => [
  t('core.onboardingAi'), t('core.onboardingProject'), t('core.onboardingWorkspace'),
  t('core.onboardingAnalysis'), t('core.onboardingRoutes'), t('core.onboardingPipeline'),
]);
const currentIndex = computed(() => ['ai', 'project', 'workspace', 'summary']
  .indexOf(session.value?.step ?? ''));
const projectRoute = computed(() => session.value?.projectSaved
  ? `/projects/${session.value.projectId}` : '/projects');
const canAdvance = computed(() => !store.error && !store.busy && (session.value?.step === 'ai'
  ? aiReady.value : session.value?.step === 'project'
    ? projectReady.value || !!session.value.projectIntent : true));

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
  max-width: 900px;
  min-width: 0;
  margin: 0 auto;
  padding: clamp(12px, 3vw, 28px);
  overflow-wrap: anywhere;
}

.onboarding-steps {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(180px, 100%), 1fr));
  gap: 12px;
  padding: 0;
  list-style: none;
}

.onboarding-steps li {
  padding: 8px 0;
  min-width: 0;
}

.onboarding-steps [aria-current] {
  font-weight: 700;
}

.onboarding-steps [aria-disabled] {
  color: var(--ink-low);
}

.onboarding-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin: 24px 0 16px;
}

.onboarding-save {
  color: var(--muted);
}
</style>

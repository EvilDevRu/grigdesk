<template>
  <section v-if="session">
    <header class="onboarding-section-head">
      <div class="summary-complete" aria-hidden="true">✓</div>
      <h2 tabindex="-1">{{ session.draft.title }}</h2>
      <p class="onboarding-description">{{ t('core.onboardingSummaryHelp') }}</p>
    </header>
    <div class="summary-facts">
      <p class="summary-ai" :class="{ 'is-skipped': session.aiSkipped }">
        {{ t(session.aiSkipped ? 'core.onboardingAiSkipped' : 'core.onboardingAiDone') }}
      </p>
      <p>{{ t(session.draft.workspace.mode === 'isolated'
        ? 'core.onboardingIsolated' : 'core.onboardingShared') }}</p>
    </div>
    <ul class="summary-repositories">
      <li v-for="repo in session.draft.repositories" :key="repo.name">
        <span>{{ repo.source }}</span>
        <span class="summary-branch">{{ repo.baseBranch }}</span>
      </li>
    </ul>
    <div class="summary-next">
      <h3>{{ t('core.onboardingWhatsNext') }}</h3>
      <p>{{ t('core.onboardingManualRemainder') }}</p>
      <UiActionLink href="#/documents?source=grigdesk&amp;path=server%2Fseed%2Fpipeline-sample%2FREADME.md"
        variant="link" tone="accent">
        {{ t('core.onboardingInstruction') }}
      </UiActionLink>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import { t, UiActionLink } from '../../ui';
import { useOnboardingStore } from '../../stores/onboarding.ts';

const store = useOnboardingStore();
const session = computed(() => store.snapshot?.active);
</script>

<style scoped>
.summary-complete {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  margin-bottom: 12px;
  border-radius: var(--radius-round);
  background: color-mix(in srgb, var(--good) 12%, transparent);
  color: var(--good);
  font-size: 14px;
}

.summary-facts {
  display: grid;
  gap: 8px;
  margin-bottom: 12px;
  font-size: 12px;
}

.summary-facts p {
  margin: 0;
}

.summary-ai {
  color: var(--good);
}

.summary-ai.is-skipped {
  color: var(--ink-mid);
}

.summary-repositories {
  display: grid;
  margin: 0 0 16px;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  list-style: none;
  background: var(--surface);
}

.summary-repositories li {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 8px 16px;
  min-width: 0;
  padding: 10px 12px;
  font-family: var(--mono);
  font-size: 12px;
}

.summary-repositories li + li {
  border-top: 1px solid var(--line);
}

.summary-branch {
  color: var(--accent);
}

.summary-next {
  padding-top: 12px;
  border-top: 1px solid var(--line);
}

.summary-next h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}

.summary-next p {
  margin: 6px 0 8px;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.5;
}
</style>

<template>
  <section v-if="session">
    <h2>{{ session.draft.title }}</h2>
    <p>{{ t('core.onboardingProjectId', { id: session.projectId }) }}</p>
    <p>{{ t(session.aiSkipped ? 'core.onboardingAiSkipped' : 'core.onboardingAiDone') }}</p>
    <ul>
      <li v-for="repo in session.draft.repositories" :key="repo.name">
        {{ repo.source }} — {{ repo.baseBranch }}
      </li>
    </ul>
    <p>{{ t(session.draft.workspace.mode === 'isolated'
      ? 'core.onboardingIsolated' : 'core.onboardingShared') }}</p>
    <p>{{ t('core.onboardingManualRemainder') }}</p>
    <a href="#/documents?source=grigdesk&amp;path=server%2Fseed%2Fpipeline-sample%2FREADME.md">
      {{ t('core.onboardingInstruction') }}
    </a>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import { t } from '../../ui';
import { useOnboardingStore } from '../../stores/onboarding.ts';

const store = useOnboardingStore();
const session = computed(() => store.snapshot?.active);
</script>

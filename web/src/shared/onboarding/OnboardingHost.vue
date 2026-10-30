<template>
  <OnboardingModal v-if="store.isOpen" />
</template>

<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { useOnboardingStore } from '../../stores/onboarding.ts';
import { useSse } from '../../composables/useSse.ts';
import { isRecord } from '../../../../shared/lib/objects.ts';
import { asyncView } from '../asyncView.ts';

const OnboardingModal = asyncView(() => import('../../views/onboarding/OnboardingModal.vue'));

const store = useOnboardingStore();
const route = useRoute();
const router = useRouter();
const attempted = new Set<string>();

watch(() => [store.requestedMode, store.scope] as const, ([mode, scope]) => {
  if (mode && scope) {
    void store.open(mode);
  }
}, { immediate: true });

const removeNavigationGuard = router.beforeEach(async (to, from) => {
  if (!store.isOpen || from.matched.length === 0 || to.name === 'onboarding'
    || to.fullPath === from.fullPath) {
    return true;
  }

  return store.close();
});

onBeforeUnmount(removeNavigationGuard);

watch(() => store.scope, async (scope) => {
  if (!scope || attempted.has(scope)) {
    return;
  }

  attempted.add(scope);
  await router.isReady();

  const initialPath = route.redirectedFrom?.path ?? route.path;
  const landingPath = route.fullPath;

  const state = await store.load();

  if (store.scope !== scope || store.isOpen || initialPath !== '/' || route.fullPath !== landingPath
    || state?.shouldOpen !== true) {
    return;
  }

  await store.open('auto');
}, { immediate: true });

useSse((name, data) => {
  if (name === 'onboarding-changed' && isRecord(data) && typeof data.revision === 'number'
    && data.revision <= (store.snapshot?.revision ?? -1)) {
    return;
  }

  if ((name === 'hello' || name === 'onboarding-changed') && store.scope) {
    void store.load();
  }
});
</script>

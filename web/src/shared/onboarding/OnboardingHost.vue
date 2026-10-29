<template></template>

<script setup lang="ts">
import { watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { useOnboardingStore } from '../../stores/onboarding.ts';
import { useSse } from '../../composables/useSse.ts';
import { isRecord } from '../../../../shared/lib/objects.ts';

const store = useOnboardingStore();
const route = useRoute();
const router = useRouter();
const attempted = new Set<string>();

watch(() => store.scope, async (scope) => {
  if (!scope || attempted.has(scope)) {
    return;
  }

  attempted.add(scope);
  await router.isReady();

  const initialPath = route.redirectedFrom?.path ?? route.path;
  const landingPath = route.fullPath;

  const state = await store.load();

  if (store.scope !== scope || initialPath !== '/' || route.fullPath !== landingPath
    || state?.shouldOpen !== true) {
    return;
  }

  if (await store.start('auto') && store.scope === scope && route.fullPath === landingPath) {
    await router.push('/onboarding');
  }
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

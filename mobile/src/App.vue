<template>
  <UiAuthLayout v-if="loading">
    <p class="auth-status" role="status">Подготовка…</p>
  </UiAuthLayout>
  <UiAuthLayout v-else-if="startupError">
    <UiError :text="startupError" />
  </UiAuthLayout>
  <AddRelayView v-else-if="!link.state?.paired" />
  <LockView v-else-if="!link.state.unlocked || link.state.revoked" />
  <div v-else class="app-shell">
    <UiTabBar v-if="!needsUpdate" />
    <div class="app-main">
      <aside v-if="needsUpdate" class="app-banner" role="status">
        <UiIcon name="download" />
        <p>Обнови приложение для работы с этим GrigDesk.</p>
      </aside>
      <MoreView v-if="needsUpdate" :key="link.state.generation" />
      <RouterView v-else :key="link.state.generation" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterView } from 'vue-router';

import AddRelayView from './views/AddRelayView.vue';
import LockView from './views/LockView.vue';
import MoreView from './views/MoreView.vue';
import { UiAuthLayout, UiError, UiIcon, UiTabBar } from './ui.ts';
import { useLinkStore } from './stores/link.ts';
import { isNewer } from './api/version.ts';
import { useDeviceClass } from './composables/useDeviceClass.ts';

const link = useLinkStore();
const loading = ref(true);
const startupError = ref('');
const needsUpdate = computed(() =>
  isNewer(link.minApp, import.meta.env.VITE_APP_VERSION || '0.1.0'),
);

useDeviceClass();

onMounted(async () => {
  try {
    await link.refresh();
  } catch (failure) {
    startupError.value = failure instanceof Error ? failure.message : 'Приложение не запущено.';
  } finally {
    loading.value = false;
  }
});
</script>

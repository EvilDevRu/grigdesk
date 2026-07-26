<script setup>
import { onMounted, watch } from 'vue';
import AppShell from './shared/layout/AppShell.vue';
import LoginView from './views/LoginView.vue';
import UpdateBanner from './shared/ui/UpdateBanner.vue';
import TaskModal from './views/TaskModal.vue';
import ChatPanel from './views/ChatPanel.vue';
import DiffModal from './views/DiffModal.vue';
import { useBoardStore } from './stores/board.js';
import { useSystemStore } from './stores/system.js';
import { useAuthStore } from './stores/auth.js';

const auth = useAuthStore();

// Фоновые поллинги запускаем ТОЛЬКО после входа: иначе они молотят в закрытый API,
// ловят 401 и засоряют консоль на экране логина.
function startPolling() {
  useBoardStore().startPolling();
  useSystemStore().startPolling();
}

onMounted(async () => {
  auth.watchUnauthorized();
  await auth.load();
  if (auth.authenticated) startPolling();
});

// Вошли позже (через форму) — поднимаем поллинги тогда. Потеряли сессию — гасим:
// иначе интервалы продолжают долбить закрытый API и сыплют 401 в консоль на экране входа.
watch(() => auth.authenticated, (on, was) => {
  if (on && !was) startPolling();
  if (!on && was) {
    useBoardStore().stopPolling();
    useSystemStore().stopPolling();
  }
});
</script>

<template>
  <!-- Пока не знаем состояние входа — не рисуем ничего: иначе на миг мелькает либо форма
       у вошедшего, либо интерфейс у невошедшего. -->
  <!-- Баннер обновления — ВНЕ ветки авторизации: service worker может держать старую сборку
       и на экране входа, а обновление не требует сессии (работает с SW, не с API). -->
  <UpdateBanner />

  <template v-if="auth.ready">
    <LoginView v-if="!auth.authenticated" />
    <template v-else>
      <AppShell>
        <router-view v-slot="{ Component }">
          <component :is="Component" />
        </router-view>
      </AppShell>
      <TaskModal />
      <ChatPanel />
      <DiffModal />
    </template>
  </template>
</template>

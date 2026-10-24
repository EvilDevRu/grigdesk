<template>
  <UiDialog
    :open="state.phase !== 'idle'"
    layer="confirm"
    :title="title"
    :description="description"
    :busy="state.phase === 'stopping'"
    :persistent="state.phase === 'stopping'"
    :dismissible="state.phase !== 'stopping'"
    @update:open="!$event && renderer.choose(false)"
  >
    <div class="desktop-exit-content">
      <UiSpinner v-if="state.phase === 'stopping'" :label="t('desktop.exitStoppingTitle')" />
      <section v-if="state.snapshot.chats.length">
        <h3>{{ t('desktop.exitChats') }}</h3>
        <ul>
          <li v-for="chat in state.snapshot.chats" :key="chat.chatKey">{{ chat.title }}</li>
        </ul>
      </section>
      <section v-if="state.snapshot.pipelines.length">
        <h3>{{ t('desktop.exitPipelines') }}</h3>
        <ul>
          <li v-for="pipeline in state.snapshot.pipelines" :key="pipeline.task">
            #{{ pipeline.task }} — {{ pipeline.title }}
            <span v-if="state.results.find((result) => result.task === pipeline.task)?.state === 'unknown'">
              {{ t('desktop.exitStopUnknown') }}
            </span>
          </li>
        </ul>
      </section>
      <UiCheckbox v-if="state.phase === 'prompt'" v-model="state.remember">
        {{ t('desktop.exitRemember') }}
      </UiCheckbox>
    </div>
    <template v-if="state.phase === 'prompt'" #footer>
      <UiButton @click="renderer.choose(false)">{{ t('desktop.exitCancel') }}</UiButton>
      <UiButton variant="solid" @click="renderer.choose(true)">{{ t('desktop.exitConfirm') }}</UiButton>
    </template>
  </UiDialog>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue';

import { t, UiButton, UiCheckbox, UiDialog, UiSpinner } from '../../ui.ts';
import { useChatStore } from '../../stores/chat.ts';
import { createDesktopExitRenderer } from '../desktopExit.ts';

const chat = useChatStore();
const renderer = createDesktopExitRenderer({ sessions: () => chat.sessions });
const state = renderer.state;
const title = computed(() => state.phase === 'stopping'
  ? t('desktop.exitStoppingTitle') : t('desktop.exitConfirmTitle'));
const description = computed(() => state.phase === 'stopping'
  ? t('desktop.exitStoppingHint') : t('desktop.exitConfirmHint'));

onMounted(() => {
  window.grigdeskDesktopExit = renderer.dispatch;
});

onBeforeUnmount(() => {
  if (window.grigdeskDesktopExit === renderer.dispatch) {
    delete window.grigdeskDesktopExit;
  }

  renderer.dispose();
});
</script>

<style scoped>
.desktop-exit-content {
  display: grid;
  gap: 16px;
  min-width: 0;
  overflow-wrap: anywhere;
}

.desktop-exit-content ul {
  max-height: 25vh;
  overflow: auto;
  padding-inline-start: 24px;
}

.desktop-exit-content h3 {
  margin: 0;
  font-size: inherit;
}
</style>

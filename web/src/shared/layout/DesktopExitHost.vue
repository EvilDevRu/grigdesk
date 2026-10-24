<template>
  <UiDialog
    :open="state.phase !== 'idle'"
    :class="{ 'ui-dialog-host': state.phase === 'prompt' }"
    data-role="desktop-exit"
    layer="confirm"
    size="compact"
    :mobile-fullscreen="false"
    :title="title"
    :description="description"
    :busy="state.phase === 'stopping'"
    :persistent="state.phase === 'stopping'"
    :dismissible="state.phase !== 'stopping'"
    @update:open="!$event && renderer.choose(false)"
  >
    <template #title>
      <span class="ui-dialog-host__head">
        <span
          class="ui-dialog-host__icon"
          :data-tone="state.phase === 'prompt' ? 'danger' : 'accent'"
          aria-hidden="true"
        >
          <UiSpinner v-if="state.phase === 'stopping'" decorative />
          <svg v-else class="ui-dialog-host__glyph" viewBox="0 0 24 24">
            <path d="M10 4H5v16h5M10 12h11m-4-4 4 4-4 4" />
          </svg>
        </span>
        <span>{{ title }}</span>
      </span>
    </template>
    <template #description>
      <span class="ui-dialog-host__message">{{ description }}</span>
    </template>
    <div class="desktop-exit-content">
      <section v-if="state.snapshot.chats.length" class="desktop-exit-group">
        <h3 class="desktop-exit-group__heading">
          {{ t('desktop.exitChats') }}
          <span class="desktop-exit-group__count">{{ state.snapshot.chats.length }}</span>
        </h3>
        <ul class="desktop-exit-list">
          <li v-for="chat in state.snapshot.chats" :key="chat.chatKey" class="desktop-exit-list__row">
            {{ chat.title }}
          </li>
        </ul>
      </section>
      <section v-if="state.snapshot.pipelines.length" class="desktop-exit-group">
        <h3 class="desktop-exit-group__heading">
          {{ t('desktop.exitPipelines') }}
          <span class="desktop-exit-group__count">{{ state.snapshot.pipelines.length }}</span>
        </h3>
        <ul class="desktop-exit-list">
          <li
            v-for="pipeline in state.snapshot.pipelines"
            :key="pipeline.task"
            class="desktop-exit-list__row"
          >
            <span class="desktop-exit-list__task">#{{ pipeline.task }}</span>
            <span class="desktop-exit-list__details">
              <span>{{ pipeline.title }}</span>
              <span
                v-if="state.results.find((result) => result.task === pipeline.task)?.state === 'unknown'"
                class="desktop-exit-list__warning"
                role="status"
              >
                {{ t('desktop.exitStopUnknown') }}
              </span>
            </span>
          </li>
        </ul>
      </section>
    </div>
    <template v-if="state.phase === 'prompt'" #footer>
      <div class="desktop-exit-footer">
        <UiCheckbox v-model="state.remember">{{ t('desktop.exitRemember') }}</UiCheckbox>
        <div class="ui-dialog-host__actions">
          <UiButton variant="ghost" data-role="desktop-exit-cancel" @click="renderer.choose(false)">
            {{ t('desktop.exitCancel') }}
          </UiButton>
          <UiButton variant="solid" tone="danger" @click="renderer.choose(true)">
            {{ t('desktop.exitConfirm') }}
          </UiButton>
        </div>
      </div>
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
  gap: 14px;
  min-width: 0;
  max-height: 40dvh;
  overflow-y: auto;
  overscroll-behavior: contain;
  font-size: 13px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.desktop-exit-group {
  min-width: 0;
}

.desktop-exit-group__heading {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 7px;
  color: var(--ink-mid);
  font-size: 12px;
  font-weight: 500;
}

.desktop-exit-group__count {
  min-width: 20px;
  padding: 0 5px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  color: var(--ink-mid);
  font-size: 11px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.desktop-exit-list {
  margin: 0;
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  list-style: none;
}

.desktop-exit-list__row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 8px 10px;
}

.desktop-exit-list__row + .desktop-exit-list__row {
  border-top: 1px solid var(--line);
}

.desktop-exit-list__task {
  flex: none;
  color: var(--ink-mid);
  font-family: var(--mono);
  font-size: 11px;
}

.desktop-exit-list__details {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.desktop-exit-list__warning {
  color: var(--warn);
  font-size: 12px;
}

.desktop-exit-footer {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  width: 100%;
}
</style>

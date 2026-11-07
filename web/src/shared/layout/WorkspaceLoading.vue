<template>
  <div class="workspace-loading">
    <div class="connection" role="status" aria-live="polite">{{ label }}</div>
    <div v-if="routeName === 'chats'" class="chats">
      <div class="list" data-loading-region="list" :style="listStyle">
        <div class="list-header"><UiSkeleton height="32px" /><UiSkeleton width="48%" /></div>
        <div class="list-rows"><UiSkeletonLayout :header="false" :rows="6" /></div>
      </div>
      <div class="conversation"><ChatLoadingPreview /></div>
    </div>
    <div v-else-if="routeName === 'board'" class="board"><BoardLoading include-own-tasks /></div>
    <div v-else-if="routeName === 'pipeline'" class="pipeline">
      <div class="toolbar" data-loading-region="toolbar">
        <UiSkeleton shape="block" width="120px" height="var(--toolbar-control-h)" />
        <UiSkeleton shape="block" width="180px" height="var(--toolbar-control-h)" />
      </div>
      <PipelineLoading :compact="pipelineModes.compact" :loops-on="pipelineModes.loopsOn" />
    </div>
    <InboxLoading v-else-if="routeName === 'inbox'" />
    <GitHubLoading v-else-if="routeName === 'github'" />
    <TelegramLoading v-else-if="routeName === 'telegram'" />
    <component :is="panelLoading(routeName)" v-else-if="toolIds.includes(routeName)" />
    <UiLoadingState v-else><UiSkeletonLayout layout="form" /></UiLoadingState>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import { UiLoadingState, UiSkeleton, UiSkeletonLayout } from '../../ui';
import { panelLoading } from '../tools/panelLoading.ts';
import ChatLoadingPreview from '../../views/chat/ChatLoadingPreview.vue';
import BoardLoading from '../../views/BoardLoading.vue';
import PipelineLoading from '../../views/PipelineLoading.vue';
import InboxLoading from '../../views/InboxLoading.vue';
import GitHubLoading from '../../views/GitHubLoading.vue';
import TelegramLoading from '../../views/TelegramLoading.vue';

const props = defineProps<{ label: string; routeName: string }>();
const toolIds = ['code', 'shelf', 'terminal', 'ssh', 'db', 'docker'];

/**
 * До подключения доступны только настройки устройства, без данных чатов.
 * Ограничение по доступному контейнеру задаёт CSS, чтобы учитывать рейки оболочки.
 */
function initialListWidth(): number | null {
  try {
    const width = Number(localStorage.getItem('grigdesk-chats-list-width'));

    return Number.isFinite(width) && width > 0 ? Math.round(width) : null;
  } catch {
    return null;
  }
}

/**
 * Подключение ещё не монтирует Конвейер, но его режимы уже доступны на устройстве.
 * Чтение не меняет сохранения и при запрете storage оставляет обычный вид.
 */
function initialPipelineModes() {
  try {
    return {
      compact: localStorage.getItem('grigdesk-compact') === '1',
      loopsOn: localStorage.getItem('grigdesk-loops') === '1',
    };
  } catch {
    return { compact: false, loopsOn: false };
  }
}

const width = initialListWidth();
const pipelineModes = initialPipelineModes();
const listStyle = computed(() => props.routeName === 'chats' && width != null
  ? { '--chat-list-w': `${width}px` } : undefined);
</script>

<style scoped>
.workspace-loading { position: relative; container-type: inline-size;
  height: 100%; min-height: 0; min-width: 0; }
.connection { position: absolute; z-index: 2; top: 8px; right: 12px; max-width: calc(100% - 24px);
  padding: 4px 8px; border-radius: var(--radius); background: var(--surface); font-size: 12px; }
.chats { display: flex; height: 100%; min-width: 0; overflow: hidden; }
.list { display: flex; flex-direction: column; --chat-list-default: 300px;
  width: clamp(220px, var(--chat-list-w, var(--chat-list-default)),
    max(220px, min(max(560px, 40cqw), calc(100cqw - 420px)))); flex: none;
  border-right: 1px solid var(--line); }
.list-header { display: grid; align-content: center; gap: 5px; min-height: var(--chat-head-h);
  padding: 0 10px; border-bottom: 1px solid var(--line); }
.list-rows { padding: 24px 18px; }
.conversation { display: flex; flex: 1; min-width: 0; }
.board { container: board-page / inline-size; }
.pipeline { display: flex; flex-direction: column; gap: 14px; }
.toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px;
  min-height: calc(var(--toolbar-control-h) + 8px);
  margin: calc(var(--page-gutter) * -1) calc(var(--page-gutter) * -1) -2px;
  padding: 3px var(--page-gutter) 4px; border-bottom: 1px solid var(--line); }
@media (min-width: 900px) and (max-width: 1099px) {
  .list { --chat-list-default: 260px; }
}
@media (max-width: 899px) {
  .list { width: 100%; border-right: 0; }
  .conversation { display: none; }
}
</style>

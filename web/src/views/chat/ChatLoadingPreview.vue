<template>
  <div class="chat-loading-preview" :style="composerStyle">
  <UiLoadingState :label="label" :failed="failed" style="height: 100%">
    <div class="conversation">
      <div class="header" data-loading-region="header">
        <UiSkeleton width="38%" height="16px" />
        <UiSkeleton width="64%" />
      </div>
      <div class="body" data-loading-region="body">
        <UiSkeleton v-for="index in 4" :key="index" class="message"
                    :class="{ outgoing: index % 2 === 0 }" shape="block" />
      </div>
      <div class="conversation-input" data-loading-region="input">
        <div class="composer">
          <UiSkeleton shape="circle" />
          <div class="composer-field" data-loading-region="composer">
            <UiSkeleton shape="block" height="100%" />
          </div>
          <UiSkeleton shape="circle" />
          <UiSkeleton shape="circle" />
        </div>
      </div>
    </div>
  </UiLoadingState>
  </div>
</template>

<script setup lang="ts">
import { UiLoadingState, UiSkeleton, UiSkeletonLayout } from '../../ui';
import { computed } from 'vue';
import { storedComposerHeight } from './chatLayout.ts';

defineOptions({ inheritAttrs: false });

withDefaults(defineProps<{
  label?: string;
  description?: string;
  failed?: boolean;
}>(), {
  label: undefined,
  description: undefined,
  failed: false,
});

const composerHeight = storedComposerHeight();
const composerStyle = computed(() => (
  composerHeight == null ? undefined : { '--composer-h': `${composerHeight}px` }
));
</script>

<style scoped>
 .chat-loading-preview { flex: 1; height: 100%; min-width: 0; min-height: 0; }
.conversation { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.header { display: flex; flex-direction: column; justify-content: center; gap: 12px;
  min-height: var(--chat-head-h); padding: 4px var(--chat-gutter); border-bottom: 1px solid var(--line); }
.body { display: flex; flex: 1; flex-direction: column; gap: 24px; min-height: 0;
  overflow: hidden; padding: 24px var(--chat-gutter); }
.message { width: 64%; }
.outgoing { align-self: flex-end; width: 48%; }
.conversation-input { padding: 12px var(--chat-gutter) 16px; border-top: 1px solid var(--line); }
.composer { display: flex; align-items: flex-end; gap: 6px; padding: 8px;
  border: 1px solid var(--line); border-radius: 12px; }
.composer-field { flex: 1; height: var(--composer-h, 53px); min-height: 48px; max-height: 46vh; }
@media (max-width: 899px) {
  .conversation-input { padding: 8px var(--chat-gutter); }
  .composer { flex-wrap: wrap; padding: 6px; }
  .composer-field { flex: 1 0 100%; order: -1; }
}
@media (max-width: 600px) {
  .composer-field { height: 58px; max-height: min(160px, 28vh); }
}
</style>

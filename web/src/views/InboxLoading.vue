<template>
  <div class="inbox-loading">
    <UiLoadingState style="height: 100%" :label="label" :failed="failed">
      <div class="workspace">
        <div class="catalog" data-loading-region="catalog">
          <div class="tools" data-loading-region="header">
            <div class="tabs" data-loading-region="tabs">
              <UiSkeleton width="48%" height="28px" />
              <UiSkeleton width="48%" height="28px" />
            </div>
            <UiSkeleton shape="block" height="32px" />
          </div>
          <div class="rows">
            <div v-for="index in 5" :key="index" class="row" data-loading-region="card">
              <UiSkeleton width="40%" />
              <UiSkeleton width="80%" height="19px" />
              <UiSkeleton width="64%" />
              <UiSkeleton width="90%" />
            </div>
          </div>
        </div>
        <div class="detail" data-loading-region="detail">
          <div class="messages">
            <UiSkeleton width="40%" height="20px" />
            <UiSkeleton width="64%" height="25px" />
            <UiSkeletonLayout layout="text" :header="false" :rows="6" />
          </div>
          <div class="actions"><UiSkeleton width="50%" height="32px" /></div>
        </div>
      </div>
    </UiLoadingState>
  </div>
</template>

<script setup lang="ts">
import { UiLoadingState, UiSkeleton, UiSkeletonLayout } from '../ui';

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
</script>

<style scoped>
.inbox-loading { flex: 1; min-height: 0; container: inbox-loading / inline-size; }
.workspace { display: grid; grid-template-columns: minmax(300px, 360px) minmax(0, 1fr);
  height: 100%; min-height: 0; }
.catalog { min-width: 0; overflow: hidden; border-right: 1px solid var(--line);
  background: var(--sidebar); }
.tools { display: grid; gap: 10px; padding: 12px; border-bottom: 1px solid var(--line); }
.tabs { display: flex; align-items: center; gap: 2px; padding: 3px; height: 34px; margin-block: 6px; }
.rows { padding: 6px; }
.row { display: grid; gap: 8px; padding: 12px; margin-bottom: 3px; }
.detail { display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
.messages { display: grid; align-content: start; flex: 1; gap: 16px;
  padding: 24px clamp(16px, 3cqi, 48px); }
.actions { display: flex; justify-content: flex-end; padding: 12px 20px;
  border-top: 1px solid var(--line); }
@container inbox-loading (max-width: 900px) {
  .workspace { grid-template-columns: minmax(0, 1fr); }
  .catalog { border-right: 0; }
  .detail { display: none; }
}
</style>

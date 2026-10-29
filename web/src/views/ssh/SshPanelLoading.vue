<template>
  <div class="panel" :class="{ compact, dock: presentation === 'dock' }">
    <UiLoadingState style="height: 100%" :label="label" :failed="failed">
      <div class="outline">
        <div class="header">
          <div class="brand">
            <UiSkeleton shape="block" width="var(--ssh-loading-mark-size)"
                        height="var(--ssh-loading-mark-size)" />
            <UiSkeleton width="90px" />
          </div>
          <UiSkeleton class="summary" width="96px" height="25px" />
          <UiSkeleton shape="block" width="30px" height="30px" />
        </div>
        <div class="split">
          <div class="list"><UiSkeletonLayout /></div>
          <div class="body">
            <div class="console"><UiSkeletonLayout layout="text" :rows="10" /></div>
            <div class="audit"><UiSkeleton width="35%" height="16px" /></div>
          </div>
        </div>
      </div>
    </UiLoadingState>
  </div>
</template>

<script setup lang="ts">
import { UiLoadingState, UiSkeleton, UiSkeletonLayout } from '../../ui';

defineOptions({ inheritAttrs: false });

withDefaults(defineProps<{
  compact?: boolean;
  presentation?: string;
  label?: string;
  description?: string;
  failed?: boolean;
}>(), {
  compact: false,
  presentation: 'page',
  label: undefined,
  description: undefined,
  failed: false,
});
</script>

<style scoped>
.panel { container: ssh-loading / inline-size; width: 100%; overflow: hidden; }
.panel, .outline { height: 100%; min-height: 0; min-width: 0; }
.outline { display: grid; grid-template-rows: auto minmax(0, 1fr); gap: 10px;
  padding: 9px 12px 12px; overflow: hidden; }
.header {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
  min-height: 38px;
}
.brand { --ssh-loading-mark-size: 32px; display: flex; align-items: center; gap: 10px; }
.summary { justify-self: end; }
.split {
  display: grid;
  grid-template-columns: minmax(270px, 326px) minmax(0, 1fr);
  gap: 10px;
  min-height: 0;
}
.list { padding: 14px 9px 10px; border: 1px solid var(--line); border-radius: var(--radius); }
.body { display: flex; flex-direction: column; gap: 8px;
  grid-column: 2; grid-row: 1; min-height: 0; min-width: 0; }
.console { flex: 1; min-height: 0; padding: 16px; border: 1px solid var(--line); }
.audit { display: flex; align-items: center; min-height: 41px; padding: 0 10px;
  border: 1px solid var(--line); border-radius: var(--radius); }
.compact.dock .header { padding-right: var(--tool-dock-actions-space, 82px); }
@container ssh-loading (max-width: 880px) {
  .outline { grid-template-rows: auto auto; align-content: start; overflow: auto; }
  .split { display: flex; flex-direction: column; }
  .console { display: none; }
}
@container ssh-loading (max-width: 600px) {
  .outline { gap: 8px; padding: 7px 8px 10px; }
  .header { grid-template-columns: minmax(0, 1fr) auto; gap: 7px; }
  .summary { grid-column: 1 / -1; grid-row: 2; justify-self: start; }
  .split { gap: 8px; }
}
@container ssh-loading (max-width: 390px) {
  .brand { --ssh-loading-mark-size: 29px; }
}
</style>

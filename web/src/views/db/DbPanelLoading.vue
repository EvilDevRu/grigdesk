<template>
  <div class="panel" :class="{ compact, dock: presentation === 'dock' }">
    <UiLoadingState style="height: 100%" :label="label" :failed="failed">
      <div class="outline">
        <div class="header"><UiSkeleton width="26%" height="20px" /></div>
        <div class="split">
          <div class="list"><UiSkeletonLayout /></div>
          <div class="body">
            <div class="queries" data-loading-region="queries">
              <UiSkeleton width="35%" height="18px" />
              <UiSkeleton width="60%" />
            </div>
            <div class="console">
              <div class="console-header"><UiSkeleton width="28%" height="18px" /></div>
              <div class="workbench">
                <div class="schema" data-loading-region="schema">
                  <div class="schema-header"><UiSkeleton width="45%" height="16px" /></div>
                  <div class="schema-copy"><UiSkeletonLayout :header="false" /></div>
                </div>
                <div class="query-console">
                  <div class="query-editor" data-loading-region="query-editor">
                    <div class="query-heading">
                      <UiSkeleton width="38%" height="16px" />
                      <UiSkeleton width="50%" />
                    </div>
                    <div class="query-field">
                      <UiSkeleton width="15%" height="17px" />
                      <UiSkeleton shape="block" height="139.75px" data-loading-region="query-input" />
                    </div>
                    <div class="query-actions"><UiSkeleton shape="block" width="120px" height="32px" /></div>
                  </div>
                  <div class="results" data-loading-region="results">
                    <UiSkeleton width="24%" height="18px" />
                    <UiSkeletonLayout layout="text" :header="false" :rows="2" />
                  </div>
                </div>
              </div>
            </div>
            <div class="audit"><UiSkeleton width="30%" height="18px" /></div>
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
.panel {
  container: db-loading / inline-size;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
.outline {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 10px;
  height: 100%;
  min-height: 0;
  padding: 9px 12px 12px;
}
.header {
  display: flex;
  align-items: center;
  min-height: 38px;
}
.split {
  display: grid;
  grid-template-columns: minmax(280px, 326px) minmax(0, 1fr);
  gap: 10px;
  min-height: 0;
}
.list { padding: 14px; border: 1px solid var(--line); }
.body { display: flex; flex-direction: column; gap: 8px; min-width: 0; min-height: 0; overflow: auto; }
.queries {
  display: grid;
  flex: none;
  gap: 8px;
  min-height: 84px;
  padding: 9px 10px;
  border: 1px solid var(--line);
}
.console {
  display: flex;
  flex: 1 0 470px;
  flex-direction: column;
  min-height: 470px;
  border: 1px solid var(--line);
}
.console-header {
  display: flex;
  flex: none;
  align-items: center;
  min-height: 44px;
  padding: 5px 7px;
  border-bottom: 1px solid var(--line);
}
.workbench {
  display: grid;
  flex: 1;
  grid-template-columns: minmax(190px, 250px) minmax(0, 1fr);
  min-height: 360px;
}
.schema { min-width: 0; border-right: 1px solid var(--line); }
.schema-header {
  display: flex;
  align-items: center;
  min-height: 43px;
  padding: 6px 8px 6px 10px;
  border-bottom: 1px solid var(--line);
}
.schema-copy { padding: 9px; }
.query-console { display: grid; grid-template-rows: auto minmax(180px, 1fr); min-width: 0; }
.query-editor {
  display: grid;
  gap: 8px;
  padding: 10px;
  border-bottom: 1px solid var(--line);
}
.query-heading { display: grid; gap: 6px; min-height: 40px; align-content: center; }
.query-field { display: grid; gap: 6px; }
.query-actions { display: flex; justify-content: flex-end; min-height: 42px; }
.results { display: grid; align-content: start; gap: 16px; padding: 10px; }
.audit { display: flex; flex: none; align-items: center; min-height: 41px; padding: 9px 10px; }
/* До первой сессии узкая панель открывается списком профилей.
   Порог берётся от ширины панели, как у готового рабочего пространства. */
@container db-loading (max-width: 940px) {
  .split { grid-template-columns: minmax(0, 1fr); }
  .body { display: none; }
}
@container db-loading (max-width: 660px) {
  .outline { padding: 7px 8px 10px; gap: 8px; }
}
</style>

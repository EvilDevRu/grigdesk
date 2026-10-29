<template>
  <div class="diff-loading">
    <UiLoadingState style="height: 100%" :label="label" :failed="failed">
      <div class="split">
        <div class="tree" data-loading-region="tree"><UiSkeletonLayout /></div>
        <div class="editor">
          <UiSkeleton class="header" height="36px" />
          <div class="canvases" :class="{ together: sideBySide }">
            <div class="canvas" :class="{ original: sideBySide }" data-loading-region="original">
              <UiSkeletonLayout layout="text" :rows="12" />
            </div>
            <div v-if="sideBySide" class="canvas" data-loading-region="modified">
              <UiSkeletonLayout layout="text" :rows="12" />
            </div>
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
  label?: string;
  description?: string;
  failed?: boolean;
  sideBySide?: boolean;
}>(), {
  label: undefined,
  description: undefined,
  failed: false,
  sideBySide: true,
});
</script>

<style scoped>
.diff-loading {
  height: 100%;
  min-height: 0;
}

.split {
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr);
  height: 100%;
}

.tree {
  padding: 8px;
  border-right: 1px solid var(--line);
  min-width: 0;
}

.editor {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  container: diff-editor-loading / inline-size;
}

.canvases {
  display: grid;
  min-height: 0;
  padding-right: 30px;
}

.canvas {
  min-width: 0;
  overflow: hidden;
  padding: 16px;
}

.together {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

/* Monaco оставляет слева только gutter при ширине редактора до 900 px.
   Проверяется ширина самого редактора после дерева, включая диалоги и окна. */
@container diff-editor-loading (max-width: 900px) {
  .together {
    grid-template-columns: 38px minmax(0, 1fr);
  }

  .original {
    padding-inline: 6px;
  }
}

@container diff-panel (max-width: 700px) {
  .split {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
  }

  .tree {
    max-height: min(160px, 30dvh);
    overflow: hidden;
    border-bottom: 1px solid var(--line);
  }
}
</style>

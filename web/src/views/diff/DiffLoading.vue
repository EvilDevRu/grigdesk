<template>
  <div class="diff-loading">
    <UiLoadingState style="height: 100%" :label="label" :failed="failed">
      <div class="split">
        <div class="tree" data-loading-region="tree">
          <div class="tree-header"><UiSkeleton width="55%" height="18px" /></div>
          <div class="tree-search"><UiSkeleton height="32px" /></div>
          <div class="tree-content"><UiSkeletonLayout :header="false" /></div>
        </div>
        <div class="editor">
          <UiSkeleton class="header" height="36px" />
          <div class="context"><UiSkeleton width="40%" height="16px" /></div>
          <UiSkeleton height="27px" />
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
  grid-template-columns: 288px minmax(0, 1fr);
  height: 100%;
}

.tree {
  border-right: 1px solid var(--line);
  min-width: 0;
}

.tree-header {
  display: flex;
  align-items: center;
  min-height: 36px;
  padding-inline: 12px;
  border-bottom: 1px solid var(--line);
}

.tree-search {
  padding: 10px;
  border-bottom: 1px solid var(--line);
}

.tree-content {
  padding: 10px;
}

.context {
  padding: 6px 12px;
  border-bottom: 1px solid var(--line);
}

.editor {
  display: grid;
  grid-template-rows: auto auto auto minmax(0, 1fr);
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
  }

  .tree {
    overflow: hidden;
    border-right: 0;
  }

  .editor {
    display: none;
  }
}
</style>

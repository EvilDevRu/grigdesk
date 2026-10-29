<template>
  <UiLoadingState :class="{ 'create-loading': area === 'create' }" :label="label" :failed="failed">
    <div v-if="area === 'library'" class="tiles">
      <div v-for="i in 6" :key="i" class="tile" data-loading-region="tile">
        <div class="preview"><UiSkeleton shape="block" height="100%" /></div>
        <div class="copy"><UiSkeleton width="65%" /><UiSkeleton width="40%" /></div>
      </div>
    </div>
    <div v-else class="create">
      <div class="panel-header"><UiSkeleton width="20%" height="20px" /></div>
      <div class="navigation"><UiSkeleton width="300px" height="32px" /></div>
      <div class="create-body">
        <div class="create-scroll">
          <div class="create-content">
            <div class="create-heading">
              <UiSkeleton width="28%" height="24px" />
              <UiSkeleton width="60%" />
            </div>
            <div class="create-grid">
              <div class="primary" data-loading-region="primary">
                <div class="create-card">
                  <UiSkeleton width="30%" height="16px" />
                  <UiSkeleton shape="block" height="32px" />
                  <UiSkeleton shape="block" height="72px" />
                  <UiSkeleton width="60%" />
                </div>
              </div>
              <div class="meta" data-loading-region="meta">
                <div class="create-card">
                  <UiSkeleton width="55%" height="16px" />
                  <div v-for="i in 3" :key="i" class="meta-field">
                    <UiSkeleton width="40%" height="18px" />
                    <UiSkeleton shape="block" height="32px" />
                    <UiSkeleton width="85%" />
                  </div>
                </div>
                <div class="create-card"><UiSkeleton width="65%" height="18px" /></div>
              </div>
            </div>
          </div>
        </div>
        <div class="create-footer" data-loading-region="footer">
          <div class="footer-actions">
            <UiSkeleton width="220px" height="20px" />
            <UiSkeleton shape="block" width="160px" height="32px" />
          </div>
          <UiSkeleton width="50%" height="20px" />
        </div>
      </div>
    </div>
  </UiLoadingState>
</template>

<script setup lang="ts">
import { UiLoadingState, UiSkeleton } from '../../ui';

defineOptions({ inheritAttrs: false });

withDefaults(defineProps<{
  label?: string;
  description?: string;
  failed?: boolean;
  area?: 'library' | 'create';
}>(), {
  label: undefined,
  description: undefined,
  failed: false,
  area: 'library',
});
</script>

<style scoped>
.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 210px), 1fr)); gap: 16px; }
.tile { min-width: 0; border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
.preview { height: 170px; }
.copy { display: grid; gap: 14px; padding: 14px; height: 117px; }
.create-loading,
.create {
  height: 100%;
  min-height: 0;
}
.create {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.panel-header {
  display: flex;
  flex: none;
  align-items: center;
  min-height: calc(16px * 1.55 + 16px);
  padding: 10px 16px 6px;
}
.navigation {
  flex: none;
  padding: 0 16px 8px;
  border-bottom: 1px solid var(--line);
}
.navigation > * {
  max-width: 100%;
}
.create-body {
  container: studio-create-loading / inline-size;
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}
.create-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 16px;
  scrollbar-gutter: stable;
}
.create-content {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 1160px;
}
.create-heading {
  display: grid;
  align-content: center;
  gap: 12px;
  height: calc(20px * 1.55 + 6px + 13px * 1.6);
}
.create-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 280px;
  align-items: start;
  gap: 16px;
}
.primary,
.meta {
  display: grid;
  gap: 16px;
  min-width: 0;
}
.create-card {
  display: grid;
  gap: 14px;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
}
.meta-field {
  display: grid;
  gap: 6px;
}
.create-footer {
  display: grid;
  flex: none;
  gap: 8px;
  padding: 12px 20px;
  border-top: 1px solid var(--line);
}
.footer-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.footer-actions > * {
  max-width: calc(50% - 8px);
}
@container studio-create-loading (max-width: 859px) {
  .create-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
@container studio-create-loading (max-width: 559px) {
  .create-scroll {
    padding: 12px 16px;
  }
  .create-footer {
    padding: 8px 16px;
  }
}
@media (max-height: 500px) {
  .create-scroll {
    padding: 8px 16px;
  }
  .create-heading {
    display: none;
  }
  .create-card {
    padding: 8px;
    gap: 8px;
  }
  .create-footer {
    padding: 8px 16px;
  }
}
</style>

<template>
  <TopbarActions>
    <span class="tlabel mono">#{{ taskId || '—' }} {{ t('core.diffDif') }}</span>
  </TopbarActions>
  <DiffPanel :task-id="taskId" />
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { t } from '../ui';
import { useRoute } from 'vue-router';
import TopbarActions from '../shared/layout/TopbarActions.vue';
import DiffPanel from './diff/DiffPanel.vue';

// Роут /diff — полноэкранный диф задачи. Ядро — переиспользуемый DiffPanel (тот же в модале).
const route = useRoute();
const taskId = computed(() => String(route.query.task || '').replace(/[^0-9]/g, ''));
</script>

<style scoped>
.tlabel { font-size: 12px; color: var(--ink-mid); }
</style>

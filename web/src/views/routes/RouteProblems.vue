<template>
  <section class="route-problems">
    <p v-if="stale" class="muted">Отчёт устарел: проверьте черновик снова.</p>
    <p v-else-if="!issues.length" class="muted">Проблем не найдено.</p>
    <ul v-else>
      <li v-for="(issue, index) in issues" :key="`${issue.path}:${index}`">
        <span :class="issue.severity">{{ issue.message }}</span>
        <small class="mono">{{ issue.path }}</small>
        <UiButton :data-test="`focus-issue${index ? `-${index}` : ''}`"
                  @click="$emit('focus', issue)">Перейти к полю</UiButton>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import type { RouteEditorIssue } from '../../../../shared/pipeline/routesEditorContracts.ts';
import { UiButton } from '../../ui';

defineProps<{ issues: RouteEditorIssue[]; stale: boolean }>();
defineEmits<{ focus: [issue: RouteEditorIssue] }>();
</script>

<style scoped>
.route-problems ul { margin: 0; padding-left: 20px; }
.route-problems li { display: flex; align-items: center; gap: 8px; margin: 4px 0; }
.route-problems .error { color: var(--bad); }
.route-problems .warning { color: var(--warn); }
.mono { font-family: var(--font-mono); font-size: 11px; }
</style>

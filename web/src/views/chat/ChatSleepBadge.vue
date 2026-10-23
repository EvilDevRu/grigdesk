<template>
  <span class="sleep-badge" v-tooltip="description" :aria-label="description">
    <svg width="12" height="9" viewBox="0 0 12 9" fill="none" aria-hidden="true">
      <path d="M1 1h5L1 8h5M8 4h3L8 8h3" />
    </svg>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import type { ChatBackgroundTask } from '../../../../shared/chat/chatBackgroundTasks.ts';
import { t, vTooltip } from '../../ui.ts';

const props = defineProps<{ tasks: ChatBackgroundTask[] }>();

const categories = [
  { kind: 'subagent', key: 'core.chatSleepSubagents' },
  { kind: 'monitor', key: 'core.chatSleepMonitors' },
  { kind: 'command', key: 'core.chatSleepCommands' },
  { kind: 'other', key: 'core.chatSleepOther' },
] as const;

const description = computed(() => {
  const lines = [t('core.chatSleepHeading')];

  for (const category of categories) {
    const tasks = props.tasks.filter((task) => task.kind === category.kind);

    if (!tasks.length) {
      continue;
    }

    lines.push(t(category.key, { count: tasks.length }));

    for (const task of tasks) {
      lines.push(t('core.chatSleepDescription', {
        description: task.description.trim() ? task.description : t('core.chatSleepNoDescription'),
      }));
    }
  }

  return lines.join('\n');
});
</script>

<style scoped>
.sleep-badge {
  position: absolute;
  left: 2px;
  bottom: 2px;
  display: grid;
  place-items: center;
  width: 15px;
  height: 12px;
  border-radius: 3px;
  color: var(--ink);
  background: var(--surface);
}

.sleep-badge path {
  stroke: currentColor;
  stroke-width: 1.4;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>

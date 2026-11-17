<template>
  <div :class="compact ? 'project-compact' : 'project-rail'"
    :data-chat-project-picker="compact ? 'compact' : 'rail'">
    <UiSelect v-if="compact" :model-value="modelValue" :aria-label="t('core.chatProjectChoose')"
      :disabled="disabled" searchable @update:model-value="emit('select', String($event ?? ''))">
      <option value="">{{ t('core.chatProjectAll') }}</option>
      <option value="@none">{{ t('core.chatProjectNone') }}</option>
      <option v-for="item in items" :key="item.id" :value="item.id">
        {{ item.title }}{{ item.archivedAt ? ` · ${t('core.chatFilterArchived')}` : '' }}
      </option>
    </UiSelect>
    <template v-else>
      <UiIconButton data-context="chat-project-rail-item" data-chat-project=""
        :label="t('core.chatProjectAll')" :pressed="modelValue === ''" :disabled="disabled"
        v-tooltip="t('core.chatProjectAll')" @click="emit('select', '')">
        <span aria-hidden="true">▦</span>
      </UiIconButton>
      <UiIconButton data-context="chat-project-rail-item" data-chat-project="@none"
        :label="t('core.chatProjectNone')" :pressed="modelValue === '@none'" :disabled="disabled"
        v-tooltip="t('core.chatProjectNone')" @click="emit('select', '@none')">
        <span aria-hidden="true">—</span>
      </UiIconButton>
      <div class="project-rail-scroll">
        <UiIconButton v-for="item in items" :key="item.id" data-context="chat-project-rail-item"
          :data-chat-project="item.id" :label="labelOf(item)" :pressed="modelValue === item.id"
          :disabled="disabled" v-tooltip="labelOf(item)" @click="emit('select', item.id)">
          <ProjectAvatar :id="item.id" :title="item.title" :icon="item.icon" />
        </UiIconButton>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { UiIconButton, UiSelect, vTooltip, t } from '../../ui.ts';
import ProjectAvatar from '../projects/ProjectAvatar.vue';
import type { ProjectSummary } from '../../../../shared/runtime/projectsContracts.ts';

defineProps<{
  modelValue: string;
  items: ProjectSummary[];
  compact?: boolean;
  disabled?: boolean;
}>();

const emit = defineEmits<{ select: [value: string] }>();

function labelOf(item: ProjectSummary): string {
  return item.archivedAt ? `${item.title} · ${t('core.chatFilterArchived')}` : item.title;
}
</script>

<style scoped>
.project-rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  box-sizing: border-box;
  width: 44px;
  flex: none;
  min-height: 0;
  padding-block: 6px;
  border-right: 1px solid var(--line);
}
.project-rail-scroll {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  min-height: 0;
  overflow: hidden auto;
  scrollbar-width: thin;
}

.project-compact {
  display: none;
  min-width: 0;
}

@media (max-width: 899px) {
  .project-rail { display: none; }
  .project-compact { display: block; }
}
</style>

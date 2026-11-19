<template>
  <div :class="compact ? 'project-compact' : 'project-rail'"
    :data-chat-project-picker="compact ? 'compact' : 'rail'">
    <template v-if="compact">
      <UiSelect :model-value="modelValue" :aria-label="t('core.chatProjectChoose')"
        :disabled="disabled" searchable @update:model-value="emit('select', String($event ?? ''))">
        <option value="">{{ t('core.chatProjectAll') }}</option>
        <option value="@none">{{ t('core.chatProjectNone') }}</option>
        <option v-for="item in items" :key="item.id" :value="item.id">
          {{ item.title }}
        </option>
      </UiSelect>
      <UiIconButton data-chat-project-create :label="t('core.projectNovyyProekt')"
        :disabled="disabled" v-tooltip="t('core.projectNovyyProekt')" @click="emit('create')">
        <ProjectIcon name="plus" />
      </UiIconButton>
    </template>
    <template v-else>
      <UiIconButton data-context="chat-project-rail-item" data-chat-project=""
        :label="t('core.chatProjectAll')" :pressed="modelValue === ''" :disabled="disabled"
        v-tooltip="t('core.chatProjectAll')" @click="emit('select', '')">
        <ProjectIcon name="chatList" />
      </UiIconButton>
      <UiIconButton data-context="chat-project-rail-item" data-chat-project="@none"
        :label="t('core.chatProjectNone')" :pressed="modelValue === '@none'" :disabled="disabled"
        v-tooltip="t('core.chatProjectNone')" @click="emit('select', '@none')">
        <span aria-hidden="true">—</span>
      </UiIconButton>
      <div class="project-rail-scroll">
        <UiIconButton v-for="item in items" :key="item.id" data-context="chat-project-rail-item"
          :data-chat-project="item.id" :label="item.title" :pressed="modelValue === item.id"
          :disabled="disabled" v-tooltip="item.title" @click="emit('select', item.id)">
          <ProjectAvatar :id="item.id" :title="item.title" :icon="item.icon" />
        </UiIconButton>
      </div>
      <UiIconButton data-chat-project-create :label="t('core.projectNovyyProekt')"
        :disabled="disabled" v-tooltip="t('core.projectNovyyProekt')" @click="emit('create')">
        <ProjectIcon name="plus" />
      </UiIconButton>
    </template>
  </div>
</template>

<script setup lang="ts">
import { UiIconButton, UiSelect, vTooltip, t } from '../../ui.ts';
import ProjectAvatar from '../projects/ProjectAvatar.vue';
import ProjectIcon from '../projects/ProjectIcon.vue';
import type { ProjectSummary } from '../../../../shared/runtime/projectsContracts.ts';

defineProps<{
  modelValue: string;
  items: ProjectSummary[];
  compact?: boolean;
  disabled?: boolean;
}>();

const emit = defineEmits<{ select: [value: string]; create: [] }>();
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
  flex: 1;
  overflow: hidden auto;
  scrollbar-width: none;
  overscroll-behavior-y: contain;
}

@supports selector(::-webkit-scrollbar) {
  .project-rail-scroll {
    scrollbar-width: auto;
    scrollbar-color: auto;
    scrollbar-gutter: stable both-edges;
  }

  .project-rail-scroll::-webkit-scrollbar {
    width: 2px;
  }

  .project-rail-scroll::-webkit-scrollbar-thumb {
    border: 0;
    background: var(--line-2);
  }

  .project-rail-scroll::-webkit-scrollbar-thumb:hover {
    background: var(--ink-mid);
  }
}

.project-compact {
  display: none;
  min-width: 0;
}

@media (max-width: 899px), (max-width: 1024px) and (max-height: 600px) {
  .project-rail { display: none; }
  .project-compact { display: flex; align-items: center; gap: 6px; }
  .project-compact > .ui-select-wrap { flex: 1; min-width: 0; }
}
</style>

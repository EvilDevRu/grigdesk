<template>
  <UiPaneHeader v-if="phone" class="phone-toolbar" data-ui-touch :aria-label="t('core.pipeline')">
    <div class="phone-toolbar__filters">
    <UiSelect
      data-role="pipeline-phone-project"
      data-context="pipeline-phone-filter"
      :aria-label="t('core.pipelineProject')"
      v-tooltip="selectedProject?.id === 'all' ? t('core.pipelineAllProjects') : selectedProject?.label"
      :model-value="project"
      @update:model-value="emit('project', String($event))"
    >
      <option v-for="option in projects" :key="option.id" :value="option.id">
        {{ option.id === 'all' ? t('core.pipelineAllProjects') : option.label }} · {{ option.count }}
      </option>
      <template #value>
        <span class="phone-toolbar__label">
          {{ project === 'all' ? t('core.pipelineAllProjects') : selectedProject?.label }}
        </span>
        <span class="phone-toolbar__count">{{ selectedProject?.count }}</span>
      </template>
    </UiSelect>

    <UiSelect
      data-role="pipeline-phone-status"
      data-context="pipeline-phone-filter"
      :aria-label="t('core.pipelineStatus')"
      v-tooltip="status === 'all' ? t('core.pipelineAllStatuses') : selectedStatus?.label"
      :data-filtered="status !== 'all' || undefined"
      :model-value="status"
      @update:model-value="emit('status', String($event))"
    >
      <option v-for="option in statuses" :key="option.id" :value="option.id">
        {{ option.id === 'all' ? t('core.pipelineAllStatuses') : option.label }} · {{ option.count }}
      </option>
      <template #value>
        <span class="phone-toolbar__label">{{ selectedStatus?.label }}</span>
        <span class="phone-toolbar__count">{{ selectedStatus?.count }}</span>
      </template>
    </UiSelect>

    </div>
    <template #actions>
    <UiPopover
      has-popup="menu"
      placement="bottom-end"
      :aria-label="t('core.pipelineRunControls')"
      :style="{ width: 'min(320px, calc(100vw - 20px))' }"
      data-ui-touch
    >
      <template #trigger>
        <UiIconButton
          data-phone-controls
          data-context="pipeline-phone-controls"
          :label="t('core.pipelineControls')"
          v-tooltip="t('core.pipelineControls')"
          :loading="bulkBusy !== null"
          :loading-label="t(bulkBusy === 'stop' ? 'core.stoppingPipelines' : 'core.startingPipelines')"
        >
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="5" cy="12" r="1.7" />
            <circle cx="12" cy="12" r="1.7" />
            <circle cx="19" cy="12" r="1.7" />
          </svg>
        </UiIconButton>
      </template>

      <template #default="{ close }">
        <div class="phone-controls">
          <div class="phone-controls__group" role="group" :aria-label="t('core.pipelineCardView')">
            <p class="phone-controls__heading">{{ t('core.pipelineCardView') }}</p>
            <UiButton
              data-role="pipeline-phone-compact"
              data-context="pipeline-phone-menu"
              variant="ghost"
              block
              role="menuitemcheckbox"
              :aria-checked="compact"
              :pressed="compact"
              @click="emit('compact', !compact)"
            >
              {{ t('core.pipelineCompactView') }}
            </UiButton>
            <UiButton
              data-role="pipeline-phone-loops"
              data-context="pipeline-phone-menu"
              variant="ghost"
              block
              role="menuitemcheckbox"
              :aria-checked="loopsOn"
              :pressed="loopsOn"
              :disabled="compact"
              @click="emit('loops', !loopsOn)"
            >
              {{ t('core.pipelineShowLoops') }}
            </UiButton>
            <p v-if="compact" class="phone-controls__hint">{{ t('core.pipelineLoopsHint') }}</p>
          </div>

          <div v-for="action in bulkActions" :key="action.id" class="phone-controls__group"
               role="group" :aria-label="t(action.label)">
            <p class="phone-controls__heading">{{ t(action.label) }}</p>
            <UiButton
              v-for="scope in ['project', 'all'] as const"
              :key="scope"
              :data-phone-bulk-action="action.id"
              data-context="pipeline-phone-menu"
              :data-bulk-scope="scope"
              variant="ghost"
              block
              role="menuitem"
              :disabled="disabled || bulkBusy !== null || !bulkCounts[action.id][scope]"
              @click="close('action'); emit('bulk', action.id, scope)"
            >
              <span class="phone-controls__command">
                <span>{{ t(action[scope]) }}</span>
                <b class="mono">{{ bulkCounts[action.id][scope] }}</b>
              </span>
            </UiButton>
          </div>
        </div>
      </template>
    </UiPopover>
    </template>
  </UiPaneHeader>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { UiButton, UiIconButton, UiPaneHeader, UiPopover, UiSelect, t, vTooltip } from '../../ui';

type BulkAction = 'resume' | 'stop';
type BulkScope = 'project' | 'all';

interface FilterOption {
  id: string;
  label: string;
  count: number;
}

const props = defineProps<{
  projects: FilterOption[];
  statuses: FilterOption[];
  project: string;
  status: string;
  compact: boolean;
  loopsOn: boolean;
  disabled: boolean;
  bulkBusy: BulkAction | null;
  bulkActions: readonly {
    id: BulkAction;
    label: 'core.startPipelines' | 'core.stopPipelines';
    project: 'core.startTabPipelines' | 'core.stopTabPipelines';
    all: 'core.startAllPipelines' | 'core.stopAllPipelines';
  }[];
  bulkCounts: Record<BulkAction, Record<BulkScope, number>>;
}>();

const emit = defineEmits<{
  project: [id: string];
  status: [id: string];
  compact: [value: boolean];
  loops: [value: boolean];
  bulk: [action: BulkAction, scope: BulkScope];
}>();

const media = window.matchMedia('(max-width: 600px)');
const phone = ref(media.matches);

const selectedProject = computed(() => props.projects.find((option) => option.id === props.project));
const selectedStatus = computed(() => props.statuses.find((option) => option.id === props.status));

function updatePhone() {
  phone.value = media.matches;
}

onMounted(() => media.addEventListener('change', updatePhone));
onUnmounted(() => media.removeEventListener('change', updatePhone));
</script>

<style scoped>
.phone-toolbar__filters {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
  align-items: center;
  gap: 4px;
}

.phone-toolbar__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.phone-toolbar__count {
  flex: none;
  font-variant-numeric: tabular-nums;
}

.phone-controls {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.phone-controls__group {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.phone-controls__heading,
.phone-controls__hint {
  margin: 0;
  padding: 4px 10px;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.5;
}

.phone-controls__command {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
}
</style>

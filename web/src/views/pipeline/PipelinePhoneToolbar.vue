<template>
  <div v-if="phone" class="phone-toolbar" data-ui-touch>
    <UiSelect
      data-role="pipeline-phone-project"
      :aria-label="t('core.pipelineProject')"
      :model-value="project"
      @update:model-value="emit('project', String($event))"
    >
      <option v-for="option in projects" :key="option.id" :value="option.id">
        {{ option.id === 'all' ? t('core.pipelineAllProjects') : option.label }} · {{ option.count }}
      </option>
    </UiSelect>

    <div class="phone-toolbar__row">
      <UiSelect
        data-role="pipeline-phone-status"
        :aria-label="t('core.pipelineStatus')"
        :model-value="status"
        @update:model-value="emit('status', String($event))"
      >
        <option v-for="option in statuses" :key="option.id" :value="option.id">
          {{ option.id === 'all' ? t('core.pipelineAllStatuses') : option.label }} · {{ option.count }}
        </option>
      </UiSelect>

      <UiPopover
        has-popup="menu"
        placement="bottom-end"
        :aria-label="t('core.pipelineRunControls')"
        :style="{ width: 'min(320px, calc(100vw - 20px))' }"
        data-ui-touch
      >
        <template #trigger>
          <UiButton
            data-role="pipeline-phone-controls"
            data-context="pipeline-phone-controls"
            :loading="bulkBusy !== null"
            :loading-label="t(bulkBusy === 'stop' ? 'core.stoppingPipelines' : 'core.startingPipelines')"
          >
            {{ t('core.pipelineControls') }}
          </UiButton>
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
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { UiButton, UiPopover, UiSelect, t } from '../../ui';

type BulkAction = 'resume' | 'stop';
type BulkScope = 'project' | 'all';

interface FilterOption {
  id: string;
  label: string;
  count: number;
}

defineProps<{
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

function updatePhone() {
  phone.value = media.matches;
}

onMounted(() => media.addEventListener('change', updatePhone));
onUnmounted(() => media.removeEventListener('change', updatePhone));
</script>

<style scoped>
.phone-toolbar {
  position: sticky;
  top: calc(var(--page-gutter) * -1);
  z-index: 30;
  display: grid;
  gap: 8px;
  margin: calc(var(--page-gutter) * -1) calc(var(--page-gutter) * -1) -2px;
  padding: 8px var(--page-gutter);
  border-bottom: 1px solid var(--line);
  background: var(--topbar);
}

.phone-toolbar__row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  min-width: 0;
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

<template>
  <span
    class="task-source-chip"
    :class="{ 'task-internal-flag': own }"
    v-tooltip="reason || name"
    :aria-label="reason ? `${name}: ${reason}` : name"
  >
    <img v-if="logo && !failed" :src="logo" alt="" @error="failed = true" />
    <span v-else-if="!own" class="task-source-chip__monogram" aria-hidden="true">{{ name.slice(0, 1) }}</span>
    <span>{{ name }}</span>
    <span v-if="reason">{{ t('core.trackerSourceUnavailable') }}</span>
  </span>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import { useTrackersStore } from '../stores/trackers.ts';
import { t, vTooltip } from '../ui.ts';

const props = defineProps<{ source?: string; driverId?: string }>();
const trackers = useTrackersStore();
const failed = ref(false);
const own = computed(() => props.source === 'grigdesk');
const id = computed(() => props.driverId ?? props.source?.split('@')[0]);
const driver = computed(() => trackers.catalog?.drivers.find((entry) => entry.id === id.value));
const name = computed(() => own.value ? 'GrigDesk'
  : driver.value?.name ?? id.value ?? t('core.boardTrackerSource'));
const logo = computed(() => own.value ? undefined : driver.value?.logoUrl);
const reason = computed(() => own.value ? '' : driver.value?.reason
  ?? (driver.value?.status === 'unavailable' ? t('core.trackerSourceUnavailable') : ''));

watch(logo, () => {
  failed.value = false;
});
</script>

<style scoped>
.task-source-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--ink-mid);
  font-size: 10px;
}
.task-source-chip img {
  width: 14px;
  height: 14px;
  object-fit: contain;
}
.task-source-chip__monogram {
  font-weight: 700;
}
</style>

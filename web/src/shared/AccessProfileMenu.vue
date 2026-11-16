<template>
  <div v-if="orderedProfiles.length > 1" class="access-profile-menu">
    <div ref="rail" class="access-profile-rail" data-profile-switcher>
      <UiSegmentedControl :model-value="list?.activeProfileId ?? ''" size="compact"
        :label="t('settings.accessProfilesConnection')">
        <UiButton v-for="profile in visibleProfiles" :key="profile.id" size="compact" variant="ghost"
          :pressed="profile.id === list?.activeProfileId"
          :disabled="switchDisabled && profile.id !== list?.activeProfileId"
          v-tooltip="profile.name" @click="store.activate(providerId, profile.id)">
          <span class="access-profile-label">{{ profile.name }}</span>
        </UiButton>
        <UiPopover v-if="hiddenProfiles.length" placement="top-end"
          :aria-label="t('settings.accessProfilesMore')">
          <template #trigger>
            <UiIconButton size="compact" :label="t('settings.accessProfilesMore')"
              v-tooltip="t('settings.accessProfilesMore')">…</UiIconButton>
          </template>
          <template #default="{ close }">
            <div class="access-profile-overflow">
              <UiButton v-for="profile in hiddenProfiles" :key="profile.id" variant="ghost" block wrap
                :pressed="profile.id === list?.activeProfileId"
                :disabled="switchDisabled && profile.id !== list?.activeProfileId"
                @click="store.activate(providerId, profile.id); close('action')">
                {{ profile.name }}
              </UiButton>
            </div>
          </template>
        </UiPopover>
      </UiSegmentedControl>
    </div>
    <p v-if="list && !list.switchAllowed" class="access-profile-hint" role="status">
      {{ t('settings.accessProfilesSwitchBusy') }}
    </p>
    <p v-if="store.errors[providerId]" class="access-profile-hint" role="alert">
      {{ store.errors[providerId] }}
      <UiButton variant="text" size="compact" @click="store.load(providerId)">
        {{ t('settings.accessProfilesRetry') }}
      </UiButton>
    </p>
    <div class="access-profile-measure" aria-hidden="true" inert>
      <div ref="measurement" class="access-profile-measure-row">
        <UiSegmentedControl :model-value="list?.activeProfileId ?? ''" size="compact" data-measure-group>
          <UiButton v-for="profile in orderedProfiles" :key="profile.id" size="compact" variant="ghost"
            data-measure-profile>
            <span class="access-profile-label">{{ profile.name }}</span>
          </UiButton>
          <UiIconButton size="compact" label="…" data-measure-overflow>…</UiIconButton>
        </UiSegmentedControl>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';

import { UiButton, UiIconButton, UiPopover, UiSegmentedControl, t, vTooltip } from '../ui.ts';
import { useAccessProfilesStore } from '../stores/accessProfiles.ts';
import { useSse } from '../composables/useSse.ts';

const props = defineProps<{ providerId: string }>();
const store = useAccessProfilesStore();
const rail = ref<HTMLElement | null>(null);
const measurement = ref<HTMLElement | null>(null);
const visibleCount = ref(0);
const list = computed(() => store.lists[props.providerId]);
const switchDisabled = computed(() => store.pending[props.providerId]
  || !!store.errors[props.providerId] || !list.value?.switchAllowed);
const orderedProfiles = computed(() => {
  const profiles = list.value?.profiles ?? [];

  return [
    ...profiles.filter((profile) => profile.id === list.value?.activeProfileId),
    ...profiles.filter((profile) => profile.id !== list.value?.activeProfileId),
  ];
});
const visibleProfiles = computed(() => orderedProfiles.value.slice(0, visibleCount.value));
const hiddenProfiles = computed(() => orderedProfiles.value.slice(visibleCount.value));
let observer: ResizeObserver | undefined;

/**
 * Ширины берутся с тех же controls: перевод и длинное имя учитываются до переполнения.
 * Для скрытых профилей резервируется место «…», активное подключение идёт первым.
 */
function measureProfiles(): void {
  if (!rail.value || !measurement.value) {
    return;
  }

  const widths = Array.from(measurement.value.querySelectorAll<HTMLElement>('[data-measure-profile]'))
    .map((element) => element.offsetWidth);
  const overflowWidth = measurement.value.querySelector<HTMLElement>('[data-measure-overflow]')
    ?.offsetWidth ?? 0;
  const groupWidth = measurement.value.querySelector<HTMLElement>('[data-measure-group]')?.offsetWidth ?? 0;
  const total = widths.reduce((sum, width) => sum + width, 0);
  const frame = Math.max(0, groupWidth - total - overflowWidth);
  const available = rail.value.clientWidth - frame;

  if (total <= available) {
    visibleCount.value = widths.length;

    return;
  }

  let used = 0;
  let count = 0;

  for (const width of widths) {
    const next = used + width;

    if (next > available - overflowWidth) {
      break;
    }

    used = next;
    count += 1;
  }

  visibleCount.value = count;
}

watch(() => props.providerId, () => store.load(props.providerId), { immediate: true });
watch(orderedProfiles, async () => {
  await nextTick();
  measureProfiles();
}, { flush: 'post' });
useSse((name) => store.refreshOnEvent(props.providerId, name));
watch([rail, measurement], ([railElement, measureElement]) => {
  observer?.disconnect();

  if (!railElement || !measureElement) {
    return;
  }

  observer ??= new ResizeObserver(measureProfiles);
  observer.observe(railElement);
  observer.observe(measureElement);
  measureProfiles();
}, { flush: 'post' });
onBeforeUnmount(() => observer?.disconnect());
</script>

<style scoped>
.access-profile-menu {
  position: relative;
  display: grid;
  gap: 6px;
  width: 100%;
  min-width: 0;
}
.access-profile-rail,
.access-profile-measure-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.access-profile-rail {
  min-width: 0;
}
.access-profile-label {
  display: block;
  max-width: 100px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.access-profile-overflow {
  display: grid;
  gap: 4px;
  width: min(280px, calc(100vw - 56px));
}
.access-profile-hint {
  margin: 0;
  color: var(--ink-mid);
  font-size: 11px;
  line-height: 1.4;
}
.access-profile-measure {
  position: absolute;
  inset: 0;
  height: 0;
  overflow: hidden;
  visibility: hidden;
  pointer-events: none;
}
.access-profile-measure-row {
  width: max-content;
}
</style>

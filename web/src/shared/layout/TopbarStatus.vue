<template>
  <UiPopover v-if="compact" v-model:open="open" class="ui-topbar-panel shell-status-panel"
             attachment="topbar" placement="bottom-end" :offset="0"
             :aria-label="t('core.systemStatus')" @close="emit('close')">
    <template #trigger>
      <UiIconButton variant="link" role="rail" data-context="topbar-action"
                    data-shell-status-trigger
                    :label="t('core.systemStatus')" :tone="attention ? 'warning' : 'neutral'">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 12h4l3-8 4 16 3-8h4" />
        </svg>
      </UiIconButton>
    </template>
    <header class="ui-topbar-panel__head">
      <strong class="ui-topbar-panel__title">{{ t('core.systemStatus') }}</strong>
    </header>
    <slot />
  </UiPopover>
  <slot v-else />
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { UiIconButton, UiPopover, t } from '../../ui.ts';

defineProps<{ attention?: boolean }>();

const open = defineModel<boolean>('open', { default: false });
const emit = defineEmits<{ close: [] }>();
const compact = ref(false);
let media: MediaQueryList | null = null;

const update = () => {
  compact.value = media?.matches ?? false;
};

watch(compact, () => {
  open.value = false;
  emit('close');
});

onMounted(() => {
  media = window.matchMedia('(max-width: 1100px)');
  media.addEventListener('change', update);
  update();
});

onBeforeUnmount(() => media?.removeEventListener('change', update));
</script>

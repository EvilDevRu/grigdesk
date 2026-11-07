<template>
  <section class="typed-example">
    <p>{{ context.t('greeting', undefined, String(context.settings.value.greeting ?? 'Привет')) }}</p>
    <UiButton tone="neutral" @click="clicked">
      <template #leading>→</template>
      {{ context.t('action', undefined, 'Проверить') }}
    </UiButton>
  </section>
</template>

<script setup lang="ts">
import { UiButton } from '@grigdesk/ui';
import type { PluginPanelProps } from '@grigdesk/plugin-types/web';

defineProps<PluginPanelProps>();

function clicked(event: MouseEvent): void {
  event.preventDefault();
}
</script>

<style scoped>
.typed-example {
  padding: 16px;
}
</style>

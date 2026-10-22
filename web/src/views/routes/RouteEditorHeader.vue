<template>
  <UiPaneHeader class="route-editor-header" inset="content">
    <template #title><h2>{{ heading || document.title }}</h2></template>
    <template #meta>
      <span class="route-editor-header__state">
        <span v-tooltip="document.title">Черновик · r{{ document.revision }}</span>
        <span v-if="readOnly">Только просмотр</span>
        <span v-else :class="{ 'is-saved': saved }" role="status">
          {{ saving ? 'Сохраняю…' : saved ? 'Сохранено' : 'Есть правки' }}
        </span>
      </span>
    </template>
    <template v-if="!readOnly && !saved" #actions>
      <UiButton data-context="workspace-toolbar" variant="outline" tone="accent"
                :loading="saving" :disabled="saving" @click="$emit('save')">Сохранить</UiButton>
    </template>
  </UiPaneHeader>
</template>

<script setup lang="ts">
import type { RouteDraft } from '../../../../shared/pipeline/routesEditorContracts.ts';
import { UiButton, UiPaneHeader, vTooltip } from '../../ui';

defineProps<{
  heading?: string;
  document: RouteDraft;
  readOnly: boolean;
  saved: boolean;
  saving: boolean
}>();
defineEmits<{ save: [] }>();
</script>

<style scoped>
.route-editor-header__state {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 8px 12px;
}

.is-saved {
  color: var(--ink-mid);
}
</style>

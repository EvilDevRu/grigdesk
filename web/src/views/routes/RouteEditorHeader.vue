<template>
  <header class="route-editor-header">
    <strong>{{ document.title }}</strong>
    <span class="muted">r{{ document.revision }}</span>
    <span v-if="readOnly" class="muted">Только просмотр</span>
    <span v-else class="route-editor-header__saved">{{ saved ? 'Сохранено' : 'Есть несохранённые правки' }}</span>
    <UiButton v-if="!readOnly && !saved" class="route-editor-header__save"
              :loading="saving" :disabled="saving"
              @click="$emit('save')">Сохранить</UiButton>
  </header>
</template>

<script setup lang="ts">
import type { RouteDraft } from '../../../../shared/routesEditorContracts.ts';
import { UiButton } from '../../ui';

defineProps<{
  document: RouteDraft;
  readOnly: boolean;
  saved: boolean;
  saving: boolean
}>();
defineEmits<{ save: [] }>();
</script>

<style scoped>
.route-editor-header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.route-editor-header__saved { color: var(--good); font-size: 12px; }
.route-editor-header__save { flex: none; white-space: nowrap; }
</style>

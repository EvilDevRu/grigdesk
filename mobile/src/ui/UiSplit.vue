<template>
  <div
    class="app-page split"
    :class="{ 'chat-split': chatLayout }"
    :data-detail="detail ? 'true' : 'false'"
    :data-list-hidden="chatLayout && detail && !layout.listVisible || undefined"
    :style="chatLayout ? { '--chat-list-width': layout.listWidth + 'rem' } : undefined"
  >
    <section class="pane split-list"><slot /></section>
    <div class="split-detail">
      <RouterView v-if="detail" />
      <UiEmpty v-else class="split-empty" :icon="emptyIcon" :text="emptyText" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { RouterView, useRoute } from 'vue-router';

import type { IconName } from './icons.ts';
import UiEmpty from './UiEmpty.vue';
import { useChatLayoutStore } from '../stores/chatLayout.ts';

defineProps<{
  emptyText: string;
  emptyIcon: IconName;
  chatLayout?: boolean;
}>();

// Список и карточка — одна страница: на планшете они стоят рядом, на узком экране
// CSS оставляет одну колонку по тому, открыта ли карточка в адресе.
const route = useRoute();
const layout = useChatLayoutStore();
const detail = computed(() => Boolean(route.params.id));
</script>

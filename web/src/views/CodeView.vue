<template>
  <div class="tool-route-adapter" data-tool-route="code" aria-hidden="true"></div>
</template>

<script setup>
// Route-adapter намеренно не импортирует CodePanel: единственный экземпляр панели
// принадлежит постоянному ToolHost в AppShell. Здесь только перевод deep-link
// (`#/code?project=…&repo=…&root=…&path=…`) в обычный intent панели — тем же путём,
// которым открывает ссылку чат. Query после постановки убирается replace-ом: он
// живёт один переход и не должен повторно открывать файл при возврате назад.
import { watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useDockStore } from '../stores/dock.js';
import { parseCodeRouteHref } from '../features/code/links.js';

const route = useRoute();
const router = useRouter();
const dock = useDockStore();

watch(() => route.fullPath, () => {
  if (route.name !== 'code') {
    return;
  }

  const query = new URLSearchParams(
    Object.entries(route.query)
      .filter(([, value]) => typeof value === 'string')
      .map(([key, value]) => [key, value]),
  );
  const target = parseCodeRouteHref(`#/code?${query}`);

  if (!target) {
    return;
  }

  dock.enqueue('code', { type: 'open-file', ...target });
  router.replace({ name: 'code' });
}, { immediate: true });
</script>

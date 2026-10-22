<template>
  <div class="tool-route-adapter" data-tool-route="studio3d" aria-hidden="true"></div>
</template>

<script setup lang="ts">
// Route-adapter не монтирует панель 3D: ею владеет единственный ToolHost.
import { onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { firstQueryValue } from '../shared/alertTargets.ts';
import { useDockStore } from '../stores/dock.ts';

const route = useRoute();
const router = useRouter();
const dock = useDockStore();

/**
 * Query страницы /3d переводится в команду дока ровно один раз на изменение.
 * После пересылки адрес принадлежит чату, поэтому он очищается заменой маршрута.
 */
function forward(): void {
  const tab = firstQueryValue(route.query.tab);
  const model = firstQueryValue(route.query.model);
  const version = firstQueryValue(route.query.version);

  if (!tab && !model && !version) {
    return;
  }

  dock.enqueue('studio3d', {
    type: 'open',
    ...(tab && { tab }),
    ...(model && { model }),
    ...(version && { version })
  });
  void router.replace({ name: 'studio3d' });
}

onMounted(forward);
watch(() => [route.query.tab, route.query.model, route.query.version], forward);
</script>

<template>
  <section class="route-revision-history revs">
    <h3>Ревизии каталога</h3>
    <div v-if="healthy.length > 1" class="route-revision-history__compare">
      <label>От
        <UiSelect data-test="revision-from" :model-value="fromHash"
                  @update:model-value="fromHash = String($event ?? '')">
          <option v-for="revision in healthy" :key="revision.catalogHash"
                  :value="revision.catalogHash">{{ revision.catalogHash.slice(0, 12) }}</option>
        </UiSelect>
      </label>
      <label>К
        <UiSelect data-test="revision-to" :model-value="toHash"
                  @update:model-value="toHash = String($event ?? '')">
          <option v-for="revision in healthy" :key="revision.catalogHash"
                  :value="revision.catalogHash">{{ revision.catalogHash.slice(0, 12) }}</option>
        </UiSelect>
      </label>
      <UiButton data-test="compare-revisions" :disabled="busy || !fromHash || !toHash
                || fromHash === toHash" @click="$emit('compare', fromHash, toHash)">
        Сравнить ревизии
      </UiButton>
    </div>
    <div v-for="revision in revisions" :key="revision.catalogHash" class="route-revision-history__row">
      <span class="mono">{{ revision.catalogHash.slice(0, 12) }}</span>
      <span class="muted">{{ formatDate(revision.createdAt) }}</span>
      <span v-if="revision.routes" class="muted route-revision-history__routes">
        {{ Object.keys(revision.routes).join(', ') }}
      </span>
      <span v-if="revision.isCurrent">current</span>
      <span v-if="revision.integrity !== 'ok'" class="bad">
        Повреждена: {{ revision.integrity }}
      </span>
      <div class="route-revision-history__actions">
        <UiButton :data-test="`view-${revision.catalogHash}`"
                  :disabled="busy || revision.integrity !== 'ok'"
                  @click="$emit('view', revision.catalogHash)">Открыть</UiButton>
        <UiButton :data-test="`create-${revision.catalogHash}`"
                  :disabled="busy || revision.integrity !== 'ok'"
                  @click="$emit('create', revision.catalogHash)">Создать черновик</UiButton>
        <UiButton v-if="!revision.isCurrent" :data-test="`rollback-${revision.catalogHash}`"
                  :disabled="busy || revision.integrity !== 'ok'"
                  @click="$emit('rollback', revision)">Откатить</UiButton>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { RouteRevision } from '../../../../shared/routesContracts.ts';
import { UiButton, UiSelect } from '../../ui';

const props = defineProps<{ revisions: RouteRevision[]; busy: boolean }>();

defineEmits<{
  view: [catalogHash: string];
  create: [catalogHash: string];
  compare: [fromCatalogHash: string, toCatalogHash: string];
  rollback: [revision: RouteRevision];
}>();

const healthy = computed(() => props.revisions.filter((revision) => revision.integrity === 'ok'));
const fromHash = ref('');
const toHash = ref('');

watch(healthy, (revisions) => {
  if (!revisions.some((revision) => revision.catalogHash === fromHash.value)) {
    fromHash.value = revisions.find((revision) => !revision.isCurrent)?.catalogHash
      ?? revisions[0]?.catalogHash ?? '';
  }
  if (!revisions.some((revision) => revision.catalogHash === toHash.value)) {
    toHash.value = revisions.find((revision) => revision.isCurrent)?.catalogHash
      ?? revisions[0]?.catalogHash ?? '';
  }
}, { immediate: true });

function formatDate(value: string): string {
  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('ru-RU');
}
</script>

<style scoped>
.route-revision-history { display: grid; gap: 8px; }
/* Кнопки не сжимаются: «Открыть» и «Откатить», урезанные до «От…», неразличимы, а откат
   меняет весь каталог. На узкой панели действия уходят на следующую строку. */
.route-revision-history__row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
.route-revision-history__routes { flex: 1 1 220px; min-width: 0; }
.route-revision-history__actions { display: flex; flex: none; gap: 8px; margin-left: auto; }
.route-revision-history__compare { display: flex; align-items: end; gap: 10px; }
.route-revision-history__compare label { display: grid; gap: 4px; }
.mono { font-family: var(--font-mono); }
.bad { color: var(--bad); }
.muted { color: var(--ink-mid); }
</style>

<template>
  <section class="route-compare">
    <header>
      <strong v-if="'draftRevision' in report">Сравнение черновика r{{ report.draftRevision }}</strong>
      <strong v-else>Сравнение ревизий</strong>
      <span v-if="'currentCatalogHash' in report">
        current {{ report.currentCatalogHash?.slice(0, 12) ?? 'нет' }}
      </span>
      <span v-else>{{ report.fromCatalogHash.slice(0, 12) }} →
        {{ report.toCatalogHash.slice(0, 12) }}</span>
      <span v-if="'sourceRevision' in report">источник r{{ report.sourceRevision }}</span>
      <UiButton v-if="'draftRevision' in report" data-test="open-publish" :disabled="!canPublish"
                @click="$emit('publish')">Опубликовать этот снимок</UiButton>
    </header>
    <p v-if="!report.changes.length">Исполняемый каталог не изменился.</p>
    <details v-for="(change, index) in report.changes" :key="`${change.scope}:${change.routeId}:${index}`" open>
      <summary>{{ change.scope === 'bootstrap' ? 'Начальная разведка' : change.routeId }}:
        {{ change.kind === 'added' ? 'добавлено' : change.kind === 'removed' ? 'удалено' : 'изменено' }}
      </summary>
      <div class="route-compare__sides">
        <div><strong>До</strong><pre>{{ format(change.before) }}</pre></div>
        <div><strong>После</strong><pre>{{ format(change.after) }}</pre></div>
      </div>
      <details v-for="field in change.fields ?? []" :key="field.path">
        <summary class="mono">{{ field.path }} — {{ field.kind }}</summary>
        <div class="route-compare__sides">
          <pre>{{ format(field.before) }}</pre><pre>{{ format(field.after) }}</pre>
        </div>
      </details>
    </details>
    <details v-if="report.presentationChanges?.length">
      <summary>Расположение на холсте (не влияет на публикацию)</summary>
      <div v-for="field in report.presentationChanges" :key="field.path" class="mono">
        {{ field.path }}: {{ format(field.before) }} → {{ format(field.after) }}
      </div>
    </details>
  </section>
</template>

<script setup lang="ts">
import type {
  RouteCompareReport, RouteRevisionCompareReport,
} from '../../../../shared/routesEditorContracts.ts';
import { UiButton } from '../../ui';

defineProps<{ report: RouteCompareReport | RouteRevisionCompareReport; canPublish: boolean }>();
defineEmits<{ publish: [] }>();

function format(value: unknown): string {
  return value === null ? '—' : JSON.stringify(value, null, 2);
}
</script>

<style scoped>
.route-compare { overflow: auto; border: 1px solid var(--line); border-radius: 8px; padding: 10px; }
.route-compare header { display: flex; align-items: center; gap: 10px; }
.route-compare details { margin-top: 10px; }
.route-compare__sides { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.route-compare__sides > div { min-width: 0; }
.route-compare pre { max-height: 35vh; overflow: auto; white-space: pre-wrap;
  overflow-wrap: anywhere; background: var(--surface-2); padding: 10px; }
</style>

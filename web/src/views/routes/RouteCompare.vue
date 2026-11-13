<template>
  <section class="route-compare">
    <header>
      <strong v-if="'draftRevision' in report">{{ t('core.routeSravnenieChernovikaR') }}{{ report.draftRevision }}</strong>
      <strong v-else>{{ t('core.routeSravnenieReviziy') }}</strong>
      <span v-if="'currentCatalogHash' in report"> {{ 'current' }} {{ report.currentCatalogHash?.slice(0, 12) ?? t('core.routeNet') }}
      </span>
      <span v-else>{{ report.fromCatalogHash.slice(0, 12) }} →
        {{ report.toCatalogHash.slice(0, 12) }}</span>
      <span v-if="'sourceRevision' in report">{{ t('core.routeIstochnikR') }}{{ report.sourceRevision }}</span>
      <UiButton v-if="'draftRevision' in report" data-test="open-publish" :disabled="!canPublish"
                @click="$emit('publish')">{{ t('core.routeOpublikovatEtotSnimok') }}</UiButton>
    </header>
    <p v-if="!report.changes.length">{{ t('core.routeIspolnyaemyyKatalogNeIzmenilsya') }}</p>
    <details v-for="(change, index) in report.changes" :key="`${change.scope}:${change.routeId}:${index}`" open>
      <summary>{{ change.scope === 'bootstrap' ? t('core.routeNachalnayaRazvedka') : change.routeId }}:
        {{ change.kind === 'added' ? t('core.routeDobavleno') : change.kind === 'removed' ? t('core.routeUdaleno') : t('core.routeIzmeneno') }}
      </summary>
      <div class="route-compare__sides">
        <div><strong>{{ t('core.routeDo') }}</strong><pre>{{ format(change.before) }}</pre></div>
        <div><strong>{{ t('core.routePosle') }}</strong><pre>{{ format(change.after) }}</pre></div>
      </div>
      <details v-for="field in change.fields ?? []" :key="field.path">
        <summary class="mono">{{ field.path }} — {{ field.kind }}</summary>
        <div class="route-compare__sides">
          <pre>{{ format(field.before) }}</pre><pre>{{ format(field.after) }}</pre>
        </div>
      </details>
    </details>
    <details v-if="report.presentationChanges?.length">
      <summary>{{ t('core.routeRaspolozhenieNaHolsteNe') }}</summary>
      <div v-for="field in report.presentationChanges" :key="field.path" class="mono">
        {{ field.path }}: {{ format(field.before) }} → {{ format(field.after) }}
      </div>
    </details>
  </section>
</template>

<script setup lang="ts">
import type {
  RouteCompareReport, RouteRevisionCompareReport,
} from '../../../../shared/pipeline/routesEditorContracts.ts';
import { UiButton, t } from '../../ui';

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

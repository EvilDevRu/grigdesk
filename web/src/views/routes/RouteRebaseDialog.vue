<template>
  <section class="route-rebase-dialog" role="dialog" :aria-label="t('core.routePerenosChernovika')">
    <h3>{{ t('core.routePerenosChernovikaR') }}{{ preview.draftRevision }}</h3>
    <p>{{ t('core.routeNovoeOsnovanie') }} <code>{{ preview.currentCatalogHash.slice(0, 12) }}</code>{{ t('core.routeKazhdyyVyborZamenyaetTselyy') }}</p>
    <p v-if="!preview.conflicts.length">{{ t('core.routePeresecheniyNetNezavisimyePravki') }}</p>
    <div v-for="conflict in preview.conflicts" :key="keyOf(conflict)"
         class="route-rebase-dialog__conflict">
      <strong>{{ conflict.scope === 'bootstrap' ? t('core.routeNachalnayaRazvedka') : conflict.routeId }}</strong>
      <div class="route-rebase-dialog__versions">
        <div><span>{{ t('core.routeOsnovanie') }}</span><pre>{{ format(conflict.base) }}</pre></div>
        <div><span>{{ t('core.routeMoyaVersiya') }}</span><pre>{{ format(conflict.mine) }}</pre></div>
        <div><span>{{ t('core.routeTekuschiyKatalog') }}</span><pre>{{ format(conflict.current) }}</pre></div>
      </div>
      <label>{{ t('core.routeKakuyuVersiyuOstavit') }} <UiSelect :data-test="`rebase-choice-${keyOf(conflict)}`"
                  :model-value="choices[keyOf(conflict)] ?? ''"
                  @update:model-value="setChoice(conflict, String($event ?? ''))">
          <option value="">{{ t('core.routeVyberite') }}</option>
          <option value="mine">{{ t('core.routeMoyu') }}</option>
          <option value="current">{{ t('core.routeIzTekuschegoKataloga') }}</option>
        </UiSelect>
      </label>
    </div>
    <div class="route-rebase-dialog__actions">
      <UiButton @click="$emit('cancel')">{{ t('core.cancel') }}</UiButton>
      <UiButton data-test="rebase-confirm" :disabled="busy || !resolved"
                @click="confirm">{{ t('core.routePerenestiChernovik') }}</UiButton>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, reactive, watch } from 'vue';
import type { RouteRebaseConflict, RouteRebasePreview,
  RouteRebaseResolution } from '../../../../shared/pipeline/routesEditorContracts.ts';
import { UiButton, UiSelect, t } from '../../ui';

const props = defineProps<{ preview: RouteRebasePreview; busy: boolean }>();
const emit = defineEmits<{ confirm: [resolutions: RouteRebaseResolution[]]; cancel: [] }>();
const choices = reactive<Record<string, RouteRebaseResolution['choice'] | ''>>({});

function keyOf(conflict: RouteRebaseConflict): string {
  return conflict.scope === 'bootstrap' ? 'bootstrap' : `route-${conflict.routeId}`;
}

function format(value: unknown): string {
  return value === null ? '—' : JSON.stringify(value, null, 2);
}

function setChoice(conflict: RouteRebaseConflict, value: string): void {
  choices[keyOf(conflict)] = value === 'mine' || value === 'current' ? value : '';
}

watch(() => props.preview, () => {
  for (const key of Object.keys(choices)) {
    delete choices[key];
  }
});

const resolved = computed(() => props.preview.conflicts.every(
  (conflict) => choices[keyOf(conflict)] === 'mine'
    || choices[keyOf(conflict)] === 'current',
));

function confirm(): void {
  if (!resolved.value || props.busy) {
    return;
  }

  emit('confirm', props.preview.conflicts.map((conflict) => ({
    scope: conflict.scope,
    routeId: conflict.routeId,
    choice: choices[keyOf(conflict)] as RouteRebaseResolution['choice'],
  })));
}
</script>

<style scoped>
.route-rebase-dialog { border: 1px solid var(--line); border-radius: 8px; padding: 12px; }
.route-rebase-dialog__conflict { border-top: 1px solid var(--line); padding: 10px 0; }
.route-rebase-dialog__versions { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.route-rebase-dialog__versions > div { min-width: 0; }
.route-rebase-dialog pre { max-height: 28vh; overflow: auto; white-space: pre-wrap;
  overflow-wrap: anywhere; background: var(--surface-2); padding: 8px; }
.route-rebase-dialog label { display: grid; gap: 5px; }
.route-rebase-dialog__actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>

<template>
  <UiDialog open data-ui-workspace :busy="busy" :dismissible="!busy"
    :title="`${t('core.routeOpublikovatChernovikR')}${report.draftRevision}?`"
    :close-label="t('core.close')" initial-focus="#route-publication-comment" @close="emit('cancel')">
    <div class="route-publish-dialog">
      <p>{{ t('core.routeNovyePopytkiPoydutPo') }}</p>
      <dl>
        <dt>{{ t('core.routeTekuschiyKatalog') }}</dt><dd class="mono">{{ report.currentCatalogHash?.slice(0, 12) ?? t('core.routeNet') }}</dd>
        <dt>{{ t('core.trackerSource') }}</dt><dd>{{ t('core.routeRedaktorIstochnikR') }}{{ report.sourceRevision }}</dd>
        <dt>{{ t('core.routeIzmeneniy') }}</dt><dd>{{ report.changes.length }}</dd>
      </dl>
      <label for="route-publication-comment">{{ t('core.routeKommentariyKPublikatsii') }} <UiTextarea id="route-publication-comment" v-model="comment"
                    data-test="publication-comment" maxlength="2000" />
      </label>
      <p v-if="!canPublish" class="bad">{{ t('core.routeSnimokUstarelIliSoderzhit') }}</p>
    </div>
    <template #footer>
      <UiButton :disabled="busy" @click="emit('cancel')">{{ t('core.cancel') }}</UiButton>
      <UiButton data-test="confirm-publish" variant="solid" tone="accent" :disabled="!canPublish || busy"
                @click="$emit('confirm', comment)">{{ t('core.routeOpublikovatEtotSnimok') }}</UiButton>
    </template>
  </UiDialog>
</template>

<script setup lang="ts">
import type { RouteCompareReport } from '../../../../shared/pipeline/routesEditorContracts.ts';
import { ref } from 'vue';
import { UiButton, UiDialog, UiTextarea, t } from '../../ui';

defineProps<{
  report: RouteCompareReport;
  canPublish: boolean;
  busy?: boolean
}>();

const emit = defineEmits<{ confirm: [comment: string]; cancel: [] }>();

const comment = ref('');
</script>

<style scoped>
.route-publish-dialog dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; }
.route-publish-dialog label { display: grid; gap: 6px; }
.mono { font-family: var(--font-mono); }
.bad { color: var(--bad); }
</style>

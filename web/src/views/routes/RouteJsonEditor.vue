<template>
  <section class="route-json-editor">
    <h3>{{ t('core.routeJsonPolnogoChernovika') }}</h3>
    <p class="muted">{{ t('core.routeZdesRedaktiruyutsyaNazvanieMarshruty') }}</p>
    <div class="route-json-editor__actions">
      <UiButton data-test="json-format" @click="emit('format')">{{ t('core.routeFormatirovat') }}</UiButton>
      <UiButton data-test="json-apply" :disabled="readOnly" @click="emit('apply')"> {{ t('core.routePrimenitKFormam') }} </UiButton>
    </div>
    <p v-if="buffer.dirty" class="bad">{{ t('core.routeJsonTekstEscheNe') }}</p>
    <p v-if="buffer.error" class="bad" role="alert">{{ buffer.error }}</p>
    <RouteMarkdownInput :model-value="buffer.raw" language="json"
                        data-test="json-raw"
                        @update:model-value="emit('update:raw', $event)"
                        @save="emit('apply')" />
    <div v-if="issues.length" role="alert" class="route-json-editor__issues">
      <strong>{{ t('core.routeProblemyProverkiEtogoDokumenta') }}</strong>
      <ul>
        <li v-for="(issue, index) in issues" :key="index">
          <code>{{ issue.path }}</code>: {{ issue.message }}
        </li>
      </ul>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { RouteEditorIssue } from '../../../../shared/pipeline/routesEditorContracts.ts';
import type { RouteJsonBuffer } from '../../actions/routes/jsonDraftBuffer.ts';
import { UiButton, t } from '../../ui';
import RouteMarkdownInput from './RouteMarkdownInput.vue';

defineProps<{
  buffer: RouteJsonBuffer;
  issues: RouteEditorIssue[];
  readOnly: boolean;
}>();

const emit = defineEmits<{
  'update:raw': [raw: string];
  format: [];
  apply: [];
}>();
</script>

<style scoped>
.route-json-editor { display: grid; gap: 10px; }
.route-json-editor__actions { display: flex; gap: 8px; }
.route-json-editor :deep(.route-markdown-input) { min-height: 320px; height: 50vh; }
.route-json-editor__issues { border: 1px solid var(--line); border-radius: 6px; padding: 10px; }
.bad { color: var(--bad); }
</style>

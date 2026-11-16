<template>
  <section class="route-draft-panel">
    <template v-if="routeEntry">
      <h3>{{ routeEntry.route.title || routeId }}</h3>
      <ol>
        <li v-for="node in routeEntry.route.nodes" :key="node.id">
          <span class="mono">{{ node.id }}</span>
          <small>{{ node.executor }}</small>
          <UiButton v-if="node.prompt" @click="$emit('select-node', node.id)">{{ t('core.routeInstruktsiya') }}</UiButton>
          <div v-if="node.prompt" class="route-draft-panel__prompts">
            <div v-for="block in node.prompt.blocks" :key="block.file">
              <small class="mono">{{ block.file }}</small>
              <pre>{{ routeEntry.prompts[block.file] ?? '' }}</pre>
            </div>
          </div>
        </li>
      </ol>
    </template>
    <p v-else class="bad">{{ t('core.routeMarshrut2') }}{{ routeId }}{{ t('core.routeOtsutstvuetVEtomChernovike') }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { RouteDraftContent } from '../../../../shared/pipeline/routesEditorContracts.ts';
import { UiButton, t } from '../../ui';

const props = defineProps<{ document: RouteDraftContent; routeId: string }>();

defineEmits<{ 'select-node': [nodeId: string] }>();

const routeEntry = computed(() => props.document.routes[props.routeId] ?? null);
</script>

<style scoped>
.route-draft-panel {
  overflow: auto;
  padding: 0;
}

.route-draft-panel h3 {
  margin: 0 0 10px;
}

.route-draft-panel ol {
  margin: 0;
  padding-left: 22px;
}

.route-draft-panel li {
  padding: 5px 0;
  border-top: 1px solid var(--line);
}

.route-draft-panel small {
  margin-left: 8px;
  color: var(--ink-mid);
}

.route-draft-panel__prompts {
  margin: 6px 0;
}

.route-draft-panel__prompts pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: var(--surface-2);
  padding: 8px;
  border-radius: var(--radius);
}
</style>

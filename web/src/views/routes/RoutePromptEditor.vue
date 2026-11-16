<template>
  <section class="route-prompt-editor">
    <template v-if="bundle && node?.prompt">
      <header><strong>{{ t('core.routeInstruktsiya2') }} {{ node.label || node.id }}</strong></header>
      <RoutePromptBlocks :blocks="node.prompt.blocks" :selected="selectedIndex"
                         @select="selectedIndex = $event" @move="moveBlock" />
      <template v-if="selectedBlock">
        <p class="muted mono">{{ selectedBlock.file }}</p>
        <div v-if="consumers.length > 1" class="route-prompt-shared">
          <span>{{ t('core.routeIspolzuyut2') }} {{ consumers.join(', ') }}</span>
          <UiButton data-test="copy-shared-block" @click="copySelectedBlock">{{ t('core.routeOtdelnayaKopiya') }}</UiButton>
        </div>
        <RouteMarkdownInput ref="markdownInput" :model-value="selectedText" @update:model-value="changeText"
                            @save="$emit('save')" @blur="$emit('end-history-group')" />
        <RouteContextFields :required-context="node.prompt.requiredContext"
                            :when="selectedBlock.when"
                            @update:required-context="changeRequiredContext"
                            @update:when="changeWhen" />
        <details open><summary>{{ t('core.routePredprosmotrMarkdown') }}</summary>
          <div class="route-prompt-preview" v-html="preview"></div>
        </details>
      </template>
      <p v-else class="muted">{{ t('core.routeDobavteBlokInstruktsii') }}</p>
    </template>
    <p v-else class="muted">{{ t('core.routeVybrannyyEtapNeSoderzhit') }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { DraftMachine } from '../../../../shared/pipeline/routeDefinition.ts';
import type { RouteWhen } from '../../../../shared/pipeline/routeDefinition.ts';
import type { RouteDraft } from '../../../../shared/pipeline/routesEditorContracts.ts';
import { mdToHtml } from '../../shared/md.ts';
import { UiButton, t } from '../../ui';
import RoutePromptBlocks from './RoutePromptBlocks.vue';
import RouteMarkdownInput from './RouteMarkdownInput.vue';
import RouteContextFields from './RouteContextFields.vue';

type Bundle = { route: DraftMachine; prompts: Record<string, string> };

const props = withDefaults(defineProps<{
  document: RouteDraft;
  routeId: string;
  nodeId: string;
  scope?: 'route' | 'bootstrap';
  focusPath?: string;
}>(), { scope: 'route' });
const emit = defineEmits<{
  change: [value: {
    routeId: string;
    bundle: Bundle;
    historyGroup?: string
  }];
  save: [];
  'end-history-group': [];
}>();
const selectedIndex = ref(0);
const markdownInput = ref<{ focus: () => void } | null>(null);
const bundle = computed<Bundle | null>(() => props.scope === 'bootstrap'
  ? { route: props.document.bootstrap, prompts: props.document.bootstrapPrompts }
  : props.document.routes[props.routeId] ?? null);
const node = computed(() => bundle.value?.route.nodes.find((entry) => entry.id === props.nodeId) ?? null);
const selectedBlock = computed(() => node.value?.prompt?.blocks[selectedIndex.value] ?? null);
const selectedText = computed(() => selectedBlock.value
  ? bundle.value?.prompts[selectedBlock.value.file] ?? '' : '');
const preview = computed(() => mdToHtml(selectedText.value));
const consumers = computed(() => {
  if (!bundle.value || !selectedBlock.value) {
    return [];
  }

  const file = selectedBlock.value.file;

  return bundle.value.route.nodes.filter((entry) =>
    entry.prompt?.blocks.some((block) => block.file === file)).map((entry) => entry.id);
});

watch(() => [props.routeId, props.nodeId], () => {
  emit('end-history-group');
  selectedIndex.value = 0;
});
watch(selectedIndex, () => emit('end-history-group'));
onBeforeUnmount(() => emit('end-history-group'));
watch(() => [props.focusPath, props.routeId, props.nodeId], async () => {
  const index = props.focusPath?.match(/\/prompt\/blocks\/(\d+)(?:\/|$)/)?.[1];

  if (index === undefined) {
    return;
  }

  const value = Number(index);

  if (!Number.isSafeInteger(value) || value < 0
    || value >= (node.value?.prompt?.blocks.length ?? 0)) {
    return;
  }

  selectedIndex.value = value;
  await nextTick();
  markdownInput.value?.focus?.();
}, { immediate: true });

/**
 * Применяет правку промптов и метаданных с группировкой истории.
 * Текст и блоки промпта редактируются внутри одного черновика каталога.
 */
function changeBundle(change: (next: Bundle) => void, historyGroup?: string): void {
  if (!bundle.value) {
    return;
  }

  const next = JSON.parse(JSON.stringify(bundle.value)) as Bundle;

  change(next);
  emit('change', {
    routeId: props.routeId,
    bundle: next,
    historyGroup
  });
}

/**
 * Записывает текст выбранного блока промпта.
 * Текст и блоки промпта редактируются внутри одного черновика каталога.
 */
function changeText(text: string): void {
  const file = selectedBlock.value?.file;

  if (!file) {
    return;
  }

  changeBundle((next) => {
     next.prompts[file] = text;
  },
    `prompt:${props.scope === 'bootstrap' ? 'bootstrap' : props.routeId}:${file}`);
}

/**
 * Создаёт отдельный файл блока для независимого потребителя.
 * Текст и блоки промпта редактируются внутри одного черновика каталога.
 */
function copySelectedBlock(): void {
  const file = selectedBlock.value?.file;

  if (!file || consumers.value.length < 2) {
    return;
  }

  const base = file.endsWith('.md') ? file.slice(0, -3) : file;
  let candidate = `${base}.${props.nodeId}.md`;
  let suffix = 2;

  while (Object.hasOwn(bundle.value?.prompts ?? {}, candidate)) {
    candidate = `${base}.${props.nodeId}.${suffix}.md`;
    suffix += 1;
  }

  changeBundle((next) => {
    const target = next.route.nodes.find((entry) => entry.id === props.nodeId);
    const block = target?.prompt?.blocks[selectedIndex.value];

    if (!block) {
      return;
    }

    block.file = candidate;
    next.prompts[candidate] = next.prompts[file] ?? '';
  });
}

function changeRequiredContext(requiredContext: string[]): void {
  changeBundle((next) => {
    const target = next.route.nodes.find((entry) => entry.id === props.nodeId);

    if (target?.prompt) {
      target.prompt.requiredContext = requiredContext;
    }
  });
}

function changeWhen(when: RouteWhen | undefined): void {
  changeBundle((next) => {
    const target = next.route.nodes.find((entry) => entry.id === props.nodeId);
    const block = target?.prompt?.blocks[selectedIndex.value];

    if (!block) {
      return;
    }
    if (when) {
      block.when = when;
    }
    else {
      delete block.when;
    }
  });
}

function moveBlock({ from, to }: { from: number; to: number }): void {
  if (!node.value?.prompt || to < 0 || to >= node.value.prompt.blocks.length) {
    return;
  }

  changeBundle((next) => {
    const target = next.route.nodes.find((entry) => entry.id === props.nodeId);
    const blocks = target?.prompt?.blocks;

    if (!blocks) {
      return;
    }

    const [block] = blocks.splice(from, 1);

    if (block) {
      blocks.splice(to, 0, block);
    }
  });
  selectedIndex.value = to;
}
</script>

<style scoped>
.route-prompt-editor { min-height: 0; overflow: auto; border: 1px solid var(--line);
  border-radius: 8px; padding: 12px; }
.route-prompt-editor header { margin-bottom: 10px; }
.route-prompt-editor details { margin-top: 10px; }
.route-prompt-preview { padding: 10px; background: var(--surface-2); border-radius: 6px; }
.route-prompt-shared { display: flex; align-items: center; gap: 8px; }
.mono { font-family: var(--font-mono); }
</style>

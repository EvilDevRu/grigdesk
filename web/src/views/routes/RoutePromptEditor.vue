<template>
  <section class="route-prompt-editor">
    <template v-if="bundle && node?.prompt">
      <header><strong>Инструкция: {{ node.label || node.id }}</strong></header>
      <div v-if="templates.length" class="route-prompt-template">
        <label>Заготовка из библиотеки
          <UiSelect data-test="template-select" :model-value="selectedTemplateId"
                    @update:model-value="selectedTemplateId = String($event ?? '')">
            <option value="">Выберите заготовку</option>
            <option v-for="card in templates" :key="card.id" :value="card.id">
              {{ card.label }}
            </option>
          </UiSelect>
        </label>
        <UiButton data-test="copy-template" :disabled="!templateSupported"
                  @click="copyTemplate">Копировать текст заготовки</UiButton>
        <UiButton data-test="update-template" :disabled="!templateSupported || consumers.length > 1"
                  @click="openTemplateDiff">Обновить из заготовки</UiButton>
        <span v-if="selectedTemplate && !templateSupported" class="bad">
          Этот тип заготовки не поддерживается для этапа agent.
        </span>
        <span v-if="selectedTemplate && consumers.length > 1" class="muted">
          Сначала создайте отдельную копию общего блока.
        </span>
      </div>
      <section v-if="reviewedTemplate" data-test="template-diff" class="route-template-diff">
        <strong>Изменение инструкции</strong>
        <div><div><span>Сейчас</span><pre>{{ reviewedTemplate.before }}</pre></div>
          <div><span>После обновления</span><pre>{{ reviewedTemplate.after }}</pre></div></div>
        <UiButton data-test="cancel-template-update" @click="reviewedTemplate = null">Отмена</UiButton>
        <UiButton data-test="apply-template-update" :disabled="!reviewStillCurrent"
                  @click="applyTemplateUpdate">Применить показанное</UiButton>
      </section>
      <RoutePromptBlocks :blocks="node.prompt.blocks" :selected="selectedIndex"
                         @select="selectedIndex = $event" @move="moveBlock" />
      <template v-if="selectedBlock">
        <p class="muted mono">{{ selectedBlock.file }}</p>
        <div v-if="consumers.length > 1" class="route-prompt-shared">
          <span>Используют: {{ consumers.join(', ') }}</span>
          <UiButton data-test="copy-shared-block" @click="copySelectedBlock">Отдельная копия</UiButton>
        </div>
        <RouteMarkdownInput ref="markdownInput" :model-value="selectedText" @update:model-value="changeText"
                            @save="$emit('save')" @blur="$emit('end-history-group')" />
        <RouteContextFields :required-context="node.prompt.requiredContext"
                            :when="selectedBlock.when"
                            @update:required-context="changeRequiredContext"
                            @update:when="changeWhen" />
        <details open><summary>Предпросмотр Markdown</summary>
          <div class="route-prompt-preview" v-html="preview"></div>
        </details>
      </template>
      <p v-else class="muted">Добавьте блок инструкции.</p>
    </template>
    <p v-else class="muted">Выбранный этап не содержит инструкции.</p>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { DraftMachine } from '../../../../shared/pipeline/routeDefinition.ts';
import type { RouteWhen } from '../../../../shared/pipeline/routeDefinition.ts';
import type { RouteDraft } from '../../../../shared/pipeline/routesEditorContracts.ts';
import type { AgentCard } from '../../../../shared/pipeline/agentsContracts.ts';
import { mdToHtml } from '../../shared/md.ts';
import { UiButton, UiSelect } from '../../ui';
import RoutePromptBlocks from './RoutePromptBlocks.vue';
import RouteMarkdownInput from './RouteMarkdownInput.vue';
import RouteContextFields from './RouteContextFields.vue';

type Bundle = { route: DraftMachine; prompts: Record<string, string> };

const props = withDefaults(defineProps<{
  document: RouteDraft;
  routeId: string;
  nodeId: string;
  scope?: 'route' | 'bootstrap';
  templates?: Pick<AgentCard, 'id' | 'kind' | 'label' | 'prompt'>[];
  focusPath?: string;
}>(), { templates: () => [], scope: 'route' });
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
const selectedTemplateId = ref('');
const reviewedTemplate = ref<{
  file: string;
  before: string;
  after: string;
  templateId: string
} | null>(null);
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
const selectedTemplate = computed(() => props.templates.find((card) =>
  card.id === selectedTemplateId.value) ?? null);
const templateSupported = computed(() => selectedTemplate.value?.kind === 'agent'
  && node.value?.executor === 'agent' && Boolean(selectedBlock.value));
const reviewStillCurrent = computed(() => Boolean(reviewedTemplate.value
  && reviewedTemplate.value.file === selectedBlock.value?.file
  && reviewedTemplate.value.before === selectedText.value
  && reviewedTemplate.value.templateId === selectedTemplateId.value));

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

/**
 * Копирует библиотечный шаблон по значению в выбранный блок.
 * Текст и блоки промпта редактируются внутри одного черновика каталога.
 */
function copyTemplate(): void {
  const card = selectedTemplate.value;
  const file = selectedBlock.value?.file;

  if (!card || !file || !templateSupported.value) {
    return;
  }

  changeBundle((next) => {
    let targetFile = file;

    if (consumers.value.length > 1) {
      const base = file.endsWith('.md') ? file.slice(0, -3) : file;

      targetFile = `${base}.${props.nodeId}.md`;

      let suffix = 2;

      while (Object.hasOwn(next.prompts, targetFile)) {
        targetFile = `${base}.${props.nodeId}.${suffix}.md`;
        suffix += 1;
      }

      const target = next.route.nodes.find((entry) => entry.id === props.nodeId);
      const block = target?.prompt?.blocks[selectedIndex.value];

      if (block) {
        block.file = targetFile;
      }
    }

    next.prompts[targetFile] = card.prompt;
  });
}

function openTemplateDiff(): void {
  if (!templateSupported.value || consumers.value.length > 1
    || !selectedBlock.value || !selectedTemplate.value) {
    return;
  }

  reviewedTemplate.value = {
    file: selectedBlock.value.file,
    before: selectedText.value,
    after: selectedTemplate.value.prompt,
    templateId: selectedTemplate.value.id,
  };
}

/**
 * Применяет заранее просмотренную разницу обновления шаблона.
 * Текст и блоки промпта редактируются внутри одного черновика каталога.
 */
function applyTemplateUpdate(): void {
  const review = reviewedTemplate.value;

  if (!review || !reviewStillCurrent.value) {
    return;
  }

  changeBundle((next) => {
     next.prompts[review.file] = review.after;
  });
  reviewedTemplate.value = null;
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
.route-prompt-template { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.bad { color: var(--bad); }
.route-template-diff { border: 1px solid var(--line); padding: 10px; border-radius: 8px; }
.route-template-diff > div { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.route-template-diff pre { white-space: pre-wrap; overflow-wrap: anywhere; }
.mono { font-family: var(--font-mono); }
</style>

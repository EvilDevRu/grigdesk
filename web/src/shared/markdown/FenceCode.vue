<template>
  <div class="md-fence" :class="{ 'md-fence--collapsed': collapsed }" :data-lang="lang || undefined">
    <pre :id="bodyId" class="md-fence__pre"><FenceCodeLines :lines="lines" /></pre>
    <div class="md-fence__tools">
      <span v-if="lang" class="md-fence__lang">{{ lang }}</span>
      <slot name="tools" />
      <UiIconButton
        role="embedded"
        :label="copied ? 'Скопировано' : 'Копировать код'"
        :title="copied ? 'Скопировано' : 'Копировать код'"
        data-context="md-fence-copy"
        @click="copy"
      >
        <svg v-if="copied" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="20 6 9 17 4 12" />
        </svg>
        <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      </UiIconButton>
    </div>
    <UiDisclosureButton v-if="long" v-model:open="expanded" density="compact" :controls="bodyId"
                        data-context="md-fence-expand">
      {{ expanded ? 'Свернуть' : 'Показать полностью' }}
    </UiDisclosureButton>
  </div>
</template>

<script setup lang="ts">
import { computed, h, onUnmounted, ref, shallowRef, useId, watch } from 'vue';
import type { FunctionalComponent } from 'vue';

import { UiDisclosureButton, UiIconButton } from '../../ui';
import { writeClipboardText } from '../clipboard.ts';
import { highlightCode } from './codeHighlight.ts';
import { diffLines, isDiffLanguage, plainLines, shouldCollapse } from './fenceLines.ts';
import type { FenceLine, FenceToken } from './fenceLines.ts';

const props = defineProps<{
  code: string;
  lang: string;
  closed: boolean;
}>();

defineSlots<{ tools?(): unknown }>();

const bodyId = `md-fence-${useId().replaceAll(':', '')}`;
const highlighted = shallowRef<FenceToken[][] | null>(null);
const expanded = ref(false);
const copied = ref(false);
let highlightRun = 0;
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
let mounted = true;

const lines = computed<FenceLine[]>(() => {
  if (isDiffLanguage(props.lang)) {
    return diffLines(props.code);
  }

  if (highlighted.value) {
    return highlighted.value.map((tokens) => ({ kind: '', tokens }));
  }

  return plainLines(props.code);
});
const long = computed(() => shouldCollapse(props.code));
const collapsed = computed(() => long.value && !expanded.value);

/**
 * Строки кода строятся render-функцией: шаблон внутри <pre> сохранил бы свои отступы и
 * переносы как текст кода. Между строками — ровно один перенос, как в исходнике.
 */
const FenceCodeLines: FunctionalComponent<{ lines: FenceLine[] }> = (lineProps) => h(
  'code',
  null,
  lineProps.lines.flatMap((line, index) => {
    const node = h(
      'span',
      { class: line.kind ? ['md-line', `md-line--${line.kind}`] : 'md-line' },
      line.tokens.map((token) => h('span', token.color ? { style: { color: token.color } } : null,
        token.content)),
    );

    return index < lineProps.lines.length - 1 ? [node, '\n'] : [node];
  }),
);

FenceCodeLines.props = ['lines'];

/**
 * Подсвечивает только закрытый блок: пока агент печатает, текст меняется, и подсветка
 * каждого куска мигала бы. Поздний ответ прежнего запуска отбрасывается по номеру.
 */
async function highlight(): Promise<void> {
  highlightRun += 1;

  const run = highlightRun;

  highlighted.value = null;

  if (!props.closed || isDiffLanguage(props.lang)) {
    return;
  }

  const result = await highlightCode(props.code, props.lang);

  if (mounted && run === highlightRun) {
    highlighted.value = result;
  }
}

/**
 * Копирует исходный код блока, а не текст DOM: разметка подсветки в буфер не попадает.
 * Отметка «Скопировано» гаснет сама через полторы секунды.
 */
async function copy(): Promise<void> {
  const done = await writeClipboardText(props.code);

  if (!done || !mounted) {
    return;
  }

  copied.value = true;
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => {
    copied.value = false;
  }, 1500);
}

watch(() => [props.code, props.lang, props.closed], highlight, { immediate: true });
onUnmounted(() => {
  mounted = false;
  highlightRun += 1;
  clearTimeout(copiedTimer);
});
</script>

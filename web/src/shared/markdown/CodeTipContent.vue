<template>
  <div class="code-tip">
    <div v-if="caption" class="code-tip__caption">{{ caption }}</div>
    <pre class="code-tip__code"><FenceCodeLines :lines="lines" /></pre>
    <div v-if="remaining" class="code-tip__more">
      … ещё {{ remaining }} {{ lineWord }} — раскрой шаг для сохранённого текста
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, shallowRef, watch } from 'vue';

import { highlightCode } from './codeHighlight.ts';
import { FenceCodeLines } from './fenceCodeLines.ts';
import { plainLines, type FenceLine, type FenceToken } from './fenceLines.ts';

const props = withDefaults(defineProps<{
  code: string;
  lang: string;
  caption?: string;
  maxLines?: number;
}>(), {
  caption: '',
  maxLines: 24,
});

const highlighted = shallowRef<FenceToken[][] | null>(null);
let generation = 0;
let mounted = true;

const limit = computed(() => Number.isInteger(props.maxLines) && props.maxLines > 0 ? props.maxLines : 24);
const sourceLines = computed(() => props.code.replace(/\n$/, '').split('\n'));
const visibleCode = computed(() => sourceLines.value.slice(0, limit.value).join('\n'));
const remaining = computed(() => Math.max(0, sourceLines.value.length - limit.value));
const lineWord = computed(() => {
  const units = remaining.value % 10;
  const hundred = remaining.value % 100;

  if (units === 1 && hundred !== 11) {
    return 'строка';
  }
  if (units >= 2 && units <= 4 && (hundred < 12 || hundred > 14)) {
    return 'строки';
  }

  return 'строк';
});
const lines = computed<FenceLine[]>(() => highlighted.value
  ? highlighted.value.map((tokens) => ({ kind: '', tokens }))
  : plainLines(visibleCode.value));

/**
 * Подсветчик получает только строки, которые войдут в поверхность подсказки.
 * Пустой язык сохраняет простой текст и не загружает грамматику.
 */
async function highlight(): Promise<void> {
  const run = ++generation;

  highlighted.value = null;

  if (!props.lang) {
    return;
  }

  const result = await highlightCode(visibleCode.value, props.lang);

  if (mounted && run === generation) {
    highlighted.value = result;
  }
}

watch(() => [props.code, props.lang, props.maxLines], highlight, { immediate: true });
onBeforeUnmount(() => {
  mounted = false;
  generation += 1;
});
</script>

<style scoped>
.code-tip {
  display: flex;
  flex-direction: column;
  min-height: 0;
  max-height: inherit;
}

.code-tip__caption {
  flex: none;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  overflow: hidden;
  color: var(--ink-low);
  font-family: inherit;
}

.code-tip__code {
  flex: 0 1 auto;
  min-height: 0;
  overflow: hidden;
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.code-tip__more {
  flex: none;
  color: var(--ink-low);
}
</style>

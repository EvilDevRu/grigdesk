<template>
  <div ref="root" class="rich-md" @error.capture="imageError">
    <template v-for="segment in segments" :key="segment.key">
      <div v-if="segment.kind === 'markdown'" class="md-html" v-html="segment.html"></div>
      <FenceMermaid
        v-else-if="segment.kind === 'fence' && segment.fence === 'mermaid'"
        :code="segment.code"
        :closed="segment.closed"
      />
      <FenceCode
        v-else-if="segment.kind === 'fence'"
        :code="segment.code"
        :lang="segment.lang"
        :closed="segment.closed"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';

import { mdTokensToHtml } from '../md.ts';
import type { HrefResolver } from '../md.ts';
import FenceCode from './FenceCode.vue';
import FenceMermaid from './FenceMermaid.vue';
import { splitMarkdown } from './segments.ts';
import type { FenceSegment, MarkdownSegment } from './segments.ts';

type RenderedSegment = (MarkdownSegment & { html: string }) | FenceSegment;

const props = defineProps<{
  text: string;
  resolveHref?: HrefResolver;
  resolveImageHref?: HrefResolver;
}>();

const root = ref<HTMLElement | null>(null);

// Резолверы вызываются внутри computed: смена их реактивных источников перерисовывает
// ссылки без смены текста. Одинаковую HTML-строку Vue в DOM не переписывает.
const sourceSegments = computed(() => splitMarkdown(props.text));
const segments = computed<RenderedSegment[]>(() => sourceSegments.value.map((segment) => {
  if (segment.kind !== 'markdown') {
    return segment;
  }

  return {
    ...segment,
    html: mdTokensToHtml(segment.tokens, {
      resolveHref: props.resolveHref,
      resolveImageHref: props.resolveImageHref,
    }),
  };
}));

/**
 * Ошибка HTTP или декодирования заменяет картинку безопасным текстом из alt.
 * Удалённый узел и схемы не принадлежат текущему HTML-куску и здесь не обрабатываются.
 */
function imageError(event: Event): void {
  const target = event.target as HTMLImageElement | null;

  if (target?.tagName !== 'IMG' || !root.value?.contains(target) || !target.closest('.md-html')) {
    return;
  }

  const text = target.getAttribute('alt') || 'Изображение недоступно';

  target.replaceWith(target.ownerDocument.createTextNode(text));
}
</script>

<style scoped>
/* Рамка блока кода и схемы. Селектор с .md-fence > pre специфичнее правил потребителя
   (.text.md pre), поэтому блок одинаков в ответе и в реплике хода. */
.rich-md :deep(.md-fence),
.rich-md :deep(.md-diagram) {
  position: relative;
  margin: 6px 0 8px;
}

.rich-md :deep(.md-fence > pre.md-fence__pre) {
  margin: 0;
  padding: 10px 12px;
  overflow-x: auto;
  background: var(--ground);
  border: 1px solid var(--line);
  border-radius: 8px;
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.5;
  color: var(--md-code-foreground);
}

.rich-md :deep(.md-fence--collapsed > pre.md-fence__pre) {
  max-height: 320px;
  overflow-y: hidden;
}

/* Inline-code стиль потребителя не должен рисовать фон и отступы внутри блока. */
.rich-md :deep(.md-fence > pre.md-fence__pre > code) {
  background: none;
  padding: 0;
  border-radius: 0;
}

/* Кнопки блока видны при наведении и фокусе; на сенсорных экранах — всегда. */
.rich-md :deep(.md-fence__tools) {
  position: absolute;
  top: 4px;
  right: 4px;
  display: flex;
  align-items: center;
  gap: 2px;
  padding-left: 8px;
  background: var(--ground);
  border-radius: 7px;
  opacity: 0;
  transition: opacity 120ms ease;
}

.rich-md :deep(.md-fence:hover > .md-fence__tools),
.rich-md :deep(.md-fence:focus-within > .md-fence__tools),
.rich-md :deep(.md-diagram:hover > .md-fence__tools),
.rich-md :deep(.md-diagram:focus-within > .md-fence__tools) {
  opacity: 1;
}

@media (hover: none) {
  .rich-md :deep(.md-fence__tools) {
    opacity: 1;
  }
}

.rich-md :deep(.md-fence__lang) {
  padding-right: 4px;
  font-size: 11px;
  color: var(--ink-low);
}

.rich-md :deep(.md-line--add),
.rich-md :deep(.md-line--del),
.rich-md :deep(.md-line--hunk) {
  display: inline-block;
  min-width: 100%;
}

.rich-md :deep(.md-line--add) {
  background: color-mix(in srgb, var(--good) 16%, transparent);
}

.rich-md :deep(.md-line--del) {
  background: color-mix(in srgb, var(--bad) 16%, transparent);
}

.rich-md :deep(.md-line--hunk) {
  color: var(--accent);
}

.rich-md :deep(.md-line--meta) {
  color: var(--ink-mid);
}

.rich-md :deep(.md-diagram) {
  padding: 12px;
  background: var(--ground);
  border: 1px solid var(--line);
  border-radius: 8px;
}

.rich-md :deep(.md-diagram > img.md-diagram__image) {
  display: block;
  max-width: 100%;
  height: auto;
  margin: 0 auto;
  border-radius: 0;
  cursor: zoom-in;
}

.rich-md :deep(.md-diagram__error) {
  margin: 2px 0 8px;
  font-size: 11px;
  color: var(--ink-mid);
}

/* Плашки GitHub: цвет полосы, фона и заголовка задаёт тон плашки. */
.rich-md :deep(.md-html > blockquote.md-alert) {
  margin: 6px 0 8px;
  padding: 6px 10px;
  color: var(--ink);
  background: color-mix(in srgb, var(--md-alert-tone, var(--accent)) 8%, transparent);
  border-left: 3px solid var(--md-alert-tone, var(--accent));
  border-radius: 0 8px 8px 0;
}

.rich-md :deep(.md-alert--tip) {
  --md-alert-tone: var(--good);
}

.rich-md :deep(.md-alert--warning) {
  --md-alert-tone: var(--warn);
}

.rich-md :deep(.md-alert--caution) {
  --md-alert-tone: var(--bad);
}

.rich-md :deep(.md-alert__title) {
  font-weight: 600;
  color: var(--md-alert-tone, var(--accent));
}
</style>

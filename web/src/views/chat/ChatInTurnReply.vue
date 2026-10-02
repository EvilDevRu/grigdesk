<template>
  <div v-if="block?.text?.trim()" class="chat-in-turn-reply" data-role="chat-in-turn-reply"
       aria-label="Реплика агента">
    <div :id="bodyId" class="chat-in-turn-reply__body"
         :class="{ collapsed: !expanded, faded: !expanded && overflows }">
      <div ref="content" class="text md"
           v-html="html"></div>
    </div>
    <UiDisclosureButton v-if="overflows" v-model:open="expanded" density="compact" :controls="bodyId"
                        data-role="chat-reply-expand">
      {{ expanded ? 'Свернуть' : 'Показать полностью' }}
    </UiDisclosureButton>
    <span v-if="block.complete === false" class="chat-in-turn-reply__draft">Пишет…</span>
    <span v-if="block.truncated" class="chat-in-turn-reply__draft">Ответ сокращён</span>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useId, watch } from 'vue';
import { mdToHtml } from '../../shared/md.ts';
import { chatFileLinkHref } from '../../features/code/links.ts';
import { UiDisclosureButton } from '../../ui';

const props = defineProps<{
  block: {
    text?: string;
    complete?: boolean;
    truncated?: boolean;
  };
}>();

const bodyId = `chat-reply-${useId().replaceAll(':', '')}`;
const content = ref<HTMLElement | null>(null);
const expanded = ref(false);
const overflows = ref(false);
let observer: ResizeObserver | null = null;

const text = computed(() => props.block.text || '');
const html = computed(() => mdToHtml(text.value, { resolveHref: chatFileLinkHref }));

/**
 * Раскрытие нужно только там, где текст действительно длиннее четырёх строк.
 * Измерение повторяется при дописывании ответа и изменении ширины колонки чата.
 */
function measurePreview(): void {
  const element = content.value;

  if (!element) {
    return;
  }

  const style = getComputedStyle(element);
  const lineHeight = Number.parseFloat(style.lineHeight);
  const lines = Number.parseFloat(style.getPropertyValue('--chat-reply-preview-lines')) || 4;

  overflows.value = element.scrollHeight > lineHeight * lines + 1;
}

watch(html, async () => {
  await nextTick();
  measurePreview();
});

onMounted(() => {
  measurePreview();

  if (typeof ResizeObserver !== 'undefined' && content.value) {
    observer = new ResizeObserver(measurePreview);
    observer.observe(content.value);
  }
});
onUnmounted(() => observer?.disconnect());
</script>

<style scoped>
.chat-in-turn-reply {
  min-width: 0;
  font-size: var(--chat-reply-size, .78125rem);
  line-height: var(--chat-reply-leading, 1.5);
  color: var(--ink);
}
.chat-in-turn-reply__body.collapsed {
  max-height: calc(var(--chat-reply-size, .78125rem) * var(--chat-reply-leading, 1.5)
    * var(--chat-reply-preview-lines, 4));
  overflow: hidden;
}
.chat-in-turn-reply__body.faded { mask-image: linear-gradient(#000 75%, transparent); }
.chat-in-turn-reply__draft { display: block; font-size: 11px; color: var(--ink-mid); }
.text { overflow-wrap: anywhere; }
.text :deep(p) { margin: 0 0 4px; }
.text :deep(:first-child) { margin-top: 0; }
.text :deep(:last-child) { margin-bottom: 0; }
.text :deep(h1), .text :deep(h2), .text :deep(h3),
.text :deep(h4), .text :deep(h5), .text :deep(h6) {
  margin: 8px 0 4px;
  font-size: var(--chat-reply-heading-size, .875rem);
}
.text :deep(ul), .text :deep(ol) { margin: 4px 0; padding-left: 20px; }
.text :deep(a) { color: var(--accent); text-decoration: underline; }
.text :deep(code) { font-size: 12px; background: var(--surface-2); }
.text :deep(pre) { padding: 6px 8px; background: var(--ground); overflow-x: auto; }
.text :deep(blockquote) { margin: 4px 0; padding-left: 10px; border-left: 2px solid var(--line); }
.text :deep(table) { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; }
.text :deep(th), .text :deep(td) { border: 1px solid var(--line); padding: 3px 6px; }
.text :deep(img) { max-width: 100%; height: auto; cursor: zoom-in; }
</style>

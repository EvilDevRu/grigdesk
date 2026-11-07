<template>
  <div class="stage-document">
    <header class="document-toolbar">
      <UiDisclosureButton
        class="document-title"
        data-role="pipeline-section-disclosure"
        :controls="contentId"
        density="compact"
        :open="open"
        @update:open="$emit('update:open', $event)"
      >
        {{ title || t('core.stageDocument') }}
      </UiDisclosureButton>
      <UiPopover
        v-if="open && sections.length > 1"
        v-model:open="outlineOpen"
        has-popup="menu"
        placement="bottom-end"
        :aria-label="t('core.stageDocumentContents')"
        :style="{ width: 'min(320px, calc(100vw - 32px))' }"
      >
        <template #trigger>
          <UiButton class="outline-trigger" variant="ghost" size="compact">
            <template #leading>
              <svg class="outline-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M7 5h10M7 10h10M7 15h10M3 5h.01M3 10h.01M3 15h.01" />
              </svg>
            </template>
            {{ t('core.stageDocumentContents') }}
          </UiButton>
        </template>
        <template #default="{ close }">
          <nav class="document-outline" :aria-label="t('core.stageDocumentContents')">
            <UiButton
              v-for="section in sections"
              :key="section.id"
              role="menuitem"
              data-context="stage-document-section"
              variant="ghost"
              :tone="activeId === section.id ? 'accent' : 'neutral'"
              :aria-current="activeId === section.id ? 'location' : undefined"
              block
              wrap
              @click="goToSection(section, close)"
            >
              <span class="outline-entry" :class="{ 'is-nested': section.nested }">
                {{ section.title }}
              </span>
            </UiButton>
          </nav>
        </template>
      </UiPopover>
    </header>
    <article v-show="open" :id="contentId" ref="article" class="document-body md" v-html="html"></article>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, nextTick, ref, useId, watch } from 'vue';

import { mdToHtml } from '../../shared/md.ts';
import { UiButton, UiDisclosureButton, UiPopover, t } from '../../ui';
import type { UiPopoverCloseReason } from '../../ui';

interface DocumentSection {
  id: string;
  title: string;
  nested: boolean;
  element: HTMLElement;
}

const props = withDefaults(defineProps<{
  text: string;
  title?: string;
  open?: boolean;
}>(), { open: true });

defineEmits<{ 'update:open': [value: boolean] }>();

const article = ref<HTMLElement | null>(null);
const sections = ref<DocumentSection[]>([]);
const activeId = ref('');
const outlineOpen = ref(false);
const contentId = `stage-document-${useId()}`;
let ownerDocument: Document | undefined;

const html = computed(() => mdToHtml(props.text));

/**
 * Оглавление читает только заголовки готового безопасного HTML: примеры Markdown
 * внутри кода и цитат не становятся разделами, а повторяющиеся названия получают разные id.
 */
function collectSections(): void {
  const headings = [...(article.value?.children || [])].filter(
    (element): element is HTMLElement => /^H[1-3]$/.test(element.tagName),
  );
  const contentHeadings = headings.filter((heading) => heading.tagName !== 'H1');
  const entries = contentHeadings.length ? contentHeadings : headings;
  const firstLevel = Math.min(...entries.map((heading) => Number(heading.tagName.slice(1))));

  sections.value = entries.map((element, index) => {
    const id = `${contentId}-section-${index}`;

    element.id = id;
    element.tabIndex = -1;

    return {
      id,
      title: element.textContent?.trim() || '',
      nested: Number(element.tagName.slice(1)) > firstLevel,
      element,
    };
  });
  activeId.value = sections.value[0]?.id || '';
  outlineOpen.value = false;
}

/**
 * Текущий раздел считается относительно видимого верха всех прокручиваемых предков.
 * Это одинаково работает в колонке desktop и общем потоке узкой модалки.
 */
function updateActiveSection(): void {
  if (!article.value?.getClientRects().length) {
    return;
  }

  let top = 0;
  let bottom = article.value.ownerDocument.defaultView?.innerHeight || Infinity;
  let parent = article.value.parentElement;

  while (parent) {
    if (/(auto|scroll|hidden)/.test(getComputedStyle(parent).overflowY)) {
      const bounds = parent.getBoundingClientRect();

      top = Math.max(top, bounds.top);
      bottom = Math.min(bottom, bounds.bottom);
    }

    parent = parent.parentElement;
  }

  const passed = sections.value.filter((section) => section.element.getBoundingClientRect().top <= top + 80);
  const atEnd = article.value.getBoundingClientRect().bottom <= bottom + 1;

  activeId.value = (atEnd ? sections.value.at(-1) : passed.at(-1) || sections.value[0])?.id || '';
}

/**
 * Переход ждёт закрытия общего меню и завершения его собственного возврата фокуса.
 * Затем фокус оказывается на заголовке, откуда можно продолжить чтение с клавиатуры.
 */
async function goToSection(
  section: DocumentSection,
  close: (reason?: UiPopoverCloseReason) => void,
): Promise<void> {
  close('action');
  await nextTick();
  await nextTick();

  section.element.focus({ preventScroll: true });
  section.element.scrollIntoView({ block: 'start', behavior: 'auto' });
  activeId.value = section.id;
}

watch([html, article], collectSections, { flush: 'post' });
watch(() => props.open, (open) => {
  if (!open) {
    outlineOpen.value = false;
  }
});

onMounted(() => {
  ownerDocument = article.value?.ownerDocument;
  ownerDocument?.addEventListener('scroll', updateActiveSection, { capture: true, passive: true });
});

onBeforeUnmount(() => {
  ownerDocument?.removeEventListener('scroll', updateActiveSection, true);
});
</script>

<style scoped>
.stage-document {
  min-width: 0;
}

.document-toolbar {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--line);
  background: var(--surface);
}

.document-title {
  flex: 0 1 auto;
  width: auto;
}

.outline-trigger {
  flex: none;
}

.outline-icon {
  width: 16px;
  height: 16px;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
}

.document-outline {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: min(420px, 60dvh);
  overflow-y: auto;
  overscroll-behavior: contain;
}

.outline-entry {
  display: block;
  width: 100%;
  min-width: 0;
  text-align: left;
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.outline-entry.is-nested {
  padding-left: 14px;
}

.document-body {
  min-width: 0;
  width: 100%;
  margin: 0;
  padding-bottom: 24px;
  color: var(--ink);
  font-size: 14px;
  line-height: 1.65;
  overflow-wrap: anywhere;
}

.document-body :deep(> :first-child) {
  margin-top: 0;
}

.document-body :deep(p) {
  margin: 0 0 12px;
}

.document-body :deep(h1),
.document-body :deep(h2),
.document-body :deep(h3),
.document-body :deep(h4) {
  color: var(--ink);
  font-weight: 600;
  line-height: 1.4;
  scroll-margin-top: 64px;
  overflow-wrap: anywhere;
}

.document-body :deep(h1) {
  margin: 0 0 24px;
  font-size: 23px;
  letter-spacing: -.025em;
}

.document-body :deep(h2) {
  margin: 28px 0 12px;
  padding-top: 20px;
  border-top: 1px solid var(--line);
  font-size: 18px;
  letter-spacing: -.02em;
}

.document-body :deep(h2:first-child) {
  padding-top: 0;
  border-top: 0;
}

.document-body :deep(h3) {
  margin: 22px 0 10px;
  font-size: 15px;
}

.document-body :deep(h4) {
  margin: 22px 0 10px;
  font-size: 14px;
}

.document-body :deep(ul),
.document-body :deep(ol) {
  margin: 0 0 16px;
  padding-left: 24px;
}

.document-body :deep(li) {
  margin: 4px 0;
}

.document-body :deep(li::marker) {
  color: var(--ink-mid);
}

.document-body :deep(li > p),
.document-body :deep(li > ul),
.document-body :deep(li > ol) {
  margin-bottom: 8px;
}

.document-body :deep(strong) {
  color: var(--ink);
  font-weight: 600;
}

.document-body :deep(hr) {
  margin: 28px 0;
  border: 0;
  border-top: 1px solid var(--line);
}

.document-body :deep(blockquote) {
  margin: 20px 0;
  padding: 12px 18px;
  border-left: 3px solid var(--accent);
  background: color-mix(in srgb, var(--accent) 6%, transparent);
  color: var(--ink-mid);
}

.document-body :deep(blockquote > :last-child) {
  margin-bottom: 0;
}

.document-body :deep(a) {
  color: var(--accent);
  text-underline-offset: 3px;
}

.document-body :deep(code) {
  padding: 2px 5px;
  border-radius: 4px;
  background: var(--surface-2);
  font: .87em var(--mono);
}

.document-body :deep(pre) {
  max-width: 100%;
  margin: 20px 0;
  padding: 16px;
  overflow-x: auto;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--ground);
  line-height: 1.65;
}

.document-body :deep(pre code) {
  padding: 0;
  background: transparent;
  overflow-wrap: normal;
}

.document-body :deep(img) {
  max-width: 100%;
  height: auto;
  border-radius: 6px;
}

.document-body :deep(table) {
  display: block;
  width: 100%;
  max-width: 100%;
  margin: 20px 0;
  overflow-x: auto;
  border: 1px solid var(--line);
  border-radius: 6px;
  border-collapse: separate;
  border-spacing: 0;
  font-size: 12px;
}

.document-body :deep(th),
.document-body :deep(td) {
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
  text-align: left;
  vertical-align: top;
  line-height: 1.6;
}

.document-body :deep(th) {
  background: var(--surface-2);
  color: var(--ink-mid);
  font-weight: 600;
}

.document-body :deep(tbody tr:last-child td) {
  border-bottom: 0;
}

.document-body :deep(tbody tr:nth-child(even)) {
  background: color-mix(in srgb, var(--surface-2) 35%, transparent);
}

@media (max-width: 600px) {
  .document-toolbar {
    gap: 8px;
    margin-bottom: 16px;
  }

  .document-body :deep(h1) {
    font-size: 21px;
  }
}
</style>

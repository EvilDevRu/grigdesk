<template>
  <section class="help-browser" data-role="help-browser" data-ui-workspace>
    <UiPaneHeader v-if="!embedded">
      <template #title>
        <h1 class="help-brand"><UiHelpIcon />{{ t('core.helpTitle') }}</h1>
      </template>
    </UiPaneHeader>
    <div v-if="status === 'loading'" class="help-state">
      <UiLoadingState :label="t('core.loading')" />
    </div>
    <div v-else-if="status === 'error'" class="help-state">
      <UiInlineMessage tone="danger">
        {{ t(errorKey) }}
        <UiButton @click="$emit('retry')">{{ t('core.helpRetry') }}</UiButton>
      </UiInlineMessage>
    </div>
    <div v-else-if="bundle" class="help-columns">
      <aside class="help-sidebar" :data-expanded="indexExpanded">
        <div class="help-index-toggle">
          <UiDisclosureButton v-model:open="indexExpanded" :controls="indexId" variant="link" block>
            {{ t('core.helpContents') }}
          </UiDisclosureButton>
        </div>
        <div :id="indexId" class="help-index-panel">
          <div class="help-index-search">
            <UiSearchInput v-model="query" :aria-label="t('core.helpSearch')"
                           :placeholder="t('core.helpSearch')" maxlength="256" />
          </div>
          <nav class="help-index" :aria-label="t('core.helpContents')">
            <p v-if="query.trim()" class="help-search-summary" role="status">
              {{ items.length ? t('core.helpSearchCount', { count: items.length }) : t('core.helpNoResults') }}
            </p>
            <section v-for="group in groups" :key="group.section" class="help-index-group">
              <h2>{{ group.section }}</h2>
              <UiActionLink v-for="item in group.items" :key="item.id" class="help-index-item"
                            :href="`#/help/${item.id}`" variant="link" data-context="help-index-item"
                            :aria-current="articleId === item.id ? 'page' : undefined"
                            @click="navigateLink($event, item.id)">
                {{ item.title }}
              </UiActionLink>
            </section>
          </nav>
          <div class="help-index-footer">{{ t('core.helpVersion', { version: bundle.version }) }}</div>
        </div>
      </aside>
      <section class="help-reading">
        <UiPaneHeader>
          <span class="help-section">{{ article?.section ?? t('core.helpContents') }}</span>
          <template v-if="article" #actions>
            <UiButton v-if="canAsk" variant="ghost" data-context="workspace-toolbar"
                      @click="$emit('ask', article.id)">
              <template #leading>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
                     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M8 10h8M8 14h5M7 4h10a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H9l-5 4V7a3 3 0 0 1 3-3z" />
                </svg>
              </template>
              {{ t('core.helpAskAgent') }}
            </UiButton>
            <UiActionLink v-if="website" :href="website" target="_blank" variant="link">
              {{ t('core.helpOnWebsite') }}
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none"
                   stroke="currentColor" stroke-width="1.6"
                   stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M14 3h7v7M21 3l-9 9M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5" />
              </svg>
            </UiActionLink>
          </template>
        </UiPaneHeader>
        <div class="help-reading-body" :class="{ 'has-outline': outline.length > 0 }">
          <article ref="body" class="help-article" tabindex="-1" :aria-label="article?.title"
                   @click.capture="followLink">
            <UiInlineMessage v-if="uiLocale !== bundle.locale" class="help-language-note">
              {{ t('core.helpRussianContent') }}
            </UiInlineMessage>
            <RichMarkdown v-if="article" :text="article.markdown"
                          :resolve-href="resolveHref" :resolve-image-href="noImages" />
            <UiInlineMessage v-else>
              {{ t('core.helpArticleMissing') }}
              <UiButton @click="$emit('navigate', 'overview', '')">{{ t('core.helpContents') }}</UiButton>
            </UiInlineMessage>
          </article>
          <nav v-if="outline.length" class="help-outline" :aria-label="t('core.helpOnThisPage')">
            <h2>{{ t('core.helpOnThisPage') }}</h2>
            <UiActionLink v-for="heading in outline" :key="heading.id"
                          :href="`#/help/${articleId}#${heading.id}`" variant="link"
                          data-context="help-outline-item"
                          :aria-current="fragment === heading.id ? 'location' : undefined"
                          @click="navigateLink($event, articleId, heading.id)">
              {{ heading.title }}
            </UiActionLink>
          </nav>
        </div>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue';
import {
  UiActionLink,
  UiButton,
  UiDisclosureButton,
  UiHelpIcon,
  UiInlineMessage,
  UiLoadingState,
  UiPaneHeader,
  UiSearchInput,
  t,
  uiLocale,
} from '../../ui.ts';
import RichMarkdown from '../../shared/markdown/RichMarkdown.vue';
import type { HelpBundle } from '../../../../shared/help/helpContracts.ts';
import type { HelpLoadError } from '../../shared/helpLoader.ts';
import { helpHref } from '../../../../shared/help/helpLinks.ts';
import { queryHelp } from '../../../../shared/help/helpQuery.ts';

const props = withDefaults(defineProps<{
  bundle: HelpBundle | null;
  status: 'loading' | 'ready' | 'error';
  error?: HelpLoadError;
  articleId?: string;
  fragment?: string;
  canAsk?: boolean;
  showWebsite?: boolean;
  embedded?: boolean;
}>(), {
  error: '',
  articleId: 'overview',
  fragment: '',
  canAsk: false,
  showWebsite: true,
  embedded: false,
});

const emit = defineEmits<{
  navigate: [
    id: string,
    fragment: string
  ];
  retry: [
  ];
  ask: [
    id: string
  ];
}>();
const errorKey = computed(() => props.error === 'helpServerUpgradeRequired'
  ? 'core.helpServerUpgradeRequired' : 'core.helpUnavailable');

const indexId = `help-index-${useId().replaceAll(':', '')}`;
const query = ref('');
const indexExpanded = ref(false);
const body = ref<HTMLElement | null>(null);
const outline = ref<Array<{
  id: string;
  title: string;
}>>([]);

const article = computed(() => props.bundle?.articles.find((entry) => entry.id === props.articleId));
const items = computed(() => {
  if (!props.bundle) {
    return [];
  }
  if (!query.value.trim()) {
    return props.bundle.articles;
  }

  const result = queryHelp(props.bundle, {
    action: 'search', query: query.value
  });

  return 'items' in result ? result.items : [];
});
const groups = computed(() => [...new Set(items.value.map((item) => item.section))].map((section) => ({
  section,
  items: items.value.filter((item) => item.section === section),
})));
const website = computed(() => {
  if (!props.bundle || !props.showWebsite) {
    return '';
  }

  const version = props.bundle.version;

  return `https://grigdesk.com/help/${version}/index.html?locale=${uiLocale.value}#/help/${props.articleId}`;
});
const noImages = () => false as const;
const resolveHref = (href: string) => props.bundle ? helpHref(props.bundle, props.articleId, href) : false;

/**
 * Обычный выбор остаётся внутри reader и сворачивает оглавление узкого экрана.
 * Модификаторы сохраняют штатное открытие ссылки в другом окне или вкладке.
 */
function navigateLink(event: MouseEvent, id: string, fragment = ''): void {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
    return;
  }

  event.preventDefault();
  emit('navigate', id, fragment);

  if (indexExpanded.value) {
    indexExpanded.value = false;
    void nextTick(() => body.value?.focus({ preventScroll: true }));
  }
}

/**
 * Ссылки статей используют тот же выбор, что дерево, и не покидают текущую модалку.
 * Внешние HTTPS-ссылки обрабатывает существующая безопасная граница приложения.
 */
function followLink(event: MouseEvent): void {
  const target = event.target instanceof Element ? event.target.closest('a') : null;
  const href = target?.getAttribute('href') ?? '';
  const match = /^#\/help\/([a-z][a-z0-9-]*)(?:#(.*))?$/u.exec(href);

  if (match) {
    navigateLink(event, match[1]!, match[2] ?? '');
  }
}
/**
 * Заголовки получают стабильные якоря из видимого текста, а не из raw HTML статьи.
 * Неизвестный якорь оставляет начало статьи и не меняет маршрут или настройки.
 */
async function revealFragment(resetPosition = false): Promise<void> {
  await nextTick();

  const used = new Map<string, number>();
  const headings = [];

  for (const heading of body.value?.querySelectorAll('h1,h2,h3,h4,h5,h6') ?? []) {
    const base = (heading.textContent ?? '').normalize('NFKC').toLocaleLowerCase('ru-RU')
      .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/gu, '');
    const count = used.get(base) ?? 0;

    used.set(base, count + 1);
    heading.id = count ? `${base}-${count}` : base;

    if (heading.tagName === 'H2') {
      headings.push({
        id: heading.id,
        title: heading.textContent ?? '',
      });
    }
  }

  outline.value = headings;

  let fragment = '';

  try {
    fragment = decodeURIComponent(props.fragment || '');
  }
  catch {
    return;
  }

  const selected = [...(body.value?.querySelectorAll('[id]') ?? [])]
    .find((node) => node.id === fragment);

  const target = selected ?? (resetPosition ? body.value?.querySelector('h1') : null);

  target?.scrollIntoView?.({
    block: 'start'
  });
}

watch(() => [article.value?.id, article.value?.markdown, props.fragment, props.status], (_next, previous) => {
  void revealFragment(Boolean(previous?.[0]));
}, {
  immediate: true
});
</script>

<style scoped>
.help-browser {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--ground);
  container: help-browser / inline-size;
}

.help-brand {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.help-brand svg {
  width: 16px;
  height: 16px;
  color: var(--ink-mid);
}

.help-state {
  padding: 24px;
}

.help-columns {
  display: grid;
  flex: 1;
  grid-template-columns: 256px minmax(0, 1fr);
  min-height: 0;
  overflow: hidden;
}

.help-sidebar {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--sidebar);
  border-right: 1px solid var(--line);
}

.help-index-toggle {
  display: none;
}

.help-index-panel {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}

.help-index-search {
  padding: 16px 12px 12px;
}

.help-index {
  flex: 1;
  min-height: 0;
  padding: 0 8px 16px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}

.help-index-group + .help-index-group {
  margin-top: 18px;
}

.help-index-group h2,
.help-outline h2 {
  margin: 0 0 6px;
  padding: 4px 10px;
  color: var(--ink-low);
  font-size: 11px;
  font-weight: 600;
  line-height: 18px;
  letter-spacing: .04em;
}

.help-search-summary {
  margin: 0;
  padding: 4px 10px 12px;
  color: var(--ink-mid);
  font-size: 12px;
}

.help-index-footer {
  padding: 10px 18px;
  border-top: 1px solid var(--line);
  color: var(--ink-low);
  font-size: 11px;
}

.help-reading {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.help-section {
  color: var(--ink-mid);
  font-size: 12px;
}

.help-reading-body {
  display: grid;
  flex: 1;
  grid-template-columns: minmax(0, 1fr);
  align-content: start;
  align-items: start;
  gap: 36px;
  min-height: 0;
  padding: 32px clamp(24px, 3cqi, 48px) 56px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}

.help-reading-body.has-outline {
  grid-template-columns: minmax(0, 1fr) 164px;
}

.help-article {
  width: 100%;
  max-width: 800px;
  min-width: 0;
  margin-inline: auto;
  overflow-wrap: anywhere;
  color: var(--ink);
  font-size: 13px;
  line-height: 1.8;
}

.help-language-note {
  margin-bottom: 20px;
}

.help-article :deep(h1) {
  margin: 0 0 20px;
  font-size: 28px;
  font-weight: 650;
  line-height: 1.25;
  letter-spacing: -.025em;
}

.help-article :deep(h2) {
  margin: 28px 0 12px;
  padding-top: 24px;
  border-top: 1px solid var(--line);
  font-size: 16px;
  font-weight: 600;
  line-height: 1.4;
}

.help-article :deep(h3) {
  margin: 24px 0 10px;
  font-size: 14px;
  line-height: 1.5;
}

.help-article :deep(p) {
  margin: 0 0 14px;
}

.help-article :deep(h1 + p) {
  color: var(--ink-mid);
  font-size: 14px;
}

.help-article :deep(ul),
.help-article :deep(ol) {
  margin: 0 0 16px;
  padding-left: 24px;
}

.help-article :deep(li + li) {
  margin-top: 8px;
}

.help-article :deep(li::marker) {
  color: var(--ink-mid);
}

.help-article :deep(a) {
  color: var(--accent);
  text-decoration: none;
}

.help-article :deep(a:hover) {
  text-decoration: underline;
}

.help-article :deep(h1),
.help-article :deep(h2),
.help-article :deep(h3) {
  scroll-margin-top: 24px;
}

.help-article :deep(pre),
.help-article :deep(table) {
  display: block;
  max-width: 100%;
  overflow-x: auto;
}

.help-outline {
  position: sticky;
  top: 0;
  padding-left: 12px;
  border-left: 1px solid var(--line);
}

@container help-browser (max-width: 1100px) {
  .help-reading-body.has-outline {
    grid-template-columns: minmax(0, 1fr);
  }

  .help-outline {
    display: none;
  }
}

@container help-browser (max-width: 700px) {
  .help-columns {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
  }

  .help-sidebar {
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }

  .help-index-toggle {
    display: flex;
    padding: 2px 12px;
  }

  .help-index-panel {
    flex: initial;
    max-height: 45vh;
  }

  .help-sidebar[data-expanded='false'] .help-index-panel {
    display: none;
  }

  .help-index-search {
    padding-top: 4px;
  }

  .help-reading-body {
    padding: 24px 18px 40px;
  }

  .help-article :deep(h1) {
    font-size: 24px;
  }
}
</style>

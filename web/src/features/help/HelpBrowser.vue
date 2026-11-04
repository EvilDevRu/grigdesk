<template>
  <UiWorkspacePage class="help-browser" data-role="help-browser">
    <template #title><h1>{{ t('core.helpTitle') }}</h1></template>
    <template v-if="bundle" #meta>{{ t('core.helpVersion', { version: bundle.version }) }}</template>
    <UiLoadingState v-if="status === 'loading'" :label="t('core.loading')" />
    <UiInlineMessage v-else-if="status === 'error'" tone="danger">
      {{ t(errorKey) }}
      <UiButton @click="$emit('retry')">{{ t('core.helpRetry') }}</UiButton>
    </UiInlineMessage>
    <template v-else-if="bundle">
      <UiInlineMessage v-if="uiLocale !== bundle.locale">{{ t('core.helpRussianContent') }}</UiInlineMessage>
      <div class="help-columns">
        <nav class="help-index" :aria-label="t('core.helpContents')">
          <UiInput v-model="query" type="search" :aria-label="t('core.helpSearch')"
                   :placeholder="t('core.helpSearch')" maxlength="256" />
          <p v-if="query.trim() && !items.length" role="status">{{ t('core.helpNoResults') }}</p>
          <template v-for="group in groups" :key="group.section">
            <h2>{{ group.section }}</h2>
            <UiPressable v-for="item in group.items" :key="item.id" class="help-index-item"
                         :aria-current="articleId === item.id ? 'page' : undefined"
                         @click="$emit('navigate', item.id, '')">
              {{ item.title }}
            </UiPressable>
          </template>
        </nav>
        <article ref="body" class="help-article" @click.capture="followLink">
          <template v-if="article">
            <div class="help-article-actions">
              <UiButton v-if="canAsk" @click="$emit('ask', article.id)">
                {{ t('core.helpAskAgent') }}
              </UiButton>
              <UiActionLink v-if="website" :href="website" target="_blank">
                {{ t('core.helpOnWebsite') }}
              </UiActionLink>
            </div>
            <RichMarkdown :text="article.markdown" :resolve-href="resolveHref" :resolve-image-href="noImages" />
          </template>
          <UiInlineMessage v-else>
            {{ t('core.helpArticleMissing') }}
            <UiButton @click="$emit('navigate', 'overview', '')">{{ t('core.helpContents') }}</UiButton>
          </UiInlineMessage>
        </article>
      </div>
    </template>
  </UiWorkspacePage>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import {
  UiActionLink, UiButton, UiInlineMessage, UiInput, UiLoadingState, UiPressable,
  UiWorkspacePage, t, uiLocale,
} from '../../ui.ts';
import RichMarkdown from '../../shared/markdown/RichMarkdown.vue';
import type { HelpBundle } from '../../../../shared/help/helpContracts.ts';
import type { HelpLoadError } from '../../shared/helpLoader.ts';
import { helpHref } from '../../../../shared/help/helpLinks.ts';
import { queryHelp } from '../../../../shared/help/helpQuery.ts';
import { RELEASE_CHANNEL_URLS } from '../../../../shared/runtime/releaseChannelContracts.ts';

const props = withDefaults(defineProps<{
  bundle: HelpBundle | null;
  status: 'loading' | 'ready' | 'error';
  error?: HelpLoadError;
  articleId?: string;
  fragment?: string;
  canAsk?: boolean;
  showWebsite?: boolean;
}>(), {
  error: '',
  articleId: 'overview',
  fragment: '',
  canAsk: false,
  showWebsite: true
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

const query = ref('');
const body = ref<HTMLElement | null>(null);
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

  const origin = new URL(RELEASE_CHANNEL_URLS[0]).origin;
  const version = props.bundle.version;

  return `${origin}/help/${version}/index.html#/help/${props.articleId}`;
});
const noImages = () => false as const;
const resolveHref = (href: string) => props.bundle ? helpHref(props.bundle, props.articleId, href) : false;
/**
 * Ссылки статей используют тот же выбор, что дерево, и не покидают текущую модалку.
 * Внешние HTTPS-ссылки обрабатывает существующая безопасная граница приложения.
 */
function followLink(event: MouseEvent): void {
  const target = event.target instanceof Element ? event.target.closest('a') : null;
  const href = target?.getAttribute('href') ?? '';
  const match = /^#\/help\/([a-z][a-z0-9-]*)(?:#(.*))?$/u.exec(href);

  if (match) {
    event.preventDefault();
    emit('navigate', match[1]!, match[2] ?? '');
  }
}
/**
 * Заголовки получают стабильные якоря из видимого текста, а не из raw HTML статьи.
 * Неизвестный якорь оставляет начало статьи и не меняет маршрут или настройки.
 */
async function revealFragment(resetPosition = false): Promise<void> {
  await nextTick();

  const used = new Map<string, number>();

  for (const heading of body.value?.querySelectorAll('h1,h2,h3,h4,h5,h6') ?? []) {
    const base = (heading.textContent ?? '').normalize('NFKC').toLocaleLowerCase('ru-RU')
      .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/gu, '');
    const count = used.get(base) ?? 0;

    used.set(base, count + 1);
    heading.id = count ? `${base}-${count}` : base;
  }

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

watch(() => [article.value?.markdown, props.fragment], (_next, previous) => {
  void revealFragment(Boolean(previous?.[0]));
}, {
  immediate: true
});
</script>

<style scoped>
.help-article-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.help-columns { display: grid; grid-template-columns: minmax(180px, 260px) minmax(0, 1fr); gap: 24px; }
.help-index, .help-article { min-width: 0; }
.help-index-item { display: block; width: 100%; text-align: left; }
.help-article { overflow-wrap: anywhere; }
.help-article :deep(pre), .help-article :deep(table) { display: block; max-width: 100%; overflow-x: auto; }
@media (max-width: 700px) { .help-columns { grid-template-columns: minmax(0, 1fr); } }
</style>

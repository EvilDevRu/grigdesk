<template>
  <section class="document-panel">
    <div v-if="loading" class="state"><UiSpinner decorative /> Открываю документ…</div>
    <div v-else-if="error" class="state error">
      <b>Документ не открыт</b>
      <span>{{ error }}</span>
      <UiButton @click="load">Повторить</UiButton>
    </div>
    <div v-else-if="document" class="document-shell">
      <div class="document-meta">
        <span class="source">{{ document.source.label }}</span>
        <span class="path mono">{{ document.displayPath }}</span>
        <span class="size">{{ formatSize(document.size) }}</span>
        <span v-if="formatTime(document.modifiedAt)" class="modified">{{ formatTime(document.modifiedAt) }}</span>
        <span v-if="line > 0" class="line">строка {{ line }}</span>
        <UiButton v-if="document.format === 'markdown'" variant="ghost" :pressed="showSource"
                  @click="showSource = !showSource">
          {{ showSource ? 'Предпросмотр' : 'Исходник' }}
        </UiButton>
      </div>
      <article v-if="document.format === 'markdown' && !showSource" ref="contentEl"
               class="document-body markdown" v-html="markdown"></article>
      <pre v-else-if="document.format === 'markdown' || line > 0" ref="contentEl"
           class="document-body plain numbered"><code><span
        v-for="(value, index) in textLines" :key="index" class="text-line"
        :class="{ selected: index + 1 === line }" :data-line="index + 1"
      >{{ value || ' ' }}</span></code></pre>
      <pre v-else ref="contentEl" class="document-body plain"><code>{{ document.content }}</code></pre>
    </div>
    <div v-else class="state">Документ не выбран.</div>
  </section>
</template>

<script setup lang="ts">
// Переиспользуемое ядро viewer-а: route-страница — лишь одна оболочка. Компонент
// получает стабильный DocumentRef, читает API и не сохраняет содержимое в store/localStorage.
import { computed, nextTick, ref, watch } from 'vue';
import { api, failureText } from '../../shared/apiClient.ts';
import { parseDocumentFile, type DocumentFile } from './contracts.ts';
import { mdToHtml } from '../../shared/md.ts';
import { documentRefAssetHref, documentRefRouteHref } from './links.ts';
import { UiButton, UiSpinner } from '../../ui';

const props = defineProps({
  source: { type: String, default: '' },
  path: { type: String, default: '' },
  anchor: { type: String, default: '' },
  line: { type: Number, default: 0 },
});

const emit = defineEmits<{ loaded: [document: DocumentFile | null] }>();

const loading = ref(false);
const error = ref('');
const document = ref<DocumentFile | null>(null);
const contentEl = ref<HTMLElement | null>(null);
const showSource = ref(false);
let loadGeneration = 0;

function localLink(href: string) {
  const current = document.value?.ref;

  return current ? documentRefRouteHref(href, {
    source: current.source,
    basePath: current.path,
  }) : '';
}

function localImage(href: string) {
  const current = document.value?.ref;

  return current ? documentRefAssetHref(href, {
    source: current.source,
    basePath: current.path,
  }) : '';
}

const markdown = computed(() => document.value?.format === 'markdown'
  ? mdToHtml(document.value.content, {
    resolveHref: localLink,
    resolveImageHref: localImage,
    allowHtml: true,
  })
  : '');
const textLines = computed(() => String(document.value?.content || '').split('\n'));

function slug(value: unknown) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '') || 'section';
}

/**
 * Добавляет устойчивые якоря заголовкам и прокручивает к выбранной строке.
 * Декорирование ждёт DOM, чтобы выбор исходника и Markdown не терял позицию.
 */
async function decorateAndScroll() {
  await nextTick();

  const root = contentEl.value;

  if (!root) {
    return;
  }

  const seen = new Map<string, number>();

  for (const heading of root.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
    const base = slug(heading.textContent);
    const n = (seen.get(base) || 0) + 1;

    seen.set(base, n);

    if (!heading.id) {
      heading.id = n === 1 ? base : `${base}-${n}`;
    }
  }

  const wanted = props.anchor;
  const exactLineVisible = props.line > 0
    && (document.value?.format !== 'markdown' || showSource.value);
  const target = exactLineVisible
    ? root.querySelector(`[data-line="${props.line}"]`)
    : (wanted
      ? [...root.querySelectorAll('[id]')].find((node) => node.id === wanted || node.id === slug(wanted))
      : null);

  target?.scrollIntoView({ block: 'start' });
}

/**
 * Сбрасывает прежний файл и публикует только проверенный ответ текущего запроса.
 * Смена документа сохраняет прежнюю защиту от опоздавшей загрузки.
 */
async function load() {
  const generation = ++loadGeneration;

  document.value = null;
  error.value = '';
  emit('loaded', null);

  if (!props.source || !props.path) {
    return;
  }

  loading.value = true;

  try {
    const query = new URLSearchParams({ source: props.source, path: props.path });
    const value = await api.get(`/api/documents/file?${query}`);

    if (generation !== loadGeneration) {
      return;
    }

    const file = parseDocumentFile(value);

    document.value = file;
    // Точный :line важнее красивого render: открываем исходник с номерами строк.
    // Пользователь в любой момент может вернуться к Markdown-предпросмотру.
    showSource.value = file.format === 'markdown' && props.line > 0;
    emit('loaded', file);
    await decorateAndScroll();
  } catch (e) {
    if (generation === loadGeneration) {
      error.value = failureText(e, 'Не удалось открыть документ');
    }
  } finally {
    if (generation === loadGeneration) {
      loading.value = false;
    }
  }
}

watch(() => [props.source, props.path], load, { immediate: true });
watch(() => props.line, (value) => {
  if (value > 0 && document.value?.format === 'markdown') {
    showSource.value = true;
  }
});
watch(() => [props.anchor, props.line, markdown.value, showSource.value], decorateAndScroll);

/**
 * Показывает прежние единицы размера без изменения границ округления.
 * Небольшие файлы остаются в байтах, остальные показываются в килобайтах.
 */
function formatSize(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} Б`;
  }

  return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} КБ`;
}

function formatTime(value: string) {
  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('ru-RU');
}
</script>

<style scoped>
.document-panel { min-width: 0; min-height: 0; height: 100%; overflow: auto; background: var(--ground); }
.state { min-height: 240px; display: flex; align-items: center; justify-content: center; gap: 8px;
  color: var(--ink-mid); padding: 24px; }
.state.error { flex-direction: column; text-align: center; color: var(--bad); }
.state.error span { color: var(--ink-mid); }
.document-shell { min-height: 100%; }
.document-meta { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 8px;
  min-height: 36px; padding: 7px max(24px, calc((100% - 872px) / 2)); border-bottom: 1px solid var(--line); background: color-mix(in srgb, var(--ground) 94%, transparent);
  backdrop-filter: blur(8px); color: var(--ink-mid); font-size: 11px; }
.document-meta > span + span::before { content: '·'; margin-right: 8px; color: var(--line-2); }
.document-meta .source { color: var(--ink); font-weight: 600; }
.document-meta .path { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.document-body { box-sizing: border-box; width: min(920px, calc(100% - 32px)); margin: 0 auto; padding: 30px 24px 72px;
  color: var(--ink); font-size: 15px; line-height: 1.65; overflow-wrap: anywhere; }
.plain { white-space: pre-wrap; tab-size: 4; font: 13px/1.62 var(--mono, monospace); }
.plain code { font: inherit; }
.numbered { counter-reset: text-line; }
.text-line { display: block; min-height: 1.62em; padding: 0 8px 0 52px; margin: 0 -8px; position: relative; }
.text-line::before { content: attr(data-line); position: absolute; left: 0; width: 38px; text-align: right; color: var(--ink-mid); opacity: .65; }
.text-line.selected { background: color-mix(in srgb, var(--accent) 16%, transparent); border-radius: 4px; }
.markdown :deep(h1), .markdown :deep(h2), .markdown :deep(h3),
.markdown :deep(h4), .markdown :deep(h5), .markdown :deep(h6) { line-height: 1.25; margin: 1.45em 0 .55em; scroll-margin-top: 52px; }
.markdown :deep(h1) { margin-top: 0; font-size: 2em; }
.markdown :deep(h2) { padding-bottom: .25em; border-bottom: 1px solid var(--line); font-size: 1.55em; }
.markdown :deep(h3) { font-size: 1.28em; }
.markdown :deep(p), .markdown :deep(ul), .markdown :deep(ol), .markdown :deep(blockquote) { margin: 0 0 1em; }
.markdown :deep(ul), .markdown :deep(ol) { padding-left: 1.6em; }
.markdown :deep(a) { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
.markdown :deep(blockquote) { border-left: 3px solid var(--line-2); padding: 2px 0 2px 14px; color: var(--ink-mid); }
.markdown :deep(code) { border-radius: 4px; padding: 1px 5px; background: var(--surface-2); font: .9em var(--mono, monospace); }
.markdown :deep(pre) { overflow: auto; border: 1px solid var(--line); border-radius: 9px; padding: 14px;
  background: var(--surface); line-height: 1.5; }
.markdown :deep(pre code) { padding: 0; background: none; }
.markdown :deep(table) { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; margin-bottom: 1em; }
.markdown :deep(th), .markdown :deep(td) { border: 1px solid var(--line); padding: 6px 9px; text-align: left; }
.markdown :deep(th) { background: var(--surface-2); }
.markdown :deep(hr) { border: 0; border-top: 1px solid var(--line); margin: 1.6em 0; }
.markdown :deep(img) { display: block; max-width: 100%; height: auto; margin: 10px auto; border-radius: 8px; }
@media (max-width: 759px) {
  .document-meta { padding: 7px 14px; }
  .document-meta .size, .document-meta .modified { display: none; }
  .document-body { width: 100%; padding: 22px 14px 56px; font-size: 14px; }
  .plain { font-size: 12.5px; }
}
</style>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { api } from '../shared/api-client.js';
import { registerLayer } from '../shared/ui/layer-stack.js';
import { useDocumentPreviewStore } from '../stores/document-preview.js';
import DocumentPanel from '../features/documents/DocumentPanel.vue';
import { documentLinkFromClick, parseDocumentRouteHref } from '../features/documents/links.js';

const preview = useDocumentPreviewStore();
const source = ref('');
const documentPath = ref('');
const anchor = ref('');
const line = ref(0);
const documentValue = ref(null);
const resolving = ref(false);
const resolveError = ref('');
let generation = 0;

const title = computed(() => preview.image?.name
  || documentValue.value?.name
  || documentPath.value.split('/').filter(Boolean).at(-1)
  || 'Документ');

function clearDocument() {
  source.value = '';
  documentPath.value = '';
  anchor.value = '';
  line.value = 0;
  documentValue.value = null;
  resolveError.value = '';
}

watch(() => preview.href, async (href) => {
  const currentGeneration = ++generation;
  clearDocument();
  resolving.value = false;
  if (!href) return;
  const target = parseDocumentRouteHref(href);
  if (!target) {
    resolveError.value = 'Некорректная ссылка на документ';
    return;
  }
  anchor.value = target.anchor;
  line.value = target.line;
  if (!target.open) {
    source.value = target.source;
    documentPath.value = target.path;
    return;
  }

  resolving.value = true;
  try {
    const resolved = await api.post('/api/documents/resolve', { path: target.open });
    if (currentGeneration !== generation) return;
    source.value = resolved.ref.source;
    documentPath.value = resolved.ref.path;
  } catch (error) {
    if (currentGeneration === generation) {
      resolveError.value = error.message || 'Ссылка на документ недоступна';
    }
  } finally {
    if (currentGeneration === generation) resolving.value = false;
  }
}, { immediate: true });

function onDocumentClick(event) {
  const href = documentLinkFromClick(event);
  if (!href) return;
  event.preventDefault();
  preview.show(href);
}

let unregisterLayer = null;
watch(() => preview.visible, (visible) => {
  document.documentElement.classList.toggle('document-modal-open', visible);
  unregisterLayer?.();
  unregisterLayer = visible
    ? registerLayer('document-modal', { priority: 180, close: () => preview.close() })
    : null;
}, { immediate: true });
onBeforeUnmount(() => {
  unregisterLayer?.();
  document.documentElement.classList.remove('document-modal-open');
});
</script>

<template>
  <Transition name="document-modal">
    <div v-if="preview.visible" class="document-overlay" @click.self="preview.close()">
      <section class="document-modal" role="dialog" aria-modal="true" :aria-label="title"
               @click="onDocumentClick">
        <header class="document-head">
          <div class="document-title">
            <span>{{ title }}</span>
            <small v-if="preview.image" class="mono">Изображение из чата</small>
            <small v-else-if="documentValue?.displayPath" class="mono">{{ documentValue.displayPath }}</small>
          </div>
          <button type="button" class="document-close" title="Закрыть (Esc)" aria-label="Закрыть"
                  @click="preview.close()">✕</button>
        </header>
        <div v-if="preview.image" class="image-preview">
          <img :src="preview.image.src" :alt="preview.image.name" />
        </div>
        <div v-else-if="resolving" class="document-state"><span class="spin"></span> Проверяю ссылку…</div>
        <div v-else-if="resolveError" class="document-state error">{{ resolveError }}</div>
        <DocumentPanel v-else class="document-panel" :source="source" :path="documentPath"
                       :anchor="anchor" :line="line" @loaded="documentValue = $event" />
      </section>
    </div>
  </Transition>
</template>

<style scoped>
.document-overlay { position: fixed; inset: 0; z-index: 180; display: flex; align-items: center; justify-content: center;
  padding: 3vh 2vw; background: #000c; }
.document-modal { width: min(1120px, 96vw); height: 94vh; min-height: 0; display: flex; flex-direction: column;
  overflow: hidden; border: 1px solid var(--line-2); border-radius: 14px; background: var(--ground);
  box-shadow: 0 24px 70px #000c; }
.document-head { min-height: 52px; flex: none; display: flex; align-items: center; justify-content: space-between;
  gap: 16px; padding: 9px 14px 9px 18px; border-bottom: 1px solid var(--line); background: var(--topbar); }
.document-title { min-width: 0; display: flex; flex-direction: column; gap: 2px; color: var(--ink); font-size: 13px; font-weight: 650; }
.document-title span, .document-title small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.document-title small { color: var(--ink-mid); font-size: 10px; font-weight: 400; }
.document-close { width: 32px; height: 32px; flex: none; border: 1px solid var(--line); border-radius: 8px;
  background: var(--surface-2); color: var(--ink-mid); cursor: pointer; }
.document-close:hover { color: var(--ink); border-color: var(--line-2); }
.document-panel { flex: 1; min-height: 0; }
.image-preview { flex: 1; min-height: 0; display: grid; place-items: center; overflow: auto; padding: 20px;
  background: color-mix(in srgb, var(--ground) 92%, #000); }
.image-preview img { display: block; max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain;
  border-radius: 8px; box-shadow: 0 12px 44px #0008; }
.document-state { flex: 1; display: flex; align-items: center; justify-content: center; gap: 8px; padding: 24px;
  color: var(--ink-mid); text-align: center; }
.document-state.error { color: var(--bad); }
.document-modal-enter-active, .document-modal-leave-active { transition: opacity .15s ease; }
.document-modal-enter-from, .document-modal-leave-to { opacity: 0; }
@media (max-width: 759px) {
  .document-overlay { padding: 0; }
  .document-modal { width: 100vw; height: 100dvh; border: 0; border-radius: 0; }
}
</style>

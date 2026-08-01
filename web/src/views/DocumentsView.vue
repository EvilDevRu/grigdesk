<script setup>
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../shared/api-client.js';
import TopbarActions from '../shared/layout/TopbarActions.vue';
import DocumentPanel from '../features/documents/DocumentPanel.vue';

const route = useRoute();
const router = useRouter();
const document = ref(null);
const resolveError = ref('');
const resolving = ref(false);
let resolveGeneration = 0;

const source = computed(() => String(route.query.source || ''));
const documentPath = computed(() => String(route.query.path || ''));
const anchor = computed(() => String(route.query.anchor || ''));
const line = computed(() => Math.max(0, Number.parseInt(route.query.line, 10) || 0));

// Ответы, созданные до появления viewer-а, содержат абсолютный host path. Он живёт
// только один переход: сервер разрешает его в DocumentRef, затем replace убирает его из URL.
watch(() => String(route.query.open || ''), async (openPath) => {
  const generation = ++resolveGeneration;
  resolveError.value = '';
  if (!openPath) { resolving.value = false; return; }
  resolving.value = true;
  try {
    const resolved = await api.post('/api/documents/resolve', { path: openPath });
    if (generation !== resolveGeneration) return;
    await router.replace({
      name: 'documents',
      query: {
        source: resolved.ref.source,
        path: resolved.ref.path,
        ...(line.value ? { line: String(line.value) } : {}),
        ...(anchor.value ? { anchor: anchor.value } : {}),
      },
    });
  } catch (e) {
    if (generation === resolveGeneration) resolveError.value = e.message || 'Ссылка на документ недоступна';
  } finally {
    if (generation === resolveGeneration) resolving.value = false;
  }
}, { immediate: true });

const title = computed(() => document.value?.name || 'Документ');
function close() {
  if (window.history.length > 1) router.back();
  else router.push('/chats');
}
</script>

<template>
  <TopbarActions>
    <button class="back" type="button" title="Назад" @click="close">←</button>
    <span class="title" :title="document?.displayPath || title">{{ title }}</span>
  </TopbarActions>
  <main class="documents-view">
    <div v-if="resolving" class="resolve-state"><span class="spin"></span> Проверяю ссылку…</div>
    <div v-else-if="resolveError" class="resolve-state error">{{ resolveError }}</div>
    <DocumentPanel v-else :source="source" :path="documentPath" :anchor="anchor" :line="line"
                   @loaded="document = $event" />
  </main>
</template>

<style scoped>
.documents-view { height: 100%; min-height: 0; overflow: hidden; }
.back { width: 30px; height: 30px; display: grid; place-items: center; border: 1px solid var(--line);
  border-radius: 8px; background: var(--surface); color: var(--ink); cursor: pointer; font-size: 17px; }
.back:hover { border-color: var(--line-2); background: var(--surface-2); }
.title { max-width: min(54vw, 560px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--ink-mid); font: 12px var(--mono, monospace); }
.resolve-state { height: 100%; display: flex; align-items: center; justify-content: center; gap: 8px; color: var(--ink-mid); }
.resolve-state.error { color: var(--bad); padding: 24px; text-align: center; }
</style>

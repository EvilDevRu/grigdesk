<template>
  <section class="sect" data-role="pipeline-deferred-findings">
    <div class="secth">Замечания на будущее</div>
    <p v-if="loading">Читаю замечания попытки…</p>
    <div v-else-if="error" role="alert">
      <p>{{ error }}</p>
      <UiButton variant="text" @click="load">Повторить чтение</UiButton>
    </div>
    <template v-else>
      <p v-if="!items.length">Отложенных замечаний нет.</p>
      <template v-else>
        <p>Эти замечания ждут твоего решения на приёмке. Маршрут их не исправлял.</p>
        <ul>
          <li v-for="item in items" :key="findingKey(item)">
            <b>{{ item.id }}</b> — {{ item.summary }}
            <span class="source">{{ sourceLabel(item) }}</span>
          </li>
        </ul>
      </template>
    </template>
  </section>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';

import { isRecord } from '../../../../shared/lib/objects.ts';
import { errorMessage } from '../../../../shared/lib/errors.ts';
import { api } from '../../shared/apiClient.ts';
import { UiButton } from '../../ui';

interface DeferredFindingView {
  id: string;
  summary: string;
  sourceNode?: string;
  source?: { phase?: string } | null;
}

const props = defineProps({
  task: [Number, String],
  profile: String,
  attempt: String,
});

const emit = defineEmits<{ ready: [value: boolean] }>();

const items = ref<DeferredFindingView[]>([]);
const error = ref('');
const loading = ref(false);
let generation = 0;

function findingKey(item: DeferredFindingView) {
  return `${item.source?.phase || 'route'}/${item.sourceNode}/${item.id}`;
}

function sourceLabel(item: DeferredFindingView) {
  return item.source?.phase === 'bootstrap' ? 'Разведка SCOUT' : `Узел ${item.sourceNode}`;
}

/**
 * Проверяет поля находки, которые читает список и подпись источника.
 * Остальные поля остаются в исходном объекте для совместимости со старым сервером.
 */
function isDeferredFinding(value: unknown): value is DeferredFindingView {
  return isRecord(value) && typeof value.id === 'string' && typeof value.summary === 'string'
    && (value.sourceNode === undefined || typeof value.sourceNode === 'string')
    && (value.source == null || (isRecord(value.source)
      && (value.source.phase === undefined || typeof value.source.phase === 'string')));
}

/**
 * Старый ответ HTTP не может подменить список после смены попытки или закрытия окна.
 * При ошибке чтения родитель удерживает принятие; пустой проверенный список допустим.
 */
async function load() {
  const request = ++generation;

  emit('ready', false);
  items.value = [];
  error.value = '';
  loading.value = true;

  try {
    if (!props.task || !props.profile || !props.attempt) {
      throw new Error('Попытка не определена.');
    }

    const query = new URLSearchParams({ profile: props.profile, attempt: props.attempt });
    const value = await api.get(`/api/tasks/${props.task}/findings?${query}`);

    if (request !== generation) {
      return;
    }

    if (!isRecord(value) || value.attemptId !== props.attempt || value.profile !== props.profile
        || !isRecord(value.findings) || !Array.isArray(value.findings.deferred)
        || !value.findings.deferred.every(isDeferredFinding)) {
      throw new Error('Попытка изменилась — обнови карточку.');
    }

    items.value = value.findings.deferred;
    emit('ready', true);
  } catch (cause) {
    if (request !== generation) {
      return;
    }

    error.value = `Замечания недоступны: ${errorMessage(cause, 'Не удалось выполнить запрос')}`;
  } finally {
    if (request === generation) {
      loading.value = false;
    }
  }
}

watch(() => [props.task, props.profile, props.attempt], load, { immediate: true });
onBeforeUnmount(() => {
  generation += 1;
});
</script>

<style scoped>
.source { display: block; color: var(--ink-mid); font-size: 0.85em; }
li { margin-block: 0.5rem; overflow-wrap: anywhere; }
</style>

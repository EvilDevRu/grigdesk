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

<script setup>
import { onBeforeUnmount, ref, watch } from 'vue';
import { api } from '../../shared/apiClient.ts';
import { UiButton } from '../../ui';

const props = defineProps({
  task: [Number, String],
  profile: String,
  attempt: String,
});
const emit = defineEmits(['ready']);
const items = ref([]);
const error = ref('');
const loading = ref(false);
let generation = 0;

function findingKey(item) {
  return `${item.source?.phase || 'route'}/${item.sourceNode}/${item.id}`;
}

function sourceLabel(item) {
  return item.source?.phase === 'bootstrap' ? 'Разведка SCOUT' : `Узел ${item.sourceNode}`;
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

    if (value.attemptId !== props.attempt || value.profile !== props.profile
        || !Array.isArray(value.findings?.deferred)) {
      throw new Error('Попытка изменилась — обнови карточку.');
    }

    items.value = value.findings.deferred;
    emit('ready', true);
  } catch (cause) {
    if (request !== generation) {
      return;
    }

    error.value = `Замечания недоступны: ${cause.message}`;
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

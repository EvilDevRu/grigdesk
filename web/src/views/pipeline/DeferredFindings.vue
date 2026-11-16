<template>
  <section class="sect deferred-sect" data-role="pipeline-deferred-findings">
    <header class="deferred-head">
      <span class="deferred-title">{{ t('core.pipelineZamechaniyaNaBuduschee') }}</span>
      <span v-if="items.length" class="deferred-count">{{ items.length }}</span>
    </header>

    <UiLoadingState v-if="loading" :label="t('core.pipelineChitayuZamechaniyaPopytki')" variant="document">
      <div class="findings-loading"><UiSkeletonLayout layout="text" :header="false" /></div>
    </UiLoadingState>
    <div v-else-if="error" class="deferred-error" role="alert">
      <p>{{ error }}</p>
      <UiButton variant="text" size="compact" @click="load">{{ t('core.pipelinePovtoritChtenie') }}</UiButton>
    </div>
    <template v-else>
      <p v-if="!items.length" class="deferred-empty">{{ t('core.pipelineOtlozhennyhZamechaniyNet') }}</p>
      <template v-else>
        <p class="deferred-note"> {{ t('core.pipelineEtiZamechaniyaZhdutTvoego') }} </p>
        <ol class="deferred-list">
          <li v-for="(item, index) in items" :key="findingKey(item)" class="deferred-item">
            <span class="deferred-num" aria-hidden="true">{{ index + 1 }}</span>
            <div class="deferred-body">
              <p class="deferred-summary">{{ item.summary }}</p>
              <div class="deferred-meta">
                <code class="deferred-id">{{ item.id }}</code>
                <span class="deferred-source">{{ sourceLabel(item) }}</span>
              </div>
            </div>
          </li>
        </ol>
      </template>
    </template>
  </section>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';

import { isRecord } from '../../../../shared/lib/objects.ts';
import { errorMessage } from '../../../../shared/lib/errors.ts';
import { api } from '../../shared/apiClient.ts';
import { UiButton, UiLoadingState, UiSkeletonLayout, t } from '../../ui';

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
  return item.source?.phase === 'bootstrap'
        ? t('core.pipelineRazvedkaScout')
        : t('core.pipelineUzelSourcenode', { sourceNode: item.sourceNode });
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
      throw new Error(t('core.pipelinePopytkaNeOpredelena'));
    }

    const query = new URLSearchParams({ profile: props.profile, attempt: props.attempt });
    const value = await api.get(`/api/tasks/${props.task}/findings?${query}`);

    if (request !== generation) {
      return;
    }

    if (!isRecord(value) || value.attemptId !== props.attempt || value.profile !== props.profile
        || !isRecord(value.findings) || !Array.isArray(value.findings.deferred)
        || !value.findings.deferred.every(isDeferredFinding)) {
      throw new Error(t('core.pipelinePopytkaIzmenilasObnoviKartochku'));
    }

    items.value = value.findings.deferred;
    emit('ready', true);
  } catch (cause) {
    if (request !== generation) {
      return;
    }

    error.value = t('core.pipelineZamechaniyaNedostupnyErrormessagecause', {
      errorMessagecause: errorMessage(cause, t('core.pipelineNeUdalosVypolnitZapros')),
    });
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
.findings-loading {
  --skeleton-row-height: 20px;
}

/* Отложенные находки — решение человека на приёмке, поэтому раздел читается
   карточкой: заголовок со счётчиком, затем короткие нумерованные пункты.
   Раньше это был сплошной абзац с маркированным списком, и в колонке 400 px
   разные замечания сливались в один текст. */
.deferred-sect {
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: 11px;
  background: var(--ground);
}

.deferred-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.deferred-title {
  flex: 1;
  min-width: 0;
  color: var(--ink-mid);
  font-size: 11px;
  font-weight: 600;
  line-height: 1.3;
  letter-spacing: .08em;
  text-transform: uppercase;
}

.deferred-count {
  flex: none;
  min-width: 20px;
  padding: 1px 7px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--warn) 16%, transparent);
  color: var(--warn);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  font-weight: 650;
  line-height: 16px;
  text-align: center;
}

.deferred-note,
.deferred-empty {
  margin: 0;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.5;
}

.deferred-empty {
  color: var(--ink-low);
}

.deferred-error {
  display: grid;
  gap: 6px;
  color: var(--bad);
  font-size: 12.5px;
}

.deferred-error p {
  margin: 0;
  overflow-wrap: anywhere;
}

.deferred-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.deferred-item {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  gap: 8px;
  padding: 8px 0;
  border-top: 1px solid color-mix(in srgb, var(--line) 70%, transparent);
}

.deferred-item:first-child {
  border-top: 0;
  padding-top: 2px;
}

.deferred-num {
  padding-top: 1px;
  color: var(--ink-low);
  font-family: var(--mono);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  line-height: 16px;
  text-align: right;
}

.deferred-body {
  min-width: 0;
  display: grid;
  gap: 4px;
}

.deferred-summary {
  margin: 0;
  color: var(--ink);
  font-size: 12.5px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.deferred-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 8px;
  min-width: 0;
}

.deferred-id {
  max-width: 100%;
  overflow: hidden;
  color: var(--ink-mid);
  font-family: var(--mono);
  font-size: 10.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.deferred-source {
  color: var(--ink-low);
  font-size: 10.5px;
  line-height: 16px;
  white-space: nowrap;
}
</style>

<template>
  <section class="pane">
    <UiPaneHeader
      :title="current?.task.title || listed?.title || 'Задача Б24'"
      :sub="current?.task.status || ''"
      back="/b24"
      back-label="Все задачи Б24"
    />
    <div ref="body" class="pane-body">
      <div class="pane-content">
        <UiError
          v-if="store.detailError || error"
          :text="store.detailError || error"
          @retry="reload"
        />
        <p v-if="!current && !store.detailError && !error" class="list-loading" role="status">
          Загрузка…
        </p>
        <template v-if="current">
          <div class="detail-heading">
            <span class="row-id">Б24 #{{ current.task.id }}</span>
            <h2>{{ current.task.title }}</h2>
          </div>
          <dl class="detail-facts">
            <div>
              <dt>Статус</dt>
              <dd>{{ current.task.status }}</dd>
            </div>
            <div>
              <dt>Ответственный</dt>
              <dd>{{ current.task.responsible }}</dd>
            </div>
            <div v-if="current.task.deadline">
              <dt>Срок</dt>
              <dd>{{ new Date(current.task.deadline).toLocaleDateString('ru-RU') }}</dd>
            </div>
          </dl>
          <section class="detail-section">
            <h2 class="section-title">Описание</h2>
            <p class="mobile-prose detail-text">{{ current.task.description || 'Без описания' }}</p>
            <p v-if="current.task.truncated" class="mobile-muted">
              Продолжение описания — в GrigDesk.
            </p>
          </section>
          <UiButton kind="primary" variant="solid" :busy="busy" @click="loadOptions">
            <UiIcon name="pipeline" />
            <span>Запустить на конвейере</span>
          </UiButton>
        </template>
        <UiCard v-if="options && !selected">
          <h2>Варианты запуска</h2>
          <p v-if="options.reason">{{ options.reason }}</p>
          <div class="mobile-options">
            <UiButton
              v-for="option in options.options"
              :key="option.id"
              :disabled="Boolean(option.disabledReason) || !options.actionToken"
              @click="selected = option.id"
            >
              <span
                >{{ option.title
                }}<span v-if="option.disabledReason" class="mobile-option-description">
                  {{ option.disabledReason }}</span
                ></span
              >
            </UiButton>
          </div>
        </UiCard>
      </div>
    </div>
    <UiDialog
      v-if="selected"
      title="Запустить на конвейере?"
      confirm="Запустить"
      :busy="busy"
      @close="selected = ''"
      @confirm="launch"
    >
      <p>{{ current?.task.title }}</p>
      <p>{{ options?.options.find((option) => option.id === selected)?.title }}</p>
    </UiDialog>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import type { LaunchOptions } from '../api/contract.ts';
import { ApiError } from '../api/client.ts';
import { UiButton, UiCard, UiDialog, UiError, UiIcon, UiPaneHeader } from '../ui.ts';
import { useB24Store } from '../stores/b24.ts';
import { useLinkStore } from '../stores/link.ts';
import { useReload } from '../composables/useReload.ts';

const route = useRoute();
const router = useRouter();
const store = useB24Store();
const link = useLinkStore();
const id = computed(() => String(route.params.id));
const current = computed(() => (store.current?.task.id === id.value ? store.current : null));
const listed = computed(() => store.list?.tasks.find((task) => task.id === id.value) || null);
const options = ref<LaunchOptions | null>(null);
const selected = ref('');
const busy = ref(false);
const error = ref('');
const body = ref<HTMLElement | null>(null);
const reload = () => store.load(id.value);

/**
 * Доступные варианты и token приходят из актуального каталога сервера.
 * Один вариант открывает подтверждение, отсутствие вариантов показывает причину.
 */
async function loadOptions() {
  busy.value = true;
  error.value = '';

  const capturedId = id.value;

  try {
    const result = await link.api!.getLaunchOptions(capturedId);

    if (capturedId !== id.value) {
      return;
    }

    options.value = result;

    const enabled = result.options.filter((option) => !option.disabledReason);

    if (enabled.length === 1 && result.actionToken) {
      selected.value = enabled[0]!.id;
    }
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : 'Варианты недоступны.';
  } finally {
    busy.value = false;
  }
}

/**
 * Запуск использует прежний snapshot/token; изменение каталога требует нового выбора.
 * После подтверждённого результата открывается общий список конвейера.
 */
async function launch() {
  if (!selected.value || !options.value?.actionToken || busy.value) {
    return;
  }

  busy.value = true;

  try {
    await link.api!.launchB24Task(id.value, selected.value, options.value.actionToken);
    await router.push('/tasks');
  } catch (failure) {
    error.value =
      failure instanceof ApiError && failure.status === 409
        ? 'Варианты запуска изменились. Выберите заново.'
        : failure instanceof Error
          ? failure.message
          : 'Запуск не подтверждён.';
  } finally {
    selected.value = '';
    options.value = null;
    busy.value = false;
  }
}

watch(id, () => {
  // На планшете карточка не пересоздаётся при выборе другой задачи: читаем её с начала.
  if (body.value) {
    body.value.scrollTop = 0;
  }

  options.value = null;
  selected.value = '';
  void reload();
});
useReload(reload, ['b24']);
</script>

<template>
  <UiSplit empty-text="Выберите задачу в списке" empty-icon="pipeline">
    <UiPaneHeader title="Конвейер" brand status />
    <UiListTools
      v-if="store.list?.tasks.length"
      v-model:query="query"
      v-model:filter="filter"
      placeholder="Поиск задач"
      :count="sorted.length"
      :partial="store.list.hasMore"
      :filters="filters"
    />
    <div class="pane-body">
      <div class="list-body">
        <UiError v-if="store.error" :text="store.error" @retry="store.loadList" />
        <p v-if="!store.list && !store.error" class="list-loading" role="status">Загрузка…</p>
        <UiEmpty
          v-if="store.list && !store.list.tasks.length"
          icon="pipeline"
          text="На конвейере пока нет задач"
        />
        <UiEmpty
          v-if="store.list?.tasks.length && !sorted.length"
          icon="search"
          text="Задачи не найдены"
        >
          <UiButton @click="
            query = '';
            filter = 'all';
          ">Сбросить фильтры</UiButton>
        </UiEmpty>
        <UiListRow
          v-for="task in sorted"
          :key="task.id"
          :to="'/tasks/' + task.id"
          :label="task.title"
          :current="task.id === activeId"
          :data-wait="task.needsHuman ? 'true' : undefined"
        >
          <template #lead>
            <span class="row-state" :data-state="tone(task)" aria-hidden="true"></span>
          </template>
          <span class="row-line">
            <strong class="row-title row-title-wrap">{{ task.title }}</strong>
            <span class="row-time">{{ ago(task.updatedAt) }}</span>
          </span>
          <span class="row-line">
            <span class="row-id">#{{ task.id }}</span>
            <span class="row-sub" :aria-label="task.needsHuman?.text || task.stage">
              {{ task.needsHuman?.text || task.stage }}
            </span>
            <UiChip :tone="tone(task)">{{ stateName(task.state) }}</UiChip>
          </span>
        </UiListRow>
        <UiButton v-if="store.list?.hasMore" @click="more">Показать ещё</UiButton>
      </div>
    </div>
  </UiSplit>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';

import type { TaskSummary } from '../api/contract.ts';
import {
  UiButton,
  UiChip,
  UiEmpty,
  UiError,
  UiListRow,
  UiListTools,
  UiPaneHeader,
  UiSplit,
} from '../ui.ts';
import { ago } from '../ui/format.ts';
import { stageTone, stateName } from '../ui/taskState.ts';
import { useTasksStore } from '../stores/tasks.ts';
import { useLinkStore } from '../stores/link.ts';
import { useReload } from '../composables/useReload.ts';

const route = useRoute();
const store = useTasksStore();
const link = useLinkStore();
const activeId = computed(() => String(route.params.id || ''));
const query = ref('');
const filter = ref('all');
const filters = [
  {
    value: 'all',
    label: 'Все',
  },
  {
    value: 'waiting',
    label: 'Требуют меня',
  },
];
const sorted = computed(() =>
  (store.list?.tasks || []).filter((task) =>
    `${task.id} ${task.title} ${task.stage}`.toLocaleLowerCase('ru')
      .includes(query.value.trim().toLocaleLowerCase('ru')) &&
    (filter.value !== 'waiting' || Boolean(task.needsHuman)),
  ).sort(
    (a, b) => Number(Boolean(b.needsHuman)) - Number(Boolean(a.needsHuman)),
  ),
);
const tone = (task: TaskSummary) =>
  task.needsHuman ? 'warn' : stageTone(task.state) || 'idle';

/**
 * Дополнительная страница проверяет прежний snapshot до слияния списков.
 * Сбой не превращает отсутствие данных в пустой успешный список.
 */
async function more() {
  const snapshot = store.list;

  if (!snapshot?.nextCursor) {
    return;
  }

  try {
    const page = await link.api!.getTasks(snapshot.nextCursor);

    if (store.list === snapshot) {
      store.list = {
        ...page,
        tasks: [...snapshot.tasks, ...page.tasks],
      };
    }
  } catch (failure) {
    store.error = failure instanceof Error ? failure.message : 'Список недоступен.';
  }
}

useReload(store.loadList, ['tasks']);
</script>

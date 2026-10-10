<template>
  <UiSplit empty-text="Выберите задачу в списке" empty-icon="board">
    <UiPaneHeader title="Задачи Б24" brand status />
    <UiListTools
      v-if="store.list?.tasks.length"
      v-model:query="query"
      v-model:filter="filter"
      placeholder="Поиск задач Б24"
      :count="visible.length"
      :partial="store.list.hasMore"
      :filters="filters"
    />
    <div class="pane-body">
      <div class="list-body">
        <UiError v-if="store.error" :text="store.error" @retry="store.loadList" />
        <p v-if="!store.list && !store.error" class="list-loading" role="status">Загрузка…</p>
        <UiEmpty
          v-if="store.list && !store.list.tasks.length"
          icon="board"
          text="Задач Б24 пока нет"
        />
        <UiEmpty
          v-if="store.list?.tasks.length && !visible.length"
          icon="search"
          text="Задачи не найдены"
        >
          <UiButton @click="
            query = '';
            filter = 'all';
          ">Сбросить фильтры</UiButton>
        </UiEmpty>
        <UiListRow
          v-for="task in visible"
          :key="task.id"
          :to="'/b24/' + task.id"
          :label="task.title"
          :current="task.id === activeId"
        >
          <template #lead>
            <span
              class="row-state"
              :data-state="task.onPipeline ? 'accent' : 'idle'"
              aria-hidden="true"
            ></span>
          </template>
          <strong class="row-title row-title-wrap">{{ task.title }}</strong>
          <span class="row-line">
            <span class="row-id">#{{ task.id }}</span>
            <span class="row-sub" :aria-label="facts(task)">{{ facts(task) }}</span>
            <UiChip v-if="task.onPipeline" tone="accent">На конвейере</UiChip>
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

import type { B24Summary } from '../api/contract.ts';
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
import { useB24Store } from '../stores/b24.ts';
import { useLinkStore } from '../stores/link.ts';
import { useReload } from '../composables/useReload.ts';

const route = useRoute();
const store = useB24Store();
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
    value: 'pipeline',
    label: 'На конвейере',
  },
];
const visible = computed(() =>
  (store.list?.tasks || []).filter((task) =>
    `${task.id} ${task.title}`.toLocaleLowerCase('ru')
      .includes(query.value.trim().toLocaleLowerCase('ru')) &&
    (filter.value !== 'pipeline' || task.onPipeline),
  ),
);
const facts = (task: B24Summary) =>
  [
    task.status,
    task.deadline ? 'до ' + new Date(task.deadline).toLocaleDateString('ru-RU') : '',
  ]
    .filter(Boolean)
    .join(' · ');

/**
 * Cursor принадлежит только текущему списку, поэтому поздняя страница не восстанавливает старый экран.
 * Ошибки портала остаются видимыми и не запускают никаких мутаций.
 */
async function more() {
  const snapshot = store.list;

  if (!snapshot?.nextCursor) {
    return;
  }

  try {
    const page = await link.api!.getB24Tasks(snapshot.nextCursor);

    if (store.list === snapshot) {
      store.list = {
        ...page,
        tasks: [...snapshot.tasks, ...page.tasks],
      };
    }
  } catch (failure) {
    store.error = failure instanceof Error ? failure.message : 'Б24 недоступен.';
  }
}

useReload(store.loadList, ['b24', 'tasks']);
</script>

<template>
  <section class="list" data-role="project-list">
    <UiPaneHeader>
      <template #title><h1>Проекты</h1></template>
      <template #meta><span class="count">{{ items.length }}</span></template>
      <template #actions><slot name="actions" /></template>
    </UiPaneHeader>
    <div class="tools">
      <label class="search" data-role="project-search">
        <UiSearchInput v-model="search" aria-label="Поиск проектов" placeholder="Найти проект…" />
      </label>
      <div data-role="project-sort" :data-sort="sort">
      <UiIconButton data-context="workspace-toolbar"
        :label="sort === 'title' ? 'Сортировка: по названию' : 'Сортировка: по изменению'"
        :pressed="sort === 'updated'" :data-sort="sort"
        v-tooltip="sort === 'title' ? 'Сортировка: по названию' : 'Сортировка: по изменению'"
        @click="sort = sort === 'title' ? 'updated' : 'title'">
        <ProjectIcon name="sort" />
      </UiIconButton>
      </div>
    </div>
    <div class="filters" data-role="project-filter" role="group" aria-label="Показывать проекты">
      <UiButton variant="ghost" data-context="workspace-filter" data-value="active"
        :pressed="filter === 'active'" @click="filter = 'active'">
        Активные <span class="count">{{ items.filter(item => !item.archivedAt).length }}</span>
      </UiButton>
      <UiButton variant="ghost" data-context="workspace-filter" data-value="archive"
        :pressed="filter === 'archive'" @click="filter = 'archive'">
        Архив <span class="count">{{ items.filter(item => item.archivedAt).length }}</span>
      </UiButton>
    </div>

    <!--
      Отказ показывается НАД списком, а не вместо него: последний удачный ответ
      остаётся на экране, и человек видит, что именно не перечиталось.
    -->
    <div v-if="error" class="failure" data-role="project-error" role="alert">
      <UiInlineMessage tone="danger">{{ error }}</UiInlineMessage>
      <UiButton variant="text" data-role="project-retry" @click="emit('retry')">Повторить</UiButton>
    </div>

    <UiLoadingState v-if="loading && !items.length" label="Загрузка…" />
    <div v-else-if="!items.length && !error" class="empty">
      <strong>Проектов пока нет.</strong>
      <span>Создайте первый, чтобы собрать его настройки и репозитории вместе.</span>
    </div>
    <div v-else-if="items.length && !visible.length" class="empty" role="status">
      <strong>{{ search.trim() ? 'Ничего не найдено.'
        : filter === 'archive' ? 'Архив пуст.' : 'Нет активных проектов.' }}</strong>
      <span>{{ search.trim() ? 'Попробуйте другое название, метку или путь.'
        : filter === 'archive' ? 'Здесь появятся архивированные проекты.'
          : 'Создайте проект или восстановите его из архива.' }}</span>
      <UiButton v-if="search.trim()" variant="text" @click="search = ''">Сбросить поиск</UiButton>
    </div>

    <div v-else class="rows">
      <UiPressable
        v-for="item in visible"
        :key="item.id"
        class="row"
        data-context="workspace-catalog-row"
        data-role="project-row"
        :data-project-id="item.id"
        :aria-current="selectedId === item.id ? 'page' : undefined"
        @click="emit('open', item.id)"
      >
        <span class="row-content">
          <span class="head">
            <span class="title">{{ item.title }}</span>
            <span v-if="item.archivedAt" class="archived">Архив</span>
            <span v-if="item.repos.length" class="repo-count">
              <ProjectIcon name="repo" /><span class="ui-visually-hidden">Репозитории: </span>
              {{ item.repos.length }}
            </span>
          </span>
          <span v-for="warning in item.warnings" :key="warning" class="warn">{{ warning }}</span>
        </span>
      </UiPressable>
    </div>
  </section>
</template>

<script setup lang="ts">
// Список проектов: строка отвечает на «что это за проект и где его код», а поиск
// и фильтр — на «как его найти». Сети и состояния здесь нет: список приходит
// готовым, а открытие паспорта — событие наружу.
import { computed, ref } from 'vue';

import {
  UiButton,
  UiInlineMessage,
  UiPressable,
  UiSearchInput,
  UiIconButton,
  UiPaneHeader,
  vTooltip,
  UiLoadingState,
} from '../../ui';
import ProjectIcon from './ProjectIcon.vue';
import type { ProjectSummary } from '../../../../shared/runtime/projectsContracts';

const props = defineProps<{
  items: ProjectSummary[];
  loading: boolean;
  error: string;
  selectedId?: string;
}>();

const emit = defineEmits<{
  open: [id: string];
  retry: [];
}>();

type ProjectFilter = 'active' | 'archive';
type ProjectSort = 'title' | 'updated';

const search = ref('');
const filter = ref<ProjectFilter>('active');
const sort = ref<ProjectSort>('title');

// Поиск идёт по названию, идентификатору, меткам и путям: путь человек часто помнит
// лучше названия проекта, а метка — это то, чем он сам разложил проекты по полкам.
function matches(item: ProjectSummary, needle: string): boolean {
  if (filter.value === 'archive' ? !item.archivedAt : Boolean(item.archivedAt)) {
    return false;
  }
  if (!needle) {
    return true;
  }

  const haystack = [
    item.title,
    item.id,
    ...item.tags,
    ...item.repos.map((repo) => repo.dir),
  ].join('\n').toLowerCase();

  return haystack.includes(needle);
}

const visible = computed(() => {
  const needle = search.value.trim().toLowerCase();
  const found = props.items.filter((item) => matches(item, needle));

  // Сортировка по изменению — свежие сверху: паспорт правят, чтобы вернуться к работе,
  // и последний правленный проект нужен чаще всего.
  return found.sort((left, right) => (sort.value === 'title'
    ? left.title.localeCompare(right.title, 'ru')
    : String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? ''))));
});
</script>

<style scoped>
.list {
  min-width: 0;
}

.count {
  color: var(--ink-mid);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.tools {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 12px 10px 6px;
}

.search {
  flex: 1;
  min-width: 0;
}

.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 0 10px 8px;
}

.filters .count {
  margin-left: 4px;
}

.failure {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 12px;
}

.rows {
  display: flex;
  flex-direction: column;
  padding: 0 6px 10px;
}

.row {
  display: flex;
  align-items: center;
  width: 100%;
}

.row-content {
  display: flex;
  flex-direction: column;
  min-width: 0;
  width: 100%;
  overflow-wrap: anywhere;
}

.head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 6px;
}

.title {
  font-weight: 400;
  line-height: 20px;
}

.repo-count {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--ink-mid);
  font-size: 12px;
}

.repo-count svg {
  width: 12px;
  height: 12px;
}

.archived {
  color: var(--ink-mid);
  font-size: 12px;
}

.warn {
  font-size: 12px;
  color: var(--warn);
  overflow-wrap: anywhere;
}

.empty {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 24px 16px;
  color: var(--ink-mid);
}

.empty strong {
  color: var(--ink);
  font-weight: 500;
}
</style>

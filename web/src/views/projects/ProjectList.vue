<template>
  <section class="list"
    :data-perf-pending="loading && !items.length ? '' : undefined" data-role="project-list">
    <UiPaneHeader>
      <template #title><h1>{{ t('core.projects') }}</h1></template>
      <template #meta><span class="count">{{ items.length }}</span></template>
      <template #actions><slot name="actions" /></template>
    </UiPaneHeader>
    <div class="tools">
      <label class="search" data-role="project-search">
        <UiSearchInput v-model="search" size="compact"
                       :aria-label="t('core.projectPoiskProektov')" :placeholder="t('core.projectNaytiProekt')" />
      </label>
      <div data-role="project-sort" :data-sort="sort">
      <UiIconButton data-context="workspace-toolbar"
        :label="sort === 'title' ? t('core.projectSortirovkaPoNazvaniyu') : t('core.projectSortirovkaPoIzmeneniyu')"
        :pressed="sort === 'updated'" :data-sort="sort"
        v-tooltip="sort === 'title' ? t('core.projectSortirovkaPoNazvaniyu') : t('core.projectSortirovkaPoIzmeneniyu')"
        @click="sort = sort === 'title' ? 'updated' : 'title'">
        <ProjectIcon name="sort" />
      </UiIconButton>
      </div>
    </div>
    <div class="filters" data-role="project-filter" role="group" :aria-label="t('core.projectPokazyvatProekty')">
      <UiButton variant="ghost" data-context="workspace-filter" data-value="active"
        :pressed="filter === 'active'" @click="filter = 'active'"> {{ t('core.projectAktivnye') }} <span class="count">{{ items.filter(item => !item.archivedAt).length }}</span>
      </UiButton>
      <UiButton variant="ghost" data-context="workspace-filter" data-value="archive"
        :pressed="filter === 'archive'" @click="filter = 'archive'"> {{ t('core.projectArhiv') }} <span class="count">{{ items.filter(item => item.archivedAt).length }}</span>
      </UiButton>
    </div>

    <!--
      Отказ показывается НАД списком, а не вместо него: последний удачный ответ
      остаётся на экране, и человек видит, что именно не перечиталось.
    -->
    <div v-if="error" class="failure" data-role="project-error"
    :data-perf-error="!items.length && !loading ? '' : undefined" role="alert">
      <UiInlineMessage tone="danger">{{ error }}</UiInlineMessage>
      <UiButton variant="text" data-role="project-retry" @click="emit('retry')">{{ t('core.pluginNotificationsRetry') }}</UiButton>
    </div>

    <UiLoadingState v-if="loading && !items.length" :label="t('core.browserLoading')" :failed="Boolean(error)" >
      <div class="project-loading"><UiSkeletonLayout layout="list" :header="false" /></div>
    </UiLoadingState>
    <div v-else-if="!items.length && !error" class="empty">
      <strong>{{ t('core.projectProektovPokaNet') }}</strong>
      <span>{{ t('core.projectSozdaytePervyyChtobySobrat') }}</span>
    </div>
    <div v-else-if="items.length && !visible.length" class="empty" role="status">
      <strong>{{ search.trim() ? t('core.projectNichegoNeNaydeno')
        : filter === 'archive' ? t('core.projectArhivPust') : t('core.projectNetAktivnyhProektov') }}</strong>
      <span>{{ search.trim() ? t('core.projectPoprobuyteDrugoeNazvanieMetku')
        : filter === 'archive' ? t('core.projectZdesPoyavyatsyaArhivirovannyeProekty')
          : t('core.projectSozdayteProektIliVosstanovite') }}</span>
      <UiButton v-if="search.trim()" variant="text" @click="search = ''">{{ t('core.dbDesignClearSearch') }}</UiButton>
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
            <span v-if="item.archivedAt" class="archived">{{ t('core.projectArhiv') }}</span>
            <span v-if="item.repos.length" class="repo-count">
              <ProjectIcon name="repo" /><span class="ui-visually-hidden">{{ t('core.projectRepozitorii2') }} </span>
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
import { UiSkeletonLayout, t } from '../../ui';

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
.project-loading {
  --skeleton-row-height: max(34px, var(--control-height));
  --skeleton-list-gap: 0px; padding: 0 6px 10px; }

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
  gap: 7px;
  padding: 6px 10px;
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

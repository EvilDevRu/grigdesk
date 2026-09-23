<template>
  <section class="list" data-role="project-list">
    <div class="list-heading">
      <span>Каталог проектов</span>
      <span class="count">{{ visible.length }}</span>
    </div>
    <header class="tools">
      <label class="tool search" data-role="project-search">
        <UiSearchInput v-model="search" aria-label="Поиск проектов" placeholder="Найти проект…" />
      </label>

      <label class="tool" data-role="project-filter">
        <span class="lbl">Показывать</span>
        <UiSelect v-model="filter" compact>
          <option value="active">Активные</option>
          <option value="archive">Архив</option>
        </UiSelect>
      </label>

      <label class="tool" data-role="project-sort">
        <span class="lbl">Сортировка</span>
        <UiSelect v-model="sort" compact>
          <option value="title">По названию</option>
          <option value="updated">По изменению</option>
        </UiSelect>
      </label>
    </header>

    <!--
      Отказ показывается НАД списком, а не вместо него: последний удачный ответ
      остаётся на экране, и человек видит, что именно не перечиталось.
    -->
    <div v-if="error" class="failure" data-role="project-error">
      <UiInlineMessage tone="danger">{{ error }}</UiInlineMessage>
      <UiButton variant="text" data-role="project-retry" @click="emit('retry')">Повторить</UiButton>
    </div>

    <div v-if="loading && !items.length" class="empty" role="status">Загрузка…</div>
    <div v-else-if="!items.length" class="empty">
      <strong>Проектов пока нет.</strong>
      <span>Создайте первый, чтобы собрать его настройки и репозитории вместе.</span>
    </div>
    <div v-else-if="!visible.length" class="empty">
      <strong>Ничего не найдено.</strong>
      <span>Попробуйте другое название, метку или путь.</span>
    </div>

    <div v-else class="rows">
      <UiPressable
        v-for="item in visible"
        :key="item.id"
        class="row"
        data-context="project-catalog-row"
        data-role="project-row"
        :data-project-id="item.id"
        :aria-current="selectedId === item.id ? 'page' : undefined"
        @click="emit('open', item.id)"
      >
        <ProjectAvatar :title="item.title" />
        <span class="row-content">
          <span class="head">
            <span class="title">{{ item.title }}</span>
            <span v-if="item.archivedAt" class="archived">Архив</span>
          </span>
          <span v-if="item.title !== item.id" class="id">{{ item.id }}</span>
          <span class="meta">Репозиториев: {{ item.repos.length }}</span>
          <span class="profile" :class="{ connected: item.profile.present }">
            <span class="profile-dot" />{{ profileLabel(item) }}
          </span>
          <span v-for="warning in item.warnings" :key="warning" class="warn">{{ warning }}</span>
        </span>
        <span class="chevron" aria-hidden="true">›</span>
      </UiPressable>
    </div>
  </section>
</template>

<script setup lang="ts">
// Список проектов: строка отвечает на «что это за проект и где его код», а поиск
// и фильтр — на «как его найти». Сети и состояния здесь нет: список приходит
// готовым, а открытие паспорта — событие наружу.
import { computed, ref } from 'vue';

import { UiButton, UiInlineMessage, UiPressable, UiSearchInput, UiSelect } from '../../ui';
import type { ProjectSummary } from '../../../../shared/projectsContracts';
import ProjectAvatar from './ProjectAvatar.vue';

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

/**
 * Строка списка отвечает и на «пути откуда»: у проекта фабрики их задаёт профиль,
 * и человек должен видеть это до открытия паспорта. Пути в строке не печатаются —
 * они длинные, а поиск по ним работает.
 */
function profileLabel(item: ProjectSummary): string {
  if (!item.profile.present) {
    return 'профиля нет';
  }

  return item.profile.pathsSource === 'profile' ? 'пути из профиля' : 'пути из паспорта';
}

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
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-width: 0;
  height: 100%;
  padding: 20px 12px 12px;
}

.list-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 6px;
  font-size: 13px;
  font-weight: 600;
}

.count {
  padding: 1px 7px;
  border: 1px solid var(--line);
  border-radius: 6px;
  color: var(--ink-mid);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.tools {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr);
  gap: 12px 8px;
  padding: 0 6px 18px;
  border-bottom: 1px solid var(--line);
}

.tool {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.search {
  grid-column: 1 / -1;
}

.lbl {
  color: var(--ink-mid);
  font-size: 11px;
}

.failure {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.rows {
  display: flex;
  flex-direction: column;
  gap: 5px;
  overflow-y: auto;
  min-height: 0;
  padding: 2px;
}

.row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: start;
  gap: 12px;
  width: 100%;
  flex-shrink: 0;
}

.row-content {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.title {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.id {
  color: var(--ink-mid);
  font-family: var(--mono);
  font-size: 11px;
  overflow-wrap: anywhere;
}

.meta {
  font-size: 12px;
  color: var(--ink-mid);
}

.profile {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--ink-low);
  font-size: 11px;
}

.profile-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--ink-low);
}

.connected .profile-dot {
  background: var(--good);
}

.chevron {
  align-self: center;
  color: var(--ink-low);
  font-size: 20px;
}

.archived {
  color: var(--ink-mid);
  font-size: 10px;
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
  padding: 24px 10px;
  color: var(--ink-mid);
  font-size: 13px;
}

.empty strong {
  color: var(--ink);
  font-weight: 500;
}
</style>

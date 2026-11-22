<template>
  <aside class="cl"
    :data-perf-pending="!chat.loaded && (!chat.loadError || chat.loading) ? '' : undefined"
    :data-perf-error="!chat.loaded && chat.loadError && !chat.loading ? '' : undefined">
    <ChatProjectPicker
      v-if="projectAvailable"
      :items="projectItems"
      :model-value="selectedProject"
      :disabled="!projectsReady"
      @select="selectProject"
      @create="createOpen = true"
    />

    <div class="cl-body">
    <div class="top">
      <ChatProjectPicker
        v-if="projectAvailable"
        :items="projectItems"
        :model-value="selectedProject"
        :disabled="!projectsReady"
        compact
        @select="selectProject"
        @create="createOpen = true"
      />
      <UiInlineMessage v-if="projectAvailable && projects.error" data-chat-project-error tone="danger">
        {{ projects.error }}
      </UiInlineMessage>
      <UiButton
        v-if="projectAvailable && projects.error"
        data-chat-project-retry
        size="compact"
        variant="text"
        :disabled="projects.loading"
        @click="retryProjects"
      >
        {{ t('core.chatProjectRetry') }}
      </UiButton>
      <div class="tools">
        <div class="search">
          <UiSearchInput
            v-model="q"
            size="compact"
            :placeholder="showArchived ? t('core.chatPoiskVArhive') : t('core.search')"
          />
        </div>
        <UiCreateButton
          class="new"
          :label="t('core.chatNovyyChat')"
          :disabled="!canCreateChat"
          @click="newChat"
        />
      </div>
      <div v-if="selectedProject" data-chat-project-current class="project-current">
        <span>{{ selectedProjectTitle }}</span>
        <UiIconButton data-chat-project-clear role="embedded" :label="t('core.chatProjectAll')"
          @click="selectProject('')">×</UiIconButton>
      </div>

      <div class="list-controls">
        <UiSegmentedControl
          v-model="scopeSegment"
          class="scope"
          data-context="chat-scope"
          size="compact"
          :options="scopeOptions"
          :label="t('core.chatListScope')"
        />
        <UiIconButton
          v-if="filtersAvailable"
          class="filter-toggle"
          data-chat-filter-toggle
          :label="activeFilterCount
            ? t('core.chatListFiltersActive', { count: activeFilterCount })
            : t('core.chatListFilters')"
          :tone="activeFilterCount ? 'accent' : 'neutral'"
          :pressed="Boolean(activeFilterCount)"
          :aria-expanded="String(filtersOpen)"
          v-tooltip="t('core.chatListFilters')"
          aria-controls="chat-list-filters"
          @click="filtersOpen = !filtersOpen"
        >
          <svg width="16" height="16" viewBox="0 0 24 24"
               fill="none" stroke="currentColor" stroke-width="1.8"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M4 5h16l-6.3 7.1v5.4l-3.4 1.7v-7.1z" />
          </svg>
          <span v-if="activeFilterCount" class="filter-count">{{ activeFilterCount }}</span>
        </UiIconButton>
      </div>
      <div
        v-if="filtersAvailable"
        id="chat-list-filters"
        class="filterbar"
        :class="{ expanded: filtersOpen }"
        role="region"
        :aria-label="t('core.chatListFilters')"
      >
        <div class="filter-section" role="group" :aria-label="t('core.chatFilterState')">
          <div class="filter-heading">
            <span class="filter-caption">{{ t('core.chatFilterState') }}</span>
            <UiIconButton
              role="embedded"
              :label="t('core.chatFilterReset')"
              v-tooltip="t('core.chatFilterReset')"
              :disabled="!activeFilterCount"
              data-chat-filter-reset
              @click="resetFilters"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
                   stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M3 10a9 9 0 1 1 2.6 8.4M3 4v6h6" />
              </svg>
            </UiIconButton>
          </div>
          <div class="filter-states">
            <UiButton
              v-for="state in stateFilterOptions"
              :key="state.key"
              :data-chat-filter="state.key"
              variant="outline"
              size="compact"
              :tone="filters[state.key] ? 'accent' : 'neutral'"
              :pressed="filters[state.key]"
              @click="setFilter(state.key, !filters[state.key])"
            >
              <template #leading>
                <span class="filter-state-dot" :class="`filter-state-dot--${state.key}`" aria-hidden="true" />
              </template>
              {{ state.label }}
            </UiButton>
          </div>
        </div>
        <div class="filter-section">
          <span class="filter-caption">{{ t('core.chatFilterTask') }}</span>
          <div class="filter-task-fields">
            <UiSelect
              :model-value="taskSelect"
              data-chat-filter="task-mode"
              compact
              :aria-label="t('core.chatFilterTask')"
              @update:model-value="onTaskModeSelect"
            >
              <option value="all">{{ t('core.chatFilterTaskAll') }}</option>
              <option value="any">{{ t('core.chatFilterTaskAny') }}</option>
              <option value="none">{{ t('core.chatFilterTaskNone') }}</option>
            </UiSelect>
            <UiInput
              class="task-number"
              data-chat-filter="task-number"
              :model-value="taskNumber"
              inputmode="numeric"
              :placeholder="t('core.chatFilterTaskNumber')"
              :aria-label="t('core.chatFilterTaskNumber')"
              @update:model-value="onTaskNumber"
            />
          </div>
        </div>
        <div class="filter-details">
          <div class="filter-section">
            <span class="filter-caption">{{ t('core.chatFilterProvider') }}</span>
            <UiSelect
              data-chat-filter="provider"
              compact
              :model-value="filters.provider"
              :aria-label="t('core.chatFilterProvider')"
              @update:model-value="setFilter('provider', String($event))"
            >
              <option value="">{{ t('core.chatFilterProviderAll') }}</option>
              <option v-for="entry in prov.providers" :key="entry.id" :value="entry.id">
                {{ entry.name }}
              </option>
            </UiSelect>
          </div>
          <div class="filter-section">
            <span class="filter-caption">{{ t('core.chatFilterFresh') }}</span>
            <UiSelect
              data-chat-filter="fresh"
              compact
              :model-value="filters.fresh"
              :aria-label="t('core.chatFilterFresh')"
              @update:model-value="onFreshSelect"
            >
              <option value="">{{ t('core.chatFilterFreshAll') }}</option>
              <option value="day">{{ t('core.chatFilterFreshDay') }}</option>
              <option value="week">{{ t('core.chatFilterFreshWeek') }}</option>
              <option value="month">{{ t('core.chatFilterFreshMonth') }}</option>
            </UiSelect>
          </div>
        </div>
      </div>
      <div v-if="filterChips.length && !filtersOpen" class="filter-chips">
        <span v-for="chip in filterChips" :key="chip.key" class="filter-chip" data-chat-chip>
          {{ chip.label }}
          <UiIconButton
            role="embedded"
            class="chip-x"
            :label="t('core.chatFilterRemove')"
            @click="clearFilter(chip.key)"
          ><span aria-hidden="true">×</span></UiIconButton>
        </span>
      </div>
    </div>

    <div ref="rowsHost" class="rows" @scroll.passive="onRowsScroll">
      <div v-if="!chat.loaded" class="list-pending">
        <section class="load-state" :class="{ 'load-state-error': chat.loadError }">
          <div class="load-status" role="status" aria-live="polite" aria-atomic="true">
            <span class="load-mark" aria-hidden="true">
              <UiSpinner v-if="!chat.loadError || chat.loading" decorative />
              <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
                <path d="M12 8v5m0 3v.1" stroke-linecap="round" />
                <circle cx="12" cy="12" r="9" />
              </svg>
            </span>
            <div class="load-copy">
              <strong class="load-title" :class="{ 'ui-loading-state__hidden': !chat.loadError }">
                {{ t(chat.loadError ? 'core.chatListLoadFailed' : 'core.chatListLoading') }}
              </strong>
              <p v-if="chat.loadError" class="load-reason">
                {{ resolveUiText(chat.loadErrorMessage || '') }}
              </p>
              <p v-if="chat.loadError && chat.loading" class="load-retry-status">
                {{ t('core.chatListLoading') }}
              </p>
            </div>
          </div>
          <p class="load-hint">{{ t('core.chatStoreNotLoaded') }}</p>
          <UiButton v-if="chat.loadError" :disabled="chat.loading" @click="chat.retryLoad()">
            {{ t('core.chatListRetry') }}
          </UiButton>
        </section>

        <div v-if="!chat.loadError" class="list-skeleton" aria-hidden="true">
          <div v-for="index in 6" :key="index" class="skeleton-row">
            <UiSkeleton shape="circle" class="skeleton-avatar"
                        width="var(--chat-avatar-size)" height="var(--chat-avatar-size)" />
            <span class="skeleton-copy">
              <UiSkeleton class="skeleton-title" height="9px" />
              <UiSkeleton class="skeleton-snippet" height="7px" />
            </span>
            <UiSkeleton class="skeleton-time" height="6px" />
          </div>
        </div>
      </div>
      <div v-else-if="!paging.loaded" class="load-state" role="status">
        <p>{{ paging.error || t('core.chatPageLoading') }}</p>
        <UiButton v-if="paging.error" :disabled="paging.loading"
                  @click="chat.ensureChatPage(q, showArchived, listFilters)">
          {{ t('core.chatPageRetry') }}
        </UiButton>
      </div>
      <div v-else-if="q.trim() && (chat.search?.loading || chat.search?.error)" class="load-state">
        <p role="status">{{ chat.search.error || t('core.chatSearchLoading') }}</p>
        <UiButton v-if="chat.search.error" @click="chat.searchChats(q, showArchived, listFilters)">
          {{ t('core.chatListRetry') }}
        </UiButton>
      </div>
      <div v-else-if="!rows.length && !paging.hasMore" class="none muted">
        <template v-if="activeFilterCount">
          <p class="filter-empty">{{ t('core.chatFilterEmpty') }}</p>
          <UiButton variant="ghost" size="compact" data-chat-filter-reset @click="resetFilters">
            {{ t('core.chatFilterReset') }}
          </UiButton>
        </template>
        <template v-else>{{ emptyLabel }}</template>
      </div>
      <div
        v-for="r in rows"
        :key="r.id"
        :data-chat-id="r.id"
        v-memo="[
          r.title, r.snippet, r.modelName, r.providerColor, r.catalogProjectId, r.projectTitle, r.projectIcon,
          r.archived, r.draft, r.sending, r.compacting, r.unread, r.waiting, r.sleep,
          r.id === chat.activeId, r.id === editId, r.id === editId ? editVal : '', ago(r.ts),
        ]"
        class="row"
        :class="{
          archived: r.archived,
          cur: r.id === chat.activeId,
          wait: r.waiting,
        }"
        :style="r.providerColor ? { '--prov': r.providerColor } : null"
      >
        <template v-if="editId === r.id">
          <span
            class="ava"
            :class="{ live: r.sending }"
            v-tooltip="avatarTitle(r)"
          >
            <ProjectAvatar
              :id="r.catalogProjectId ?? undefined"
              :title="r.projectTitle"
              :icon="r.projectIcon"
            />
            <ChatSleepBadge
              v-if="r.sleep && !r.sending && !r.compacting"
              :tasks="r.sleep.backgroundTasks"
            />
            <span
              v-if="r.unread"
              class="udot"
              v-tooltip="t('core.chatNeprochitannyyOtvet')"
            />
          </span>
          <span class="mid">
            <UiInput
              ref="editEl"
              v-model="editVal"
              class="edit"
              :aria-label="t('core.chatNazvanieChata')"
              @keydown.enter="commitEdit"
              @keydown.esc="editId = null"
              @blur="commitEdit"
            />
          </span>
        </template>

        <UiPressable
          v-else
          class="row-hit"
          :pressed="r.id === chat.activeId"
          :aria-description="r.projectTitle || t('core.chatProjectNone')"
          @click="select(r)"
          @dblclick="startEdit(r)"
        >
          <span
            class="ava"
            :class="{ live: r.sending }"
            v-tooltip="avatarTitle(r)"
          >
            <ProjectAvatar
              :id="r.catalogProjectId ?? undefined"
              :title="r.projectTitle"
              :icon="r.projectIcon"
            />
            <ChatSleepBadge
              v-if="r.sleep && !r.sending && !r.compacting"
              :tasks="r.sleep.backgroundTasks"
            />
            <span
              v-if="r.unread"
              class="udot"
              v-tooltip="t('core.chatNeprochitannyyOtvet')"
            />
          </span>

          <span class="mid">
            <span class="t1">
              <span class="name">{{ r.title }}</span>
              <span
                v-if="r.waiting"
                class="wchip"
                v-tooltip="t('core.chatAgentZhdetTvoegoOtveta')"
              > {{ t('core.chatZhdetOtveta') }} </span>
              <span
                v-else-if="r.modelName"
                class="mdl"
                :class="{ brand: Boolean(r.providerColor) }"
              >{{ r.modelName }}</span>
              <span class="ago muted">{{ ago(r.ts) }}</span>
            </span>
            <span class="t2 muted">
              <span v-if="r.draft" class="dr">{{ t('core.chatChernovik') }}</span>{{
                r.snippet || t('core.chatPustoyChat')
              }}
            </span>
          </span>
        </UiPressable>

        <span v-if="editId !== r.id" class="acts">
          <!-- Мышь: кнопки появляются при наведении, действие — одним нажатием. -->
          <span class="acts-quick">
            <UiIconButton
              v-if="r.archived"
              data-context="chat-list-action"
              role="rail"
              :label="t('core.chatDostatChatIzArhiva')"
              v-tooltip="t('core.chatDostatIzArhiva')"
              tone="accent"
              @click="restore(r)"
            >
              ↩
            </UiIconButton>
            <UiIconButton
              data-context="chat-list-action"
              role="rail"
              :label="t('core.chatPereimenovatChat')"
              v-tooltip="t('core.machineRename')"
              @click="startEdit(r)"
            >
              ✎
            </UiIconButton>
            <UiIconButton
              data-context="chat-list-action"
              role="rail"
              :label="r.archived ? t('core.chatUdalitChatNavsegda') : t('core.chatPeremestitChatVArhiv')"
              v-tooltip="r.archived ? t('core.chatUdalitNavsegda') : t('core.chatPeremestitVArhiv')"
              :tone="r.archived ? 'danger' : 'accent'"
              @click="del(r)"
            >
              ✕
            </UiIconButton>
          </span>
          <!-- Палец: наведения нет, поэтому действия собраны в меню с полными подписями. -->
          <span class="acts-menu">
            <UiPopover has-popup="menu" placement="bottom-end" :aria-label="t('core.chatDeystviyaTitle', { title: r.title })">
              <template #trigger>
                <UiIconButton data-context="chat-list-action" role="rail" :label="t('core.chatDeystviyaTitle', { title: r.title })">
                  ⋯
                </UiIconButton>
              </template>
              <template #default="{ close }">
                <div class="ui-action-menu">
                  <UiButton v-if="r.archived" role="menuitem" variant="ghost"
                            @click="close('action'); restore(r)">{{ t('core.chatDostatIzArhiva') }}</UiButton>
                  <UiButton role="menuitem" variant="ghost"
                            @click="close('action'); startEdit(r)">{{ t('core.machineRename') }}</UiButton>
                  <UiButton role="menuitem" variant="ghost" :tone="r.archived ? 'danger' : 'neutral'"
                            @click="close('action'); del(r)">
                    {{ r.archived ? t('core.chatUdalitNavsegda') : t('core.chatPeremestitVArhiv') }}
                  </UiButton>
                </div>
              </template>
            </UiPopover>
          </span>
        </span>
      </div>
      <div v-if="chat.loaded && paging.loaded && (paging.loading || paging.error || paging.hasMore)"
           class="load-state" role="status" aria-live="polite">
        <p v-if="paging.loading">{{ t('core.chatPageLoading') }}</p>
        <p v-else-if="paging.error">{{ paging.error }}</p>
        <UiButton v-if="paging.needsRefresh" :disabled="paging.loading"
                  @click="chat.retryChatPage(q, showArchived, listFilters)">
          {{ t('core.chatPageRefresh') }}
        </UiButton>
        <UiButton v-else :disabled="paging.loading" @click="chat.retryChatPage(q, showArchived, listFilters)">
          {{ t(paging.error ? 'core.chatPageRetry' : 'core.chatPageMore') }}
        </UiButton>
      </div>
    </div>
    </div>
    <ProjectCreateDialog
      v-if="createOpen"
      :open="createOpen"
      @update:open="createOpen = $event"
      @saved="retryProjects"
      @open-found="openFoundProject"
    />
  </aside>
</template>

<script setup lang="ts">
import { UiSkeleton, t, messageRef, uiLocale } from '../../ui';

import type { ChatListRow } from '../../shared/chatContracts.ts';
import type { UiFieldHandle } from '../../ui.ts';
import type { ChatSleepingSession } from '../../../../shared/chat/chatBackgroundTasks.ts';

import { onUnmounted, computed, nextTick, ref, watch } from 'vue';
import { captureChatScrollAnchor } from '../../shared/chatScrollAnchor.ts';
import { useChatStore } from '../../stores/chat.ts';
import { useProvidersStore } from '../../stores/providers.ts';
import ChatProjectPicker from './ChatProjectPicker.vue';
import ProjectAvatar from '../projects/ProjectAvatar.vue';
import ProjectCreateDialog from '../projects/ProjectCreateDialog.vue';
import { useChatProjectFilter } from './useChatProjectFilter.ts';
import ChatSleepBadge from './ChatSleepBadge.vue';
import { useChatSleeping } from '../../composables/useChatSleeping.ts';
import {
  confirmDialog, UiButton, UiPopover, UiIconButton, UiCreateButton, UiInput,
  UiPressable, UiSearchInput, UiSegmentedControl, UiSelect, UiSpinner,
  UiInlineMessage, resolveUiText, vTooltip,
} from '../../ui';

import {
  EMPTY_CHAT_FILTERS, hasChatFilters, normalizeChatFilters,
} from '../../../../shared/chat/chatPaging.ts';

import type { ChatListFilters } from '../../../../shared/chat/chatPaging.ts';

// Телеграм-сайдбар чатов: поиск сверху, ниже — активные либо архивные чаты.
// Строка: аватар, название, сниппет последнего сообщения (или совпадения при поиске), время.
type ListRow = ChatListRow & {
  modelName: string;
  projectTitle: string;
  sleep?: ChatSleepingSession;
};

const chat = useChatStore();
// open — «чат выбран, покажи его». Нужен мобильной раскладке, где список и чат делят одну
// колонку: следить за activeId там мало — повторный тык по уже активному чату его не меняет.
const emit = defineEmits(['open', 'open-project']);

const prov = useProvidersStore();
const { sessions: sleepingSessions } = useChatSleeping();

prov.load(false, { cached: true, reason: 'mount' });

const SCOPE_LS = 'chat.list.scope';

/**
 * Область переживает монтирование: прежний тумблер слетал при каждом заходе.
 * Повреждённое или отсутствующее значение даёт «активные»; сбой хранилища
 * не ломает список.
 */

function restoreScope(): boolean {
  try {
    return localStorage.getItem(SCOPE_LS) === 'archived';
  } catch {
    return false;
  }
}

const q = ref('');

const showArchived = ref(restoreScope());
// Доступность протокола объявлена до filters: немедленный watch восстановления
// регистрируется сразу после filters и читает её при регистрации (иначе TDZ).

const filtersAvailable = computed(() => chat.pagingEnabled && chat.filtersProtocol === 1);

const FILTERS_LS = 'chat.list.filters';

/**
 * Восстановление принимает только нормализованные значения: повреждённый
 * или чужой JSON не ломает список и молча откатывается к пустым фильтрам.
 */

function restoreFilters(): ChatListFilters {
  try {
    const restored = normalizeChatFilters(JSON.parse(localStorage.getItem(FILTERS_LS) || '{}'));

    delete restored.project;

    return restored;
  } catch {
    return { ...EMPTY_CHAT_FILTERS };
  }
}

const filters = ref<ChatListFilters>({ ...EMPTY_CHAT_FILTERS });

const projectAvailable = computed(() => chat.pagingEnabled && chat.projectFiltersProtocol === 1);
const { projects, projectItems, selectedProject, selectProject, retryProjects, ready: projectsReady }
  = useChatProjectFilter(projectAvailable);
const projectById = computed(() => new Map(projectItems.value.map((item) => [item.id, item])));
const selectedProjectRecord = computed(() => projectById.value.get(selectedProject.value));
const canCreateChat = computed(() => chat.loaded && (
  !selectedProject.value || selectedProject.value === '@none'
  || Boolean(selectedProjectRecord.value)
));
const selectedProjectTitle = computed(() => selectedProject.value === '@none'
  ? t('core.chatProjectNone') : selectedProjectRecord.value?.title ?? selectedProject.value);
const listFilters = computed<ChatListFilters>(() => {
  const ordinary = { ...filters.value };

  delete ordinary.project;

  return {
    ...ordinary,
    ...(projectAvailable.value && selectedProject.value ? { project: selectedProject.value } : {}),
  };
});

const filtersOpen = ref(false);

const createOpen = ref(false);

/**
 * «Открыть найденный» из модалки создания ведёт в паспорт существующего проекта:
 * адрес принимает раздел «Проекты», поэтому навигацию делает владелец раскладки.
 */
function openFoundProject(id: string): void {
  emit('open-project', id);
}

const taskSelect = ref<'all' | 'any' | 'none'>('all');

const taskNumber = ref('');

let taskTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Восстановленный набор применяется только после подтверждения протокола
 * первой страницей: старый сервер отверг бы фильтры кодом 400 всего списка.
 * При потере флага активные фильтры снимаются, чтобы список жил как прежде;
 * сохранённый набор не затирается (персист ниже пропускает запись).
 * Набор перечитывается при каждом подтверждении: после сброса и возврата
 * протокола не воскрешаются значения времён монтирования.
 * Watch стоит после объявления filtersAvailable (шаг 6) и до watch списка:
 * его немедленный вызов должен видеть уже восстановленные фильтры.
 */

watch(filtersAvailable, (available) => {
  if (available) {
    const restored = restoreFilters();

    if (hasChatFilters(restored) && !hasChatFilters(filters.value)) {
      filters.value = { ...restored };

      taskSelect.value = restored.task === 'any' || restored.task === 'none'
        ? restored.task : 'all';

      taskNumber.value = /^[0-9]+$/.test(restored.task) ? restored.task : '';
    }

    return;
  }

  if (hasChatFilters(filters.value)) {
    filters.value = { ...EMPTY_CHAT_FILTERS };

    taskSelect.value = 'all';

    taskNumber.value = '';
  }
}, { immediate: true });

/**
 * Номер задачи приоритетнее режима; ввод с debounce, чтобы каждый символ
 * не создавал серверную страницу. Повторная проверка внутри таймера гасит
 * гонку со сбросом фильтров, случившимся за время ожидания.
 */

watch([taskSelect, taskNumber], () => {
  clearTimeout(taskTimer ?? undefined);

  taskTimer = setTimeout(() => {
    const number = taskNumber.value.trim();

    const task = number || (taskSelect.value === 'all' ? '' : taskSelect.value);

    if (task !== filters.value.task) {
      filters.value = { ...filters.value, task };
    }
  }, 250);
});

// Персист переживает сбой хранилища (приватный режим): фильтрация важнее записи.
// Пока протокол не подтверждён, не пишем: сброс на старом сервере не должен
// затирать сохранённый набор.

watch(filters, (value) => {
  if (!filtersAvailable.value) {
    return;
  }

  try {
    localStorage.setItem(FILTERS_LS, JSON.stringify(value));
  } catch {
    // Запись недоступна — фильтры продолжают работать в памяти.
  }
});

function onTaskNumber(value: string | number | null) {
  taskNumber.value = String(value ?? '').replace(/\D/g, '').slice(0, 12);
}

const rowsHost = ref<HTMLElement | null>(null);

const paging = computed(() => chat.pageFor(q.value, showArchived.value, listFilters.value));

// Сегмент области — прямая замена тумблера: showArchived остаётся источником правды
// для всего списка, сегмент лишь переключает его двумя кнопками.

const scopeSegment = computed({
  get: () => (showArchived.value ? 'archived' : 'active'),
  set: (value: string) => {
    showArchived.value = value === 'archived';
  },
});

// Счётчик архива — отдельный бейдж сегмента, а не « · N» в подписи: название
// остаётся коротким, число читается плашкой и не растягивает переключатель.
const scopeOptions = computed(() => [
  { value: 'active', label: t('core.chatFilterActive') },
  {
    value: 'archived',
    label: t('core.chatFilterArchived'),
    badge: selectedProject.value ? '' : chat.archivedChatCount || '',
  },
]);

const activeFilterCount = computed(() => [
  filters.value.unread,
  filters.value.waiting,
  filters.value.working,
  filters.value.task !== '',
  filters.value.provider !== '',
  filters.value.fresh !== '',
].filter(Boolean).length);

const stateFilterOptions = computed(() => [
  { key: 'unread', label: t('core.chatFilterUnread') },
  { key: 'waiting', label: t('core.chatFilterWaiting') },
  { key: 'working', label: t('core.chatFilterWorking') },
] as const);

/**
 * Фильтры меняются только целой копией: watch списка видит замену объекта
 * и перезагружает scope; мутация полей не породила бы гонку поколений.
 */

function setFilter<K extends keyof ChatListFilters>(key: K, value: ChatListFilters[K]) {
  filters.value = { ...filters.value, [key]: value };
}

/**
 * Подпись свежести — литеральные ключи: вычисляемый ключ потребовал бы таблицу
 * dynamicExpressions в i18n-scope, а ветвей здесь всего три.
 */

function freshLabel(fresh: ChatListFilters['fresh']): string {
  if (fresh === 'day') {
    return t('core.chatFilterFreshDay');
  }

  if (fresh === 'week') {
    return t('core.chatFilterFreshWeek');
  }

  return t('core.chatFilterFreshMonth');
}

/**
 * UiSelect отдаёт string|number|null; свежесть принимает только три окна,
 * неизвестное значение откатывается к «за всё время».
 */

function onFreshSelect(value: string | number | null) {
  const fresh = value === 'day' || value === 'week' || value === 'month' ? value : '';

  setFilter('fresh', fresh);
}

/**
 * UiSelect отдаёт string|number|null; режим задачи принимает только три
 * значения, неизвестное откатывается к «все чаты». Сужение здесь, а не в
 * v-model: широкий union UiSelectValue не присваивается в литеральный тип ref.
 */

function onTaskModeSelect(value: string | number | null) {
  taskSelect.value = value === 'any' || value === 'none' ? value : 'all';
}

/**
 * Чипы перечисляют включённые фильтры в порядке панели.
 * Задача показана номером либо режимом — тем же значением, что ушло на сервер.
 */

const filterChips = computed(() => {
  const value = filters.value;

  const chips: Array<{ key: keyof ChatListFilters; label: string }> = [];

  if (value.unread) {
    chips.push({ key: 'unread', label: t('core.chatFilterUnread') });
  }

  if (value.waiting) {
    chips.push({ key: 'waiting', label: t('core.chatFilterWaiting') });
  }

  if (value.working) {
    chips.push({ key: 'working', label: t('core.chatFilterWorking') });
  }

  if (value.task === 'any') {
    chips.push({ key: 'task', label: t('core.chatFilterTaskAny') });
  } else if (value.task === 'none') {
    chips.push({ key: 'task', label: t('core.chatFilterTaskNone') });
  } else if (value.task) {
    chips.push({ key: 'task', label: t('core.coreTaskid', { taskId: value.task }) });
  }

  if (value.provider) {
    chips.push({
      key: 'provider',
      label: prov.providers.find((entry) => entry.id === value.provider)?.name || value.provider,
    });
  }

  if (value.fresh) {
    chips.push({ key: 'fresh', label: freshLabel(value.fresh) });
  }

  return chips;
});

/**
 * Крестик чипа выключает один фильтр; задача также сбрасывает оба своих controls.
 * Полный сброс возвращает пустой набор и очищает номер с режимом.
 */

function clearFilter(key: keyof ChatListFilters) {
  if (key === 'task') {
    taskSelect.value = 'all';

    taskNumber.value = '';
  }

  setFilter(key, EMPTY_CHAT_FILTERS[key]);
}

function resetFilters() {
  taskSelect.value = 'all';

  taskNumber.value = '';

  filters.value = { ...EMPTY_CHAT_FILTERS };
}

// Персист области отдельным ключом: серверный контракт фильтров не меняется.

watch(showArchived, (value) => {
  try {
    localStorage.setItem(SCOPE_LS, value ? 'archived' : 'active');
  } catch {
    // Запись недоступна — область продолжает работать в памяти.
  }
});

let searchTimer: ReturnType<typeof setTimeout> | null = null;
let scopeEpoch = 0;
let restoringScope = false;

watch([q, showArchived, listFilters], ([query, archived, currentFilters], previous) => {
  clearTimeout(searchTimer ?? undefined);

  const epoch = ++scopeEpoch;

  if (previous?.[0] !== undefined && rowsHost.value) {
    chat.pageFor(previous[0], previous[1], previous[2]).scrollTop = rowsHost.value.scrollTop;
  }

  restoringScope = true;
  chat.beginChatSearch(query, archived, currentFilters);

  /**
   * Возврат к scope восстанавливает его scroll только после принятой порции.
   * Быстрый переход к другому поиску отменяет применение прежнего положения.
   */
  const load = async () => {
    await chat.searchChats(query, archived, currentFilters);
    await nextTick();

    if (epoch === scopeEpoch) {
      if (rowsHost.value) {
        rowsHost.value.scrollTop = paging.value.scrollTop;
      }

      restoringScope = false;
    }
  };

  if (query.trim()) {
    searchTimer = setTimeout(() => void load(), 250);
  } else {
    void load();
  }
}, { immediate: true });

onUnmounted(() => {
  clearTimeout(searchTimer ?? undefined);

  clearTimeout(taskTimer ?? undefined);
});

/**
 * Контейнер сообщает собственную прокрутку и загружает одну следующую порцию.
 * Кнопка продолжения остаётся доступной, когда строк недостаточно для overflow.
 */
function onRowsScroll() {
  const element = rowsHost.value;
  const page = paging.value;

  if (!element || restoringScope) {
    return;
  }

  page.scrollTop = element.scrollTop;

  if (page.loaded && page.hasMore && !page.loading && !page.error
    && element.scrollHeight - element.clientHeight - element.scrollTop <= 240) {
    void chat.loadChatPage(q.value, showArchived.value, false, listFilters.value);
  }
}

const emptyLabel = computed(() => {
  if (q.value.trim()) {
    return t('core.inboxNoResults');
  }

  return showArchived.value ? t('core.chatArhivPust') : t('core.chatNetAktivnyhChatov');
});

// Строки берут знак из каталога проектов, а подпись и оттенок модели — из реестра исполнителей.
const rows = computed(() => {
  if (!chat.loaded) {
    return [];
  }

  return chat.list(q.value, showArchived.value, listFilters.value).map((r: ChatListRow) => {
    const { id: modelId, model, provider } = prov.modelOf(r.modelRef || r.model);
    const project = projectById.value.get(r.catalogProjectId ?? '');

    return {
      ...r,
      projectTitle: project?.title ?? r.catalogProjectId ?? '',
      projectIcon: project?.icon,
      providerColor: provider?.color,
      modelName: model?.name || (provider ? modelId || provider.name : ''),
      sleep: sleepingSessions.value[r.id],
    };
  });
});

watch(() => rows.value.map((row) => row.id).join('\0'), async () => {
  if (!rowsHost.value || restoringScope) {
    return;
  }

  const restore = captureChatScrollAnchor(rowsHost.value, '[data-chat-id]');
  const atTop = rowsHost.value.scrollTop <= 1;
  const epoch = scopeEpoch;

  await nextTick();

  if (!rowsHost.value || restoringScope || epoch !== scopeEpoch) {
    return;
  }
  if (atTop) {
    rowsHost.value.scrollTop = 0;
  } else {
    restore();
  }
});

// Memo строки перечисляет всё, что рисует её поддерево, включая выбор и инлайн-редактор.
// Копия строки при обновлении другого чата не должна пересоздавать все controls списка.

// Отправка из архивного разговора сама возвращает его в активные. В этот момент
// переключаем и левый список: иначе открытый чат уже активный, а сайдбар продолжает
// показывать архив, из которого его строка только что исчезла.
watch(
  () => chat.archived.some((session: { id: string }) => session.id === chat.activeId),
  (archived, wasArchived) => {
    if (showArchived.value && wasArchived && !archived) {
      showArchived.value = false;
    }
  },
);

/**
 * Подсказка к знаку раскрывает имя проекта и модель чата.
 * Для работающего чата подпись модели также сообщает о ходе или сжатии.
 */
function avatarTitle(row: ListRow) {
  const project = row.projectTitle || t('core.chatProjectNone');
  const modelName = row.modelName || t('core.chatModelPoUmolchaniyu');
  let status = modelName;

  if (row.compacting) {
    status = t('core.chatModelnameSzhimayuKontekst', { modelName });
  } else if (row.sending) {
    status = t('core.chatModelnameAgentRabotaet', { modelName });
  }

  return `${project} · ${status}`;
}

/**
 * Относительное время сохраняет компактный телеграмный формат строки.
 * После недели календарная дата устойчивее постоянно растущего числа дней.
 */
const calendarDate = computed(
  () => new Intl.DateTimeFormat(uiLocale.value, { day: '2-digit', month: '2-digit' }),
);

/**
 * Форматтер принадлежит смонтированному списку и создаётся один раз, а не для каждой строки.
 * При пересортировке сохраняется прежний календарный и относительный формат времени.
 */
function ago(ts: number) {
  if (!ts) {
    return '';
  }

  const elapsed = Date.now() - ts;

  if (elapsed < 60e3) {
    return t('core.chatSeychas');
  }
  if (elapsed < 3600e3) {
    return t('core.chatFloorelapsed60e3M', { floorelapsed60e3: Math.floor(elapsed / 60e3) });
  }
  if (elapsed < 86400e3) {
    return t('core.chatFloorelapsed3600e3Ch', { floorelapsed3600e3: Math.floor(elapsed / 3600e3) });
  }
  if (elapsed < 7 * 86400e3) {
    return t('core.chatFloorelapsed86400e3D', { floorelapsed86400e3: Math.floor(elapsed / 86400e3) });
  }

  return calendarDate.value.format(new Date(ts));
}

const editId = ref<string | null>(null);
const editVal = ref('');
const editEl = ref<UiFieldHandle<HTMLInputElement> | UiFieldHandle<HTMLInputElement>[] | null>(null);

/**
 * Инлайн-редактор заменяет primary pressable, поэтому после рендера фокусируем
 * exposed handle поля из текущей строки и выделяем прежнее название целиком.
 */
async function startEdit(r: ListRow) {
  editId.value = r.id;
  editVal.value = r.title;

  await nextTick();

  // ref внутри v-for собирается в массив
  const el = Array.isArray(editEl.value) ? editEl.value[0] : editEl.value;

  el?.focus();
  el?.select?.();
}

function commitEdit() {
  if (editId.value) {
    chat.renameChat(editId.value, editVal.value.trim());
  }

  editId.value = null;
}

/**
 * Создание разрешено только после подтверждённого списка с сервера.
 * Мобильная область открывается, когда стор действительно создал разговор.
 */
/**
 * Создание берёт только явный выбор списка; фильтр не изменяет существующие разговоры.
 * Архивная/удалённая регистрация не становится новой рабочей областью.
 */
function newChat() {
  const selected = selectedProject.value;

  if (!canCreateChat.value) {
    return;
  }

  const options = selected === '@none'
    ? { workdir: { kind: 'grigdesk' as const } }
    : selected ? {
      workdir: {
        kind: 'project' as const,
        projectId: selected,
        repoKey: null,
      },
    } : {};

  if (!chat.newSession(options)) {
    return;
  }

  showArchived.value = false;
  resetFilters();
  emit('open');
}

function select(r: ListRow) {
  chat.selectChat(r.id);
  emit('open');
}

function restore(r: ListRow) {
  chat.restoreArchived(r.id);
  showArchived.value = false;
}

/**
 * Активный чат сначала архивируется, архивный удаляется безвозвратно.
 * Диалог сохраняет эту разницу в тексте и danger-семантике до мутации store.
 */
async function del(r: ListRow) {
  const permanent = r.archived;
  const ok = await confirmDialog(
    permanent
      ? messageRef('core.chatUdalitChatTitleBezvozvratno', { title: r.title })
      : messageRef('core.chatPeremestitChatTitleV', { title: r.title }),
    {
      title: permanent ? t('core.chatUdalitChatNavsegda') : t('core.chatPeremestitVArhiv'),
      okText: permanent ? t('core.taskDelete') : t('core.chatVArhiv'),
      danger: permanent,
    },
  );

  if (ok) {
    chat.deleteChat(r.id);
  }
}
</script>

<style scoped>
/* Ширину задаёт раскладка страницы: `--chat-list-w` ставит ChatsView, когда человек
   двигал разделитель. Пока не двигал — переменной нет, и ширину целиком решает CSS
   вместе со своими медиазапросами (второго источника правды о ширине экрана не заводим). */
.cl { width: var(--chat-list-w, 300px); flex: none; display: flex; flex-direction: row; min-height: 0;
  border-right: 1px solid var(--line); }

.cl-body {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.project-current {
  display: flex;
  align-items: center;
  min-width: 0;
}

.project-current > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Высота шапки — общий с открытым чатом токен (--chat-head-h): содержимое здесь и справа
   разное, и без общей высоты две разделительные линии идут на разном уровне. Содержимое
   центрируем по вертикали — тогда запас высоты не выглядит «прибитым» к верху. */
.top { display: flex; flex-direction: column; justify-content: center; gap: 4px;
  min-height: var(--chat-head-h); flex: none; padding: 8px 10px; border-bottom: 1px solid var(--line); }
.tools { display: flex; align-items: center; gap: 7px; }
.search { flex: 1; min-width: 0; }
/* Строка под поиском — единый левый кластер: лёгкий pill-переключатель области
   (chat-scope) и сразу за ним голая иконка фильтров, без прижатия к правому краю.
   Панель раскрывается ниже и отодвигает строки, как filterbar доски задач.
   Счётчик активных фильтров — угловой бейдж иконки, а не коробка с подписью. */
.list-controls { display: flex; align-items: center; gap: 6px; }
.scope { flex: 0 1 auto; min-width: 0; }
.filter-toggle { position: relative; flex: none; }
.filter-count { position: absolute; top: -3px; right: -3px; display: inline-grid; place-items: center;
  min-width: 14px; height: 14px; padding: 0 3px; border-radius: 7px; background: var(--accent);
  color: var(--surface); font-size: 9.5px; font-weight: 700; line-height: 1;
  box-shadow: 0 0 0 2px var(--surface); }
.filterbar {
  display: none;
  flex-direction: column;
  gap: 8px;
  margin-top: 4px;
  padding: 8px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: color-mix(in srgb, var(--surface-2) 45%, var(--surface));
  container-type: inline-size;
}
.filterbar.expanded { display: flex; }
.filter-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 4px 8px;
}
.filter-section {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.filter-caption {
  font-size: 11px;
  font-weight: 500;
  color: var(--ink-mid);
}
.filter-states {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.filter-state-dot {
  display: block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
}
.filter-state-dot--unread { background: var(--accent); }
.filter-state-dot--waiting { background: var(--warn); }
.filter-state-dot--working { background: var(--good); }
.filter-task-fields,
.filter-details {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.filter-section > .ui-select-wrap,
.filter-task-fields > * {
  width: 100%;
  min-width: 0;
}
@container (max-width: 250px) {
  .filter-task-fields,
  .filter-details { grid-template-columns: minmax(0, 1fr); }
}
.filter-chips { display: flex; flex-wrap: wrap; gap: 5px; padding: 6px 2px 0; }
.filter-chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 6px;
  border: 1px solid var(--line); border-radius: 6px; background: var(--surface-2);
  font-size: 11.5px; color: var(--ink-mid); }
.filter-empty { margin: 0 0 8px; }
.new { flex: none; }

.rows { flex: 1; overflow-y: auto; overflow-anchor: none; padding: 5px; }
.none { padding: 12px; font-size: 12.5px; text-align: center; }

.list-pending {
  padding-top: 12px;
}
.load-state {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 14px 20px;
}
.load-status {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.load-mark {
  display: grid;
  place-items: center;
  flex: none;
  width: 32px;
  height: 32px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--accent) 9%, transparent);
  color: var(--accent);
}
.load-mark svg {
  width: 20px;
  height: 20px;
}
.load-state-error .load-mark {
  background: color-mix(in srgb, var(--warn) 10%, transparent);
  color: var(--warn);
}
.load-copy {
  min-width: 0;
}
.load-title {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.load-hint,
.load-reason,
.load-retry-status {
  margin: 0;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.load-reason,
.load-retry-status {
  margin-top: 3px;
}
.list-skeleton {
  padding: 0 8px;
  pointer-events: none;
  mask-image: linear-gradient(to bottom, #000 15%, transparent 100%);
}
.skeleton-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: var(--chat-list-row-h);
  padding: 8px 6px;
}
.skeleton-avatar {
  width: var(--chat-avatar-size);
  flex: none;
}
.skeleton-copy {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 9px;
}
.skeleton-title {
  width: 68%;
}
.skeleton-snippet {
  width: 90%;
}
.skeleton-time {
  align-self: flex-start;
  width: 22px;
  margin-top: 8px;
}
.skeleton-row:nth-child(even) .skeleton-title {
  width: 50%;
}
.skeleton-row:nth-child(3n) .skeleton-snippet {
  width: 65%;
}
/* Фон строки — непрозрачный `--row-bg` поверх фона списка (`--surface`): тем же цветом
   кнопки действий закрывают конец названия и время, не отличаясь от самой строки. */
.row { position: relative; display: flex; align-items: center; gap: 9px; padding: 4px 8px;
  min-height: var(--chat-list-row-h); border-radius: 10px; --row-bg: var(--surface); background: var(--row-bg); }
.row-hit { display: flex; flex: 1; align-items: center; gap: 9px; width: 100%; min-width: 0; text-align: left; }

.row:hover { --row-bg: var(--surface-2); }
.row.cur { --row-bg: color-mix(in srgb, var(--accent) 18%, var(--surface)); }
/* Чат, где агент ждёт ответа: тёплая полоска слева — видно, что строка требует действия,
   даже когда список длинный (сам чип может уехать под многоточие названия). */
.row.wait { --row-bg: color-mix(in srgb, var(--warn, #e0a33a) 10%, var(--surface)); }
.row.wait::before { content: ''; position: absolute; left: 0; top: 6px; bottom: 6px; width: 3px;
  border-radius: 0 3px 3px 0; background: var(--warn, #e0a33a); }
.row.wait.cur { --row-bg: color-mix(in srgb, var(--warn, #e0a33a) 18%, var(--surface)); }

.ava {
  position: relative;
  display: grid;
  flex: none;
  place-items: center;
  width: var(--chat-avatar-size);
  height: var(--chat-avatar-size);
}
.ava > .project-avatar {
  width: calc(100% - 4px);
  height: calc(100% - 4px);
  border-radius: 50%;
}
.ava > .project-avatar.has-image {
  background: var(--surface-2);
}
/* Кольцо вращается вокруг неподвижного аватара проекта. */
.ava.live::before {
  --live-ring-color: var(--prov, var(--accent));
  content: '';
  position: absolute;
  inset: -4px;
  border: 2px solid color-mix(in srgb, var(--live-ring-color) 24%, transparent);
  border-top-color: var(--live-ring-color);
  border-right-color: color-mix(in srgb, var(--live-ring-color) 68%, transparent);
  border-radius: 50%;
  pointer-events: none;
  animation: chat-live-spin .85s linear infinite;
}
@keyframes chat-live-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .ava.live::before {
    animation: none;
    border-color: var(--live-ring-color);
  }
}
/* «Непрочитано» — точка на аватаре: не двигает разметку строки и не спорит с кольцом работы */
.udot { position: absolute; top: -1px; right: -1px; width: 10px; height: 10px; border-radius: 50%;
  background: var(--accent); box-shadow: 0 0 0 2px var(--surface); }

.mid { display: block; flex: 1; min-width: 0; }
.t1 { display: flex; align-items: baseline; gap: 6px; }
.name { flex: 1; min-width: 0; font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ago { flex: none; font-size: 11px; }
/* Модель чата — мелкой подписью рядом с названием; при нехватке места жертвуем ею, а не названием */
.mdl { flex: none; font-size: 10.5px; color: var(--ink-mid); border: 1px solid var(--line); border-radius: 5px;
  padding: 0 5px; max-width: 92px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mdl.brand {
  color: color-mix(in srgb, var(--prov) 48%, var(--ink));
  background: color-mix(in srgb, var(--prov) 14%, var(--row-bg));
  border-color: color-mix(in srgb, var(--prov) 45%, var(--line));
}
/* «Ждёт ответа» — чип на месте подписи модели: тёплый, заметный, но не кричащий */
.wchip { flex: none; font-size: 10.5px; font-weight: 600; color: var(--warn, #e0a33a); line-height: 1.6;
  border: 1px solid color-mix(in srgb, var(--warn, #e0a33a) 55%, transparent); border-radius: 5px; padding: 0 5px;
  background: color-mix(in srgb, var(--warn, #e0a33a) 14%, transparent); white-space: nowrap; }
/* Неотправленный текст — как в телеграме: пометка цветом, дальше сам текст */
.dr { color: var(--warn, #e0a33a); margin-right: 4px; }
.t2 { display: block; font-size: 12px; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; margin-top: 1px; }
.edit { width: 100%; }

/* Палец: одно постоянное место меню «⋯», ширина названия не меняется при касании и фокусе. */
.acts { display: flex; flex: none; align-items: center; }
.acts-quick { display: none; }

/* Мышь: меню не нужно, три кнопки всплывают при наведении поверх правого края строки
   (время и подпись модели). Место под них не резервируется и отступ строки не растёт —
   иначе название сужалось бы и прыгало при каждом проходе курсора по списку.
   Фокус с клавиатуры показывает кнопки так же, как наведение. */
@media (hover: hover) and (pointer: fine) {
  .acts { position: absolute; top: 4px; right: 8px; bottom: 4px; pointer-events: none; }
  .acts-menu { display: none; }
  .acts-quick { display: flex; align-items: center; gap: 3px; height: 100%; padding-left: 14px;
    background: linear-gradient(to right, transparent, var(--row-bg) 12px); opacity: 0; }
  .row:hover .acts-quick, .row:focus-within .acts-quick { opacity: 1; }
  /* Кликабельны только сами кнопки: полоса растушёвки слева пропускает нажатие в строку. */
  .row:hover .acts-quick > *, .row:focus-within .acts-quick > * { pointer-events: auto; }
}

/* Планшет-альбом: список уже, но остаётся на экране рядом с чатом */
@media (min-width: 900px) and (max-width: 1099px) { .cl { width: var(--chat-list-w, 232px); } }

/* Узкий экран: список занимает всю колонку (чат показывается вместо него — см. ChatsView) */
@media (max-width: 899px) {
  .cl { width: 100%; border-right: none; }
  .rows { padding: 5px 5px calc(6px + env(safe-area-inset-bottom, 0px)); }
}

@media (max-width: 600px) {
  .top {
    min-height: 0;
    padding: 6px 12px;
    gap: 4px;
  }
  .rows { padding: 4px 6px; }
  .row { gap: 8px; padding: 8px 6px; }
  .name { font-size: 15px; }
  .t2 { font-size: 13px; margin-top: 4px; }
  .mdl { max-width: 72px; }
}
</style>

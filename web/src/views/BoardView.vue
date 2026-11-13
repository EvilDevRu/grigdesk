<template>
  <div class="board ui-workspace"
    :data-perf-pending="performanceInitialPending ? '' : undefined"
    :data-perf-error="performanceInitialFailure ? '' : undefined" data-ui-workspace :class="{ 'stats-expanded': statsExpanded, 'has-board-pages': phonePages.length > 1 }">
    <UiPaneHeader class="board-heading" data-context="board-heading">
      <template #title>
        <h2 class="board-title">{{ translate('core.board') }}</h2>
      </template>
      <template #meta>
        <BoardTrackerSettingsButton v-if="phoneBoard" @click="trackerSettingsOpen = true" />
        <p v-else-if="data && !noTrackers" class="board-updated muted"
           role="status" data-role="board-snapshot-status">
          <span v-if="snapshotStale">{{ translate('core.boardSnapshotStale') }} </span>
          <time :datetime="snapshotDateTime">{{ translate('core.boardSnapshotUpdated', { time: snapshotTime }) }}</time>
        </p>
      </template>
      <template #actions>
        <UiButton tone="accent" data-context="workspace-toolbar" data-role="board-new-task"
                  @click="newTaskOpen = true">{{ translate('core.taskFormNewTask') }}</UiButton>
        <BoardTrackerSettingsButton v-if="!phoneBoard" @click="trackerSettingsOpen = true" />
      </template>
    </UiPaneHeader>
    <TrackerSettingsDialog v-if="trackerSettingsOpen" v-model:open="trackerSettingsOpen" />
    <NewGrigdeskTaskDialog v-if="newTaskOpen" v-model:open="newTaskOpen"
                           @created="ui.openTask($event.id, $event.source)"
                           @connect="trackerSettingsOpen = true" />

    <div id="board-tracker-panel" class="tracker-board">
      <div v-if="(!phoneBoard && !data) || noTrackers || error
                 || data?.widgets?.length || activeTasks.length"
           class="board-overview">
      <div v-if="noTrackers" class="tracker-setup-banner">
        <p>{{ translate('core.trackerSetupBanner') }}</p>
        <UiButton tone="accent" @click="trackerSettingsOpen = true">
          {{ translate('core.trackerSetupAction') }}
        </UiButton>
      </div>
    <template v-if="!noTrackers">
    <BoardLoading v-if="!phoneBoard && !data && !error" summary-only :label="translate('core.taskZagruzkaDoski')" />
    <UiInlineMessage v-if="error" :tone="data ? 'warning' : 'danger'" class="board-tracker-error"
    :data-perf-error="!data && !loading ? '' : undefined">
      <div class="board-tracker-error-heading">
        <strong>{{ trackerUnavailableLabel }}</strong>
        <div class="board-tracker-error-actions">
          <UiButton variant="text" :disabled="loading" :loading="loading" @click="board.load(true)">
            {{ translate('core.boardRetry') }}
          </UiButton>
          <UiDisclosureButton v-model:open="errorDetailsOpen" :controls="errorDetailsId" density="compact">
            {{ translate('core.boardErrorDetails') }}
          </UiDisclosureButton>
        </div>
      </div>
      <p v-if="errorDetailsOpen" :id="errorDetailsId" class="board-tracker-error-details">{{ error }}</p>
    </UiInlineMessage>

    <template v-if="data">
      <TrackerWidgets :widgets="data.widgets ?? []" />

      <!-- Драйвер разрешает несколько незакрытых таймеров одновременно: показываем каждый. -->
      <section
        v-if="activeTasks.length"
        class="active-timers"
        aria-labelledby="active-timers-title"
      >
        <div class="active-timers-head">
          <span class="active-timers-symbol" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M12 7.5v4.5l3 2 M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z" />
            </svg>
            <span class="active-timers-pulse"></span>
          </span>
          <span class="active-timers-heading">
            <h2 id="active-timers-title" class="active-timers-title">{{ translate('core.taskAktivnyeTaymery') }}</h2>
            <span class="active-timers-subtitle">{{ translate('core.taskVremyaSpisyvaetsyaSeychas') }}</span>
          </span>
          <span
            class="active-timers-count mono"
            :aria-label="translate('core.taskZapuschenoTaymerovLength', { length: activeTasks.length })"
          >
            {{ activeTasks.length }}
          </span>
        </div>
        <ul class="active-timers-grid">
          <li v-for="task in activeTasks" :key="task.id" class="active-timer-item">
            <UiPressable
              data-context="active-timer-card"
              v-tooltip="task.title"
              @click="ui.openTask(task.id)"
            >
              <span class="active-timer-card-head">
                <span class="active-timer-state">
                  <span class="active-timer-dot" aria-hidden="true"></span> {{ translate('core.taskTaymerIdet') }} </span>
                <span class="active-timer-time mono">{{ secToHMS(liveElapsed(task)) }}</span>
              </span>
              <span class="active-task-title">{{ task.title }}</span>
              <span class="active-task-meta">
                <span class="mono">#{{ task.id }}</span>
                <span v-if="projectName(task)" class="active-task-project">
                  {{ projectName(task) }}
                </span>
              </span>
            </UiPressable>
          </li>
        </ul>
      </section>

    </template>
    </template>
      </div>
      <UiTabs v-if="phoneBoard && phonePages.length > 1" class="board-page-nav"
              data-context="board-page-nav" data-ui-workspace-tabs size="compact" :label="translate('core.boardPages')"
              :model-value="activeBoardPage" @update:model-value="selectBoardPage">
        <UiTab v-for="page in phonePages" :id="`${boardPagesId}-tab-${page.id}`" :key="page.id"
               :value="page.id" :controls="`${boardPagesId}-panel-${page.id}`"
               :aria-label="translate('core.boardPageLabel', {
                 label: page.id === 'related' ? translate('core.boardRelatedTitle') : page.label,
                 count: page.loading ? translate('core.loading') : page.count,
               })"
               :data-board-page-tab="page.id" data-context="board-page-tab">
          <span class="board-page-label">{{ page.label }}</span>
          <span class="board-page-count">{{ page.loading ? '…' : page.count }}</span>
        </UiTab>
      </UiTabs>
      <div ref="boardPagesTrack" class="board-pages" @scroll.passive="onBoardPagesScroll">

      <div class="cols"
           :class="{ solo: !(showRelated && (data?.toReview?.length || data?.created?.length)) }">
        <!-- Мои задачи — основной блок -->
        <section :id="`${boardPagesId}-panel-mine`" class="col primary"
                 :role="phoneBoard && phonePages.length > 1 ? 'tabpanel' : undefined"
                 :aria-labelledby="phoneBoard && phonePages.length > 1 ? `${boardPagesId}-tab-mine` : undefined"
                 :inert="phoneBoard && activeBoardPage !== 'mine' ? true : undefined">
          <div class="colhead">
            <h3 class="h big">
              <span class="heading-name">{{ translate('core.boardMinePage') }}</span>
              <span class="cnt">
                {{ hasListFilters
                  ? translate('core.boardVisibleTaskCount', { visible: myTasks.length, total: allTasks.length })
                  : myTasks.length }}
              </span>
            </h3>
            <div class="search" role="search">
              <UiSearchInput
                ref="taskSearch"
                v-model="q"
                :aria-label="translate('core.taskPoiskPoZadacham')"
                :placeholder="translate('core.taskNomerNazvanieProekt')"
                :clear-label="translate('core.clearSearch')"
              />
            </div>
            <UiButton
              class="filter-toggle"
              data-context="board-filter-toggle"
              variant="outline"
              :tone="activeFilterCount ? 'accent' : 'neutral'"
              :pressed="Boolean(activeFilterCount)"
              :aria-expanded="String(filtersOpen)"
              :aria-label="activeFilterCount
                ? translate('core.boardTaskFiltersActive', { count: activeFilterCount })
                : translate('core.boardTaskFilters')"
              v-tooltip="translate('core.boardTaskFilters')"
              aria-controls="board-task-filters"
              @click="filtersOpen = !filtersOpen"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M4 5h16l-6.3 7.1v5.4l-3.4 1.7v-7.1z" />
              </svg>
              <span class="filter-toggle-label">{{ translate('core.taskFiltry') }}</span>
              <span v-if="activeFilterCount" class="filter-count">{{ activeFilterCount }}</span>
            </UiButton>

          </div>

          <div class="filter-section show-filter" role="group" :aria-label="translate('core.taskPokazat')">
            <UiToggleButton
              v-model="favoriteOnly"
              class="favfilter"
              data-context="board-quick-filter"
              variant="outline"
              tone="warning"
              :disabled="!favoritesReady"
              v-tooltip="favoritesReady ? translate('core.taskTolkoIzbrannyeZadachi') : translate('core.taskIzbrannoeZagruzhaetsya')"
            >
              <template #leading>
                <svg
                  viewBox="0 0 24 24"
                  :fill="favoriteOnly ? 'currentColor' : 'none'"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="m12 2.7 2.8 5.7 6.3.9-4.6 4.4 1.1 6.3-5.6-3-5.6 3 1.1-6.3-4.6-4.4 6.3-.9z" />
                </svg>
              </template> {{ translate('core.taskIzbrannye') }} {{ currentFavoriteCount }}
            </UiToggleButton>
            <!-- «Новых» не бывает без загруженной базовой линии отметок, поэтому кнопка
                 ждёт сервер (seen.ready), а не гадает по пустому набору. -->
            <UiToggleButton
              v-model="newOnly"
              class="newfilter"
              data-context="board-quick-filter"
              variant="outline"
              tone="accent"
              :disabled="!seenReady"
              v-tooltip="seenReady ? translate('core.taskTolkoNovyeTeChto') : translate('core.taskOtmetkiProsmotraZagruzhayutsya')"
            >
              <template #leading>
                <svg
                  viewBox="0 0 24 24"
                  :fill="newOnly ? 'currentColor' : 'none'"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M12 3.4 14 9l5.6 2-5.6 2-2 5.6-2-5.6L4.4 11 10 9z" />
                </svg>
              </template> {{ translate('core.codeReviewStatusA') }} {{ currentNewCount }}
            </UiToggleButton>
          </div>

          <div id="board-task-filters" class="filterbar" :class="{ expanded: filtersOpen }"
               role="region" :aria-label="translate('core.boardTaskFilters')">
            <label class="filter-section sort-filter">
              <span class="filter-caption">{{ translate('core.taskSortirovka') }}</span>
              <UiSelect v-model="sortBy" class="trisort">
                <option value="created">{{ translate('core.boardCreatedOrder') }}</option>
                <option v-if="analysisEnabled" value="risk">{{ translate('core.taskPoRisku') }}</option>
                <option v-if="analysisEnabled" value="complexity">{{ translate('core.taskPoSlozhnosti') }}</option>
                <option v-if="analysisEnabled" value="size">{{ translate('core.taskPoRazmeru') }}</option>
                <option v-if="analysisEnabled" value="fresh">{{ translate('core.taskPoSvezhestiOtsenki') }}</option>
              </UiSelect>
            </label>

            <div class="filter-section" role="group" :aria-label="translate('core.boardSourceFilter')">
              <span class="filter-caption">{{ translate('core.boardSourceFilter') }}</span>
              <UiToggleButton v-for="driver in sourceDrivers" :key="driver.id"
                              :model-value="selectedSources.includes(driver.id)"
                              @update:model-value="toggleSource(driver.id, $event)">
                {{ driver.name }}
              </UiToggleButton>
            </div>
            <label class="filter-section">
              <span class="filter-caption">{{ translate('core.boardProjectFilter') }}</span>
              <UiSelect v-model="selectedGroup">
                <option value="">{{ translate('core.boardAllProjects') }}</option>
                <option value="__none__">{{ translate('core.boardNoProject') }}</option>
                <option v-for="group in groupOptions" :key="group" :value="group">{{ group }}</option>
              </UiSelect>
            </label>

            <div v-if="analysisEnabled" class="filter-section triage-filter" role="group" aria-labelledby="board-triage-filter-label">
              <span id="board-triage-filter-label" class="filter-caption">{{ translate('core.taskDesignAnalysis') }}</span>
              <UiSegmentedControl
                v-model="triageMode"
                class="trisegment"
                data-context="board-triage-mode"
                :label="translate('core.taskRezhimTriazha')"
                :options="TRIAGE_OPTIONS"
              />
            </div>
            <div v-else class="filter-section triage-disabled">{{ translate('core.taskTriazhVyklyuchen') }}</div>

            <div class="filter-actions">
              <UiButton
                v-if="hasListFilters || activeFilterCount"
                class="filter-reset"
                variant="text"
                v-tooltip="translate('core.trackerResetOrder')"
                @click="resetTaskFilters"
              > {{ translate('settings.reset') }} </UiButton>
              <div v-if="analysisEnabled && unrated.length" class="batch-actions" role="group"
                   :aria-label="translate('core.taskMassovyeDeystviyaSZadachami')">
                <UiButton
                  class="batch-action triage-all"
                  variant="solid"
                  tone="accent"
                  :aria-label="translate('core.taskOtsenitVseZadachiBez', { length: unrated.length })"
                  v-tooltip="translate('core.taskPostavitVseZadachiBez')"
                  @click="analyzeAllUnrated"
                >
                  <template #leading>
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.8"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M12 3.5 14 9l5.5 2-5.5 2-2 5.5-2-5.5L4.5 11 10 9z" />
                    </svg>
                  </template> {{ translate('core.taskOtsenitVse') }} <template #trailing>
                    <span class="batch-count mono" aria-hidden="true">{{ unrated.length }}</span>
                  </template>
                </UiButton>
              </div>
            </div>
          </div>
          <div v-if="selectedSources.includes('tracker') && favorites.error" class="faverror" role="alert">
            <span>{{ translate('core.taskIzbrannoe') }} {{ favorites.error }}</span>
            <UiButton
              variant="text"
              tone="accent"
              :disabled="favorites.loading"
              @click="favorites.load(true)"
            >
              {{ favorites.loading ? translate('core.taskPovtoryayu') : translate('core.pluginNotificationsRetry') }}
            </UiButton>
          </div>
          <!-- Отказ отметок обязан быть виден: молча он читается как «новых задач нет». -->
          <div v-if="selectedSources.includes('tracker') && seen.error" class="faverror" role="alert">
            <span>{{ translate('core.taskOtmetkiProsmotra') }} {{ seen.error }}</span>
            <UiButton
              variant="text"
              tone="accent"
              :disabled="seen.loading"
              @click="seen.load(true)"
            >
              {{ seen.loading ? translate('core.taskPovtoryayu') : translate('core.pluginNotificationsRetry') }}
            </UiButton>
          </div>
          <div class="list-head"
               :class="{ 'without-analysis': !analysisEnabled, 'without-timer': !supportsTimer }"
               aria-hidden="true">
            <span class="list-task-label">{{ translate('core.chatOptionTask') }}</span>
            <span v-if="analysisEnabled">{{ translate('core.taskDesignAnalysis') }}</span>
            <span v-if="supportsTimer" class="list-time-label">{{ translate('core.taskUchteno') }}</span>
          </div>
          <ul ref="taskList" class="tasks scroller" @scroll="onTasksScroll">
            <li v-for="t in visibleTasks" :key="taskReferenceKey(t)" class="trow"
                :class="{ 'without-analysis': !analysisEnabled, 'without-timer': !supportsTimer }">
              <TaskFavoriteButton :active="favoriteState(t).isFavorite(t.id)"
                                  class="board-favorite" data-context="board-task-favorite"
                                  :pending="!favoriteState(t).loaded || favoriteState(t).loading || favoriteState(t).isPending(t.id)"
                                  :task-title="t.title" @toggle="toggleFavorite(t)" />
              <UiPressable
                class="ttext"
                :disabled="Boolean(data?.multiSource && !isTaskSourceId(t.source))"
                data-role="task-title"
                data-context="board-task"
                @click="ui.openTask(t.id, isTaskSourceId(t.source) ? t.source : undefined)"
              >
                <span class="task-name">{{ t.title }}</span>
                <span class="task-meta">
                  <span class="mono task-id">#{{ t.id }}</span>
                  <TaskSourceChip v-if="t.source || t.driverId" :source="t.source" :driver-id="t.driverId" />
                  <span v-if="projectName(t)" class="task-project">{{ projectName(t) }}</span>
                  <span v-if="taskStateLabel(t)" class="task-state" :class="{ overdue: t.overdue }">
                    <span
                      class="tstat"
                      :class="{
                        conv: conveyor.has(taskReferenceKey(t)),
                        'on-shelf': shelfEnabled && shelfState(t).isOnShelf(t.id),
                      }"
                      :style="{ background: dotColor(t) }"
                      v-tooltip="dotTitle(t)"
                    ></span>
                    {{ taskStateLabel(t) }}
                  </span>
                  <span v-else class="tstat" :class="{ 'on-shelf': shelfEnabled && shelfState(t).isOnShelf(t.id) }"
                        :style="{ background: dotColor(t) }" v-tooltip="dotTitle(t)"></span>
                  <span v-if="shelfEnabled && shelfState(t).isOnShelf(t.id)" class="shelf-mark">{{ translate('core.taskNaPolke') }}</span>
                  <span v-if="isNewTask(t)" class="newbadge" role="img"
                        :aria-label="translate('core.taskNovayaZadachaEscheNe')"
                        v-tooltip="translate('core.taskNovayaZadachaEscheNe')">{{ translate('core.taskNovaya') }}</span>
                  <span v-if="t.unread" class="badge" :aria-label="translate('core.taskNeprochitannyhSoobscheniyUnread', { unread: String(t.unread) })">
                    {{ t.unread }} {{ translate('core.taskSoobsch') }} </span>
                </span>
              </UiPressable>
              <div v-if="analysisEnabled" class="task-triage"><TriageBadge :row="triageOf(t)" /></div>
              <span v-if="supportsTimer" class="ttime" :class="{ running: t.timerRunning }">
                <span class="mono">{{ secToHMS(liveElapsed(t)) }}</span>
                <span v-if="t.timerRunning" class="time-state">{{ translate('core.taskIdetUchet') }}</span>
              </span>
            </li>
            <li v-if="!myTasks.length" class="muted empty">
              <template v-if="!selectedSources.length">{{ translate('core.boardNoSourcesSelected') }}</template>
              <template v-else-if="!allTasks.length">{{ translate('core.boardUnifiedEmpty') }}</template>
              <template v-else-if="favoriteOnly && !currentFavoriteCount">{{ translate('core.taskVTekuschemSpiskeIzbrannyh') }}</template>
              <template v-else-if="favoriteOnly">{{ translate('core.taskIzbrannyeZadachiNePodhodyat') }}</template>
              <template v-else-if="newOnly && !currentNewCount">{{ translate('core.taskNovyhZadachNetVse') }}</template>
              <template v-else-if="newOnly">{{ translate('core.taskNovyeZadachiNePodhodyat') }}</template>
              <template v-else>{{ translate('core.inboxNoResults') }}</template>
            </li>
            <li v-else-if="visibleTasks.length < myTasks.length" class="more muted">
              <span>{{ translate('core.taskPokazano') }} {{ visibleTasks.length }} {{ translate('settings.from') }} {{ myTasks.length }}</span>
              <UiButton data-role="board-load-more" variant="text" @click="showMoreTasks"> {{ translate('core.chatPageMore') }} </UiButton>
            </li>
          </ul>
        </section>

        <!-- На телефоне пустой контроль сохраняет ширину вкладок и положение остальных страниц. -->
        <section v-if="showRelated && (phoneBoard || data?.toReview?.length || data?.created?.length)"
                 :id="`${boardPagesId}-panel-related`" class="col secondary"
                 :role="phoneBoard && phonePages.length > 1 ? 'tabpanel' : undefined"
                 :aria-labelledby="phoneBoard && phonePages.length > 1 ? `${boardPagesId}-tab-related` : undefined"
                 :inert="phoneBoard && activeBoardPage !== 'related' ? true : undefined">
          <h3 class="h big related-heading">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
                 stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M8 5H5v15h14V5h-3M9 3h6v4H9zM8 12h8M8 16h5" />
            </svg>
            {{ translate('core.boardRelatedTitle') }}
          </h3>
          <UiTabs :model-value="secondaryMode ?? 'review'" class="secondary-tabs" :label="translate('core.taskSvyazannyeZadachi')"
                  @update:model-value="secondaryMode = String($event)">
            <UiTab id="board-review-tab" data-context="board-related-tab"
                   value="review" controls="board-related-list"> {{ translate('core.boardRelatedPage') }} <span class="cnt">{{ data?.toReview!.length }}</span>
            </UiTab>
            <UiTab id="board-created-tab" data-context="board-related-tab"
                   value="created" controls="board-related-list"> {{ translate('core.taskPorucheniya') }} <span class="cnt">{{ data?.created!.length }}</span>
            </UiTab>
          </UiTabs>
          <UiSearchInput
            v-model="secondaryQuery"
            :aria-label="translate('core.taskPoiskPoSvyazannymZadacham')"
            :placeholder="translate('core.taskPoiskVEtomSpiske')"
            :clear-label="translate('core.boardViewClearRelatedTaskSearch')"
          />
          <div class="secondary-summary">
            <span>{{ secondaryMode !== 'created' ? translate('core.taskZhdutMoegoKontrolya') : translate('core.taskYaPostavilZadachu') }}</span>
            <span v-if="secondaryQuery.trim()">{{ relatedTasks.length }} {{ translate('settings.from') }} {{ relatedSource.length }}</span>
          </div>
          <div
            id="board-related-list"
            class="related-panel"
            role="tabpanel"
            :aria-labelledby="secondaryMode !== 'created' ? 'board-review-tab' : 'board-created-tab'"
          >
            <ul ref="relatedList" class="tasks related-list">
              <li v-for="t in relatedTasks" :key="taskReferenceKey(t)" class="related-row">
                <UiPressable
                  class="ttext"
                :disabled="Boolean(data?.multiSource && !isTaskSourceId(t.source))"
                  data-role="task-title"
                  data-context="board-task"
                  @click="ui.openTask(t.id, isTaskSourceId(t.source) ? t.source : undefined)"
                >
                  <span class="task-name">{{ t.title }}</span>
                  <span class="task-meta">
                    <span class="mono task-id">#{{ t.id }}</span>
                  <TaskSourceChip v-if="t.source || t.driverId" :source="t.source" :driver-id="t.driverId" />
                    <span v-if="projectName(t)" class="task-project">{{ projectName(t) }}</span>
                    <span v-if="t.responsible" class="task-responsible">{{ t.responsible }}</span>
                    <span v-if="taskStateLabel(t)" class="task-state" :class="{ overdue: t.overdue }">
                      <span class="tstat" :style="{ background: dotColor(t) }"></span>
                      {{ taskStateLabel(t) }}
                    </span>
                  </span>
                </UiPressable>
              </li>
              <li v-if="!relatedTasks.length" class="muted empty">
                {{ secondaryQuery.trim() ? translate('core.inboxNoResults') : translate('core.taskVEtomSpiskePoka') }}
              </li>
            </ul>
          </div>
        </section>
      </div>

      </div>
    </div>
    <footer v-if="phoneBoard && !noTrackers" class="board-phone-footer">
      <p role="status" data-role="board-snapshot-status">
        <template v-if="data">
          <span v-if="snapshotStale">{{ translate('core.boardSnapshotStale') }} </span>
          <time :datetime="snapshotDateTime">{{ translate('core.boardSnapshotUpdated', { time: snapshotTime }) }}</time>
        </template>
        <span v-else>{{ error ? trackerUnavailableLabel : translate('core.loading') }}</span>
      </p>
    </footer>
  </div>
</template>

<script setup lang="ts">
import TaskSourceChip from '../shared/TaskSourceChip.vue';
import { taskReferenceKey, taskPersonalSource, isTaskSourceId } from '../../../shared/tasks/taskReference.ts';
import TrackerWidgets from './board/TrackerWidgets.vue';
import BoardTrackerSettingsButton from './board/BoardTrackerSettingsButton.vue';
import { useBoardPhonePages } from './board/useBoardPhonePages.ts';
import type { BoardPhonePage } from './board/useBoardPhonePages.ts';
import TrackerSettingsDialog from './board/TrackerSettingsDialog.vue';
import { boardAllRoleTasks } from '../shared/boardTimerTasks.ts';
import { boardSupportsTimer } from '../shared/trackerCapabilities.ts';
import { useTrackersStore } from '../stores/trackers.ts';
import BoardLoading from './BoardLoading.vue';

import NewGrigdeskTaskDialog from './board/NewGrigdeskTaskDialog.vue';
import type { BoardTask } from '../shared/boardContracts.ts';
import type { UiFieldHandle } from '../ui.ts';
import { isRecord } from '../../../shared/lib/objects.ts';
import { decodePipelineTasks } from '../shared/pipelineContracts.ts';

import { ref, computed, watch, nextTick, onMounted, onUnmounted, useId } from 'vue';
import { storeToRefs } from 'pinia';
import { liveTimerSec, secToHMS } from '../shared/format.ts';
import { useBoardStore } from '../stores/board.ts';
import { useUiStore } from '../stores/ui.ts';
import { analyzeTask, startAnalysisPolling, useAnalysisStore } from '../actions/analysis';
import { useTaskFavoritesStore } from '../stores/taskFavorites.ts';
import { useTaskShelfStore } from '../stores/taskShelf.ts';
import { usePluginsStore } from '../stores/plugins.ts';
import { useTaskSeenStore } from '../stores/taskSeen.ts';
import TriageBadge from './board/TriageBadge.vue';
import TaskFavoriteButton from './board/TaskFavoriteButton.vue';
import { api } from '../shared/apiClient.ts';
import { useSse } from '../composables/useSse.ts';
import {
  boardTaskListResetKey, matchesBoardTask, selectBoardTasks, unifiedBoardTasks, boardComposition,
} from '../shared/boardTaskList.ts';
import {
  confirmDialog, UiButton, UiDisclosureButton, UiInlineMessage, UiPaneHeader, UiPressable,
  UiSearchInput, UiSegmentedControl, UiSelect, UiTab, UiTabs, UiToggleButton, vTooltip, t, messageRef,
  uiLocale,
} from '../ui';

const translate = t;
const ui = useUiStore();
const newTaskOpen = ref(false);
const trackerSettingsOpen = ref(false);
const errorDetailsOpen = ref(false);
const errorDetailsId = `board-error-${useId()}`;
const trackers = useTrackersStore();
const trackerUnavailableLabel = computed(() => {
  const name = trackers.catalog?.drivers.find((driver) => driver.id === trackers.catalog?.externalId)?.name;

  return name
    ? translate('core.boardNamedTrackerUnavailable', { name })
    : translate('core.boardTrackerUnavailable');
});
// Данные — из кеш-стора (мгновенный показ при переходе + фоновое обновление).
const board = useBoardStore();
const { data, error, loading, readAt } = storeToRefs(board);
const noTrackers = computed(() => !!trackers.catalog && !trackers.error
  && !(trackers.catalog.enabledIds?.length ?? (trackers.catalog.externalId ? 1 : 0)));

// Пометка устаревания обязана реагировать и на отказ отдельной ветки мультиисточника:
// общий error остаётся пустым, когда не обновляется только один трекер.
const snapshotStale = computed(() => !!error.value || !!board.refreshProblem);

const performanceInitialFailure = computed(() => !data.value && !!error.value && !loading.value);
const performanceInitialPending = computed(() => !performanceInitialFailure.value
  && !noTrackers.value && !data.value && !error.value);

watch(error, () => {
  errorDetailsOpen.value = false;
});

const snapshotDateTime = computed(() => readAt.value > 0
  ? new Date(readAt.value).toISOString() : undefined);
const snapshotTime = computed(() => readAt.value > 0
  ? new Date(readAt.value).toLocaleString(uiLocale.value) : '—');
const now = ref(Date.now());
const STATUS_COLOR: Record<string, string> = {
  running: 'var(--accent)',
  overdue: 'var(--bad)',
  my_review: 'var(--warn)',
  waiting: 'var(--warn)',
  deferred: 'var(--idle)',
  completed: 'var(--good)',
  done: 'var(--good)',
};

function statusColor(kind: string | undefined) {
  return STATUS_COLOR[kind || ''] || 'var(--ink-mid)';
}

// Задачи на конвейере фабрики: id → жив ли демон. Точка статуса в списке берёт
// цвет конвейера (зелёный — идёт, оранжевый — стоит/ждёт), как на странице конвейера.
const conveyor = ref(new Map<string, boolean>());
/**
 * Дешёвый снимок фабрики уточняет точки состояния задач трекера.
 * Неверный ответ оставляет прежние точки и не объявляет пустую успешную загрузку.
 */
async function loadConveyor() {
  try {
    const { tasks } = decodePipelineTasks(await api.get('/api/tasks?sources=1'));

    conveyor.value = new Map((tasks || []).filter((task) => task.source).map((task) => [
      taskReferenceKey({ id: task.task, source: task.source }), !!task.daemonAlive,
    ]));
  } catch { /* фабрика недоступна — точки остаются статусными */ }
}

useSse((name) => {
  if (name === 'trackers-changed') {
    trackers.invalidate();
    void trackers.load(true);
    void board.load(true);
    void favorites.load(true);
    void seen.load(true);
  }

  if (name === 'state-change') {
    loadConveyor();
  }
});
/**
 * Точка задачи использует состояние фабрики, когда оно уже известно.
 * При отсутствии проекции сохраняется прежний цвет портального статуса.
 */
function dotColor(t: BoardTask) {
  const k = taskReferenceKey(t);

  if (conveyor.value.has(k)) {
    return conveyor.value.get(k) ? 'var(--good)' : 'var(--warn)';
  }

  return statusColor(t.statusKind);
}
/**
 * Подпись точки объясняет текущую работу или остановку конвейера.
 * Задача вне фабрики продолжает показывать исходную подпись трекера.
 */
function dotTitle(t: BoardTask) {
  const k = taskReferenceKey(t);

  if (conveyor.value.has(k)) {
    return conveyor.value.get(k)
      ? translate('core.coreNaKonveyereIdet')
      : translate('core.coreNaKonveyereStoitZhdet');
  }

  return t.statusLabel;
}

function projectName(t: BoardTask) {
  return String(t?.group || '').trim();
}
/**
 * Доступная подпись задачи согласована с её точкой состояния.
 * Признак просрочки используется только вне уже известного конвейера.
 */
function taskStateLabel(task: BoardTask) {
  const id = taskReferenceKey(task);

  if (conveyor.value.has(id)) {
    return conveyor.value.get(id)
      ? translate('core.coreKonveyerIdet')
      : translate('core.pipelineKonveyerOstanovlen');
  }

  return task.overdue ? translate('core.taskOverdue') : task.statusLabel || '';
}

// Живой тик таймера: считается от timer_started_at из трекера — см. liveTimerSec.
function liveElapsed(t: BoardTask) {
  return liveTimerSec(t, now.value);
}

// Иконки плиток (Lucide-контуры, stroke=currentColor).
const supportsTimer = computed(() => data.value?.multiSource
  ? trackers.catalog?.drivers.some((driver) => driver.capabilities.timer) ?? false
  : boardSupportsTimer(data.value));
const activeTasks = computed(() => supportsTimer.value
  ? boardAllRoleTasks(data.value).filter((task) => task.timerRunning) : []);
// Поиск основного списка независим от поиска контроля и поручений.
const q = ref('');
const taskSearch = ref<UiFieldHandle<HTMLInputElement> | null>(null);
const taskList = ref<HTMLElement | null>(null);
const secondaryQuery = ref('');
const secondaryMode = ref<string | null>(null);
const relatedList = ref<HTMLElement | null>(null);
const relatedSource = computed(() => secondaryMode.value === 'created'
  ? data.value?.created || []
  : data.value?.toReview || []);
const relatedTasks = computed(() => relatedSource.value
  .filter((task) => !trackers.catalog?.enabledIds || selectedSources.value.includes(
    task.source?.split('@')[0] ?? 'tracker',
  ))
  .filter((task) => matchesBoardTask(task, secondaryQuery.value)));

// При первом ответе открываем непустой список. Дальше выбор принадлежит человеку,
// даже если после обновления в выбранном разделе больше нет задач.
watch(() => [data.value?.toReview?.length || 0, data.value?.created?.length || 0], ([review, created]) => {
  if (secondaryMode.value === null && (review || created)) {
    secondaryMode.value = review ? 'review' : 'created';
  }
}, { immediate: true });
watch([secondaryMode, secondaryQuery], () => {
  if (relatedList.value) {
    relatedList.value.scrollTop = 0;
  }
});

// Триаж: бейджи оценок + сортировка/фильтры по ним. Выбор запоминается.
const analysis = useAnalysisStore();
const favorites = useTaskFavoritesStore();
const shelf = useTaskShelfStore();
const plugins = usePluginsStore();
const shelfEnabled = computed(() => plugins.enabled('shelf'));
const analysisEnabled = computed(() => {
  const manifest = plugins.byId('analysis');

  return manifest ? manifest.enabled !== false : true;
});
const favoriteOnly = ref(false);
const statsExpanded = ref(false);
const filtersOpen = ref(false);
// Новая задача — та, которую ещё не открывали. Отметки серверные, поэтому до их
// загрузки (и до базовой линии) новых не бывает: см. геттер ready.
const seen = useTaskSeenStore();
const newOnly = ref(false);
const favoriteState = (task: BoardTask) => favorites.forSource?.(
  isTaskSourceId(task.source) ? task.source : undefined,
) ?? favorites;
const seenState = (task: BoardTask) => seen.forSource?.(
  isTaskSourceId(task.source) ? task.source : undefined,
) ?? seen;
const shelfState = (task: BoardTask) => shelf.forSource?.(
  isTaskSourceId(task.source) ? task.source : undefined,
) ?? shelf;
const isNewTask = (task: BoardTask) => seenState(task).ready && !seenState(task).isSeen(task.id);
const TRIAGE_LS = 'board.triage';
const SORT_MODES = new Set(['created', 'risk', 'complexity', 'size', 'fresh']);
const TRIAGE_OPTIONS = [
  { value: 'all', get label() {
    return translate('core.selectAllGroups');
  } },
  { value: 'unrated', get label() {
    return translate('core.taskBezOtsenki');
  } },
  { value: 'needs-info', get label() {
    return translate('core.taskNuzhnyUtochneniya');
  } },
];
/**
 * Сохранённые предпочтения принимаются как неизвестный JSON.
 * Неверный контейнер сохраняет прежний fallback сортировки и фильтров доски.
 */
function readTriagePrefs() {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(TRIAGE_LS) || '{}');
    const saved = isRecord(value) ? value : {};

    return {
      sortBy: typeof saved.sortBy === 'string' && SORT_MODES.has(saved.sortBy) ? saved.sortBy : 'created',
      // Один режим вместо двух независимых флагов: повреждённое старое значение
      // больше не может одновременно включить «без оценки» и «нужны уточнения».
      sources: Array.isArray(saved.sources) ? [...new Set(saved.sources.filter((source) =>
        typeof source === 'string' && source !== 'grigdesk'))] : ['tracker'],
      group: typeof saved.group === 'string' ? saved.group : '',
      triageMode: saved?.onlyUnrated ? 'unrated' : saved?.onlyNeedsInfo ? 'needs-info' : 'all',
    };
  } catch {
    return {
      sortBy: 'created',
      triageMode: 'all',
      sources: ['tracker'],
      group: ''
    };
  }
}

const savedTriage = readTriagePrefs();
const selectedSources = ref<string[]>(savedTriage.sources);
const selectedGroup = ref(savedTriage.group);
const sourceDrivers = computed(() => trackers.catalog?.enabledIds
  ? trackers.catalog.drivers.filter((driver) => (trackers.catalog!.enabledIds!.includes(driver.id)
      || data.value?.tasks?.some((task) => task.source?.startsWith(`${driver.id}@`))))
  : [{ id: 'tracker', name: trackerName.value }]);

const allTasks = computed(() => unifiedBoardTasks(
  data.value?.tasks,
));
const groupOptions = computed(() => [...new Set(allTasks.value
  .map((task) => String(task.group || '').trim()).filter(Boolean))].sort());
const sourceTasks = computed(() => selectBoardTasks({
  tasks: allTasks.value,
  sources: selectedSources.value,
  group: selectedGroup.value,
  // Источник и проект общие для списка и счётчиков. Порядок задаётся ниже,
  // после выбора сортировки; счётчикам сортировать строки незачем.
  sortBy: 'tracker',
}));
const showRelated = computed(() => selectedSources.value.length > 0
  && !!data.value);
const trackerName = computed(() => trackers.catalog?.drivers
  .find((driver) => driver.id === trackers.catalog?.externalId)?.name
  || translate('core.boardTrackerSource'));

watch(sourceDrivers, (drivers) => {
  if (selectedSources.value.includes('tracker') && trackers.catalog?.enabledIds) {
    selectedSources.value = [...selectedSources.value.filter((id) => id !== 'tracker'),
      ...drivers.map((driver) => driver.id)];
  }
}, { immediate: true });

const favoritesReady = computed(() => favorites.loaded);
const seenReady = computed(() => seen.ready);

function toggleSource(source: string, enabled: boolean) {
  selectedSources.value = enabled ? [...new Set([...selectedSources.value, source])]
    : selectedSources.value.filter((item) => item !== source);
}

watch(() => [board.sourceKey, board.readAt], () => {
  if (selectedGroup.value && selectedGroup.value !== '__none__'
    && !loading.value && !error.value && data.value
    && !groupOptions.value.includes(selectedGroup.value)) {
    selectedGroup.value = '';
  }
});

const sortBy = ref(savedTriage.sortBy);   // created | risk | complexity | size | fresh
const triageMode = ref(savedTriage.triageMode); // all | unrated | needs-info
const onlyUnrated = computed(() => triageMode.value === 'unrated');
const onlyNeedsInfo = computed(() => triageMode.value === 'needs-info');

watch([sortBy, triageMode, selectedSources, selectedGroup], () => {
  try {
    localStorage.setItem(TRIAGE_LS, JSON.stringify({
      version: 2,
      sources: selectedSources.value,
      group: selectedGroup.value,
      sortBy: sortBy.value,
      onlyUnrated: onlyUnrated.value,
      onlyNeedsInfo: onlyNeedsInfo.value,
    }));
  } catch { /* приватный режим/запрет хранилища не должен ронять доску */ }
});

const numericAllowed = (task: BoardTask) => task.source === data.value?.source
  || (!data.value?.multiSource && !isTaskSourceId(task.source));
const triageOf = (task: BoardTask) => numericAllowed(task) ? analysis.byTask[task.id] || null : null;
// Батч: все задачи без оценки и не в очереди — в триаж по одной (очередь на сервере).
const unrated = computed(() => allTasks.value.filter((t) => {
  if (!analysisEnabled.value || !numericAllowed(t)) {
    return false;
  }

  const r = triageOf(t);

  return !r?.analysis && !['queued', 'running'].includes(r?.status?.state || '');
}));
/**
 * Последовательно ставит ещё не оценённые задачи в существующую очередь триажа.
 * Подтверждение человека и отказ одной задачи не меняют порядок остальных запросов.
 */
async function analyzeAllUnrated() {
  const list = unrated.value;

  if (!list.length) {
    return;
  }
  if (!(await confirmDialog(
    messageRef('core.taskPostavitVOcheredTriazha', { length: list.length }),
    { title: translate('core.taskOtsenitVseZadachiBez2'), okText: translate('core.taskPostavitVOchered') },
  ))) {
    return;
  }

  for (const t of list) {
    try {
      await analyzeTask(t.id, { source: isTaskSourceId(t.source)
        ? t.source : taskPersonalSource(t.personalSource) });
    } catch {
      // Отказ одной задачи не отменяет остальные элементы очереди.
    }
  }
}

const projectedAnalysis = computed(() => Object.fromEntries(allTasks.value
  .filter(numericAllowed).map((task) => [taskReferenceKey(task), analysis.byTask[task.id]])));

const myTasks = computed(() => {
  return selectBoardTasks({
    tasks: sourceTasks.value,
    analysisByTask: projectedAnalysis.value,
    query: q.value,
    sortBy: analysisEnabled.value ? sortBy.value : 'created',
    onlyUnrated: analysisEnabled.value && onlyUnrated.value,
    onlyNeedsInfo: analysisEnabled.value && onlyNeedsInfo.value,
    favoriteOnly: favoriteOnly.value,
    isFavorite: (task: BoardTask) => favoriteState(task).isFavorite(task.id),
    newOnly: newOnly.value && seenReady.value,
    isSeen: (task: BoardTask) => !seenState(task).ready || seenState(task).isSeen(task.id),
  });
});
const currentFavoriteCount = computed(() => {
  return sourceTasks.value.filter((task) => favoriteState(task).isFavorite(task.id)).length;
});
// Счётчик на кнопке фильтра — по всему списку доски, а не по видимой выборке:
// он отвечает на вопрос «сколько задач я ещё не смотрел», а не «сколько нашлось».
const currentNewCount = computed(() => {
  return sourceTasks.value.filter(isNewTask).length;
});
const activeFilterCount = computed(() => [
  sortBy.value !== 'created',
  sourceDrivers.value.some((driver) => !selectedSources.value.includes(driver.id)),
  !!selectedGroup.value,
  favoriteOnly.value,
  newOnly.value,
  analysisEnabled.value && triageMode.value !== 'all',
].filter(Boolean).length);
const hasListFilters = computed(() => !!q.value.trim()
  || sourceDrivers.value.some((driver) => !selectedSources.value.includes(driver.id)) || !!selectedGroup.value
  || favoriteOnly.value || newOnly.value
  || (analysisEnabled.value && triageMode.value !== 'all'));

/**
 * Возвращает исходный список и фокус в поиск после исчезновения кнопки сброса.
 * Сортировка и личные фильтры сбрасываются вместе, серверные отметки не меняются.
 */
async function resetTaskFilters() {
  q.value = '';
  sortBy.value = 'created';
  selectedSources.value = sourceDrivers.value.map((driver) => driver.id);
  selectedGroup.value = '';
  triageMode.value = 'all';
  favoriteOnly.value = false;
  newOnly.value = false;
  await nextTick();
  taskSearch.value?.focus();
}

const toggleFavorite = (task: BoardTask) => favoriteState(task).toggle(task.id);
// Пагинация по скроллу: рисуем первые N, при докрутке до низа добавляем ещё.
const PAGE = 40;
const visibleCount = ref(PAGE);
const visibleTasks = computed(() => myTasks.value.slice(0, visibleCount.value));
const listResetKey = computed(() => boardTaskListResetKey({
  query: q.value,
  onlyUnrated: onlyUnrated.value,
  onlyNeedsInfo: onlyNeedsInfo.value,
  favoriteOnly: favoriteOnly.value,
  newOnly: newOnly.value,
  sortBy: sortBy.value,
  taskCount: allTasks.value.length,
  sources: selectedSources.value,
  group: selectedGroup.value,
  composition: JSON.stringify([board.sourceKey, boardComposition(allTasks.value)]),
}));

watch(listResetKey, () => {
  visibleCount.value = PAGE;

  if (taskList.value) {
    taskList.value.scrollTop = 0;
  }
});

function showMoreTasks() {
  visibleCount.value = Math.min(myTasks.value.length, visibleCount.value + PAGE);
}
/**
 * Подгружает следующую порцию строк при приближении к концу списка.
 * Проверка DOM-цели оставляет посторонние события без изменения пагинации.
 */
function onTasksScroll(e: Event) {
  const el = e.target;

  if (!(el instanceof HTMLElement)) {
    return;
  }
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80 && visibleCount.value < myTasks.value.length) {
    showMoreTasks();
  }
}

const boardPagesId = `board-pages-${useId()}`;
const phonePages = computed<BoardPhonePage[]>(() => {
  const pages: BoardPhonePage[] = [{
    id: 'mine',
    label: translate('core.boardMinePage'),
    count: allTasks.value.length,
    loading: loading.value && !data.value,
  }];

  if (showRelated.value) {
    pages.push({
      id: 'related',
      label: translate('core.boardRelatedPage'),
      count: (data.value?.toReview?.length ?? 0) + (data.value?.created?.length ?? 0),
      loading: false,
    });
  }

  return pages;
});
const {
  phone: phoneBoard,
  activePage: activeBoardPage,
  track: boardPagesTrack,
  selectPage: selectBoardPage,
  onScroll: onBoardPagesScroll,
} = useBoardPhonePages(phonePages);

let ticker: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  void trackers.load();
  board.load();
  favorites.load(true);
  seen.load(true);

  if (analysisEnabled.value) {
    startAnalysisPolling();
  }

  loadConveyor();
  ticker = setInterval(() => {
    now.value = Date.now();
  }, 1000);
});
onUnmounted(() => {

  if (ticker) {
    clearInterval(ticker);
  }
});
</script>

<style scoped>
/* Шапка заполняет верхнее и боковые поля AppShell, как тулбар конвейера.
   Отступ содержимого доски сохраняется у самой страницы. */
.board-heading {
  flex: none;
  margin: calc(var(--page-gutter) * -1) calc(var(--page-gutter) * -1) 0;
}
.board-overview {
  display: contents;
}
.board-pages {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}
.board-page-label {
  min-width: 0;
  overflow-wrap: anywhere;
}
.tracker-board {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}
.board-tracker-error-heading,
.board-tracker-error-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.board-tracker-error-heading {
  justify-content: space-between;
}
.board-tracker-error-details {
  margin: 8px 0 0;
  overflow-wrap: anywhere;
}
.tracker-setup-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 12px;
  padding: 12px 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface-2);
}
.tracker-setup-banner p {
  flex: 1 1 240px;
  min-width: 0;
  margin: 0;
  color: var(--ink);
}

.board {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
  container: board-page / inline-size;
}
.board-updated {
  margin: 0;
  font-size: 11px;
  line-height: 1.4;
}
.err { color: var(--bad); }
.link { color: var(--accent); margin-left: 8px; }

.stats { display: grid; gap: 12px; grid-template-columns: repeat(2, 1fr); }
@container board-page (min-width: 720px) { .stats { grid-template-columns: repeat(4, 1fr); } }
.tile { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius);
  padding: 12px 16px; display: flex; flex-direction: column; gap: 7px; }
.thead { min-height: 36px; display: flex; align-items: center; gap: 9px; }
.tico { width: 27px; height: 27px; border-radius: 8px; display: grid; place-items: center; flex: none; }
.tico svg { width: 15px; height: 15px; }
.t-accent .tico { color: var(--accent); background: color-mix(in srgb, var(--accent) 15%, transparent); }
.t-good .tico { color: var(--good); background: color-mix(in srgb, var(--good) 15%, transparent); }
.t-warn .tico { color: var(--warn); background: color-mix(in srgb, var(--warn) 15%, transparent); }
.t-month .tico { color: var(--ink); background: var(--surface-2); }
.tlabel { font-size: 12px; color: var(--ink-mid); font-weight: 500; }
.tval { font-size: 24px; font-weight: 700; letter-spacing: -.02em; line-height: 1; }
.tdelta { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 4px; align-self: flex-start;
  font-size: 11px; color: var(--ink-mid); line-height: 1.5; }
.tdelta .darrow { font-weight: 700; }
.tdelta .dvs { color: var(--ink-mid); }
.tdelta.up { color: var(--good); }
.tdelta.down { color: var(--ink-mid); }

.tpct { margin-left: auto; font-size: 12px; color: var(--ink-mid); font-weight: 600; }
.tpct.over { color: var(--good); }
.month-summary {
  display: flex; align-items: flex-end; justify-content: space-between; flex-wrap: wrap; gap: 7px;
}
.month-completed {
  display: inline-flex; align-items: baseline; gap: 4px; color: var(--ink-mid);
  font-size: 10.5px; line-height: 1.1;
}
.month-completed strong { color: var(--good); font-size: 16px; font-weight: 700; }
.bar { height: 7px; background: var(--surface-2); border-radius: 999px; overflow: hidden; }
.bar .fill { display: block; height: 100%; background: var(--good); border-radius: 999px; transition: width .3s; }
.bar .fill.over { background: linear-gradient(90deg, var(--good), var(--accent)); }
.mfoot { display: flex; align-items: center; justify-content: space-between; font-size: 11.5px; }
.mfoot .over { color: var(--good); font-weight: 600; }

.active-timers {
  padding: 12px;
  background:
    linear-gradient(
      135deg,
      color-mix(in srgb, var(--good) 7%, var(--surface)),
      var(--surface) 32%
    );
  border: 1px solid color-mix(in srgb, var(--good) 34%, var(--line));
  border-radius: var(--radius);
  box-shadow: var(--shadow);
}
.active-timers-head {
  display: flex;
  align-items: center;
  gap: 11px;
  min-width: 0;
  margin-bottom: 11px;
  padding: 0 2px;
}
.active-timers-symbol {
  position: relative;
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  flex: none;
  border-radius: 10px;
  background: color-mix(in srgb, var(--good) 13%, transparent);
  color: var(--good);
}
.active-timers-symbol svg {
  width: 17px;
  height: 17px;
}
.active-timers-pulse {
  position: absolute;
  top: -2px;
  right: -2px;
  width: 8px;
  height: 8px;
  border: 2px solid var(--surface);
  border-radius: 50%;
  background: var(--good);
  animation: active-timer-pulse 1.6s ease-in-out infinite;
}
.active-timers-heading {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.active-timers-title {
  margin: 0;
  color: var(--ink);
  font-size: 13px;
  font-weight: 680;
  line-height: 1.2;
}
.active-timers-subtitle {
  overflow: hidden;
  color: var(--ink-mid);
  font-size: 10.5px;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.active-timers-count {
  min-width: 24px;
  height: 24px;
  display: inline-grid;
  place-items: center;
  flex: none;
  box-sizing: border-box;
  border-radius: 999px;
  background: color-mix(in srgb, var(--good) 15%, transparent);
  color: var(--good);
  font-size: 11.5px;
  font-weight: 750;
}
.active-timers-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(260px, 100%), 1fr));
  gap: 8px;
  list-style: none;
  margin: 0;
  padding: 0;
}
.active-timer-item {
  min-width: 0;
}
.active-timer-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  min-width: 0;
}
.active-timer-state {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--good);
  font-size: 10px;
  font-weight: 650;
  letter-spacing: .02em;
  white-space: nowrap;
}
.active-timer-dot {
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: 50%;
  background: var(--good);
  box-shadow: 0 0 6px color-mix(in srgb, var(--good) 65%, transparent);
}
.active-timer-time {
  flex: none;
  color: var(--accent);
  font-size: 14px;
  font-weight: 650;
  white-space: nowrap;
}
.active-task-title {
  display: -webkit-box;
  overflow: hidden;
  color: var(--ink);
  font-size: 13px;
  font-weight: 620;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-height: 1.35;
  text-align: left;
}
.active-task-meta {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  min-width: 0;
  margin-top: auto;
  color: var(--ink-mid);
  font-size: 10px;
  line-height: 1.2;
}
.active-task-project {
  overflow: hidden;
  padding-left: 7px;
  border-left: 1px solid var(--line-2);
  text-overflow: ellipsis;
  white-space: nowrap;
}
@keyframes active-timer-pulse { 50% { opacity: .35; } }
@media (prefers-reduced-motion: reduce) {
  .active-timers-pulse { animation: none; }
}

.cols { display: flex; flex-wrap: wrap; gap: 16px; align-items: stretch; min-width: 0; }
.col { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
/* Основной блок «Мои задачи» — в карточке, чтобы визуально доминировал */
.col.primary {
  flex: 2 1 720px; container: board-primary / inline-size;
  background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 18px;
}
.col.secondary {
  flex: 1 1 280px;
  gap: 14px;
  padding: 18px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
}
.related-heading { min-height: var(--control-height); }
.related-heading svg {
  width: 18px;
  height: 18px;
  flex: none;
  color: var(--ink-mid);
}
.secondary-tabs { width: 100%; }
.secondary-tabs > :deep(.ui-tab) { flex: 1; }
.secondary-summary {
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 4px 8px;
  color: var(--ink-mid);
  font-size: 12px;
}
.related-panel { display: flex; flex: 1; min-height: 0; }
.related-list { flex: 1; max-height: min(58vh, 560px); overflow-y: auto; scrollbar-gutter: stable; }
.related-row { padding: 14px 6px; }
.related-row:hover, .related-row:focus-within { background: var(--surface-2); }
.related-row + .related-row { border-top: 1px solid var(--line); }
/* Правой колонки нет — карточка задач занимает всю доступную строку. */
.cols.solo .primary { flex-basis: 100%; }
.colhead {
  display: grid;
  grid-template-columns: minmax(130px, 1fr) minmax(180px, 300px) auto;
  align-items: center;
  gap: 12px;
  margin: 0 0 4px;
  min-width: 0;
}
.h {
  font-size: 14px;
  font-weight: 640;
  margin: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--ink-mid);
}
.h.big { font-size: 16px; color: var(--ink); letter-spacing: -.015em; }
.colhead .h { flex-wrap: wrap; }
.heading-name { white-space: nowrap; }
.cnt {
  font-size: 11px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  color: var(--ink-mid);
  background: var(--surface-2);
  border-radius: 4px;
  padding: 2px 7px;
  white-space: nowrap;
}
.filter-toggle {
  display: inline-flex;
  grid-column: 3;
  grid-row: 1;
  justify-self: end;
}
.filter-count {
  min-width: 18px; height: 18px; display: inline-grid; place-items: center; padding: 0 4px;
  border-radius: 999px; background: color-mix(in srgb, var(--accent) 18%, transparent);
  color: var(--accent); font-size: 10px; font-weight: 700; line-height: 1;
}
.filterbar {
  display: none;
  align-items: flex-end;
  flex-wrap: wrap;
  gap: 12px;
  min-width: 0;
  max-width: 100%;
  padding: 14px 0 6px;
  border-top: 1px solid var(--line);
}
.filterbar.expanded { display: flex; }
.filter-section { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; min-width: 0; }
.sort-filter { flex: 0 1 205px; }
.show-filter {
  flex: none;
  gap: 8px;
  padding-bottom: 6px;
}
.triage-filter { flex: 0 1 auto; }
.filter-caption {
  flex-basis: 100%; color: var(--ink-mid); font-size: 11px; font-weight: 500;
  line-height: 1.4; white-space: nowrap;
}
.trisort {
  flex: 1 1 135px; min-width: 0; box-sizing: border-box;
}
.filter-actions { display: flex; flex: 0 1 auto; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; margin-left: auto; }
.batch-actions {
  display: flex; align-items: center; flex: none; padding-left: 10px;
  border-left: 1px solid var(--line);
}
.batch-count {
  min-width: 20px; height: 20px; display: inline-grid; place-items: center; box-sizing: border-box;
  border-radius: 999px; background: color-mix(in srgb, #000 18%, transparent); padding: 0 5px;
  font-size: 10px; line-height: 1;
}
.search {
  grid-column: 2;
  grid-row: 1;
  width: 100%;
  min-width: 0;
}
.search > :deep(.ui-search-input) { width: 100%; }
.faverror {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  margin: 2px 0 4px; padding: 7px 10px; border: 1px solid color-mix(in srgb, var(--bad) 45%, var(--line));
  border-radius: 8px; color: var(--bad); font-size: 12px;
}
.tasks { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.scroller {
  flex: 1;
  max-height: min(58vh, 560px);
  overflow-y: auto;
  scrollbar-gutter: stable;
}
.more {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  font-size: 12px;
  padding: 10px 0 4px;
}
.list-head,
.trow {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) 182px 86px;
  align-items: center;
  gap: 12px;
}
.list-head {
  padding: 10px 8px;
  overflow-y: hidden;
  scrollbar-gutter: stable;
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
  color: var(--ink-mid);
  font-size: 11px;
}
.list-task-label { grid-column: 2; }
.list-time-label { text-align: right; }
.trow { min-width: 0; padding: 15px 8px; }
.trow.without-analysis,
.list-head.without-analysis { grid-template-columns: 28px minmax(0, 1fr) 86px; }
.trow.without-timer,
.list-head.without-timer { grid-template-columns: 28px minmax(0, 1fr) 182px; }
.trow.without-analysis.without-timer,
.list-head.without-analysis.without-timer { grid-template-columns: 28px minmax(0, 1fr); }
.trow > :deep(.board-favorite) { align-self: start; margin-top: -3px; }
.trow:hover,
.trow:focus-within { background: var(--surface-2); }
.trow + .trow { border-top: 1px solid var(--line); }
.task-name { width: 100%; font-size: 14px; font-weight: 500; line-height: 1.5; }
.task-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 10px;
  min-width: 0;
  color: var(--ink-mid);
  font-size: 11.5px;
  line-height: 1.5;
}
.task-id { color: var(--ink-low); font-size: 10.5px; }
.task-project { overflow-wrap: anywhere; }
.task-state { display: inline-flex; align-items: center; gap: 7px; }
.task-state.overdue { color: var(--bad); }
.shelf-mark { color: var(--warn); }
.task-triage { min-width: 0; }
.tstat { width: 8px; height: 8px; border-radius: 50%; flex: none; box-shadow: 0 0 6px color-mix(in srgb, currentColor 0%, transparent); }
.tstat.on-shelf { outline: 1px solid var(--warn); outline-offset: 3px; }
/* Задача на конвейере: точка чуть крупнее и «дышит» — видно с первого взгляда */
.tstat.conv { width: 9px; height: 9px; animation: convpulse 2s ease-in-out infinite; }
@keyframes convpulse { 50% { opacity: .45; } }
.badge { font-size: 11px; color: var(--accent); }
/* Метка «новая» — того же синего, что и точка новых задач на чипе «Доска» в навигации:
   человек приходит сюда именно с неё, и цвет должен совпасть. */
.newbadge {
  flex: none; font-size: 11px; font-weight: 500; line-height: 1.5;
  border-radius: 5px;
  background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); padding: 1px 6px;
}
.ttime {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  color: var(--ink-mid);
  font-size: 12px;
}
.ttime.running { color: var(--good); }
.time-state { font-size: 11px; }
.empty { font-size: 13px; padding: 24px 10px; }

/* Решение принимается по ширине карточки, а не viewport: sidebar, dock и правая
   колонка могут оставить планшету узкий primary даже при широком окне. */
@container board-primary (max-width: 720px) {
  .colhead { grid-template-columns: minmax(0, 1fr) auto; }
  .colhead .h { grid-column: 1 / -1; }
  .filter-toggle { grid-column: 2; grid-row: 2; }
  .search { grid-column: 1; grid-row: 2; }
  .filterbar { display: none; padding-top: 5px; border-top: 1px solid var(--line); }
  .filterbar.expanded { display: flex; }
  .filter-section { flex: 1 1 100%; align-items: stretch; }
  .filter-caption { flex-basis: 100%; padding: 2px 1px 0; }
  .sort-filter .trisort { flex-basis: 100%; width: 100%; }
  .show-filter { flex: none; align-items: center; }
  .trisegment { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); width: 100%; }
  .trisegment :deep(.ui-button) { width: 100%; }
  .filter-actions { width: 100%; margin-left: 0; }
  .filter-actions > :deep(.ui-button) { flex: 1 1 auto; }
  .batch-actions { margin-left: auto; }
  .list-head { display: none; }
  .trow,
  .trow.without-analysis { grid-template-columns: 28px minmax(0, 1fr) 86px; gap: 9px; padding: 12px 2px; }
  .trow.without-timer { grid-template-columns: 28px minmax(0, 1fr); }
  .trow .ttext { grid-column: 2 / -1; }
  .task-triage { grid-column: 2; }
  .ttime { grid-column: 3; grid-row: 2; }
}

@container board-primary (max-width: 560px) {
  .trisegment { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .batch-actions {
    flex: 1 1 100%;
    margin-left: 0;
    padding: 8px 0 0;
    border-left: 0;
    border-top: 1px solid var(--line);
  }
  .batch-actions > :deep(.ui-button) { width: 100%; }
}

@container board-primary (max-width: 390px) {
  .colhead { column-gap: 8px; }
  .colhead .h { font-size: 15px; gap: 6px; }
  .trow,
  .trow.without-analysis { grid-template-columns: 24px minmax(0, 1fr) 78px; gap: 6px; }
  .trow.without-timer,
  .trow.without-analysis.without-timer { grid-template-columns: 24px minmax(0, 1fr); }
  .task-triage :deep(.total) { display: none; }
}

@media (prefers-reduced-motion: reduce) {
  .tstat.conv { animation: none; }
}

.charts-head { display: flex; align-items: center; justify-content: space-between; }
.charts-grid { display: grid; gap: 12px; grid-template-columns: 1fr; margin-top: 10px; }
@container board-page (min-width: 720px) { .charts-grid { grid-template-columns: repeat(3, 1fr); } }
@container board-page (max-width: 420px) {
  .stats { gap: 8px; }
  .tile { padding: 10px; }
  .thead { gap: 6px; }
  .tico { width: 22px; height: 22px; }
  .tval { font-size: 20px; line-height: 1.2; overflow-wrap: anywhere; }
}
.stats-summary { display: none; align-items: center; justify-content: space-between; gap: 8px; }
@media (max-height: 500px) {
  .stats-summary { display: flex; }
  .board:not(.stats-expanded) .stats { display: none; }
  .filter-toggle { display: inline-flex; }
  .filterbar:not(.expanded) { display: none; }
}
@container board-page (max-width: 500px) {
  .stats-summary { display: flex; flex-wrap: wrap; }
  .board:not(.stats-expanded) .stats { display: none; }
}

/* На телефоне список принадлежит прокрутке страницы: вложенное окно в 58vh
   мешало долистывать задачи и переходить к контролю и поручениям одним жестом. */
@media (max-width: 600px) {
  .board {
    height: 100%;
    min-height: 0;
    gap: 8px;
    overflow: hidden;
    padding: 0 var(--page-gutter) var(--page-gutter);
    background: var(--surface);
  }
  .tracker-board {
    flex: 1;
    min-height: 0;
    gap: 8px;
    overflow: visible;
  }
  .board-overview {
    display: flex;
    flex-direction: column;
    flex: none;
    gap: 8px;
    max-height: min(30vh, 240px);
    overflow-y: auto;
  }
  .board-phone-footer {
    flex: none;
    min-height: 18px;
  }
  .board-pages {
    position: relative;
    display: grid;
    flex: 1;
    min-height: 0;
    grid-auto-flow: column;
    grid-auto-columns: 100%;
    grid-template-rows: minmax(0, 1fr);
    gap: 0;
    overflow-x: auto;
    overflow-y: hidden;
    scroll-snap-type: x mandatory;
    overscroll-behavior-x: contain;
    scrollbar-width: none;
  }
  .board-pages::-webkit-scrollbar { display: none; }
  .board-pages > .cols { display: contents; }
  .board.has-board-pages .colhead .search,
  .board.has-board-pages .colhead .filter-toggle { grid-row: 1; }
  .board-heading { margin: 0 calc(var(--page-gutter) * -1); }
  .cols { gap: 16px; }
  .board.has-board-pages .colhead .h,
  .board.has-board-pages .col.secondary > .h { display: none; }
  .col.primary, .col.secondary {
    flex-basis: 100%;
    width: 100%;
    height: 100%;
    min-height: 0;
    padding: 0;
    overflow-y: auto;
    scroll-snap-align: start;
    scroll-snap-stop: always;
    border: 0;
    border-radius: 0;
    background: transparent;
  }
  .colhead .h, .col.secondary > .h {
    margin: 0;
    color: var(--ink-mid);
    font-size: 14px;
    line-height: 20px;
  }
  [data-role='board-snapshot-status'] {
    margin: 0;
    padding-inline: 12px;
    font-size: 12px;
    line-height: 18px;
  }
  .colhead { grid-template-columns: minmax(0, 1fr) auto; gap: 4px 8px; margin: 0; }
  .colhead .h { grid-column: 1 / -1; }
  .colhead .search { grid-column: 1; grid-row: 2; }
  .colhead .filter-toggle { grid-column: 2; grid-row: 2; }
  .triage-filter { flex: 1 1 100%; }
  .trisegment { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); width: 100%; }
  .scroller, .related-list { max-height: none; overflow-y: visible; scrollbar-gutter: auto; }
  .tasks .trow, .tasks .trow.without-analysis {
    grid-template-columns: minmax(0, 1fr) auto 44px;
    gap: 4px 8px;
    padding: 8px 12px;
    border-radius: 0;
  }
  .tasks .trow .ttext { grid-column: 1 / 3; grid-row: 1; }
  .tasks .trow > :deep(.board-favorite) { grid-column: 3; grid-row: 1; margin-top: 0; }
  .tasks .trow .task-triage { grid-column: 1; grid-row: 2; }
  .tasks .trow .ttime {
    grid-column: 2 / -1;
    grid-row: 2;
    flex-direction: row;
    align-items: center;
    gap: 8px;
  }
  .task-name { font-size: 15px; line-height: 1.45; }
  .task-meta { font-size: 12px; gap: 4px 8px; }
  .col.secondary { gap: 8px; }
  .related-row { padding: 10px 12px; }
  .active-timers { padding: 10px; }
  .charts-head { flex-wrap: wrap; gap: 8px; }
}
</style>

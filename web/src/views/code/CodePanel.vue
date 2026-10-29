<template>
  <div class="code-panel" :class="{ compact, narrow: codePanelNarrow }"
       :aria-busy="loading ? 'true' : undefined">
    <header ref="panelHeader" class="code-head" tabindex="-1">
      <strong>Код</strong>
      <!-- Выбор рабочей копии живёт в шапке, а не отдельным блоком панели: там он
           виден и при свёрнутом дереве, а панели остаётся один смысл — содержимое. -->
      <div class="head-ctx">
        <div v-if="showsProjectPicker" class="head-pick project" v-tooltip="'Проект'">
          <label for="code-project">проект</label>
          <UiSelect id="code-project" compact data-context="code-head-select"
                    :model-value="project" @change="selectProject">
            <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.id }}</option>
          </UiSelect>
        </div>
        <div v-if="showsContextPicker" class="head-pick tree"
             v-tooltip="context?.treePath || 'Рабочая копия'">
          <label for="code-context">рабочая копия</label>
          <UiSelect id="code-context" compact data-context="code-head-select"
                    :model-value="contextId" @change="selectContext">
            <template v-if="contextGroups.length > 1">
              <optgroup v-for="group in contextGroups" :key="group.repoKey" :label="group.repoKey">
                <option v-for="item in group.items" :key="item.id" :value="item.id" :title="item.treePath">
                  {{ item.label }}
                </option>
              </optgroup>
            </template>
            <template v-else>
              <option v-for="item in contexts" :key="item.id" :value="item.id" :title="item.treePath">
                {{ item.label }}
              </option>
            </template>
          </UiSelect>
        </div>
        <span v-else-if="headContext" class="tlabel mono"
              v-tooltip="context?.treePath">{{ headContext }}</span>
      </div>
      <span class="grow"></span>
      <!-- Переключатель навигатора — иконка без подписи, того же роста, что кнопки дока
           справа. Подпись с именем вкладки читалась второй вкладкой «Коммиты». -->
      <UiIconButton v-if="!codePanelNarrow" class="navigator-toggle" role="embedded"
                    data-context="tool-dock-navigator"
                    :pressed="!navigatorCollapsed" :aria-expanded="!navigatorCollapsed"
                    :label="navigatorToggleLabel" v-tooltip="navigatorToggleLabel"
                    @click="navigatorCollapsed = !navigatorCollapsed">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="2.5" y="3" width="15" height="14" rx="2" />
          <path d="M7 3v14" />
        </svg>
      </UiIconButton>
    </header>

    <!-- Холодный запуск сразу занимает финальную сетку. Без этого сначала был
         короткий пустой экран «Загрузка…», а затем вся рабочая область прыгала. -->
    <div v-if="loading" ref="layHost" class="lay code-loading"
         :class="layoutClasses"
         :style="compactStyle">
      <aside class="rail" aria-hidden="true">
        <span v-for="index in 3" :key="index" class="loading-rail-item"></span>
      </aside>
      <aside class="panel loading-panel" aria-hidden="true">
        <div class="loading-tree">
          <span v-for="index in 7" :key="index" class="loading-row"
                :style="{ '--loading-row': `${48 + ((index * 17) % 38)}%` }"></span>
        </div>
      </aside>
      <div v-if="!navigatorCollapsed" class="code-split loading-split" aria-hidden="true">
        <span></span>
      </div>
      <section class="editorwrap loading-editor" aria-hidden="true">
        <div class="ehead"><span class="loading-path"></span></div>
        <div class="ebody"><span class="loading-status">Загрузка кода…</span></div>
      </section>
    </div>
    <div v-else-if="!projects.length" class="empty">
      Проектов пока нет — заведи в разделе <router-link to="/projects">«Проекты»</router-link>.
    </div>

    <div v-else ref="layHost" class="lay" :class="layoutClasses"
         :style="compactStyle">
      <!-- Рейка разделов слева, как activity bar в VS Code: три небольшие кнопки вместо
           вкладок в шапке. Шапка остаётся контексту, а переключатель стоит на одном месте
           при любой ширине — в узкой раскладке он же возвращает навигатор поверх редактора. -->
      <aside class="rail" aria-label="Разделы кода">
        <UiIconButton class="rail-item" role="rail" data-context="code-rail-item" data-tab="files"
                      aria-controls="code-navigator" :pressed="mainTab === 'files'"
                      label="Файлы" v-tooltip="'Файлы: дерево и поиск по коду'"
                      @click="setMainTab('files')">
          <svg class="ic" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M6 3h8l4 4v14H6z M14 3v4h4" />
          </svg>
        </UiIconButton>
        <UiIconButton class="rail-item" role="rail" data-context="code-rail-item" data-tab="changes"
                      aria-controls="code-navigator" :pressed="mainTab === 'changes'"
                      :label="changesRailLabel" v-tooltip="changesRailLabel"
                      @click="setMainTab('changes')">
          <svg class="ic" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M6 3v12 M15 6a3 3 0 1 0 6 0 3 3 0 1 0-6 0 M3 18a3 3 0 1 0 6 0 3 3 0 1 0-6 0 M18 9a9 9 0 0 1-9 9" />
          </svg>
          <span v-if="changePathCount" class="rail-badge mono" aria-hidden="true">{{ changePathCount }}</span>
        </UiIconButton>
        <UiIconButton class="rail-item" role="rail" data-context="code-rail-item" data-tab="commits"
                      aria-controls="code-navigator" :pressed="mainTab === 'commits'"
                      label="Коммиты" v-tooltip="'Коммиты: журнал и отрезки ветки'"
                      @click="setMainTab('commits')">
          <svg class="ic" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 1 0 0-7 M2.5 12h6 M15.5 12h6" />
          </svg>
        </UiIconButton>
      </aside>

      <!-- Панель — только содержимое: дерево файлов либо изменения. Проект и рабочая
           копия выбираются в шапке раздела. -->
      <aside id="code-navigator" class="panel">
        <UiLoadingState v-if="contextLoading" label="Загружаю рабочую копию…" variant="inline" />

        <div v-if="error" class="perr">{{ error }}</div>
        <div v-if="!projectHasRepos" class="pnote">
          Пути репозиториев не заданы — раздел <router-link to="/projects">«Проекты»</router-link>.
        </div>
        <div v-if="unavailableRepos.length" class="pnote context-warning">
          <span>Недоступные репозитории:</span>
          <span v-for="item in unavailableRepos" :key="item.repoKey" class="unavailable-repo mono">
            {{ item.repoKey }} — {{ item.repoDir }}
          </span>
          Проверь пути в разделе <router-link to="/projects">«Проекты»</router-link>.
        </div>

        <div v-if="!fileHistoryActive && tab === 'files'" class="code-search">
          <UiSearchInput
            v-model="searchQuery"
            data-action="code-search"
            placeholder="Поиск по коду"
            aria-label="Поиск по коду"
            @keydown.enter.prevent="openFirstSearchResult"
          />
        </div>

        <!-- Композер относится к изменениям, но живёт внизу панели: дерево получает
             высоту первым, а пустой индекс больше не отнимает четверть экрана. -->
        <div v-if="!fileHistoryActive && tab === 'git' && gitPane === 'changes' && git"
             class="git-footer">
          <div class="git-compose" :class="{ open: commitComposerOpen, amend: amendCommit }">
            <div class="git-compose-head">
              <UiPressable class="commit-disclosure" data-context="code-commit-disclosure"
                           data-action="commit-disclosure" :aria-expanded="commitComposerOpen"
                           @click="toggleCommitComposer">
                <span class="git-compose-title">{{ commitComposerTitle }}</span>
                <span class="git-index-state" :class="{ empty: !git.staged.length }">
                  {{ commitIndexLabel }}
                </span>
                <span class="commit-chevron" aria-hidden="true">
                  {{ commitComposerOpen ? '▾' : '▸' }}
                </span>
              </UiPressable>
              <UiPopover v-if="commitComposerOpen" has-popup="dialog" placement="top-end"
                         :style="{ width: 'min(300px, calc(100vw - 20px))' }">
                <template #trigger>
                  <UiIconButton role="embedded" data-context="code-commit"
                                data-action="commit-more" label="Дополнительные действия коммита"
                                v-tooltip="'Дополнительные действия коммита'">
                    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                      <circle cx="3" cy="8" r="1.15" />
                      <circle cx="8" cy="8" r="1.15" />
                      <circle cx="13" cy="8" r="1.15" />
                    </svg>
                  </UiIconButton>
                </template>
                <template #default="{ close }">
                  <div class="code-popover-panel commit-more-panel">
                    <strong class="code-popover-title">Действия коммита</strong>
                    <UiSwitch v-model="amendCommit" class="amend-toggle"
                              data-context="code-commit-amend" data-action="amend"
                              :disabled="gitActionBusy || !amendAvailable"
                              v-tooltip="amendTitle"
                              :aria-description="amendTitle"
                              @change="changeAmend">
                      Дополнить последний коммит
                    </UiSwitch>
                    <UiButton block variant="ghost" data-context="code-popover-action"
                              data-action="undo-commit" :loading="gitBusy === 'undo'"
                              :disabled="gitActionBusy || !undoAvailable" v-tooltip="undoTitle"
                              @click="undoGitCommit(); close('action')">
                      Отменить последний коммит
                    </UiButton>
                  </div>
                </template>
              </UiPopover>
            </div>
            <p v-if="!commitComposerOpen" class="commit-empty-hint">
              {{ commitComposerHint }}
            </p>
            <div v-else class="git-compose-body">
              <div v-if="amendCommit" class="amend-active-row">
                <span>Последний локальный коммит будет изменён.</span>
                <UiButton variant="ghost" data-context="code-commit"
                          data-action="leave-amend" @click="leaveAmend">
                  Выйти из amend
                </UiButton>
              </div>
              <!-- `rows="1"` оставляет поле компактным, но сохраняет многострочное сообщение. -->
              <UiTextarea
                v-model="commitMessage"
                class="commit-message"
                data-context="code-commit"
                rows="1"
                maxlength="5000"
                placeholder="Сообщение коммита"
                aria-label="Сообщение коммита"
                :disabled="gitActionBusy"
                @keydown.enter="commitOnShortcut"
              />
              <div class="git-compose-actions">
                <UiIconButton
                  class="generate-commit"
                  role="embedded"
                  data-context="code-commit"
                  label="Составить сообщение по staged diff"
                  v-tooltip="'Составить сообщение по staged diff'"
                  :loading="gitBusy === 'generate'"
                  :disabled="gitActionBusy || !git.staged.length"
                  @click="generateCommitMessage"
                >
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35"
                       stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="m8 1.5 1.1 3.4L12.5 6 9.1 7.1 8 10.5 6.9 7.1 3.5 6l3.4-1.1z" />
                    <path d="m13 10 .55 1.45L15 12l-1.45.55L13 14l-.55-1.45L11 12l1.45-.55z" />
                  </svg>
                </UiIconButton>
                <UiButton
                  class="commit-action"
                  data-context="code-commit"
                  variant="solid"
                  tone="accent"
                  :loading="gitBusy === 'commit'"
                  :disabled="gitActionBusy || (!amendCommit && !git.staged.length)
                    || !commitMessage.trim()"
                  @click="commitGitChanges"
                >{{ amendCommit ? 'Дополнить коммит' : 'Создать коммит' }}</UiButton>
              </div>
            </div>
          </div>
          <div class="git-sync-row">
            <UiInlineMessage v-if="gitNotice" class="git-notice"
                             data-context="code-git-notice"
                             :tone="gitNotice.type === 'err' ? 'danger' : 'success'">
              {{ gitNotice.text }}
            </UiInlineMessage>
            <p v-else-if="trackingNote" class="git-notice git-tracking-note"
               :class="trackingNote.type"
               v-tooltip="trackingNote.hint">
              {{ trackingNote.text }}
            </p>
            <span v-else class="grow"></span>
            <div class="git-remote-actions" role="group" aria-label="Синхронизация с remote">
              <UiIconButton
                class="fetch-action"
                role="embedded"
                data-context="code-commit"
                data-action="fetch"
                label="Проверить удалённый репозиторий"
                v-tooltip="'Проверить удалённый репозиторий'"
                :loading="gitBusy === 'fetch'"
                :disabled="gitActionBusy || !fetchRemoteLabel"
                @click="fetchGitRemote"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"
                     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M8 2v8M4.8 7.4 8 10.6l3.2-3.2M3 13.5h10" />
                </svg>
              </UiIconButton>
              <UiIconButton
                class="push-action"
                role="embedded"
                data-context="code-commit"
                :label="pushLabel"
                :loading="gitBusy === 'push'"
                :disabled="gitActionBusy || git.tracking?.detached"
                v-tooltip="pushTitle"
                @click="pushGitChanges"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"
                     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M8 11V3M4.8 6.2 8 3l3.2 3.2M3 13.5h10" />
                </svg>
              </UiIconButton>
            </div>
          </div>
        </div>

        <div v-if="fileHistoryActive" class="scroll tree file-history">
          <div class="subhead file-history-head">
            <UiIconButton role="embedded" data-context="code-group-action"
                          data-action="close-file-history" label="Вернуться"
                          v-tooltip="'Вернуться к дереву'" @click="closeFileHistory()">←</UiIconButton>
            <span class="subtitle">История</span>
            <span class="grow"></span>
            <span class="cnt mono">{{ fileHistoryEntries.length }}</span>
          </div>
          <div class="history-path mono" v-tooltip="fileHistoryPath">{{ fileHistoryPath }}</div>
          <UiLoadingState v-if="fileHistoryLoading" label="Читаю историю…" >
            <UiSkeletonLayout layout="list" :header="false" />
          </UiLoadingState>
          <div v-else-if="fileHistoryError" class="perr">{{ fileHistoryError }}</div>
          <div v-else-if="!fileHistoryEntries.length" class="pnote">История файла пуста.</div>
          <UiPressable v-for="entry in fileHistoryEntries" :key="entry.hash"
                       class="commit file-history-entry" data-context="code-commit-row"
                       :data-hash="entry.hash" :class="{ sel: fileHistorySelected === entry.hash }"
                       :pressed="fileHistorySelected === entry.hash" v-tooltip="entry.when"
                       @click="openFileHistoryEntry(entry)">
            <span class="hash mono">{{ entry.hash.slice(0, 7) }}</span>
            <span class="subj">{{ entry.subject }}</span>
            <span v-if="entry.path !== fileHistoryPath" class="history-old-path mono">
              {{ entry.path }}
            </span>
          </UiPressable>
        </div>

        <div v-else-if="tab === 'files' && searchActive"
             class="scroll tree code-search-results">
          <UiLoadingState v-if="searchLoading" label="Ищу…" variant="inline" />
          <div v-else-if="searchError" class="perr">{{ searchError }}</div>
          <template v-else>
            <template v-if="searchResult?.files.length">
              <div class="subhead search-result-head">
                <span class="subtitle">Файлы</span>
                <span class="cnt mono">{{ searchResult.files.length }}</span>
              </div>
              <UiPressable v-for="file in searchResult.files" :key="`file:${file.path}`"
                           class="trow search-result" data-search-kind="file"
                           :data-search-path="file.path" v-tooltip="file.path"
                           @click="openSearchResult(file.path, 1)">
                <span class="search-file mono">{{ file.path }}</span>
              </UiPressable>
            </template>
            <template v-if="searchResult?.matches.length">
              <div class="subhead search-result-head">
                <span class="subtitle">Совпадения</span>
                <span class="cnt mono">{{ searchResult.matches.length }}</span>
              </div>
              <UiPressable
                v-for="(match, index) in searchResult.matches"
                :key="`match:${match.path}:${match.line}:${index}`"
                class="trow search-result search-match"
                data-search-kind="match"
                :data-search-path="match.path"
                :data-search-line="match.line"
                v-tooltip="`${match.path}:${match.line}`"
                @click="openSearchResult(match.path, match.line)"
              >
                <span class="search-location mono">{{ match.path }}:{{ match.line }}</span>
                <span class="search-text mono">{{ match.text }}</span>
              </UiPressable>
            </template>
            <div v-if="searchResult && !searchResult.files.length && !searchResult.matches.length"
                 class="pnote">Ничего не найдено.</div>
            <div v-if="searchResult?.truncated" class="pnote search-truncated">
              Показаны первые 500 совпадений.
            </div>
          </template>
        </div>

        <!-- Дерево файлов. Место под шеврон занято и у файла (пустой .chev): без него
             имя файла уезжало влево на ширину стрелки и вставало вровень с каталогом
             уровнем выше — лесенка читалась рваной. Каталог на тысячи файлов рисуется
             окном VirtualRows: целиком он замораживал панель. -->
        <div v-else-if="tab === 'files'" class="scroll tree file-tree">
          <p v-if="!rows.length && !contextLoading && !error" class="pnote">
            {{ context ? 'В этой рабочей копии пока нет файлов.' : 'Выберите рабочую копию репозитория.' }}
          </p>
          <VirtualRows v-slot="{ item: row }" :items="rows" :item-key="fileRowKey">
            <UiPressable v-if="row.dir" class="trow dir" data-context="code-tree-row"
                         :data-dir-path="row.rel" :data-depth="row.depth"
                         v-tooltip="fileTreeDecorations.directories.has(row.rel)
                           ? 'В каталоге есть изменения' : undefined"
                         :aria-expanded="openDirs.has(row.rel)" :style="rowDepth(row.depth)"
                         @click="toggleDir(row.rel)">
              <span class="chev">{{ openDirs.has(row.rel) ? '▾' : '▸' }}</span>
              <span class="dname">{{ row.name }}</span>
              <span v-if="fileTreeDecorations.directories.has(row.rel)"
                    class="git-dir-dot" aria-hidden="true">•</span>
              <span v-if="fileTreeDecorations.directories.has(row.rel)" class="ui-visually-hidden">
                — внутри есть изменения
              </span>
            </UiPressable>
            <UiPressable v-else class="trow frow" data-context="code-tree-row"
                         :class="{ sel: fileSel === row.rel }"
                         :pressed="fileSel === row.rel" :data-file-path="row.rel" :data-depth="row.depth"
                         :data-status="fileTreeDecorations.files.get(row.rel)"
                         v-tooltip="fileTreeDecorations.files.get(row.rel) === 'U'
                           ? CONFLICT_HINT : undefined"
                         :style="rowDepth(row.depth)" @click="openFile(row.rel)">
              <span class="chev" aria-hidden="true"></span>
              <span v-if="fileTreeDecorations.files.get(row.rel)" class="st"
                    :class="fileTreeDecorations.files.get(row.rel)">
                {{ STLABEL[fileTreeDecorations.files.get(row.rel) || '']
                  || fileTreeDecorations.files.get(row.rel) }}
              </span>
              <span class="nm" :class="fileTreeDecorations.files.get(row.rel)">{{ row.name }}</span>
            </UiPressable>
          </VirtualRows>
        </div>

        <!-- Git разделён на две вкладки: рабочие группы больше не выталкивают журнал
             коммитов за нижнюю границу навигатора. -->
        <div v-else-if="tab === 'git'" class="git-panel" :class="`${gitPane}-pane`">
          <div v-if="git && gitPane === 'changes'" class="git-panel-toolbar">
            <span class="git-panel-label">Файлы изменений</span>
            <span class="grow"></span>
            <div class="git-view-toggle" role="group" aria-label="Вид изменений">
              <UiIconButton class="git-view-action" role="embedded"
                            data-context="code-group-action" data-view="tree"
                            v-tooltip="'Показать деревом'" label="Показать деревом"
                            :pressed="gitView === 'tree'" @click="setGitView('tree')">
                <svg aria-hidden="true" viewBox="0 0 16 16">
                  <path d="M2 2.5h4v3H2zM6 4h3v1H6zM8 4h1v7H8zM8 7h2v1H8zM8 10h2v1H8zM10 6.5h4v3h-4zM10 9.5h4v3h-4z" />
                </svg>
              </UiIconButton>
              <UiIconButton class="git-view-action" role="embedded"
                            data-context="code-group-action" data-view="list"
                            v-tooltip="'Показать списком'" label="Показать списком"
                            :pressed="gitView === 'list'" @click="setGitView('list')">
                <svg aria-hidden="true" viewBox="0 0 16 16">
                  <path d="M2 3h2v2H2zM5 3h9v2H5zM2 7h2v2H2zM5 7h9v2H5zM2 11h2v2H2zM5 11h9v2H5z" />
                </svg>
              </UiIconButton>
            </div>
          </div>
          <div class="scroll tree git-tree" :class="{ 'commit-tree': gitPane === 'commits' }">
            <UiLoadingState v-if="gitLoading && !git" label="Читаю гит…" >
              <UiSkeletonLayout layout="list" :header="false" />
            </UiLoadingState>
            <template v-if="git">
              <div v-if="gitPane === 'changes' && !changeGroups.length"
                   class="git-clean" role="status">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"
                     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="m3.2 8.2 3 3L12.9 4.5" />
                </svg>
                <span>Рабочая копия чистая</span>
              </div>
              <section v-if="gitPane === 'commits'" class="commit-log-section">
                <div class="subhead commits-head">
                  <span class="subtitle">История ветки</span>
                  <span v-if="commitSel.size" class="cnt mono">{{ commitSel.size }}</span>
                  <span class="grow"></span>
                  <!-- Подпись режима совпадает с хвостом заголовка отрезка «… + текущие»:
                       одно слово в двух местах, а не два разных. Сброс отрезка живёт в его
                       сводке ниже, в шапке журнала третьей кнопки нет. -->
                  <UiButton variant="ghost" data-context="code-group-action"
                            data-action="commits-with-work"
                            v-tooltip="commitsWorkTitle" :pressed="commitsWorkActive"
                            :aria-disabled="!commitsWorkAvailable"
                            @click="toggleCommitsWork">+ текущие</UiButton>
                  <UiIconButton role="embedded" data-context="code-group-action"
                                data-action="branch-diff" label="Показать всю ветку"
                                v-tooltip="branchDiffAvailability.title"
                                :pressed="branchMode" :loading="commitsLoading && branchMode"
                                :disabled="!branchDiffAvailability.enabled"
                                @click="toggleBranchDiff">
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35"
                         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <circle cx="4" cy="3" r="1.5" />
                      <circle cx="4" cy="13" r="1.5" />
                      <circle cx="12" cy="5" r="1.5" />
                      <path d="M4 4.5v7M5.5 10.5C9 10.2 10.5 8.4 10.5 6.4" />
                    </svg>
                  </UiIconButton>
                </div>
                <UiLoadingState v-if="commitsLoading" label="Читаю коммиты…" >
                  <UiSkeletonLayout layout="list" :header="false" />
                </UiLoadingState>
                <div v-else-if="commitsError" class="perr commits-state">{{ commitsError }}</div>
                <div class="commit-log">
                  <UiPressable v-for="c in git.log" :key="c.hash" class="commit"
                               data-context="code-commit-row" :data-hash="c.hash"
                               :class="{ sel: commitSel.has(c.hash) }"
                               :pressed="commitSel.has(c.hash)" v-tooltip="c.when"
                               @click="pickCommit(c, $event)">
                    <span class="hash mono">{{ c.hash }}</span>
                    <span class="subj">{{ c.subject }}</span>
                  </UiPressable>
                </div>
              </section>
              <section v-for="group in visibleGitGroups" :key="group.id" class="git-group"
                       :data-group-section="group.id">
              <!-- Сводка отрезка — заголовок группы его файлов в две строки: сам отрезок с
                   действиями и итог во всю ширину. Она липнет к верху списка, так что сброс не
                   прячется за длинным деревом, а журнал над ней остаётся местом выбора. -->
              <div v-if="group.id === 'commits'" class="subhead commit-range-summary"
                   :data-group="group.id">
                <span class="subtitle" v-tooltip="group.hint">{{ group.title }}</span>
                <UiIconButton
                  class="git-group-action"
                  role="embedded"
                  data-context="code-group-action"
                  data-action="patch-review"
                  :data-group="group.id"
                  :label="`Обзор группы «${group.title}»`"
                  v-tooltip="'Показать все изменения одной страницей'"
                  :pressed="patchReviewActive && patchReviewGroupId === group.id"
                  :loading="patchLoading && patchReviewGroupId === group.id"
                  :disabled="!group.files.length"
                  @click="openPatchReview(group)"
                >
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"
                       stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M2.5 2.5h11v11h-11zM5 5h6M5 8h6M5 11h4" />
                  </svg>
                </UiIconButton>
                <UiIconButton
                  class="git-group-action"
                  role="embedded"
                  data-context="code-group-action"
                  data-action="clear-commits"
                  label="Снять выбор коммитов"
                  v-tooltip="'Сбросить отрезок и вернуться к журналу'"
                  @click="clearCommitSelection"
                >
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"
                       stroke-linecap="round" aria-hidden="true">
                    <path d="m4 4 8 8M12 4l-8 8" />
                  </svg>
                </UiIconButton>
                <span class="commit-range-meta">
                  <span class="cnt mono">{{ fileCountLabel(group.files.length) }}</span>
                  <span v-if="group.stat.total" class="diffstat mono"
                        v-tooltip="gitStatTitle(group.stat)">
                    <i v-if="group.stat.add" class="a">+{{ group.stat.add }}</i>
                    <i v-if="group.stat.del" class="d">−{{ group.stat.del }}</i>
                  </span>
                  <span v-if="group.note" class="group-note" v-tooltip="group.note">
                    {{ group.note }}
                  </span>
                </span>
              </div>
              <div v-else class="subhead" :data-group="group.id">
                <!-- Заголовок сворачивает дерево группы: до списка коммитов не нужно прокручивать
                     все правки. Счётчик и итог остаются — свёрнуто не значит пусто. -->
                <UiPressable class="group-toggle" data-context="code-group-toggle"
                             data-action="toggle-group"
                             :aria-expanded="!collapsedGroups.has(group.id)"
                             v-tooltip="group.hint" @click="toggleGroupCollapsed(group.id)">
                  <span class="subtitle">{{ group.title }}</span>
                </UiPressable>
                <span v-if="group.files.length" class="cnt mono">{{ group.files.length }}</span>
                <!-- Итог группы, как сводка pull request на GitHub: сумма строк по всем файлам
                     и полоска из пяти квадратиков. Без строк (бинарные файлы, чистое дерево)
                     итога нет, чтобы не рисовать «+0». -->
                <span v-if="group.stat.total" class="diffstat mono" v-tooltip="gitStatTitle(group.stat)">
                  <i v-if="group.stat.add" class="a">+{{ group.stat.add }}</i>
                  <i v-if="group.stat.del" class="d">−{{ group.stat.del }}</i>
                  <span class="bar" aria-hidden="true">
                    <i v-for="(block, index) in group.stat.blocks" :key="index" :class="block"></i>
                  </span>
                </span>
                <span class="grow"></span>
                <UiIconButton
                  class="git-group-action"
                  role="embedded"
                  data-context="code-group-action"
                  data-action="patch-review"
                  :data-group="group.id"
                  :label="`Обзор группы «${group.title}»`"
                  v-tooltip="'Показать все изменения одной страницей'"
                  :pressed="patchReviewActive && patchReviewGroupId === group.id"
                  :loading="patchLoading && patchReviewGroupId === group.id"
                  :disabled="!group.files.length"
                  @click="openPatchReview(group)"
                >
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"
                       stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M2.5 2.5h11v11h-11zM5 5h6M5 8h6M5 11h4" />
                  </svg>
                </UiIconButton>
                <UiPopover v-if="group.id === 'work' && discardableGitCount(group)"
                           has-popup="menu" placement="bottom-end"
                           :style="{ width: 'min(250px, calc(100vw - 20px))' }">
                  <template #trigger>
                    <UiIconButton class="git-group-action" role="embedded"
                                  data-context="code-group-action" data-action="group-more"
                                  label="Действия группы" v-tooltip="'Действия группы'">
                      <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                        <circle cx="3" cy="8" r="1.15" />
                        <circle cx="8" cy="8" r="1.15" />
                        <circle cx="13" cy="8" r="1.15" />
                      </svg>
                    </UiIconButton>
                  </template>
                  <template #default="{ close }">
                    <UiButton block variant="ghost" tone="danger"
                              data-context="code-popover-action" data-action="discard-all"
                              :loading="gitBusy === 'discard:all'" :disabled="gitActionBusy"
                              @click="discardGitGroup(group); close('action')">
                      Откатить все tracked-правки
                    </UiButton>
                  </template>
                </UiPopover>
                <UiIconButton
                  v-if="group.mutable && group.files.length"
                  class="git-group-action"
                  role="embedded"
                  data-context="code-group-action"
                  :data-action="group.id === 'staged' ? 'unstage-all' : 'stage-all'"
                  :label="gitGroupActionLabel(group.id)"
                  v-tooltip="gitGroupActionLabel(group.id)"
                  :loading="gitBusy === gitGroupActionKey(group.id)"
                  :disabled="gitActionBusy"
                  @click="changeGitGroup(group)"
                >{{ group.id === 'staged' ? '−' : '+' }}</UiIconButton>
              </div>
              <div v-if="!group.files.length" class="pnote">
                {{ group.id === 'commits' ? 'В выбранных коммитах нет изменений файлов.' : 'Несохранённых изменений нет.' }}
              </div>
              <template v-else-if="gitPane === 'changes' && collapsedGroups.has(group.id)"></template>
              <!-- Группа бывает на тысячи файлов (новый репозиторий целиком в индексе):
                   и дерево, и список рисуются окном VirtualRows, а не всеми строками. -->
              <template v-else-if="gitView === 'tree'">
                <VirtualRows v-slot="{ item: row }" :items="group.rows" :item-key="gitRowKey">
                  <!-- Каталог: та же обойма, что у файла — в индекс уходят все файлы группы
                       под ним. Граница по «/», чтобы src не захватил src-other. -->
                  <div v-if="row.kind === 'dir'" class="git-file-line git-dir-line"
                       data-ui-row="code-change" :data-dir="row.path" :data-group="group.id">
                    <UiPressable class="trow dir git-row git-dir"
                                 data-context="code-tree-row"
                                 :data-path="row.path" :data-group="group.id" :data-depth="row.depth"
                                 :aria-expanded="gitOpenDirs.has(row.ref)"
                                 :style="rowDepth(row.depth)" @click="toggleGitDir(row.ref)">
                      <span class="chev">{{ gitOpenDirs.has(row.ref) ? '▾' : '▸' }}</span>
                      <span class="dname" v-tooltip="row.path">{{ row.name }}</span>
                    </UiPressable>
                    <span v-if="group.mutable" class="git-row-actions">
                      <UiIconButton
                        class="git-file-action"
                        role="embedded"
                        data-context="code-row-action"
                        :data-action="group.id === 'staged' ? 'unstage-dir' : 'stage-dir'"
                        :data-dir="row.path"
                        :label="gitDirActionLabel(group, row.path)"
                        v-tooltip="gitDirActionLabel(group, row.path)"
                        :loading="gitBusy === gitDirActionKey(group.id, row.path)"
                        :disabled="gitActionBusy"
                        @click="changeGitDir(group, row.path)"
                      >{{ group.id === 'staged' ? '−' : '+' }}</UiIconButton>
                    </span>
                  </div>
                  <div v-else class="git-file-line" data-ui-row="code-change">
                    <UiPressable class="trow frow git-row git-file"
                                 data-context="code-tree-row"
                                 :class="{ sel: gitSel === row.ref }" :pressed="gitSel === row.ref"
                                 :data-path="row.path" :data-group="group.id" :data-depth="row.depth"
                                 v-tooltip="gitFileHint(row.file)"
                                 :style="rowDepth(row.depth)" @click="selectGit(row.ref)">
                      <span class="chev" aria-hidden="true"></span>
                      <span class="st" :class="row.file.status">
                        {{ STLABEL[row.file.status] || row.file.status }}
                      </span>
                      <span class="nm mono" v-tooltip="row.path">{{ row.name }}</span>
                      <span class="cnt mono">
                        <i v-if="row.file.add" class="a">+{{ row.file.add }}</i>
                        <i v-if="row.file.del" class="d">−{{ row.file.del }}</i>
                      </span>
                    </UiPressable>
                    <!-- Обойма действий строки: к правому краю прижата она одна, а не каждая кнопка —
                         иначе «Откатить» и «+» ложились в одну точку. -->
                    <span class="git-row-actions">
                      <UiPopover v-if="group.id === 'work' && row.file.status !== 'U'"
                                 has-popup="menu" placement="bottom-end"
                                 :style="{ width: 'min(240px, calc(100vw - 20px))' }">
                        <template #trigger>
                          <UiIconButton class="git-file-action" role="embedded"
                                        data-context="code-row-action" data-action="row-more"
                                        :data-file="row.path" label="Действия с файлом"
                                        v-tooltip="`Действия с ${row.path}`">
                            <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                              <circle cx="3" cy="8" r="1.15" />
                              <circle cx="8" cy="8" r="1.15" />
                              <circle cx="13" cy="8" r="1.15" />
                            </svg>
                          </UiIconButton>
                        </template>
                        <template #default="{ close }">
                          <UiButton block variant="ghost" tone="danger"
                                    data-context="code-popover-action"
                                    :data-group="group.id"
                                    :data-action="row.file.status === 'A' ? 'clean' : 'discard'"
                                    :data-file="row.path" :loading="gitBusy === discardGitFileKey(row.file)"
                                    :disabled="gitActionBusy"
                                    @click="discardGitFile(group, row.file); close('action')">
                            {{ discardGitFileLabel(row.file) }}
                          </UiButton>
                        </template>
                      </UiPopover>
                      <UiIconButton
                        v-if="group.mutable"
                        class="git-file-action"
                        role="embedded"
                        data-context="code-row-action"
                        :data-action="group.id === 'staged' ? 'unstage' : 'stage'"
                        :data-file="row.path"
                        :label="gitFileActionLabel(group.id, row.file)"
                        v-tooltip="gitFileActionLabel(group.id, row.file)"
                        :loading="gitBusy === gitFileActionKey(group.id, row.path)"
                        :disabled="gitActionBusy"
                        @click="changeGitFile(group, row.file)"
                      >{{ group.id === 'staged' ? '−' : '+' }}</UiIconButton>
                    </span>
                  </div>
                </VirtualRows>
              </template>
              <!-- Плоский список: сначала имя файла, каталог — приглушённым хвостом.
                   Целый путь обрезался с конца, то есть съедал именно имя. -->
              <template v-else>
                <VirtualRows v-slot="{ item: entry }" :items="group.list" :item-key="gitListKey">
                  <div class="git-file-line" data-ui-row="code-change">
                    <UiPressable class="trow frow git-row git-file"
                                 data-context="code-tree-row"
                                 :class="{ sel: gitSel === gitRef(group.id, entry.file.path) }"
                                 :pressed="gitSel === gitRef(group.id, entry.file.path)"
                                 :data-path="entry.file.path" :data-group="group.id"
                                 v-tooltip="gitFileHint(entry.file)"
                                 @click="selectGit(gitRef(group.id, entry.file.path))">
                      <span class="st" :class="entry.file.status">
                        {{ STLABEL[entry.file.status] || entry.file.status }}
                      </span>
                      <span class="nm split mono" v-tooltip="entry.file.path">
                        <b class="nm-base">{{ entry.name }}</b>
                        <i v-if="entry.dir" class="nm-dir">{{ entry.dir }}</i>
                      </span>
                      <span class="cnt mono">
                        <i v-if="entry.file.add" class="a">+{{ entry.file.add }}</i>
                        <i v-if="entry.file.del" class="d">−{{ entry.file.del }}</i>
                      </span>
                    </UiPressable>
                    <!-- Обойма действий строки: к правому краю прижата она одна, а не каждая кнопка —
                         иначе «Откатить» и «+» ложились в одну точку. -->
                    <span class="git-row-actions">
                      <UiPopover v-if="group.id === 'work' && entry.file.status !== 'U'"
                                 has-popup="menu" placement="bottom-end"
                                 :style="{ width: 'min(240px, calc(100vw - 20px))' }">
                        <template #trigger>
                          <UiIconButton class="git-file-action" role="embedded"
                                        data-context="code-row-action" data-action="row-more"
                                        :data-file="entry.file.path" label="Действия с файлом"
                                        v-tooltip="`Действия с ${entry.file.path}`">
                            <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                              <circle cx="3" cy="8" r="1.15" />
                              <circle cx="8" cy="8" r="1.15" />
                              <circle cx="13" cy="8" r="1.15" />
                            </svg>
                          </UiIconButton>
                        </template>
                        <template #default="{ close }">
                          <UiButton block variant="ghost" tone="danger"
                                    data-context="code-popover-action" :data-group="group.id"
                                    :data-action="entry.file.status === 'A' ? 'clean' : 'discard'"
                                    :data-file="entry.file.path"
                                    :loading="gitBusy === discardGitFileKey(entry.file)"
                                    :disabled="gitActionBusy"
                                    @click="discardGitFile(group, entry.file); close('action')">
                            {{ discardGitFileLabel(entry.file) }}
                          </UiButton>
                        </template>
                      </UiPopover>
                      <UiIconButton
                        v-if="group.mutable"
                        class="git-file-action"
                        role="embedded"
                        data-context="code-row-action"
                        :data-action="group.id === 'staged' ? 'unstage' : 'stage'"
                        :data-file="entry.file.path"
                        :label="gitFileActionLabel(group.id, entry.file)"
                        v-tooltip="gitFileActionLabel(group.id, entry.file)"
                        :loading="gitBusy === gitFileActionKey(group.id, entry.file.path)"
                        :disabled="gitActionBusy"
                        @click="changeGitFile(group, entry.file)"
                      >{{ group.id === 'staged' ? '−' : '+' }}</UiIconButton>
                    </span>
                  </div>
                </VirtualRows>
              </template>
            </section>
            </template>
          </div>
        </div>
      </aside>

      <div v-if="!navigatorCollapsed" class="code-split" role="separator"
           aria-orientation="vertical" tabindex="0"
           :aria-valuemin="NAVIGATOR_MIN_WIDTH" :aria-valuemax="Math.round(navigatorMaxWidth)"
           :aria-valuenow="Math.round(navigatorWidth)"
           @pointerdown.prevent="startNavigatorResize" @pointermove.prevent="moveNavigatorResize"
           @pointerup.prevent="finishNavigatorResize" @pointercancel.prevent="finishNavigatorResize"
           @keydown="navigatorResizeKey">
        <span aria-hidden="true"></span>
      </div>

      <!-- Просмотр: файл или диф -->
      <section ref="editorHost" class="editorwrap">
        <header class="editor-header">
        <div class="ehead file-head-row">
          <UiIconButton v-if="codePanelNarrow && narrowPane === 'editor'" role="embedded"
                        data-context="code-editor-action" data-action="back-to-navigator"
                        :label="narrowBackLabel" v-tooltip="narrowBackLabel"
                        @click="showNarrowNavigator">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"
                 stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="m9.5 3-5 5 5 5" />
            </svg>
          </UiIconButton>
          <div class="editor-identity">
            <template v-if="fileHistoryActive">
              <span v-if="fileHistoryDiff" class="st" :class="fileHistoryDiff.status">
                {{ STLABEL[fileHistoryDiff.status] || fileHistoryDiff.status }}
              </span>
              <span class="epath mono" v-tooltip="fileHistoryDiff?.path || fileHistoryPath">
                <i v-if="headPath(fileHistoryDiff?.path || fileHistoryPath).dir" class="epath-dir">
                  {{ headPath(fileHistoryDiff?.path || fileHistoryPath).dir }}/
                </i><!-- -->
                <b class="epath-name">{{ headPath(fileHistoryDiff?.path || fileHistoryPath).name }}</b>
              </span>
              <span v-if="fileHistoryDiffLoading" class="note">читаю diff…</span>
              <span v-else-if="fileHistoryDiffError" class="note diff-error">
                {{ fileHistoryDiffError }}
              </span>
            </template>
            <template v-else-if="tab === 'files' && fileSel">
              <span class="epath mono" v-tooltip="fileSel">
                <i v-if="headPath(fileSel).dir" class="epath-dir">{{ headPath(fileSel).dir }}/</i><!-- -->
                <b class="epath-name">{{ headPath(fileSel).name }}</b>
              </span>
              <span v-if="showsImage" class="note img-note">изображение</span>
              <span v-else-if="fileData?.binary" class="note">бинарный</span>
              <span v-else-if="fileData?.tooBig" class="note">
                слишком большой — превью отключено
              </span>
              <span v-if="fileLoading" class="note">читаю…</span>
              <span v-else-if="blameLoading" class="note">считаю blame…</span>
              <span v-else-if="blameError" class="note diff-error">{{ blameError }}</span>
            </template>
            <template v-else-if="tab === 'git' && patchReviewActive">
              <span class="epath review-title" v-tooltip="patchReviewGroup?.title">
                Обзор · {{ patchReviewGroup?.title }}
              </span>
              <span v-if="patchReviewGroup" class="note mono range-summary">
                {{ fileCountLabel(patchReviewGroup.files.length) }},
                +{{ patchReviewGroup.stat.add }} −{{ patchReviewGroup.stat.del }}
              </span>
              <span v-if="patchLoading" class="note">читаю патч…</span>
              <span v-else-if="patchError" class="note diff-error">{{ patchError }}</span>
            </template>
            <template v-else-if="tab === 'git' && gitFile">
              <span class="st" :class="gitFile.status">
                {{ STLABEL[gitFile.status] || gitFile.status }}
              </span>
              <span class="epath mono" v-tooltip="gitFile.path">
                <i v-if="headPath(gitFile.path).dir" class="epath-dir">
                  {{ headPath(gitFile.path).dir }}/
                </i><!-- -->
                <b class="epath-name">{{ headPath(gitFile.path).name }}</b>
              </span>
              <span v-if="gitFile.binary" class="note">бинарный</span>
              <span v-else-if="gitFile.tooBig" class="note">
                слишком большой — превью отключено
              </span>
            </template>
          </div>
          <span v-if="tab === 'files' && fileSel && !fileHistoryActive"
                class="file-view-state">Просмотр</span>
          <span class="grow"></span>
          <div class="file-head-actions" role="group" aria-label="Действия файла">
              <UiButton v-if="tab === 'git' && patchReviewActive" variant="ghost"
                        data-context="code-editor-action" data-action="close-patch-review"
                        v-tooltip="'Вернуться к файлу'" @click="closePatchReview">
                <svg class="glyph" aria-hidden="true" viewBox="0 0 16 16" fill="none"
                     stroke="currentColor" stroke-width="1.45" stroke-linecap="round"
                     stroke-linejoin="round">
                  <path d="m7 3-5 5 5 5M2 8h12" />
                </svg>
                <span class="label">К файлу</span>
              </UiButton>
              <UiButton v-if="canShowFileHistory && !editorNarrowActions" variant="ghost"
                        data-context="code-editor-action" data-action="file-history"
                        v-tooltip="'Показать историю файла'" @click="openFileHistory">
                <svg class="glyph" aria-hidden="true" viewBox="0 0 16 16">
                  <path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zm0 1.3a5.2 5.2 0 1 1 0 10.4 5.2 5.2 0 0 1 0-10.4zM7.4 4h1.2v4.2l2.9 1.7-.6 1-3.5-2.1z" />
                </svg>
                <span class="label">История</span>
              </UiButton>
              <UiButton v-if="canAskAgent && !editorNarrowActions" variant="ghost"
                        data-context="code-editor-action"
                        data-action="ask-agent" :loading="askAgentBusy" :disabled="askAgentBusy"
                        v-tooltip="'Создать чат с черновиком вопроса'" @click="askAgentAboutCode">
                <svg class="glyph" aria-hidden="true" viewBox="0 0 16 16">
                  <path d="M2 2.5h12v8.5H6.2L3 13.6V11H2z" />
                </svg>
                <span class="label">Спросить агента</span>
              </UiButton>
              <UiPopover v-if="canShowFileMenu" has-popup="dialog" placement="bottom-end"
                         :style="{ width: 'min(300px, calc(100vw - 20px))' }">
                <template #trigger>
                  <UiIconButton role="embedded" data-context="code-editor-action"
                                data-action="file-actions" label="Действия файла"
                                v-tooltip="'Действия файла'">
                    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                      <circle cx="3" cy="8" r="1.15" />
                      <circle cx="8" cy="8" r="1.15" />
                      <circle cx="13" cy="8" r="1.15" />
                    </svg>
                  </UiIconButton>
                </template>
                <template #default="{ close }">
                  <div class="code-popover-panel">
                    <strong class="code-popover-title">Действия файла</strong>
                    <UiButton v-if="editorNarrowActions && canShowFileHistory" block variant="ghost"
                              data-context="code-popover-action" data-action="file-history"
                              @click="openFileHistory(); close('action')">
                      История файла
                    </UiButton>
                    <UiButton v-if="editorNarrowActions && canAskAgent" block variant="ghost"
                              data-context="code-popover-action" data-action="ask-agent"
                              :loading="askAgentBusy" :disabled="askAgentBusy"
                              @click="askAgentAboutCode(); close('action')">
                      Спросить агента
                    </UiButton>
                    <UiButton v-if="tab === 'files' && fileSel && !fileHistoryActive"
                              block variant="ghost" data-context="code-popover-action"
                              data-action="blame" :pressed="blameEnabled" :disabled="!canUseBlame"
                              v-tooltip="blameTitle" @click="toggleBlame">
                      Авторство строк
                    </UiButton>
                    <UiButton v-if="canCopyCodeLink" block variant="ghost"
                              data-context="code-popover-action" data-action="copy-code-link"
                              @click="copyCodeLink(); close('action')">
                      {{ codeLinkCopied ? 'Ссылка скопирована' : 'Скопировать ссылку' }}
                    </UiButton>
                    <UiButton block variant="ghost" data-context="code-popover-action"
                              data-action="refresh-file" :loading="gitLoading || fileLoading"
                              @click="requestRefresh(); close('action')">
                      Обновить
                    </UiButton>
                  </div>
                </template>
              </UiPopover>
          </div>
        </div>
        <div v-if="showsComparisonRow" class="diffhead">
          <div class="comparison-identity">
            <span v-if="comparisonBadge" class="comparison-sides mono"
                  v-tooltip="comparisonBadge.hint">
              {{ comparisonBadge.label }}
            </span>
            <span v-if="rangeSummary" class="note mono range-summary">{{ rangeSummary }}</span>
            <span v-if="diffLoading" class="note">читаю…</span>
            <span v-else-if="diffError" class="note diff-error">{{ diffError }}</span>
          </div>
          <UiButton v-if="tab === 'git' && gitPane === 'changes' && (commitSel.size || branchMode)"
                    variant="ghost" data-context="code-editor-action"
                    data-action="clear-commits" v-tooltip="'Сбросить выбранный диапазон'"
                    @click="clearCommitSelection">
            Сбросить диапазон
          </UiButton>
          <span class="grow"></span>
          <div v-if="gitFileNavigation" class="file-navigation" role="group"
               :aria-label="`Навигация по файлам изменений: файл ${gitFileNavigation.index + 1} из ${gitFileNavigation.total}`">
            <UiIconButton role="embedded" data-context="code-editor-action"
                          label="Предыдущий файл" v-tooltip="'Предыдущий файл'"
                          :disabled="!gitFileNavigation.previous"
                          @click="navigateGitFile(-1)">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"
                   stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="m10 3-5 5 5 5" />
              </svg>
            </UiIconButton>
            <span class="file-position mono" aria-live="polite">
              <span class="file-position-label">Файл </span>{{ gitFileNavigation.index + 1 }} /
              {{ gitFileNavigation.total }}
            </span>
            <UiIconButton role="embedded" data-context="code-editor-action"
                          label="Следующий файл" v-tooltip="'Следующий файл'"
                          :disabled="!gitFileNavigation.next"
                          @click="navigateGitFile(1)">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"
                   stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="m6 3 5 5-5 5" />
              </svg>
            </UiIconButton>
          </div>
          <UiPopover has-popup="dialog" placement="bottom-end"
                     :style="{ width: 'min(320px, calc(100vw - 20px))' }">
            <template #trigger>
              <UiButton class="diff-view-trigger" variant="ghost"
                        data-context="code-editor-action" data-action="diff-view"
                        v-tooltip="`Вид сравнения: ${diffLayoutLabel}`">
                <span>Вид сравнения</span>
                <span class="diff-view-mode">· {{ diffLayoutLabel }}</span>
                <svg class="chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor"
                     stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"
                     aria-hidden="true">
                  <path d="m4 6 4 4 4-4" />
                </svg>
              </UiButton>
            </template>
            <div class="code-popover-panel diff-view-panel">
              <strong class="code-popover-title">Вид сравнения</strong>
              <span class="code-popover-label">Расположение</span>
              <div class="diff-layout-options" role="group" aria-label="Расположение сравнения">
                <UiButton variant="ghost" data-context="code-popover-choice"
                          :pressed="renderSideBySide"
                          :disabled="oneSidedDiff || editorForcesInlineDiff"
                          @click="setDiffLayout(true)">
                  Рядом
                </UiButton>
                <UiButton variant="ghost" data-context="code-popover-choice"
                          :pressed="!renderSideBySide" @click="setDiffLayout(false)">
                  В одну колонку
                </UiButton>
              </div>
              <p v-if="oneSidedDiff" class="code-popover-note">
                Новый или удалённый файл показывается в одну колонку.
              </p>
              <p v-else-if="editorForcesInlineDiff" class="code-popover-note">
                На этой ширине сравнение показано в одну колонку. При расширении вернётся
                сохранённый режим «Рядом».
              </p>
              <UiSwitch :model-value="diffWrap" data-action="diff-wrap"
                        @change="toggleDiffWrap">
                Переносить длинные строки
              </UiSwitch>
              <UiSwitch :model-value="ignoreTrimWhitespace" data-action="diff-whitespace"
                        @change="toggleDiffWhitespace">
                Игнорировать пробелы по краям строк
              </UiSwitch>
            </div>
          </UiPopover>
        </div>
        </header>
        <div class="ebody" data-escape-owner="monaco">
          <div v-show="tab === 'files' && !imageSrc && !fileHistoryActive"
               ref="fileHost" class="editor"></div>
          <div v-show="(tab === 'git' && !patchReviewActive) || fileHistoryActive"
               ref="diffHost" class="editor"></div>
          <PatchReview v-if="patchReviewActive && patchReviewData"
                       :patch="patchReviewData.patch" :truncated="patchReviewData.truncated"
                       :files="patchReviewGroup?.files || []" @open="openPatchReviewFile" />
          <div v-else-if="patchReviewActive && patchLoading" class="overlay">Собираю обзор…</div>
          <div v-else-if="patchReviewActive && patchError" class="overlay">{{ patchError }}</div>
          <!-- Картинка вместо пустого редактора: сырые байты отдаёт raw-роут «Кода». -->
          <div v-if="tab === 'files' && imageSrc && !fileHistoryActive" class="imgwrap">
            <img v-if="!imageError" :src="imageSrc" :alt="fileSel" @error="imageError = 'Не удалось загрузить изображение'">
            <div v-else class="imgerr">
              {{ imageError }}<br>
              <span class="muted">Возможно, файл больше 10 МБ или его формат не поддерживается предпросмотром.</span>
            </div>
          </div>
          <div v-if="fileHistoryActive && !fileHistoryDiff && !fileHistoryDiffLoading"
               class="overlay">
            <div class="editor-empty">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
                   stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M4 5h16M4 12h16M4 19h10" />
              </svg>
              <strong>Выбери коммит</strong>
              <span>История файла находится в панели слева.</span>
            </div>
          </div>
          <div v-else-if="tab === 'files' && !fileSel" class="overlay">
            <div class="editor-empty">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
                   stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M6 3h8l4 4v14H6zM14 3v4h4" />
              </svg>
              <strong>Выбери файл</strong>
              <span>Открой его в дереве или найди по имени и содержимому.</span>
            </div>
          </div>
          <div v-else-if="tab === 'git' && !patchReviewActive
                         && commitSel.size && commitsDiff && !commitsDiff.files.length"
               class="overlay">
            <div class="editor-empty">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
                   stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M5 7h14M7 12h10M9 17h6" />
              </svg>
              <strong>В диапазоне нет изменений</strong>
              <span>Выбери другой коммит или вернись к текущим правкам.</span>
            </div>
          </div>
          <!-- Пусто = нет изменений НИ В ОДНОЙ группе: при чистом рабочем дереве, но
               непустом индексе, диф выбранного файла существует и закрывать его нечем. -->
          <div v-else-if="tab === 'git' && !patchReviewActive && git && !gitEntries.size"
               class="overlay">
            <div class="editor-empty positive">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
                   stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <path d="m8 12 2.6 2.6L16.5 9" />
              </svg>
              <strong>Рабочая копия чистая</strong>
              <span>Несохранённых изменений нет.</span>
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { UiSkeletonLayout } from '../../ui';

import { toolWindowText } from '../../shared/tools/toolWindowMessages.ts';
import { sendCodeWindowAction } from '../../shared/tools/toolWindowActions.ts';
import { parseToolWindowState } from '../../shared/tools/toolWindowState.ts';
import type { ToolWindowState } from '../../shared/tools/toolWindowState.ts';
// Плагин «Код» — просмотр кода и управление Git проектов, как в VS Code:
// слева рейка режимов (код | гит), дальше панель (дерево файлов или изменения),
// справа Monaco. Смотреть можно ЛЮБОЕ дерево репозитория — основное или worktree
// (их создаёт фабрика): репозиторий и worktree выбираются одним полем «Рабочая копия».
// Пути репозиториев проекта задаются в разделе «Проекты».
import { ref, computed, watch, onBeforeUnmount, onMounted, nextTick } from 'vue';
import { codeApi, codeErrorMessage } from '../../shared/codeApi';
import { useSse } from '../../composables/useSse';
import { useChatStore } from '../../stores/chat.ts';
import { router } from '../../router.ts';
import type {
  CodeBlameLine,
  CodeDirectoryEntry,
  CodeCommitsDiffResponse,
  CodeFileDiffResponse,
  CodeFileLogEntry,
  CodeFileResponse,
  CodeGitEntry,
  CodeGitFile,
  CodeGitResponse,
  CodePatchResponse,
  CodeProject,
  CodeRepo,
  CodeRequestContext,
  CodeSearchResponse,
  CodeTarget,
} from '../../../../shared/plugins/code/codeContracts';
import PatchReview from './PatchReview.vue';
import VirtualRows from '../../shared/VirtualRows.vue';
import { monaco, langOf, READONLY_OPTS } from '../../shared/monaco';
import { codeLinkHref } from '../../features/code/links';
import { pickCodeProject } from './projectChoice';
import {
  askAgentDraft,
  buildCodeContexts,
  buildGitGroups,
  chunkList,
  groupDirectoryFiles,
  splitGitPath,
  commitRangeBounds,
  encodeStoredCodeContext,
  extendCommitSelection,
  fileDiffKey,
  gitGroupDirectoryPaths,
  gitRef,
  normalizeGitView,
  pickCodeContext,
  pruneCommitSelection,
  reconcileGitOpenDirs,
  treeDecorations,
  toggleCommitSelection,
} from '../../shared/codeTree';
import type { CodeContext, GitGroup, GitGroupId, GitGroupStat } from '../../shared/codeTree';
import {
  UiButton,
  UiIconButton,
  UiInlineMessage,
  UiPopover,
  UiPressable,
  UiSearchInput,
  UiSelect,
  UiSwitch,
  UiTextarea,
  confirmDialog,
  promptDialog,
  vTooltip,
  UiLoadingState,
} from '../../ui';

type CodeTab = 'files' | 'git';
type CodeMainTab = 'files' | 'changes' | 'commits';
type GitPane = 'changes' | 'commits';
type NarrowPane = 'navigator' | 'editor';
type ContextSnapshot = CodeRequestContext & { generation: number };
type ActivationOptions = { activation?: number | null };
type RefreshOptions = ActivationOptions & { silent?: boolean; contentOnly?: boolean };
type PreviousContext = {
  generation: number;
  project: string;
  contextId: string;
  tab: CodeTab;
  gitPane: GitPane;
  file: string;
  gitFile: string;
};
type CodePanelContext = {
  id: 'code';
  presentation: string;
  project?: string;
  context?: string;
  tab: CodeTab;
  file?: string;
};
type OpenFileIntent = {
  type: 'open-file';
  project?: string;
  repo: string;
  root: string;
  path: string;
  line?: number;
};
type CodeIntent = OpenFileIntent | { type: 'project'; project: string };
type IntentEnvelope = { id: number; payload: CodeIntent | null };
type FileTreeRow = CodeDirectoryEntry & { rel: string; depth: number };
type GitNotice = { type: 'ok' | 'err'; text: string };
interface FileHistoryOrigin {
  tab: CodeTab;
  gitPane: GitPane;
  file: string;
  gitRef: string;
}
interface CommitSelectionSnapshot {
  from: string;
  to: string;
  selected: number;
}
type TrackingNote = {
  type: 'err' | 'mid';
  text: string;
  hint?: string
};
type GitActionOptions<Result> = {
  execute: (snapshot: ContextSnapshot) => Promise<Result>;
  key: string;
  refreshGit?: boolean;
  onSuccess?: (result: Result) => void;
};

const props = withDefaults(defineProps<{
  active?: boolean;
  compact?: boolean;
  presentation?: string;
  intents?: unknown[];
}>(), {
  active: true,
  compact: false,
  presentation: 'page',
  intents: () => [],
});
const emit = defineEmits<{
  'consume-intent': [id: number];
  context: [value: CodePanelContext | null];
}>();
const chatStore = useChatStore();

const loading = ref(true);
const contextLoading = ref(false);
const error = ref('');
const projects = ref<CodeProject[]>([]);   // сводка /api/projects: [{id, repos, …}]
const project = ref('');
const repos = ref<CodeRepo[]>([]);      // /api/code/:project/repos: [{key, dir, trees}]
const repoKey = ref('');
const treePath = ref('');
const contextId = ref('');
const tab = ref<CodeTab>('files');   // 'files' | 'git'
const gitPane = ref<GitPane>('changes');

const contextModel = computed(() => buildCodeContexts(repos.value));
const contexts = computed(() => contextModel.value.contexts);
const unavailableRepos = computed(() => contextModel.value.unavailable);
const contextById = computed(() => new Map(contexts.value.map((item) => [item.id, item])));
const context = computed(() => contextById.value.get(contextId.value) || null);
const contextGroups = computed(() => {
  const groups: { repoKey: string; items: CodeContext[] }[] = [];
  const byRepo = new Map<string, { repoKey: string; items: CodeContext[] }>();

  for (const item of contexts.value) {
    let group = byRepo.get(item.repoKey);

    if (!group) {
      group = { repoKey: item.repoKey, items: [] };
      byRepo.set(item.repoKey, group);
      groups.push(group);
    }

    group.items.push(item);
  }

  return groups;
});
const projectHasRepos = computed(() => (
  (projects.value.find((item) => item.id === project.value)?.repos || []).length > 0
));
// Оба переключателя видны всегда, как только есть что показать: даже единственный
// вариант обязан выглядеть переключателем — иначе непонятно, где вообще менять проект
// и рабочую копию. Скрывается только пустой селект, которому нечего предложить.
const showsProjectPicker = computed(() => projects.value.length > 0);
const showsContextPicker = computed(() => contexts.value.length > 0);
/**
 * Текст шапки на время, пока рабочих копий ещё нет: репозитории проекта не прочитаны
 * или все оказались недоступны. Имя проекта добавляется только при живом отличии от
 * ключа репозитория, а сам ключ пропадает, когда его уже назвал селект проекта.
 */
const headContext = computed(() => {
  if (!context.value) {
    return '';
  }

  if (showsProjectPicker.value) {
    return context.value.repoKey === project.value
      ? context.value.treeLabel
      : context.value.label;
  }

  return context.value.repoKey === project.value
    ? context.value.label
    : `${project.value} · ${context.value.label}`;
});

// ── Дерево файлов (ленивое: каталог читается при раскрытии) ──
const dirs = ref(new Map<string, CodeDirectoryEntry[]>());     // rel ('' = корень) → entries [{name, dir}]
const openDirs = ref(new Set<string>());
const fileSel = ref('');
const fileData = ref<CodeFileResponse | null>(null);      // { content, binary, tooBig, size }
const fileLoading = ref(false);
const searchQuery = ref('');
const searchResult = ref<CodeSearchResponse | null>(null);
const searchLoading = ref(false);
const searchError = ref('');
const searchActive = computed(() => searchQuery.value.length >= 2);
const SEARCH_DELAY_MS = 300;

// ── Гит ──
const git = ref<CodeGitResponse | null>(null);           // { branch, files, staged, log }
const changePathCount = computed(() => new Set([
  ...(git.value?.staged || []).map((file) => file.path),
  ...(git.value?.files || []).map((file) => file.path),
]).size);
const mainTab = computed<CodeMainTab>(() => (tab.value === 'files' ? 'files' : gitPane.value));
// Счётчик входит в доступное имя кнопки рейки: значок-бейдж читатель экрана не видит.
const changesRailLabel = computed(() => (
  changePathCount.value ? `Изменения · ${changePathCount.value}` : 'Изменения'
));
const fileTreeDecorations = computed(() => treeDecorations(git.value));
const gitLoading = ref(false);
const diffContent = ref(new Map<string, CodeFileDiffResponse>());
const diffLoading = ref(false);
const diffError = ref('');
const patchContent = ref(new Map<string, CodePatchResponse>());
const patchReviewKey = ref('');
const patchReviewGroupId = ref<GitGroupId | null>(null);
const patchLoading = ref(false);
const patchError = ref('');
const commitsDiff = ref<CodeCommitsDiffResponse | null>(null);
const commitsLoading = ref(false);
const commitsError = ref('');
const branchMode = ref(false);
const commitSel = ref(new Set<string>());
const commitAnchor = ref('');
const commitsLoadedSelection = ref<CommitSelectionSnapshot | null>(null);
// «С текущими изменениями» — настройка устройства, по умолчанию включена: диф отрезка до
// HEAD показывает и несохранённые правки. Для более старого конца режим молча не действует.
const commitsWithWork = ref(localStorage.getItem('grigdesk-code-commits-work') !== '0');
const commitMessage = ref('');
const amendCommit = ref(false);
const amendHeadMessage = ref('');
const commitComposerOpen = ref(false);
const commitComposerTouched = ref(false);
const gitBusy = ref('');
const gitNotice = ref<GitNotice | null>(null);     // { type: 'ok' | 'err', text }
const gitActionBusy = computed(() => !!gitBusy.value);
const commitComposerTitle = computed(() => {
  if (!commitComposerOpen.value) {
    return 'Коммит';
  }

  return amendCommit.value ? 'Изменение последнего коммита' : 'Новый коммит';
});
const commitIndexLabel = computed(() => (
  git.value?.staged.length
    ? `${fileCountLabel(git.value.staged.length)} в индексе`
    : 'Индекс пуст'
));
const commitComposerHint = computed(() => (
  git.value?.staged.length
    ? 'Раскройте форму, чтобы написать сообщение.'
    : 'Подготовьте файлы кнопкой +'
));
const amendAvailable = computed(() => {
  const current = git.value;

  return Boolean(current?.log.length)
    && !current?.tracking?.detached
    && (!current?.tracking?.upstream || Number(current.tracking.ahead) > 0);
});
const amendTitle = computed(() => {
  if (!git.value?.log.length) {
    return 'В репозитории ещё нет последнего коммита';
  }
  if (git.value.tracking?.detached) {
    return 'Detached HEAD нельзя переписывать';
  }
  if (git.value.tracking?.upstream && Number(git.value.tracking.ahead) === 0) {
    return 'Коммит уже отправлен — push без force невозможен';
  }

  return 'Добавить индекс в последний локальный коммит или изменить его сообщение';
});
const undoAvailable = computed(() => amendAvailable.value && (git.value?.log.length || 0) > 1);
const undoTitle = computed(() => {
  if (git.value?.tracking?.detached) {
    return 'Detached HEAD нельзя переписывать';
  }
  if (git.value?.tracking?.upstream && Number(git.value.tracking.ahead) === 0) {
    return 'Коммит уже отправлен — push без force невозможен';
  }
  if (!git.value?.log.length) {
    return 'В репозитории ещё нет последнего коммита';
  }
  if (git.value.log.length < 2) {
    return 'У последнего коммита нет родителя';
  }

  return 'Отменить последний коммит и вернуть его изменения в индекс';
});

watch(() => git.value?.headMessage || '', (next, previous) => {
  if (amendCommit.value
    && (!commitMessage.value.trim()
      || commitMessage.value === previous
      || commitMessage.value === amendHeadMessage.value)) {
    commitMessage.value = next;
  }

  amendHeadMessage.value = next;
});
watch(amendAvailable, (available) => {
  if (!available) {
    amendCommit.value = false;
  }
});
watch(() => git.value?.staged.length || 0, (next, previous) => {
  if (next > 0 && previous === 0 && !commitComposerTouched.value
    && codePanelHeight.value >= 600) {
    commitComposerOpen.value = true;
  } else if (next === 0 && previous > 0 && !commitComposerTouched.value
    && !commitMessage.value.trim() && !amendCommit.value) {
    commitComposerOpen.value = false;
  }
});
watch(amendCommit, (enabled) => {
  if (enabled) {
    commitComposerOpen.value = true;
  }
});

const fetchRemoteLabel = computed(() => {
  const tracking = git.value?.tracking;

  if (tracking?.remote) {
    return tracking.remote;
  }

  return tracking?.upstream?.split('/')[0] || '';
});
const pushLabel = computed(() => {
  if (!git.value?.tracking?.upstream) {
    return 'Опубликовать';
  }

  const ahead = Number(git.value.tracking.ahead) || 0;

  return ahead > 0 ? `Пуш ↑${ahead}` : 'Пуш';
});
const pushTitle = computed(() => (git.value?.tracking?.upstream
  ? 'Отправить текущую ветку'
  : 'Опубликовать ветку и настроить upstream'));

/**
 * Строка под композером говорит только то, чего НЕТ в шапке раздела: связь с remote,
 * расхождение с ним и detached HEAD. Само имя ветки шапка уже назвала, и третья его
 * копия в одной панели была шумом.
 *
 * Исключение — расхождение живой ветки с той, что отдал каталог рабочих копий:
 * `refresh` перечитывает гит, но не `/repos`, поэтому после переключения ветки мимо
 * GrigDesk шапка остаётся устаревшей, и промолчать здесь значило бы соврать.
 */
const trackingNote = computed<TrackingNote | null>(() => {
  const tracking = git.value?.tracking || null;

  if (tracking?.detached) {
    return { type: 'err', text: 'detached HEAD — коммит уйдёт в никуда, пуш недоступен' };
  }

  const live = String(git.value?.branch || '');

  if (live && context.value?.branch && live !== context.value.branch) {
    return {
      type: 'err',
      text: `ветка сменилась на ${live}`,
      hint: 'откройте рабочую копию заново'
    };
  }

  if (!tracking?.upstream) {
    return { type: 'mid', text: 'ветка ещё не опубликована' };
  }

  const ahead = Number(tracking.ahead) || 0;
  const behind = Number(tracking.behind) || 0;

  if (!ahead && !behind) {
    return null;
  }

  return {
    type: 'mid',
    text: `${tracking.upstream} · ↑${ahead} ↓${behind}`,
    hint: 'расхождение с веткой отслеживания',
  };
});
// Выбор адресуется парой «группа:путь»: один и тот же файл законно лежит и в индексе,
// и в рабочем дереве, и дифы у них разные.
const gitSel = ref('');
// Для добавленного/удалённого файла одна сторона дифа заведомо пуста. В режиме
// «рядом» она съедала половину редактора (особенно заметно в развёрнутом доке),
// поэтому такие изменения всегда показываем одной колонкой.
const oneSidedDiff = computed(() => ['A', 'D'].includes(gitFile.value?.status || ''));
const editorWidth = ref(Number.POSITIVE_INFINITY);
const editorForcesInlineDiff = computed(() => editorWidth.value < 760);
const editorNarrowActions = computed(() => editorWidth.value < 760);
const codePanelWidth = ref(Number.POSITIVE_INFINITY);
const codePanelNarrow = computed(() => codePanelWidth.value < 760);
const narrowPane = ref<NarrowPane>('navigator');
const narrowBackLabel = computed(() => ({
  files: 'К файлам',
  changes: 'К изменениям',
  commits: 'К коммитам',
}[mainTab.value]));
const fullSide = ref(localStorage.getItem('grigdesk-diff-side') !== '0');
const compactSide = ref(localStorage.getItem('grigdesk-dock-diff-side') === '1');
const side = computed({
  get: () => (props.compact ? compactSide.value : fullSide.value),
  set: (value) => {
    if (props.compact) {
      compactSide.value = !!value;
      localStorage.setItem('grigdesk-dock-diff-side', value ? '1' : '0');
    } else {
      fullSide.value = !!value;
      localStorage.setItem('grigdesk-diff-side', value ? '1' : '0');
    }
  },
});
const renderSideBySide = computed(() => (
  side.value && !oneSidedDiff.value && !editorForcesInlineDiff.value
));
const diffWrap = ref(localStorage.getItem('grigdesk-diff-wrap') === '1');
const ignoreTrimWhitespace = ref(localStorage.getItem('grigdesk-diff-ws') === '1');
const gitView = ref(normalizeGitView(localStorage.getItem('grigdesk-code-git-view')));
// Свёрнутые группы изменений — настройка устройства: свёрнутое дерево правок открывает
// список коммитов без прокрутки, а счётчик и итог группы остаются в заголовке.
const collapsedGroups = ref(readCollapsedGroups());
const gitOpenDirs = ref(new Set<string>());
const gitKnownDirs = ref(new Set<string>());
const gitDirsReady = ref(false);
// Группы изменений, как Source Control в VS Code: индекс и рабочее дерево. Пустая
// группа не рисуется, поэтому при чистом индексе панель выглядит ровно как раньше.
const selectedCommitBounds = computed(() => commitRangeBounds(
  git.value?.log || [],
  commitSel.value,
));
const commitsWorkAvailable = computed(() => {
  if (branchMode.value) {
    return true;
  }

  const bounds = selectedCommitBounds.value;
  const head = git.value?.log[0]?.hash || '';

  return !bounds || (!!head && bounds.to === head);
});
const commitsWorkActive = computed(() => commitsWithWork.value && commitsWorkAvailable.value);
const commitsWorkTitle = computed(() => {
  if (!commitsWorkAvailable.value) {
    return 'Текущие изменения можно добавить только к отрезку до последнего коммита';
  }

  return commitsWithWork.value
    ? 'Показывать отрезок вместе с несохранёнными правками — выключить'
    : 'Показывать отрезок вместе с несохранёнными правками';
});
const branchDiffAvailability = computed(() => {
  const selected = context.value;

  if (!selected || !git.value) {
    return { enabled: false, title: 'Сначала выбери рабочую копию.' };
  }
  if (selected.main) {
    return git.value.tracking.upstream
      ? { enabled: true, title: 'Показать всю ветку относительно upstream' }
      : { enabled: false, title: 'У основной ветки нет upstream.' };
  }

  const main = contexts.value.find((item) => item.repoKey === selected.repoKey && item.main);

  return main?.branch && main.branch !== '(detached)'
    ? { enabled: true, title: `Показать всю ветку относительно ${main.branch}` }
    : { enabled: false, title: 'У основного дерева не определена ветка.' };
});
const commitGroup = computed(() => {
  const diff = commitsDiff.value;
  const bounds = commitsLoadedSelection.value;

  if (!diff || (!branchMode.value && !bounds)) {
    return null;
  }

  if (branchMode.value) {
    return {
      files: diff.files,
      from: diff.range.from,
      to: diff.range.to,
      commits: diff.range.commits,
      selected: diff.range.commits,
      mode: 'branch' as const,
      work: diff.range.work,
    };
  }

  return {
    files: diff.files,
    from: bounds?.from || '',
    to: bounds?.to || '',
    commits: diff.range.commits,
    selected: commitSel.value.size,
    work: diff.range.work,
  };
});
const gitGroups = computed(() => buildGitGroups(git.value, gitOpenDirs.value, commitGroup.value));
const changeGroups = computed(() => gitGroups.value.filter((group) => group.id !== 'commits'));
const visibleGitGroups = computed(() => (
  gitPane.value === 'changes'
    ? changeGroups.value
    : gitGroups.value.filter((group) => group.id === 'commits')
));

// Ключи строк для VirtualRows — постоянные функции, а не стрелки в шаблоне: новая стрелка
// на каждом рендере панели была бы новым prop и будила бы окно впустую.
const fileRowKey = (row: FileTreeRow) => row.rel;
const gitRowKey = (row: GitGroup['rows'][number]) => row.key;
const gitListKey = (entry: GitGroup['list'][number]) => entry.file.path;
const patchReviewGroup = computed(() => (
  gitGroups.value.find((group) => group.id === patchReviewGroupId.value) || null
));
const patchReviewData = computed(() => patchContent.value.get(patchReviewKey.value) || null);
const patchReviewActive = computed(() => Boolean(patchReviewKey.value && patchReviewGroup.value));
const gitEntries = computed(() => {
  const map = new Map<string, { file: CodeGitEntry; group: GitGroup }>();

  for (const group of gitGroups.value) {
    for (const file of group.files) {
      map.set(gitRef(group.id, file.path), { file, group });
    }
  }

  return map;
});
const gitEntry = computed(() => gitEntries.value.get(gitSel.value) || null);
const gitFileNavigation = computed(() => {
  if (tab.value !== 'git' || fileHistoryActive.value) {
    return null;
  }

  const entry = gitEntry.value;

  if (!entry || entry.group.files.length < 2 || patchReviewActive.value) {
    return null;
  }

  const index = entry.group.files.findIndex((file) => file.path === entry.file.path);

  if (index < 0) {
    return null;
  }

  const previous = entry.group.files[index - 1];
  const next = entry.group.files[index + 1];

  return {
    index,
    total: entry.group.files.length,
    previous: previous ? gitRef(entry.group.id, previous.path) : '',
    next: next ? gitRef(entry.group.id, next.path) : '',
  };
});
/**
 * Запись, чей диф показывает редактор. В режиме «+ текущие» слитый диф отрезка открывается
 * по клику на файл в ЛЮБОЙ группе: тот же путь есть в группе коммитов — показывается он,
 * а строка рабочего дерева остаётся выбранной. Новый файл только с диска в отрезок тоже
 * входит, и его слитый диф совпадает с собственным. Иначе человеку приходилось искать тот
 * же файл именно в группе коммитов.
 */
const shownEntry = computed(() => {
  const entry = gitEntry.value;

  if (!entry || entry.group.id === 'commits' || !commitsDiff.value?.range.work) {
    return entry;
  }

  return gitEntries.value.get(gitRef('commits', entry.file.path)) || entry;
});
const rangeSummary = computed(() => {
  const group = shownEntry.value?.group;

  if (group?.id !== 'commits') {
    return '';
  }

  return `${fileCountLabel(group.files.length)}, +${group.stat.add} −${group.stat.del}`;
});
const gitFile = computed<CodeGitFile | null>(() => {
  const entry = shownEntry.value;

  if (!entry) {
    return null;
  }

  const range = entry.group.id === 'commits' && commitsDiff.value
    ? rangeCacheKey(commitsDiff.value.range)
    : '';
  const content = diffContent.value.get(fileDiffKey(entry.group.id, entry.file.path, range));

  return {
    ...entry.file,
    tooBig: content?.tooBig || false,
    oldContent: content?.oldContent || '',
    newContent: content?.newContent || '',
  };
});
const canCopyCodeLink = computed(() => (
  !fileHistoryActive.value
  && (tab.value === 'files' ? !!fileSel.value : !!gitFile.value && !patchReviewActive.value)
));
const canAskAgent = computed(() => !patchReviewActive.value && !fileHistoryActive.value && (
  tab.value === 'files' ? !!fileSel.value : !!gitEntry.value
));
const canShowFileHistory = computed(() => !fileHistoryActive.value && !patchReviewActive.value && (
  tab.value === 'files' ? !!fileSel.value : !!gitFile.value
));
// Обновление относится ко всему текущему контексту, поэтому меню остаётся доступным
// и в чистом Git-состоянии, когда выбрать файл ещё невозможно.
const canShowFileMenu = computed(() => !patchReviewActive.value);
const blameEnabled = ref(localStorage.getItem('grigdesk-code-blame') === '1');
const blameLines = ref<CodeBlameLine[]>([]);
const blamePath = ref('');
const blameLoading = ref(false);
const blameError = ref('');
const canUseBlame = computed(() => Boolean(
  tab.value === 'files'
  && fileSel.value
  && fileData.value
  && !fileData.value.binary
  && !fileData.value.tooBig
  && !isImagePath(fileSel.value),
));
const blameTitle = computed(() => {
  if (fileData.value?.binary) {
    return 'Blame недоступен для бинарного файла';
  }
  if (fileData.value?.tooBig) {
    return 'Blame недоступен для слишком большого файла';
  }
  if (isImagePath(fileSel.value)) {
    return 'Blame недоступен для изображения';
  }

  return blameEnabled.value ? 'Скрыть авторство строк' : 'Показать авторство строк';
});
const codeLinkCopied = ref(false);
const askAgentBusy = ref(false);
const fileHistoryOrigin = ref<FileHistoryOrigin | null>(null);
const fileHistoryPath = ref('');
const fileHistoryEntries = ref<CodeFileLogEntry[]>([]);
const fileHistorySelected = ref('');
const fileHistoryDiff = ref<CodeGitFile | null>(null);
const fileHistoryLoading = ref(false);
const fileHistoryError = ref('');
const fileHistoryDiffLoading = ref(false);
const fileHistoryDiffError = ref('');
const fileHistoryActive = computed(() => fileHistoryOrigin.value !== null);
const STLABEL: Record<string, string> = {
  A: 'A',
  M: 'M',
  D: 'D',
  R: 'R',
  U: '!',
};
const CONFLICT_HINT = 'конфликт: разреши в файле, затем добавь в индекс';
// Шаг лесенки дерева задаётся в CSS (`--tree-step`), сюда приезжает только глубина:
// иначе два числа — px в скрипте и отступ шеврона в стилях — разъезжаются при правке.
function rowDepth(depth: number) {
  return { '--depth': depth };
}

/** Подсказка итога группы: в заголовке только числа, слово «строк» живёт здесь. */
function gitStatTitle(stat: GitGroupStat) {
  return `добавлено строк: ${stat.add}, удалено строк: ${stat.del}`;
}

/**
 * Путь в шапке редактора: каталог отдельно от имени файла. Каталог сжимается с многоточием,
 * имя — никогда: иначе при узкой шапке путь превращался в «docs…» и файл было не узнать.
 */
function headPath(path: string) {
  return splitGitPath(path);
}

/**
 * Склоняет счётчик файлов в короткой сводке выбранного диапазона.
 * Отдельная ветка 11…14 защищает исключение русского множественного числа.
 */
function fileCountLabel(count: number) {
  const tail = count % 100;
  const digit = count % 10;
  const word = tail >= 11 && tail <= 14
    ? 'файлов'
    : digit === 1 ? 'файл' : digit >= 2 && digit <= 4 ? 'файла' : 'файлов';

  return `${count} ${word}`;
}

/**
 * Переключает diff на соседний файл, не меняя выбранную Git-группу.
 * На границе списка кнопка недоступна, поэтому здесь пустая цель означает no-op.
 */
function navigateGitFile(direction: -1 | 1) {
  const navigation = gitFileNavigation.value;
  const target = direction < 0 ? navigation?.previous : navigation?.next;

  if (target) {
    void selectGit(target);
  }
}

/**
 * Выбирает первый файл первой непустой группы.
 * Индекс имеет приоритет перед рабочим деревом, как и порядок групп в панели.
 */
function firstGitRef() {
  for (const group of gitGroups.value) {
    const first = group.files[0];

    if (first) {
      return gitRef(group.id, first.path);
    }
  }

  return '';
}

/** Короткая ревизия для явной подписи сторон сравнения. */
function shortRevision(value: string) {
  return value.slice(0, 7);
}

// Бейдж называет обе стороны, а не внутреннюю Git-группу: даже при одной группе
// человеку важно отличать HEAD → индекс от индекс → рабочая копия.
const gitScopeBadge = computed(() => {
  const entry = shownEntry.value;

  if (!entry) {
    return null;
  }

  if (entry.group.id === 'commits') {
    const range = commitsDiff.value?.range;

    if (!range) {
      return null;
    }

    return range.work
      ? {
        label: `${shortRevision(range.base)} → рабочая копия`,
        hint: 'слева — до первого выбранного коммита, справа — файл на диске',
      }
      : {
        label: `${shortRevision(range.base)} → ${shortRevision(range.to)}`,
        hint: 'слева — до первого выбранного коммита, справа — после последнего',
      };
  }

  if (entry.file.status === 'U') {
    return {
      label: 'наша версия → рабочая копия',
      hint: 'слева — наша версия до конфликта, справа — файл с маркерами конфликта',
    };
  }

  return entry.group.id === 'staged'
    ? { label: 'HEAD → индекс', hint: 'справа то, что уедет в следующий коммит' }
    : {
      label: 'индекс → рабочая копия',
      hint: 'справа правки на диске, которые в коммит пока не попадут',
    };
});
const selectedFileHistoryEntry = computed(() => (
  fileHistoryEntries.value.find((entry) => entry.hash === fileHistorySelected.value) || null
));
const comparisonBadge = computed(() => {
  if (!fileHistoryActive.value) {
    return gitScopeBadge.value;
  }

  const entry = selectedFileHistoryEntry.value;

  return entry
    ? {
      label: `${shortRevision(entry.base)} → ${shortRevision(entry.hash)}`,
      hint: 'версия файла до коммита и версия в выбранном коммите',
    }
    : {
      label: 'История файла',
      hint: 'выбери коммит в журнале слева',
    };
});
const showsComparisonRow = computed(() => !patchReviewActive.value && (
  fileHistoryActive.value
    ? Boolean(fileHistoryDiff.value || fileHistoryDiffLoading.value || fileHistoryDiffError.value)
    : tab.value === 'git' && Boolean(gitFile.value)
));
const diffLayoutLabel = computed(() => (
  oneSidedDiff.value || !renderSideBySide.value ? 'Одна колонка' : 'Рядом'
));

// ── Monaco: оба редактора живут под v-show, но модели очищаются при смене контекста. ──
const fileHost = ref<HTMLElement | null>(null);
const diffHost = ref<HTMLElement | null>(null);
const editorHost = ref<HTMLElement | null>(null);
const panelHeader = ref<HTMLElement | null>(null);
const layHost = ref<HTMLElement | null>(null);
let fileEditor: monaco.editor.IStandaloneCodeEditor | null = null;
let diffEditor: monaco.editor.IStandaloneDiffEditor | null = null;
let fileModel: monaco.editor.ITextModel | null = null;
let diffModels: monaco.editor.ITextModel[] = [];
let blameDecorations: monaco.editor.IEditorDecorationsCollection | null = null;
let blameMouseDisposable: { dispose(): void } | null = null;
let codeLinkCopiedTimer: ReturnType<typeof setTimeout> | null = null;
// Строка, на которую надо встать, когда модель уже создана: intent приходит раньше
// ответа сервера, а Monaco умеет прокручивать только существующую модель.
let pendingReveal: { path: string; line: number } | null = null;

// Generation защищает весь контекст, request ID — конкурирующие запросы внутри него.
let contextGeneration = 0;
let reposRequestId = 0;
let fileRequestId = 0;
let gitRequestId = 0;
let diffRequestId = 0;
let commitsRequestId = 0;
let patchRequestId = 0;
let fileHistoryRequestId = 0;
let blameRequestId = 0;
let searchRequestId = 0;
let searchTimer: ReturnType<typeof setTimeout> | null = null;
let commitsLoadedKey = '';

// Параметры file-diff/patch по принятому отрезку: с диском второй ревизии нет, есть флаг.
function rangeQuery(range: CodeCommitsDiffResponse['range']) {
  return range.work
    ? { base: range.base, work: true }
    : { base: range.base, to: range.to };
}

function rangeCacheKey(range: CodeCommitsDiffResponse['range']) {
  return `${range.base}:${range.to}${range.work ? ':work' : ''}`;
}

let gitActionId = 0;
let fileLoadingRequestId = 0;
let gitLoadingRequestId = 0;
const dirRequestIds = new Map<string, number>();

// Растровые картинки показываются предпросмотром вместо пустого Monaco: сырые байты
// отдаёт `/api/code/:project/raw`. Набор обязан совпадать с RAW_IMAGE_TYPES сервера
// (сторож — tests/server/code-raw.test.js); SVG исключён намеренно, как у документов.
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|bmp|ico)$/i;
const isImagePath = (rel: string) => IMAGE_EXT.test(String(rel || ''));
const imageSrc = computed(() => (fileSel.value && isImagePath(fileSel.value) && context.value
  ? codeApi.rawUrl(captureContext(), fileSel.value)
  : ''));
const imageError = ref('');
// Бинарность у картинки — норма, а не диагноз: пометку «бинарный» показываем только
// тем файлам, которые действительно нечем показать.
const showsImage = computed(() => !!imageSrc.value && !imageError.value);

const contextStorageKey = (id: string) => `grigdesk-code-context:${id}`;
const captureContext = (): ContextSnapshot => ({
  generation: contextGeneration,
  project: project.value,
  repoKey: repoKey.value,
  treePath: treePath.value,
});
const contextIsCurrent = (snapshot: ContextSnapshot) => snapshot.generation === contextGeneration
  && snapshot.project === project.value
  && snapshot.repoKey === repoKey.value
  && snapshot.treePath === treePath.value;
const projectIsCurrent = (generation: number, id: string, requestId: number) => (
  generation === contextGeneration
  && id === project.value
  && requestId === reposRequestId
);
const activationIsCurrent = (id: number | null) => id == null || id === activationId;

// Ширина рейки разделов слева: одна цифра и для сетки (через CSS-переменную), и для
// перевода координаты указателя в ширину навигатора.
const RAIL_WIDTH = 44;
const NAVIGATOR_MIN_WIDTH = 220;
const NAVIGATOR_MAX_WIDTH = 420;
const NAVIGATOR_DEFAULT_WIDTH = 320;
const navigatorMaxWidth = ref(NAVIGATOR_MAX_WIDTH);
const codePanelHeight = ref(Number.POSITIVE_INFINITY);
/**
 * Ограничивает сохранённую ширину текущим размером панели.
 * Повреждённое значение storage возвращает стандартные 320 пикселей.
 */
const clampNavigatorWidth = (value: string | number | null, max = navigatorMaxWidth.value) => {
  const parsed = value === null || value === '' ? NaN : Number(value);

  return Math.min(
    Math.max(NAVIGATOR_MIN_WIDTH, max),
    Math.max(NAVIGATOR_MIN_WIDTH, Number.isFinite(parsed) ? parsed : NAVIGATOR_DEFAULT_WIDTH),
  );
};

/**
 * Читает пользовательскую ширину навигатора из локального состояния устройства.
 * Недоступный storage не имеет права сломать открытие самой панели.
 */
function readNavigatorWidth() {
  try {
    return localStorage.getItem('grigdesk-code-dock-nav-width');
  } catch {
    return null;
  }
}

/**
 * Запоминает только уже ограниченную и округлённую ширину навигатора.
 * Ошибка записи оставляет рабочей текущую раскладку до закрытия страницы.
 */
function storeNavigatorWidth() {
  try {
    localStorage.setItem('grigdesk-code-dock-nav-width', String(Math.round(navigatorWidth.value)));
  } catch {
    // Недоступный storage не должен ломать сам разделитель.
  }
}
// Храним желаемую ширину отдельно от текущего viewport-clamp. При временном
// сужении дока дерево ужимается, а после разворачивания возвращается к выбору
// человека, если он сам не двигал разделитель в узком состоянии.
const navigatorPreferredWidth = ref(clampNavigatorWidth(
  readNavigatorWidth(),
  NAVIGATOR_MAX_WIDTH,
));
const navigatorWidth = computed(() => clampNavigatorWidth(navigatorPreferredWidth.value));
const navigatorCollapsed = ref(false);
const navigatorToggleLabel = computed(() => (
  navigatorCollapsed.value ? 'Показать навигатор' : 'Скрыть навигатор'
));
const compactStyle = computed(() => ({
  '--code-rail-width': `${RAIL_WIDTH}px`,
  '--code-nav-width': `${navigatorWidth.value}px`,
}));
const layoutClasses = computed(() => ({
  compact: props.compact,
  'navigator-collapsed': navigatorCollapsed.value && !codePanelNarrow.value,
  'code-narrow': codePanelNarrow.value,
  'narrow-navigator': codePanelNarrow.value && narrowPane.value === 'navigator',
  'narrow-editor': codePanelNarrow.value && narrowPane.value === 'editor',
}));
let navigatorPointer: number | null = null;
let navigatorObserver: ResizeObserver | null = null;
let editorObserver: ResizeObserver | null = null;

/**
 * Пересчитывает допустимую ширину дерева после изменения размера панели.
 * Редактор сохраняет большую часть пространства, а желаемая ширина не теряется.
 */
function measureNavigatorWidth() {
  const rect = layHost.value?.getBoundingClientRect?.();
  const width = rect?.width;

  if (rect?.height && rect.height > 0) {
    codePanelHeight.value = rect.height;
  }

  if (width === undefined || width <= 0) {
    return;
  }

  const widthChanged = codePanelWidth.value !== width;

  codePanelWidth.value = width;

  const nextMax = Math.min(
    NAVIGATOR_MAX_WIDTH,
    Math.max(NAVIGATOR_MIN_WIDTH, Math.floor(width * 0.42)),
  );

  if (nextMax !== navigatorMaxWidth.value) {
    navigatorMaxWidth.value = nextMax;
  }

  if (widthChanged) {
    nextTick(layoutEditors);
  }
}

/**
 * Переводит координату указателя в ширину дерева относительно панели.
 * Ширина рейки вычитается до ограничения размера и перераскладки редакторов.
 */
function updateNavigatorWidth(clientX: number) {
  const rect = layHost.value?.getBoundingClientRect?.();

  if (!rect?.width) {
    return;
  }

  navigatorPreferredWidth.value = clampNavigatorWidth(clientX - rect.left - RAIL_WIDTH);
  layoutEditors();
}

/**
 * Захватывает основной указатель на время перетаскивания разделителя.
 * Соседние указатели не должны завершать или менять активное движение.
 */
function startNavigatorResize(event: PointerEvent) {
  if (event.button !== undefined && event.button !== 0) {
    return;
  }

  navigatorPointer = event.pointerId;

  if (event.currentTarget instanceof Element) {
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  updateNavigatorWidth(event.clientX);
}

function moveNavigatorResize(event: PointerEvent) {
  if (navigatorPointer !== event.pointerId) {
    return;
  }

  updateNavigatorWidth(event.clientX);
}

/**
 * Завершает только активное перетаскивание и освобождает захват.
 * Предпочтение сохраняется после окончания движения, без записи на каждом кадре.
 */
function finishNavigatorResize(event: PointerEvent) {
  if (navigatorPointer !== event.pointerId) {
    return;
  }

  navigatorPointer = null;

  if (event.currentTarget instanceof Element) {
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }

  storeNavigatorWidth();
}

/**
 * Даёт разделителю те же ограничения ширины при управлении с клавиатуры.
 * Shift увеличивает шаг, а Home и End выбирают края допустимого диапазона.
 */
function navigatorResizeKey(event: KeyboardEvent) {
  const step = event.shiftKey ? 64 : 16;

  if (event.key === 'ArrowLeft') {
    navigatorPreferredWidth.value = clampNavigatorWidth(navigatorWidth.value - step);
  }
  else if (event.key === 'ArrowRight') {
    navigatorPreferredWidth.value = clampNavigatorWidth(navigatorWidth.value + step);
  }
  else if (event.key === 'Home') {
    navigatorPreferredWidth.value = NAVIGATOR_MIN_WIDTH;
  }
  else if (event.key === 'End') {
    navigatorPreferredWidth.value = navigatorMaxWidth.value;
  }
  else {
    return;
  }

  event.preventDefault();
  storeNavigatorWidth();
  nextTick(layoutEditors);
}

function layoutEditors() {
  fileEditor?.layout?.();
  diffEditor?.layout?.();
}

function showNarrowNavigator() {
  narrowPane.value = 'navigator';
  nextTick(layoutEditors);
}

function showNarrowEditor() {
  narrowPane.value = 'editor';
  nextTick(layoutEditors);
}

watch(layHost, (host) => {
  navigatorObserver?.disconnect?.();
  navigatorObserver = null;

  if (!host) {
    return;
  }
  if (typeof ResizeObserver !== 'undefined') {
    navigatorObserver = new ResizeObserver(measureNavigatorWidth);
    navigatorObserver.observe(host);
  }

  nextTick(measureNavigatorWidth);
}, { flush: 'post' });

watch(editorHost, (host) => {
  editorObserver?.disconnect?.();
  editorObserver = null;

  if (!host) {
    return;
  }

  const measure = () => {
    const width = host.getBoundingClientRect?.().width;

    if (width && width > 0 && editorWidth.value !== width) {
      editorWidth.value = width;
      nextTick(layoutEditors);
    }
  };

  if (typeof ResizeObserver !== 'undefined') {
    editorObserver = new ResizeObserver(measure);
    editorObserver.observe(host);
  }

  nextTick(measure);
}, { flush: 'post' });

watch(navigatorCollapsed, async () => {
  await nextTick();
  layoutEditors();
});
watch(narrowPane, async () => {
  await nextTick();
  layoutEditors();
});

function focusPanel() {
  panelHeader.value?.focus?.();
}

defineExpose({
  focus: focusPanel,
  exportState,
  importState,
});

/**
 * Экспортирует только выбор и черновик после завершения уже принятой команды.
 * Незавершённая мутация остаётся у прежнего владельца и блокирует перенос.
 */
async function exportState(): Promise<ToolWindowState> {
  if (gitBusy.value || askAgentBusy.value) {
    throw new Error(toolWindowText('toolCodeBusy'));
  }

  while (loading.value || contextLoading.value || fileLoading.value || processingIntents) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  return {
    project: project.value,
    repo: repoKey.value,
    root: treePath.value,
    tab: tab.value,
    gitPane: gitPane.value,
    file: fileSel.value,
    gitRef: gitSel.value,
    line: fileEditor?.getPosition?.()?.lineNumber || 1,
    commitSel: [...commitSel.value],
    branchMode: branchMode.value,
    commitsWithWork: commitsWithWork.value,
    commitMessage: commitMessage.value,
    amendCommit: amendCommit.value,
    commitComposerOpen: commitComposerOpen.value,
    commitComposerTouched: commitComposerTouched.value,
  };
}

/**
 * Восстанавливает точную рабочую копию до файла, а черновик после сбросов выбора.
 * Скрытая панель загружает каталог до импорта, не ожидая показа после подтверждения возврата.
 * Исчезнувший путь показывает прежнюю ошибку и не открывает одноимённый файл другой копии.
 */
async function importState(value: ToolWindowState): Promise<void> {
  const state = parseToolWindowState('code', value);

  if (!state) {
    throw new Error(toolWindowText('toolCodeStateInvalid'));
  }

  if (!initialized && !props.active) {
    await activate();
  }

  while (loading.value || contextLoading.value || fileLoading.value || processingIntents) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  // После перезагрузки main снимок принятого окна может отсутствовать.
  // Пустой снимок оставляет обычный выбор панели, не адресует рабочую копию undefined.
  if (Object.keys(state).length === 0) {
    return;
  }

  if (typeof state.project === 'string' && project.value !== state.project) {
    await setProject(state.project);
  }

  const target = contexts.value.find((item) => item.repoKey === state.repo && item.treePath === state.root);

  if (!target) {
    error.value = `Рабочая копия ${String(state.root)} недоступна — проверь пути в разделе «Проекты»`;

    return;
  }

  if (contextId.value !== target.id) {
    await setContext(target.id);
  }

  if (state.tab === 'files' && typeof state.file === 'string' && state.file) {
    await openIntentFile({
      type: 'open-file',
      project: String(state.project),
      repo: String(state.repo),
      root: String(state.root),
      path: state.file,
      line: Number(state.line) || 1,
    });
  } else if (state.tab === 'git') {
    branchMode.value = state.branchMode === true;
    commitSel.value = new Set(Array.isArray(state.commitSel) ? state.commitSel.map(String) : []);
    commitsWithWork.value = state.commitsWithWork !== false;
    gitPane.value = ['changes', 'commits', 'branches'].includes(String(state.gitPane))
      ? state.gitPane as GitPane : 'changes';
    await setTab('git');

    if (typeof state.gitRef === 'string' && gitEntries.value.has(state.gitRef)) {
      await selectGit(state.gitRef);
    }
  }

  commitMessage.value = typeof state.commitMessage === 'string' ? state.commitMessage : '';
  amendCommit.value = state.amendCommit === true;
  commitComposerOpen.value = state.commitComposerOpen === true;
  commitComposerTouched.value = state.commitComposerTouched === true;
}

function selectProject(event: Event) {
  if (event.target instanceof HTMLSelectElement) {
    return setProject(event.target.value);
  }
}

function selectContext(event: Event) {
  if (event.target instanceof HTMLSelectElement) {
    return setContext(event.target.value);
  }
}

// Переходы — явными обработчиками, без каскадов watch: порядок загрузки детерминирован.
/**
 * Смена проекта начинает новое поколение запросов и сохраняет выбор человека.
 * Ответы предыдущего проекта не могут вернуть его рабочую копию или состояние.
 */
async function setProject(id: string, { activation = null }: ActivationOptions = {}) {
  if (!activationIsCurrent(activation)) {
    return;
  }

  const generation = ++contextGeneration;
  const requestId = ++reposRequestId;

  project.value = id;
  localStorage.setItem('grigdesk-project', id); // общий выбор проекта с «Маршрутами» и «Проектами»
  repos.value = [];
  repoKey.value = '';
  treePath.value = '';
  contextId.value = '';
  resetState();
  contextLoading.value = true;

  if (!projectHasRepos.value) {
    if (projectIsCurrent(generation, id, requestId)) {
      contextLoading.value = false;
    }

    return;
  }

  let loadedRepos;

  try {
    loadedRepos = await codeApi.repos(id);
  } catch (e) {
    if (activationIsCurrent(activation) && projectIsCurrent(generation, id, requestId)) {
      error.value = codeErrorMessage(e);
      contextLoading.value = false;
    }

    return;
  }

  if (!activationIsCurrent(activation) || !projectIsCurrent(generation, id, requestId)) {
    return;
  }

  repos.value = loadedRepos;

  const picked = pickCodeContext(contexts.value, localStorage.getItem(contextStorageKey(id)));

  if (!picked) {
    contextLoading.value = false;

    return;
  }

  await setContext(picked.id, { activation });
}

/**
 * Открывает рабочую копию по точному id и сбрасывает принадлежащие прежней модели.
 * Корень и Git загружаются последовательно с проверкой поколения после ожиданий.
 */
async function setContext(id: string, { activation = null }: ActivationOptions = {}) {
  if (!activationIsCurrent(activation)) {
    return;
  }

  const selected = contextById.value.get(id);

  if (!selected) {
    return;
  }

  const generation = ++contextGeneration;

  contextId.value = selected.id;
  repoKey.value = selected.repoKey;
  treePath.value = selected.treePath;
  resetState();
  contextLoading.value = true;
  localStorage.setItem(contextStorageKey(project.value), encodeStoredCodeContext(selected));

  const snapshot = captureContext();
  const rootLoaded = await loadDir('', snapshot, { activation });

  if (rootLoaded && activationIsCurrent(activation) && contextIsCurrent(snapshot)) {
    await loadGit(snapshot, { activation, metadataOnly: tab.value !== 'git' });
  }
  if (activationIsCurrent(activation)
    && generation === contextGeneration && contextIsCurrent(snapshot)) {
    contextLoading.value = false;
  }
}

/**
 * Очищает данные и модели прежней рабочей копии вместе с индикаторами загрузки.
 * Смена идентификаторов запросов лишает поздние ответы права менять новую панель.
 */
function resetState() {
  dirs.value = new Map();
  openDirs.value = new Set();
  fileSel.value = '';
  fileData.value = null;
  imageError.value = '';
  git.value = null;
  gitSel.value = '';
  diffContent.value = new Map();
  diffLoading.value = false;
  diffError.value = '';
  patchContent.value = new Map();
  patchReviewKey.value = '';
  patchReviewGroupId.value = null;
  patchLoading.value = false;
  patchError.value = '';
  commitsDiff.value = null;
  commitsLoading.value = false;
  commitsError.value = '';
  branchMode.value = false;
  commitSel.value = new Set();
  commitAnchor.value = '';
  commitsLoadedSelection.value = null;
  commitMessage.value = '';
  amendCommit.value = false;
  amendHeadMessage.value = '';
  commitComposerOpen.value = false;
  commitComposerTouched.value = false;
  gitBusy.value = '';
  gitNotice.value = null;
  gitOpenDirs.value = new Set();
  gitKnownDirs.value = new Set();
  gitDirsReady.value = false;
  fileLoading.value = false;
  gitLoading.value = false;
  fileLoadingRequestId = 0;
  gitLoadingRequestId = 0;
  fileRequestId += 1;
  gitRequestId += 1;
  diffRequestId += 1;
  commitsRequestId += 1;
  patchRequestId += 1;
  fileHistoryRequestId += 1;
  resetBlameView();
  resetSearch();
  fileHistoryOrigin.value = null;
  fileHistoryPath.value = '';
  fileHistoryEntries.value = [];
  fileHistorySelected.value = '';
  fileHistoryDiff.value = null;
  fileHistoryLoading.value = false;
  fileHistoryError.value = '';
  fileHistoryDiffLoading.value = false;
  fileHistoryDiffError.value = '';
  commitsLoadedKey = '';
  gitActionId += 1;
  dirRequestIds.clear();
  clearFileModel();
  clearDiffModels();
  error.value = '';
  narrowPane.value = 'navigator';
}

/**
 * Переключает вид без второго Git-снимка: вкладка файлов уже держит метаданные для
 * меток, а при входе в Git остаётся только подгрузить содержимое выбранного diff.
 */
async function setMainTab(next: CodeMainTab) {
  showNarrowNavigator();

  if (next === 'files') {
    await setTab('files');
  } else {
    gitPane.value = next;
    await setTab('git');
  }

  // Явный выбор вкладки всегда раскрывает её навигатор; состояние внутри не сбрасывается.
  navigatorCollapsed.value = false;
  await nextTick();
  layoutEditors();
}

/**
 * Переключает внутренний файловый/Git-режим и восстанавливает его текущую модель.
 * Публичные три вкладки обязаны приходить сюда через setMainTab.
 */
async function setTab(t: CodeTab) {
  if (fileHistoryActive.value) {
    await closeFileHistory(false);
  }

  tab.value = t;

  if (!treePath.value) {
    return;
  }
  if (t === 'files') {
    if (!git.value) {
      await loadGit(captureContext(), { metadataOnly: true });
    }

    return;
  }
  if (!git.value) {
    await loadGit(captureContext());

    return;
  }

  await nextTick();

  if (branchMode.value) {
    await loadBranchDiff(captureContext());
  } else if (commitSel.value.size) {
    await syncCommitsDiff(captureContext());
  } else {
    await ensureDiffContent();
  }
}

/**
 * Читает свёрнутые группы из localStorage; повреждённое значение — как пустое, чтобы
 * панель не осталась без дерева из-за чужой записи.
 */
function readCollapsedGroups(): Set<GitGroupId> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem('grigdesk-code-collapsed-groups') || '[]');
    const ids = Array.isArray(parsed) ? parsed : [];

    const known = new Set<string>(['staged', 'work', 'commits']);

    return new Set(ids.filter((id): id is GitGroupId => typeof id === 'string' && known.has(id)));
  } catch {
    return new Set();
  }
}

/**
 * Сворачивает или разворачивает группу и сразу запоминает состояние на устройстве.
 * Новый Set нужен реактивности: мутация прежнего Vue не заметит.
 */
function toggleGroupCollapsed(id: GitGroupId) {
  const next = new Set(collapsedGroups.value);

  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }

  collapsedGroups.value = next;
  localStorage.setItem('grigdesk-code-collapsed-groups', JSON.stringify([...next]));
}

function setGitView(view: 'list' | 'tree') {
  gitView.value = normalizeGitView(view);
  localStorage.setItem('grigdesk-code-git-view', gitView.value);
}

/** Выбирает расположение напрямую: popover не должен зависеть от прежнего toggle-состояния. */
function setDiffLayout(value: boolean) {
  if (!oneSidedDiff.value) {
    side.value = value;
  }
}

function toggleDiffWrap() {
  diffWrap.value = !diffWrap.value;
  localStorage.setItem('grigdesk-diff-wrap', diffWrap.value ? '1' : '0');
}

function toggleDiffWhitespace() {
  ignoreTrimWhitespace.value = !ignoreTrimWhitespace.value;
  localStorage.setItem('grigdesk-diff-ws', ignoreTrimWhitespace.value ? '1' : '0');
}

/** Учитывает только текстовую модель, которую Monaco действительно показывает. */
function fileSupportsBlame(relPath: string, data: CodeFileResponse | null): boolean {
  return Boolean(relPath && data && !data.binary && !data.tooBig && !isImagePath(relPath));
}

/** Убирает подписи с модели, сохраняя принятый ответ для возврата из истории. */
function removeBlameDecorations() {
  blameDecorations?.clear();
}

/**
 * Инвалидирует запрос и содержимое blame. Сам пользовательский режим сохраняется:
 * в новой рабочей копии или файле он должен запуститься заново автоматически.
 */
function resetBlameView() {
  blameRequestId += 1;
  blameLines.value = [];
  blamePath.value = '';
  blameLoading.value = false;
  blameError.value = '';
  removeBlameDecorations();
}

/**
 * Собирает короткую подпись строки. Нулевой hash никогда не маскируется коммитом.
 * Пустые метаданные получают нейтральные подписи и не ломают ширину декорации.
 */
function blameLineLabel(line: CodeBlameLine): string {
  if (!line.hash) {
    return '  не в коммите';
  }

  const author = line.author || 'неизвестный автор';
  const when = line.when || 'давно';

  return `  ${line.hash.slice(0, 7)} · ${author} · ${when}`;
}

/**
 * Применяет один принятый ответ к текущей текстовой модели Monaco.
 * Коллекция переиспользуется, чтобы редактор не накапливал владельцев декораций.
 */
function applyBlameDecorations() {
  if (!fileEditor || !blameEnabled.value || blamePath.value !== fileSel.value) {
    removeBlameDecorations();

    return;
  }

  const decorations: monaco.editor.IModelDeltaDecoration[] = blameLines.value.map((line) => ({
    range: {
      startLineNumber: line.line,
      startColumn: 1,
      endLineNumber: line.line,
      endColumn: 1,
    },
    options: {
      isWholeLine: true,
      after: {
        content: blameLineLabel(line),
        inlineClassName: 'code-blame-after',
        inlineClassNameAffectsLetterSpacing: true,
      },
      hoverMessage: { value: line.subject || 'Без темы' },
    },
  }));

  if (blameDecorations) {
    blameDecorations.set(decorations);
  } else {
    blameDecorations = fileEditor.createDecorationsCollection(decorations);
  }
}

/**
 * Загружает blame только для принятого снимка и пути. Request id не даёт позднему
 * ответу прежнего файла нарисовать подписи поверх новой модели.
 */
async function loadBlame(snapshot: ContextSnapshot, relPath: string) {
  if (!blameEnabled.value || !fileSupportsBlame(relPath, fileData.value)) {
    resetBlameView();

    return;
  }

  const own = ++blameRequestId;

  blameLoading.value = true;
  blameError.value = '';
  removeBlameDecorations();

  try {
    const response = await codeApi.blame(snapshot, relPath);

    if (!contextIsCurrent(snapshot) || own !== blameRequestId
      || !blameEnabled.value || fileSel.value !== relPath) {
      return;
    }

    blameLines.value = response.lines;
    blamePath.value = relPath;
    applyBlameDecorations();
  } catch (blameLoadError) {
    if (contextIsCurrent(snapshot) && own === blameRequestId && fileSel.value === relPath) {
      blameLines.value = [];
      blamePath.value = '';
      blameError.value = codeErrorMessage(blameLoadError, 'Не удалось посчитать blame');
    }
  } finally {
    if (contextIsCurrent(snapshot) && own === blameRequestId) {
      blameLoading.value = false;
    }
  }
}

/**
 * Сохраняет режим между открытиями и немедленно обновляет текущую модель.
 * При выключении летящий запрос инвалидируется общим request id.
 */
function toggleBlame() {
  if (!canUseBlame.value) {
    return;
  }

  blameEnabled.value = !blameEnabled.value;
  localStorage.setItem('grigdesk-code-blame', blameEnabled.value ? '1' : '0');

  if (blameEnabled.value) {
    void loadBlame(captureContext(), fileSel.value);
  } else {
    resetBlameView();
  }
}

/**
 * Подпись ведёт сразу в diff породившего её коммита, без дополнительного file-log.
 * Для незакоммиченной строки перехода нет.
 */
async function openBlameCommit(line: CodeBlameLine) {
  const relPath = blamePath.value;

  if (!line.hash || !relPath || fileHistoryActive.value) {
    return;
  }

  const entry: CodeFileLogEntry = {
    hash: line.hash,
    base: line.base,
    subject: line.subject,
    when: line.when,
    path: relPath,
  };

  fileHistoryOrigin.value = {
    tab: 'files',
    gitPane: gitPane.value,
    file: fileSel.value,
    gitRef: '',
  };
  fileHistoryPath.value = relPath;
  fileHistoryEntries.value = [entry];
  fileHistorySelected.value = '';
  fileHistoryDiff.value = null;
  fileHistoryError.value = '';
  fileHistoryDiffError.value = '';
  removeBlameDecorations();
  await openFileHistoryEntry(entry);
}

/** Подключает один делегированный обработчик клика к переиспользуемому редактору. */
function installBlameClick() {
  if (!fileEditor || blameMouseDisposable) {
    return;
  }

  blameMouseDisposable = fileEditor.onMouseDown((event) => {
    const element = event.target.element as (HTMLElement & {
      closest(selector: string): Element | null;
    }) | null;

    if (!element?.closest?.('.code-blame-after')) {
      return;
    }

    const lineNumber = event.target.position?.lineNumber || 0;
    const line = blameLines.value.find((item) => item.line === lineNumber);

    if (line) {
      void openBlameCommit(line);
    }
  });
}

/**
 * Возвращает короткую метку дерева для первой строки черновика.
 * Ветка не дублируется внутри метки: она явно идёт следом отдельным полем.
 */
function draftWorktreeLabel(selected: CodeContext | null): string {
  if (!selected || selected.main) {
    return 'Основная';
  }
  if (selected.task) {
    return `Задача ${selected.task}`;
  }

  return `Worktree ${selected.name || 'без имени'}`;
}

/**
 * Снимает выбранные строки из уже проверенного ответа файла, а не читает DOM Monaco.
 * Частичное выделение одной строки всё равно даёт агенту целую строку с контекстом.
 */
function selectedFileLines() {
  const selection = fileEditor?.getSelection?.();

  if (!selection || (selection.startLineNumber === selection.endLineNumber
    && selection.startColumn === selection.endColumn)) {
    return {};
  }

  const from = Math.min(selection.startLineNumber, selection.endLineNumber);
  const to = Math.max(selection.startLineNumber, selection.endLineNumber);
  const snippet = (fileData.value?.content || '').replace(/\r\n?/gu, '\n')
    .split('\n')
    .slice(from - 1, to)
    .join('\n');

  return {
    lines: { from, to },
    snippet,
  };
}

/**
 * Открывает историю текущего файла поверх левой панели, не меняя выбранный файл.
 * Поздний ответ прежнего дерева отбрасывается общим generation и request id.
 */
async function openFileHistory() {
  if (!canShowFileHistory.value) {
    return;
  }

  const relPath = tab.value === 'files' ? fileSel.value : (gitFile.value?.path || '');

  if (!relPath) {
    return;
  }

  showNarrowNavigator();

  const snapshot = captureContext();
  const own = ++fileHistoryRequestId;

  fileHistoryOrigin.value = {
    tab: tab.value,
    gitPane: gitPane.value,
    file: fileSel.value,
    gitRef: gitSel.value,
  };
  fileHistoryPath.value = relPath;
  fileHistoryEntries.value = [];
  fileHistorySelected.value = '';
  fileHistoryDiff.value = null;
  fileHistoryError.value = '';
  fileHistoryDiffError.value = '';
  fileHistoryLoading.value = true;
  removeBlameDecorations();
  // Прежний диф снимается сразу: под оверлеем «Выбери коммит слева» оставалась линейка
  // обзора старого дифа, и экран выглядел как незагрузившийся, а не пустой.
  clearDiffModels();

  try {
    const response = await codeApi.fileLog(snapshot, relPath);

    if (!contextIsCurrent(snapshot) || own !== fileHistoryRequestId
      || fileHistoryPath.value !== relPath) {
      return;
    }

    fileHistoryEntries.value = response.entries;
  } catch (historyError) {
    if (contextIsCurrent(snapshot) && own === fileHistoryRequestId) {
      fileHistoryError.value = codeErrorMessage(historyError, 'Не удалось прочитать историю файла');
    }
  } finally {
    if (contextIsCurrent(snapshot) && own === fileHistoryRequestId) {
      fileHistoryLoading.value = false;
    }
  }
}

/**
 * Читает стороны пути именно в выбранном историческом коммите.
 * `entry.path` может быть старым именем после `--follow`, его нельзя заменять текущим.
 */
async function openFileHistoryEntry(entry: CodeFileLogEntry) {
  if (!fileHistoryActive.value) {
    return;
  }

  showNarrowEditor();

  const snapshot = captureContext();
  const own = ++fileHistoryRequestId;

  fileHistorySelected.value = entry.hash;
  fileHistoryDiff.value = null;
  fileHistoryDiffError.value = '';
  fileHistoryDiffLoading.value = true;
  clearDiffModels();

  try {
    const response = await codeApi.fileDiff(snapshot, {
      group: 'commits',
      path: entry.path,
      base: entry.base,
      to: entry.hash,
    });

    if (!contextIsCurrent(snapshot) || own !== fileHistoryRequestId
      || fileHistorySelected.value !== entry.hash) {
      return;
    }

    fileHistoryDiff.value = {
      ...response,
      add: 0,
      del: 0,
      group: 'commits',
    };
    await nextTick();

    if (contextIsCurrent(snapshot) && own === fileHistoryRequestId) {
      showDiff(fileHistoryDiff.value);
    }
  } catch (historyError) {
    if (contextIsCurrent(snapshot) && own === fileHistoryRequestId) {
      fileHistoryDiffError.value = codeErrorMessage(historyError, 'Не удалось прочитать версию файла');
    }
  } finally {
    if (contextIsCurrent(snapshot) && own === fileHistoryRequestId) {
      fileHistoryDiffLoading.value = false;
    }
  }
}

/**
 * Закрывает историю и восстанавливает существующую модель исходного режима.
 * При явной смене вкладки restore отключается: новый режим сам выберет свою модель.
 */
async function closeFileHistory(restore = true) {
  const origin = fileHistoryOrigin.value;

  fileHistoryRequestId += 1;
  fileHistoryOrigin.value = null;
  fileHistoryPath.value = '';
  fileHistoryEntries.value = [];
  fileHistorySelected.value = '';
  fileHistoryDiff.value = null;
  fileHistoryLoading.value = false;
  fileHistoryError.value = '';
  fileHistoryDiffLoading.value = false;
  fileHistoryDiffError.value = '';
  clearDiffModels();

  if (!restore || !origin) {
    return;
  }

  gitPane.value = origin.gitPane;
  await nextTick();

  if (origin.tab === 'files') {
    if (fileData.value && fileSel.value === origin.file) {
      showFile(origin.file, fileData.value);
    }
  } else {
    gitSel.value = origin.gitRef;
    await ensureDiffContent();
  }
}

/**
 * Создаёт новый чат только с черновиком и переводит человека к композеру.
 * Для Git-группы патч одного файла повторно проверяет сервер через точный path.
 */
async function askAgentAboutCode() {
  if (askAgentBusy.value || !canAskAgent.value || !context.value) {
    return;
  }

  const snapshot = captureContext();
  const selectedContext = context.value;
  const entry = tab.value === 'git' ? shownEntry.value : null;
  const relPath = tab.value === 'files' ? fileSel.value : (entry?.file.path || '');

  if (!relPath) {
    return;
  }

  askAgentBusy.value = true;

  try {
    const root = treePath.value.replace(/\/+$/u, '');
    const position = fileEditor?.getPosition?.();
    const line = tab.value === 'files' ? Number(position?.lineNumber) || 1 : 0;
    let patch = '';

    if (entry) {
      const range = entry.group.id === 'commits' ? commitsDiff.value?.range : null;
      const response = await codeApi.patch(snapshot, {
        group: entry.group.id,
        path: entry.file.path,
        ...(range ? rangeQuery(range) : {}),
      });

      if (!contextIsCurrent(snapshot) || gitEntry.value?.file.path !== relPath) {
        return;
      }

      patch = response.patch;
    }

    const draft = askAgentDraft({
      label: draftWorktreeLabel(selectedContext),
      branch: git.value?.branch || selectedContext.branch,
      absPath: `${root}/${relPath}`,
      line,
      ...(tab.value === 'files' ? selectedFileLines() : {}),
      ...(patch ? { patch } : {}),
    });
    const taskId = selectedContext.task.replace(/\D/gu, '');

    const action = {
      ...(taskId ? { taskId } : {}),
      workdir: {
        kind: 'project' as const,
        projectId: project.value,
        repoKey: selectedContext.repoKey
      },
      title: `Код · ${relPath.split('/').at(-1) || relPath}`,
      draft,
    };

    if (!sendCodeWindowAction(action)) {
      chatStore.newSession(action);
      await router.push('/chats');
    }
  } catch (askError) {
    error.value = codeErrorMessage(askError, 'Не удалось создать черновик для агента');
  } finally {
    askAgentBusy.value = false;
  }
}

/**
 * Копирует адрес обычного файла с текущей строкой Monaco. Git-diff адресуется файлом
 * целиком: строка на двух сторонах неоднозначна, поэтому остаётся равной нулю.
 */
async function copyCodeLink() {
  const path = tab.value === 'files' ? fileSel.value : (gitFile.value?.path || '');

  if (!path || !project.value || !repoKey.value || !treePath.value) {
    return;
  }

  const position = tab.value === 'files' ? fileEditor?.getPosition?.() : null;
  const target: CodeTarget = {
    project: project.value,
    repo: repoKey.value,
    root: treePath.value,
    path,
    line: Number(position?.lineNumber) || 0,
  };
  const href = codeLinkHref(target, globalThis.location?.origin || '');
  let copied = false;

  try {
    const writeText = globalThis.navigator?.clipboard?.writeText;

    if (typeof writeText === 'function') {
      await writeText.call(globalThis.navigator.clipboard, href);
      copied = true;
    }
  } catch {
    // HTTP вне localhost и политика браузера штатно закрывают Clipboard API.
  }

  if (!copied) {
    await promptDialog({
      title: 'Ссылка на файл',
      multiline: false,
      text: 'Буфер обмена недоступен. Скопируй адрес вручную.',
      value: href,
      okText: 'Готово',
    });

    return;
  }

  codeLinkCopied.value = true;

  if (codeLinkCopiedTimer) {
    clearTimeout(codeLinkCopiedTimer);
  }

  codeLinkCopiedTimer = setTimeout(() => {
    codeLinkCopied.value = false;
    codeLinkCopiedTimer = null;
  }, 2_000);
}

function toggleGitDir(ref: string) {
  const open = new Set(gitOpenDirs.value);

  if (open.has(ref)) {
    open.delete(ref);
  }
  else {
    open.add(ref);
  }

  gitOpenDirs.value = open;
}

function gitGroupActionKey(group: GitGroupId) {
  return `${group === 'staged' ? 'unstage' : 'stage'}:all`;
}

function gitFileActionKey(group: GitGroupId, path: string) {
  return `${group === 'staged' ? 'unstage' : 'stage'}:${path}`;
}

function gitDirActionKey(group: GitGroupId, dir: string) {
  return `${group === 'staged' ? 'unstage' : 'stage'}:dir:${dir}`;
}

/**
 * Подпись действия каталога называет и каталог, и число его файлов в группе: человек
 * должен понимать, сколько строк уедет одним нажатием.
 */
function gitDirActionLabel(group: GitGroup, dir: string) {
  const count = groupDirectoryFiles(group.files, dir).length;

  return group.id === 'staged'
    ? `Вернуть каталог ${dir} из индекса (${fileCountLabel(count)})`
    : `Добавить каталог ${dir} в индекс (${fileCountLabel(count)})`;
}

function gitGroupActionLabel(group: GitGroupId) {
  return group === 'staged'
    ? 'Вернуть все изменения из индекса'
    : 'Добавить все изменения в индекс';
}

/**
 * Называет обычное перемещение между группами и отдельно объясняет stage конфликта.
 * У конфликтной строки плюс означает признание текущего содержимого разрешённым.
 */
function gitFileActionLabel(group: GitGroupId, file: CodeGitEntry) {
  if (file.status === 'U') {
    return `Пометить разрешённым: ${file.path}`;
  }

  return group === 'staged'
    ? `Вернуть ${file.path} из индекса`
    : `Добавить ${file.path} в индекс`;
}

function gitFileHint(file: CodeGitEntry) {
  return file.status === 'U' ? CONFLICT_HINT : file.path;
}

function discardableGitCount(group: GitGroup) {
  return group.files.filter((file) => file.status !== 'A' && file.status !== 'U').length;
}

function discardGitFileKey(file: CodeGitEntry) {
  return `${file.status === 'A' ? 'clean' : 'discard'}:${file.path}`;
}

function discardGitFileLabel(file: CodeGitEntry) {
  return file.status === 'A'
    ? `Удалить ${file.path}`
    : `Откатить изменения ${file.path}`;
}

/**
 * Разрушительное действие фиксирует контекст до диалога и повторно сверяет его после.
 * Новый файл удаляется через clean, tracked-правка возвращается к индексу через restore.
 */
async function discardGitFile(group: GitGroup, file: CodeGitEntry) {
  if (group.id !== 'work' || file.status === 'U') {
    return null;
  }

  const snapshot = captureContext();
  const clean = file.status === 'A';
  const accepted = await confirmDialog(
    `${clean ? 'Удалить' : 'Откатить'} «${file.path}» без возможности отмены?`,
    {
      title: clean ? 'Удалить новый файл' : 'Откатить изменения',
      okText: clean ? 'Удалить' : 'Откатить',
      danger: true,
    },
  );

  if (!accepted || !contextIsCurrent(snapshot)) {
    return null;
  }

  const action = clean ? 'clean' : 'discard';

  return performGitAction({
    execute: (current) => codeApi[action](current, { paths: [file.path] }),
    key: discardGitFileKey(file),
  });
}

/**
 * Групповой откат считает только tracked-пути: untracked-файлы требуют отдельного
 * подтверждения удаления и никогда не исчезают вслед за общей кнопкой restore.
 */
async function discardGitGroup(group: GitGroup) {
  const changed = discardableGitCount(group);

  if (group.id !== 'work' || !changed) {
    return null;
  }

  const snapshot = captureContext();
  const accepted = await confirmDialog(
    `Откатить tracked-файлы (${changed}) без возможности отмены?`,
    {
      title: 'Откатить изменения',
      okText: 'Откатить',
      danger: true,
    },
  );

  if (!accepted || !contextIsCurrent(snapshot)) {
    return null;
  }

  return performGitAction({
    execute: (current) => codeApi.discard(current, { all: true }),
    key: 'discard:all',
  });
}

/**
 * Выполняет одну Git-команду для точного снимка рабочей копии и при необходимости
 * перечитывает обе группы. Поздний ответ старого worktree не меняет новый выбор.
 */
async function performGitAction<Result>({
  execute,
  key,
  refreshGit = true,
  onSuccess,
}: GitActionOptions<Result>): Promise<Result | null> {
  if (gitActionBusy.value || !treePath.value) {
    return null;
  }

  const snapshot = captureContext();
  const own = ++gitActionId;

  gitBusy.value = key;
  gitNotice.value = null;

  try {
    const result = await execute(snapshot);

    if (!contextIsCurrent(snapshot) || own !== gitActionId) {
      return null;
    }

    onSuccess?.(result);

    if (refreshGit) {
      await loadGit(snapshot, { silent: true });
    }

    return result;
  } catch (actionError) {
    if (contextIsCurrent(snapshot) && own === gitActionId) {
      gitNotice.value = {
        type: 'err',
        text: codeErrorMessage(actionError),
      };
    }

    return null;
  } finally {
    if (contextIsCurrent(snapshot) && own === gitActionId) {
      gitBusy.value = '';
    }
  }
}

/**
 * Переносит целую изменяемую группу в индекс или обратно.
 * Группа выбранных коммитов остаётся только для чтения.
 */
function changeGitGroup(group: GitGroup) {
  if (!group.mutable) {
    return null;
  }

  const action = group.id === 'staged' ? 'unstage' : 'stage';

  return performGitAction({
    execute: (snapshot) => codeApi[action](snapshot, { all: true }),
    key: gitGroupActionKey(group.id),
  });
}

// Сервер принимает не больше стольких путей за одно действие (ACTION_PATHS_MAX).
const GIT_ACTION_PATHS_MAX = 500;

/**
 * Переносит все файлы каталога в индекс или обратно. Пути берутся из свежей группы,
 * поэтому сервер сверит каждый; каталог больше потолка уходит последовательными порциями.
 */
function changeGitDir(group: GitGroup, dir: string) {
  if (!group.mutable) {
    return null;
  }

  const action = group.id === 'staged' ? 'unstage' : 'stage';
  const paths = groupDirectoryFiles(group.files, dir);

  if (!paths.length) {
    return null;
  }

  return performGitAction({
    execute: async (snapshot) => {
      let changed = 0;

      for (const chunk of chunkList(paths, GIT_ACTION_PATHS_MAX)) {
        const result = await codeApi[action](snapshot, { paths: chunk });

        changed += result.changed;
      }

      return { ok: true as const, changed };
    },
    key: gitDirActionKey(group.id, dir),
  });
}

/**
 * Переносит одну проверенную строку изменяемой группы в индекс или обратно.
 * Сервер повторно сверяет путь со свежим снимком перед мутацией.
 */
function changeGitFile(group: GitGroup, file: CodeGitEntry) {
  if (!group.mutable) {
    return null;
  }

  const action = group.id === 'staged' ? 'unstage' : 'stage';

  return performGitAction({
    execute: (snapshot) => codeApi[action](snapshot, { paths: [file.path] }),
    key: gitFileActionKey(group.id, file.path),
  });
}

function generateCommitMessage() {
  if (!git.value?.staged?.length) {
    return null;
  }

  return performGitAction({
    execute: (snapshot) => codeApi.commitMessage(snapshot),
    key: 'generate',
    refreshGit: false,
    onSuccess: (result) => {
      commitMessage.value = result.title;
      gitNotice.value = {
        type: 'ok',
        text: `Название составлено · ${result.model}`,
      };
    },
  });
}

/**
 * В многострочном поле Enter принадлежит тексту: им набирают тело сообщения.
 * Коммит вешается на Ctrl/Cmd+Enter — та же пара, что в Source Control VS Code;
 * пока поле было однострочным, ту же работу делал голый Enter.
 */
function commitOnShortcut(event: KeyboardEvent) {
  if (!event.ctrlKey && !event.metaKey) {
    return;
  }

  event.preventDefault();
  commitGitChanges();
}

function toggleCommitComposer() {
  commitComposerOpen.value = !commitComposerOpen.value;
  commitComposerTouched.value = true;
}

function leaveAmend() {
  amendCommit.value = false;
}

/**
 * Подставляет полное сообщение HEAD только при включении amend.
 * Уже введённый человеком и не совпадающий с прежним HEAD текст остаётся нетронутым.
 */
function changeAmend(event: Event) {
  const enabled = (event.target as HTMLInputElement | null)?.checked === true;

  if (!enabled) {
    return;
  }

  const previous = amendHeadMessage.value;
  const next = git.value?.headMessage || '';

  if (!commitMessage.value.trim() || commitMessage.value === previous) {
    commitMessage.value = next;
  }

  amendHeadMessage.value = next;
}

/**
 * Фиксирует режим до сетевого вызова: даже если переключатель изменится во время
 * запроса, сервер получит намерение именно того нажатия, которое запустило действие.
 */
function commitGitChanges() {
  const message = commitMessage.value.trim();

  if ((!amendCommit.value && !git.value?.staged?.length) || !message) {
    return null;
  }

  const amend = amendCommit.value;

  return performGitAction({
    execute: (snapshot) => codeApi.commit(snapshot, message, { amend }),
    key: 'commit',
    onSuccess: (result) => {
      commitMessage.value = '';
      amendCommit.value = false;
      gitNotice.value = {
        type: 'ok',
        text: `Создан коммит ${result.hash}: ${result.subject}`,
      };
    },
  });
}

function pushGitChanges() {
  if (git.value?.tracking?.detached) {
    return null;
  }

  return performGitAction({
    execute: (snapshot) => codeApi.push(snapshot),
    key: 'push',
    onSuccess: (result) => {
      gitNotice.value = {
        type: 'ok',
        text: result.published
          ? `Ветка ${result.branch} опубликована и связана с remote.`
          : `Ветка ${result.branch} отправлена.`,
      };
    },
  });
}

/**
 * Fetch не меняет рабочую ветку: сервер обновляет только refs выбранного remote,
 * а клиент подменяет tracking из ответа без второго чтения тяжёлого списка diff.
 */
function fetchGitRemote() {
  if (!fetchRemoteLabel.value) {
    return null;
  }

  return performGitAction({
    execute: (snapshot) => codeApi.fetch(snapshot),
    key: 'fetch',
    refreshGit: false,
    onSuccess: (result) => {
      if (git.value) {
        git.value = { ...git.value, tracking: result.tracking };
      }
    },
  });
}

/**
 * Отмена HEAD всегда подтверждается после фиксации контекста рабочей копии.
 * После диалога ещё раз проверяется, что человек не успел перейти в другое дерево.
 */
async function undoGitCommit() {
  if (!undoAvailable.value) {
    return null;
  }

  const snapshot = captureContext();
  const accepted = await confirmDialog(
    'Отменить последний коммит? Его изменения вернутся в индекс.',
    {
      title: 'Отменить последний коммит',
      okText: 'Отменить коммит',
      danger: true,
    },
  );

  if (!accepted || !contextIsCurrent(snapshot)) {
    return null;
  }

  return performGitAction({
    execute: (current) => codeApi.undoCommit(current),
    key: 'undo',
    onSuccess: (result) => {
      amendCommit.value = false;
      commitMessage.value = result.message;
      gitNotice.value = {
        type: 'ok',
        text: 'Последний коммит отменён; изменения возвращены в индекс.',
      };
    },
  });
}

/**
 * Записывает каталог только для актуальной рабочей копии и последнего запроса.
 * Отказ сохраняет прежнее дерево, чтобы тихое обновление не очищало навигацию.
 */
async function loadDir(
  rel: string,
  snapshot = captureContext(),
  { activation = null }: ActivationOptions = {},
) {
  const requestId = (dirRequestIds.get(rel) || 0) + 1;

  dirRequestIds.set(rel, requestId);

  try {
    const entries = await codeApi.list(snapshot, rel);

    if (!activationIsCurrent(activation)
      || !contextIsCurrent(snapshot) || dirRequestIds.get(rel) !== requestId) {
      return false;
    }

    const next = new Map(dirs.value);

    next.set(rel, entries || []);
    dirs.value = next;

    return true;
  } catch (e) {
    if (activationIsCurrent(activation)
      && contextIsCurrent(snapshot) && dirRequestIds.get(rel) === requestId) {
      error.value = codeErrorMessage(e);
    }

    return false;
  }
}

/**
 * Раскрывает ленивый каталог только после успешного чтения его содержимого.
 * Сворачивание уже открытого каталога обходится без сетевого запроса.
 */
async function toggleDir(rel: string) {
  const open = new Set(openDirs.value);

  if (open.has(rel)) {
    open.delete(rel);
    openDirs.value = open;

    return;
  }
  if (!dirs.value.has(rel) && !(await loadDir(rel))) {
    return;
  }

  open.add(rel);
  openDirs.value = open;
}

// Плоские строки видимой части дерева — из раскрытых каталогов.
const rows = computed(() => {
  const out: FileTreeRow[] = [];
  /**
   * Строит строки только для раскрытой части ленивого дерева.
   * Глубина передаётся стилям, чтобы шаг отступов оставался единым.
   */
  const walk = (rel: string, depth: number) => {
    for (const e of dirs.value.get(rel) || []) {
      const p = rel ? `${rel}/${e.name}` : e.name;

      out.push({
        name: e.name,
        dir: e.dir,
        rel: p,
        depth
      });

      if (e.dir && openDirs.value.has(p)) {
        walk(p, depth + 1);
      }
    }
  };

  walk('', 0);

  return out;
});

/**
 * Сбрасывает поиск вместе с debounce и инвалидирует уже отправленный запрос.
 * Смена рабочей копии поэтому не может вернуть результаты прежнего дерева.
 */
function resetSearch() {
  if (searchTimer) {
    clearTimeout(searchTimer);
    searchTimer = null;
  }

  searchRequestId += 1;
  searchQuery.value = '';
  searchResult.value = null;
  searchLoading.value = false;
  searchError.value = '';
}

/**
 * Отправляет отложенный запрос для одного снимка и принимает только последнюю строку.
 * Новый ввод сразу лишает поздний ответ прежнего запроса права менять список.
 */
async function executeSearch(query: string, snapshot: ContextSnapshot, own: number) {
  try {
    const response = await codeApi.search(snapshot, query);

    if (!contextIsCurrent(snapshot) || own !== searchRequestId || searchQuery.value !== query) {
      return;
    }

    searchResult.value = response;
  } catch (searchLoadError) {
    if (contextIsCurrent(snapshot) && own === searchRequestId && searchQuery.value === query) {
      searchError.value = codeErrorMessage(searchLoadError, 'Не удалось выполнить поиск');
    }
  } finally {
    if (contextIsCurrent(snapshot) && own === searchRequestId) {
      searchLoading.value = false;
    }
  }
}

/**
 * Debounce начинает поиск только со второго символа. До сетевого вызова request id
 * уже закреплён, поэтому следующая клавиша безопасно отменяет ожидающий таймер.
 */
function scheduleSearch(query: string) {
  if (searchTimer) {
    clearTimeout(searchTimer);
    searchTimer = null;
  }

  const own = ++searchRequestId;

  searchResult.value = null;
  searchError.value = '';

  if (query.length < 2 || !treePath.value) {
    searchLoading.value = false;

    return;
  }

  searchLoading.value = true;
  searchTimer = setTimeout(() => {
    searchTimer = null;
    void executeSearch(query, captureContext(), own);
  }, SEARCH_DELAY_MS);
}

/** Открывает результат штатным файловым путём и откладывает reveal до модели Monaco. */
async function openSearchResult(relPath: string, line: number) {
  pendingReveal = {
    path: relPath,
    line: Math.max(1, line),
  };

  const opened = await openFile(relPath);

  if (opened !== true && pendingReveal?.path === relPath) {
    pendingReveal = null;
  }
}

/**
 * Enter повторяет визуальный порядок: первый файл, затем первое совпадение.
 * Пустой принятый ответ оставляет редактор и выбор без изменений.
 */
function openFirstSearchResult() {
  const file = searchResult.value?.files[0];
  const match = searchResult.value?.matches[0];

  if (file) {
    void openSearchResult(file.path, 1);
  } else if (match) {
    void openSearchResult(match.path, match.line);
  }
}

watch(searchQuery, scheduleSearch);

/**
 * Другой файл сначала снимает прежнюю модель, чтобы заголовок совпадал с содержимым.
 * Обновление того же пути сохраняет валидный снимок до проверенного ответа.
 */
async function openFile(rel: string, { silent = false, activation = null }: RefreshOptions = {}) {
  if (!activationIsCurrent(activation)) {
    return;
  }

  showNarrowEditor();

  const snapshot = captureContext();
  const requestId = ++fileRequestId;

  if (fileSel.value !== rel) {
    fileData.value = null;
    resetBlameView();
    clearFileModel();
  }

  fileSel.value = rel;
  imageError.value = '';

  if (!silent) {
    fileLoadingRequestId = requestId;
    fileLoading.value = true;
  }

  try {
    const data = await codeApi.file(snapshot, rel);

    if (!activationIsCurrent(activation)
      || !contextIsCurrent(snapshot) || fileRequestId !== requestId || fileSel.value !== rel) {
      return;
    }

    fileData.value = data;
    await nextTick();

    if (activationIsCurrent(activation)
      && contextIsCurrent(snapshot) && fileRequestId === requestId && fileSel.value === rel) {
      showFile(rel, data);

      if (blameEnabled.value && fileSupportsBlame(rel, data)) {
        void loadBlame(snapshot, rel);
      } else {
        resetBlameView();
      }
    }

    return true;
  } catch (e) {
    const current = activationIsCurrent(activation)
      && contextIsCurrent(snapshot) && fileRequestId === requestId && fileSel.value === rel;

    if (!current) {
      return;
    }

    error.value = codeErrorMessage(e);
    // Только 404 подтверждает, что прежний файл больше нельзя показывать. При
    // сетевой/серверной ошибке последний валидный снимок остаётся на месте.
    return e !== null && typeof e === 'object' && 'status' in e && e.status === 404 ? false : null;
  } finally {
    // Владелец индикатора отделён от latest request: тихая revalidation может
    // вытеснить запрос по id, но не должна навсегда оставить «читаю…».
    if (!silent && fileLoadingRequestId === requestId) {
      fileLoadingRequestId = 0;
      fileLoading.value = false;
    }
  }
}

/**
 * Сбрасывает снимок сторон и лишает поздний file-diff права вернуть старую модель.
 * Ручной refresh может сохранить модель до принятия нового списка.
 */
function resetDiffContent({ clearModels = true } = {}) {
  diffContent.value = new Map();
  diffError.value = '';
  diffLoading.value = false;
  diffRequestId += 1;
  patchContent.value = new Map();
  patchReviewKey.value = '';
  patchReviewGroupId.value = null;
  patchLoading.value = false;
  patchError.value = '';
  patchRequestId += 1;

  if (clearModels) {
    clearDiffModels();
  }
}

/**
 * Подгружает стороны выбранной строки один раз на снимок. Ключ включает commit-range,
 * поэтому одинаковый путь из рабочего дерева и истории не делит чужое содержимое.
 */
async function ensureDiffContent(entry = shownEntry.value) {
  if (!entry) {
    clearDiffModels();

    return;
  }

  // Ответ принимается для той строки, что выбрана сейчас: в режиме «+ текущие» это может
  // быть строка рабочего дерева, а сам диф — из группы коммитов.
  const selectedRef = gitSel.value;

  const range = entry.group.id === 'commits' ? commitsDiff.value?.range : null;

  if (entry.group.id === 'commits' && !range) {
    return;
  }

  const rangeKey = range ? rangeCacheKey(range) : '';
  const key = fileDiffKey(entry.group.id, entry.file.path, rangeKey);
  const cached = diffContent.value.get(key);

  if (cached) {
    showDiff({ ...entry.file, ...cached });

    return;
  }

  const snapshot = captureContext();
  const own = ++diffRequestId;

  diffLoading.value = true;
  diffError.value = '';
  clearDiffModels();

  try {
    const content = await codeApi.fileDiff(snapshot, {
      group: entry.group.id,
      path: entry.file.path,
      ...(range ? rangeQuery(range) : {}),
    });

    if (!contextIsCurrent(snapshot) || own !== diffRequestId || gitSel.value !== selectedRef) {
      return;
    }

    const next = new Map(diffContent.value);

    next.set(key, content);
    diffContent.value = next;
    showDiff({ ...entry.file, ...content });
  } catch (diffFailure) {
    if (contextIsCurrent(snapshot) && own === diffRequestId) {
      diffError.value = codeErrorMessage(diffFailure, 'Не удалось прочитать диф файла');
    }
  } finally {
    if (contextIsCurrent(snapshot) && own === diffRequestId) {
      diffLoading.value = false;
    }
  }
}

/**
 * Ключ staged/work принадлежит текущему Git-снимку, а commits дополнительно включает
 * диапазон: одинаковая группа разных выбранных коммитов не делит патч.
 */
function patchKey(group: GitGroup): string {
  const range = group.id === 'commits' ? commitsDiff.value?.range : null;

  return range
    ? `${group.id}:${rangeCacheKey(range)}`
    : group.id;
}

/**
 * Закрывает обзор и лишает уже летящий ответ права вернуть его на экран.
 * Сам кеш очищает только смена Git-снимка в resetDiffContent.
 */
function clearPatchReview() {
  patchReviewKey.value = '';
  patchReviewGroupId.value = null;
  patchLoading.value = false;
  patchError.value = '';
  patchRequestId += 1;
}

/**
 * Загружает полный patch группы один раз на текущий Git-снимок.
 * Повторный клик по активной кнопке возвращает обычный Monaco-диф.
 */
async function openPatchReview(group: GitGroup) {
  if (!group.files.length) {
    return;
  }

  showNarrowEditor();

  const key = patchKey(group);

  if (patchReviewKey.value === key) {
    await closePatchReview();

    return;
  }

  const range = group.id === 'commits' ? commitsDiff.value?.range : null;

  if (group.id === 'commits' && !range) {
    return;
  }

  const snapshot = captureContext();
  const own = ++patchRequestId;

  patchReviewKey.value = key;
  patchReviewGroupId.value = group.id;
  patchError.value = '';
  clearDiffModels();

  if (patchContent.value.has(key)) {
    patchLoading.value = false;

    return;
  }

  patchLoading.value = true;

  try {
    const response = await codeApi.patch(snapshot, {
      group: group.id,
      ...(range ? rangeQuery(range) : {}),
    });

    if (!contextIsCurrent(snapshot) || own !== patchRequestId || patchReviewKey.value !== key) {
      return;
    }

    const next = new Map(patchContent.value);

    next.set(key, response);
    patchContent.value = next;
  } catch (reviewError) {
    if (contextIsCurrent(snapshot) && own === patchRequestId && patchReviewKey.value === key) {
      patchError.value = codeErrorMessage(reviewError, 'Не удалось собрать обзор изменений');
    }
  } finally {
    if (contextIsCurrent(snapshot) && own === patchRequestId && patchReviewKey.value === key) {
      patchLoading.value = false;
    }
  }
}

async function closePatchReview() {
  clearPatchReview();
  await nextTick();
  await ensureDiffContent();
}

/**
 * Возвращает Monaco-диф выбранного файла из обзора.
 * Клик по строке дополнительно прокручивает ту сторону, чей номер был показан.
 */
async function openPatchReviewFile(path: string, line: number, side: 'old' | 'new') {
  const group = patchReviewGroup.value;

  if (!group || !group.files.some((file) => file.path === path)) {
    return;
  }

  clearPatchReview();
  await nextTick();
  await selectGit(gitRef(group.id, path));

  if (line > 0) {
    const editor = side === 'old'
      ? diffEditor?.getOriginalEditor?.()
      : diffEditor?.getModifiedEditor?.();

    editor?.setPosition({ lineNumber: line, column: 1 });
    editor?.revealLineInCenter(line);
  }
}

/**
 * Синхронизирует общий diff выбранного отрезка. Неудача оставляет последнюю принятую
 * группу и Monaco-модель, а request id отбрасывает поздний ответ прежнего выбора.
 */
async function syncCommitsDiff(snapshot = captureContext()) {
  const bounds = selectedCommitBounds.value;

  if (!bounds) {
    if (patchReviewGroupId.value === 'commits') {
      clearPatchReview();
    }

    commitsRequestId += 1;
    commitsDiff.value = null;
    commitsLoadedSelection.value = null;
    commitsLoadedKey = '';
    commitsLoading.value = false;
    commitsError.value = '';

    if (gitEntry.value?.group.id === 'commits' || gitSel.value.startsWith('commits:')) {
      gitSel.value = firstGitRef();
      await nextTick();
      await ensureDiffContent();
    }

    return;
  }

  const work = commitsWorkActive.value;
  const key = `${bounds.from}:${bounds.to}${work ? ':work' : ''}`;

  if (commitsLoadedKey === key && commitsDiff.value && !commitsError.value) {
    commitsLoadedSelection.value = { ...bounds, selected: commitSel.value.size };

    return;
  }

  if (patchReviewGroupId.value === 'commits') {
    clearPatchReview();
  }

  const own = ++commitsRequestId;

  commitsLoading.value = true;
  commitsError.value = '';

  try {
    const nextDiff = await codeApi.commitsDiff(snapshot, bounds.from, bounds.to, { work });
    const current = selectedCommitBounds.value;
    const currentKey = current
      ? `${current.from}:${current.to}${commitsWorkActive.value ? ':work' : ''}`
      : '';

    if (!contextIsCurrent(snapshot) || own !== commitsRequestId || currentKey !== key) {
      return;
    }

    commitsDiff.value = nextDiff;
    commitsLoadedKey = key;
    commitsLoadedSelection.value = { ...bounds, selected: commitSel.value.size };

    const nextDirs = gitGroupDirectoryPaths(git.value, commitGroup.value);

    gitOpenDirs.value = reconcileGitOpenDirs(nextDirs, gitOpenDirs.value, gitKnownDirs.value);
    gitKnownDirs.value = nextDirs;

    await nextTick();

    const first = commitGroup.value?.files[0];

    gitSel.value = first ? gitRef('commits', first.path) : '';
    await nextTick();
    await ensureDiffContent();
  } catch (rangeFailure) {
    if (contextIsCurrent(snapshot) && own === commitsRequestId) {
      commitsError.value = codeErrorMessage(rangeFailure, 'Не удалось прочитать выбранные коммиты');
    }
  } finally {
    if (contextIsCurrent(snapshot) && own === commitsRequestId) {
      commitsLoading.value = false;
    }
  }
}

/**
 * Загружает все собственные коммиты ветки тем же представлением, что и ручной
 * отрезок, и отбрасывает ответ уже покинутой рабочей копии.
 */
async function loadBranchDiff(snapshot = captureContext()) {
  if (!branchDiffAvailability.value.enabled) {
    return;
  }

  const own = ++commitsRequestId;

  if (patchReviewGroupId.value === 'commits') {
    clearPatchReview();
  }

  branchMode.value = true;
  commitSel.value = new Set();
  commitAnchor.value = '';
  commitsDiff.value = null;
  commitsLoadedSelection.value = null;
  commitsLoadedKey = '';
  commitsLoading.value = true;
  commitsError.value = '';

  try {
    const nextDiff = await codeApi.branchDiff(snapshot, { work: commitsWithWork.value });

    if (!contextIsCurrent(snapshot) || own !== commitsRequestId || !branchMode.value) {
      return;
    }

    commitsDiff.value = nextDiff;

    const nextDirs = gitGroupDirectoryPaths(git.value, commitGroup.value);

    gitOpenDirs.value = reconcileGitOpenDirs(nextDirs, gitOpenDirs.value, gitKnownDirs.value);
    gitKnownDirs.value = nextDirs;

    await nextTick();

    const first = commitGroup.value?.files[0];

    gitSel.value = first ? gitRef('commits', first.path) : '';
    await nextTick();
    await ensureDiffContent();
  } catch (branchFailure) {
    if (contextIsCurrent(snapshot) && own === commitsRequestId) {
      commitsError.value = codeErrorMessage(branchFailure, 'Не удалось прочитать всю ветку');
    }
  } finally {
    if (contextIsCurrent(snapshot) && own === commitsRequestId) {
      commitsLoading.value = false;
    }
  }
}

/**
 * Переключает «с текущими изменениями» и перечитывает уже показанный отрезок или ветку.
 * Настройка живёт на устройстве; при недоступном режиме клик ничего не меняет.
 */
async function toggleCommitsWork() {
  if (!commitsWorkAvailable.value) {
    return;
  }

  commitsWithWork.value = !commitsWithWork.value;
  localStorage.setItem('grigdesk-code-commits-work', commitsWithWork.value ? '1' : '0');

  if (branchMode.value) {
    return loadBranchDiff();
  }
  if (selectedCommitBounds.value) {
    commitsLoadedKey = '';

    return syncCommitsDiff();
  }
}

/**
 * Повторное нажатие закрывает режим ветки и возвращает первый рабочий diff,
 * не сохраняя веточный диапазон в кеше выбранных коммитов.
 */
async function toggleBranchDiff() {
  if (!branchMode.value) {
    return loadBranchDiff();
  }

  branchMode.value = false;
  commitsDiff.value = null;
  commitsError.value = '';
  commitsRequestId += 1;
  gitSel.value = firstGitRef();
  await nextTick();

  return ensureDiffContent();
}

/**
 * Клик без модификатора переключает строку, Shift добавляет видимый промежуток.
 * Любой выбор строки завершает режим целой ветки до запроса нового отрезка.
 */
function pickCommit(entry: CodeGitResponse['log'][number], event: MouseEvent) {
  if (branchMode.value) {
    branchMode.value = false;
    commitsDiff.value = null;
    commitsLoadedSelection.value = null;
    commitsLoadedKey = '';
  }

  commitSel.value = event.shiftKey
    ? extendCommitSelection(git.value?.log || [], commitSel.value, commitAnchor.value, entry.hash)
    : toggleCommitSelection(commitSel.value, entry.hash);
  commitAnchor.value = entry.hash;

  return syncCommitsDiff();
}

/**
 * Снимает выбор и режим ветки, затем возвращает первый файл рабочего снимка.
 * Один путь очистки не оставляет старый commit-range в Monaco.
 */
function clearCommitSelection() {
  branchMode.value = false;
  commitSel.value = new Set();
  commitAnchor.value = '';

  return syncCommitsDiff();
}

/**
 * Принимает проверенный снимок Git целиком, сохраняя раскрытие и выбор файла.
 * Поздние ответы другой рабочей копии не создают модели в текущем редакторе.
 */
async function loadGit(
  snapshot = captureContext(),
  {
    silent = false,
    activation = null,
    metadataOnly = false,
  }: RefreshOptions & { metadataOnly?: boolean } = {},
) {
  if (!activationIsCurrent(activation)) {
    return;
  }

  const requestId = ++gitRequestId;

  if (!silent) {
    gitLoadingRequestId = requestId;
    gitLoading.value = true;
  }

  try {
    const nextGit = await codeApi.git(snapshot);

    if (!activationIsCurrent(activation)
      || !contextIsCurrent(snapshot) || gitRequestId !== requestId) {
      return;
    }

    const previousSelection = commitSel.value;
    const nextSelection = pruneCommitSelection(nextGit.log, previousSelection);

    commitSel.value = nextSelection;

    const nextDirs = gitGroupDirectoryPaths(nextGit, commitGroup.value);

    gitOpenDirs.value = reconcileGitOpenDirs(
      nextDirs,
      gitDirsReady.value ? gitOpenDirs.value : undefined,
      gitDirsReady.value ? gitKnownDirs.value : undefined,
    );
    gitKnownDirs.value = nextDirs;
    gitDirsReady.value = true;
    git.value = nextGit;
    resetDiffContent();

    if (gitSel.value && !gitEntries.value.has(gitSel.value)) {
      gitSel.value = '';
    }
    if (!gitSel.value) {
      gitSel.value = firstGitRef();
    }

    await nextTick();

    if (!activationIsCurrent(activation)
      || !contextIsCurrent(snapshot) || gitRequestId !== requestId) {
      return;
    }

    if (metadataOnly) {
      return;
    }

    const selectionChanged = previousSelection.size !== nextSelection.size
      || [...previousSelection].some((hash) => !nextSelection.has(hash));

    if (branchMode.value) {
      await loadBranchDiff(snapshot);
    } else if (selectionChanged || (!nextSelection.size && commitsDiff.value)) {
      await syncCommitsDiff(snapshot);
    } else if (nextSelection.size && !commitsDiff.value) {
      await syncCommitsDiff(snapshot);
    } else {
      await ensureDiffContent();
    }
  } catch (e) {
    if (activationIsCurrent(activation)
      && contextIsCurrent(snapshot) && gitRequestId === requestId) {
      error.value = codeErrorMessage(e);
    }
  } finally {
    if (!silent && gitLoadingRequestId === requestId) {
      gitLoadingRequestId = 0;
      gitLoading.value = false;
    }
  }
}

/**
 * Меняет выбранный диф после обновления DOM.
 * Проверка контекста и ключа не даёт ожиданию восстановить уже покинутый выбор.
 */
async function selectGit(ref: string) {
  const snapshot = captureContext();

  showNarrowEditor();

  if (patchReviewActive.value) {
    clearPatchReview();
  }

  if (gitSel.value !== ref) {
    clearDiffModels();
    diffError.value = '';
  }

  gitSel.value = ref;
  await nextTick();

  if (contextIsCurrent(snapshot) && gitSel.value === ref) {
    await ensureDiffContent();
  }
}

let refreshInFlight = false;
let refreshAfterFlight = false;
let refreshAfterSilent = true;

/**
 * Перечитывает активный режим поверх последнего корректного снимка.
 * Удаление выбранного файла подтверждает только 404, а не временная ошибка сети.
 */
async function refresh({
  silent = false,
  activation = null,
  contentOnly = false,
}: RefreshOptions = {}) {
  if (!treePath.value) {
    return;
  }

  const snapshot = captureContext();

  if (tab.value === 'git') {
    if (!silent) {
      resetDiffContent({ clearModels: false });
    }
    if (!silent || !gitLoading.value) {
      await loadGit(snapshot, { silent, activation });
    }

    return;
  }
  // Файлы перечитываем поверх последнего валидного снимка. Очищение до ответа
  // давало заметный белый кадр при повторном открытии панели.
  const selected = fileSel.value;

  if (contentOnly) {
    await loadGit(snapshot, {
      silent,
      activation,
      metadataOnly: true,
    });

    if (!activationIsCurrent(activation) || !contextIsCurrent(snapshot)) {
      return;
    }
    if (selected && (!silent || !fileLoading.value)) {
      await openFile(selected, { silent, activation });
    }

    return;
  }

  const open = [...openDirs.value];

  if (!(await loadDir('', snapshot, { activation }))
    || !activationIsCurrent(activation) || !contextIsCurrent(snapshot)) {
    return;
  }

  for (const rel of open) {
    await loadDir(rel, snapshot, { activation });

    if (!activationIsCurrent(activation) || !contextIsCurrent(snapshot)) {
      return;
    }
  }

  await loadGit(snapshot, {
    silent,
    activation,
    metadataOnly: true,
  });

  if (!activationIsCurrent(activation) || !contextIsCurrent(snapshot)) {
    return;
  }

  if (silent && fileLoading.value) {
    return;
  }

  const fileResult = selected && fileSel.value === selected
    ? await openFile(selected, { silent, activation })
    : undefined;

  if (fileResult === false && activationIsCurrent(activation)
    && contextIsCurrent(snapshot) && fileSel.value === selected) {
    fileSel.value = '';
    fileData.value = null;
    clearFileModel();
  }
}

/**
 * Сериализует ручные и фоновые поводы обновления. Все сигналы поверх летящего
 * запроса схлопываются в один повтор; ручной повод делает повтор видимым.
 */
async function requestRefresh({ silent = false }: Pick<RefreshOptions, 'silent'> = {}) {
  if (!props.active || !treePath.value) {
    return;
  }
  if (refreshInFlight) {
    refreshAfterFlight = true;
    refreshAfterSilent = refreshAfterSilent && silent;

    return;
  }

  refreshInFlight = true;

  let nextSilent = silent;

  try {
    do {
      refreshAfterFlight = false;
      refreshAfterSilent = true;
      await refresh({ silent: nextSilent, contentOnly: true });
      nextSilent = refreshAfterSilent;
    } while (refreshAfterFlight && props.active);
  } finally {
    refreshInFlight = false;
    refreshAfterFlight = false;
    refreshAfterSilent = true;
  }
}

/** Возврат браузерной вкладки перечитывает только активную панель. */
function refreshWhenVisible() {
  if (document.visibilityState === 'visible') {
    requestRefresh({ silent: true });
  }
}

useSse((name) => {
  if (name === 'projects-changed' || name === 'hello') {
    void activate({ preserve: true });
  }

  if (name === 'chat-done') {
    requestRefresh({ silent: true });
  }
});

/**
 * Освобождает файловую модель вместе с относящимися к ней blame-декорациями.
 * Сам принятый ответ сохраняется для возврата из исторического diff.
 */
function clearFileModel() {
  removeBlameDecorations();
  fileEditor?.setModel(null);
  fileModel?.dispose();
  fileModel = null;
}

function clearDiffModels() {
  diffEditor?.setModel(null);
  diffModels.forEach((model) => model.dispose());
  diffModels = [];
}

/**
 * Подключает новую read-only модель до освобождения прежней.
 * Для растровых изображений модель не создаётся: предпросмотром владеет img.
 */
function showFile(rel: string, data: CodeFileResponse) {
  // Картинку показывает <img>, а не редактор: пустая модель Monaco под ней только
  // мигала бы курсором и держала ресурсы.
  if (isImagePath(rel)) {
    clearFileModel();

    return;
  }
  if (!fileHost.value || !data) {
    return;
  }
  if (!fileEditor) {
    fileEditor = monaco.editor.create(fileHost.value, {
      ...READONLY_OPTS,
      fontSize: 13,
      lineHeight: 20,
      padding: { top: 8, bottom: 8 },
      renderLineHighlight: 'none',
    });
    installBlameClick();
    fileEditor.onDidChangeCursorPosition?.(publishCodeContext);
  }

  const model = monaco.editor.createModel(data.binary || data.tooBig ? '' : data.content, langOf(rel));

  fileEditor.setModel(model);
  fileModel?.dispose(); // старую модель снимаем ПОСЛЕ переустановки (иначе варнинг Monaco)
  fileModel = model;

  if (blamePath.value === rel) {
    applyBlameDecorations();
  }

  if (pendingReveal && pendingReveal.path === rel) {
    revealLine(pendingReveal.line);
    pendingReveal = null;
  }

  // Новая модель уже стоит на строке 1: Monaco может не сообщить о таком же курсоре.
  // Контекст публикуется после модели и перехода, включая повторное открытие того же файла.
  publishCodeContext();
}

/** Ссылка вида `file.js:120` открывает файл на нужной строке и подсвечивает её. */
function revealLine(line: number) {
  if (!fileEditor || !(line > 0)) {
    return;
  }

  fileEditor.revealLineInCenter(line);
  fileEditor.setPosition({ lineNumber: line, column: 1 });
}

/**
 * Создаёт обе стороны read-only дифа и затем освобождает прежние модели.
 * Редактор переиспользуется между файлами и получает актуальный режим колонок.
 */
function showDiff(f: CodeGitFile | null) {
  if (!f || !diffHost.value) {
    return;
  }
  if (!diffEditor) {
    diffEditor = monaco.editor.createDiffEditor(diffHost.value, {
      ...READONLY_OPTS,
      fontSize: 13,
      lineHeight: 20,
      padding: { top: 8, bottom: 8 },
      renderSideBySide: renderSideBySide.value,
      diffWordWrap: diffWrap.value ? 'on' : 'off',
      renderOverviewRuler: true,
      ignoreTrimWhitespace: ignoreTrimWhitespace.value,
      hideUnchangedRegions: {
        enabled: true,
        minimumLineCount: 3,
        contextLineCount: 3
      },
    });
  }

  const lang = langOf(f.path);
  const orig = monaco.editor.createModel(f.tooBig ? '' : (f.oldContent || ''), lang);
  const mod = monaco.editor.createModel(f.tooBig ? '' : (f.newContent || ''), lang);
  const old = diffModels;

  diffModels = [orig, mod];
  diffEditor.setModel({ original: orig, modified: mod });
  old.forEach((m) => m.dispose());
}

watch(renderSideBySide, async (value) => {
  diffEditor?.updateOptions?.({ renderSideBySide: value });
  await nextTick();
  layoutEditors();
});
watch(diffWrap, async (value) => {
  diffEditor?.updateOptions?.({ diffWordWrap: value ? 'on' : 'off' });
  await nextTick();
  layoutEditors();
});
watch(ignoreTrimWhitespace, (value) => {
  diffEditor?.updateOptions?.({ ignoreTrimWhitespace: value });
});
watch(() => props.compact, async () => {
  await nextTick();
  diffEditor?.updateOptions?.({ renderSideBySide: renderSideBySide.value });
  layoutEditors();
});

let initialized = false;
let activationId = 0;
let processingIntents = false;
const handledIntentIds = new Set<number>();

/**
 * Legacy-очередь дока передаёт неизвестный payload. Исполняются только точные
 * команды «Кода»; повреждённая команда с корректным id потребляется один раз.
 */
function decodeIntent(value: unknown): IntentEnvelope | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !('id' in value)
    || typeof value.id !== 'number' || !Number.isSafeInteger(value.id) || value.id <= 0) {
    return null;
  }

  const id = value.id;

  if (!('type' in value)) {
    return { id, payload: null };
  }
  if (value.type === 'project' && 'project' in value && typeof value.project === 'string') {
    return { id, payload: { type: 'project', project: value.project } };
  }
  if (value.type !== 'open-file'
    || !('repo' in value) || typeof value.repo !== 'string' || !value.repo
    || !('root' in value) || typeof value.root !== 'string' || !value.root
    || !('path' in value) || typeof value.path !== 'string' || !value.path
    || ('project' in value && value.project !== undefined && typeof value.project !== 'string')
    || ('line' in value && value.line !== undefined && (typeof value.line !== 'number'
      || !Number.isSafeInteger(value.line) || value.line < 0))) {
    return { id, payload: null };
  }

  return {
    id,
    payload: {
      type: 'open-file',
      repo: value.repo,
      root: value.root,
      path: value.path,
      ...('project' in value && typeof value.project === 'string' ? { project: value.project } : {}),
      ...('line' in value && typeof value.line === 'number' ? { line: value.line } : {}),
    },
  };
}

/**
 * Проверяет неизвестные команды и исключает уже потреблённые идентификаторы.
 * Идентификаторы удалённых из очереди команд освобождаются вместе с их памятью.
 */
function unhandledIntents(): IntentEnvelope[] {
  const decoded = props.intents.flatMap((value) => {
    const intent = decodeIntent(value);

    return intent ? [intent] : [];
  });
  const current = new Set(decoded.map((intent) => intent.id));

  for (const id of handledIntentIds) {
    if (!current.has(id)) {
      handledIntentIds.delete(id);
    }
  }

  return decoded.filter((intent) => !handledIntentIds.has(intent.id));
}

/**
 * Проверяет существование прежней рабочей копии при повторном открытии панели.
 * Если она сохранилась, обновляет содержимое без сброса Monaco и пустого кадра.
 */
async function revalidateProject(previous: PreviousContext, own: number) {
  const generation = contextGeneration;
  const id = project.value;
  const requestId = ++reposRequestId;

  error.value = '';

  // Список проектов уже перечитан и подтвердил, что у текущего проекта больше
  // нет репозиториев. Только здесь старый снимок действительно стал невалиден.
  if (!projectHasRepos.value) {
    if (own === activationId && projectIsCurrent(generation, id, requestId)) {
      contextGeneration += 1;
      repos.value = [];
      repoKey.value = '';
      treePath.value = '';
      contextId.value = '';
      resetState();
      contextLoading.value = false;
    }

    return;
  }

  let loadedRepos;

  try {
    loadedRepos = await codeApi.repos(id);
  } catch (e) {
    if (own === activationId && projectIsCurrent(generation, id, requestId)) {
      error.value = codeErrorMessage(e);
      contextLoading.value = false;
    }

    return;
  }

  if (own !== activationId || !projectIsCurrent(generation, id, requestId)) {
    return;
  }

  const nextContexts = buildCodeContexts(loadedRepos).contexts;
  const picked = nextContexts.find((item) => item.id === previous.contextId)
    || pickCodeContext(nextContexts, localStorage.getItem(contextStorageKey(id)));

  repos.value = loadedRepos;

  if (!picked) {
    contextGeneration += 1;
    repoKey.value = '';
    treePath.value = '';
    contextId.value = '';
    resetState();
    contextLoading.value = false;

    return;
  }
  if (picked.id !== previous.contextId || contextId.value !== previous.contextId) {
    await setContext(picked.id, { activation: own });

    return;
  }

  // Тот же контекст обновляется без resetState(): дерево, выбранный файл и
  // Monaco остаются на экране до атомарной подмены свежими ответами.
  await refresh({ silent: true, activation: own });

  if (own === activationId && projectIsCurrent(generation, id, requestId)) {
    contextLoading.value = false;
  }
}

/**
 * Загружает проекты при открытии и по возможности сохраняет точный контекст.
 * Новая активация или выбор человека отменяют право старого ответа менять панель.
 */
async function activate({ preserve = false } = {}) {
  const own = ++activationId;
  const previous = preserve ? {
    generation: contextGeneration,
    project: project.value,
    contextId: contextId.value,
    tab: tab.value,
    gitPane: gitPane.value,
    file: fileSel.value,
    gitFile: gitSel.value,
  } : null;

  if (!initialized) {
    loading.value = true;
  }

  try {
    const loaded = await codeApi.projects();

    if (own !== activationId) {
      return;
    }
    // Пока фоновый запрос летел, человек мог выбрать другой проект/worktree.
    // Такой ответ больше не имеет права возвращать интерфейс к старому снимку.
    if (previous && (previous.generation !== contextGeneration
      || previous.project !== project.value || previous.contextId !== contextId.value)) {
      return;
    }

    projects.value = loaded;

    const wanted = previous?.project || localStorage.getItem('grigdesk-project') || '';
    const pick = preserve && previous?.project && !loaded.some((item) => item.id === previous.project)
      ? null : pickCodeProject(projects.value, wanted);
    let revalidatedInPlace = false;

    if (pick && preserve && previous?.project === pick.id && project.value === pick.id) {
      revalidatedInPlace = true;
      await revalidateProject(previous, own);
    } else if (pick) {
      await setProject(pick.id, { activation: own });
    } else {
      contextGeneration += 1;
      project.value = '';
      repos.value = [];
      repoKey.value = '';
      treePath.value = '';
      contextId.value = '';
      resetState();
    }
    if (own !== activationId) {
      return;
    }
    // Файл/диф относится к точной рабочей копии. Если project или context исчез,
    // не переносим старый путь в случайный fallback-репозиторий.
    const sameContext = !revalidatedInPlace && previous?.project === project.value
      && previous?.contextId === contextId.value;

    if (sameContext && previous.tab === 'git') {
      gitPane.value = previous.gitPane;
      await setTab('git');

      if (previous.gitFile && gitEntries.value.has(previous.gitFile)) {
        await selectGit(previous.gitFile);
      }
    } else if (sameContext && previous?.file) {
      // Повторное открытие проверяет файл сервером. Если он исчез, старое превью
      // не остаётся висеть под новым деревом.
      if ((await openFile(previous.file, { activation: own })) === false) {
        fileSel.value = '';
        fileData.value = null;
        clearFileModel();
      }
    }

    initialized = true;
  } catch (e) {
    if (own === activationId) {
      error.value = codeErrorMessage(e);
    }
  } finally {
    if (own === activationId) {
      loading.value = false;
    }
  }

  await processIntents();
  await nextTick();
  layoutEditors();
}

/**
 * Открывает точный файл по intent из чата или deep-link: проект → рабочая копия →
 * раскрытие каталогов пути → сам файл. Цель адресуется репозиторием и корнем дерева,
 * а не «текущим выбором»: ссылка на worktree задачи не должна открыть одноимённый
 * файл основного дерева.
 */
async function openIntentFile(intent: OpenFileIntent) {
  const wantRepo = String(intent.repo || '');
  const wantRoot = String(intent.root || '');
  const rel = String(intent.path || '');

  if (!wantRepo || !wantRoot || !rel) {
    return;
  }

  if (intent.project && project.value !== intent.project) {
    if (!projects.value.some((item) => item.id === intent.project)) {
      error.value = `Проект «${intent.project}» недоступен в разделе «Код»`;

      return;
    }

    await setProject(intent.project);

    if (project.value !== intent.project) {
      return;
    }
  }

  const target = contexts.value.find((item) => item.repoKey === wantRepo && item.treePath === wantRoot);

  if (!target) {
    error.value = `Рабочая копия ${wantRoot} недоступна — проверь пути в разделе «Проекты»`;

    return;
  }
  if (contextId.value !== target.id) {
    await setContext(target.id);

    if (contextId.value !== target.id) {
      return;
    }
  }
  if (tab.value !== 'files') {
    tab.value = 'files';
  }

  // Каталоги раскрываем по одному сверху вниз: дерево ленивое, и без этого файл
  // открылся бы в редакторе, но не подсветился бы в навигаторе.
  const snapshot = captureContext();
  const segments = rel.split('/').slice(0, -1);
  let prefix = '';
  const open = new Set(openDirs.value);

  for (const segment of segments) {
    prefix = prefix ? `${prefix}/${segment}` : segment;

    if (!dirs.value.has(prefix) && !(await loadDir(prefix, snapshot))) {
      break;
    }
    if (!contextIsCurrent(snapshot)) {
      return;
    }

    open.add(prefix);
  }

  openDirs.value = open;
  pendingReveal = intent.line ? { path: rel, line: intent.line } : null;

  if ((await openFile(rel)) === false) {
    pendingReveal = null;
    error.value = `${rel}: файл не найден в этой рабочей копии`;
  }
}

/**
 * Последовательно исполняет и потребляет проверенные команды одной очереди.
 * Команды, пришедшие во время ожидания, запускаются после текущей обработки.
 */
async function processIntents() {
  const pending = unhandledIntents();

  if (!props.active || !initialized || loading.value || processingIntents || !pending.length) {
    return;
  }

  processingIntents = true;

  try {
    for (const { id, payload: intent } of pending) {
      if (intent?.type === 'project' && intent.project && project.value !== intent.project) {
        const target = projects.value.find((item) => item.id === intent.project);

        if (target) {
          await setProject(target.id);
        }
      } else if (intent?.type === 'open-file') {
        await openIntentFile(intent);
      }

      handledIntentIds.add(id);
      emit('consume-intent', id);
    }
  } finally {
    processingIntents = false;
    // Intent мог приехать, пока выполнялся предыдущий setProject. Его watcher уже
    // сработал и увидел processing=true, поэтому явно продолжаем очередь.
    if (props.active && unhandledIntents().length) {
      queueMicrotask(processIntents);
    }
  }
}

watch(() => props.active, (active, wasActive) => {
  if (active) {
    activate({ preserve: initialized && wasActive === false });
  }
  else {
    activationId += 1;
    gitActionId += 1;
    gitBusy.value = '';
  }
}, { immediate: true });
watch(() => props.intents, processIntents, { deep: true });
/**
 * Публикует текущую строку после движения курсора и смены выбора панели.
 * В проекцию не входят абсолютный корень, текст файла или черновик коммита.
 */
function publishCodeContext() {
  emit('context', props.active ? {
    id: 'code',
    presentation: props.presentation,
    ...(project.value ? { project: project.value } : {}),
    ...(repoKey.value ? { repository: repoKey.value } : {}),
    ...(context.value?.label ? { context: context.value.label } : {}),
    tab: tab.value,
    ...(fileSel.value ? { file: fileSel.value, line: fileEditor?.getPosition?.()?.lineNumber || 1 } : {}),
  } : null);
}

watch(
  [() => props.active, () => props.presentation, project, contextId, tab, fileSel],
  publishCodeContext,
  { immediate: true },
);
onMounted(() => {
  document.addEventListener('visibilitychange', refreshWhenVisible);
});
onBeforeUnmount(() => {
  activationId += 1;
  gitActionId += 1;
  document.removeEventListener('visibilitychange', refreshWhenVisible);

  if (codeLinkCopiedTimer) {
    clearTimeout(codeLinkCopiedTimer);
  }
  if (searchTimer) {
    clearTimeout(searchTimer);
    searchTimer = null;
  }

  navigatorObserver?.disconnect?.();
  editorObserver?.disconnect?.();
  emit('context', null);
  blameRequestId += 1;
  searchRequestId += 1;
  blameMouseDisposable?.dispose();
  blameMouseDisposable = null;
  blameDecorations?.clear();
  blameDecorations = null;
  clearFileModel();
  clearDiffModels();
  fileEditor?.dispose();
  diffEditor?.dispose();
});
</script>

<style scoped>
.code-panel { height: 100%; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
.code-head {
  min-width: 0; min-height: 36px; display: flex; align-items: center; gap: 10px;
  padding: 0 4px 8px; color: var(--ink); outline: none;
  container: code-head / inline-size;
}
.code-head strong { flex: none; font-size: 13px; font-weight: 650; }
.code-head:focus-visible { outline: 2px solid color-mix(in srgb, var(--accent) 45%, transparent); outline-offset: 2px; }
.navigator-toggle { flex: none; }
/* Шапка — не форма: у контролов нет своих коробок, только подпись-метка, значение
   и шеврон. Тот же приём, что в строке состояния чата. */
.head-ctx { display: flex; align-items: center; gap: 10px; min-width: 0; }
.head-pick { display: flex; align-items: center; gap: 6px; min-width: 0; }
.head-pick label { flex: none; font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em;
  color: var(--ink-mid); opacity: .75; }
/* Проект ужимается последним: его имя короткое и целиком помещается почти всегда,
   а метка рабочей копии длинная и у неё есть подсказка с полным путём. */
.head-pick.project { flex: none; }
.head-pick.project :deep(.ui-select) { min-width: 0; max-width: 180px; }
.head-pick.tree { flex: 0 1 auto; }
.head-pick.tree :deep(.ui-select) { min-width: 0; max-width: 280px; }
/* Разделитель между переключателями, как в строке состояния чата: без коробок
   два соседних значения иначе читаются одной фразой. */
.head-pick + .head-pick { border-left: 1px solid var(--line); padding-left: 10px; }
/* В узкой шапке дока подписи уходят: они стоили проекту его имени («rd…»), хотя
   значение и шеврон сами говорят, что это переключатель. Полные имена — в title. */
@container code-head (max-width: 620px) {
  .head-pick label { display: none; }
  .head-pick + .head-pick { padding-left: 8px; }
}
@container code-head (max-width: 479px) {
  .head-ctx { flex: 1 1 0; gap: 5px; overflow: hidden; }
  .head-pick.tree { flex: 1 1 0; overflow: hidden; }
  .head-pick.project :deep(.ui-select) { max-width: 104px; }
  .head-pick.tree :deep(.ui-select) { width: 100%; max-width: none; }
  .head-pick + .head-pick { padding-left: 6px; }
}
.code-panel.narrow .code-head { column-gap: 6px; }
.tlabel { font-size: 12px; color: var(--ink-mid); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Только корневое «проектов нет»: у состояний внутри панели (`.git-index-state.empty`)
   свои классы, и общий селектор `.empty` раздувал их отступами на 40px. */
.code-panel > .empty { color: var(--ink-mid); padding: 40px 0; text-align: center; }
.code-panel > .empty a, .pnote a { color: var(--accent); }

/* Первая колонка — рейка разделов; её ширину задаёт скрипт той же цифрой, которой
   вычитает рейку из координаты разделителя. */
.lay { flex: 1; min-width: 0; min-height: 0; display: grid;
  grid-template-columns: var(--code-rail-width, 44px) minmax(0, min(var(--code-nav-width, 320px), 42%))
    8px minmax(0, 1fr);
  border: 1px solid var(--line); border-radius: 12px; overflow: hidden; background: var(--surface); }

/* В доке и на route дерево остаётся слева, как на полной странице.
   Верхняя граница clamp не отдаёт навигатору больше 42% узкой рабочей области. */
.lay.compact {
  grid-template-rows: minmax(0, 1fr);
  border: 0; border-radius: 0;
}
.lay .rail { grid-column: 1; grid-row: 1; }
.lay .panel { grid-column: 2; grid-row: 1; min-width: 0; border-right: 0; }
.lay .editorwrap { grid-column: 4; grid-row: 1; }
.lay.navigator-collapsed { grid-template-columns: var(--code-rail-width, 44px) 0 0 minmax(0, 1fr); }
.lay.navigator-collapsed .panel { display: none; }
/* Ни compact, ни ширина окна не определяют мобильную геометрию: класс приходит из
   ResizeObserver самого CodePanel. Обе области остаются смонтированы, меняется только
   видимость — Monaco не теряет модель, позицию и выделение. Рейка остаётся и здесь:
   без неё в узкой раскладке не было бы, чем сменить раздел. */
.lay.code-narrow { grid-template-columns: var(--code-rail-width, 44px) minmax(0, 1fr); }
.lay.code-narrow .panel, .lay.code-narrow .editorwrap { grid-column: 2; grid-row: 1; }
.lay.code-narrow .code-split { display: none; }
.lay.code-narrow.narrow-navigator .editorwrap { display: none; }
.lay.code-narrow.narrow-editor .panel { display: none; }
.code-loading { user-select: none; }
.loading-rail-item { width: 34px; height: 34px; border-radius: 8px; background: var(--surface-2); }
.loading-panel { gap: 0; }
.loading-tree { display: flex; flex-direction: column; gap: 11px; padding: 15px 17px; }
.loading-row { width: var(--loading-row); height: 8px; border-radius: 999px; background: var(--line); opacity: .78; }
.loading-editor .ehead { min-height: 37px; }
.loading-path { width: min(42%, 260px); height: 8px; border-radius: 999px; background: var(--line); }
.loading-editor .ebody { display: grid; place-items: center; background: #0a0c10; }
.loading-status { color: var(--ink-mid); font-size: 12px; }
.loading-split { pointer-events: none; }
.code-split {
  grid-column: 3; grid-row: 1; position: relative; cursor: col-resize; touch-action: none;
  display: grid; place-items: center; background: var(--sidebar); border-right: 1px solid var(--line);
}
.code-split span { width: 2px; height: 34px; border-radius: 999px; background: var(--line-2); }
.code-split:hover span, .code-split:focus-visible span { background: var(--accent); }
.code-split:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.code-panel.compact .code-head {
  min-height: 40px;
  padding: var(--tool-dock-action-top, 4px) var(--tool-dock-actions-space, 4px) 5px 11px;
  border-bottom: 1px solid var(--line); background: var(--topbar);
}
.code-panel.compact .code-head strong { font-size: 12.5px; letter-spacing: .01em; }

/* Рейка разделов: skin кнопки — в общем actions.css по data-context, здесь только
   раскладка колонки и бейдж счётчика поверх значка «Изменений». */
.rail { display: flex; flex-direction: column; gap: 2px; padding: 8px 0; align-items: center;
  background: var(--sidebar); border-right: 1px solid var(--line); }
.rail-item { position: relative; }
.ic { width: 19px; height: 19px; }
.rail-badge {
  position: absolute; top: -2px; right: -3px; min-width: 16px; height: 16px;
  display: inline-grid; place-items: center; box-sizing: border-box; padding: 0 4px;
  border: 1px solid var(--line-2); border-radius: 999px; background: var(--surface-2);
  color: var(--ink-mid); font-size: 9px; font-weight: 750; line-height: 1;
}

/* Панель */
.panel { display: flex; flex-direction: column; min-width: 0; min-height: 0; border-right: 1px solid var(--line); background: var(--sidebar);
  container: code-panel / inline-size; }
.perr { color: var(--bad); font-size: 12px; padding: 8px 12px; }
.pnote { color: var(--ink-mid); font-size: 12px; padding: 8px 12px; }
.context-warning { display: flex; flex-direction: column; gap: 3px; }
.unavailable-repo { color: var(--bad); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.git-footer { order: 20; flex: none; min-width: 0; border-top: 1px solid var(--line);
  background: color-mix(in srgb, var(--surface) 72%, var(--sidebar)); }
.git-compose { display: flex; flex-direction: column; gap: 5px; padding: 6px 8px; }
.git-compose-head { display: flex; align-items: center; gap: 4px; min-width: 0; }
.commit-disclosure { display: flex; flex: 1; align-items: center; gap: 6px; min-width: 0;
  text-align: left; }
.git-compose-title { color: var(--ink); font-size: 11.5px; font-weight: 650; }
.git-index-state { min-width: 0; overflow: hidden; color: var(--accent); font-size: 10.5px;
  text-overflow: ellipsis; white-space: nowrap; }
.git-index-state::before { content: '·'; margin-right: 5px; color: var(--ink-low); }
.git-index-state.empty { color: var(--ink-low); }
.commit-chevron { margin-left: auto; color: var(--ink-mid); font-size: 10px; }
.commit-empty-hint { margin: -1px 0 1px; color: var(--ink-mid); font-size: 10.5px; line-height: 16px; }
.git-compose-body { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.git-compose .commit-message { width: 100%; }
.amend-active-row { display: flex; align-items: center; gap: 5px; min-width: 0;
  color: var(--warn); font-size: 10.5px; }
.amend-active-row span { flex: 1; min-width: 0; }
.git-compose-actions { display: flex; align-items: center; gap: 5px; min-width: 0; }
.git-compose-actions .commit-action { flex: 1; min-width: 0; }
.git-compose-actions .generate-commit { flex: none; }
.git-sync-row { display: flex; align-items: center; gap: 6px; min-width: 0; min-height: 34px;
  padding: 3px 8px; border-top: 1px solid color-mix(in srgb, var(--line) 72%, transparent); }
.git-remote-actions { display: inline-flex; flex: none; align-items: center; gap: 3px; }
.git-notice {
  flex: 1; min-width: 0; margin: 0; overflow-wrap: anywhere;
}
.git-tracking-note { overflow: hidden; padding: 0; color: var(--ink-mid); text-overflow: ellipsis;
  font-size: 10.5px; line-height: 1.35; white-space: nowrap; }
.git-tracking-note.err { color: var(--bad); }
.git-panel { order: 10; display: flex; flex: 1; flex-direction: column; min-width: 0;
  min-height: 0; }
.git-panel-toolbar {
  display: flex; flex: none; align-items: center; gap: 6px; min-height: 31px; padding: 3px 10px;
  border-bottom: 1px solid var(--line); background: var(--sidebar);
}
.git-panel-label {
  color: var(--ink-low); font-size: 10.5px; font-weight: 650;
  letter-spacing: .035em; text-transform: uppercase;
}
.git-clean {
  display: flex; align-items: center; gap: 7px; padding: 8px 6px;
  color: var(--good); font-size: 11.5px;
}
.git-clean svg { width: 15px; height: 15px; flex: none; }
.scroll { flex: 1; min-width: 0; overflow: auto; padding: 6px 8px; }
/* Лесенка дерева: шаг задан ОДИН раз здесь, скрипт присылает строке только --depth.
   Держать шаг числом в JS нельзя — он должен сходиться с положением направляющей. */
.tree {
  --tree-step: 14px;
  --tree-lead: 8px;
  --tree-guide: color-mix(in srgb, var(--line) 58%, transparent);
}

/* Вид строки (высота, радиус, фон, состояния) живёт в общем скине
   `.ui-pressable[data-context='code-tree-row']`: локальной копии этих свойств
   у плагина быть не должно. Здесь — только раскладка и направляющие дерева. */
.trow { display: flex; align-items: center; gap: 7px; width: 100%; text-align: left; }
.git-file-line { position: relative; display: flex; align-items: center; gap: 2px; min-width: 0; }
.git-file-line .trow { flex: 1; width: auto; min-width: 0; }
.git-file-action { flex: none; }
/* Обойма действий строки: одна на строку, кнопки в ней в ряд. На тач-устройстве — в потоке. */
.git-row-actions { display: flex; align-items: center; gap: 2px; flex: none; }
.git-file-line:has(.git-row-actions > :nth-child(2)) { --row-actions: 2; }
/* Заголовок группы — кнопка сворачивания (скин в actions.css, code-group-toggle); здесь
   только текст заголовка, который при нехватке места обрезается многоточием. */
.group-toggle .subtitle { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* На указателе обойма всплывает справа поверх уже зарезервированной колонки. */
@media (hover: hover) and (pointer: fine) {
  .git-row-actions { position: absolute; top: 50%; right: 2px; transform: translateY(-50%);
    opacity: 0; pointer-events: none; }
  .git-file-line:hover .git-row-actions, .git-file-line:focus-within .git-row-actions {
    opacity: 1; pointer-events: auto; }
}
/* Направляющие линии предков — по одной на уровень, ровно под шевроном родителя. */
.tree .trow {
  padding-left: calc(var(--tree-lead) + var(--depth, 0) * var(--tree-step));
  background-image: repeating-linear-gradient(to right, var(--tree-guide) 0 1px, transparent 1px var(--tree-step));
  background-repeat: no-repeat;
  /* 5.5px = половина шеврона минус половина линии: направляющая идёт ровно по его центру. */
  background-position: calc(var(--tree-lead) + 5.5px) 0;
  background-size: calc(var(--depth, 0) * var(--tree-step)) 100%;
}
.chev { flex: none; width: 12px; font-size: 10px; color: var(--ink-mid); }
.dname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.git-dir-dot { flex: none; color: var(--warn); font-size: 15px; line-height: 1; }
.file-tree .nm.A { color: var(--good); }
.file-tree .nm.M { color: var(--warn); }
.file-tree .nm.D { color: var(--bad); }
.file-tree .nm.R { color: var(--accent); }
.file-tree .nm.U { color: var(--bad); }
/* Плоский список: имя целиком, каталог сжимается первым и обрезается СЛЕВА —
   у пути важен хвост рядом с файлом, а не общий для десятка строк корень.
   Своим классом, а не общим `.nm`: у строки дерева внутри голый текст, и flex-контейнер
   отменил бы ему многоточие. */
.nm.split { display: flex; align-items: baseline; gap: 6px; overflow: hidden; }
.nm-base { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; font-weight: 400; }
/* Вес сжатия 999 против 1 у имени: сначала уступает каталог и только когда его уже
   не осталось — само имя. Иначе оба обрезались поровну и не читалось ни одно. */
.nm-dir { flex: 0 999 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  direction: rtl; text-align: left; color: var(--ink-mid); font-size: 11px; font-style: normal; }
.st {
  flex: none; width: 18px; height: 18px; text-align: center; font-family: var(--mono);
  font-size: 10.5px; font-weight: 700; line-height: 18px; border-radius: 5px;
}
.st.A { color: var(--good); background: color-mix(in srgb, var(--good) 12%, transparent); }
.st.M { color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, transparent); }
.st.D, .st.U { color: var(--bad); background: color-mix(in srgb, var(--bad) 12%, transparent); }
.st.R { color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
.cnt { flex: none; font-size: 11px; display: flex; gap: 5px; transition: opacity .1s; }
.cnt .a { color: var(--good); } .cnt .d { color: var(--bad); }
/* Итог группы: числа в тех же цветах, что у строк файлов, полоска — пять квадратиков
   GitHub. Заголовок группы задаёт вес шрифта, итог его наследует. */
.diffstat { flex: none; display: flex; align-items: center; gap: 5px; font-size: 11px; }
.diffstat .a { color: var(--good); } .diffstat .d { color: var(--bad); }
.diffstat .bar { display: inline-flex; gap: 1px; }
.diffstat .bar i { width: 7px; height: 7px; border-radius: 1px; background: var(--line); }
.diffstat .bar .add { background: var(--good); } .diffstat .bar .del { background: var(--bad); }
/* В панели уже 360 px итог с пятизначными числами не умещается в строке заголовка рядом
   с кнопками: замер при 300 px показал заголовок, ужатый до «В…». Поэтому там итог
   целиком уходит на свою строку под заголовком — числа и полоска остаются читаемыми. */
@container code-panel (max-width: 359px) {
  .subhead:not(.commit-range-summary) { flex-wrap: wrap; }
  .subhead > .diffstat { order: 10; flex-basis: 100%; }
}
/* В узкой панели имени файла уступают и счётчик строк, и хвост каталога: имя — то,
   ради чего список открывают, числа видны в самом дифе, а целый путь остаётся в
   подсказке строки. Меряем панель, а не окно: ширину ей задаёт разделитель дерева,
   а не размер экрана. */
@container code-panel (max-width: 299px) {
  .git-file .cnt, .git-file .nm-dir { display: none; }
}

/* Заголовок группы: капс с разрядкой был вдвое шире строчных букв и в узком доке
   переносил «В рабочем дереве» на вторую строку вместе с кнопками. */
.subhead { font-size: 11px; font-weight: 650; letter-spacing: .01em;
  color: var(--ink-mid); padding: 6px 4px 4px; display: flex; align-items: center; gap: 5px;
  min-width: 0; border-bottom: 1px solid color-mix(in srgb, var(--line) 72%, transparent); }
.git-tree .subhead {
  position: sticky; top: -6px; z-index: 3;
  background: color-mix(in srgb, var(--sidebar) 94%, var(--surface));
}
.commit-tree { display: flex; flex-direction: column; overflow: hidden; padding: 0; }
/* Секция журнала — flex-колонка: список получает остаток высоты и прокручивается сам.
   Блочная секция с overflow: hidden просто отрезала хвост истории без прокрутки. */
.commit-log-section { display: flex; flex: none; flex-direction: column; max-height: 240px;
  min-height: 0; overflow: hidden; border-bottom: 1px solid var(--line); }
.commit-log-section:only-child { flex: 1; max-height: none; border-bottom: 0; }
.commit-log-section .commits-head { flex: none; padding: 6px 8px 5px; }
.commit-log-section .commits-state { flex: none; }
.commit-log { flex: 1; min-height: 0; overflow: auto; padding: 5px 8px; }
.commit-tree .git-group { flex: 1; min-height: 0; overflow: auto; padding: 6px 8px; }
/* Сводка отрезка — сетка: первая строка — отрезок и две кнопки, вторая — итог во всю
   ширину. Текстовое «Сбросить» рядом с заголовком не оставляло ему места уже при 320 px. */
.commit-range-summary { display: grid; grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center; column-gap: 4px; row-gap: 3px; padding: 5px 4px 6px; }
.commit-range-summary .subtitle { color: var(--ink); font-size: 11.5px; }
.commit-range-meta { display: flex; grid-column: 1 / -1; align-items: center; gap: 0 6px;
  min-width: 0; overflow: hidden; color: var(--ink-mid); font-size: 10.5px; font-weight: 400;
  white-space: nowrap; }
.commit-range-meta .cnt, .commit-range-meta .diffstat { flex: none; font-size: 10.5px; }
.commit-range-meta .group-note { flex: 0 1 auto; min-width: 0; overflow: hidden;
  text-overflow: ellipsis; color: var(--ink-low); }
.commit-range-meta .group-note::before { content: '·'; margin-right: 6px; }
.subtitle { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.git-view-toggle { display: inline-flex; gap: 1px; }
.git-view-toggle svg { width: 15px; height: 15px; fill: currentColor; }
.git-group-action { flex: none; }
.commit { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.hash { flex: none; color: var(--accent); font-size: 11px; }
.subj { color: var(--ink-mid); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.history-path { padding: 5px 7px 8px; color: var(--ink-mid); overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; border-bottom: 1px solid var(--line); }
.file-history-entry { flex-wrap: wrap; }
.file-history-entry .subj { flex: 1; min-width: 0; }
.history-old-path { flex-basis: 100%; padding-left: 64px; color: var(--ink-mid);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10.5px; }
.code-search { padding: 7px; border-bottom: 1px solid var(--line); }
.code-search :deep(.ui-search-input) { width: 100%; }
.code-search :deep(.ui-input) { min-width: 0; width: 100%; }
.search-result-head { padding-top: 8px; }
.search-result { min-height: 30px; height: auto; align-items: flex-start; flex-direction: column;
  gap: 2px; padding-block: 5px; }
.search-file, .search-location, .search-text { max-width: 100%; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.search-location { color: var(--accent); font-size: 10.5px; }
.search-text { color: var(--ink-mid); font-size: 11px; }
.search-truncated { border-top: 1px solid var(--line); }

/* Просмотр */
.editorwrap { display: flex; flex-direction: column; min-width: 0; min-height: 0;
  container: code-editor / inline-size; }
.editor-header { flex: none; min-width: 0; border-bottom: 1px solid var(--line);
  background: var(--topbar); }
.ehead {
  display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 6px 10px;
}
.ehead [data-action='back-to-navigator'] { flex: none; }
.editor-identity { display: flex; flex: 0 1 auto; align-items: center; gap: 8px;
  min-width: 0; overflow: hidden; }
.ehead .st { width: auto; min-width: 18px; padding: 0 5px; }
.epath { flex: 0 1 auto; min-width: 0; display: inline-flex; align-items: baseline;
  font-size: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.epath-dir { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis;
  font-size: 12.5px; font-style: normal; color: var(--ink-mid); }
.epath-name { flex: none; font-size: 12.5px; font-weight: 500; }
.epath.review-title { font-size: 12.5px; }
.file-view-state { flex: none; color: var(--ink-low); font-size: 12px; }
.file-head-actions { display: flex; flex: none; align-items: center; gap: 2px; min-width: 0; }
.diffhead {
  display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 36px;
  padding: 2px 10px; border-top: 1px solid var(--line);
}
.comparison-identity { display: flex; flex: 0 1 auto; align-items: center; gap: 8px;
  min-width: 0; }
.comparison-sides {
  min-width: 0; color: var(--ink-mid); font-size: 12px; line-height: 16px;
  white-space: normal;
}
.file-navigation { display: inline-flex; flex: none; align-items: center; gap: 1px; }
.file-position { min-width: 66px; color: var(--ink-mid); font-size: 11px;
  font-variant-numeric: tabular-nums; text-align: center; white-space: nowrap; }
.file-head-actions > *, .diffhead > * { flex-shrink: 0; }
.ehead .glyph { display: inline-flex; align-items: center; justify-content: center;
  width: 14px; height: 14px; flex: none; }
.ehead svg.glyph { fill: currentColor; }
.ehead .glyph.ok { color: var(--good); }
.ehead .glyph + .label { margin-left: 5px; }
.range-summary { flex: none; color: var(--ink-mid); }
.diff-view-trigger { flex: none; white-space: nowrap; }
.diff-view-trigger .chevron { margin-left: 5px; }
.diff-view-mode { color: var(--ink-low); }
.code-popover-panel { display: grid; gap: 7px; min-width: 0; }
.code-popover-title { color: var(--ink); font-size: 12.5px; font-weight: 650; }
.code-popover-label { color: var(--ink-mid); font-size: 11px; }
.code-popover-note { margin: 0; color: var(--ink-mid); font-size: 11.5px; line-height: 1.4; }
.diff-layout-options { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 4px; }
.diff-view-panel { gap: 9px; }

@container code-editor (max-width: 980px) {
  .range-summary { display: none; }
}
@container code-editor (max-width: 760px) {
  .ehead { min-height: 40px; padding-inline: 8px; }
  .diffhead { padding-inline: 8px; }
  .file-view-state { display: none; }
}
@container code-editor (max-width: 520px) {
  .ehead, .diffhead { gap: 4px; }
  .file-position { min-width: 38px; }
  .file-position-label, .diff-view-mode { display: none; }
  .epath-dir { max-width: 34%; }
}
@container code-editor (max-width: 390px) {
  .ehead { align-items: flex-start; min-height: 44px; }
  .editor-identity { align-items: flex-start; padding-top: 6px; }
  .epath { flex-wrap: wrap; line-height: 17px; white-space: normal; }
  .epath-dir { max-width: 100%; }
  .diffhead { flex-wrap: wrap; min-height: 36px; padding-block: 4px; }
  .comparison-identity { flex: 1 1 100%; }
}
.note { font-size: 11px; color: var(--warn); flex: none; }
.note.diff-error { color: var(--bad); }
.grow { flex: 1; }
.ebody { flex: 1; min-height: 0; position: relative; }
.editor { position: absolute; inset: 0; }
:global(.code-blame-after) {
  color: var(--ink-mid); font-family: var(--mono); font-size: 11px; opacity: .72;
  cursor: pointer;
}
.overlay { position: absolute; inset: 0; display: grid; place-items: center; color: var(--ink-mid);
  font-size: 13px; background: #0a0c10; }
.editor-empty { display: flex; align-items: center; flex-direction: column; gap: 7px;
  max-width: 360px; padding: 24px; text-align: center; }
.editor-empty svg { width: 28px; height: 28px; margin-bottom: 2px; color: var(--ink-low); }
.editor-empty strong { color: var(--ink); font-size: 13px; font-weight: 600; }
.editor-empty span { color: var(--ink-mid); font-size: 11.5px; }
.editor-empty.positive svg { color: var(--good); }

/* Предпросмотр картинки: вписываем целиком, «шахматка» показывает прозрачность. */
.imgwrap {
  position: absolute; inset: 0; display: grid; place-items: center; overflow: auto; padding: 16px;
  background: #0a0c10;
  background-image:
    linear-gradient(45deg, #14181f 25%, transparent 25%, transparent 75%, #14181f 75%),
    linear-gradient(45deg, #14181f 25%, transparent 25%, transparent 75%, #14181f 75%);
  background-size: 18px 18px; background-position: 0 0, 9px 9px;
}
.imgwrap img { max-width: 100%; max-height: 100%; object-fit: contain;
  border-radius: 6px; box-shadow: 0 2px 18px rgba(0, 0, 0, .45); }
.imgerr { color: var(--bad); font-size: 13px; text-align: center; line-height: 1.6; }
.imgerr .muted { color: var(--ink-mid); font-size: 12px; }
.note.img-note { color: var(--ink-mid); }

.diff-layout { flex: none; }
</style>

<template>
  <TaskCardFrame
    data-perf-target="task"
    :data-perf-key="`${taskSource || ''}:${taskId}`"
    :presentation="presentation"
    :open="Boolean(taskId)"
    data-role="task-modal"
    size="workspace"
    initial-focus="#task-modal-title"
    :label="detail?.title || t('core.taskZadachaTaskid', { taskId: taskId || '' })"
    :body-inset="false"
    fade-only
    @update:open="onTaskDialogOpenChange"
  >
    <div class="task-detail"
    :data-perf-pending="loading && !detail ? '' : undefined" data-ui-workspace :data-pane="contentPane">
      <div class="mhead" :class="{ 'mhead-window': presentation === 'document' }">
        <UiPaneHeader class="task-toolbar" inset="content" data-ui-task-header>
          <template #title>
            <span class="meyebrow">{{ t('core.taskFormGenericTask') }}</span>
          </template>
          <template #meta>
            <span class="mid mono">#{{ taskId }}</span>
            <TaskSourceChip v-if="taskSource" :source="taskSource" />
          </template>
          <template #actions>
            <div class="mhead-actions" role="group" :aria-label="t('core.taskDeystviyaSKartochkoy')">
              <TaskFavoriteButton
                v-if="canUsePersonal"
                :active="favorites.isFavorite(taskId)"
                :pending="!favorites.loaded || favorites.loading || favorites.isPending(taskId)"
                :task-title="detail?.title || boardTask?.title || t('core.taskZadachaTaskid', { taskId: String(taskId ?? '') })"
                @toggle="toggleFavorite"
              />
              <UiIconButton
                data-context="task-modal-header"
                :label="t('core.taskObnovitZadachu')"
                v-tooltip="t('core.trackerUpdate')"
                :loading="loading"
                :disabled="Boolean(editForm) || busy === 'edit'"
                :loading-label="t('core.taskObnovlyayuZadachu')"
                @click="refresh"
              >
                <UiRefreshIcon />
              </UiIconButton>
              <UiIconButton
                data-context="task-modal-header"
                :label="t('core.taskZakrytZadachu')"
                v-tooltip="t('core.taskZakrytEsc')"
                @click="ui.close()"
              >
                ✕
              </UiIconButton>
            </div>
          </template>
        </UiPaneHeader>
        <div class="mheading">
          <h3 id="task-modal-title" class="mtitle" tabindex="-1">
            {{ detail?.title || (loading ? t('core.browserLoading') : t('core.chatOptionTask')) }}
          </h3>
        </div>
      </div>

      <div v-if="err || (canUsePersonal && (favorites.error || shelf.error))" class="malerts" aria-live="polite">
        <p v-if="err" class="err"
    :data-perf-error="!detail && !loading ? '' : undefined">{{ err }}</p>
        <p v-if="canUsePersonal && favorites.error" class="err">{{ t('core.taskIzbrannoe') }} {{ favorites.error }}</p>
        <p v-if="canUsePersonal && shelf.error" class="err">{{ t('core.taskPolka') }} {{ shelf.error }}</p>
      </div>

      <div class="mcontext" :aria-label="t('core.taskSostoyanieZadachi')">
        <div class="meta">
          <span v-if="taskStatus" class="tag task-status">{{ taskStatus }}</span>
          <span v-if="detail?.replicate === 'Y'" class="tag">{{ t('core.taskRecurring') }}</span>
          <span v-if="taskProject" class="context-item">
            <span class="context-label">{{ t('core.taskEditProject') }}</span>{{ taskProject }}
          </span>
          <span v-if="taskResponsible" class="context-item">
            <span class="context-label">{{ t('core.taskEditResponsible') }}</span>
            <img v-if="responsibleAvatar" :key="responsibleAvatar" :src="responsibleAvatar" alt=""
                 class="task-avatar" referrerpolicy="no-referrer" @error="hideAvatar" />
            {{ taskResponsible }}
          </span>
          <span v-if="detail?.creator?.name" class="context-item">
            <span class="context-label">{{ t('core.taskCreator') }}</span>
            <img v-if="creatorAvatar" :key="creatorAvatar" :src="creatorAvatar" alt=""
                 class="task-avatar" referrerpolicy="no-referrer" @error="hideAvatar" />
            {{ detail.creator.name }}
          </span>
          <span v-if="taskPriority" class="context-item">
            <span class="context-label">{{ t('core.taskEditPriority') }}</span>{{ taskPriority }}
          </span>
          <span v-if="taskDeadlineText" class="context-item" :class="{ over: taskDeadlineState === 'over' }">
            <span class="context-label">{{ t('core.taskDeadline') }}</span>
            {{ taskDeadlineText }}
            <span v-if="taskDeadlineState">🔥 {{ taskDeadlineState === 'over'
              ? t('core.taskOverdue') : t('core.taskUrgent') }}</span>
          </span>
          <span v-if="taskAccomplices" class="context-item">
            <span class="context-label">{{ t('core.taskAccomplices') }}</span>{{ taskAccomplices }}
          </span>
          <span v-if="taskAuditors" class="context-item">
            <span class="context-label">{{ t('core.taskAuditors') }}</span>{{ taskAuditors }}
          </span>
          <UiButton v-if="taskParentId" size="compact" data-role="task-parent"
                    @click="ui.openTask(taskParentId, taskSource)">
            {{ t('core.taskParent', { id: taskParentId }) }}
          </UiButton>
          <span v-if="!hasTaskMeta" class="context-empty">
            {{ loading ? t('core.taskChitayuDannyeZadachi') : t('core.taskDopolnitelnyhMetokNet') }}
          </span>
        </div>
      </div>

      <div class="task-sectionbar">
        <UiTabs v-model="taskSection" class="task-navigation" :label="t('core.taskDesignSections')">
          <UiTab
            id="task-tab-description"
            value="description"
            controls="task-description"
            data-context="task-modal-tab"
            data-task-section="description"
          >{{ t('core.taskDesignDescription') }}</UiTab>
          <UiTab
            id="task-tab-triage"
            value="triage"
            controls="task-panel-triage"
            data-context="task-modal-tab"
            data-task-section="triage"
          >{{ t('core.taskDesignAnalysis') }}</UiTab>
          <UiTab
            v-if="isB24Task && trackerCaps.comments"
            id="task-tab-comments"
            value="comments"
            controls="task-panel-comments"
            data-context="task-modal-tab"
            data-task-section="comments"
          >
            {{ t('core.taskDesignComments') }}<span v-if="comments?.length"> · {{ comments.length }}</span>
          </UiTab>
        </UiTabs>
      </div>

      <div class="mbody">
        <section id="task-description" class="task-pane brief-pane"
                 role="tabpanel" aria-labelledby="task-tab-description">
          <div class="brief-head">
            <h4 class="pane-title">{{ editForm ? t('core.taskEditHeading') : t('core.taskOpisanieZadachi') }}</h4>
            <UiButton
              v-if="isB24Task && trackerCaps.editing && detail && !editForm"
              size="compact"
              data-role="task-edit-open"
              v-tooltip="t('core.taskRedaktirovatZadachu')"
              :disabled="loading || busy === 'edit'"
              @click="openTaskEdit"
            > {{ t('settings.change') }} </UiButton>
          </div>
          <div class="brief-scroll" :class="{ 'brief-scroll--editing': editForm }">
            <TaskLoading v-if="loading && !detail" :label="t('core.taskChitayuDannyeZadachi')"  area="description" />
            <form v-else-if="editForm" class="task-edit" :aria-label="t('core.taskEditHeading')"
                  @submit.prevent="saveTaskEdit" @keydown.ctrl.enter.prevent="saveTaskEdit"
                  @keydown.meta.enter.prevent="saveTaskEdit">
              <div class="task-edit-scroll">
                <div class="task-edit-main">
                  <UiField
                    :label="t('core.taskEditTitle')"
                    required
                    :error="editForm.title.trim() ? '' : t('core.taskEditTitleRequired')"
                  >
                    <UiInput
                      ref="editTitleInput"
                      v-model="editForm.title"
                      data-role="task-edit-title"
                      maxlength="255"
                      autocomplete="off"
                      :disabled="busy === 'edit'"
                    />
                  </UiField>

                  <UiField
                    :label="t('core.taskDesignDescription')"
                    :hint="t('core.taskEditDescriptionHint')"
                  >
                    <UiTextarea
                      v-model="editForm.description"
                      data-role="task-edit-description"
                      rows="12"
                      :placeholder="t('core.taskEditDescriptionPlaceholder')"
                      :disabled="busy === 'edit'"
                    />
                  </UiField>
                </div>

                <aside class="task-edit-properties" :aria-label="t('core.taskEditProperties')">
                  <h5 class="task-edit-section-title">{{ t('core.taskEditProperties') }}</h5>
                  <div class="task-edit-grid">
                    <UiField :label="t('core.taskEditResponsible')">
                      <UiSelect
                        v-model="editForm.responsibleId"
                        data-role="task-edit-responsible"
                        :disabled="editOptionsBusy || busy === 'edit'"
                      >
                        <option v-if="!editForm.responsibleId" value="" disabled>
                          {{ t('core.taskEditUnassigned') }}
                        </option>
                        <option
                          v-for="user in editResponsibleOptions"
                          :key="user.id"
                          :value="String(user.id)"
                        >
                          {{ user.name }}
                        </option>
                      </UiSelect>
                    </UiField>

                    <UiField :label="t('core.taskEditProject')">
                      <UiSelect
                        v-model="editForm.groupId"
                        data-role="task-edit-group"
                        :disabled="editOptionsBusy || busy === 'edit'"
                      >
                        <option value="">{{ t('core.taskEditNoProject') }}</option>
                        <option
                          v-for="group in editGroupOptions"
                          :key="group.id"
                          :value="String(group.id)"
                        >
                          {{ group.name }}
                        </option>
                      </UiSelect>
                    </UiField>

                    <UiField :label="t('core.taskEditPriority')">
                      <UiSelect
                        v-model.number="editForm.priority"
                        data-role="task-edit-priority"
                        :disabled="busy === 'edit'"
                      >
                        <option :value="0">{{ t('core.taskPriorityLow') }}</option>
                        <option :value="1">{{ t('core.taskPriorityNormal') }}</option>
                        <option :value="2">{{ t('core.taskPriorityHigh') }}</option>
                      </UiSelect>
                    </UiField>

                    <UiField :label="t('core.taskDeadline')">
                      <UiInput
                        v-model="editForm.deadline"
                        type="datetime-local"
                        data-role="task-edit-deadline"
                        :disabled="busy === 'edit'"
                      />
                    </UiField>
                  </div>

                  <div class="task-edit-people">
                    <UiDisclosureButton v-model:open="editAccomplicesOpen" controls="task-edit-accomplices"
                                        density="compact" data-role="task-edit-accomplices-toggle"
                                        :disabled="editOptionsBusy || busy === 'edit'">
                      {{ t('core.taskAccomplices') }}
                      <span class="task-edit-count">{{ editForm.accomplices.length }}</span>
                    </UiDisclosureButton>
                    <div v-show="editAccomplicesOpen" id="task-edit-accomplices" class="task-edit-people-list">
                      <UiChoiceList v-model="editForm.accomplices" mode="multiple" selection-indicator
                                    data-role="task-edit-accomplices" :label="t('core.taskAccomplices')"
                                    :options="editParticipantOptions"
                                    :disabled="editOptionsBusy || busy === 'edit'">
                        <p v-if="!editParticipantOptions.length" class="task-edit-note">
                          {{ t('core.taskEditNoPeople') }}
                        </p>
                      </UiChoiceList>
                    </div>
                    <UiDisclosureButton v-model:open="editAuditorsOpen" controls="task-edit-auditors"
                                        density="compact" data-role="task-edit-auditors-toggle"
                                        :disabled="editOptionsBusy || busy === 'edit'">
                      {{ t('core.taskAuditors') }}
                      <span class="task-edit-count">{{ editForm.auditors.length }}</span>
                    </UiDisclosureButton>
                    <div v-show="editAuditorsOpen" id="task-edit-auditors" class="task-edit-people-list">
                      <UiChoiceList v-model="editForm.auditors" mode="multiple" selection-indicator
                                    data-role="task-edit-auditors" :label="t('core.taskAuditors')"
                                    :options="editParticipantOptions"
                                    :disabled="editOptionsBusy || busy === 'edit'">
                        <p v-if="!editParticipantOptions.length" class="task-edit-note">
                          {{ t('core.taskEditNoPeople') }}
                        </p>
                      </UiChoiceList>
                    </div>
                  </div>

                  <TaskLoading v-if="editOptionsBusy" :label="t('core.taskEditLoadingOptions')"
                               area="options" :failed="Boolean(editOptionsError)" />
                  <div v-else-if="editOptionsError" class="edit-options-state bad">
                    <span>{{ editOptionsError }}</span>
                    <UiButton data-role="task-edit-options-retry" @click="loadEditOptions">
                      {{ t('core.taskEditRetry') }}
                    </UiButton>
                  </div>
                </aside>
              </div>

              <div class="task-edit-footer">
                <p class="task-edit-note" :class="{ 'task-edit-dirty': editHasChanges }" role="status">
                  {{ editHasChanges ? t('core.taskEditUnsaved') : t('core.taskEditSaveHint') }}
                </p>
                <UiFormActions class="task-edit-actions">
                  <UiButton
                    data-role="task-edit-cancel"
                    variant="ghost"
                    :disabled="busy === 'edit'"
                    @click="cancelTaskEdit"
                  >
                    {{ t('core.cancel') }}
                  </UiButton>
                  <UiButton
                    data-role="task-edit-save"
                    tone="accent"
                    variant="solid"
                    :loading="busy === 'edit'"
                    :disabled="!editCanSave"
                    :loading-label="t('core.taskEditSaving')"
                    @click="saveTaskEdit"
                  >
                    {{ t('core.save') }}
                  </UiButton>
                </UiFormActions>
              </div>
            </form>

            <template v-else>
              <p v-if="editMessage" class="edit-message" role="status">{{ editMessage }}</p>
              <div v-if="cleanDesc" class="desc-box">
                <p class="desc" v-html="descHtml"></p>
              </div>

              <section v-if="checklist.rows.length || canEditChecklist"
                       class="task-extra" data-role="task-checklist">
                <h5>{{ t('core.taskChecklist') }} · {{ t('core.taskChecklistProgress', {
                  complete: checklist.complete,
                  total: checklist.total,
                }) }}</h5>
                <div class="task-checklists">
                  <section v-for="list in checklistLists" :key="list.id"
                           class="task-checklist-list" :data-checklist-list="list.id">
                    <ul class="task-checklist">
                      <li v-for="entry in list.entries" :key="entry.key" class="task-checklist-entry"
                          :class="{ 'is-list-header': entry.depth === 0 }"
                          :style="{ marginInlineStart: `${Math.max(0, entry.depth - 1) * 16}px` }">
                        <div v-if="entry.item" class="task-checklist-row"
                             :data-checklist-id="entry.item.id">
                          <h6 v-if="entry.depth === 0" class="task-checklist-heading">
                            <span>{{ entry.item.title }}</span>
                            <span v-if="entry.item.important" :aria-label="t('core.taskImportant')">★</span>
                            <span v-if="entry.progress" class="context-label"
                                  data-role="checklist-list-progress">
                              {{ t('core.taskChecklistProgress', entry.progress) }}
                            </span>
                          </h6>
                          <div v-else class="task-checklist-label">
                            <UiCheckbox :checked="entry.item.complete"
                                        :disabled="!canEditChecklist || Boolean(busy)"
                                        @change="toggleChecklistItem(entry.item, $event)">
                              <span :class="{ 'task-checklist-complete': entry.item.complete }">
                                {{ entry.item.title }}
                              </span>
                              <span v-if="entry.item.important" :aria-label="t('core.taskImportant')">★</span>
                            </UiCheckbox>
                          </div>
                          <template v-if="canEditChecklist">
                            <div v-if="checklistEditing === entry.item.id" class="task-checklist-editor">
                              <UiInput v-model="checklistTitleDraft" data-role="checklist-rename-input"
                                       data-escape-owner
                                       :aria-label="t(entry.depth === 0
                                         ? 'core.taskChecklistListTitle' : 'core.taskChecklistTitle')"
                                       maxlength="255" :disabled="Boolean(busy)"
                                       @keydown.enter.prevent="renameChecklistItem"
                                       @keydown.esc.stop.prevent="checklistEditing = null" />
                              <UiFormActions align="start">
                                <UiButton size="compact" tone="accent" variant="solid"
                                          :disabled="Boolean(busy) || !checklistTitleDraft.trim()"
                                          data-role="checklist-rename-save" @click="renameChecklistItem">
                                  {{ t('core.taskChecklistSave') }}
                                </UiButton>
                                <UiButton size="compact" variant="ghost" :disabled="Boolean(busy)"
                                          data-role="checklist-rename-cancel" @click="checklistEditing = null">
                                  {{ t('core.taskChecklistCancel') }}
                                </UiButton>
                              </UiFormActions>
                            </div>
                            <div v-else class="task-checklist-actions">
                              <UiIconButton v-if="entry.depth > 0"
                                            :label="t('core.taskChecklistAddChild', { title: entry.item.title })"
                                            v-tooltip="t('core.taskChecklistAddChild', { title: entry.item.title })"
                                            :disabled="Boolean(busy) || checklistAdding !== null"
                                            data-task-action="checklist-add-child"
                                            @click="openChecklistItem(entry.item.id)">
                                +
                              </UiIconButton>
                              <UiIconButton :label="t(entry.depth === 0
                                              ? 'core.taskChecklistListRename' : 'core.taskChecklistRename')"
                                            v-tooltip="t(entry.depth === 0
                                              ? 'core.taskChecklistListRename' : 'core.taskChecklistRename')"
                                            :disabled="Boolean(busy)"
                                            data-task-action="checklist-rename"
                                            @click="editChecklistItem(entry.item)">
                                ✎
                              </UiIconButton>
                              <UiIconButton :label="t(entry.depth === 0
                                              ? 'core.taskChecklistListDelete' : 'core.taskChecklistDelete')"
                                            v-tooltip="t(entry.depth === 0
                                              ? 'core.taskChecklistListDelete' : 'core.taskChecklistDelete')"
                                            :disabled="Boolean(busy)"
                                            data-task-action="checklist-delete"
                                            @click="deleteChecklistItem(entry.item)">
                                ✕
                              </UiIconButton>
                            </div>
                          </template>
                        </div>
                        <div v-else :data-checklist-parent="entry.parentId">
                          <div v-if="checklistAdding === entry.parentId" class="task-checklist-editor"
                               data-role="checklist-item-form">
                            <span class="context-label">
                              {{ entry.depth === 1 ? t('core.taskChecklistNewItem')
                                : t('core.taskChecklistNewChild', { title: entry.parentTitle }) }}
                            </span>
                            <UiInput ref="checklistItemInputs" v-model="checklistDrafts[entry.parentId]"
                                     data-role="checklist-add-input" data-escape-owner
                                     :aria-label="t('core.taskChecklistTitle')"
                                     :placeholder="t('core.taskChecklistTitle')"
                                     maxlength="255" :disabled="Boolean(busy)"
                                     @keydown.enter.prevent="addChecklistItem(entry.parentId)"
                                     @keydown.esc.stop.prevent="cancelChecklistItem(entry.parentId)" />
                            <UiFormActions align="start">
                              <UiButton size="compact" tone="accent" variant="solid"
                                        data-role="checklist-add"
                                        :loading="busy === `checklist-${entry.parentId}`"
                                        :loading-label="t('core.taskChecklistSaving')"
                                        :disabled="Boolean(busy) || !checklistDrafts[entry.parentId]?.trim()"
                                        @click="addChecklistItem(entry.parentId)">
                                {{ t('core.taskChecklistSave') }}
                              </UiButton>
                              <UiButton size="compact" variant="ghost" data-role="checklist-item-cancel"
                                        :disabled="Boolean(busy)" @click="cancelChecklistItem(entry.parentId)">
                                {{ t('core.taskChecklistCancel') }}
                              </UiButton>
                            </UiFormActions>
                          </div>
                          <UiButton v-else size="compact" variant="ghost" data-role="checklist-add-item"
                                    :disabled="Boolean(busy) || checklistAdding !== null"
                                    @click="openChecklistItem(entry.parentId)">
                            + {{ t('core.taskChecklistAdd') }}
                          </UiButton>
                        </div>
                      </li>
                    </ul>
                  </section>
                </div>
                <p v-if="checklistSavedTitle" class="task-checklist-saved" role="status"
                   data-role="checklist-item-saved">
                  {{ t('core.taskChecklistItemSaved', { title: checklistSavedTitle }) }}
                </p>
                <div v-if="canEditChecklist" class="task-checklist-create">
                  <div v-if="checklistCreating" class="task-checklist-editor">
                    <UiInput v-model="checklistListTitle" data-role="checklist-list-input" data-escape-owner
                             :aria-label="t('core.taskChecklistListTitle')"
                             :placeholder="t('core.taskChecklistListTitle')"
                             maxlength="255" :disabled="Boolean(busy)"
                             @keydown.enter.prevent="createChecklistList"
                             @keydown.esc.stop.prevent="cancelChecklistList" />
                    <UiFormActions align="start">
                      <UiButton size="compact" tone="accent" variant="solid" data-role="checklist-create"
                                :disabled="Boolean(busy) || !checklistListTitle.trim()"
                                @click="createChecklistList">
                        {{ t('core.taskChecklistCreate') }}
                      </UiButton>
                      <UiButton size="compact" variant="ghost" data-role="checklist-create-cancel"
                                :disabled="Boolean(busy)" @click="cancelChecklistList">
                        {{ t('core.taskChecklistCancel') }}
                      </UiButton>
                    </UiFormActions>
                  </div>
                  <UiButton v-else size="compact" variant="ghost" data-role="checklist-add-list"
                            :disabled="Boolean(busy)" @click="checklistCreating = true">
                    {{ t('core.taskChecklistAddList') }}
                  </UiButton>
                </div>
              </section>

              <section v-if="taskTags.length || canEditTags" class="task-extra" data-role="task-tags">
                <h5>{{ t('core.taskTags') }}</h5>
                <div v-if="taskTags.length" class="task-tag-list">
                  <span v-for="tag in taskTags" :key="tag" class="tag">
                    {{ tag }}
                    <UiIconButton v-if="canEditTags" :label="t('core.taskTagRemove', { tag })"
                                  :disabled="Boolean(busy) || comLoading || !taskTagsLoaded"
                                  data-task-action="task-tag-remove"
                                  @click="updateTags(taskTags.filter((item) => item !== tag))">
                      ✕
                    </UiIconButton>
                  </span>
                </div>
                <div v-if="canEditTags" class="task-tag-editor">
                  <UiInput ref="taskTagInput" v-model="tagDraft" data-role="task-tag-input"
                           :placeholder="t('core.taskTagAdd')" :aria-label="t('core.taskTagAdd')"
                           maxlength="100"
                           :disabled="Boolean(busy) || comLoading || !taskTagsLoaded || taskTags.length >= 50"
                           @keydown.enter.prevent="addTag" />
                  <UiButton data-role="task-tag-add"
                            :disabled="Boolean(busy) || comLoading || !taskTagsLoaded
                              || taskTags.length >= 50 || !tagDraft.trim()" @click="addTag">
                    {{ t('core.taskTagAddButton') }}
                  </UiButton>
                </div>
              </section>

              <section v-if="taskSubtasks.length" class="task-extra" data-role="task-subtasks">
                <h5>{{ t('core.taskSubtasks') }}</h5>
                <ul class="task-subtasks">
                  <li v-for="subtask in taskSubtasks" :key="subtask.id">
                    <UiButton size="compact" @click="ui.openTask(subtask.id)">
                      #{{ subtask.id }} {{ subtask.title }}
                    </UiButton>
                    <span v-if="subtask.statusText" class="context-label">{{ subtask.statusText }}</span>
                  </li>
                </ul>
              </section>

              <!-- Обсуждение в Telegram: то, на что показывают ссылки в описании -->
              <section v-if="tgLinks.length" class="tg">
                <div class="tlbl">{{ t('core.taskObsuzhdenieVTelegram') }}</div>
                <div v-for="(l, i) in tgLinks" :key="i" class="tgitem">
                  <!-- Нераскрытая ссылка обязана объяснить себя: молчание читается
                       как «в чате пусто», а причина — как «сюда нет доступа». -->
                  <div v-if="!l.ok" class="tgfail">
                    <span class="tgurl">{{ l.url }}</span>
                    <span class="tgwhy">{{ l.message || t('core.taskSsylkaNeRaskryta') }}</span>
                  </div>
                  <template v-else>
                    <div class="tghead">
                      <span class="tgchat">{{ l.chat?.title || t('core.taskChat') }}</span>
                      <span v-if="l.chat?.username" class="tgat">@{{ l.chat.username }}</span>
                      <span v-if="l.thread" class="tgthread">{{ t('core.taskTema') }} {{ l.thread }}</span>
                      <a class="tgurl" :href="l.url" target="_blank" rel="noopener">{{ t('core.taskOtkryt') }}</a>
                    </div>
                    <div
                      v-for="q in l.quotes"
                      :key="q.messageId"
                      class="tgq"
                      :class="{ tgtarget: q.target }"
                    >
                      <div class="tgmeta">
                        <span class="tgauthor">{{ q.author }}</span>
                        <span class="tgtime">{{ tgTime(q.at) }}</span>
                        <span v-if="q.target" class="tgpin">{{ t('core.taskSsylka') }}</span>
                      </div>
                      <div class="tgtext">
                        {{ q.text }}<template v-if="q.trimmed">…</template>
                      </div>
                      <div v-if="q.media?.length" class="tgmedia">{{ q.media.join(', ') }}</div>
                    </div>
                    <div v-if="l.more" class="tgmore"> {{ t('core.taskEsche2') }} {{ l.more }} {{ tgPlural(l.more) }} {{ t('core.taskVVetke') }} </div>
                  </template>
                </div>
              </section>
              <div v-if="!cleanDesc && !tgLinks.length" class="brief-empty"> {{ t('core.taskPostanovkaPokaNeZagruzhena') }} </div>
            </template>
          </div>
        </section>

        <section class="task-pane work-pane" :aria-label="t('core.taskDesignAnalysis')">
          <div class="tab-scroll" :class="{ 'show-comments': mtab === 'comments' }">
            <!-- Триаж: оценка сложности/рисков без стенда -->
            <div
              v-show="mtab === 'triage'"
              id="task-panel-triage"
              class="triage"
              role="tabpanel"
              aria-labelledby="task-tab-triage"
            >
          <div v-if="!analysisEnabled" class="triage-disabled"> {{ t('core.taskTriazhVyklyuchenVNastroykah') }} </div>
          <template v-else>
          <div v-if="!triagePending" class="thead2" :class="{ 'is-empty': !triage?.analysis }">
            <div class="triage-summary">
              <span class="triage-summary-title">{{ t('core.taskOtsenkaPoKodu') }}</span>
              <span v-if="triage?.analysis" class="triage-ready">{{ t('core.taskGotova') }}</span>
              <span v-else-if="triageState === 'failed'" class="terr"> {{ t('core.taskNeUdalosOtsenit') }} {{ triage?.status?.error || t('core.taskPoprobuyteEscheRaz') }}
              </span>
              <span v-else class="tmuted">{{ t('core.taskZadachaEscheNeOtsenena') }}</span>
            </div>
            <p v-if="!triage?.analysis" class="triage-empty-hint">{{ t('core.taskDesignAnalysisHint') }}</p>
            <UiButton
              data-role="task-compact-action"
              tone="accent"
              :disabled="!canAnalyzeTask"
              @click="analyzeNow"
            >
              {{ triage?.analysis ? t('core.taskPereotsenit') : t('core.taskOtsenitZadachu') }}
            </UiButton>
            <dl v-if="triage?.analysis" class="triage-metrics">
              <div
                v-for="metric in triageMetrics"
                :key="metric.id"
                class="triage-metric"
                :data-metric="metric.id"
                :data-tone="metric.tone"
              >
                <dt>{{ metric.label }}</dt>
                <dd>{{ metric.value }}</dd>
              </div>
            </dl>
            <p v-if="triage?.analysis" class="triage-route" v-tooltip="triage.analysis.route_reason || ''">
              {{ triageWorkLabel }}
              <span v-if="triageDepthLabel">· {{ triageDepthLabel }} {{ t('core.taskMarshrut2') }}</span>
            </p>
          </div>

          <!-- Нажал «Уточнить» или «Переоценить» — и до конца захода на панели остаётся
               только ход разбора со счётчиком. Прошлая оценка и уже отвеченные вопросы к
               нему отношения не имеют, а сделать с ними человек всё равно ничего не может. -->
          <div v-else class="thead2 triage-progress" role="status" aria-live="polite">
            <span class="tlbl">{{ t('core.pluginAnalysis') }}</span>
            <UiSpinner decorative />
            <span class="triage-progress-state">{{ triageProgressLabel }}</span>
            <span v-if="triageProgressElapsed" class="triage-progress-time mono">
              {{ triageProgressElapsed }}
            </span>
          </div>

          <template v-if="triage?.analysis && !triagePending">
            <div
              v-if="triage.analysis.summary || triage.stale?.length || triage.analysis.risk_markers?.length"
              class="triage-findings"
            >
              <section v-if="triage.analysis.summary" class="triage-result" :aria-label="t('core.taskVyvodOtsenki')">
                <h5>{{ t('core.taskVyvod') }}</h5>
                <p class="tsum">{{ triage.analysis.summary }}</p>
              </section>
              <p v-if="triage.stale?.length" class="tstale"> {{ t('core.taskKodPodOtsenkoyMenyalsya') }} {{ triage.stale.slice(0, 5).join(', ') }}{{ triage.stale.length > 5 ? t('core.taskIEscheLength5', { length5: triage.stale.length - 5 }) : '' }} {{ t('core.taskStoitPereotsenit') }} </p>
              <section v-if="triage.analysis.risk_markers?.length" class="triage-risks">
                <h5>{{ t('core.taskRiskiIOgranicheniya') }} <span>{{ triage.analysis.risk_markers.length }}</span></h5>
                <ul class="tlist">
                  <li v-for="m in triage.analysis.risk_markers" :key="m">{{ m }}</li>
                </ul>
              </section>
            </div>
            <section
              v-if="triageQuestions.length"
              class="clarify"
              aria-labelledby="task-triage-questions-title"
            >
              <header class="clarify-head">
                <div>
                  <h5 id="task-triage-questions-title">{{ t('core.taskNuzhnoVasheReshenie') }}</h5>
                  <p>{{ t('core.taskVyberitePodhodyaschiyVariantPri') }}</p>
                </div>
              </header>
              <div class="clarify-list">
              <article
                v-for="(question, questionIndex) in triageQuestions"
                :key="question.id"
                class="clarify-card"
                :class="{ 'is-answered': answerFor(question) }"
              >
                <div class="clarify-question">
                  <span class="clarify-index" aria-hidden="true">{{ questionIndex + 1 }}</span>
                  <div class="clarify-question-copy">
                    <h6>{{ question.text }}</h6>
                    <span
                      v-if="answerFor(question)"
                      class="clarify-status"
                      :class="{
                        warn: answerFor(question)!.status === 'human_required',
                      }"
                    >
                      {{ answerFor(question)!.status === 'human_required'
                        ? t('core.taskArbitrOstavilVoprosCheloveku')
                        : answerFor(question)!.actor === 'grigdesk-arbiter'
                          ? t('core.taskArbitrMashinnyyOtvet')
                          : t('core.taskOtvetilChelovek') }}
                    </span>
                  </div>
                </div>
                <div v-if="question.recommendation" class="clarify-recommendation">
                  <span class="clarify-recommendation-label">{{ t('core.taskRekomendatsiya') }}</span>
                  <strong v-if="recommendationOption(question)">
                    {{ recommendationOption(question) }}
                  </strong>
                  <span v-if="question.recommendation.reason">
                    {{ question.recommendation.reason }}
                  </span>
                </div>
                <UiChoiceList
                  v-if="question.options.length"
                  class="clarify-options"
                  data-role="task-clarification-options"
                  :label="question.text"
                  :model-value="selectedClarifyOption(question.id)"
                  :options="clarifyOptions(question)"
                  selection-indicator
                  @update:model-value="selectClarifyOption(question.id, $event)"
                />
                <div v-if="question.options.length" class="clarify-compose-row">
                  <UiDisclosureButton
                    :controls="`task-clarification-extra-${questionIndex}`"
                    density="compact"
                    variant="text"
                    :open="composerOpenFor(question)"
                    @update:open="setComposerOpen(question.id, $event)"
                  >
                    {{ composerOpenFor(question) ? t('core.taskSkrytPoyasnenie') : t('core.taskDobavitPoyasnenie') }}
                  </UiDisclosureButton>
                </div>
                <div
                  v-show="composerOpenFor(question)"
                  :id="`task-clarification-extra-${questionIndex}`"
                  class="clarify-answer"
                >
                  <div class="clarify-answer-head">
                    <span>{{ question.options.length ? t('core.taskPoyasnenieKVyboru') : t('core.taskVashOtvet') }}</span>
                    <small>{{ question.options.length ? t('core.taskNeobyazatelno') : t('core.taskSvoimiSlovami') }}</small>
                  </div>
                  <UiTextarea
                    v-model="clarifyDrafts[question.id]!.text"
                    class="clarify-text"
                    data-role="task-clarification"
                    rows="2"
                    :placeholder="question.options.length
                      ? t('core.taskDobavteDetaliEsliOdnogo')
                      : t('core.taskOtvetteNaVoprosTriazha')"
                    @focus="activeQuestionId = question.id"
                    @paste="onClarifyPaste(question.id, $event)"
                    @keydown.ctrl.enter.prevent="sendClarify"
                  />
                  <div class="clarify-answer-tools">
                    <span>{{ t('core.taskLokalnoNeVB24') }}</span>
                    <div class="clarify-card-actions">
                      <UiFilePicker
                        data-role="task-attachment"
                        accept="image/*"
                        multiple
                        density="compact"
                        :label="t('core.taskPrilozhitFoto')"
                        :loading-label="t('core.taskPrikladyvayuFoto')"
                        v-tooltip="t('core.taskPrilozhitFotoKOtvetu')"
                        :busy="clarifyUploading"
                        :show-summary="false"
                        :show-reset="false"
                        @change="onClarifyFiles(question.id, $event)"
                      >
                        <template #leading>
                          <svg
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                          >
                            <rect x="3" y="3" width="18" height="18" rx="2.5" />
                            <circle cx="8.6" cy="8.6" r="1.4" />
                            <path d="m20 16-4.5-4.5L7 19" />
                          </svg>
                        </template>
                      </UiFilePicker>
                      <UiIconButton
                        :label="t('core.taskNachatDiktovkuOtvetaNa', { text: question.text })"
                        v-tooltip="t('core.taskNachatDiktovku')"
                        @click="startClarifyDictation(question.id)"
                      >
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          aria-hidden="true"
                        >
                          <rect x="9" y="3" width="6" height="11" rx="3" />
                          <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6" />
                        </svg>
                      </UiIconButton>
                    </div>
                  </div>
                  <div v-if="draftFor(question.id).attachments.length" class="attrow">
                    <span
                      v-for="attachment in draftFor(question.id).attachments"
                      :key="attachment.file"
                      class="attchip"
                    >
                      <img :src="attachment.url" :alt="attachment.name" />
                      <span class="attname">{{ attachment.name }}</span>
                      <UiIconButton
                        :label="t('core.taskUbratName', { name: attachment.name })"
                        v-tooltip="t('settings.remove')"
                        @click="dropClarifyAtt(question.id, attachment.file)"
                      >
                        ✕
                      </UiIconButton>
                    </span>
                  </div>
                </div>
              </article>
              </div>
              <div class="clarify-submit">
                <UiFormActions align="start">
                  <UiButton
                    data-role="task-compact-action"
                    tone="accent"
                    variant="solid"
                    :loading="busy === 'clarify' || clarifyUploading"
                    :disabled="busy === 'clarify' || clarifyUploading || !hasClarifyAnswers"
                    :loading-label="t('core.taskSohranyayuUtochneniya')"
                    @click="sendClarify"
                  >
                    <template #leading><UiRefreshIcon /></template> {{ t('core.taskUtochnitIPereotsenit') }} </UiButton>
                  <UiButton
                    v-if="analysisManifest"
                    :loading="busy === 'arbitrate'"
                    :disabled="busy === 'arbitrate'"
                    @click="arbitrateQuestions"
                  > {{ t('core.taskRazobratArbitrom') }} </UiButton>
                </UiFormActions>
              </div>
            </section>
            <div v-if="clarifySaved" class="clhist">
              <UiDisclosureButton
                controls="task-triage-history"
                data-role="task-analysis-disclosure"
                density="compact"
                :open="showClarifyHistory"
                @update:open="showClarifyHistory = $event"
              > {{ t('core.taskUtochneniyaDlyaAgentov') }} </UiDisclosureButton>
              <div v-if="showClarifyHistory" id="task-triage-history" class="clhist-body">
                <p class="triage-private-hint">{{ t('core.taskHranyatsyaLokalnoZakazchikIh') }}</p>
                {{ clarifySaved }}
              </div>
            </div>
            <UiDisclosureButton
              v-if="triage.note"
              data-role="task-note-disclosure"
              controls="task-triage-note"
              density="compact"
              :open="showNote"
              @update:open="showNote = $event"
            > {{ t('core.taskRazvednotaKartaKoda') }} </UiDisclosureButton>
            <div v-if="showNote" id="task-triage-note" class="tnote" v-html="noteHtml"></div>
            <div v-if="triage.analysis.generated_at || triage.analysis.meta" class="triage-details">
              <UiDisclosureButton
                controls="task-analysis-details"
                data-role="task-analysis-disclosure"
                density="compact"
                :open="showAnalysisDetails"
                @update:open="showAnalysisDetails = $event"
              > {{ t('core.taskPodrobnostiOtsenki') }} </UiDisclosureButton>
              <dl v-if="showAnalysisDetails" id="task-analysis-details" class="tmeta">
                <template v-if="triage.analysis.generated_at">
                  <dt>{{ t('core.taskPoluchena') }}</dt>
                  <dd>{{ new Date(triage.analysis.generated_at).toLocaleString(uiLocale) }}</dd>
                </template>
                <template v-if="Object.keys(triage.analysis.repos || {}).length">
                  <dt>{{ t('core.code') }}</dt>
                  <dd>
                    <div
                      v-for="(repo, key) in triage.analysis.repos"
                      :key="key"
                      data-role="task-analysis-source"
                    >
                      {{ triageSourceLabel(key, repo) }}
                    </div>
                  </dd>
                </template>
                <template v-if="triage.analysis.meta?.provider">
                  <dt>{{ t('core.taskEditResponsible') }}</dt><dd>{{ triage.analysis.meta.provider }}</dd>
                </template>
                <template v-if="triage.analysis.meta?.model">
                  <dt>{{ t('core.chatOptionModel') }}</dt><dd>{{ triage.analysis.meta.model }}</dd>
                </template>
                <template v-if="triage.analysis.meta?.effort">
                  <dt>{{ t('settings.effort') }}</dt><dd>{{ triage.analysis.meta.effort }}</dd>
                </template>
                <template v-if="triage.analysis.meta?.duration_ms != null">
                  <dt>{{ t('core.taskDlitelnost') }}</dt>
                  <dd>{{ mmss(triage.analysis.meta.duration_ms / 1000) }}</dd>
                </template>
                <template v-if="triage.analysis.meta?.cost_usd != null">
                  <dt>{{ t('core.taskStoimost') }}</dt><dd>${{ triage.analysis.meta.cost_usd.toFixed(2) }}</dd>
                </template>
              </dl>
            </div>
          </template>
          </template>
        </div>

        <!-- Комментарии задачи (таб): список из B24 + добавление -->
        <div
          v-if="isB24Task && trackerCaps.comments"
          v-show="mtab === 'comments'"
          id="task-panel-comments"
          class="comtab"
          role="tabpanel"
          aria-labelledby="task-tab-comments"
        >
          <TaskLoading v-if="mtab === 'comments' && comLoading && comments === null"
                       :label="t('core.taskZagruzkaKommentariev')" area="comments" />
          <div v-else-if="comments && !comments.length" class="tmuted">{{ t('core.taskKommentarievNet') }}</div>
          <div v-else-if="comments" class="comlist">
            <div v-for="c in comments" :key="c.mid" class="com">
              <div class="comhead">
                <b>{{ c.author }}</b>
                <span class="comtime mono">{{ formatDateTime(c.time) || c.time }}</span>
              </div>
              <div class="comtext">{{ c.text }}</div>
              <div v-if="c.attachments?.length" class="comatts">
                <span v-for="a in c.attachments" :key="a.attachedId" class="comatt">📎 {{ a.name || t('core.taskFaylAttachedid', { attachedId: a.attachedId }) }}</span>
              </div>
            </div>
          </div>
          <div class="comment">
            <UiTextarea
              v-model="commentText"
              class="comment-text"
              data-role="task-comment"
              :aria-label="t('core.taskKommentariyKZadache')"
              rows="2"
              :disabled="busy === 'comment'"
              :placeholder="t('core.taskDobavitKommentariy')"
            />
            <UiButton
              :loading="busy === 'comment'"
              :disabled="busy === 'comment' || !commentText.trim()"
              :loading-label="t('core.taskOtpravlyayuKommentariy')"
              @click="sendComment"
            > {{ t('core.send') }} </UiButton>
          </div>
        </div>
          </div>
        </section>
      </div>

      <!-- Управление -->
      <footer v-show="!editForm || taskSection !== 'description'" class="controls"
              :aria-label="t('core.taskDeystviyaSZadachey')">
          <div v-if="isB24Task && trackerCaps.timer" class="timer-group" role="group" :aria-label="t('core.taskUchetVremeni')">
            <div class="timer" :class="{ run: running }">
              <span class="tclock mono">{{ elapsed !== null ? secToHMS(elapsed) : '—' }}</span>
              <span class="tstate">{{ running ? t('core.taskIdetUchet') : t('core.taskUchetOstanovlen') }}</span>
            </div>
            <UiButton
              data-context="task-footer-action"
              :tone="running ? 'warning' : 'accent'"
              variant="outline"
              :loading="busy === 'timer'"
              :disabled="busy === 'timer' || timerStartBlocked"
              :loading-label="t('core.taskObnovlyayuUchetVremeni')"
              v-tooltip="timerStartBlocked ? t('core.taskZadachaZavershenaSnachalaVozobnovite') : null"
              @click="toggleTimer"
            >
              {{ running ? t('core.taskOstanovitUchet') : t('core.taskNachatUchet') }}
            </UiButton>
          </div>
          <div class="cbtns">
            <!-- Уже на конвейере — вместо запуска показываем переход, повторный старт заблокирован.
                 Затык виден прямо на кнопке: карточку задачи открывают чаще, чем конвейер, а
                 «Уже на конвейере» одинаково выглядело и у идущей задачи, и у вставшей, поэтому
                 ожидание человека оставалось незаметным. -->
            <UiButton
              v-if="conveyor"
              data-context="task-footer-action"
              :tone="conveyor.stall ? 'danger' : 'accent'"
              variant="outline"
              v-tooltip="conveyor.stall
                ? [conveyor.stall.title, conveyor.stall.hint].filter(Boolean).join(' — ')
                : t('core.taskZadachaUzheNaKonveyere', { route: conveyor.route || t('core.taskMarshrut2') })"
              @click="openConveyor"
            >
              {{ conveyor.stall ? (conveyor.stall.kind === 'crashed' ? t('core.taskKonveyerOborvalsya') : t('core.taskKonveyerVstal'))
                 : conveyor.daemonAlive ? t('core.taskDesignPipelineRunning')
                   : t('core.taskDesignPipeline') }} →
            </UiButton>
            <UiButton
              v-else
              data-context="task-footer-action"
              data-role="task-launch-open"
              tone="accent"
              variant="outline"
              :loading="busy === 'launch' || launchOptionsBusy"
              :disabled="!detail || loading || busy === 'launch' || launchOptionsBusy || !!launchForm"
              :loading-label="t('core.taskChitayuParametryZapuska')"
              v-tooltip="launchOpenHint"
              @click="openLaunch"
            >
              {{ t('core.taskDesignLaunch') }}
            </UiButton>
            <UiButton
              v-if="isB24Task && completed && trackerCaps.renew"
              data-context="task-footer-action"
              tone="success"
              variant="solid"
              :loading="busy === 'renew'"
              :disabled="busy === 'renew'"
              :loading-label="t('core.taskVozobnovlyayuZadachu')"
              @click="renew"
            > {{ t('core.taskVozobnovit') }} </UiButton>
            <template v-else-if="isB24Task && awaitingReview && trackerCaps.review">
              <UiButton tone="success" :loading="busy === 'approve'" :disabled="Boolean(busy)"
                        data-role="task-approve" @click="reviewTask(true)">
                {{ t('core.taskApprove') }}
              </UiButton>
              <UiButton :loading="busy === 'disapprove'" :disabled="Boolean(busy)"
                        data-role="task-disapprove" @click="reviewTask(false)">
                {{ t('core.taskDisapprove') }}
              </UiButton>
            </template>
            <UiButton
              v-else-if="isB24Task && !completed && trackerCaps.complete"
              data-context="task-footer-action"
              tone="success"
              variant="solid"
              :loading="busy === 'complete'"
              :disabled="busy === 'complete'"
              :loading-label="t('core.taskZavershayuZadachu')"
              @click="complete"
            > {{ t('core.taskZavershit') }} </UiButton>
          </div>
          <div v-if="canUsePersonal || sandbox" class="csecondary">
            <div class="ctools" role="group" :aria-label="t('core.taskToolsActions')">
              <UiButton
                v-if="canUsePersonal && shelfEnabled"
                data-context="task-footer-action"
                data-role="task-shelf-toggle"
                tone="neutral"
                variant="ghost"
                :pressed="shelf.isOnShelf(taskId)"
                :loading="shelf.isPending(taskId)"
                :disabled="shelf.isPending(taskId)"
                :loading-label="t('core.taskObnovlyayuPolku')"
                @click="toggleShelf"
              >
                {{ shelf.isOnShelf(taskId) ? t('core.taskNaPolke') : t('core.taskNaPolku') }}
              </UiButton>
              <OpenDiffButton
                data-context="task-footer-action"
                variant="ghost"
                :task-id="taskId!"
              />
            </div>
            <div
              v-if="sandbox || (isB24Task && trackerCaps.delete)"
              class="cdanger"
              role="group"
              :aria-label="t('core.taskDestructiveActions')"
            >
              <!-- Стенд и удаление доступны напрямую, но отделены от запуска
                   и завершения, чтобы повседневные действия не соседствовали с ними. -->
              <UiButton
                v-if="sandbox"
                data-context="task-footer-action"
                tone="danger"
                variant="ghost"
                :loading="sandboxBusy"
                :disabled="sandboxBusy"
                :loading-label="t('core.taskSnoshuStend')"
                v-tooltip="t('core.taskSnestiPesochnitsuZadachiFront', { fePort: sandbox.fePort, apiPort: sandbox.apiPort ? `, API :${sandbox.apiPort}` : '' })"
                @click="sandboxDown"
              > {{ t('core.taskSnestiStend') }} </UiButton>
              <UiButton
                v-if="isB24Task && trackerCaps.delete"
                data-context="task-footer-action"
                data-role="task-delete"
                tone="danger"
                variant="ghost"
                :loading="busy === 'delete'"
                :disabled="Boolean(busy)"
                @click="deleteTask"
              >
                {{ t('core.taskDelete') }}
              </UiButton>
            </div>
          </div>
          <!-- Обычный запуск показывает только человеческое решение. Immutable-техника
               видна кратко и раскрывается отдельно для редкой ручной корректировки. -->
          <div v-if="launchForm" class="lform">
            <div v-if="!launchForm.profile || launchOpts!.profiles?.length! > 1" class="lrow">
              <label class="llbl" for="launch-profile">{{ t('core.taskProfil') }}</label>
              <UiSelect
                id="launch-profile"
                v-model="launchForm.profile"
                data-context="task-launch"
                compact
                :disabled="launchOptionsBusy || busy === 'launch'"
                @change="changeLaunchProfile"
              >
                <option v-if="!launchForm.profile" disabled value="">{{ t('core.taskVyberiProfil') }}</option>
                <option v-for="p in launchOpts!.profiles" :key="p" :value="p">{{ p }}</option>
              </UiSelect>
              <span v-if="launchOptionsBusy" class="lhint">
                <UiSpinner decorative /> {{ t('core.taskChitayuKatalog') }} </span>
            </div>
            <div class="lrow">
              <label class="llbl" for="launch-route">{{ t('core.taskMarshrut3') }}</label>
              <UiSelect
                id="launch-route"
                v-model="launchForm.route"
                data-context="task-launch"
                compact
                :disabled="launchOptionsBusy || busy === 'launch'"
                @change="changeLaunchRoute"
              >
                <option
                  v-for="r in launchOpts!.routes"
                  :key="r"
                  :value="r"
                  :title="launchOpts!.routeOptions?.[r]?.title || ''"
                >{{ r }}</option>
              </UiSelect>
              <span v-if="launchRouteIsSuggested" class="lhint suggested"> {{ t('core.taskRekomendovanTriazhem') }}<template v-if="routeDepthLabel"> · {{ routeDepthLabel }}</template>
              </span>
              <!-- Человек ушёл с рекомендованного маршрута: основание относится к ней, а не к
                   выбранному, поэтому текстом его больше не показываем — только подсказкой. -->
              <span
                v-else-if="routeSuggestion"
                class="lhint"
                v-tooltip="routeSuggestionReason"
              >{{ t('core.taskTriazhPredlagaet') }} {{ routeSuggestion }}</span>
              <span v-if="launchRouteIsSuggested && routeSuggestionReason" class="lhint lreason"> {{ t('core.taskPochemu') }} {{ routeSuggestionReason }}
              </span>
            </div>
            <div v-if="launchOpts!.runners?.length" class="lrow">
              <label class="llbl" for="launch-runner">{{ t('core.taskEditResponsible') }}</label>
              <UiSelect
                id="launch-runner"
                v-model="launchForm.runner"
                data-context="task-launch"
                compact
                :disabled="launchOptionsBusy || busy === 'launch'"
              >
                <option value="">{{ t('core.stageProfileDefault') }}<template v-if="launchOpts!.defaultRunner"> ({{ providerLabel(launchOpts!.defaultRunner) }})</template></option>
                <option v-for="r in launchOpts!.runners" :key="r" :value="r">{{ providerLabel(r) }}</option>
              </UiSelect>
            </div>

            <div class="lsummary" :aria-label="t('core.taskParametryZapuska')">
              <div class="lsummary-row">
                <span>{{ t('core.taskProfil') }}</span>
                <b class="mono">{{ launchForm.profile }}</b>
              </div>
              <div v-if="launchNeedsDelivery" class="lsummary-row">
                <span>{{ t('core.taskShip') }}</span>
                <b class="mono">{{ launchDeliverySummary }}</b>
              </div>
              <div v-if="launchNeedsInstrumentation" class="lsummary-row">
                <span>{{ t('settings.diagnostics') }}</span>
                <b>{{ launchDiagnosisSummary }} · {{ launchInstrumentationSummary }}</b>
              </div>
              <p v-if="launchNeedsDelivery" class="lshipwarn"> {{ t('core.taskPosleFinalnyhOdobrennyhVorot') }} </p>
            </div>

            <label class="llbl">{{ t('core.taskKriteriiPriemki') }} <span class="lopt">{{ t('core.taskEtoIEstObem') }}</span></label>
            <UiTextarea
              v-model="launchForm.criteria"
              data-role="task-launch-note"
              rows="3"
              :placeholder="t('core.taskNaprimerEksportNePadaet')"
            />
            <p class="lnote"> {{ t('core.taskPoStrokeNaKazhdyy') }} </p>
            <div
              v-if="launchOpts?.scopeSuggestion?.skip?.length"
              class="lnote lscope-skip"
              data-role="task-launch-scope-skip"
            >
              <span class="lscope-skip-title">{{ t('core.taskTriazhPredlagaetNeDelat') }}</span>
              <ul>
                <li v-for="line in launchOpts!.scopeSuggestion.skip" :key="line">{{ line }}</li>
              </ul>
              <span>{{ t('core.taskNeSoglasenDopishiPunkt') }}</span>
            </div>

            <details v-if="launchNeedsDelivery || launchNeedsInstrumentation" class="ladvanced">
              <summary>{{ t('settings.advancedParameters') }}</summary>
              <div class="ladvanced-body">
                <template v-if="launchNeedsDelivery">
                  <label class="llbl">{{ t('core.taskTselevyeVetkiIzKonfiguratsii') }}</label>
                  <div v-for="repo in launchOpts!.repositories" :key="repo.name" class="lrepo">
                    <span class="mono">{{ repo.name }}</span>
                    <code class="mono">{{ repo.targetBranch }}</code>
                  </div>
                </template>
                <template v-if="launchNeedsInstrumentation">
                  <label class="llbl" for="launch-instrumentation"> {{ t('core.taskTochnyyScope') }} <span class="lopt">{{ t('core.taskPoOdnomuRepoRelative') }}</span>
                  </label>
                  <UiTextarea
                    id="launch-instrumentation"
                    v-model="launchForm.instrumentationFiles"
                    class="mono"
                    data-role="task-launch-note"
                    rows="3"
                    spellcheck="false"
                    :placeholder="'service:src/path/file.ext'"
                  />
                  <div class="lrow">
                    <label class="llbl" for="launch-diagnosis-kind">{{ t('core.taskTipDiagnoza') }}</label>
                    <UiSelect
                      id="launch-diagnosis-kind"
                      v-model="launchForm.diagnosisKind"
                      data-context="task-launch"
                      compact
                    >
                      <option value="functional">{{ 'functional' }}</option>
                      <option value="performance">{{ 'performance' }}</option>
                      <option value="data">{{ 'data' }}</option>
                      <option value="integration">{{ 'integration' }}</option>
                    </UiSelect>
                  </div>
                  <label class="llbl" for="launch-diagnosis-signal">{{ t('core.taskNablyudaemyySignal') }}</label>
                  <UiInput
                    id="launch-diagnosis-signal"
                    v-model="launchForm.diagnosisSignal"
                    data-context="task-launch"
                    maxlength="200"
                    autocomplete="off"
                    :placeholder="t('core.taskKorotkoChtoImennoVosproizvoditsya')"
                  />
                  <p class="lnote"> {{ t('core.taskScopeZakreplyaetsyaNaVsyu') }} </p>
                </template>
              </div>
            </details>
            <p v-if="launchValidationError" class="lerror">{{ launchValidationError }}</p>
            <div class="lbtns">
              <UiButton :disabled="!!busy" @click="closeLaunch"> {{ t('core.cancel') }} </UiButton>
              <UiButton
                data-role="task-launch-submit"
                tone="accent"
                variant="solid"
                :aria-label="t('core.taskZapustitZadachu')"
                :loading="busy === 'launch'"
                :disabled="!!busy || launchOptionsBusy || !!launchOpts!.error || !!launchValidationError"
                :loading-label="t('core.taskZapuskayuZadachu')"
                @click="launchSelected"
              > {{ t('core.taskZapustit') }} </UiButton>
            </div>
          </div>
          <PipelineStopPanel
            v-if="conveyor?.stall"
            class="convstall"
            :view="graphStallView(conveyorGraph, conveyor.stall)"
            :identity="`${taskId}:${conveyor.attempt}:${conveyor.stall.since || ''}`"
            :arbitrating="conveyor.arbitrating"
          />
          <span v-if="launchMsg" class="lmsg" aria-live="polite">{{ launchMsg }}</span>
          <span v-if="sandboxMsg" class="lmsg">{{ sandboxMsg }}</span>
      </footer>
    </div>
  </TaskCardFrame>
</template>

<script setup lang="ts">
import TaskSourceChip from '../shared/TaskSourceChip.vue';
import { resolveTrackerTarget } from '../shared/trackerTarget.ts';
import { trackerCapabilities } from '../shared/trackerCapabilities.ts';
import { taskReferenceKey } from '../../../shared/tasks/taskReference.ts';
import TaskLoading from './TaskLoading.vue';

import type {
  BoardNamedItem, TaskComment, TaskDetail, TaskLaunchOptions, TaskSubtask,
} from '../shared/boardContracts.ts';
import type { ChatAttachment } from '../shared/chatContracts.ts';
import type { PipelineTask } from '../shared/pipelineContracts.ts';
import type {
  AnalysisDetail, AnalysisQuestion, AnalysisClarificationEntry, AnalysisMeta,
} from '../../../shared/pipeline/analysisContracts.ts';
import { isRecord, objectOrEmpty } from '../../../shared/lib/objects.ts';
import {
  decodeBoardNamedItems, decodeTaskComments, decodeTaskTags, decodeTaskSubtasks,
} from '../shared/boardContracts.ts';
import type { ChecklistRow } from '../shared/taskCardFields.ts';
import { taskAvatar, taskPeopleNames, taskPeopleIds, taskChecklist } from '../shared/taskCardFields.ts';
import { decodeChatAttachment } from '../shared/chatContracts.ts';
import { decodeLiveGraph, decodePipelineTasks } from '../shared/pipelineContracts.ts';

import { ref, computed, watch, onUnmounted, nextTick, type PropType } from 'vue';
import { storeToRefs } from 'pinia';
import { useRouter } from 'vue-router';
import { api, failureText } from '../shared/apiClient.ts';
import { shellAction } from '../shared/shellClient.ts';
import { leaveTaskForPipeline } from '../shared/taskWindowNavigation.ts';
import { useUiContextSource } from '../composables/useUiContextSource.ts';
import { useTrackersStore } from '../stores/trackers.ts';
import { sseSubscribe } from '../composables/useSse.ts';
import { parseProjectsChange } from '../../../shared/runtime/projectsContracts.ts';
import {
  UiRefreshIcon, confirmDialog, showToast, UiButton, UiCheckbox, UiChoiceList,
  UiDisclosureButton, t, UiField, UiFilePicker, UiFormActions, UiIconButton, UiInput,
  UiPaneHeader, UiSelect, UiSpinner, UiTab, UiTabs, UiTextarea, UiTooltip, vTooltip, messageRef, uiLocale
} from '../ui';
import { useUiStore } from '../stores/ui.ts';
import { useTasksStore } from '../stores/tasks.ts';
import { useBoardStore } from '../stores/board.ts';
import { analyzeTask, readAnalysisDetail, useAnalysisStore } from '../actions/analysis';
import { analysisApi } from '../shared/analysisApi.ts';
import { questionKey } from '../../../shared/pipeline/analysisContracts.ts';
import { useTaskFavoritesStore } from '../stores/taskFavorites.ts';
import { useTaskShelfStore } from '../stores/taskShelf.ts';
import { usePluginsStore } from '../stores/plugins.ts';
import { useTaskSeenStore } from '../stores/taskSeen.ts';
import { useDictationController } from '../features/speech/provider.ts';
import { deadlineState, formatDateTime, liveTimerSec, mmss, secToHMS } from '../shared/format.ts';
import { mdToHtml } from '../shared/md.ts';
import { providerLabel } from '../shared/runnerDisplay.ts';
import OpenDiffButton from './OpenDiffButton.vue';
import TaskCardFrame from './TaskCardFrame.vue';
import PipelineStopPanel from './pipeline/PipelineStopPanel.vue';
import { graphStallView } from '../shared/graphStall.ts';
import type { LiveGraph } from '../shared/pipelineContracts.ts';
import TaskFavoriteButton from './board/TaskFavoriteButton.vue';

interface ClarifyDraft {
  text: string;
  optionIds: string[];
  attachments: ChatAttachment[];
}

const props = defineProps({
  presentation: { type: String as PropType<'dialog' | 'document'>, default: 'dialog' },
});

const COMPLETED_STATUS = 5;

const router = useRouter();

const ui = useUiStore();
const tasks = useTasksStore();
const trackers = useTrackersStore();
const trackerCaps = computed(() => {
  if (!taskSource.value || !trackers.catalog?.enabledIds) {
    return trackers.capabilities;
  }

  const driver = trackers.catalog.drivers.find((entry) => entry.id === taskSource.value?.split('@')[0]);

  return trackerCapabilities(driver?.status === 'active' ? driver.capabilities : undefined);
});
const board = useBoardStore();
const trackerFavorites = useTaskFavoritesStore();
const favorites = computed(() => trackerFavorites.forSource?.(taskSource.value)
  ?? trackerFavorites);
const trackerShelf = useTaskShelfStore();
const shelf = computed(() => trackerShelf.forSource?.(taskSource.value)
  ?? trackerShelf);
const plugins = usePluginsStore();
const trackerSeen = useTaskSeenStore();
const seen = computed(() => trackerSeen.forSource?.(taskSource.value)
  ?? trackerSeen);
const { taskId } = storeToRefs(ui);
const taskSource = computed(() => ui.taskSource);

const detail = ref<TaskDetail | null>(null);
const currentTaskKey = computed(() => taskReferenceKey({
  id: taskId.value!,
  source: taskSource.value || board.data?.source,
  unavailable: ui.taskUnavailable,
}));

// Историческая ссылка закрывает все внешние эффекты до загрузки карточки.
// Длина обычного номера не определяет его источник.
const isB24Task = computed(() => !!taskId.value && !ui.taskUnavailable);
let detailRequest = 0;
const detailTrackerRevision = ref<number | null>(null);
const loading = ref(false);
const canUsePersonal = computed(() => isB24Task.value);
const canAnalyzeTask = computed(() => isB24Task.value);
let triageRequest = 0;
let clarificationsRequest = 0;
const busy = ref<string | null>(null);   // какое действие выполняется
const err = ref<string | null>(null);
const commentText = ref('');
const now = ref(Date.now());

let ticker: ReturnType<typeof setInterval> | null = null;

// Таймер задачи — из кеша доски (там timerRunning/elapsed/startedAt).
const boardTask = computed(() => {
  const d = board.data;

  if (!d || !taskId.value || ui.taskUnavailable) {
    return null;
  }

  const id = Number(taskId.value!);

  for (const list of [d.tasks, d.toReview, d.created, d.accomplice, d.auditor]) {
    const t = (list || []).find((x) => Number(x.id) === id
      && (!taskSource.value || x.source === taskSource.value));

    if (t) {
      return t;
    }
  }

  return null;
});
const taskContext = useUiContextSource('task', { layer: 'overlay', active: false });

function taskContextDetails(id: string | number) {
  const title = detail.value?.title || boardTask.value?.title || '';

  return { taskId: String(id), ...(title ? { title } : {}) };
}

const running = computed(() => !!boardTask.value?.timerRunning);
const completed = computed(() => detail.value?.status === COMPLETED_STATUS);
const awaitingReview = computed(() => detail.value?.status === 4
  || ['await_acceptance', 'my_review'].includes(String(detail.value?.statusKind)));
const timerStartBlocked = computed(() => completed.value && !running.value);
const elapsed = computed(() => (boardTask.value ? liveTimerSec(boardTask.value, now.value) : null));
const shelfEnabled = computed(() => plugins.enabled('shelf'));
const taskProject = computed(() => detail.value?.group_name || boardTask.value?.group || '');
const taskResponsible = computed(() => detail.value?.responsible?.name || boardTask.value?.responsible || '');

const taskStatus = computed(() => detail.value?.statusText || detail.value?.status_label || '');
const taskPriority = computed(() => {
  if (detail.value?.priority_label) {
    return detail.value.priority_label;
  }

  const priority = detail.value?.priority;

  if (priority === 0 || priority === '0') {
    return t('core.taskPriorityLow');
  }
  if (priority === 1 || priority === '1') {
    return t('core.taskPriorityNormal');
  }

  return priority === 2 || priority === '2' ? t('core.taskPriorityHigh') : '';
});
const hasDetailDeadline = computed(() => Boolean(detail.value && Object.hasOwn(detail.value, 'deadline')));
const taskDeadline = computed(() => hasDetailDeadline.value
  ? detail.value?.deadline : boardTask.value?.deadline);
// Старые драйверы уже присылают готовую подпись срока доски. Сохраняем её, когда
// ISO-поля в деталях нет; явный null из деталей по-прежнему снимает срок целиком.
const taskDeadlineText = computed(() => formatDateTime(taskDeadline.value)
  || (!hasDetailDeadline.value ? boardTask.value?.deadline || '' : ''));
const taskDeadlineState = computed(() => deadlineState(taskDeadline.value, now.value)
  ?? (!hasDetailDeadline.value && boardTask.value?.overdue ? 'over' : null));
const creatorAvatar = computed(() => taskAvatar(detail.value?.creator?.icon));
const responsibleAvatar = computed(() => taskAvatar(detail.value?.responsible?.icon));
const taskAccomplices = computed(() => taskPeopleNames(detail.value?.accomplicesData));
const taskAuditors = computed(() => taskPeopleNames(detail.value?.auditorsData));
const taskParentId = computed(() => {
  const id = Number(detail.value?.parentId);

  return Number.isSafeInteger(id) && id > 0 ? String(id) : '';
});
const checklist = computed(() => taskChecklist(detail.value?.checklist));
const canEditChecklist = computed(() => isB24Task.value && trackerCaps.value.checklist === true);
const canEditTags = computed(() => isB24Task.value && trackerCaps.value.tags === true);
const checklistEditing = ref<string | null>(null);
const checklistAdding = ref<string | null>(null);
const checklistCreating = ref(false);
const checklistListTitle = ref('');
const checklistTitleDraft = ref('');
const checklistDrafts = ref<Record<string, string>>({});
const checklistItemInputs = ref<Array<{ focus: () => void }>>([]);
const checklistSavedTitle = ref('');
const tagDraft = ref('');
const taskTagInput = ref<{ focus: () => void } | null>(null);

interface ChecklistEntry {
  key: string;
  depth: number;
  parentId: string;
  parentTitle?: string;
  item?: ChecklistRow;
  progress?: { complete: number; total: number };
}

interface ChecklistList {
  id: string;
  entries: ChecklistEntry[];
}

// Поле добавления замыкает поддерево своего родителя, сохраняя прежний плоский обход.
// Каждый корневой список получает кнопку ввода, подпункт открывается действием на строке.
// Прогресс корня включает все его вложенные пункты до следующего заголовка списка.
const checklistLists = computed<ChecklistList[]>(() => {
  const lists: ChecklistList[] = [];
  const ancestors: ChecklistRow[] = [];
  const rows = checklist.value.rows;
  let entries: ChecklistEntry[] = [];
  let progress: ChecklistEntry['progress'];

  for (const [index, item] of rows.entries()) {
    if (item.depth === 0) {
      progress = { complete: 0, total: 0 };
      entries = [];
      lists.push({ id: item.id, entries });
    } else if (progress) {
      progress.total += 1;
      progress.complete += Number(item.complete);
    }

    entries.push({
      key: item.id,
      item,
      depth: item.depth,
      parentId: '',
      ...(item.depth === 0 ? { progress } : {}),
    });
    ancestors.push(item);

    const nextDepth = rows[index + 1]?.depth ?? 0;

    while (ancestors.length && ancestors.at(-1)!.depth >= nextDepth) {
      const parent = ancestors.pop()!;

      if (canEditChecklist.value && (parent.depth === 0 || checklistAdding.value === parent.id)) {
        entries.push({
          key: `add-${parent.id}`,
          parentId: parent.id,
          parentTitle: parent.title,
          depth: parent.depth + 1,
        });
      }
    }
  }

  return lists;
});

// Удалённый родитель не оставляет скрытую форму, блокирующую добавление в другие списки.
// Перечитывание дерева и смена задачи используют ту же проверку наличия выбранного узла.
watch(checklist, (value) => {
  const parentId = checklistAdding.value;

  if (parentId && !value.rows.some((row) => row.id === parentId)) {
    delete checklistDrafts.value[parentId];
    checklistAdding.value = null;
  }
});

/**
 * Черновик переименования отделён от данных задачи до подтверждения сервера.
 * Отмена оставляет исходный пункт и его отметку без изменений.
 */
function editChecklistItem(item: ChecklistRow) {
  checklistEditing.value = item.id;
  checklistTitleDraft.value = item.title;
}

/**
 * Все изменения дерева перечитывают детали и защищены от смены карточки или трекера.
 * Ошибка остаётся в общем сообщении карточки; черновик сохраняется для повторной попытки.
 */
async function mutateChecklist(
  itemId: string,
  mutation: (id: string | number) => Promise<TaskDetail>,
  success?: () => void,
) {
  if (busy.value || !canEditChecklist.value || !taskId.value) {
    return;
  }

  const id = taskId.value;
  const reference = currentTaskKey.value;
  const epoch = trackers.epoch;

  checklistSavedTitle.value = '';
  await act(`checklist-${itemId}`, async () => {
    const updated = await mutation(id);

    if (currentTaskKey.value === reference && trackers.epoch === epoch) {
      detail.value = updated;
      success?.();
    }
  });
}

/**
 * Форма открывается только для выбранного списка или подпункта и сразу получает фокус.
 * Добавление остаётся отдельным явным сохранением текущего текста без создания следующей строки.
 */
async function openChecklistItem(parentId: string) {
  if (busy.value || !canEditChecklist.value) {
    return;
  }

  checklistAdding.value = parentId;
  checklistSavedTitle.value = '';
  await nextTick();
  checklistItemInputs.value[0]?.focus();
}

/**
 * Отмена очищает только новый пункт выбранного родителя и не отправляет запрос.
 * Во время записи форма сохраняется до ответа сервера.
 */
function cancelChecklistItem(parentId: string) {
  if (busy.value) {
    return;
  }

  checklistDrafts.value[parentId] = '';
  checklistAdding.value = null;
}

/**
 * Нативная отметка возвращается к серверному состоянию на время запроса.
 * Следующее отображение берётся из перечитанных деталей, включая отказ портала.
 */
function toggleChecklistItem(item: ChecklistRow, event: Event) {
  (event.target as HTMLInputElement).checked = item.complete;

  return mutateChecklist(item.id, (id) => tasks.updateChecklistItem(id, item.id, {
    complete: !item.complete,
  }, taskSource.value));
}

/**
 * Пункт сразу сохраняется внутри выбранного списка с обязательным parentId.
 * Только успешное чтение обновлённого дерева очищает соответствующий черновик.
 */
function addChecklistItem(parentId: string) {
  const title = checklistDrafts.value[parentId]?.trim();

  if (!title) {
    return;
  }

  return mutateChecklist(parentId, (id) => tasks.addChecklistItem(id, {
    title,
    parentId,
  }, taskSource.value), () => {
    checklistDrafts.value[parentId] = '';
    checklistAdding.value = null;
    checklistSavedTitle.value = title;
  });
}

function cancelChecklistList() {
  if (!busy.value) {
    checklistCreating.value = false;
    checklistListTitle.value = '';
  }
}

/**
 * Именованный корень создаётся без parentId через прежнее действие карточки.
 * Ошибка сохраняет введённое имя; успех закрывает форму после перечитывания дерева.
 */
function createChecklistList() {
  const title = checklistListTitle.value.trim();

  if (!title) {
    return;
  }

  return mutateChecklist('new-list', (id) => tasks.addChecklistItem(id, { title }, taskSource.value), () => {
    checklistCreating.value = false;
    checklistListTitle.value = '';
  });
}

/**
 * Переименование отправляет только название выбранного пункта.
 * Редактор закрывается после подтверждённого обновления деталей.
 */
function renameChecklistItem() {
  const itemId = checklistEditing.value;
  const title = checklistTitleDraft.value.trim();

  if (!itemId || !title) {
    return;
  }

  return mutateChecklist(itemId, (id) => tasks.updateChecklistItem(
    id, itemId, { title }, taskSource.value,
  ), () => {
    checklistEditing.value = null;
  });
}

/**
 * Подтверждение удаления связано с исходной задачей и поколением подключения.
 * Переход на другую задачу во время диалога отменяет подготовленную команду.
 */
async function deleteChecklistItem(item: ChecklistRow) {
  const id = taskId.value;
  const reference = currentTaskKey.value;
  const epoch = trackers.epoch;
  const confirmation = item.depth === 0
    ? 'core.taskChecklistListDeleteConfirmation' : 'core.taskChecklistDeleteConfirmation';
  const confirmed = await confirmDialog(t(confirmation, { title: item.title }), {
    danger: true,
    okText: t(item.depth === 0 ? 'core.taskChecklistListDelete' : 'core.taskChecklistDelete'),
  });

  if (!confirmed || currentTaskKey.value !== reference || trackers.epoch !== epoch) {
    return;
  }

  await mutateChecklist(item.id, (task) => tasks.deleteChecklistItem(task, item.id, taskSource.value));
}

/**
 * Полный список тегов отправляется без локального изменения чипов.
 * Page-ответ после записи обновляет теги и прежнее обсуждение той же карточки.
 */
async function updateTags(tags: string[]) {
  if (busy.value || !canEditTags.value || !taskTagsLoaded.value || comLoading.value || !taskId.value) {
    return;
  }

  const id = taskId.value;
  const reference = currentTaskKey.value;
  const epoch = trackers.epoch;
  let updated = false;

  await act('tags', async () => {
    const page = await tasks.updateTaskTags(id, tags, taskSource.value);

    if (currentTaskKey.value === reference && trackers.epoch === epoch) {
      taskTags.value = decodeTaskTags(page);
      taskTagsLoaded.value = isRecord(page) && Array.isArray(page.tags);
      comments.value = decodeTaskComments(page);
      taskSubtasks.value = decodeTaskSubtasks(page);
      tagDraft.value = '';
      updated = true;
    }
  });

  return updated;
}

/**
 * Кнопка и Enter отправляют один и тот же список тегов без пустых значений и дублей.
 * После успешной записи фокус возвращается в разблокированное поле той же карточки.
 */
async function addTag() {
  const tag = tagDraft.value.trim();
  const id = taskId.value;
  const reference = currentTaskKey.value;
  const epoch = trackers.epoch;

  if (!tag || taskTags.value.includes(tag) || taskTags.value.length >= 50) {
    return;
  }

  if (await updateTags([...taskTags.value, tag])) {
    await nextTick();

    if (currentTaskKey.value === reference && trackers.epoch === epoch) {
      taskTagInput.value?.focus();
    }
  }
}

/**
 * Приёмка и возврат используют общий busy и серверное чтение деталей с доской.
 * Поздний ответ не заменяет новую карточку после перехода или смены подключения.
 */
async function reviewTask(approve: boolean) {
  if (busy.value || !isB24Task.value || !trackerCaps.value.review || !taskId.value) {
    return;
  }

  const id = taskId.value;
  const reference = currentTaskKey.value;
  const epoch = trackers.epoch;

  await act(approve ? 'approve' : 'disapprove', async () => {
    const updated = approve ? await tasks.approveTask(id, taskSource.value)
      : await tasks.disapproveTask(id, taskSource.value);

    if (currentTaskKey.value === reference && trackers.epoch === epoch) {
      detail.value = updated;
      await loadComments(true);
    }
  });
}

const hasTaskMeta = computed(() => Boolean(
  taskStatus.value || taskPriority.value || taskProject.value || taskResponsible.value
    || taskDeadlineText.value || detail.value?.creator?.name || taskAccomplices.value
    || taskAuditors.value || taskParentId.value || detail.value?.replicate === 'Y',
));

function hideAvatar(event: Event) {
  const image = event.target as HTMLImageElement | null;

  if (image) {
    image.hidden = true;
  }
}

/**
 * datetime-local хранит местные часы без смещения, поэтому ISO сначала разбирается как момент.
 * Нетронутый снимок сравнивается строкой и не теряет исходные секунды или часовой пояс.
 */
function deadlineEditValue(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    return '';
  }

  const date = new Date(value);

  if (!Number.isFinite(date.getTime())) {
    return '';
  }

  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);

  return local.toISOString().slice(0, 16);
}

// B24 отдаёт описание с HTML/entities — чистим до читаемого текста.
function htmlToText(s: string | null | undefined) {
  return (s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\n{3,}/g, '\n\n').trim();
}

const cleanDesc = computed(() => htmlToText(detail.value?.description));

// Описание — текстом, но URL в нём должны жить: экранируем и оборачиваем ссылки.
function linkify(s: string) {
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  return esc(s || '').replace(/(https?:\/\/[^\s&]+(?:&amp;[^\s&]+)*)/g,
    (u) => `<a href="${u.replace(/&amp;/g, '&')}" target="_blank" rel="noopener">${u}</a>`);
}

const descHtml = computed(() => linkify(cleanDesc.value));

// ── Редактирование основных полей задачи внешнего трекера ──
const editForm = ref<ReturnType<typeof taskEditSnapshot> | null>(null);
const editBaseline = ref<ReturnType<typeof taskEditSnapshot> | null>(null);
const editTitleInput = ref<InstanceType<typeof UiInput> | null>(null);
const editAccomplicesOpen = ref(false);
const editAuditorsOpen = ref(false);
const editUsers = ref<BoardNamedItem[]>([]);
const editGroups = ref<BoardNamedItem[]>([]);
const editOptionsBusy = ref(false);
const editOptionsError = ref<string | null>(null);
const editMessage = ref<string | null>(null);
let editOptionsRequest = 0;

/**
 * Делает редактируемый снимок из DTO портала. Описание становится обычным текстом,
 * но уйдёт обратно только после фактического изменения человеком.
 */
function taskEditSnapshot(task: TaskDetail) {
  const responsibleId = task?.responsible?.id ?? boardTask.value?.responsibleId ?? '';
  const groupId = Number(task?.group_id);
  const priority = Number(task?.priority);

  return {
    title: String(task?.title || ''),
    description: htmlToText(task?.description),
    responsibleId: responsibleId ? String(responsibleId) : '',
    groupId: Number.isSafeInteger(groupId) && groupId > 0 ? String(groupId) : '',
    priority: [0, 1, 2].includes(priority) ? priority : 1,
    deadline: deadlineEditValue(task.deadline),
    accomplices: taskPeopleIds(task.accomplices, task.accomplicesData),
    auditors: taskPeopleIds(task.auditors, task.auditorsData),
  };
}

/**
 * Оставляет текущее значение доступным, даже если сотрудник или проект уже исчез
 * из активного справочника портала. Без fallback открытие формы само меняло бы select.
 */
function optionsWithCurrent(
  items: BoardNamedItem[], id: string | undefined, name: string | undefined, fallback: string,
) {
  if (!id || items.some((item) => String(item.id) === String(id))) {
    return items;
  }

  return [{ id: Number(id), name: name || `${fallback} #${id}` }, ...items];
}

const editResponsibleOptions = computed(() => optionsWithCurrent(
  editUsers.value,
  editForm.value?.responsibleId,
  detail.value?.responsible?.name,
  t('core.taskEditResponsible'),
));
const editParticipantOptions = computed(() => {
  const people = new Map(editUsers.value.map((user) => [String(user.id), user.name]));

  for (const key of ['accomplices', 'auditors'] as const) {
    for (const id of editForm.value?.[key] || []) {
      if (!people.has(id)) {
        const data = detail.value?.[`${key}Data`];
        const person = isRecord(data) ? data[id] : null;

        people.set(id, isRecord(person) && typeof person.name === 'string' ? person.name : `#${id}`);
      }
    }
  }

  return [...people].map(([value, label]) => ({ value, label }));
});
const editGroupOptions = computed(() => optionsWithCurrent(
  editGroups.value,
  editForm.value?.groupId,
  detail.value?.group_name || boardTask.value?.group,
  t('core.taskEditProject'),
));

/**
 * Собирает только изменённые поля. Это защищает нетронутое HTML-описание и уменьшает
 * окно, в котором правка из GrigDesk может затереть параллельную правку в портале.
 */
function taskEditPayload() {
  const form = editForm.value;
  const baseline = editBaseline.value;

  if (!form || !baseline) {
    return {};
  }

  const fields: Record<string, unknown> = {};
  const title = form.title.trim();

  if (title !== baseline.title) {
    fields.title = title;
  }
  if (form.description !== baseline.description) {
    fields.description = form.description;
  }
  if (form.groupId !== baseline.groupId) {
    fields.groupId = form.groupId ? Number(form.groupId) : null;
  }
  if (form.responsibleId !== baseline.responsibleId) {
    fields.responsibleId = Number(form.responsibleId);
  }
  if (form.deadline !== baseline.deadline) {
    fields.deadline = form.deadline ? new Date(form.deadline).toISOString() : null;
  }
  if (Number(form.priority) !== Number(baseline.priority)) {
    fields.priority = Number(form.priority);
  }

  for (const key of ['accomplices', 'auditors'] as const) {
    if ([...form[key]].sort().join(',') !== [...baseline[key]].sort().join(',')) {
      fields[key] = form[key].length ? form[key].map(Number) : '';
    }
  }

  return fields;
}

const editHasChanges = computed(() => Object.keys(taskEditPayload()).length > 0);
const editCanSave = computed(() => (
  Boolean(editForm.value?.title.trim())
  && busy.value !== 'edit'
  && editHasChanges.value
));

/**
 * Загружает оба портальных справочника независимо. Сбой одного не закрывает форму:
 * заголовок, описание и уже известные значения всё равно можно сохранить.
 */
async function loadEditOptions() {
  if (!editForm.value) {
    return;
  }

  const requestId = ++editOptionsRequest;

  editOptionsBusy.value = true;
  editOptionsError.value = null;

  const target = await resolveTrackerTarget(taskSource.value, api);
  const [users, groups] = await Promise.allSettled([
    api.get(`${target.prefix}/users`, target.options),
    api.get(`${target.prefix}/groups`, target.options),
  ]);

  if (requestId !== editOptionsRequest || !editForm.value) {
    return;
  }

  const failures = [];

  if (users.status === 'fulfilled') {
    editUsers.value = decodeBoardNamedItems(users.value, 'users');
  } else {
    failures.push(t('core.coreIspolniteley'));
  }
  if (groups.status === 'fulfilled') {
    editGroups.value = decodeBoardNamedItems(groups.value, 'groups');
  } else {
    failures.push(t('core.coreProekty'));
  }

  editOptionsError.value = failures.length
    ? t('core.coreNeUdalosZagruzitJoin', { join: failures.join(t('core.taskAnd')) })
    : null;
  editOptionsBusy.value = false;
}

/**
 * Открывает форму на снимке показанной карточки, фокусирует название и читает справочники.
 * Повторное открытие сохраняет черновик; списки участников изначально свёрнуты.
 */
async function openTaskEdit() {
  if (!detail.value || editForm.value) {
    return;
  }

  const snapshot = taskEditSnapshot(detail.value);

  editBaseline.value = snapshot;
  editForm.value = { ...snapshot };
  editAccomplicesOpen.value = false;
  editAuditorsOpen.value = false;
  editMessage.value = null;
  editOptionsError.value = null;
  void loadEditOptions();
  await nextTick();
  editTitleInput.value?.focus();
}


/**
 * Закрывает редактор и обесценивает его незавершённый запрос справочников.
 * Поздний ответ не восстанавливает уже закрытую форму.
 */
function cancelTaskEdit() {
  editOptionsRequest += 1;
  editOptionsBusy.value = false;
  editOptionsError.value = null;
  editForm.value = null;
  editBaseline.value = null;
}

/**
 * Сохраняет изменения, затем атомарно подменяет карточку ответом сервера.
 * Поздний ответ другой задачи остаётся только в store-кеше и не меняет открытую модалку.
 */
async function saveTaskEdit() {
  if (!editCanSave.value || !taskId.value) {
    return;
  }

  const id = String(taskId.value!);
  const fields = taskEditPayload();

  await act('edit', async () => {
    const updated = await tasks.update(id, fields, taskSource.value);

    if (String(taskId.value) !== id) {
      return;
    }

    detail.value = updated;
    cancelTaskEdit();
    editMessage.value = t('core.taskChangesSaved');

    if ((Object.hasOwn(fields, 'title') || Object.hasOwn(fields, 'description'))
        && triage.value?.analysis) {
      editMessage.value += t('core.taskTriageStaleNotice');
    }
  });
}

// ── Обсуждение в Telegram: что стоит за ссылками t.me из описания ──
// Поле `telegram` приходит от GET /api/tracker/task/:id (сервер уже применил
// allowlist и лимиты). Тело задачи оно не трогает — это отдельный блок.
// Текст цитат — из чужого чата, поэтому только интерполяция: никакого v-html,
// как у описания. Отказ показываем ровно так, как прислал сервер: у него нет
// ни цитат, ни имени чата, и придумывать их за него нельзя.
const tgLinks = computed(() => detail.value?.telegram?.links || []);

function tgTime(sec: number | undefined) {
  if (!sec) {
    return '';
  }

  return new Date(sec * 1000).toLocaleString(uiLocale.value,
    {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
}
// «ещё 1 сообщение / 3 сообщения / 5 сообщений» — общего хелпера склонения
// во фронте нет, а хвост без согласования читается как опечатка.
function tgPlural(n: number) {
  const teen = n % 100;

  if (teen >= 11 && teen <= 14) {
    return t('core.coreSoobscheniy');
  }

  const one = n % 10;

  if (one === 1) {
    return t('core.coreSoobschenie');
  }
  if (one >= 2 && one <= 4) {
    return t('core.coreSoobscheniya');
  }

  return t('core.coreSoobscheniy');
}

let personalTarget = '';

/**
 * Личные эффекты выполняются только для подтверждённой карточки и поддерживаемого пространства.
 * Пара источника и номера не позволяет ответу прежней карточки отметить новую задачу.
 */
function loadPersonalState() {
  if (!taskId.value || !detail.value || !canUsePersonal.value) {
    return;
  }

  const key = currentTaskKey.value;

  if (personalTarget === key) {
    return;
  }

  personalTarget = key;
  void favorites.value.load(true);
  void shelf.value.load(true, { silent: true });
  acknowledgeShelfOnOpen(taskId.value);
  void seen.value.markSeen([taskId.value]);
}

let detailAbort: AbortController | null = null;
let commentsAbort: AbortController | null = null;

/**
 * Загружает карточку через общий кеш задач с прежним принудительным обновлением.
 * Отказ остаётся в открытой карточке и не превращается в пустой успешный ответ.
 */
async function loadDetail(force = false) {
  if (!taskId.value || ui.taskUnavailable) {
    return;
  }

  const id = taskId.value;
  const reference = currentTaskKey.value;
  const request = ++detailRequest;

  detailAbort?.abort();
  detailAbort = new AbortController();
  loading.value = true;
  err.value = null;

  try {
    const loaded = await tasks.load(id, force, detailAbort.signal, taskSource.value);

    if (request !== detailRequest || currentTaskKey.value !== reference) {
      return;
    }

    detail.value = loaded;
    void loadConveyor();

    loadPersonalState();
  } catch (e) {
    if (request === detailRequest && currentTaskKey.value === reference) {
      err.value = failureText(e);
    }
  } finally {
    if (request === detailRequest) {
      loading.value = false;
    }
  }
}

// ── Триаж: оценка сложности/рисков разведкой кода (без стенда) ──
const analysisStore = useAnalysisStore();
const triage = ref<AnalysisDetail | null>(null);        // ответ /api/analysis/:id
const showNote = ref(false);     // разведнота развёрнута
const showClarifyHistory = ref(false);
const showAnalysisDetails = ref(false);
let triageTimer: ReturnType<typeof setInterval> | null = null;
const analysisManifest = computed(() => plugins.byId('analysis'));
// Старый сервер ещё не отдаёт manifest триажа: до ручного рестарта считаем его включённым.
const analysisEnabled = computed(() => analysisManifest.value?.enabled !== false);
const triageState = computed(() => triage.value?.status?.state || null);
const triageBusy = computed(() => triageState.value === 'queued' || triageState.value === 'running');
const noteHtml = computed(() => (triage.value?.note ? mdToHtml(triage.value.note) : ''));

const TRIAGE_WORK_LABELS: Record<string, string> = {
  get feature() {
    return t('core.taskNovayaFunktsionalnost');
  },
  get debug() {
    return t('core.taskIspravlenieOshibki');
  },
  get perf() {
    return t('core.taskOptimizatsiya');
  },
  get hunt() {
    return t('core.taskPoiskDefektov');
  },
};
const CONFIDENCE_LABELS: Record<string, string> = {
  get high() {
    return t('core.taskVysokaya2');
  },
  get medium() {
    return t('core.taskSrednyaya2');
  },
  get low() {
    return t('core.taskNizkaya2');
  },
};
const triageWorkLabel = computed(() => {
  const kind = triage.value?.analysis?.route_guess;

  return TRIAGE_WORK_LABELS[kind || ''] || kind || t('core.taskTipRabotyNeUkazan');
});

/**
 * Показатели читаются отдельно от маршрута. Отсутствующие данные не превращаются
 * в нулевую оценку, а машинные уровни уверенности показываются по-русски.
 */
const triageMetrics = computed(() => {
  const value = triage.value?.analysis;

  if (!value) {
    return [];
  }

  return [
    {
      id: 'complexity',
      label: t('core.taskSlozhnost'),
      value: triageScore(value.complexity),
      tone: value.complexity! >= 4 ? 'warning' : 'neutral',
    },
    {
      id: 'risk',
      label: t('core.taskRisk'),
      value: triageScore(value.risk),
      tone: value.risk! >= 4 ? 'danger' : value.risk === 3 ? 'warning' : 'neutral',
    },
    {
      id: 'diff',
      label: t('core.taskObemPravok'),
      value: value.diff_size || '—',
      tone: 'neutral',
    },
    {
      id: 'confidence',
      label: t('core.taskUverennost2'),
      value: CONFIDENCE_LABELS[value.confidence || ''] || t('core.coreNeUkazana'),
      tone: value.confidence === 'low' ? 'warning' : 'neutral',
    },
  ];
});

function triageScore(value: unknown) {
  const score = Number(value);

  return Number.isInteger(score) && score >= 1 && score <= 5 ? `${score}/5` : '—';
}

// По какому коду шла оценка: снимок ветки origin или рабочая копия, с короткой ревизией
// и причиной, если снимок подготовить не удалось.
function triageSourceLabel(
  key: string,
  repo: NonNullable<NonNullable<AnalysisDetail['analysis']>['repos']>[string],
) {
  const where = repo.ref || t('core.codeRabochayaKopiya');
  const revision = repo.sha ? ` @ ${repo.sha.slice(0, 7)}` : '';
  const note = repo.note ? t('core.taskNote', { note: repo.note }) : '';

  return `${key}: ${where}${revision}${note}`;
}

// Заход триажа идёт с момента нажатия и до готовой оценки: сначала уходят ответы
// человека, потом оценка стоит в очереди и считается. Всё это время панель показывает
// только прогресс, поэтому одного статуса сервера мало — нужна и своя отправка.
const triagePending = computed(() => busy.value === 'clarify'
  || busy.value === 'analyze'
  || triageBusy.value);

// Первый заход по задаче называется разведкой, повторный — переоценкой: человеку важно,
// сгорит ли уже показанная оценка.
const triageProgressLabel = computed(() => {
  if (busy.value === 'clarify') {
    return t('core.coreUtochneniyaSohranyayutsya');
  }

  const again = Boolean(triage.value?.analysis);

  if (triageState.value === 'running') {
    return again ? t('core.corePereotsenkaIdet2') : t('core.coreRazvedkaIdet2');
  }

  return again ? t('core.taskPereotsenkaVOcheredi2') : t('core.taskVOcheredi');
});

// Сколько заход уже длится. До старта считаем от постановки в очередь: ожидание очереди
// человек ждёт так же, как саму работу, а пустая панель без счётчика выглядит зависшей.
const triageProgressElapsed = computed(() => {
  const startedAt = Number(triage.value?.status?.startedAt || triage.value?.status?.queuedAt || 0);

  if (!triageBusy.value || !startedAt) {
    return '';
  }

  return mmss(Math.max(0, (now.value - startedAt) / 1000));
});

function normalizeTriageQuestions(values: unknown): AnalysisQuestion[] {
  return (Array.isArray(values) ? values : []).map((raw, index) => {
    const item = objectOrEmpty(raw);
    const text = typeof raw === 'string' ? raw.trim() : String(item.text || '').trim();
    const id = typeof raw === 'object' && item.id
      ? String(item.id)
      : `legacy-${index}-${text.slice(0, 40)}`;

    return {
      id,
      text,
      options: (Array.isArray(item.options) ? item.options : []).map((option, optionIndex) => ({
        id: String(objectOrEmpty(option).id || `legacy-option-${optionIndex}`),
        label: String(objectOrEmpty(option).label || option || ''),
        description: String(objectOrEmpty(option).description || ''),
      })).filter((option) => option.label),
      recommendation: isRecord(item.recommendation)
        && typeof item.recommendation.option === 'string' && typeof item.recommendation.reason === 'string'
        ? { option: item.recommendation.option, reason: item.recommendation.reason } : null,
    };
  }).filter((question) => question.text);
}

const triageQuestions = computed(() => normalizeTriageQuestions(triage.value?.analysis?.questions));
const clarifyDrafts = ref<Record<string, ClarifyDraft>>({});
const clarifyEntries = ref<AnalysisClarificationEntry[]>([]);
const clarifyComposerOpen = ref<Record<string, boolean>>({});
const activeQuestionId = ref<string | null>(null);

/**
 * Новый набор вопросов сохраняет уже введённые ответы по их идентификаторам.
 * Активный композер переключается только после исчезновения прежнего вопроса.
 */
function syncClarifyDrafts() {
  const next: Record<string, ClarifyDraft> = {};
  const nextComposerOpen: Record<string, boolean> = {};

  for (const question of triageQuestions.value) {
    next[question.id] = clarifyDrafts.value[question.id] || {
      text: '',
      optionIds: [],
      attachments: [],
    };
    nextComposerOpen[question.id] = question.options.length === 0
      || clarifyComposerOpen.value[question.id] === true;
  }

  clarifyDrafts.value = next;
  clarifyComposerOpen.value = nextComposerOpen;

  if (!next[activeQuestionId.value || '']) {
    activeQuestionId.value = triageQuestions.value[0]?.id || null;
  }
}

function draftFor(questionId: string) {
  return clarifyDrafts.value[questionId] || {
    text: '',
    optionIds: [],
    attachments: [],
  };
}

// Ответ ищем и по идентификатору вопроса, и по смыслу его текста: следующий заход
// триажа переписывает вопросы заново, и по одному id уже данный ответ пропадал из
// карточки — человек отвечал второй раз на то же самое.
function answerFor(question: AnalysisQuestion) {
  const key = questionKey(question.text);

  for (let index = clarifyEntries.value.length - 1; index >= 0; index -= 1) {
    const entry = clarifyEntries.value[index]!;

    if (entry.questionId === question.id || (key && questionKey(entry.questionText) === key)) {
      return entry;
    }
  }

  return null;
}

function clarifyOptions(question: AnalysisQuestion) {
  return question.options.map((option) => ({
    value: option.id,
    label: option.label,
    description: option.description || undefined,
  }));
}

function selectedClarifyOption(questionId: string) {
  return draftFor(questionId).optionIds[0] || null;
}

function recommendationOption(question: AnalysisQuestion) {
  const option = String(question.recommendation?.option || '').trim();

  return question.options.find((candidate) => candidate.id === option)?.label || option;
}

function composerOpenFor(question: AnalysisQuestion) {
  return question.options.length === 0 || clarifyComposerOpen.value[question.id] === true;
}

function setComposerOpen(questionId: string, open: boolean) {
  clarifyComposerOpen.value[questionId] = open;
}

/**
 * Опрос триажа продолжается только пока задача стоит в очереди или выполняется.
 * Ошибка этого блока не закрывает карточку и не создаёт второй таймер опроса.
 */
async function loadTriage() {
  if (!taskId.value || !analysisEnabled.value || !canAnalyzeTask.value) {
    return;
  }

  const request = ++triageRequest;
  const reference = currentTaskKey.value;
  const id = taskId.value;
  const source = taskSource.value;

  try {
    const response = await readAnalysisDetail(id, source);

    if (request !== triageRequest || reference !== currentTaskKey.value) {
      return;
    }

    triage.value = response;
    syncClarifyDrafts();
  } catch { /* блок триажа не ломает модалку */ }

  if (request !== triageRequest || reference !== currentTaskKey.value) {
    return;
  }
  // Пока идёт — подтягиваем статус; закончилось — останавливаемся.
  if (triageBusy.value && !triageTimer) {
    triageTimer = setInterval(loadTriage, 6000);
  } else if (!triageBusy.value && triageTimer) {
    clearInterval(triageTimer);
    triageTimer = null;
  }
}

const analyzeNow = () => act('analyze', async () => {
  if (!analysisEnabled.value || !canAnalyzeTask.value) {
    return;
  }

  await analyzeTask(taskId.value!, { source: taskSource.value });
  await loadTriage();
});

const clarifyUploading = ref(false);

async function onClarifyFiles(questionId: string, files: File[]) {
  await uploadClarifyFiles(questionId, files);
}

function dropClarifyAtt(questionId: string, file: string) {
  const draft = draftFor(questionId);

  draft.attachments = draft.attachments.filter((attachment) => attachment.file !== file);
}
// Скрин из буфера обмена (Ctrl+V прямо в поле) и перетаскивание файлов — как в чате.
/**
 * Вложение добавляется в уточнение после проверки ответа загрузки.
 * Повреждённый ответ остаётся ошибкой и не публикует сломанную миниатюру.
 */
async function uploadClarifyFiles(questionId: string, files: File[]) {
  if (!files.length) {
    return;
  }

  clarifyUploading.value = true;

  try {
    for (const f of files) {
      const fd = new FormData();

      fd.append('file', f, f.name || 'clipboard.png');
      draftFor(questionId).attachments.push(decodeChatAttachment(await api.upload('/api/chat/upload', fd)));
    }
  } catch (e2) {
    err.value = failureText(e2);
  } finally {
    clarifyUploading.value = false;
  }
}

function onClarifyPaste(questionId: string, e: ClipboardEvent) {
  const files = [...(e.clipboardData?.items || [])]
    .filter((i) => i.kind === 'file' && i.type.startsWith('image/'))
    .map((i) => i.getAsFile()).filter((file): file is File => file !== null);

  if (files.length) {
    e.preventDefault();
    uploadClarifyFiles(questionId, files);
  }
}
// Сохраняются ЛОКАЛЬНО (t<id>.clarify.md), НЕ комментарием в B24: комментарии
// видит заказчик, а рабочие пояснения — внутренняя кухня. Их читают триаж и конвейер.
const clarifySaved = ref('');
/**
 * Ответы человека загружаются отдельно от перезаписываемой оценки триажа.
 * При отказе сохраняется прежний пустой fallback истории уточнений.
 */
async function loadClarifications() {
  if (!taskId.value || ui.taskUnavailable) {
    return;
  }

  const request = ++clarificationsRequest;
  const reference = currentTaskKey.value;
  const id = taskId.value!;
  const source = taskSource.value;

  try {
    const response = await analysisApi.clarifications(id, source);

    if (request !== clarificationsRequest || reference !== currentTaskKey.value) {
      return;
    }

    clarifySaved.value = response.text || '';
    clarifyEntries.value = response.entries || [];
  } catch {
    if (request === clarificationsRequest && reference === currentTaskKey.value) {
      clarifySaved.value = '';
      clarifyEntries.value = [];
    }
  }
}

const hasClarifyAnswers = computed(() => triageQuestions.value.some((question) => {
  const draft = draftFor(question.id);

  return draft.text.trim() || draft.optionIds.length || draft.attachments.length;
}));

function selectClarifyOption(questionId: string, optionId: string | string[] | null | undefined) {
  draftFor(questionId).optionIds = optionId == null ? [] : [String(optionId)];
}

const sendClarify = () => act('clarify', async () => {
  const answers = triageQuestions.value.map((question) => {
    const draft = draftFor(question.id);

    return {
      questionId: question.id,
      optionIds: [...draft.optionIds],
      text: draft.text.trim(),
      attachments: draft.attachments.map((attachment) => ({
        file: attachment.file,
        name: attachment.name,
      })),
    };
  }).filter((answer) => answer.text || answer.optionIds.length || answer.attachments.length);
  const legacyText = answers.map((answer) => {
    const draft = draftFor(answer.questionId);

    return [
      answer.text,
      ...draft.attachments
        .map((attachment) => attachment.path
          ? t('core.corePrilozhenoFotoPath', { path: attachment.path })
          : '')
        .filter(Boolean),
    ].filter(Boolean).join('\n');
  }).filter(Boolean).join('\n\n');
  const reference = currentTaskKey.value;
  const id = taskId.value!;
  const source = taskSource.value;
  const r = await analysisApi.answer(id, answers, legacyText, source);

  if (reference !== currentTaskKey.value) {
    return;
  }

  clarifySaved.value = r.text || '';
  clarifyEntries.value = r.entries || clarifyEntries.value;
  clarifyDrafts.value = {};
  syncClarifyDrafts();
  await analyzeTask(taskId.value!, { source: taskSource.value });
  await loadTriage();
});

const arbitrateQuestions = () => act('arbitrate', async () => {
  const reference = currentTaskKey.value;

  await analysisApi.arbitrate(taskId.value!, taskSource.value);

  if (reference !== currentTaskKey.value) {
    return;
  }

  await Promise.all([loadClarifications(), loadTriage()]);
});

const dictationController = useDictationController();
const dictationLease = dictationController.acquire('task-modal-analysis', {
  /**
   * Итог диктовки дописывается только в ещё существующий активный вопрос.
   * Смена карточки не переносит распознанный текст в другое уточнение.
   */
  onCommit(text) {
    const questionId = activeQuestionId.value;

    if (!questionId || !clarifyDrafts.value[questionId]) {
      return;
    }

    const current = clarifyDrafts.value[questionId]!.text.trimEnd();

    clarifyDrafts.value[questionId]!.text = current
      ? t('core.taskCurrentText', { current, text })
      : String(text || '');
  },
});

/**
 * Переключение вопроса отменяет предыдущую диктовку до нового захвата.
 * Отказ микрофона остаётся в карточке текущей задачи.
 */
async function startClarifyDictation(questionId: string) {
  if (activeQuestionId.value && activeQuestionId.value !== questionId) {
    await dictationLease.cancel();
  }

  activeQuestionId.value = questionId;

  try {
    await dictationLease.start();
  } catch (error) {
    err.value = failureText(error, t('core.coreMikrofonNedostupen'));
  }
}

// ── Табы модалки: Триаж | Комментарии ──
const mtab = ref('triage');
const contentPane = ref<'description' | 'work'>('description');
// Одна навигация управляет видимой областью и сохранённым обсуждением задачи.
// Возврат к описанию не сбрасывает выбранный разбор и не уничтожает его форму.
const taskSection = computed({
  get: () => contentPane.value === 'description' ? 'description' : mtab.value,
  set: (section: string | number) => {
    if (section === 'description' || section === 'triage' || section === 'comments') {
      selectTaskSection(section);
    }
  },
});
const comments = ref<TaskComment[] | null>(null);    // null = ещё не загружали
const taskTags = ref<string[]>([]);
const taskTagsLoaded = ref(false);
const taskSubtasks = ref<TaskSubtask[]>([]);
const comLoading = ref(false);
let commentsRequest = 0;

/**
 * Карточка показывает одну область, сохраняя DOM и черновики остальных.
 * Комментарии используют прежнюю вкладку и общий page-ответ без повторных запросов.
 */
function selectTaskSection(section: 'description' | 'triage' | 'comments') {
  contentPane.value = section === 'description' ? 'description' : 'work';

  if (section !== 'description') {
    mtab.value = section;
  }
}

/**
 * Один page-ответ наполняет описание тегами и подзадачами, а обсуждение — комментариями.
 * Неверные необязательные расширения скрываются без отказа прежнего обсуждения.
 */
async function loadComments(force = false) {
  if (!taskId.value || !isB24Task.value || (!trackerCaps.value.comments && !trackerCaps.value.tags)
    || (comLoading.value && !force)) {
    return;
  }

  const id = taskId.value;
  const reference = currentTaskKey.value;
  const request = ++commentsRequest;

  commentsAbort?.abort();
  commentsAbort = new AbortController();
  comLoading.value = true;

  try {
    const target = await resolveTrackerTarget(taskSource.value, api);
    const page = await api.get(`${target.prefix}/task/${id}/comments`, {
      ...target.options,
      signal: commentsAbort.signal,
    });
    const result = decodeTaskComments(page);

    if (currentTaskKey.value === reference && request === commentsRequest && isB24Task.value) {
      comments.value = result;
      taskTags.value = decodeTaskTags(page);
      taskTagsLoaded.value = isRecord(page) && Array.isArray(page.tags);
      taskSubtasks.value = decodeTaskSubtasks(page);
    }
  } catch (error) {
    if (currentTaskKey.value === reference && request === commentsRequest) {
      if (trackerCaps.value.tags) {
        err.value = failureText(error);
      }

      comments.value = [];
      taskTags.value = [];
      taskTagsLoaded.value = false;
      taskSubtasks.value = [];
    }
  } finally {
    if (currentTaskKey.value === reference && request === commentsRequest) {
      comLoading.value = false;
    }
  }
}

watch(mtab, (t) => {
  if (isB24Task.value && trackerCaps.value.comments && t === 'comments' && comments.value === null) {
    loadComments();
  }
});

watch(
  () => [taskId.value, detail.value, trackerCaps.value.comments, trackerCaps.value.tags],
  () => {
    if (detail.value && comments.value === null) {
      void loadComments();
    }
  },
);

// Уже ли задача на конвейере (есть в состоянии фабрики) — для защиты от повторного запуска.
const conveyor = ref<PipelineTask | null>(null);
const conveyorGraph = ref<LiveGraph | null>(null);
// Живой стенд задачи ({fePort, apiPort}) — чтобы снести его прямо отсюда.
const sandbox = ref<{ fePort: number; apiPort: number | null } | null>(null);
/**
 * Присутствие задачи в фабрике и её стенд загружаются независимо от карточки B24.
 * Общий стенд и исторический реестр сохраняют запрет управления из карточки.
 */
async function loadConveyor() {
  conveyor.value = null;
  conveyorGraph.value = null;
  sandbox.value = null;

  if (!taskId.value || ui.taskUnavailable) {
    return;
  }

  try {
    const { tasks: list } = decodePipelineTasks(await api.get('/api/tasks?sources=1'));
    const key = currentTaskKey.value;

    conveyor.value = (list || []).find((t) => t.source && taskReferenceKey({ id: t.task, source: t.source })
      === key) || null;
  } catch { /* нет данных фабрики — не блокируем */ }

  if (!conveyor.value) {
    return;
  }
  // Порты стенда лежат не в списке задач, а в графе — тянем только для задач конвейера.
  // Общий стенд и исторический реестр принадлежат не этой карточке: их lifecycle
  // интерфейс не трогает.
  try {
    const g = decodeLiveGraph(await api.get(`/api/tasks/${taskId.value}/graph`));

    conveyorGraph.value = g;

    if (typeof g.fePort === 'number' && g.fePort && !g.readOnly && g.workspaceMode !== 'shared') {
      sandbox.value = { fePort: g.fePort, apiPort: typeof g.apiPort === 'number' ? g.apiPort || null : null };
    }
  } catch { /* графа нет — кнопку сноса просто не покажем */ }
}
/**
 * Карточка документа ждёт подтверждения перехода в главном окне, сохраняя контекст при отказе.
 * Диалог продолжает использовать маршрут своего документа и прежний порядок закрытия.
 */
function openConveyor() {
  return leaveTaskForPipeline({
    document: props.presentation === 'document',
    send: () => shellAction('POST', '/surfaces/main', { destination: 'pipeline' },
      AbortSignal.timeout(20000)),
    route: () => router.push('/pipeline'),
    close: () => ui.close(),
    failure: () => showToast({
      id: 'task-window-pipeline',
      title: t('core.taskNeUdalosOtkrytKonveyer'),
      tone: 'warning',
    }),
  });
}

// Снести стенд, не уходя в конвейер: стенд убирают из карточки, и возвращаться
// на страницу конвейера ради одной кнопки незачем. Снос идёт до пары минут
// (docker + схемы БД) — кнопка на это время становится индикатором.
// После сноса перечитываем состояние: сервер уносит реестр задачи в архив, то есть
// задача уходит и с конвейера — иначе в карточке осталась бы кнопка «Уже на конвейере».
const sandboxBusy = ref(false);
const sandboxMsg = ref<string | null>(null);


/**
 * Сносит стенд только после подтверждения человека и один раз за действие.
 * Результат остаётся в карточке, затем состояние конвейера перечитывается.
 */
async function sandboxDown() {
  if (sandboxBusy.value) {
    return;
  }
  if (!(await confirmDialog(
    messageRef('core.taskSnestiStendZadachiTaskid', { taskId: taskId.value ?? '' }),
    { danger: true, okText: t('core.taskSnesti') },
  ))) {
    return;
  }

  sandboxBusy.value = true;
  err.value = null;
  sandboxMsg.value = null;

  try {
    await api.post(`/api/tasks/${taskId.value}/sandbox/down`);
    await loadConveyor();
    sandboxMsg.value = t('core.coreStendSnesenProgonPerenesen');
  } catch (e) {
    err.value = objectOrEmpty(e).status === 501
      ? t('core.pipelineSnosStendaNeNastroen')
      : failureText(e);
  } finally {
    sandboxBusy.value = false;
  }
}

/**
 * Одна выполняемая команда задаёт индикатор и сообщение отказа карточки.
 * Снятие busy происходит при любом исходе без повторной мутации сервера.
 */
async function act(name: string, fn: () => Promise<unknown>) {
  const reference = currentTaskKey.value;

  busy.value = name;
  err.value = null;

  try {
    await fn();
  } catch (e) {
    if (reference === currentTaskKey.value) {
      err.value = failureText(e);
    }
  } finally {
    if (reference === currentTaskKey.value) {
      busy.value = null;
    }
  }
}

const toggleTimer = () => act('timer', () => tasks.timer(
  taskId.value!, running.value ? 'pause' : 'start', taskSource.value,
));

/**
 * Подтверждение относится к исходной задаче и поколению подключения.
 * Смена трекера во время диалога не переносит завершение на другой аккаунт.
 */
const complete = async () => {
  const epoch = trackers.epoch;
  const id = taskId.value;
  const source = taskSource.value;
  const reference = currentTaskKey.value;

  if (await confirmDialog(messageRef('core.taskZavershitZadachu'), { okText: t('core.taskZavershit2') })) {
    if (epoch !== trackers.epoch || currentTaskKey.value !== reference) {
      return;
    }

    act('complete', async () => {
      await tasks.complete(id!, source);
      ui.close();
    });
  }
};

/**
 * Удаление требует подтверждения для исходной задачи и подключения.
 * После ожидания карточка закрывается только если пользователь всё ещё смотрит эту задачу.
 */
async function deleteTask() {
  if (busy.value || !isB24Task.value || !trackerCaps.value.delete) {
    return;
  }

  const epoch = trackers.epoch;
  const id = taskId.value;
  const source = taskSource.value;
  const reference = currentTaskKey.value;
  const confirmed = await confirmDialog(t('core.taskDeleteConfirmation'), {
    danger: true,
    okText: t('core.taskDelete'),
  });

  if (!confirmed || epoch !== trackers.epoch || currentTaskKey.value !== reference || busy.value) {
    return;
  }

  await act('delete', async () => {
    await tasks.deleteTask(id!, source);

    if (epoch === trackers.epoch && currentTaskKey.value === reference) {
      ui.close();
    }
  });
}

// Возобновление не возвращает детали задачи: после подтверждения перечитываем их.
// Статус и доступные действия определяет портал, а ошибки остаются в карточке.
async function renew() {
  const epoch = trackers.epoch;
  const id = taskId.value;
  const source = taskSource.value;
  const reference = currentTaskKey.value;

  if (!(await confirmDialog(
    messageRef('core.taskVozobnovitZadachu'),
    { okText: t('core.taskVozobnovit2') },
  ))) {
    return;
  }

  if (epoch !== trackers.epoch || currentTaskKey.value !== reference) {
    return;
  }

  await act('renew', async () => {
    await tasks.renew(id!, source);
    await loadDetail(true);
  });
}

const launchMsg = ref<string | null>(null);

// ── Запуск на конвейер ──
// Маршрут и критерии задаёт человек. Технические immutable-входы route engine форма
// тоже показывает явно: целевые ветки для ship и exact instrumentation scope для debug.
// Критерии предзаполняются объёмом из триажа (`scope.do` — по пункту на каждый пункт
// постановки): человек видит и правит объём ДО конвейера. Пустые критерии допустимы, но
// тогда узлы маршрута читают пункты постановки как есть; переводчик формулирует критерии
// только у маршрутов с планом. Выдумывать их за человека нельзя — отказ на приёмке
// откатывает маршрут на сборку со сбросом всего хвоста.
const launchForm = ref<ReturnType<typeof makeLaunchForm> | null>(null);   // форма открыта
const launchOpts = ref<TaskLaunchOptions | null>(null);   // ответ /launch-options
const launchOptionsBusy = ref(false);
const launchOptionsFailed = ref(false);
const DIAGNOSIS_LABELS: Record<string, string> = {
  get functional() {
    return t('core.taskPovedenie');
  },
  get performance() {
    return t('core.taskProizvoditelnost');
  },
  get data() {
    return t('core.taskDannye');
  },
  get integration() {
    return t('core.taskIntegratsiya');
  },
};
let launchOptionsRequest = 0;

/**
 * Закрытая форма больше не принимает ответы своего каталога.
 * Следующее открытие начинает отдельное поколение запросов.
 */
function closeLaunch() {
  launchOptionsRequest += 1;
  launchOptionsBusy.value = false;
  launchForm.value = null;
}

/**
 * Сбрасывает только выбор профиля и зависимые поля, сохраняя критерии человека.
 * Соседний профиль никогда не выбирается вместо исчезнувшей регистрации.
 */
function clearLaunchProfile() {
  if (!launchForm.value) {
    return;
  }

  launchForm.value.profile = '';
  launchForm.value.route = null;
  launchForm.value.instrumentationFiles = '';
  launchForm.value.diagnosisSignal = '';
  launchForm.value.runner = '';
}

/**
 * Общий поток инвалидирует каталог открытой формы, включая ещё летящий первый GET.
 * После reconnect свежий список проверяет прежний выбор, не меняя критерии и соседний проект.
 */
async function refreshLaunchOptions() {
  if (!taskId.value || (!launchForm.value && !launchOptionsBusy.value)) {
    return;
  }

  const requestId = ++launchOptionsRequest;
  const id = taskId.value;
  const reference = currentTaskKey.value;
  const profile = launchForm.value?.profile;

  launchOptionsBusy.value = true;
  launchOptionsFailed.value = true;

  try {
    let opts = await tasks.launchOptions(id, undefined, taskSource.value);

    if (requestId !== launchOptionsRequest) {
      return;
    }

    if (profile && opts.profiles?.includes(profile) && opts.profile !== profile) {
      opts = await tasks.launchOptions(id, profile, taskSource.value);
    }
    if (requestId !== launchOptionsRequest) {
      return;
    }

    const previous = launchForm.value;

    launchOpts.value = opts;
    launchForm.value = makeLaunchForm(opts, previous?.criteria ?? null);
    launchOptionsFailed.value = false;
    err.value = opts.error ? opts.message || t('core.coreVybrannyyProfilSeychasNelzya') : null;

    if (!profile || !opts.profiles?.includes(profile) || opts.profile !== profile) {
      clearLaunchProfile();
    } else if (previous) {
      launchForm.value = { ...previous };

      if (!opts.routes?.includes(previous.route || '')) {
        launchForm.value.route = null;
      }
    }
  } catch (e) {
    if (requestId === launchOptionsRequest) {
      err.value = t('core.coreNeUdalosObnovitParametry', { failureTexte: failureText(e) });
    }
  } finally {
    if (requestId === launchOptionsRequest) {
      launchOptionsBusy.value = false;
    }
  }
}

const stopLaunchEvents = sseSubscribe((name, payload) => {
  if (name === 'trackers-changed') {
    if (taskSource.value && trackers.catalog?.enabledIds) {
      const id = taskSource.value.split('@')[0];
      const previous = trackers.catalog.drivers.find((entry) => entry.id === id);

      void trackers.load(true).then(() => {
        const next = trackers.catalog?.drivers.find((entry) => entry.id === id);

        if (previous?.dataRevision !== next?.dataRevision || previous?.generation !== next?.generation) {
          detailAbort?.abort();
          commentsAbort?.abort();
          detail.value = null;
          void loadDetail(true);
        }
      });

      return;
    }

    detailRequest += 1;
    commentsRequest += 1;
    detailAbort?.abort();
    commentsAbort?.abort();
    detail.value = null;
    comments.value = null;
    taskTags.value = [];
    taskTagsLoaded.value = false;
    taskSubtasks.value = [];
    commentText.value = '';
    tasks.invalidate?.();
    trackers.invalidate();
    detailTrackerRevision.value = isRecord(payload) && Number.isSafeInteger(payload.revision)
      ? Number(payload.revision) : 0;
    loading.value = false;
    comLoading.value = false;
    void trackers.load(true);
    closeLaunch();
    cancelTaskEdit();

    return;
  }

  if (name === 'projects-changed') {
    try {
      const change = parseProjectsChange(payload);

      if (change.kind === 'deleted' && launchForm.value?.profile === change.id) {
        clearLaunchProfile();
      }
    } catch {
      return;
    }
  } else if (name !== 'hello') {
    return;
  }

  void refreshLaunchOptions();
});

// Новое поколение metadata подтверждает, что детали читаются уже из текущего подключения.
// Ожидание переживает замену запроса metadata другим подписчиком или диалогом настроек.
watch(
  () => [trackers.catalog, detailTrackerRevision.value] as const,
  ([catalog, revision]) => {
    if (!catalog || revision === null || catalog.revision < revision) {
      return;
    }

    detailTrackerRevision.value = null;
    void loadDetail(true);
  },
);
// Рекомендацию маршрута считает сервер: только он знает, из этого ли каталога пришла
// оценка и остался ли предложенный маршрут опубликованным. Клиент её не пересчитывает.
function preferredLaunchRoute(opts: TaskLaunchOptions) {
  return opts.routeSuggestion?.route || opts.defaultRoute;
}
// Объём из триажа — подсказка формы, а не решение: пустое поле заполняется им один раз
// при открытии, а введённое человеком (в т.ч. стёртое до пустоты при смене профиля)
// не перезаписывается.
function suggestedCriteria(opts: TaskLaunchOptions) {
  return (opts.scopeSuggestion?.criteria || []).join('\n');
}
/**
 * Форма создаётся из каталога профиля, показанного человеку.
 * Критерии сохраняются при смене профиля, а выбор исполнителя сбрасывается как прежде.
 */
function makeLaunchForm(opts: TaskLaunchOptions, criteria: string | null = null) {
  const route = preferredLaunchRoute(opts);
  const needsInstrumentation = opts.routeOptions?.[route!]?.instrumentationRequired;

  return {
    profile: opts.profile,
    route,
    criteria: criteria === null ? suggestedCriteria(opts) : criteria,
    instrumentationFiles: needsInstrumentation
      ? (opts.instrumentationSuggestions || []).slice(0, 1).join('\n')
      : '',
    diagnosisKind: opts.diagnosisSuggestion?.kind || 'functional',
    diagnosisSignal: opts.diagnosisSuggestion?.signal || '',
    // '' = исполнителя решает профиль; явный выбор уезжает в launch как runnerPrimary.
    // Форма пересоздаётся на каждый ответ launch-options, поэтому смена профиля
    // сама сбрасывает выбор — чужой набор исполнителей не наследуется.
    runner: '',
  };
}


/**
 * Загружает каталог запуска для открытой задачи и создаёт форму выбора.
 * Поколение запроса защищает её от ответа предыдущей карточки.
 */
async function openLaunch() {
  if (!taskId.value || !detail.value || loading.value) {
    return;
  }

  if (conveyor.value) {
    launchMsg.value = t('core.coreUzheNaKonveyere');

    return;
  }
  if (launchOptionsBusy.value) {
    return;
  }

  err.value = null;
  launchMsg.value = null;
  launchOptionsFailed.value = false;

  const requestId = ++launchOptionsRequest;
  let opts = null;

  launchOptionsBusy.value = true;

  try {
    opts = await tasks.launchOptions(
      taskId.value!, undefined, taskSource.value,
    );
  } catch (e) {
    if (requestId === launchOptionsRequest) {
      err.value = t('core.coreNeUdalosUznatParametry', { failureTexte: failureText(e) });
    }

    return;
  } finally {
    if (requestId === launchOptionsRequest) {
      launchOptionsBusy.value = false;
    }
  }

  if (requestId !== launchOptionsRequest) {
    return;
  }

  launchOpts.value = opts;

  // Если каталог выбранного по умолчанию профиля недоступен, при нескольких профилях
  // оставляем форму открытой: человек может выбрать другой опубликованный каталог.
  const profiles = opts.profiles?.length ? opts.profiles : [opts.profile];

  if (opts.error && profiles.length === 1) {
    err.value = opts.message || t('core.coreMarshrutSeychasNelzyaZapustit');

    return;
  }
  // Триаж уже прикинул маршрут — показываем это подсказкой рядом, но выбирает человек.
  launchForm.value = makeLaunchForm(opts);

  if (opts.error) {
    err.value = opts.message || t('core.coreVybrannyyProfilSeychasNelzya');
  }

  return undefined;
}


/**
 * Перечитывает параметры выбранного профиля, сохраняя критерии человека.
 * При отказе возвращает прежний выбор, не публикуя ответ старого запроса.
 */
async function changeLaunchProfile() {
  const profile = launchForm.value?.profile;

  if (!profile || launchOptionsBusy.value) {
    return;
  }

  const previousProfile = launchOpts.value?.profile;
  const requestId = ++launchOptionsRequest;
  const criteria = launchForm.value!.criteria;

  launchOptionsBusy.value = true;
  err.value = null;

  try {
    const opts = await tasks.launchOptions(taskId.value!, profile, taskSource.value);

    if (requestId !== launchOptionsRequest || !launchForm.value) {
      return;
    }

    launchOpts.value = opts;
    launchForm.value = makeLaunchForm(opts, criteria);
    launchOptionsFailed.value = false;

    if (opts.error) {
    err.value = opts.message || t('core.coreVybrannyyProfilSeychasNelzya');
  }
  } catch (e) {
    if (requestId === launchOptionsRequest) {
      if (launchForm.value && previousProfile) {
        launchForm.value.profile = previousProfile;
      }

      err.value = t('core.coreNeUdalosVybratProfil', { failureTexte: failureText(e) });
    }
  } finally {
    if (requestId === launchOptionsRequest) {
      launchOptionsBusy.value = false;
    }
  }
}
// Глубина — вторая половина рекомендации: человек видит не только «какой маршрут»,
// но и «насколько короткий», а рядом — по каким числам оценки это вышло.
const DEPTH_LABELS: Record<string, string> = {
  get light() {
    return t('core.taskLegkiy');
  },
  get mid() {
    return t('core.taskSredniy');
  },
  get full() {
    return t('core.taskPolnyy');
  },
};
const triageDepthLabel = computed(() => DEPTH_LABELS[triage.value?.analysis?.route_depth || ''] || '');
// Кнопка называет маршрут, который откроется уже выбранным: путь от оценки триажа до
// запуска — один клик, и человек заранее знает, с чем согласится.
const launchOpenHint = computed(() => {
  const route = triage.value?.analysis?.route_guess;
  const depth = triageDepthLabel.value;

  return route
    ? t('core.taskOtkrytParametryZapuskaTriazh', {
            route,
            depthdepth: depth ? t('core.coreDepthMarshrut', { depth: depth }) : '',
          })
    : t('core.taskOtkrytParametryZapuskaFabriki');
});
const routeSuggestion = computed(() => launchOpts.value?.routeSuggestion?.route || null);
const routeSuggestionReason = computed(() => launchOpts.value?.routeSuggestion?.reason || '');
const routeDepthLabel = computed(() => (
  DEPTH_LABELS[launchOpts.value?.routeSuggestion?.depth || ''] || ''
));
const launchRouteOption = computed(() => (
  launchOpts.value?.routeOptions?.[launchForm.value?.route || ''] || null
));
const launchNeedsDelivery = computed(() => launchRouteOption.value?.deliveryMode === 'publish');
const launchNeedsInstrumentation = computed(() => Boolean(
  launchRouteOption.value?.instrumentationRequired
));
const launchRouteIsSuggested = computed(() => (
  Boolean(routeSuggestion.value) && routeSuggestion.value === launchForm.value?.route
));
const launchDeliverySummary = computed(() => (launchOpts.value?.repositories || [])
  .map((repo) => `${repo.name}/${repo.targetBranch || '—'}`)
  .join(' · '));
const launchInstrumentationItems = computed(() => String(
  launchForm.value?.instrumentationFiles || '',
).split('\n').map((item) => item.trim()).filter(Boolean));
const launchInstrumentationSummary = computed(() => {
  const [first, ...rest] = launchInstrumentationItems.value;

  if (!first) {
    return t('core.coreScopeNeOpredelen');
  }

  const short = first.split('/').pop();

  return rest.length ? t('core.taskShortEscheLength', { short, length: rest.length }) : short;
});
const launchDiagnosisSummary = computed(() => (
  DIAGNOSIS_LABELS[launchForm.value?.diagnosisKind || '']
  || launchForm.value?.diagnosisKind
  || t('core.taskPovedenie')
));
const launchValidationError = computed(() => {
  if (loading.value || !detail.value) {
    return t('core.corePostanovkaZadachiEscheZagruzhaetsya');
  }
  if (launchOptionsFailed.value) {
    return t('core.coreParametryZapuskaNeUdalos');
  }
  if (!launchForm.value?.profile) {
    return t('core.coreVyberiProfil');
  }
  if (!launchForm.value?.route) {
    return t('core.coreVyberiMarshrut');
  }
  if (!launchRouteOption.value?.deliveryMode) {
    return t('core.coreKatalogNeOtdalDelivery');
  }
  if (launchOpts.value?.profileContractError) {
    return launchOpts.value.profileContractError;
  }
  if (launchNeedsDelivery.value) {
    if (!launchOpts.value?.repositories?.length) {
      return t('core.coreProfilNeObyavilRepozitorii');
    }

    const missing = launchOpts.value.repositories
      .filter((repo) => !repo.targetBranch?.trim())
      .map((repo) => repo.name);

    if (missing.length) {
      return t('core.coreProfilNeNastroilTselevye', { join: missing.join(', ') });
    }
  }
  if (launchNeedsInstrumentation.value && !launchForm.value!.instrumentationFiles.trim()) {
    return t('core.coreMarshrutTrebuetHotyaBy');
  }

  return null;
});

function changeLaunchRoute() {
  if (!launchForm.value || !launchNeedsInstrumentation.value
      || launchForm.value.instrumentationFiles.trim()) {
    return;
  }

  launchForm.value!.instrumentationFiles = (launchOpts.value?.instrumentationSuggestions || [])
    .slice(0, 1).join('\n');
}
/**
 * Известные коды запуска объясняются человеку до общего сообщения ошибки.
 * Повреждённый ответ не превращает отказ команды в успешный запуск.
 */
function launchErrorText(e: unknown) {
  const error = objectOrEmpty(e);
  const data = objectOrEmpty(error.data);
  const code = typeof data.error === 'string' ? data.error : '';
  const known: Record<string, string> = {
    catalog_changed: t('core.taskKatalogMarshrutovIzmenilsyaPerechitay'),
    run_exists: t('core.taskUZadachiUzheEst'),
  };

  return known[code] || (typeof data.message === 'string' ? data.message : '')
    || failureText(e, t('core.coreNeUdalosZapustitZadachu'));
}
/**
 * Команда запуска отправляется один раз из уже проверенной формы.
 * Сообщение результата строится из ACK, затем перечитывается состояние конвейера.
 */
async function doLaunch(payload: unknown) {
  if (busy.value) {
    return;
  }

  const reference = currentTaskKey.value;
  const id = taskId.value!;
  const source = taskSource.value;

  busy.value = 'launch';
  err.value = null;

  try {
    const r = await tasks.launch(id, {
      ...objectOrEmpty(payload),
      ...(source ? { source } : {}),
    });

    if (reference !== currentTaskKey.value) {
      return;
    }

    launchForm.value = null;
    launchMsg.value = r.outcome === 'already_running' ? t('core.coreUzheIdetNaKonveyere')
      : r.outcome === 'launched' ? t('core.coreZapuschenoProfilProfileRoute', {
        profile: r.profile,
        route: r.route ? t('core.coreMarshrutRoute', { route: r.route }) : '',
        slice010: r.attempt ? t('core.corePopytkaSlice010', { slice010: r.attempt.slice(0, 10) }) : '',
      })
      : r.note || t('core.coreOtpravleno');
    await loadConveyor();
  } catch (e) {
    if (reference !== currentTaskKey.value) {
      return;
    }

    const message = launchErrorText(e);

    if (objectOrEmpty(objectOrEmpty(e).data).error === 'tombstoned') {
      clearLaunchProfile();
      await refreshLaunchOptions();
    }

    if (reference === currentTaskKey.value) {
      err.value = message;
    }
  } finally {
    if (reference === currentTaskKey.value) {
      busy.value = null;
    }
  }
}
/**
 * Собирает прежний контракт запуска из видимого решения человека.
 * Неявный исполнитель и отсутствующий hash каталога не добавляют лишние поля.
 */
function launchPayload() {
  const instrumentationFiles = launchNeedsInstrumentation.value
    ? launchForm.value!.instrumentationFiles.split('\n').map((s) => s.trim()).filter(Boolean)
    : [];

  return {
    profile: launchForm.value!.profile,
    route: launchForm.value!.route,
    title: detail.value?.title || '',
    description: cleanDesc.value || '',
    // По строке на критерий: пустые строки отбрасывает сборка тикета.
    acceptanceCriteria: launchForm.value!.criteria.split('\n').map((s) => s.trim()).filter(Boolean),
    instrumentationFiles,
    diagnosisKind: launchNeedsInstrumentation.value ? launchForm.value!.diagnosisKind : '',
    diagnosisSignal: launchNeedsInstrumentation.value
      ? launchForm.value!.diagnosisSignal.trim()
      : '',
    // Исполнитель — только при явном выборе: пустое значение значит «по профилю»,
    // и сервер не должен получать лишний ключ.
    ...(launchForm.value!.runner ? { runnerPrimary: launchForm.value!.runner } : {}),
    // Старт pin-ит тот каталог, который человек видел в форме: между её открытием и
    // запуском профиль мог опубликовать новый, и молча уехать по нему нельзя.
    ...(launchOpts.value?.catalogHash
      ? { expectedCatalogHash: launchOpts.value.catalogHash }
      : {}),
  };
}

const launchSelected = () => {
  if (launchValidationError.value) {
    return;
  }

  return doLaunch(launchPayload());
};
const sendComment = () => act('comment', async () => {
  await tasks.comment(taskId.value!, commentText.value, taskSource.value);
  commentText.value = '';
  loadComments(true);
});
/**
 * Принудительное чтение сохраняет выбранную пару карточки.
 * Обсуждение не переходит к другому источнику после ожидания деталей.
 */
const refresh = async () => {
  const id = taskId.value;
  const reference = currentTaskKey.value;

  await loadDetail(true);

  if (currentTaskKey.value === reference && isB24Task.value) {
    board.load(true);
    void loadComments(true);
  }
};
const toggleFavorite = () => favorites.value.toggle(taskId.value!);
const toggleShelf = () => shelf.value.toggle(taskId.value!);
let acknowledgedShelfTask = '';
/**
 * Открытие карточки гасит накопленное внимание только один раз на задачу.
 * Поздний отказ позволяет повторить подтверждение при следующем обновлении полки.
 */
function acknowledgeShelfOnOpen(id = taskId.value!) {
  const key = String(id || '');

  if (!canUsePersonal.value || !key || !shelfEnabled.value || !shelf.value.loaded
    || !shelf.value.isOnShelf(key)
    || acknowledgedShelfTask === key) {
    return;
  }

  acknowledgedShelfTask = key;
  void Promise.resolve(shelf.value.acknowledge(key)).then((ok) => {
    if (!ok && String(taskId.value || '') === key) {
      acknowledgedShelfTask = '';
    }
  });
}

function onTaskDialogOpenChange(open: boolean) {
  if (!open) {
    ui.close();
  }
}

// Открытие/закрытие модалки по taskId.
watch(() => [taskId.value, taskSource.value, ui.taskUnavailable], ([id]) => {
  checklistEditing.value = null;
  checklistAdding.value = null;
  checklistCreating.value = false;
  checklistListTitle.value = '';
  checklistDrafts.value = {};
  checklistSavedTitle.value = '';
  tagDraft.value = '';
  detailTrackerRevision.value = null;
  detailAbort?.abort();
  commentsAbort?.abort();
  detailRequest += 1;
  commentsRequest += 1;
  triageRequest += 1;
  clarificationsRequest += 1;

  if (triageTimer) {
    clearInterval(triageTimer);
    triageTimer = null;
  }

  comLoading.value = false;
  detail.value = null;
  loading.value = false;
  busy.value = null;
  err.value = null;
  closeLaunch();
  acknowledgedShelfTask = '';
  personalTarget = '';
  cancelTaskEdit();
  editMessage.value = null;

  if (id && ui.taskUnavailable) {
    if (triageTimer) {
      clearInterval(triageTimer);
      triageTimer = null;
    }

    triage.value = null;
    conveyor.value = null;
    conveyorGraph.value = null;
    sandbox.value = null;
    err.value = t('core.taskNotFound');

    return;
  }

  if (id) {
    err.value = null;
    void trackers.load();
    detail.value = null;
    launchMsg.value = null;
    sandboxMsg.value = null;
    taskContext.focus({
      routingScope: { kind: 'task', taskId: String(id) },
      details: taskContextDetails(id),
    });
    launchForm.value = null;
    launchOpts.value = null;
    launchOptionsRequest += 1;
    launchOptionsBusy.value = false;
    triage.value = null;
    showNote.value = false;
    showClarifyHistory.value = false;
    showAnalysisDetails.value = false;
    mtab.value = 'triage';
    contentPane.value = 'description';
    comments.value = null;
    taskTags.value = [];
    taskTagsLoaded.value = false;
    taskSubtasks.value = [];
    clarifyDrafts.value = {};
    clarifySaved.value = '';
    clarifyEntries.value = [];
    clarifyComposerOpen.value = {};
    activeQuestionId.value = null;

    if (analysisEnabled.value) {
      loadClarifications();
    }

    loadDetail();
    loadConveyor();
    loadTriage();

    if (!ticker) {
      ticker = setInterval(() => {
        now.value = Date.now();
      }, 1000);
    }
  } else {
    void dictationLease.cancel();
    taskContext.blur();

    if (ticker) {
      clearInterval(ticker);
      ticker = null;
    }
    if (triageTimer) {
      clearInterval(triageTimer);
      triageTimer = null;
    }
  }
}, { immediate: true });

// Полка загружается параллельно карточке. Если её снимок пришёл позже, открытая
// задача всё равно должна погасить накопленный огонёк ровно один раз.
watch(
  () => [taskId.value!, shelf.value.loaded, shelf.value.entries, shelfEnabled.value],
  () => acknowledgeShelfOnOpen(),
);
watch(analysisEnabled, (enabled) => {
  if (!enabled) {
    void dictationLease.cancel();

    if (triageTimer) {
      clearInterval(triageTimer);
      triageTimer = null;
    }

    return;
  }
  if (taskId.value!) {
    loadClarifications();
    loadTriage();
  }
});
// Заголовок может приехать после открытия карточки. Обновляем bounded details, но не
// focus revision: открытый позже Pipeline/Task overlay должен остаться верхним.
watch(
  () => [taskId.value!, detail.value?.title || '', boardTask.value?.title || ''],
  ([id]) => {
    if (id) {
      taskContext.update({ details: taskContextDetails(id) });
    }
  },
  { immediate: true },
);
onUnmounted(() => {
  detailAbort?.abort();
  commentsAbort?.abort();
  detailRequest += 1;
  commentsRequest += 1;
  triageRequest += 1;
  clarificationsRequest += 1;

  if (triageTimer) {
    clearInterval(triageTimer);
    triageTimer = null;
  }

  stopLaunchEvents();
  closeLaunch();

  if (ticker) {
    clearInterval(ticker);
  }

  void dictationLease.release();
});
</script>

<style scoped>
.task-detail {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  container: task-detail / inline-size;
  background: var(--surface);
}
.mhead {
  flex: none;
  min-width: 0;
}
.mheading {
  min-width: 0;
  padding: 18px 20px 10px;
}
.meyebrow {
  color: var(--ink-mid);
  font-size: 12px;
  font-weight: 500;
}
.mid {
  color: var(--accent);
  font-size: 12px;
  font-weight: 600;
}
.mtitle {
  max-height: 84px;
  margin: 0;
  overflow-y: auto;
  color: var(--ink);
  font-size: 20px;
  font-weight: 650;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.mhead-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 4px;
}
/* В отдельном окне системной строки нет: окно двигают за шапку карточки,
   а её кнопки, включая «Закрыть», сохраняют клики и подсказки. */
.mhead-window {
  -webkit-app-region: drag;
  user-select: none;
}
.mhead-window .mhead-actions {
  -webkit-app-region: no-drag;
}
.malerts {
  flex: none;
  display: grid;
  gap: 4px;
  max-height: 104px;
  padding: 8px 20px;
  overflow-y: auto;
  border-bottom: 1px solid color-mix(in srgb, var(--bad) 28%, var(--line));
  background: color-mix(in srgb, var(--bad) 9%, var(--surface));
}
.err {
  margin: 0;
  color: var(--bad);
  font-size: 12.5px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.mcontext {
  flex: none;
  min-width: 0;
  padding: 0 20px 8px;
}
.meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 18px;
  min-width: 0;
}
.tag {
  max-width: 100%;
  padding: 3px 8px;
  border-radius: 4px;
  background: var(--surface-2);
  color: var(--ink);
  font-size: 11px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.context-item {
  display: inline-flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 3px 6px;
  min-width: 0;
  color: var(--ink);
  font-size: 12px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.task-avatar {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  object-fit: cover;
  align-self: center;
}
.task-avatar[hidden] {
  display: none;
}
.task-extra h5 {
  margin: 0 0 10px;
  font-size: 13px;
}
.task-checklist-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  min-width: 0;
}
.task-checklist-label {
  flex: 1 1 120px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.task-checklist-complete {
  color: var(--ink-mid);
  text-decoration: line-through;
}
.task-checklist-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-inline-start: auto;
}
.task-checklists {
  display: grid;
  gap: 12px;
}
.task-checklist-list {
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
}
.task-checklist-entry {
  min-width: 0;
  padding: 8px 12px;
}
.task-checklist-entry.is-list-header {
  border-block-end: 1px solid var(--line);
}
.task-checklist-heading {
  display: flex;
  flex: 1 1 160px;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  margin: 0;
  font-size: 13px;
  overflow-wrap: anywhere;
}
.task-checklist-heading .context-label {
  font-weight: normal;
}
.task-checklist-create {
  margin-block-start: 12px;
}
.task-checklist-editor {
  display: grid;
  flex: 1 0 100%;
  gap: 8px;
  min-width: 0;
}
.task-checklist-saved {
  margin: 8px 0 0;
  color: var(--good);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.task-tag-editor {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  max-width: 480px;
  min-width: 0;
  margin-block-start: 8px;
}
.task-tag-editor > .ui-input {
  flex: 1 1 140px;
  min-width: 0;
}
.task-checklist,
.task-subtasks {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.task-checklist {
  gap: 0;
}
.task-tag-list,
.task-subtasks li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.context-label {
  color: var(--ink-mid);
}
.context-item.over,
.context-item.over .context-label {
  color: var(--bad);
}
.context-empty {
  color: var(--ink-mid);
  font-size: 12px;
}
.task-sectionbar {
  flex: none;
  min-width: 0;
  padding-inline: 20px;
  border-bottom: 1px solid var(--line);
}
.mbody {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.task-pane {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.task-detail[data-pane='description'] .work-pane,
.task-detail[data-pane='work'] .brief-pane {
  display: none;
}
.brief-head {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 48px;
  padding: 16px 20px 0;
}
.pane-title {
  margin: 0;
  color: var(--ink);
  font-size: 14px;
  font-weight: 600;
  line-height: 20px;
}
.brief-scroll,
.tab-scroll {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}
.brief-scroll {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px 20px 24px;
}
.task-edit {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.brief-scroll--editing {
  gap: 0;
  padding: 0;
  overflow: hidden;
  scrollbar-gutter: auto;
}
.task-edit-scroll {
  display: grid;
  flex: 1;
  grid-template-columns: minmax(0, 1fr) minmax(240px, 0.55fr);
  align-content: start;
  align-items: start;
  gap: 24px;
  min-width: 0;
  min-height: 0;
  padding: 20px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}
.task-edit-main {
  display: grid;
  gap: 20px;
  min-width: 0;
}
.task-edit-properties {
  display: grid;
  gap: 16px;
  min-width: 0;
  padding-left: 24px;
  border-left: 1px solid var(--line);
}
.task-edit-section-title {
  margin: 0;
  color: var(--ink-mid);
  font-size: 11px;
  font-weight: 600;
  line-height: 1.5;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.task-edit-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 14px;
  min-width: 0;
}
.task-edit-people {
  display: grid;
  gap: 4px;
  min-width: 0;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}
.task-edit-count {
  margin-left: auto;
  color: var(--ink-mid);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.task-edit-people-list {
  max-height: 200px;
  min-width: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.task-edit-footer {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 12px 20px;
  min-width: 0;
  padding: 12px 20px;
  border-top: 1px solid var(--line);
  background: var(--surface);
}
.task-edit-note {
  margin: 0;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.task-edit-dirty {
  color: var(--warn);
}
.task-edit-actions {
  flex: none;
}
.edit-options-state {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.4;
}
.edit-options-state.bad {
  align-items: flex-start;
  justify-content: space-between;
  color: var(--bad);
}
.edit-message {
  margin: 0;
  padding: 8px 10px;
  border-left: 2px solid var(--good);
  background: color-mix(in srgb, var(--good) 8%, var(--surface));
  color: var(--good);
  font-size: 12px;
  line-height: 1.45;
}
.desc-box {
  max-width: 100ch;
  min-width: 0;
}
.desc {
  margin: 0;
  color: var(--ink);
  font-size: 14px;
  line-height: 1.75;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.desc :deep(a) {
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: 3px;
  overflow-wrap: anywhere;
}
.brief-empty {
  padding-block: 12px;
  color: var(--ink-mid);
  font-size: 13px;
  line-height: 1.6;
}
.tab-scroll {
  padding: 20px 20px 24px;
}
.tab-scroll.show-comments {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
/* Обсуждение в Telegram. min-width: 0 обязателен: блок стоит во флекс-колонке,
   а без него флекс-элемент не сжимается ниже своего содержимого — одна длинная
   ссылка из чужого чата раздвинула бы модалку (та же грабля, что была в чате).
   Ветка скроллится внутри себя: переписка не должна вытеснять описание. */
.tg { flex: none; min-width: 0; max-height: 360px; overflow-y: auto;
  background: var(--surface); border: 1px solid var(--line); border-radius: 10px;
  padding: 10px 12px; display: flex; flex-direction: column; gap: 10px; }
.tgitem { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.tgfail { display: flex; flex-direction: column; gap: 2px; font-size: 12px; }
.tgfail .tgurl { color: var(--ink-mid); overflow-wrap: anywhere; }
.tgwhy { color: var(--warn); }
.tghead { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; font-size: 12px; min-width: 0; }
.tgchat { color: var(--ink); font-weight: 600; overflow-wrap: anywhere; }
.tgat, .tgthread { color: var(--ink-mid); }
.tghead .tgurl { color: var(--accent); text-decoration: none; margin-left: auto; }
.tghead .tgurl:hover { text-decoration: underline; }
.tgq { border-left: 2px solid var(--line); padding: 0 0 0 8px; display: flex;
  flex-direction: column; gap: 2px; min-width: 0; }
.tgq.tgtarget { border-left-color: var(--accent); }
.tgmeta { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap;
  font-size: 11px; color: var(--ink-mid); }
.tgauthor { color: var(--ink); }
.tgpin { color: var(--accent); }
.tgtext { font-size: 13px; color: var(--ink); white-space: pre-wrap;
  overflow-wrap: anywhere; line-height: 1.5; }
.tgmedia { font-size: 11px; color: var(--ink-mid); overflow-wrap: anywhere; }
.tgmore { font-size: 11px; color: var(--ink-mid); }

.triage {
  display: flex;
  flex-direction: column;
  gap: 20px;
  min-width: 0;
}
.thead2 {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  min-width: 0;
}
.triage-summary {
  display: flex;
  flex: 1;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 10px;
  min-width: 0;
}
.triage-summary-title {
  color: var(--ink);
  font-size: 14px;
  font-weight: 600;
}
.triage-ready {
  color: var(--good);
  font-size: 12px;
}
.triage-metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  flex-basis: 100%;
  gap: 0;
  margin: 4px 0 0;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--surface-2);
}
.triage-metric {
  min-width: 0;
  padding: 14px 16px;
}
.triage-metric + .triage-metric {
  border-left: 1px solid var(--line);
}
.triage-metric dt {
  color: var(--ink-mid);
  font-size: 11px;
  line-height: 1.4;
}
.triage-metric dd {
  margin: 6px 0 0;
  color: var(--ink);
  font-size: 17px;
  font-weight: 600;
  line-height: 1.35;
  overflow-wrap: anywhere;
}
.triage-metric[data-tone='warning'] dd {
  color: var(--warn);
}
.triage-metric[data-tone='danger'] dd {
  color: var(--bad);
}
.triage-route {
  flex-basis: 100%;
  margin: 0;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.tlbl {
  color: var(--ink-mid);
  font-size: 12px;
}
.tmuted {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--ink-mid);
  font-size: 13px;
}
.triage-progress {
  justify-content: center;
  gap: 10px;
  padding: 28px 12px;
  border-radius: 10px;
  background: var(--surface);
}
.triage-progress-state,
.triage-progress-time {
  color: var(--ink-mid);
  font-size: 13px;
}
.terr {
  color: var(--bad);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.thead2 [data-role='task-compact-action'] {
  flex: none;
}
.thead2.is-empty {
  align-items: flex-start;
  flex-direction: column;
  gap: 14px;
  padding-block: 8px;
}
.is-empty .triage-summary {
  align-items: flex-start;
  flex-direction: column;
  gap: 8px;
}
.is-empty .triage-summary-title {
  color: var(--ink);
  font-size: 14px;
  font-weight: 600;
}
.triage-empty-hint {
  max-width: 62ch;
  margin: 0;
  color: var(--ink-mid);
  font-size: 13px;
  line-height: 1.6;
}
.triage-findings {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: start;
  gap: 20px 32px;
}
.triage-findings:has(> :only-child) {
  grid-template-columns: minmax(0, 1fr);
}
.triage-findings .tstale {
  grid-column: 1 / -1;
}
.triage-result h5,
.triage-risks h5 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 9px;
  color: var(--ink);
  font-size: 13px;
  font-weight: 650;
}
.triage-risks h5 span {
  color: var(--ink-mid);
  font-size: 12px;
  font-weight: 400;
}
.tsum {
  margin: 0;
  color: var(--ink);
  font-size: 13px;
  line-height: 1.65;
  overflow-wrap: anywhere;
}
.tstale {
  margin: 0;
  padding: 10px 12px;
  border-left: 2px solid var(--warn);
  background: color-mix(in srgb, var(--warn) 7%, transparent);
  color: var(--warn);
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.tlist {
  display: grid;
  gap: 10px;
  margin: 0;
  padding-left: 18px;
  color: var(--ink-mid);
  font-size: 12.5px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.tlist li::marker {
  color: var(--warn);
}
.clarify {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border-top: 1px solid var(--line);
}
.triage-disabled {
  padding-block: 8px;
  color: var(--ink-mid);
  font-size: 13px;
}
.clarify-head {
  padding-block: 16px 4px;
}
.clarify-head h5 {
  margin: 0;
  color: var(--ink);
  font-size: 14px;
  font-weight: 600;
  line-height: 20px;
}
.clarify-head p {
  margin: 6px 0 0;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.5;
}
.clarify-list {
  min-width: 0;
}
.clarify-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  padding-block: 16px;
}
.clarify-card + .clarify-card {
  border-top: 1px solid var(--line);
}
.clarify-question {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr);
  align-items: start;
  gap: 10px;
}
.clarify-index {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 4px;
  background: var(--surface-2);
  color: var(--ink-mid);
  font-family: var(--mono);
  font-size: 11px;
}
.clarify-card.is-answered .clarify-index {
  color: var(--good);
}
.clarify-question-copy {
  min-width: 0;
}
.clarify-question h6 {
  margin: 1px 0 0;
  color: var(--ink);
  font-size: 13px;
  font-weight: 600;
  line-height: 20px;
  overflow-wrap: anywhere;
}
.clarify-status {
  display: inline-flex;
  margin-top: 5px;
  color: var(--good);
  font-size: 11px;
  line-height: 1.5;
}
.clarify-status.warn {
  color: var(--warn);
}
.clarify-recommendation {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 8px;
  min-width: 0;
  margin-left: 32px;
  padding: 10px 12px;
  border-left: 2px solid var(--accent);
  background: color-mix(in srgb, var(--accent) 5%, transparent);
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.5;
}
.clarify-recommendation-label {
  color: var(--accent);
  font-weight: 500;
}
.clarify-recommendation strong {
  color: var(--ink);
  font-weight: 600;
}
.clarify-options,
.clarify-compose-row,
.clarify-answer {
  margin-left: 32px;
}
.clarify-answer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.clarify-answer-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 4px 8px;
  color: var(--ink);
  font-size: 12px;
}
.clarify-answer-head small {
  color: var(--ink-mid);
  font-size: 11px;
}
.clarify-text {
  width: 100%;
  min-width: 0;
}
.clarify-answer-tools {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  color: var(--ink-mid);
  font-size: 11px;
  line-height: 1.5;
}
.clarify-card-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 6px;
}
.clarify-submit {
  padding-top: 16px;
  border-top: 1px solid var(--line);
}
.clhist,
.triage-details {
  min-width: 0;
  padding-top: 8px;
  border-top: 1px solid var(--line);
}
.clhist-body {
  max-height: 260px;
  margin-top: 8px;
  padding: 0 10px;
  overflow-y: auto;
  color: var(--ink-mid);
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.triage-private-hint {
  margin: 0 0 10px;
  color: var(--warn);
  font-size: 12px;
}
.attrow { display: flex; gap: 8px; flex-wrap: wrap; width: 100%; }
.attchip { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line);
  border-radius: 8px; padding: 3px 8px 3px 3px; background: var(--surface-2); font-size: 12px; }
.attchip img { width: 26px; height: 26px; object-fit: cover; border-radius: 5px; }
.attname { max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-mid); }
/* ── Таб комментариев ── */
.comtab {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
  min-height: 0;
}
.comlist {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  overflow-y: auto;
  scrollbar-gutter: stable;
}

.com {
  padding-block: 12px;
  border-bottom: 1px solid var(--line);
}
.com:first-child {
  padding-top: 0;
}
.comhead {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 4px 10px;
  font-size: 13px;
  overflow-wrap: anywhere;
}
.comtime { color: var(--ink-mid); font-size: 11.5px; }
.comtext { margin-top: 4px; font-size: 13.5px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.comatts { margin-top: 6px; display: flex; gap: 8px; flex-wrap: wrap; }
.comatt { font-size: 12px; color: var(--ink-mid); border: 1px dashed var(--line); border-radius: 7px; padding: 2px 8px; }
.tnote { font-size: 13px; color: var(--ink); line-height: 1.55; max-height: 360px; overflow-y: auto;
  border-top: 1px solid var(--line); padding-top: 8px; }
.tnote :deep(h3), .tnote :deep(h4), .tnote :deep(h5), .tnote :deep(h6) { margin: 10px 0 4px; font-size: 13px; color: var(--ink); }
.tnote :deep(p) { margin: 4px 0; }
.tnote :deep(ul) { margin: 4px 0; padding-left: 18px; }
.tnote :deep(code) { font-family: var(--mono, monospace); font-size: 12px; background: var(--surface-2);
  border-radius: 4px; padding: 1px 4px; }
.tnote :deep(pre) { background: var(--surface-2); border-radius: 8px; padding: 8px 10px; overflow-x: auto; }
.tmeta {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 8px 16px;
  margin: 10px;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.5;
}
.tmeta dd {
  min-width: 0;
  margin: 0;
  color: var(--ink);
  overflow-wrap: anywhere;
}
.controls {
  position: relative;
  flex: none;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px 16px;
  min-width: 0;
  padding: 12px 20px;
  border-top: 1px solid var(--line);
  background: var(--surface);
}
.timer-group {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.timer {
  flex: none;
  display: flex;
  flex-direction: column;
  min-width: 90px;
}
.tclock {
  font-size: 17px;
  font-weight: 650;
  line-height: 1.25;
}
.timer.run .tclock {
  color: var(--good);
}
.tstate {
  color: var(--ink-mid);
  font-size: 11px;
}
.cbtns {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
}
.csecondary {
  display: flex;
  flex: 1 0 100%;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 6px 20px;
  min-width: 0;
  padding-top: 8px;
  border-top: 1px solid var(--line);
}
.ctools,
.cdanger {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}
.cdanger {
  margin-left: auto;
}
.convstall { width: 100%; }
.lmsg { font-size: 12px; color: var(--good); flex-basis: 100%; }
/* Форма запуска открывается как ограниченная по высоте панель над постоянными
   действиями: большой delivery contract не выталкивает карточку за viewport. */
.lform { position: absolute; z-index: 3; left: -1px; right: -1px; bottom: calc(100% + 1px);
  display: flex; flex-direction: column; gap: 8px; max-height: min(560px, 62dvh);
  margin: 0; padding: 14px 16px 16px; overflow-y: auto; overscroll-behavior: contain;
  scrollbar-gutter: stable; border: 1px solid var(--line-2); border-bottom-color: var(--line);
  border-radius: 12px 12px 0 0; background: var(--surface-2); box-shadow: 0 -18px 48px #0009; }
.lrow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.llbl { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--ink-mid); }
.lopt { text-transform: none; letter-spacing: 0; }
.lrepo { display: grid; grid-template-columns: minmax(90px, auto) 1fr; align-items: center; gap: 10px; }
.lrepo code { color: var(--ink); overflow-wrap: anywhere; }
.lhint { font-size: 12px; color: var(--ink-mid); }
.lhint.suggested { color: var(--good); }
/* Основание рекомендации — отдельной строкой: в ряд с селектом оно не влезает. */
.lreason { flex-basis: 100%; }
.lsummary { display: grid; gap: 5px; padding: 8px 10px; border: 1px solid var(--line);
  border-radius: 9px; background: var(--ground); }
.lsummary-row { display: grid; grid-template-columns: minmax(90px, auto) 1fr; gap: 10px;
  align-items: baseline; font-size: 12.5px; }
.lsummary-row > span { color: var(--ink-mid); }
.lsummary-row > b { min-width: 0; overflow-wrap: anywhere; font-weight: 550; }
.lshipwarn { margin: 2px 0 0; padding-top: 6px; border-top: 1px solid var(--line);
  color: var(--warn); font-size: 11.5px; line-height: 1.4; }
.lnote { margin: 0; font-size: 11.5px; color: var(--ink-mid); line-height: 1.45; }
.lscope-skip { border: 1px dashed var(--line); border-radius: 9px; padding: 6px 10px; }
.lscope-skip-title { font-weight: 600; }
.lscope-skip ul { margin: 4px 0; padding-left: 18px; }
.ladvanced { margin-top: 2px; border: 1px dashed var(--line); border-radius: 9px; padding: 7px 10px; }
.ladvanced summary { color: var(--ink-mid); font-size: 12px; cursor: pointer; user-select: none; }
.ladvanced[open] summary { margin-bottom: 9px; }
.ladvanced-body { display: flex; flex-direction: column; gap: 7px; }
.lerror { margin: 0; color: var(--bad); font-size: 12px; }
.lbtns { display: flex; gap: 8px; justify-content: flex-end; }
.comment {
  display: flex;
  flex: none;
  align-items: flex-end;
  gap: 10px;
  margin-top: auto;
  padding-top: 14px;
  border-top: 1px solid var(--line);
}
.comment-text {
  flex: 1;
  min-width: 0;
}

@container task-detail (max-width: 700px) {
  .task-edit-scroll {
    grid-template-columns: minmax(0, 1fr);
  }
  .task-edit-properties {
    padding: 20px 0 0;
    border-top: 1px solid var(--line);
    border-left: 0;
  }
  .task-edit-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .triage-findings {
    grid-template-columns: minmax(0, 1fr);
  }
  .timer-group {
    flex: 1 1 100%;
    justify-content: space-between;
  }
  .cbtns {
    flex: 1;
  }
  .triage-metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .triage-metric:nth-child(3) {
    border-left: 0;
  }
  .triage-metric:nth-child(n + 3) {
    border-top: 1px solid var(--line);
  }
}

@container task-detail (max-width: 480px) {
  .mheading {
    padding: 10px 12px 8px;
  }
  .mtitle {
    max-height: 70px;
    font-size: 16px;
  }
  .malerts {
    max-height: 88px;
    padding: 8px 12px;
  }
  .mcontext {
    max-height: 72px;
    padding: 0 12px 10px;
    overflow-y: auto;
  }
  .meta {
    gap: 6px 14px;
  }
  .context-item {
    font-size: 11px;
  }
  .task-sectionbar {
    padding-inline: 12px;
  }
  .brief-head {
    padding: 12px 12px 0;
  }
  .brief-scroll,
  .tab-scroll {
    padding: 14px 12px;
  }
  .brief-scroll--editing {
    padding: 0;
  }
  .task-edit-scroll {
    gap: 20px;
    padding: 16px 12px;
  }
  .task-edit-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .task-edit-footer {
    align-items: stretch;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px calc(10px + env(safe-area-inset-bottom));
  }
  .task-edit-actions > * {
    flex: 1;
  }
  .desc {
    font-size: 13.5px;
    line-height: 1.65;
  }
  .tg {
    max-height: 280px;
    padding: 9px 10px;
  }
  .clarify-head {
    padding-top: 16px;
  }
  .clarify-card {
    padding-block: 16px;
  }
  .clarify-recommendation,
  .clarify-options,
  .clarify-compose-row,
  .clarify-answer {
    margin-left: 0;
  }
  .clarify-answer-tools {
    align-items: flex-start;
  }
  .comment {
    flex-direction: column;
    align-items: stretch;
  }
  .comment > :last-child {
    align-self: flex-end;
  }
  .controls {
    gap: 8px;
    padding: 8px 12px calc(8px + env(safe-area-inset-bottom));
  }
  .timer-group {
    gap: 8px;
  }
  .timer {
    min-width: 78px;
  }
  .tclock {
    font-size: 16px;
  }
  .cbtns {
    display: grid;
    flex-basis: 100%;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 6px;
  }
  .cbtns:has(> :nth-child(3)) > :first-child {
    grid-column: 1 / -1;
  }
  .csecondary {
    gap: 6px 12px;
    padding-top: 6px;
  }
  .convstall,
  .lmsg {
    grid-column: 1 / -1;
  }
  .lform {
    max-height: 60dvh;
    padding: 12px 12px 14px;
    border-radius: 10px 10px 0 0;
  }
  .lrow {
    align-items: stretch;
  }
  .lsummary-row,
  .lrepo {
    grid-template-columns: 1fr;
    gap: 3px;
  }
  .lbtns > * {
    flex: 1;
  }
}

@media (max-height: 540px) {
  .mheading {
    padding-block: 6px;
  }
  .mtitle {
    max-height: 48px;
    font-size: 16px;
  }
  .mcontext {
    max-height: 46px;
    padding-bottom: 6px;
    overflow-y: auto;
  }
  .controls {
    padding-block: 6px;
  }
  .timer-group {
    flex: 1 1 auto;
  }
}
</style>

<template>
  <UiDialog
    :open="Boolean(taskId)"
    data-role="task-modal"
    size="workspace"
    :label="detail?.title || `Задача #${taskId || ''}`"
    :body-inset="false"
    fade-only
    @update:open="onTaskDialogOpenChange"
  >
      <header class="mhead">
        <div class="mheading">
          <div class="midentity">
            <span class="meyebrow">Задача Битрикс24</span>
            <span class="mid mono">#{{ taskId }}</span>
          </div>
          <h3 id="task-modal-title" class="mtitle">
            <UiSpinner v-if="loading && !detail" decorative />
            {{ detail?.title || (loading ? 'Загрузка…' : 'Задача') }}
          </h3>
        </div>
        <div class="mhead-actions" role="group" aria-label="Действия с карточкой">
          <TaskFavoriteButton :active="favorites.isFavorite(taskId)"
                              :pending="!favorites.loaded || favorites.loading || favorites.isPending(taskId)"
                              :task-title="detail?.title || boardTask?.title || `Задача #${taskId}`"
                              @toggle="toggleFavorite" />
          <UiIconButton
            data-context="task-modal-header"
            label="Обновить задачу"
            title="Обновить"
            :loading="loading"
            :disabled="Boolean(editForm) || busy === 'edit'"
            loading-label="Обновляю задачу"
            @click="refresh"
          >
            ⟳
          </UiIconButton>
          <UiIconButton
            data-context="task-modal-header"
            label="Закрыть задачу"
            title="Закрыть (Esc)"
            @click="ui.close()"
          >
            ✕
          </UiIconButton>
        </div>
      </header>

      <div v-if="err || favorites.error || shelf.error" class="malerts" aria-live="polite">
        <p v-if="err" class="err">{{ err }}</p>
        <p v-if="favorites.error" class="err">Избранное: {{ favorites.error }}</p>
        <p v-if="shelf.error" class="err">Полка: {{ shelf.error }}</p>
      </div>

      <div class="mcontext" aria-label="Состояние задачи">
        <div class="meta">
          <span v-if="detail?.status_label" class="tag task-status">{{ detail.status_label }}</span>
          <span v-if="taskProject" class="context-item">
            <span class="context-label">Проект</span>{{ taskProject }}
          </span>
          <span v-if="taskResponsible" class="context-item">
            <span class="context-label">Исполнитель</span>{{ taskResponsible }}
          </span>
          <span v-if="detail?.priority_label" class="context-item">
            <span class="context-label">Приоритет</span>{{ detail.priority_label }}
          </span>
          <span v-if="boardTask?.deadline" class="context-item" :class="{ over: boardTask.overdue }">
            <span class="context-label">{{ boardTask.overdue ? 'Просрочена' : 'Срок' }}</span>
            {{ boardTask.deadline }}
          </span>
          <span v-if="!detail?.status_label && !detail?.priority_label
            && !taskProject && !taskResponsible && !boardTask?.deadline"
                class="context-empty">{{ loading ? 'Читаю данные задачи…' : 'Дополнительных меток нет' }}</span>
        </div>
      </div>

      <div class="mbody">
        <section class="task-pane brief-pane" aria-labelledby="task-brief-title">
          <div class="pane-head">
            <div>
              <h4 id="task-brief-title" class="pane-title">Описание задачи</h4>
            </div>
            <UiButton
              v-if="detail && !editForm"
              data-role="task-edit-open"
              title="Редактировать задачу"
              :disabled="loading || busy === 'edit'"
              @click="openTaskEdit"
            >
              Изменить
            </UiButton>
          </div>
          <div class="brief-scroll">
            <div v-if="editForm" class="task-edit" aria-label="Редактирование задачи">
              <UiField
                label="Заголовок"
                required
                :error="editForm.title.trim() ? '' : 'Введите заголовок задачи'"
              >
                <UiInput
                  v-model="editForm.title"
                  data-role="task-edit-title"
                  maxlength="255"
                  autocomplete="off"
                  :disabled="busy === 'edit'"
                />
              </UiField>

              <UiField
                label="Описание"
                hint="Сохраняется обычным текстом; ссылки останутся кликабельными в карточке."
              >
                <UiTextarea
                  v-model="editForm.description"
                  data-role="task-edit-description"
                  rows="10"
                  :disabled="busy === 'edit'"
                  @keydown.ctrl.enter.prevent="saveTaskEdit"
                />
              </UiField>

              <div class="task-edit-grid">
                <UiField label="Исполнитель">
                  <UiSelect
                    v-model="editForm.responsibleId"
                    data-role="task-edit-responsible"
                    :disabled="editOptionsBusy || busy === 'edit'"
                  >
                    <option v-if="!editForm.responsibleId" value="" disabled>— не указан —</option>
                    <option
                      v-for="user in editResponsibleOptions"
                      :key="user.id"
                      :value="String(user.id)"
                    >
                      {{ user.name }}
                    </option>
                  </UiSelect>
                </UiField>

                <UiField label="Проект">
                  <UiSelect
                    v-model="editForm.groupId"
                    data-role="task-edit-group"
                    :disabled="editOptionsBusy || busy === 'edit'"
                  >
                    <option value="">— без проекта —</option>
                    <option
                      v-for="group in editGroupOptions"
                      :key="group.id"
                      :value="String(group.id)"
                    >
                      {{ group.name }}
                    </option>
                  </UiSelect>
                </UiField>

                <UiField label="Приоритет">
                  <UiSelect
                    v-model.number="editForm.priority"
                    data-role="task-edit-priority"
                    :disabled="busy === 'edit'"
                  >
                    <option :value="0">низкий</option>
                    <option :value="1">средний</option>
                    <option :value="2">высокий</option>
                  </UiSelect>
                </UiField>
              </div>

              <div v-if="editOptionsBusy" class="edit-options-state">
                <UiSpinner decorative /> Загружаю исполнителей и проекты…
              </div>
              <div v-else-if="editOptionsError" class="edit-options-state bad">
                <span>{{ editOptionsError }}</span>
                <UiButton data-role="task-edit-options-retry" @click="loadEditOptions">
                  Повторить
                </UiButton>
              </div>

              <UiFormActions class="task-edit-actions">
                <UiButton
                  data-role="task-edit-cancel"
                  :disabled="busy === 'edit'"
                  @click="cancelTaskEdit"
                >
                  Отмена
                </UiButton>
                <UiButton
                  data-role="task-edit-save"
                  tone="success"
                  variant="solid"
                  :loading="busy === 'edit'"
                  :disabled="!editCanSave"
                  loading-label="Сохраняю задачу"
                  @click="saveTaskEdit"
                >
                  Сохранить в Битрикс24
                </UiButton>
              </UiFormActions>
            </div>

            <template v-else>
              <p v-if="editMessage" class="edit-message" role="status">{{ editMessage }}</p>
              <div v-if="cleanDesc" class="desc-box">
                <p class="desc" v-html="descHtml"></p>
              </div>

              <!-- Обсуждение в Telegram: то, на что показывают ссылки в описании -->
              <section v-if="tgLinks.length" class="tg">
                <div class="tlbl">Обсуждение в Telegram</div>
                <div v-for="(l, i) in tgLinks" :key="i" class="tgitem">
                  <!-- Нераскрытая ссылка обязана объяснить себя: молчание читается
                       как «в чате пусто», а причина — как «сюда нет доступа». -->
                  <div v-if="!l.ok" class="tgfail">
                    <span class="tgurl">{{ l.url }}</span>
                    <span class="tgwhy">{{ l.message || 'ссылка не раскрыта' }}</span>
                  </div>
                  <template v-else>
                    <div class="tghead">
                      <span class="tgchat">{{ l.chat?.title || 'Чат' }}</span>
                      <span v-if="l.chat?.username" class="tgat">@{{ l.chat.username }}</span>
                      <span v-if="l.thread" class="tgthread">тема {{ l.thread }}</span>
                      <a class="tgurl" :href="l.url" target="_blank" rel="noopener">открыть</a>
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
                        <span v-if="q.target" class="tgpin">← ссылка</span>
                      </div>
                      <div class="tgtext">
                        {{ q.text }}<template v-if="q.trimmed">…</template>
                      </div>
                      <div v-if="q.media?.length" class="tgmedia">{{ q.media.join(', ') }}</div>
                    </div>
                    <div v-if="l.more" class="tgmore">
                      ещё {{ l.more }} {{ tgPlural(l.more) }} в ветке
                    </div>
                  </template>
                </div>
              </section>
              <div v-if="!cleanDesc && !tgLinks.length" class="brief-empty">
                Постановка пока не загружена или в задаче нет описания.
              </div>
            </template>
          </div>
        </section>

        <section class="task-pane work-pane" aria-labelledby="task-work-title">
          <div class="work-head">
            <div>
              <h4 id="task-work-title" class="pane-title">Разбор задачи</h4>
            </div>
            <!-- Табы: Триаж | Комментарии -->
            <UiTabs v-model="mtab" class="mtabs" label="Раздел карточки задачи">
              <UiTab
                id="task-tab-triage"
                data-context="task-modal-tab"
                value="triage"
                controls="task-panel-triage"
              >
                Оценка
              </UiTab>
              <UiTab
                id="task-tab-comments"
                data-context="task-modal-tab"
                value="comments"
                controls="task-panel-comments"
              >
                Комментарии<template v-if="comments?.length"> ({{ comments.length }})</template>
              </UiTab>
            </UiTabs>
          </div>

          <div class="tab-scroll" :class="{ 'show-comments': mtab === 'comments' }">
            <!-- Триаж: оценка сложности/рисков без стенда -->
            <div
              v-show="mtab === 'triage'"
              id="task-panel-triage"
              class="triage"
              role="tabpanel"
              aria-labelledby="task-tab-triage"
            >
          <div v-if="!analysisEnabled" class="triage-disabled">
            Триаж выключен в настройках плагинов. Сохранённые оценки и уточнения не удалены.
          </div>
          <template v-else>
          <div v-if="!triagePending" class="thead2">
            <div class="triage-summary">
              <span class="triage-summary-title">Оценка по коду</span>
              <span v-if="triage?.analysis" class="triage-ready">Готова</span>
              <span v-else-if="triageState === 'failed'" class="terr">
                Не удалось оценить: {{ triage?.status?.error || 'попробуйте ещё раз' }}
              </span>
              <span v-else class="tmuted">Задача ещё не оценена</span>
            </div>
            <UiButton
              data-role="task-compact-action"
              tone="accent"
              @click="analyzeNow"
            >
              {{ triage?.analysis ? 'Переоценить' : 'Оценить задачу' }}
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
            <p v-if="triage?.analysis" class="triage-route" :title="triage.analysis.route_reason || ''">
              {{ triageWorkLabel }}
              <span v-if="triageDepthLabel">· {{ triageDepthLabel }} маршрут</span>
            </p>
          </div>

          <!-- Нажал «Уточнить» или «Переоценить» — и до конца захода на панели остаётся
               только ход разбора со счётчиком. Прошлая оценка и уже отвеченные вопросы к
               нему отношения не имеют, а сделать с ними человек всё равно ничего не может. -->
          <div v-else class="thead2 triage-progress" role="status" aria-live="polite">
            <span class="tlbl">Триаж</span>
            <UiSpinner decorative />
            <span class="triage-progress-state">{{ triageProgressLabel }}</span>
            <span v-if="triageProgressElapsed" class="triage-progress-time mono">
              {{ triageProgressElapsed }}
            </span>
          </div>

          <template v-if="triage?.analysis && !triagePending">
            <section v-if="triage.analysis.summary" class="triage-result" aria-label="Вывод оценки">
              <h5>Вывод</h5>
              <p class="tsum">{{ triage.analysis.summary }}</p>
            </section>
            <p v-if="triage.stale?.length" class="tstale">
              ⚠ Код под оценкой менялся: {{ triage.stale.slice(0, 5).join(', ') }}{{ triage.stale.length > 5 ? ` и ещё ${triage.stale.length - 5}` : '' }} — стоит переоценить.
            </p>
            <section v-if="triage.analysis.risk_markers?.length" class="triage-risks">
              <h5>Риски и ограничения <span>{{ triage.analysis.risk_markers.length }}</span></h5>
              <ul class="tlist">
                <li v-for="m in triage.analysis.risk_markers" :key="m">{{ m }}</li>
              </ul>
            </section>
            <section
              v-if="triageQuestions.length"
              class="clarify"
              aria-labelledby="task-triage-questions-title"
            >
              <header class="clarify-head">
                <span class="clarify-head-icon" aria-hidden="true">?</span>
                <div>
                  <h5 id="task-triage-questions-title">Нужно ваше решение</h5>
                  <p>Выберите подходящий вариант. При необходимости добавьте пояснение.</p>
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
                        warn: answerFor(question).status === 'human_required',
                      }"
                    >
                      {{ answerFor(question).status === 'human_required'
                        ? 'Арбитр оставил вопрос человеку'
                        : answerFor(question).actor === 'cockpit-arbiter'
                          ? 'Арбитр — машинный ответ'
                          : 'Ответил человек' }}
                    </span>
                  </div>
                </div>
                <div v-if="question.recommendation" class="clarify-recommendation">
                  <span class="clarify-recommendation-label">Рекомендация</span>
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
                    {{ composerOpenFor(question) ? 'Скрыть пояснение' : 'Добавить пояснение' }}
                  </UiDisclosureButton>
                </div>
                <div
                  v-show="composerOpenFor(question)"
                  :id="`task-clarification-extra-${questionIndex}`"
                  class="clarify-answer"
                >
                  <div class="clarify-answer-head">
                    <span>{{ question.options.length ? 'Пояснение к выбору' : 'Ваш ответ' }}</span>
                    <small>{{ question.options.length ? 'необязательно' : 'своими словами' }}</small>
                  </div>
                  <UiTextarea
                    v-model="clarifyDrafts[question.id].text"
                    class="clarify-text"
                    data-role="task-clarification"
                    rows="2"
                    :placeholder="question.options.length
                      ? 'Добавьте детали, если одного варианта недостаточно'
                      : 'Ответьте на вопрос триажа'"
                    @focus="activeQuestionId = question.id"
                    @paste="onClarifyPaste(question.id, $event)"
                    @keydown.ctrl.enter.prevent="sendClarify"
                  />
                  <div class="clarify-answer-tools">
                    <span>Локально, не в B24 · Ctrl+Enter — отправить</span>
                    <div class="clarify-card-actions">
                      <UiFilePicker
                        data-role="task-attachment"
                        accept="image/*"
                        multiple
                        density="compact"
                        label="Приложить фото"
                        loading-label="Прикладываю фото"
                        title="Приложить фото к ответу"
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
                        :label="`Начать диктовку ответа на вопрос: ${question.text}`"
                        title="Начать диктовку"
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
                        :label="`Убрать ${attachment.name}`"
                        title="Убрать"
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
                    loading-label="Сохраняю уточнения"
                    @click="sendClarify"
                  >
                    ↻ Уточнить и переоценить
                  </UiButton>
                  <UiButton
                    v-if="analysisManifest"
                    :loading="busy === 'arbitrate'"
                    :disabled="busy === 'arbitrate'"
                    @click="arbitrateQuestions"
                  >
                    Разобрать арбитром
                  </UiButton>
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
              >
                Уточнения для агентов
              </UiDisclosureButton>
              <div v-if="showClarifyHistory" id="task-triage-history" class="clhist-body">
                <p class="triage-private-hint">Хранятся локально. Заказчик их не видит.</p>
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
            >
              Разведнота · карта кода
            </UiDisclosureButton>
            <div v-if="showNote" id="task-triage-note" class="tnote" v-html="noteHtml"></div>
            <div v-if="triage.analysis.generated_at || triage.analysis.meta" class="triage-details">
              <UiDisclosureButton
                controls="task-analysis-details"
                data-role="task-analysis-disclosure"
                density="compact"
                :open="showAnalysisDetails"
                @update:open="showAnalysisDetails = $event"
              >
                Подробности оценки
              </UiDisclosureButton>
              <dl v-if="showAnalysisDetails" id="task-analysis-details" class="tmeta">
                <template v-if="triage.analysis.generated_at">
                  <dt>Получена</dt>
                  <dd>{{ new Date(triage.analysis.generated_at).toLocaleString('ru-RU') }}</dd>
                </template>
                <template v-if="triage.analysis.meta?.provider">
                  <dt>Исполнитель</dt><dd>{{ triage.analysis.meta.provider }}</dd>
                </template>
                <template v-if="triage.analysis.meta?.model">
                  <dt>Модель</dt><dd>{{ triage.analysis.meta.model }}</dd>
                </template>
                <template v-if="triage.analysis.meta?.effort">
                  <dt>Усилие</dt><dd>{{ triage.analysis.meta.effort }}</dd>
                </template>
                <template v-if="triage.analysis.meta?.duration_ms != null">
                  <dt>Длительность</dt>
                  <dd>{{ mmss(triage.analysis.meta.duration_ms / 1000) }}</dd>
                </template>
                <template v-if="triage.analysis.meta?.cost_usd != null">
                  <dt>Стоимость</dt><dd>${{ triage.analysis.meta.cost_usd.toFixed(2) }}</dd>
                </template>
              </dl>
            </div>
          </template>
          </template>
        </div>

        <!-- Комментарии задачи (таб): список из B24 + добавление -->
        <div
          v-show="mtab === 'comments'"
          id="task-panel-comments"
          class="comtab"
          role="tabpanel"
          aria-labelledby="task-tab-comments"
        >
          <div v-if="comLoading && comments === null" class="tmuted">
            <UiSpinner decorative /> загрузка комментариев…
          </div>
          <div v-else-if="comments && !comments.length" class="tmuted">Комментариев нет.</div>
          <div v-else-if="comments" class="comlist">
            <div v-for="c in comments" :key="c.mid" class="com">
              <div class="comhead">
                <b>{{ c.author }}</b>
                <span class="comtime mono">{{ c.time }}</span>
              </div>
              <div class="comtext">{{ c.text }}</div>
              <div v-if="c.attachments?.length" class="comatts">
                <span v-for="a in c.attachments" :key="a.attachedId" class="comatt">📎 {{ a.name || `файл ${a.attachedId}` }}</span>
              </div>
            </div>
          </div>
          <div class="comment">
            <UiTextarea
              v-model="commentText"
              class="comment-text"
              data-role="task-comment"
              aria-label="Комментарий к задаче"
              rows="2"
              :disabled="busy === 'comment'"
              placeholder="Добавить комментарий…"
            />
            <UiButton
              :loading="busy === 'comment'"
              :disabled="busy === 'comment' || !commentText.trim()"
              loading-label="Отправляю комментарий"
              @click="sendComment"
            >
              Отправить
            </UiButton>
          </div>
        </div>
          </div>
        </section>
      </div>

      <!-- Управление -->
      <footer class="controls" aria-label="Действия с задачей">
          <div class="timer-group" role="group" aria-label="Учёт времени">
            <div class="timer" :class="{ run: running }">
              <span class="tclock mono">{{ elapsed !== null ? secToHMS(elapsed) : '—' }}</span>
              <span class="tstate">{{ running ? 'Идёт учёт' : 'Учёт остановлен' }}</span>
            </div>
            <UiButton
              data-context="task-footer-action"
              :tone="running ? 'warning' : 'accent'"
              variant="outline"
              :loading="busy === 'timer'"
              :disabled="busy === 'timer'"
              loading-label="Обновляю учёт времени"
              @click="toggleTimer"
            >
              {{ running ? '⏸ Остановить учёт' : '▶ Начать учёт' }}
            </UiButton>
          </div>
          <div class="cbtns">
            <UiButton
              v-if="shelfEnabled"
              data-context="task-footer-action"
              data-role="task-shelf-toggle"
              tone="neutral"
              variant="outline"
              :pressed="shelf.isOnShelf(taskId)"
              :loading="shelf.isPending(taskId)"
              :disabled="shelf.isPending(taskId)"
              loading-label="Обновляю полку"
              @click="toggleShelf"
            >
              {{ shelf.isOnShelf(taskId) ? 'На полке' : 'На полку' }}
            </UiButton>
            <!-- Уже на конвейере — вместо запуска показываем переход, повторный старт заблокирован.
                 Затык виден прямо на кнопке: карточку задачи открывают чаще, чем конвейер, а
                 «Уже на конвейере» одинаково выглядело и у идущей задачи, и у вставшей, поэтому
                 ожидание человека оставалось незаметным. -->
            <UiButton
              v-if="conveyor"
              data-context="task-footer-action"
              :tone="conveyor.stall ? 'danger' : 'accent'"
              variant="outline"
              :title="conveyor.stall
                ? `${conveyor.stall.title} — ${conveyor.stall.hint}`
                : `Задача уже на конвейере (${conveyor.route || 'маршрут'}) — открыть`"
              @click="openConveyor"
            >
              {{ conveyor.stall ? (conveyor.stall.kind === 'crashed' ? '✖ Конвейер оборвался' : '🛑 Конвейер встал')
                 : conveyor.daemonAlive ? '🏭 Идёт на конвейере' : '🏭 Уже на конвейере' }} →
            </UiButton>
            <UiButton
              v-else
              data-context="task-footer-action"
              data-role="task-launch-open"
              tone="accent"
              variant="outline"
              :loading="busy === 'launch' || launchOptionsBusy"
              :disabled="busy === 'launch' || launchOptionsBusy || !!launchForm"
              loading-label="Читаю параметры запуска"
              :title="launchOpenHint"
              @click="openLaunch"
            >
              🏭 На конвейер
            </UiButton>
            <!-- Стенд задачи сносится прямо отсюда: карточку открывают, чтобы закрыть
                 задачу, и ради одной кнопки идти в конвейер незачем. -->
            <UiButton
              v-if="sandbox"
              data-context="task-footer-action"
              tone="danger"
              variant="outline"
              :loading="sandboxBusy"
              :disabled="sandboxBusy"
              loading-label="Сношу стенд"
              :title="`Снести песочницу задачи (фронт :${sandbox.fePort}${sandbox.apiPort ? `, API :${sandbox.apiPort}` : ''})`"
              @click="sandboxDown"
            >
              ⏏ Снести стенд
            </UiButton>
            <OpenDiffButton
              data-context="task-footer-action"
              :task-id="taskId"
            />
            <UiButton
              data-context="task-footer-action"
              tone="success"
              variant="solid"
              :loading="busy === 'complete'"
              :disabled="busy === 'complete'"
              loading-label="Завершаю задачу"
              @click="complete"
            >
              ✓ Завершить
            </UiButton>
          </div>
          <!-- Обычный запуск показывает только человеческое решение. Immutable-техника
               видна кратко и раскрывается отдельно для редкой ручной корректировки. -->
          <div v-if="launchForm" class="lform">
            <div v-if="launchOpts.profiles?.length > 1" class="lrow">
              <label class="llbl" for="launch-profile">Профиль</label>
              <UiSelect
                id="launch-profile"
                v-model="launchForm.profile"
                data-context="task-launch"
                compact
                :disabled="launchOptionsBusy || busy === 'launch'"
                @change="changeLaunchProfile"
              >
                <option v-for="p in launchOpts.profiles" :key="p" :value="p">{{ p }}</option>
              </UiSelect>
              <span v-if="launchOptionsBusy" class="lhint">
                <UiSpinner decorative /> читаю каталог…
              </span>
            </div>
            <div class="lrow">
              <label class="llbl" for="launch-route">Маршрут</label>
              <UiSelect
                id="launch-route"
                v-model="launchForm.route"
                data-context="task-launch"
                compact
                :disabled="launchOptionsBusy || busy === 'launch'"
                @change="changeLaunchRoute"
              >
                <option
                  v-for="r in launchOpts.routes"
                  :key="r"
                  :value="r"
                  :title="launchOpts.routeOptions?.[r]?.title || ''"
                >{{ r }}</option>
              </UiSelect>
              <span v-if="launchRouteIsSuggested" class="lhint suggested">
                рекомендован триажем<template v-if="routeDepthLabel"> · {{ routeDepthLabel }}</template>
              </span>
              <!-- Человек ушёл с рекомендованного маршрута: основание относится к ней, а не к
                   выбранному, поэтому текстом его больше не показываем — только подсказкой. -->
              <span
                v-else-if="routeSuggestion"
                class="lhint"
                :title="routeSuggestionReason"
              >триаж предлагает: {{ routeSuggestion }}</span>
              <span v-if="launchRouteIsSuggested && routeSuggestionReason" class="lhint lreason">
                почему: {{ routeSuggestionReason }}
              </span>
            </div>
            <div v-if="launchOpts.runners?.length" class="lrow">
              <label class="llbl" for="launch-runner">Исполнитель</label>
              <UiSelect
                id="launch-runner"
                v-model="launchForm.runner"
                data-context="task-launch"
                compact
                :disabled="launchOptionsBusy || busy === 'launch'"
              >
                <option value="">Из профиля<template v-if="launchOpts.defaultRunner"> ({{ providerLabel(launchOpts.defaultRunner) }})</template></option>
                <option v-for="r in launchOpts.runners" :key="r" :value="r">{{ providerLabel(r) }}</option>
              </UiSelect>
            </div>

            <div class="lsummary" aria-label="Параметры запуска">
              <div class="lsummary-row">
                <span>Профиль</span>
                <b class="mono">{{ launchForm.profile }}</b>
              </div>
              <div v-if="launchNeedsDelivery" class="lsummary-row">
                <span>SHIP</span>
                <b class="mono">{{ launchDeliverySummary }}</b>
              </div>
              <div v-if="launchNeedsInstrumentation" class="lsummary-row">
                <span>Диагностика</span>
                <b>{{ launchDiagnosisSummary }} · {{ launchInstrumentationSummary }}</b>
              </div>
              <p v-if="launchNeedsDelivery" class="lshipwarn">
                После финальных одобренных ворот маршрут сделает commit, push и PR.
              </p>
            </div>

            <label class="llbl">Критерии приёмки <span class="lopt">— это и есть объём задачи</span></label>
            <UiTextarea
              v-model="launchForm.criteria"
              data-role="task-launch-note"
              rows="3"
              placeholder="Например: экспорт не падает на выборке 10 000 строк&#10;в отчёте появилась колонка «Менеджер»"
            />
            <p class="lnote">
              По строке на каждый пункт постановки. Конвейер не имеет права сузить этот список сам:
              пункт, которого здесь нет, он выполнит по постановке как есть или остановится с вопросом.
            </p>
            <div
              v-if="launchOpts?.scopeSuggestion?.skip?.length"
              class="lnote lscope-skip"
              data-role="task-launch-scope-skip"
            >
              <span class="lscope-skip-title">Триаж предлагает НЕ делать:</span>
              <ul>
                <li v-for="line in launchOpts.scopeSuggestion.skip" :key="line">{{ line }}</li>
              </ul>
              <span>Не согласен — допиши пункт в критерии выше.</span>
            </div>

            <details v-if="launchNeedsDelivery || launchNeedsInstrumentation" class="ladvanced">
              <summary>Дополнительные параметры</summary>
              <div class="ladvanced-body">
                <template v-if="launchNeedsDelivery">
                  <label class="llbl">Целевые ветки из конфигурации профиля</label>
                  <div v-for="repo in launchOpts.repositories" :key="repo.name" class="lrepo">
                    <span class="mono">{{ repo.name }}</span>
                    <code class="mono">{{ repo.targetBranch }}</code>
                  </div>
                </template>
                <template v-if="launchNeedsInstrumentation">
                  <label class="llbl" for="launch-instrumentation">
                    Точный scope <span class="lopt">— по одному repo:relative/path на строку</span>
                  </label>
                  <UiTextarea
                    id="launch-instrumentation"
                    v-model="launchForm.instrumentationFiles"
                    class="mono"
                    data-role="task-launch-note"
                    rows="3"
                    spellcheck="false"
                    placeholder="service:src/path/file.ext"
                  />
                  <div class="lrow">
                    <label class="llbl" for="launch-diagnosis-kind">Тип диагноза</label>
                    <UiSelect
                      id="launch-diagnosis-kind"
                      v-model="launchForm.diagnosisKind"
                      data-context="task-launch"
                      compact
                    >
                      <option value="functional">functional</option>
                      <option value="performance">performance</option>
                      <option value="data">data</option>
                      <option value="integration">integration</option>
                    </UiSelect>
                  </div>
                  <label class="llbl" for="launch-diagnosis-signal">Наблюдаемый сигнал</label>
                  <UiInput
                    id="launch-diagnosis-signal"
                    v-model="launchForm.diagnosisSignal"
                    data-context="task-launch"
                    maxlength="200"
                    autocomplete="off"
                    placeholder="Коротко: что именно воспроизводится"
                  />
                  <p class="lnote">
                    Scope закрепляется на всю попытку; временные probes разрешены только в этих файлах.
                  </p>
                </template>
              </div>
            </details>
            <p v-if="launchValidationError" class="lerror">{{ launchValidationError }}</p>
            <div class="lbtns">
              <UiButton :disabled="!!busy" @click="launchForm = null">
                Отмена
              </UiButton>
              <UiButton
                data-role="task-launch-submit"
                tone="accent"
                variant="solid"
                aria-label="Запустить задачу"
                :loading="busy === 'launch'"
                :disabled="!!busy || launchOptionsBusy || !!launchOpts.error || !!launchValidationError"
                loading-label="Запускаю задачу"
                @click="launchSelected"
              >
                🏭 Запустить
              </UiButton>
            </div>
          </div>
          <div v-if="conveyor?.stall" class="convstall">
            <b>{{ conveyor.stall.title }}</b>
            <span>{{ conveyor.stall.hint }}</span>
          </div>
          <span v-if="launchMsg" class="lmsg" aria-live="polite">{{ launchMsg }}</span>
          <span v-if="sandboxMsg" class="lmsg">{{ sandboxMsg }}</span>
      </footer>
  </UiDialog>
</template>

<script setup>
import { ref, computed, watch, onUnmounted } from 'vue';
import { storeToRefs } from 'pinia';
import { useRouter } from 'vue-router';
import { api } from '../shared/apiClient.ts';
import { useUiContextSource } from '../composables/useUiContextSource.ts';
import {
  confirmDialog,
  UiButton,
  UiChoiceList,
  UiDialog,
  UiDisclosureButton,
  UiField,
  UiFilePicker,
  UiFormActions,
  UiIconButton,
  UiInput,
  UiSelect,
  UiSpinner,
  UiTab,
  UiTabs,
  UiTextarea,
  UiTooltip,
} from '../ui';
import { useUiStore } from '../stores/ui.js';
import { useTasksStore } from '../stores/tasks.js';
import { useBoardStore } from '../stores/board.js';
import { analyzeTask, readAnalysisDetail, useAnalysisStore } from '../actions/analysis';
import { analysisApi } from '../shared/analysisApi.ts';
import { questionKey } from '../../../shared/analysisContracts.ts';
import { useTaskFavoritesStore } from '../stores/task-favorites.js';
import { useTaskShelfStore } from '../stores/taskShelf.ts';
import { usePluginsStore } from '../stores/plugins.js';
import { useTaskSeenStore } from '../stores/task-seen.js';
import { useDictationController } from '../features/speech/provider.js';
import { liveTimerSec, mmss, secToHMS } from '../shared/format.ts';
import { mdToHtml } from '../shared/md.ts';
import { providerLabel } from '../shared/runnerDisplay.ts';
import OpenDiffButton from './OpenDiffButton.vue';
import TaskFavoriteButton from './board/TaskFavoriteButton.vue';

const router = useRouter();

const ui = useUiStore();
const tasks = useTasksStore();
const board = useBoardStore();
const favorites = useTaskFavoritesStore();
const shelf = useTaskShelfStore();
const plugins = usePluginsStore();
const seen = useTaskSeenStore();
const { taskId } = storeToRefs(ui);

const detail = ref(null);
const loading = ref(false);
const busy = ref(null);   // какое действие выполняется
const err = ref(null);
const commentText = ref('');
const now = ref(Date.now());

let ticker = null;

// Таймер задачи — из кеша доски (там timerRunning/elapsed/startedAt).
const boardTask = computed(() => {
  const d = board.data; if (!d || !taskId.value) return null;
  const id = Number(taskId.value);
  for (const list of [d.tasks, d.toReview, d.created, d.accomplice, d.auditor]) {
    const t = (list || []).find((x) => x.id === id);
    if (t) return t;
  }
  return null;
});
const taskContext = useUiContextSource('task', { layer: 'overlay', active: false });
function taskContextDetails(id) {
  const title = detail.value?.title || boardTask.value?.title || '';
  return { taskId: String(id), ...(title ? { title } : {}) };
}
const running = computed(() => !!boardTask.value?.timerRunning);
const elapsed = computed(() => (boardTask.value ? liveTimerSec(boardTask.value, now.value) : null));
const shelfEnabled = computed(() => plugins.enabled('shelf'));
const taskProject = computed(() => detail.value?.group_name || boardTask.value?.group || '');
const taskResponsible = computed(() => detail.value?.responsible?.name || boardTask.value?.responsible || '');

// B24 отдаёт описание с HTML/entities — чистим до читаемого текста.
function htmlToText(s) {
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
function linkify(s) {
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return esc(s || '').replace(/(https?:\/\/[^\s&]+(?:&amp;[^\s&]+)*)/g,
    (u) => `<a href="${u.replace(/&amp;/g, '&')}" target="_blank" rel="noopener">${u}</a>`);
}
const descHtml = computed(() => linkify(cleanDesc.value));

// ── Редактирование основных полей задачи в Битрикс24 ──
const editForm = ref(null);
const editBaseline = ref(null);
const editUsers = ref([]);
const editGroups = ref([]);
const editOptionsBusy = ref(false);
const editOptionsError = ref(null);
const editMessage = ref(null);
let editOptionsRequest = 0;

/**
 * Делает редактируемый снимок из DTO портала. Описание становится обычным текстом,
 * но уйдёт обратно только после фактического изменения человеком.
 */
function taskEditSnapshot(task) {
  const responsibleId = task?.responsible?.id ?? boardTask.value?.responsibleId ?? '';
  const groupId = Number(task?.group_id);
  const priority = Number(task?.priority);

  return {
    title: String(task?.title || ''),
    description: htmlToText(task?.description),
    responsibleId: responsibleId ? String(responsibleId) : '',
    groupId: Number.isSafeInteger(groupId) && groupId > 0 ? String(groupId) : '',
    priority: [0, 1, 2].includes(priority) ? priority : 1,
  };
}

/**
 * Оставляет текущее значение доступным, даже если сотрудник или проект уже исчез
 * из активного справочника портала. Без fallback открытие формы само меняло бы select.
 */
function optionsWithCurrent(items, id, name, fallback) {
  if (!id || items.some((item) => String(item.id) === String(id))) return items;

  return [{ id: Number(id), name: name || `${fallback} #${id}` }, ...items];
}

const editResponsibleOptions = computed(() => optionsWithCurrent(
  editUsers.value,
  editForm.value?.responsibleId,
  detail.value?.responsible?.name,
  'Исполнитель',
));
const editGroupOptions = computed(() => optionsWithCurrent(
  editGroups.value,
  editForm.value?.groupId,
  detail.value?.group_name || boardTask.value?.group,
  'Проект',
));

/**
 * Собирает только изменённые поля. Это защищает нетронутое HTML-описание и уменьшает
 * окно, в котором правка из Cockpit может затереть параллельную правку в портале.
 */
function taskEditPayload() {
  const form = editForm.value;
  const baseline = editBaseline.value;
  if (!form || !baseline) return {};

  const fields = {};
  const title = form.title.trim();
  if (title !== baseline.title) fields.title = title;
  if (form.description !== baseline.description) fields.description = form.description;
  if (form.groupId !== baseline.groupId) {
    fields.groupId = form.groupId ? Number(form.groupId) : null;
  }
  if (form.responsibleId !== baseline.responsibleId) {
    fields.responsibleId = Number(form.responsibleId);
  }
  if (Number(form.priority) !== Number(baseline.priority)) {
    fields.priority = Number(form.priority);
  }
  return fields;
}

const editCanSave = computed(() => (
  Boolean(editForm.value?.title.trim())
  && busy.value !== 'edit'
  && Object.keys(taskEditPayload()).length > 0
));

/**
 * Загружает оба портальных справочника независимо. Сбой одного не закрывает форму:
 * заголовок, описание и уже известные значения всё равно можно сохранить.
 */
async function loadEditOptions() {
  if (!editForm.value) return;

  const requestId = ++editOptionsRequest;
  editOptionsBusy.value = true;
  editOptionsError.value = null;
  const [users, groups] = await Promise.allSettled([
    api.get('/api/b24/users'),
    api.get('/api/b24/groups'),
  ]);
  if (requestId !== editOptionsRequest || !editForm.value) return;

  const failures = [];
  if (users.status === 'fulfilled') {
    editUsers.value = Array.isArray(users.value?.users) ? users.value.users : [];
  } else {
    failures.push('исполнителей');
  }
  if (groups.status === 'fulfilled') {
    editGroups.value = Array.isArray(groups.value?.groups) ? groups.value.groups : [];
  } else {
    failures.push('проекты');
  }
  editOptionsError.value = failures.length
    ? `Не удалось загрузить: ${failures.join(' и ')}`
    : null;
  editOptionsBusy.value = false;
}

/** Открывает форму на точном снимке показанной карточки и начинает загрузку справочников. */
function openTaskEdit() {
  if (!detail.value || editForm.value) return;

  const snapshot = taskEditSnapshot(detail.value);
  editBaseline.value = snapshot;
  editForm.value = { ...snapshot };
  editMessage.value = null;
  editOptionsError.value = null;
  loadEditOptions();
}

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
  if (!editCanSave.value || !taskId.value) return;

  const id = String(taskId.value);
  const fields = taskEditPayload();
  await act('edit', async () => {
    const updated = await tasks.update(id, fields);
    if (String(taskId.value) !== id) return;

    detail.value = updated;
    cancelTaskEdit();
    editMessage.value = 'Изменения сохранены в Битрикс24.';
    if ((Object.hasOwn(fields, 'title') || Object.hasOwn(fields, 'description'))
        && triage.value?.analysis) {
      editMessage.value += ' Триаж основан на прежней постановке — запустите переоценку.';
    }
  });
}

// ── Обсуждение в Telegram: что стоит за ссылками t.me из описания ──
// Поле `telegram` приходит от GET /api/b24/task/:id (сервер уже применил
// allowlist и лимиты). Тело задачи оно не трогает — это отдельный блок.
// Текст цитат — из чужого чата, поэтому только интерполяция: никакого v-html,
// как у описания. Отказ показываем ровно так, как прислал сервер: у него нет
// ни цитат, ни имени чата, и придумывать их за него нельзя.
const tgLinks = computed(() => detail.value?.telegram?.links || []);

function tgTime(sec) {
  if (!sec) return '';
  return new Date(sec * 1000).toLocaleString('ru-RU',
    { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
// «ещё 1 сообщение / 3 сообщения / 5 сообщений» — общего хелпера склонения
// во фронте нет, а хвост без согласования читается как опечатка.
function tgPlural(n) {
  const teen = n % 100;
  if (teen >= 11 && teen <= 14) return 'сообщений';
  const one = n % 10;
  if (one === 1) return 'сообщение';
  if (one >= 2 && one <= 4) return 'сообщения';
  return 'сообщений';
}

async function loadDetail(force = false) {
  if (!taskId.value) return;
  loading.value = true; err.value = null;
  try { detail.value = await tasks.load(taskId.value, force); }
  catch (e) { err.value = e.message; }
  finally { loading.value = false; }
}

// ── Триаж: оценка сложности/рисков разведкой кода (без стенда) ──
const analysisStore = useAnalysisStore();
const triage = ref(null);        // ответ /api/analysis/:id
const showNote = ref(false);     // разведнота развёрнута
const showClarifyHistory = ref(false);
const showAnalysisDetails = ref(false);
let triageTimer = null;
const analysisManifest = computed(() => plugins.byId('analysis'));
// Старый сервер ещё не отдаёт manifest триажа: до ручного рестарта считаем его включённым.
const analysisEnabled = computed(() => analysisManifest.value?.enabled !== false);
const triageState = computed(() => triage.value?.status?.state || null);
const triageBusy = computed(() => triageState.value === 'queued' || triageState.value === 'running');
const noteHtml = computed(() => (triage.value?.note ? mdToHtml(triage.value.note) : ''));

const TRIAGE_WORK_LABELS = {
  feature: 'Новая функциональность',
  debug: 'Исправление ошибки',
  perf: 'Оптимизация',
  hunt: 'Поиск дефектов',
};
const CONFIDENCE_LABELS = {
  high: 'Высокая',
  medium: 'Средняя',
  low: 'Низкая',
};
const triageWorkLabel = computed(() => {
  const kind = triage.value?.analysis?.route_guess;

  return TRIAGE_WORK_LABELS[kind] || kind || 'Тип работы не указан';
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
      label: 'Сложность',
      value: triageScore(value.complexity),
      tone: value.complexity >= 4 ? 'warning' : 'neutral',
    },
    {
      id: 'risk',
      label: 'Риск',
      value: triageScore(value.risk),
      tone: value.risk >= 4 ? 'danger' : value.risk === 3 ? 'warning' : 'neutral',
    },
    {
      id: 'diff',
      label: 'Объём правок',
      value: value.diff_size || '—',
      tone: 'neutral',
    },
    {
      id: 'confidence',
      label: 'Уверенность',
      value: CONFIDENCE_LABELS[value.confidence] || 'Не указана',
      tone: value.confidence === 'low' ? 'warning' : 'neutral',
    },
  ];
});

function triageScore(value) {
  const score = Number(value);

  return Number.isInteger(score) && score >= 1 && score <= 5 ? `${score}/5` : '—';
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
    return 'уточнения сохраняются…';
  }
  const again = Boolean(triage.value?.analysis);
  if (triageState.value === 'running') {
    return again ? 'переоценка идёт…' : 'разведка идёт…';
  }

  return again ? 'переоценка в очереди…' : 'в очереди…';
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

function normalizeTriageQuestions(values) {
  return (Array.isArray(values) ? values : []).map((raw, index) => {
    const text = typeof raw === 'string' ? raw.trim() : String(raw?.text || '').trim();
    const id = typeof raw === 'object' && raw?.id
      ? String(raw.id)
      : `legacy-${index}-${text.slice(0, 40)}`;
    return {
      id,
      text,
      options: (Array.isArray(raw?.options) ? raw.options : []).map((option, optionIndex) => ({
        id: String(option?.id || `legacy-option-${optionIndex}`),
        label: String(option?.label || option || ''),
        description: String(option?.description || ''),
      })).filter((option) => option.label),
      recommendation: raw?.recommendation || null,
    };
  }).filter((question) => question.text);
}

const triageQuestions = computed(() => normalizeTriageQuestions(triage.value?.analysis?.questions));
const clarifyDrafts = ref({});
const clarifyEntries = ref([]);
const clarifyComposerOpen = ref({});
const activeQuestionId = ref(null);

function syncClarifyDrafts() {
  const next = {};
  const nextComposerOpen = {};
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
  if (!next[activeQuestionId.value]) {
    activeQuestionId.value = triageQuestions.value[0]?.id || null;
  }
}

function draftFor(questionId) {
  return clarifyDrafts.value[questionId] || { text: '', optionIds: [], attachments: [] };
}

// Ответ ищем и по идентификатору вопроса, и по смыслу его текста: следующий заход
// триажа переписывает вопросы заново, и по одному id уже данный ответ пропадал из
// карточки — человек отвечал второй раз на то же самое.
function answerFor(question) {
  const key = questionKey(question.text);
  for (let index = clarifyEntries.value.length - 1; index >= 0; index -= 1) {
    const entry = clarifyEntries.value[index];
    if (entry.questionId === question.id || (key && questionKey(entry.questionText) === key)) {
      return entry;
    }
  }
  return null;
}

function clarifyOptions(question) {
  return question.options.map((option) => ({
    value: option.id,
    label: option.label,
    description: option.description || undefined,
  }));
}

function selectedClarifyOption(questionId) {
  return draftFor(questionId).optionIds[0] || null;
}

function recommendationOption(question) {
  const option = String(question.recommendation?.option || '').trim();
  return question.options.find((candidate) => candidate.id === option)?.label || option;
}

function composerOpenFor(question) {
  return question.options.length === 0 || clarifyComposerOpen.value[question.id] === true;
}

function setComposerOpen(questionId, open) {
  clarifyComposerOpen.value[questionId] = open;
}

async function loadTriage() {
  if (!taskId.value || !analysisEnabled.value) return;
  try {
    triage.value = await readAnalysisDetail(taskId.value);
    syncClarifyDrafts();
  } catch { /* блок триажа не ломает модалку */ }
  // Пока идёт — подтягиваем статус; закончилось — останавливаемся.
  if (triageBusy.value && !triageTimer) {
    triageTimer = setInterval(loadTriage, 6000);
  } else if (!triageBusy.value && triageTimer) {
    clearInterval(triageTimer); triageTimer = null;
  }
}
const analyzeNow = () => act('analyze', async () => {
  if (!analysisEnabled.value) return;
  await analyzeTask(taskId.value);
  await loadTriage();
});

const clarifyUploading = ref(false);
async function onClarifyFiles(questionId, files) {
  await uploadClarifyFiles(questionId, files);
}
function dropClarifyAtt(questionId, file) {
  const draft = draftFor(questionId);
  draft.attachments = draft.attachments.filter((attachment) => attachment.file !== file);
}
// Скрин из буфера обмена (Ctrl+V прямо в поле) и перетаскивание файлов — как в чате.
async function uploadClarifyFiles(questionId, files) {
  if (!files.length) return;
  clarifyUploading.value = true;
  try {
    for (const f of files) {
      const fd = new FormData();
      fd.append('file', f, f.name || 'clipboard.png');
      draftFor(questionId).attachments.push(await api.upload('/api/chat/upload', fd));
    }
  } catch (e2) { err.value = e2.message; }
  finally { clarifyUploading.value = false; }
}
function onClarifyPaste(questionId, e) {
  const files = [...(e.clipboardData?.items || [])]
    .filter((i) => i.kind === 'file' && i.type.startsWith('image/'))
    .map((i) => i.getAsFile()).filter(Boolean);
  if (files.length) { e.preventDefault(); uploadClarifyFiles(questionId, files); }
}
// Сохраняются ЛОКАЛЬНО (t<id>.clarify.md), НЕ комментарием в B24: комментарии
// видит заказчик, а рабочие пояснения — внутренняя кухня. Их читают триаж и конвейер.
const clarifySaved = ref('');
async function loadClarifications() {
  try {
    const response = await analysisApi.clarifications(taskId.value);
    clarifySaved.value = response.text || '';
    clarifyEntries.value = response.entries || [];
  } catch {
    clarifySaved.value = '';
    clarifyEntries.value = [];
  }
}
const hasClarifyAnswers = computed(() => triageQuestions.value.some((question) => {
  const draft = draftFor(question.id);
  return draft.text.trim() || draft.optionIds.length || draft.attachments.length;
}));

function selectClarifyOption(questionId, optionId) {
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
          ? `[приложено фото: ${attachment.path}]`
          : '')
        .filter(Boolean),
    ].filter(Boolean).join('\n');
  }).filter(Boolean).join('\n\n');
  const r = await analysisApi.answer(taskId.value, answers, legacyText);
  clarifySaved.value = r.text || '';
  clarifyEntries.value = r.entries || clarifyEntries.value;
  clarifyDrafts.value = {};
  syncClarifyDrafts();
  await analyzeTask(taskId.value);
  await loadTriage();
});

const arbitrateQuestions = () => act('arbitrate', async () => {
  await analysisApi.arbitrate(taskId.value);
  await Promise.all([loadClarifications(), loadTriage()]);
});

const dictationController = useDictationController();
const dictationLease = dictationController.acquire('task-modal-analysis', {
  onCommit(text) {
    const questionId = activeQuestionId.value;
    if (!questionId || !clarifyDrafts.value[questionId]) return;
    const current = clarifyDrafts.value[questionId].text.trimEnd();
    clarifyDrafts.value[questionId].text = current ? `${current} ${text}` : String(text || '');
  },
});

async function startClarifyDictation(questionId) {
  if (activeQuestionId.value && activeQuestionId.value !== questionId) {
    await dictationLease.cancel();
  }
  activeQuestionId.value = questionId;
  try {
    await dictationLease.start();
  } catch (error) {
    err.value = error?.message || 'Микрофон недоступен';
  }
}

// ── Табы модалки: Триаж | Комментарии ──
const mtab = ref('triage');
const comments = ref(null);    // null = ещё не загружали
const comLoading = ref(false);
async function loadComments() {
  comLoading.value = true;
  try { comments.value = (await api.get(`/api/b24/task/${taskId.value}/comments`)).comments || []; }
  catch { comments.value = []; }
  finally { comLoading.value = false; }
}
watch(mtab, (t) => { if (t === 'comments' && comments.value === null) loadComments(); });

// Уже ли задача на конвейере (есть в состоянии фабрики) — для защиты от повторного запуска.
const conveyor = ref(null);
// Живой стенд задачи ({fePort, apiPort}) — чтобы снести его прямо отсюда.
const sandbox = ref(null);
async function loadConveyor() {
  conveyor.value = null; sandbox.value = null;
  if (!taskId.value) return;
  try {
    const { tasks: list } = await api.get('/api/tasks');
    conveyor.value = (list || []).find((t) => String(t.task) === String(taskId.value)) || null;
  } catch { /* нет данных фабрики — не блокируем */ }
  if (!conveyor.value) return;
  // Порты стенда лежат не в списке задач, а в графе — тянем только для задач конвейера.
  // Общий стенд и исторический реестр принадлежат не этой карточке: их lifecycle
  // интерфейс не трогает.
  try {
    const g = await api.get(`/api/tasks/${taskId.value}/graph`);
    if (g?.fePort && !g.readOnly && g.workspaceMode !== 'shared') {
      sandbox.value = { fePort: g.fePort, apiPort: g.apiPort || null };
    }
  } catch { /* графа нет — кнопку сноса просто не покажем */ }
}
function openConveyor() { ui.close(); router.push('/pipeline'); }

// Снести стенд, не уходя в конвейер: стенд убирают из карточки, и возвращаться
// на страницу конвейера ради одной кнопки незачем. Снос идёт до пары минут
// (docker + схемы БД) — кнопка на это время становится индикатором.
// После сноса перечитываем состояние: сервер уносит реестр задачи в архив, то есть
// задача уходит и с конвейера — иначе в карточке осталась бы кнопка «Уже на конвейере».
const sandboxBusy = ref(false);
const sandboxMsg = ref(null);
async function sandboxDown() {
  if (sandboxBusy.value) return;
  if (!(await confirmDialog(
    `Снести стенд задачи #${taskId.value}? Текущий прогон уйдёт в архив, после чего задачу можно будет отправить на конвейер заново. Ветка и незакоммиченные изменения сохранятся.`,
    { danger: true, okText: 'Снести' },
  ))) return;
  sandboxBusy.value = true; err.value = null; sandboxMsg.value = null;
  try {
    await api.post(`/api/tasks/${taskId.value}/sandbox/down`);
    await loadConveyor();
    sandboxMsg.value = 'Стенд снесён, прогон перенесён в архив';
  } catch (e) {
    err.value = e.status === 501
      ? 'Снос стенда не настроен: нет COCKPIT_SANDBOX_DOWN_CMD и down.sh у профиля.'
      : e.message;
  } finally { sandboxBusy.value = false; }
}

async function act(name, fn) {
  busy.value = name; err.value = null;
  try { await fn(); }
  catch (e) { err.value = e.message; }
  finally { busy.value = null; }
}
const toggleTimer = () => act('timer', () => tasks.timer(taskId.value, running.value ? 'pause' : 'start'));
const complete = async () => { if (await confirmDialog('Завершить задачу?', { okText: 'Завершить' })) act('complete', async () => { await tasks.complete(taskId.value); ui.close(); }); };
const launchMsg = ref(null);

// ── Запуск на конвейер ──
// Маршрут и критерии задаёт человек. Технические immutable-входы route engine форма
// тоже показывает явно: целевые ветки для ship и exact instrumentation scope для debug.
// Критерии предзаполняются объёмом из триажа (`scope.do` — по пункту на каждый пункт
// постановки): человек видит и правит объём ДО конвейера. Пустые критерии допустимы, но
// тогда узлы маршрута читают пункты постановки как есть; переводчик формулирует критерии
// только у маршрутов с планом. Выдумывать их за человека нельзя — отказ на приёмке
// откатывает маршрут на сборку со сбросом всего хвоста.
const launchForm = ref(null);   // форма открыта
const launchOpts = ref(null);   // ответ /launch-options
const launchOptionsBusy = ref(false);
const DIAGNOSIS_LABELS = {
  functional: 'поведение',
  performance: 'производительность',
  data: 'данные',
  integration: 'интеграция',
};
let launchOptionsRequest = 0;
// Рекомендацию маршрута считает сервер: только он знает, из этого ли каталога пришла
// оценка и остался ли предложенный маршрут опубликованным. Клиент её не пересчитывает.
function preferredLaunchRoute(opts) {
  return opts.routeSuggestion?.route || opts.defaultRoute;
}
// Объём из триажа — подсказка формы, а не решение: пустое поле заполняется им один раз
// при открытии, а введённое человеком (в т.ч. стёртое до пустоты при смене профиля)
// не перезаписывается.
function suggestedCriteria(opts) {
  return (opts.scopeSuggestion?.criteria || []).join('\n');
}
function makeLaunchForm(opts, criteria = null) {
  const route = preferredLaunchRoute(opts);
  const needsInstrumentation = opts.routeOptions?.[route]?.instrumentationRequired;
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
async function openLaunch() {
  if (conveyor.value) { launchMsg.value = 'Уже на конвейере'; return; }
  if (launchOptionsBusy.value) return;
  err.value = null; launchMsg.value = null;
  const requestId = ++launchOptionsRequest;
  let opts = null;
  launchOptionsBusy.value = true;
  try { opts = await tasks.launchOptions(taskId.value); }
  catch (e) {
    if (requestId === launchOptionsRequest) err.value = `Не удалось узнать параметры запуска: ${e.message}`;
    return;
  } finally {
    if (requestId === launchOptionsRequest) launchOptionsBusy.value = false;
  }
  if (requestId !== launchOptionsRequest) return;
  launchOpts.value = opts;

  // Если каталог выбранного по умолчанию профиля недоступен, при нескольких профилях
  // оставляем форму открытой: человек может выбрать другой опубликованный каталог.
  const profiles = opts.profiles?.length ? opts.profiles : [opts.profile];
  if (opts.error && profiles.length === 1) {
    err.value = opts.message || 'маршрут сейчас нельзя запустить';
    return;
  }
  // Триаж уже прикинул маршрут — показываем это подсказкой рядом, но выбирает человек.
  launchForm.value = makeLaunchForm(opts);
  if (opts.error) err.value = opts.message || 'выбранный профиль сейчас нельзя запустить';
  return undefined;
}
async function changeLaunchProfile() {
  const profile = launchForm.value?.profile;
  if (!profile || launchOptionsBusy.value) return;
  const previousProfile = launchOpts.value?.profile;
  const requestId = ++launchOptionsRequest;
  const criteria = launchForm.value.criteria;
  launchOptionsBusy.value = true;
  err.value = null;
  try {
    const opts = await tasks.launchOptions(taskId.value, profile);
    if (requestId !== launchOptionsRequest || !launchForm.value) return;
    launchOpts.value = opts;
    launchForm.value = makeLaunchForm(opts, criteria);
    if (opts.error) err.value = opts.message || 'выбранный профиль сейчас нельзя запустить';
  } catch (e) {
    if (requestId === launchOptionsRequest) {
      if (launchForm.value && previousProfile) launchForm.value.profile = previousProfile;
      err.value = `Не удалось выбрать профиль: ${e.message}`;
    }
  } finally {
    if (requestId === launchOptionsRequest) launchOptionsBusy.value = false;
  }
}
// Глубина — вторая половина рекомендации: человек видит не только «какой маршрут»,
// но и «насколько короткий», а рядом — по каким числам оценки это вышло.
const DEPTH_LABELS = { light: 'лёгкий', mid: 'средний', full: 'полный' };
const triageDepthLabel = computed(() => DEPTH_LABELS[triage.value?.analysis?.route_depth] || '');
// Кнопка называет маршрут, который откроется уже выбранным: путь от оценки триажа до
// запуска — один клик, и человек заранее знает, с чем согласится.
const launchOpenHint = computed(() => {
  const route = triage.value?.analysis?.route_guess;
  const depth = triageDepthLabel.value;
  return route
    ? `Открыть параметры запуска: триаж предлагает «${route}»${depth ? ` (${depth} маршрут)` : ''}`
    : 'Открыть параметры запуска фабрики по задаче';
});
const routeSuggestion = computed(() => launchOpts.value?.routeSuggestion?.route || null);
const routeSuggestionReason = computed(() => launchOpts.value?.routeSuggestion?.reason || '');
const routeDepthLabel = computed(() => (
  DEPTH_LABELS[launchOpts.value?.routeSuggestion?.depth] || ''
));
const launchRouteOption = computed(() => (
  launchOpts.value?.routeOptions?.[launchForm.value?.route] || null
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
  if (!first) return 'scope не определён';
  const short = first.split('/').pop();
  return rest.length ? `${short} + ещё ${rest.length}` : short;
});
const launchDiagnosisSummary = computed(() => (
  DIAGNOSIS_LABELS[launchForm.value?.diagnosisKind] || launchForm.value?.diagnosisKind || 'поведение'
));
const launchValidationError = computed(() => {
  if (loading.value || !detail.value) return 'Постановка задачи ещё загружается.';
  if (!launchForm.value?.route) return 'Выбери маршрут.';
  if (!launchRouteOption.value?.deliveryMode) return 'Каталог не отдал delivery contract маршрута.';
  if (launchOpts.value?.profileContractError) return launchOpts.value.profileContractError;
  if (launchNeedsDelivery.value) {
    if (!launchOpts.value?.repositories?.length) return 'Профиль не объявил репозитории для SHIP.';
    const missing = launchOpts.value.repositories
      .filter((repo) => !repo.targetBranch?.trim())
      .map((repo) => repo.name);
    if (missing.length) return `Профиль не настроил целевые ветки: ${missing.join(', ')}.`;
  }
  if (launchNeedsInstrumentation.value && !launchForm.value.instrumentationFiles.trim()) {
    return 'Маршрут требует хотя бы один файл инструментации.';
  }
  return null;
});
function changeLaunchRoute() {
  if (!launchForm.value || !launchNeedsInstrumentation.value
      || launchForm.value.instrumentationFiles.trim()) return;
  launchForm.value.instrumentationFiles = (launchOpts.value?.instrumentationSuggestions || [])
    .slice(0, 1).join('\n');
}
function launchErrorText(e) {
  const code = e?.data?.error;
  const known = {
    catalog_changed: 'Каталог маршрутов изменился. Перечитай параметры и поставь задачу заново.',
    run_exists: 'У задачи уже есть незакрытый прогон. Продолжи или закрой его на странице конвейера.',
  };
  return known[code] || e?.data?.message || e?.message || 'Не удалось запустить задачу.';
}
async function doLaunch(payload) {
  if (busy.value) return;
  busy.value = 'launch';
  err.value = null;
  try {
    const r = await tasks.launch(taskId.value, payload);
    launchForm.value = null;
    launchMsg.value = r.outcome === 'already_running' ? 'Уже идёт на конвейере'
      : r.outcome === 'launched' ? `Запущено (профиль ${r.profile}${r.route ? `, маршрут ${r.route}` : ''}${r.attempt ? `, попытка ${r.attempt.slice(0, 10)}…` : ''})`
      : r.note || 'Отправлено';
    await loadConveyor();
  } catch (e) {
    err.value = launchErrorText(e);
  } finally {
    busy.value = null;
  }
}
function launchPayload() {
  const instrumentationFiles = launchNeedsInstrumentation.value
    ? launchForm.value.instrumentationFiles.split('\n').map((s) => s.trim()).filter(Boolean)
    : [];
  return {
    profile: launchForm.value.profile,
    route: launchForm.value.route,
    title: detail.value?.title || '',
    description: cleanDesc.value || '',
    // По строке на критерий: пустые строки отбрасывает сборка тикета.
    acceptanceCriteria: launchForm.value.criteria.split('\n').map((s) => s.trim()).filter(Boolean),
    instrumentationFiles,
    diagnosisKind: launchNeedsInstrumentation.value ? launchForm.value.diagnosisKind : '',
    diagnosisSignal: launchNeedsInstrumentation.value
      ? launchForm.value.diagnosisSignal.trim()
      : '',
    // Исполнитель — только при явном выборе: пустое значение значит «по профилю»,
    // и сервер не должен получать лишний ключ.
    ...(launchForm.value.runner ? { runnerPrimary: launchForm.value.runner } : {}),
    // Старт pin-ит тот каталог, который человек видел в форме: между её открытием и
    // запуском профиль мог опубликовать новый, и молча уехать по нему нельзя.
    ...(launchOpts.value?.catalogHash
      ? { expectedCatalogHash: launchOpts.value.catalogHash }
      : {}),
  };
}
const launchSelected = () => {
  if (launchValidationError.value) return;
  return doLaunch(launchPayload());
};
const sendComment = () => act('comment', async () => {
  await tasks.comment(taskId.value, commentText.value);
  commentText.value = '';
  loadComments();
});
const refresh = () => { loadDetail(true); board.load(true); };
const toggleFavorite = () => favorites.toggle(taskId.value);
const toggleShelf = () => shelf.toggle(taskId.value);
let acknowledgedShelfTask = '';
function acknowledgeShelfOnOpen(id = taskId.value) {
  const key = String(id || '');
  if (!key || !shelfEnabled.value || !shelf.loaded || !shelf.isOnShelf(key)
    || acknowledgedShelfTask === key) return;
  acknowledgedShelfTask = key;
  void Promise.resolve(shelf.acknowledge(key)).then((ok) => {
    if (!ok && String(taskId.value || '') === key) acknowledgedShelfTask = '';
  });
}
function onTaskDialogOpenChange(open) {
  if (!open) {
    ui.close();
  }
}

// Открытие/закрытие модалки по taskId.
watch(taskId, (id) => {
  acknowledgedShelfTask = '';
  cancelTaskEdit();
  editMessage.value = null;
  if (id) {
    detail.value = null; launchMsg.value = null; sandboxMsg.value = null;
    taskContext.focus({
      routingScope: { kind: 'task', taskId: String(id) },
      details: taskContextDetails(id),
    });
    launchForm.value = null; launchOpts.value = null;
    launchOptionsRequest += 1; launchOptionsBusy.value = false;
    triage.value = null; showNote.value = false;
    showClarifyHistory.value = false;
    showAnalysisDetails.value = false;
    mtab.value = 'triage'; comments.value = null; clarifyDrafts.value = {}; clarifySaved.value = '';
    clarifyEntries.value = [];
    clarifyComposerOpen.value = {};
    activeQuestionId.value = null;
    if (analysisEnabled.value) loadClarifications();
    loadDetail();
    favorites.load(true);
    acknowledgeShelfOnOpen(id);
    // Задачу открыли — она больше не новая. Отметка серверная, поэтому метка гаснет
    // и в других окнах; ошибка отметки на показ задачи не влияет.
    seen.markSeen([id]);
    loadConveyor();
    loadTriage();
    if (!ticker) ticker = setInterval(() => { now.value = Date.now(); }, 1000);
  } else {
    void dictationLease.cancel();
    taskContext.blur();
    if (ticker) { clearInterval(ticker); ticker = null; }
    if (triageTimer) { clearInterval(triageTimer); triageTimer = null; }
  }
}, { immediate: true });

// Полка загружается параллельно карточке. Если её снимок пришёл позже, открытая
// задача всё равно должна погасить накопленный огонёк ровно один раз.
watch(
  () => [taskId.value, shelf.loaded, shelf.entries, shelfEnabled.value],
  ([id]) => acknowledgeShelfOnOpen(id),
);
watch(analysisEnabled, (enabled) => {
  if (!enabled) {
    void dictationLease.cancel();
    if (triageTimer) { clearInterval(triageTimer); triageTimer = null; }
    return;
  }
  if (taskId.value) {
    loadClarifications();
    loadTriage();
  }
});
// Заголовок может приехать после открытия карточки. Обновляем bounded details, но не
// focus revision: открытый позже Pipeline/Task overlay должен остаться верхним.
watch(
  () => [taskId.value, detail.value?.title || '', boardTask.value?.title || ''],
  ([id]) => { if (id) taskContext.update({ details: taskContextDetails(id) }); },
  { immediate: true },
);
watch(() => ui.launchRequested, (requested) => {
  if (!requested || !taskId.value) return;
  ui.consumeTaskLaunch();
  openLaunch();
}, { flush: 'post', immediate: true });
onUnmounted(() => {
  if (ticker) clearInterval(ticker);
  if (triageTimer) clearInterval(triageTimer);
  void dictationLease.release();
});
</script>

<style scoped>
.mhead {
  flex: none;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  padding: 18px 20px 16px;
  border-bottom: 1px solid var(--line);
  background: var(--surface);
}
.mheading {
  flex: 1;
  min-width: 0;
}
.midentity {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 7px;
}
.meyebrow {
  color: var(--ink-mid);
  font-size: 12px;
}
.mid {
  color: var(--accent);
  font-size: 12px;
  font-weight: 600;
}
.mtitle {
  max-height: 120px;
  margin: 0;
  overflow-y: auto;
  color: var(--ink);
  font-size: 19px;
  font-weight: 650;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.mhead-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 4px;
}
.malerts { flex: none; display: grid; gap: 4px; max-height: 104px; overflow-y: auto;
  padding: 8px 16px; border-bottom: 1px solid color-mix(in srgb, var(--bad) 28%, var(--line));
  background: color-mix(in srgb, var(--bad) 9%, var(--surface)); }
.err { margin: 0; color: var(--bad); font-size: 12.5px; line-height: 1.4; overflow-wrap: anywhere; }
.mcontext {
  flex: none;
  min-width: 0;
  padding: 10px 20px;
  border-bottom: 1px solid var(--line);
  background: var(--ground);
}
.meta {
  min-width: 0;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 20px;
}
.tag {
  max-width: 100%;
  padding: 3px 9px;
  border: 1px solid var(--line-2);
  border-radius: 6px;
  background: var(--surface-2);
  color: var(--ink);
  font-size: 12px;
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
.mbody { flex: 1; min-width: 0; min-height: 0; display: grid;
  grid-template-columns: minmax(0, .88fr) minmax(0, 1.12fr); gap: 14px;
  padding: 14px 16px; overflow: hidden; }
.task-pane { min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden;
  border: 1px solid var(--line); border-radius: 12px; background: var(--ground); }
.pane-head,
.work-head {
  flex: none;
  min-width: 0;
  min-height: 58px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--line);
}
.pane-head > div,
.work-head > div {
  min-width: 0;
}
.pane-title {
  margin: 0;
  color: var(--ink);
  font-size: 14px;
  font-weight: 650;
  line-height: 1.35;
}
.brief-scroll, .tab-scroll { flex: 1; min-width: 0; min-height: 0; overflow-y: auto;
  overscroll-behavior: contain; scrollbar-gutter: stable; }
.brief-scroll { display: flex; flex-direction: column; gap: 12px; padding: 12px; }
.task-edit { display: grid; gap: 13px; min-width: 0; padding: 12px;
  border: 1px solid var(--line); border-radius: 10px; background: var(--surface); }
.task-edit-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.task-edit-grid > :last-child { grid-column: 1 / -1; }
.edit-options-state { display: flex; align-items: center; gap: 7px; color: var(--ink-mid);
  font-size: 12px; line-height: 1.4; }
.edit-options-state.bad { align-items: flex-start; justify-content: space-between; color: var(--bad); }
.edit-message { margin: 0; padding: 8px 10px; border: 1px solid color-mix(in srgb, var(--good) 35%, var(--line));
  border-radius: 9px; background: color-mix(in srgb, var(--good) 8%, var(--surface));
  color: var(--good); font-size: 12px; line-height: 1.45; }
.desc-box {
  min-width: 0;
  padding: 4px;
}
.desc {
  margin: 0;
  color: var(--ink);
  font-size: 14px;
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.desc :deep(a) {
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: 3px;
  overflow-wrap: anywhere;
}
.brief-empty { display: grid; min-height: 150px; place-items: center; padding: 18px;
  border: 1px dashed var(--line); border-radius: 10px; color: var(--ink-mid); font-size: 13px;
  line-height: 1.45; text-align: center; }
.tab-scroll {
  padding: 16px;
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
  color: var(--ink-mid);
  font-size: 12px;
}
.triage-ready {
  color: var(--good);
  font-size: 12px;
}
.triage-metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  flex-basis: 100%;
  gap: 8px;
  margin: 0;
}
.triage-metric {
  min-width: 0;
  padding: 10px;
  border-radius: 8px;
  background: var(--surface);
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
.clarify { display: flex; flex-direction: column; min-width: 0; border: 1px solid var(--line);
  border-radius: 11px; background: var(--surface); }
.triage-disabled { color: var(--ink-mid); font-size: 13px; padding: 6px 2px; }
.clarify-head { display: flex; align-items: flex-start; gap: 10px; padding: 12px 14px;
  border-bottom: 1px solid var(--line);
  background: color-mix(in srgb, var(--accent) 6%, var(--surface));
  border-radius: 10px 10px 0 0; }
.clarify-head-icon { display: grid; flex: none; place-items: center; width: 24px; height: 24px;
  border: 1px solid color-mix(in srgb, var(--accent) 48%, var(--line)); border-radius: 50%;
  background: color-mix(in srgb, var(--accent) 12%, var(--surface)); color: var(--accent);
  font-family: var(--mono); font-size: 13px; font-weight: 700; }
.clarify-head h5 { margin: 0; color: var(--ink); font-size: 13px; font-weight: 650; line-height: 1.35; }
.clarify-head p { margin: 2px 0 0; color: var(--ink-mid); font-size: 11.5px; line-height: 1.45; }
.clarify-list { min-width: 0; }
.clarify-card { display: flex; flex-direction: column; gap: 10px; min-width: 0; padding: 14px; }
.clarify-card + .clarify-card { border-top: 1px solid var(--line); }
.clarify-question { display: grid; align-items: start; grid-template-columns: 24px minmax(0, 1fr); gap: 10px; }
.clarify-index { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 7px;
  background: var(--surface-2); color: var(--ink-mid); font-family: var(--mono); font-size: 11px; }
.clarify-card.is-answered .clarify-index { background: color-mix(in srgb, var(--good) 12%, var(--surface-2));
  color: var(--good); }
.clarify-question-copy { min-width: 0; }
.clarify-question h6 { margin: 1px 0 0; color: var(--ink); font-size: 13px;
  font-weight: 650; line-height: 1.45; overflow-wrap: anywhere; }
.clarify-status { display: inline-flex; margin-top: 5px; padding: 2px 7px;
  border: 1px solid color-mix(in srgb, var(--good) 35%, var(--line)); border-radius: 999px;
  color: var(--good); font-size: 10.5px; font-weight: 500; line-height: 1.35; }
.clarify-status.warn { border-color: color-mix(in srgb, var(--warn) 38%, var(--line)); color: var(--warn); }
.clarify-recommendation { display: flex; align-items: baseline; flex-wrap: wrap; gap: 3px 8px;
  min-width: 0; margin-left: 34px; padding: 8px 10px; border-left: 2px solid var(--accent);
  border-radius: 0 8px 8px 0; background: color-mix(in srgb, var(--accent) 6%, transparent);
  color: var(--ink-mid); font-size: 11.5px; line-height: 1.45; }
.clarify-recommendation-label { color: var(--accent); font-size: 10px; font-weight: 650;
  letter-spacing: .06em; text-transform: uppercase; }
.clarify-recommendation strong { color: var(--ink); font-weight: 600; }
.clarify-options { margin-left: 34px; }
.clarify-compose-row { margin-left: 34px; }
.clarify-answer { display: flex; flex-direction: column; gap: 7px; min-width: 0; margin-left: 34px; }
.clarify-answer-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
  color: var(--ink); font-size: 11.5px; font-weight: 550; }
.clarify-answer-head small { color: var(--ink-mid); font-size: 10.5px; font-weight: 400; }
.clarify-text { width: 100%; min-width: 0; }
.clarify-answer-tools { display: flex; align-items: center; justify-content: space-between;
  gap: 8px; color: var(--ink-mid); font-size: 10.5px; line-height: 1.35; }
.clarify-card-actions { display: flex; flex: none; align-items: center; gap: 6px; }
.clarify-submit { position: sticky; z-index: 1; bottom: -12px; padding: 10px 12px;
  border-top: 1px solid var(--line); border-radius: 0 0 10px 10px; background: var(--surface);
  box-shadow: 0 -12px 24px color-mix(in srgb, var(--ground) 72%, transparent); }
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
/* ── Табы модалки ── */
.mtabs { align-self: stretch; }
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

.com { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 9px 12px; }
.comhead { display: flex; gap: 10px; align-items: baseline; font-size: 13px; }
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
  gap: 12px 20px;
  min-width: 0;
  padding: 12px 20px;
  border-top: 1px solid var(--line);
  background: var(--surface);
}
.timer-group {
  display: flex;
  flex: 1 0 auto;
  align-items: center;
  gap: 16px;
  min-width: 0;
}
.timer {
  flex: none;
  display: flex;
  flex-direction: column;
  min-width: 106px;
}
.tclock {
  font-size: 19px;
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
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
}
.convstall { display: flex; flex-direction: column; gap: 2px; width: 100%;
  padding: 7px 10px; border-radius: 8px; color: var(--bad);
  background: color-mix(in srgb, var(--bad) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--bad) 30%, transparent); font-size: 12px; }
.convstall span { color: var(--ink-mid); }
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

@media (max-width: 980px) {
  .mbody { display: flex; flex-direction: column; overflow-y: auto; overscroll-behavior: contain;
    scrollbar-gutter: stable; }
  .task-pane { flex: none; min-height: auto; overflow: visible; }
  .brief-scroll, .tab-scroll { flex: none; min-height: auto; overflow: visible; scrollbar-gutter: auto; }
  .tg { max-height: 320px; }
  .clarify-submit { position: static; box-shadow: none; }
  .controls { gap: 10px; }
  .timer-group { flex: 1 1 100%; justify-content: space-between; }
  .cbtns { flex: 1; }
  .tab-scroll.show-comments { display: block; overflow: visible; }
  .comtab { min-height: 240px; }
  .comlist { flex: none; overflow: visible; }
}

@media (max-width: 600px) {
  .mhead { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; padding: 12px; }
  .mheading { display: contents; }
  .midentity { grid-row: 1; grid-column: 1; margin: 0; }
  .meyebrow { font-size: 11px; }
  .mtitle { grid-row: 2; grid-column: 1 / -1; max-height: 112px; font-size: 16px; }
  .mhead-actions { grid-row: 1; grid-column: 2; gap: 0; }
  .malerts { max-height: 88px; padding: 8px 12px; }
  .mcontext { padding: 8px 12px; max-height: 90px; overflow-y: auto; }
  .meta { gap: 8px 14px; }
  .context-item { font-size: 11px; }
  .mbody { gap: 10px; padding: 10px; }
  .task-pane { border-radius: 10px; }
  .pane-head { min-height: 50px; padding: 8px 11px; }
  .brief-scroll, .tab-scroll { padding: 10px; }
  .task-edit { padding: 10px; }
  .task-edit-grid { grid-template-columns: minmax(0, 1fr); }
  .task-edit-grid > :last-child { grid-column: auto; }
  .task-edit-actions > * { flex: 1; }
  .desc-box { padding: 2px; }
  .desc { font-size: 13.5px; line-height: 1.65; }
  .tg { max-height: 280px; padding: 9px 10px; }
  .work-head { min-height: 50px; padding: 7px; }
  .work-head > div { display: none; }
  .mtabs { width: 100%; }
  .triage-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .clarify-head, .clarify-card { padding: 11px; }
  .clarify-recommendation, .clarify-options, .clarify-compose-row, .clarify-answer {
    margin-left: 0;
  }
  .clarify-answer-tools { align-items: flex-start; }
  .comment { flex-direction: column; align-items: stretch; }
  .comment > :last-child { align-self: flex-end; }
  .controls { gap: 9px; padding: 10px 12px calc(10px + env(safe-area-inset-bottom)); }
  .timer-group { gap: 10px; }
  .timer { min-width: 90px; }
  .tclock { font-size: 17px; }
  .cbtns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; }
  .cbtns > :last-child:nth-child(odd) { grid-column: 1 / -1; }
  .convstall, .lmsg { grid-column: 1 / -1; }
  .lform { left: -10px; right: -10px; max-height: 60dvh;
    padding: 12px 12px 14px; border-radius: 12px 12px 0 0; }
  .lrow { align-items: stretch; }
  .lsummary-row, .lrepo { grid-template-columns: 1fr; gap: 3px; }
  .lbtns > * { flex: 1; }
}

@media (min-width: 981px) and (max-height: 720px) {
  .mhead { min-height: 56px; padding-block: 8px; }
  .mcontext { min-height: 38px; padding-block: 5px; }
  .mbody { gap: 10px; padding-block: 10px; }
  .pane-head, .work-head { min-height: 50px; }
  .brief-scroll, .tab-scroll { padding: 10px; }
  .controls { padding-block: 8px; }
}
</style>

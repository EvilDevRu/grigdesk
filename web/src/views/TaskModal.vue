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
        <div class="midentity">
          <span class="meyebrow">Задача Битрикс24</span>
          <span class="mid mono">#{{ taskId }}</span>
        </div>
        <h3 id="task-modal-title" class="mtitle">
          <UiSpinner v-if="loading && !detail" decorative />
          {{ detail?.title || (loading ? 'Загрузка…' : 'Задача') }}
        </h3>
        <TaskFavoriteButton :active="favorites.isFavorite(taskId)"
                            :pending="!favorites.loaded || favorites.loading || favorites.isPending(taskId)"
                            :task-title="detail?.title || boardTask?.title || `Задача #${taskId}`"
                            @toggle="toggleFavorite" />
        <UiIconButton
          data-context="task-modal-header"
          label="Обновить задачу"
          title="Обновить"
          :loading="loading"
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
      </header>

      <div v-if="err || favorites.error" class="malerts" aria-live="polite">
        <p v-if="err" class="err">{{ err }}</p>
        <p v-if="favorites.error" class="err">Избранное: {{ favorites.error }}</p>
      </div>

      <div class="mcontext" aria-label="Состояние задачи">
        <div class="meta">
          <span v-if="detail?.status_label" class="tag">{{ detail.status_label }}</span>
          <span v-if="detail?.priority_label" class="tag">{{ detail.priority_label }}</span>
          <span v-if="boardTask?.group" class="tag">{{ boardTask.group }}</span>
          <span v-if="boardTask?.deadline" class="tag" :class="{ over: boardTask.overdue }">до {{ boardTask.deadline }}</span>
          <span v-if="!detail?.status_label && !detail?.priority_label && !boardTask?.group && !boardTask?.deadline"
                class="context-empty">{{ loading ? 'Читаю данные задачи…' : 'Дополнительных меток нет' }}</span>
        </div>
      </div>

      <div class="mbody">
        <section class="task-pane brief-pane" aria-labelledby="task-brief-title">
          <div class="pane-head">
            <div>
              <span class="pane-kicker">Постановка</span>
              <h4 id="task-brief-title" class="pane-title">Что нужно сделать</h4>
            </div>
          </div>
          <div class="brief-scroll">
            <div v-if="cleanDesc" class="desc-box">
              <div class="tlbl">Описание</div>
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
                  <div v-for="q in l.quotes" :key="q.messageId" class="tgq" :class="{ tgtarget: q.target }">
                    <div class="tgmeta">
                      <span class="tgauthor">{{ q.author }}</span>
                      <span class="tgtime">{{ tgTime(q.at) }}</span>
                      <span v-if="q.target" class="tgpin">← ссылка</span>
                    </div>
                    <div class="tgtext">{{ q.text }}<template v-if="q.trimmed">…</template></div>
                    <div v-if="q.media?.length" class="tgmedia">{{ q.media.join(', ') }}</div>
                  </div>
                  <div v-if="l.more" class="tgmore">ещё {{ l.more }} {{ tgPlural(l.more) }} в ветке</div>
                </template>
              </div>
            </section>
            <div v-if="!cleanDesc && !tgLinks.length" class="brief-empty">
              Постановка пока не загружена или в задаче нет описания.
            </div>
          </div>
        </section>

        <section class="task-pane work-pane" aria-labelledby="task-work-title">
          <div class="work-head">
            <div>
              <span class="pane-kicker">Рабочая зона</span>
              <h4 id="task-work-title" class="pane-title">Разбор и связь</h4>
            </div>
            <!-- Табы: Триаж | Комментарии -->
            <UiTabs v-model="mtab" class="mtabs" label="Раздел карточки задачи">
              <UiTab
                id="task-tab-triage"
                data-context="task-modal-tab"
                value="triage"
                controls="task-panel-triage"
              >
                Триаж
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

          <div class="tab-scroll">
            <!-- Триаж: оценка сложности/рисков без стенда -->
            <div
              v-show="mtab === 'triage'"
              id="task-panel-triage"
              class="triage"
              role="tabpanel"
              aria-labelledby="task-tab-triage"
            >
          <div class="thead2">
            <span class="triage-summary">
              <span class="tlbl">Триаж</span>
              <template v-if="triage?.analysis">
                <!-- Пока идёт переоценка, старые чипсы притушены + явный индикатор: иначе
                     «нажал уточнить — и ничего не изменилось» (оценка-то на экране осталась). -->
                <span class="tchips" :class="{ dim: triageBusy }">
                  <span class="tchip" :class="triage.analysis.complexity >= 4 ? 'warn' : triage.analysis.complexity === 3 ? 'acc' : ''">сложность {{ triage.analysis.complexity }}/5</span>
                  <span class="tchip" :class="triage.analysis.risk >= 4 ? 'bad' : triage.analysis.risk === 3 ? 'warn' : ''">риск {{ triage.analysis.risk }}/5</span>
                  <span class="tchip">дифф {{ triage.analysis.diff_size }}</span>
                  <span class="tchip">{{ triage.analysis.route_guess }}</span>
                  <span v-if="triage.analysis.confidence !== 'high'" class="tchip" :class="triage.analysis.confidence === 'low' ? 'warn' : ''">уверенность: {{ triage.analysis.confidence }}</span>
                </span>
                <span v-if="triageBusy" class="tmuted">
                  <UiSpinner decorative />
                  {{ triageState === 'running' ? 'переоценка идёт…' : 'переоценка в очереди…' }}
                </span>
              </template>
              <span v-else-if="triageBusy" class="tmuted">
                <UiSpinner decorative />
                {{ triageState === 'running' ? 'разведка идёт…' : 'в очереди…' }}
              </span>
              <span v-else-if="triageState === 'failed'" class="terr" :title="triage?.status?.error">триаж упал: {{ (triage?.status?.error || '').slice(0, 80) }}</span>
              <span v-else class="tmuted">задача не оценена</span>
            </span>
            <UiButton
              data-role="task-compact-action"
              tone="accent"
              :loading="triageBusy || busy === 'analyze'"
              :disabled="triageBusy || busy === 'analyze'"
              loading-label="Оцениваю задачу"
              @click="analyzeNow"
            >
              {{ triage?.analysis ? '↻ Переоценить' : '🔍 Оценить' }}
            </UiButton>
          </div>

          <template v-if="triage?.analysis">
            <p v-if="triage.analysis.summary" class="tsum">{{ triage.analysis.summary }}</p>
            <p v-if="triage.stale?.length" class="tstale">
              ⚠ Код под оценкой менялся: {{ triage.stale.slice(0, 5).join(', ') }}{{ triage.stale.length > 5 ? ` и ещё ${triage.stale.length - 5}` : '' }} — стоит переоценить.
            </p>
            <ul v-if="triage.analysis.risk_markers?.length" class="tlist">
              <li v-for="m in triage.analysis.risk_markers" :key="m">⚠ {{ m }}</li>
            </ul>
            <ul v-if="triage.analysis.questions?.length" class="tlist q">
              <li v-for="qq in triage.analysis.questions" :key="qq">? {{ qq }}</li>
            </ul>
            <div v-if="triage.analysis.questions?.length || triage.analysis.needs_clarification"
                 class="clarify" :class="{ drag: clarifyDrag }"
                 @dragover.prevent="clarifyDrag = true" @dragleave="clarifyDrag = false" @drop.prevent="onClarifyDrop">
              <div class="clarify-row">
                <UiTextarea
                  v-model="clarifyText"
                  class="clarify-text"
                  data-role="task-clarification"
                  rows="2"
                  placeholder="Ответ на вопросы — сохранится локально для агентов, в B24 не уйдёт… (Ctrl+V — скрин, Ctrl+Enter — отправить)"
                  @paste="onClarifyPaste"
                  @keydown.ctrl.enter.prevent="sendClarify"
                />
                <UiTooltip
                  text="Фото для агента: скрин переписки или бага. Можно вставить из буфера (Ctrl+V) или перетащить сюда."
                  placement="top-end"
                >
                  <template #trigger>
                    <UiFilePicker
                      data-role="task-attachment"
                      accept="image/*"
                      multiple
                      density="compact"
                      label="Приложить фото"
                      :busy="clarifyUploading"
                      :show-summary="false"
                      :show-reset="false"
                      @change="onClarifyFiles"
                    >
                      <template #leading>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                    </svg>
                      </template>
                    </UiFilePicker>
                  </template>
                </UiTooltip>
                <UiButton
                  data-role="task-compact-action"
                  tone="accent"
                  :loading="busy === 'clarify' || clarifyUploading"
                  :disabled="busy === 'clarify' || triageBusy || clarifyUploading || (!clarifyText.trim() && !clarifyAtts.length)"
                  loading-label="Сохраняю уточнение"
                  @click="sendClarify"
                >
                  ↻ Уточнить и переоценить
                </UiButton>
              </div>
              <div v-if="clarifyAtts.length || clarifyUploading" class="attrow">
                <span v-for="a in clarifyAtts" :key="a.file" class="attchip">
                  <img :src="a.url" :alt="a.name" />
                  <span class="attname">{{ a.name }}</span>
                  <UiIconButton
                    role="rail"
                    tone="danger"
                    :label="`Убрать ${a.name}`"
                    title="Убрать"
                    @click="dropClarifyAtt(a.file)"
                  >
                    ✕
                  </UiIconButton>
                </span>
                <span v-if="clarifyUploading" class="tmuted">
                  <UiSpinner decorative /> загрузка…
                </span>
              </div>
            </div>
            <details v-if="clarifySaved" class="clhist">
              <summary>Внутренние уточнения (локально, для агентов — заказчик не видит)</summary>
              <div class="clhist-body">{{ clarifySaved }}</div>
            </details>
            <UiDisclosureButton
              v-if="triage.note"
              data-role="task-note-disclosure"
              controls="task-triage-note"
              density="compact"
              :open="showNote"
              @update:open="showNote = $event"
            >
              Разведнота (карта кода для планировщика)
            </UiDisclosureButton>
            <div v-if="showNote" id="task-triage-note" class="tnote" v-html="noteHtml"></div>
            <p class="tmeta mono">
              {{ triage.analysis.generated_at ? new Date(triage.analysis.generated_at).toLocaleString('ru-RU') : '' }}
              <template v-if="triage.analysis.meta">· {{ triage.analysis.meta.model }} · {{ Math.round((triage.analysis.meta.duration_ms || 0) / 60000) }} мин<template v-if="triage.analysis.meta.cost_usd"> · ${{ triage.analysis.meta.cost_usd.toFixed(2) }}</template></template>
            </p>
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
              rows="2"
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
          <div class="timer mono" :class="{ run: running }">
            <span class="tclock">{{ elapsed !== null ? secToHMS(elapsed) : '—' }}</span>
            <span class="tstate">{{ running ? 'идёт' : 'остановлен' }}</span>
          </div>
          <div class="cbtns">
            <UiButton
              data-context="task-footer-action"
              :tone="running ? 'warning' : 'accent'"
              variant="solid"
              :loading="busy === 'timer'"
              :disabled="busy === 'timer'"
              loading-label="Обновляю учёт времени"
              @click="toggleTimer"
            >
              {{ running ? '⏸ Остановить учёт' : '▶ Начать учёт' }}
            </UiButton>
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
              title="Открыть параметры запуска фабрики по задаче"
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
                <option v-for="r in launchOpts.routes" :key="r" :value="r">{{ r }}</option>
              </UiSelect>
              <span v-if="launchRouteIsSuggested" class="lhint suggested">рекомендован триажем</span>
              <span v-else-if="routeGuess" class="lhint">триаж предлагает: {{ routeGuess }}</span>
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

            <label class="llbl">Критерии приёмки <span class="lopt">— необязательно</span></label>
            <UiTextarea
              v-model="launchForm.criteria"
              data-role="task-launch-note"
              rows="2"
              placeholder="Например: экспорт не падает на выборке 10 000 строк&#10;в отчёте появилась колонка «Менеджер»"
            />
            <p class="lnote">
              Если оставить пустым, критерии сформулирует этап-переводчик по постановке.
            </p>

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
import { api } from '../shared/api-client.js';
import { useUiContextSource } from '../composables/useUiContextSource.js';
import {
  confirmDialog,
  UiButton,
  UiDialog,
  UiDisclosureButton,
  UiFilePicker,
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
import { useAnalysisStore } from '../stores/analysis.js';
import { useTaskFavoritesStore } from '../stores/task-favorites.js';
import { useTaskSeenStore } from '../stores/task-seen.js';
import { liveTimerSec, secToHMS } from '../shared/format.js';
import { mdToHtml } from '../shared/md.js';
import { providerLabel } from '../shared/runner-display.js';
import OpenDiffButton from './OpenDiffButton.vue';
import TaskFavoriteButton from './board/TaskFavoriteButton.vue';

const router = useRouter();

const ui = useUiStore();
const tasks = useTasksStore();
const board = useBoardStore();
const favorites = useTaskFavoritesStore();
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
let triageTimer = null;
const triageState = computed(() => triage.value?.status?.state || null);
const triageBusy = computed(() => triageState.value === 'queued' || triageState.value === 'running');
const noteHtml = computed(() => (triage.value?.note ? mdToHtml(triage.value.note) : ''));

async function loadTriage() {
  if (!taskId.value) return;
  try { triage.value = await analysisStore.detail(taskId.value); } catch { /* блок триажа не ломает модалку */ }
  // Пока идёт — подтягиваем статус; закончилось — останавливаемся.
  if (triageBusy.value && !triageTimer) {
    triageTimer = setInterval(loadTriage, 6000);
  } else if (!triageBusy.value && triageTimer) {
    clearInterval(triageTimer); triageTimer = null;
  }
}
const analyzeNow = () => act('analyze', async () => {
  await analysisStore.analyze(taskId.value);
  await loadTriage();
});

// Ответ на вопросы триажа: уходит комментарием в B24 (агент читает комментарии
// вместе с тикетом) и сразу запускает переоценку — цикл уточнения в один клик.
// К уточнению можно приложить фото (скрин переписки/бага): файл сохраняется в
// chats/attachments, в комментарий вписывается абсолютный путь — агент переоценки
// открывает его Read'ом (папка выдана ему через --add-dir).
const clarifyText = ref('');
const clarifyAtts = ref([]);   // [{file,name,url,path}]
const clarifyUploading = ref(false);
async function onClarifyFiles(files) {
  await uploadClarifyFiles(files);
}
function dropClarifyAtt(file) { clarifyAtts.value = clarifyAtts.value.filter((a) => a.file !== file); }
// Скрин из буфера обмена (Ctrl+V прямо в поле) и перетаскивание файлов — как в чате.
async function uploadClarifyFiles(files) {
  if (!files.length) return;
  clarifyUploading.value = true;
  try {
    for (const f of files) {
      const fd = new FormData();
      fd.append('file', f, f.name || 'clipboard.png');
      clarifyAtts.value.push(await api.upload('/api/chat/upload', fd));
    }
  } catch (e2) { err.value = e2.message; }
  finally { clarifyUploading.value = false; }
}
function onClarifyPaste(e) {
  const files = [...(e.clipboardData?.items || [])]
    .filter((i) => i.kind === 'file' && i.type.startsWith('image/'))
    .map((i) => i.getAsFile()).filter(Boolean);
  if (files.length) { e.preventDefault(); uploadClarifyFiles(files); }
}
const clarifyDrag = ref(false);
function onClarifyDrop(e) {
  clarifyDrag.value = false;
  uploadClarifyFiles([...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/')));
}
// Сохраняются ЛОКАЛЬНО (t<id>.clarify.md), НЕ комментарием в B24: комментарии
// видит заказчик, а рабочие пояснения — внутренняя кухня. Их читают триаж и конвейер.
const clarifySaved = ref('');
async function loadClarifications() {
  try { clarifySaved.value = (await api.get(`/api/tasks/${taskId.value}/clarifications`)).text || ''; }
  catch { clarifySaved.value = ''; }
}
const sendClarify = () => act('clarify', async () => {
  const photos = clarifyAtts.value.map((a) => `[приложено фото: ${a.path}]`).join('\n');
  const r = await api.post(`/api/tasks/${taskId.value}/clarifications`, {
    text: `${clarifyText.value.trim()}${photos ? `\n${photos}` : ''}`,
  });
  clarifySaved.value = r.text || '';
  clarifyText.value = ''; clarifyAtts.value = [];
  await analysisStore.analyze(taskId.value);
  await loadTriage();
});

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
// Критерии пустыми допустимы: тогда их формулирует этап-переводчик. Выдумывать их за человека нельзя —
// отказ на приёмке откатывает маршрут на сборку со сбросом всего хвоста.
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
function preferredLaunchRoute(opts) {
  const guess = triage.value?.analysis?.route_guess;
  return opts.routes?.includes(guess) ? guess : opts.defaultRoute;
}
function makeLaunchForm(opts, criteria = '') {
  const route = preferredLaunchRoute(opts);
  const needsInstrumentation = opts.routeOptions?.[route]?.instrumentationRequired;
  return {
    profile: opts.profile,
    route,
    criteria,
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
const routeGuess = computed(() => {
  const guess = triage.value?.analysis?.route_guess;
  return guess && guess !== launchForm.value?.route && launchOpts.value?.routes?.includes(guess) ? guess : null;
});
const launchRouteOption = computed(() => (
  launchOpts.value?.routeOptions?.[launchForm.value?.route] || null
));
const launchNeedsDelivery = computed(() => launchRouteOption.value?.deliveryMode === 'publish');
const launchNeedsInstrumentation = computed(() => Boolean(
  launchRouteOption.value?.instrumentationRequired
));
const launchRouteIsSuggested = computed(() => (
  triage.value?.analysis?.route_guess === launchForm.value?.route
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
function onTaskDialogOpenChange(open) {
  if (!open) {
    ui.close();
  }
}

// Открытие/закрытие модалки по taskId.
watch(taskId, (id) => {
  if (id) {
    detail.value = null; launchMsg.value = null; sandboxMsg.value = null;
    taskContext.focus({
      routingScope: { kind: 'task', taskId: String(id) },
      details: taskContextDetails(id),
    });
    launchForm.value = null; launchOpts.value = null;
    launchOptionsRequest += 1; launchOptionsBusy.value = false;
    triage.value = null; showNote.value = false;
    mtab.value = 'triage'; comments.value = null; clarifyAtts.value = []; clarifySaved.value = '';
    loadClarifications();
    loadDetail();
    favorites.load(true);
    // Задачу открыли — она больше не новая. Отметка серверная, поэтому метка гаснет
    // и в других окнах; ошибка отметки на показ задачи не влияет.
    seen.markSeen([id]);
    loadConveyor();
    loadTriage();
    if (!ticker) ticker = setInterval(() => { now.value = Date.now(); }, 1000);
  } else {
    taskContext.blur();
    if (ticker) { clearInterval(ticker); ticker = null; }
    if (triageTimer) { clearInterval(triageTimer); triageTimer = null; }
  }
}, { immediate: true });
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
});
</script>

<style scoped>
.mhead { flex: none; display: flex; align-items: center; gap: 12px; min-height: 66px;
  padding: 11px 16px; border-bottom: 1px solid var(--line); background: var(--surface-2); }
.midentity { flex: none; width: 112px; display: flex; flex-direction: column; gap: 2px; }
.meyebrow, .pane-kicker { color: var(--ink-mid); font-size: 10px; font-weight: 650;
  letter-spacing: .09em; line-height: 1.2; text-transform: uppercase; }
.mid { color: var(--accent); font-size: 13px; font-weight: 650; }
.mtitle { flex: 1; min-width: 0; margin: 0; overflow: hidden; color: var(--ink);
  font-size: 17px; font-weight: 650; line-height: 1.3; overflow-wrap: anywhere;
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.malerts { flex: none; display: grid; gap: 4px; max-height: 104px; overflow-y: auto;
  padding: 8px 16px; border-bottom: 1px solid color-mix(in srgb, var(--bad) 28%, var(--line));
  background: color-mix(in srgb, var(--bad) 9%, var(--surface)); }
.err { margin: 0; color: var(--bad); font-size: 12.5px; line-height: 1.4; overflow-wrap: anywhere; }
.mcontext { flex: none; min-width: 0; min-height: 43px; display: flex; align-items: center;
  padding: 7px 16px; border-bottom: 1px solid var(--line); background: var(--ground); }
.meta { min-width: 0; display: flex; flex-wrap: wrap; gap: 6px; }
.tag { max-width: 100%; padding: 3px 9px; overflow: hidden; border: 1px solid var(--line);
  border-radius: 999px; background: var(--surface-2); color: var(--ink-mid); font-size: 11.5px;
  line-height: 1.3; text-overflow: ellipsis; white-space: nowrap; }
.tag.over { border-color: color-mix(in srgb, var(--bad) 35%, var(--line)); color: var(--bad); }
.context-empty { color: var(--ink-mid); font-size: 12px; }
.mbody { flex: 1; min-width: 0; min-height: 0; display: grid;
  grid-template-columns: minmax(0, .88fr) minmax(0, 1.12fr); gap: 14px;
  padding: 14px 16px; overflow: hidden; }
.task-pane { min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden;
  border: 1px solid var(--line); border-radius: 12px; background: var(--ground); }
.pane-head { flex: none; min-height: 56px; display: flex; align-items: center; padding: 9px 13px;
  border-bottom: 1px solid var(--line); background: color-mix(in srgb, var(--surface-2) 72%, var(--ground)); }
.pane-title { margin: 3px 0 0; color: var(--ink); font-size: 14px; font-weight: 650; line-height: 1.25; }
.brief-scroll, .tab-scroll { flex: 1; min-width: 0; min-height: 0; overflow-y: auto;
  overscroll-behavior: contain; scrollbar-gutter: stable; }
.brief-scroll { display: flex; flex-direction: column; gap: 12px; padding: 12px; }
.desc-box { min-width: 0; padding: 11px 12px; border: 1px solid var(--line); border-radius: 10px;
  background: var(--surface); }
.desc-box .tlbl { margin-bottom: 7px; }
.desc { margin: 0; color: var(--ink); font-size: 13.5px; line-height: 1.58; white-space: pre-wrap;
  overflow-wrap: anywhere; }
.desc :deep(a) { color: var(--accent); text-decoration: none; word-break: break-all; }
.desc :deep(a:hover) { text-decoration: underline; }
.brief-empty { display: grid; min-height: 150px; place-items: center; padding: 18px;
  border: 1px dashed var(--line); border-radius: 10px; color: var(--ink-mid); font-size: 13px;
  line-height: 1.45; text-align: center; }
.work-head { flex: none; min-width: 0; min-height: 56px; display: flex; align-items: flex-end;
  justify-content: space-between; gap: 12px; padding: 8px 13px 0;
  border-bottom: 1px solid var(--line); background: color-mix(in srgb, var(--surface-2) 72%, var(--ground)); }
.work-head > div { flex: none; align-self: center; }
.tab-scroll { padding: 12px; }

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

.triage { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px;
  display: flex; flex-direction: column; gap: 8px; }
.thead2 { display: flex; align-items: flex-start; gap: 8px; flex-wrap: wrap; }
.triage-summary { display: flex; flex: 1 1 360px; align-items: center; gap: 6px;
  min-width: 0; flex-wrap: wrap; }
.tlbl { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--ink-mid); margin-right: 4px; }
.tchips { display: contents; }
.tchips.dim { display: inline-flex; gap: 6px; flex-wrap: wrap; opacity: .45; }
.tchip { font-size: 12px; font-family: var(--mono, monospace); color: var(--ink-mid);
  border: 1px solid var(--line); border-radius: 999px; padding: 2px 9px; }
.tchip.acc { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, transparent); }
.tchip.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, transparent); }
.tchip.bad { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 40%, transparent); }
.tmuted { color: var(--ink-mid); font-size: 13px; display: inline-flex; align-items: center; gap: 6px; }
.terr { color: var(--bad); font-size: 12px; }
.thead2 [data-role='task-compact-action'] { flex: none; }
.tsum { margin: 0; font-size: 13px; color: var(--ink); line-height: 1.5; }
.tstale { margin: 0; font-size: 12px; color: var(--warn); }
.tlist { margin: 0; padding: 0 0 0 4px; list-style: none; font-size: 12px; color: var(--ink-mid); display: flex; flex-direction: column; gap: 3px; }
.tlist.q li { color: var(--warn); }
.clarify { display: flex; flex-direction: column; gap: 8px; border-radius: 10px; }
.clarify.drag { outline: 2px dashed var(--accent); outline-offset: 3px; }
.clarify-row { display: flex; gap: 8px; align-items: flex-end; }
/* В ряду уточнения кнопка стоит вплотную к скрепке (auto-margin — только в шапке триажа),
   все контролы одной высоты. */
.clarify-row [data-role='task-compact-action'] { margin-left: 0; }
.clarify-text { flex: 1; }
.clhist { border: 1px dashed var(--line); border-radius: 9px; padding: 7px 11px; }
.clhist summary { cursor: pointer; font-size: 12.5px; color: var(--ink-mid); user-select: none; }
.clhist-body { margin-top: 6px; font-size: 13px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere;
  max-height: 220px; overflow-y: auto; }
.attrow { display: flex; gap: 8px; flex-wrap: wrap; width: 100%; }
.attchip { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line);
  border-radius: 8px; padding: 3px 8px 3px 3px; background: var(--surface-2); font-size: 12px; }
.attchip img { width: 26px; height: 26px; object-fit: cover; border-radius: 5px; }
.attname { max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-mid); }
/* ── Табы модалки ── */
.mtabs { align-self: stretch; }
/* ── Таб комментариев ── */
.comtab { min-height: 100%; display: flex; flex-direction: column; gap: 12px; }
.comlist { display: flex; flex-direction: column; gap: 10px; }
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
.tmeta { margin: 0; font-size: 11px; color: var(--ink-mid); }
.controls { position: relative; flex: none; min-width: 0; display: flex; align-items: center;
  gap: 12px; flex-wrap: wrap; padding: 10px 16px; background: var(--surface-2);
  border-top: 1px solid var(--line); }
.timer { flex: none; display: flex; flex-direction: column; min-width: 92px; margin-right: auto; }
.tclock { font-size: 18px; font-weight: 650; line-height: 1.1; }
.timer.run .tclock { color: var(--good); }
.tstate { font-size: 11px; color: var(--ink-mid); }
.cbtns { min-width: 0; display: flex; align-items: stretch; justify-content: flex-end; gap: 7px; flex-wrap: wrap; }
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
.lsummary { display: grid; gap: 5px; padding: 8px 10px; border: 1px solid var(--line);
  border-radius: 9px; background: var(--ground); }
.lsummary-row { display: grid; grid-template-columns: minmax(90px, auto) 1fr; gap: 10px;
  align-items: baseline; font-size: 12.5px; }
.lsummary-row > span { color: var(--ink-mid); }
.lsummary-row > b { min-width: 0; overflow-wrap: anywhere; font-weight: 550; }
.lshipwarn { margin: 2px 0 0; padding-top: 6px; border-top: 1px solid var(--line);
  color: var(--warn); font-size: 11.5px; line-height: 1.4; }
.lnote { margin: 0; font-size: 11.5px; color: var(--ink-mid); line-height: 1.45; }
.ladvanced { margin-top: 2px; border: 1px dashed var(--line); border-radius: 9px; padding: 7px 10px; }
.ladvanced summary { color: var(--ink-mid); font-size: 12px; cursor: pointer; user-select: none; }
.ladvanced[open] summary { margin-bottom: 9px; }
.ladvanced-body { display: flex; flex-direction: column; gap: 7px; }
.lerror { margin: 0; color: var(--bad); font-size: 12px; }
.lbtns { display: flex; gap: 8px; justify-content: flex-end; }
.comment { display: flex; gap: 8px; align-items: flex-end; margin-top: auto; }
.comment-text { flex: 1; }

@media (max-width: 980px) {
  .midentity { width: 100px; }
  .mbody { display: flex; flex-direction: column; overflow-y: auto; overscroll-behavior: contain;
    scrollbar-gutter: stable; }
  .task-pane { flex: none; min-height: auto; overflow: visible; }
  .brief-scroll, .tab-scroll { flex: none; min-height: auto; overflow: visible; scrollbar-gutter: auto; }
  .tg { max-height: 320px; }
  .controls { gap: 10px; }
  .timer { min-width: 82px; }
  .cbtns { flex: 1; }
}

@media (max-width: 600px) {
  .mhead { gap: 7px; min-height: 56px; padding: 7px 10px; }
  .midentity { width: auto; }
  .meyebrow { display: none; }
  .mid { font-size: 12px; }
  .mtitle { font-size: 14px; line-height: 1.25; }
  .mhead :deep(.favbtn) { width: 38px; height: 38px; }
  .malerts { max-height: 88px; padding: 7px 10px; }
  .mcontext { min-height: 38px; padding: 6px 10px; overflow: hidden; }
  .meta { flex-wrap: nowrap; overflow-x: auto; overscroll-behavior-x: contain; scrollbar-width: none; }
  .meta::-webkit-scrollbar { display: none; }
  .tag { flex: none; }
  .mbody { gap: 10px; padding: 10px; }
  .task-pane { border-radius: 10px; }
  .pane-head { min-height: 50px; padding: 8px 11px; }
  .brief-scroll, .tab-scroll { padding: 10px; }
  .desc-box { padding: 10px; }
  .desc { font-size: 13px; line-height: 1.55; }
  .tg { max-height: 280px; padding: 9px 10px; }
  .work-head { min-height: 44px; padding: 0 7px; }
  .work-head > div { display: none; }
  .mtabs { width: 100%; }
  .triage { padding: 10px; }
  .triage-summary { flex-basis: 100%; }
  .thead2 [data-role='task-compact-action'] { width: 100%; margin-left: 0; }
  .clarify-row { flex-wrap: wrap; }
  .clarify-text { flex-basis: 100%; }
  .clarify-row [data-role='task-compact-action'] { flex: 1; }
  .comment { flex-direction: column; align-items: stretch; }
  .comment > :last-child { align-self: flex-end; }
  .controls { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 7px 9px;
    padding: 7px 10px calc(7px + env(safe-area-inset-bottom)); }
  .timer { min-width: 58px; margin: 0; }
  .tclock { font-size: 15px; }
  .tstate { font-size: 10px; }
  .cbtns { width: 100%; flex-wrap: nowrap; justify-content: flex-start; overflow-x: auto;
    overscroll-behavior-x: contain; scrollbar-width: none; padding: 1px 0 3px; }
  .cbtns::-webkit-scrollbar { display: none; }
  .cbtns > * { flex: none; }
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

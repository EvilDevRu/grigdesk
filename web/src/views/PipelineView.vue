<template>
  <div class="pipeline">
    <div class="toolbar">
      <!-- Проекты — главный уровень панели. Натуральные ширины кнопок измеряются в
           невидимом ряду; непоместившийся хвост уезжает в список справа. -->
      <div
        ref="projectStrip"
        class="project-strip"
        role="group"
        aria-label="Проекты"
      >
        <span
          v-for="option in visibleProjectOptions"
          :key="option.id"
          class="project-button-frame"
        >
          <UiButton
            class="project-option"
            data-role="pipeline-project"
            data-context="pipeline-project"
            :data-project="option.id"
            tone="accent"
            variant="ghost"
            :pressed="activeProject === option.id"
            :aria-label="`${option.label}: ${option.count}`"
            v-tooltip="`${option.label} · ${option.count}`"
            @click="setProject(option.id)"
          >
            <span class="project-option-copy">
              <span class="project-option-label">{{ option.label }}</span>
              <b class="project-count mono">{{ option.count }}</b>
            </span>
          </UiButton>
        </span>

        <UiPopover
          v-if="hiddenProjectOptions.length"
          class="project-overflow-popover"
          has-popup="menu"
          placement="bottom-end"
          aria-label="Остальные проекты"
          :style="{ width: 'min(320px, calc(100vw - 20px))' }"
        >
          <template #trigger>
            <UiButton
              class="project-more"
              data-role="pipeline-project-overflow"
              data-context="pipeline-toolbar-more"
              variant="ghost"
              :aria-label="`Ещё проектов: ${hiddenProjectOptions.length}`"
              v-tooltip="`Ещё проектов: ${hiddenProjectOptions.length}`"
            >
              <span class="mono">+{{ hiddenProjectOptions.length }}</span>
              <svg class="project-more-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="m4 6 4 4 4-4" />
              </svg>
            </UiButton>
          </template>

          <template #default="{ close }">
            <div class="project-menu">
              <UiButton
                v-for="option in hiddenProjectOptions"
                :key="option.id"
                class="project-menu-option"
                data-role="pipeline-project-overflow-option"
                :data-project="option.id"
                role="menuitem"
                block
                variant="ghost"
                v-tooltip="option.label"
                @click="setProject(option.id); close('action')"
              >
                <span class="project-menu-copy">
                  <span>{{ option.label }}</span>
                  <b class="project-count mono">{{ option.count }}</b>
                </span>
              </UiButton>
            </div>
          </template>
        </UiPopover>

        <!-- Геометрия полностью повторяет реальные project-кнопки. Absolute + hidden
             не влияют на раскладку, overflow контейнера не даёт ряду распереть страницу. -->
        <div ref="projectMeasure" class="project-measure" aria-hidden="true">
          <span
            v-for="option in projectOptions"
            :key="`measure-${option.id}`"
            class="project-button-frame"
            :data-project-measure="option.id"
          >
            <UiButton
              class="project-option"
              data-context="pipeline-project"
              tone="accent"
              variant="ghost"
              tabindex="-1"
            >
              <span class="project-option-copy">
                <span class="project-option-label">{{ option.label }}</span>
                <b class="project-count mono">{{ option.count }}</b>
              </span>
            </UiButton>
          </span>
          <UiButton
            data-project-more-measure
            class="project-more"
            data-context="pipeline-toolbar-more"
            variant="ghost"
            tabindex="-1"
          >
            <span class="mono">+{{ projectOptions.length }}</span>
            <svg class="project-more-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="m4 6 4 4 4-4" />
            </svg>
          </UiButton>
        </div>
      </div>

      <!-- Правый кластер: вторичные состояния вплотную к двум кнопкам вида. -->
      <div class="toolbar-secondary">
        <div class="status-scroll">
          <div class="secondary-status-filters" role="group" aria-label="Состояние">
            <UiButton
              v-for="option in statusOptions"
              :key="option.id"
              class="status-filter"
              data-role="pipeline-status-filter"
              data-context="pipeline-status"
              :data-status="option.id"
              :data-empty="option.count === 0 || undefined"
              :tone="option.tone"
              variant="text"
              :pressed="activeStatus === option.id"
              :aria-label="`${option.label}: ${option.count}`"
              v-tooltip="option.hint"
              @click="setStatus(option.id)"
            >
              <span class="status-filter-copy">
                <span
                  v-if="option.id !== 'all'"
                  class="status-dot"
                  :data-tone="option.tone"
                  aria-hidden="true"
                ></span>
                <span class="status-filter-label" :class="{ 'is-all': option.id === 'all' }">
                  {{ option.label }}
                </span>
                <b class="status-count mono">{{ option.count }}</b>
              </span>
            </UiButton>
          </div>
        </div>

        <div class="status-menu">
          <UiPopover
            has-popup="menu"
            placement="bottom-end"
            aria-label="Состояние"
            :style="{ width: 'min(280px, calc(100vw - 20px))' }"
          >
            <template #trigger>
              <UiButton
                class="status-menu-trigger"
                data-role="pipeline-status-overflow"
                data-context="pipeline-status-trigger"
                :tone="currentStatusOption.tone"
                variant="text"
                :aria-label="`Состояние: ${currentStatusOption.label}, ${currentStatusOption.count}`"
                v-tooltip="currentStatusOption.label"
              >
                <span class="status-menu-trigger-copy">
                  <span class="status-menu-label">Состояние:</span>
                  <span
                    v-if="activeStatus !== 'all'"
                    class="status-dot"
                    :data-tone="currentStatusOption.tone"
                    aria-hidden="true"
                  ></span>
                  <span class="status-menu-current">{{ currentStatusOption.label }}</span>
                  <b class="status-count mono">{{ currentStatusOption.count }}</b>
                  <svg class="project-more-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="m4 6 4 4 4-4" />
                  </svg>
                </span>
              </UiButton>
            </template>

            <template #default="{ close }">
              <div class="status-menu-options">
                <UiButton
                  v-for="option in statusOptions"
                  :key="option.id"
                  data-role="pipeline-status-menu-option"
                  data-context="pipeline-status-menu-option"
                  :data-status="option.id"
                  :data-empty="option.count === 0 || undefined"
                  role="menuitemradio"
                  block
                  :tone="option.tone"
                  variant="ghost"
                  :aria-checked="activeStatus === option.id"
                  @click="setStatus(option.id); close('action')"
                >
                  <span class="status-menu-option-copy">
                    <span class="status-dot" :data-tone="option.tone" aria-hidden="true"></span>
                    <span>{{ option.label }}</span>
                    <b class="status-count mono">{{ option.count }}</b>
                  </span>
                </UiButton>
              </div>
            </template>
          </UiPopover>
        </div>

        <div class="compact-view-controls" role="group" aria-label="Вид карточек">
          <UiIconButton
            data-option="loops"
            data-context="pipeline-view"
            role="peer"
            tone="accent"
            variant="ghost"
            :pressed="loopsOn"
            :disabled="compact"
            label="Показывать все возвраты"
            v-tooltip="compact
              ? 'Возвраты доступны в подробном виде'
              : 'Показывать все возможные возвратные связи на схемах'"
            @click="toggleLoops(!loopsOn)"
          >
            <svg class="toolbar-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M7 7h10l-2.5-2.5M17 17H7l2.5 2.5M17 7a5 5 0 0 1 0 10M7 17a5 5 0 0 1 0-10" />
            </svg>
          </UiIconButton>
          <UiIconButton
            data-option="compact"
            data-context="pipeline-view"
            role="peer"
            tone="accent"
            variant="ghost"
            :pressed="compact"
            label="Компактный вид"
            v-tooltip="'Сворачивать все карточки до краткой сводки'"
            @click="toggleCompact(!compact)"
          >
            <svg class="toolbar-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M5 7h14M5 12h14M5 17h14" />
            </svg>
          </UiIconButton>
        </div>
      </div>
    </div>

    <UiLoadingState v-if="!loaded && !error" label="Загрузка…" variant="cards" />
    <p v-else-if="error" class="err">Ошибка: {{ error }}</p>
    <p v-else-if="!tasks.length" class="muted">Задач в состоянии фабрики нет.</p>
    <div v-else-if="!filteredTasks.length" class="filter-empty">
      <span>По выбранным фильтрам задач нет.</span>
      <UiButton tone="accent" variant="text" @click="resetStatusFilter">
        Показать все состояния
      </UiButton>
    </div>

    <article v-for="t in filteredTasks" :key="t.task" class="card" :class="[t.readOnly ? 'readonly' : cardState(t.graph), { collapsed: isCollapsed(t.task) }]">
      <header class="head">
        <UiIconButton
          v-if="!compact"
          class="chev"
          role="rail"
          :label="isCollapsed(t.task) ? 'Развернуть' : 'Свернуть'"
          v-tooltip="isCollapsed(t.task) ? 'Развернуть' : 'Свернуть'"
          @click="toggleCard(t.task)"
        >
          {{ collapsedSet.has(t.task) ? '▸' : '▾' }}
        </UiIconButton>
        <UiButton
          class="task mono"
          data-role="pipeline-task-id"
          v-tooltip="'Свернуть/развернуть'"
          variant="text"
          @click="toggleCard(t.task)"
        >
          #{{ t.task }}
        </UiButton>
        <span class="route">{{ ROUTE_ICON[t.route || ''] || '•' }} {{ t.route }}</span>
        <UiButton
          v-if="t.source === 'grigdesk' || b24Title(t.task)"
          class="ctitle"
          data-role="pipeline-title"
          v-tooltip="title(t)"
          variant="text"
          @click="ui.openTask(t.task)"
        >
          {{ title(t) }}
        </UiButton>
        <span
          v-else-if="title(t)"
          class="ctitle pipeline-title-static ticket"
          v-tooltip="title(t)"
        >
          {{ title(t) }}
        </span>
        <span v-else class="ctitle pipeline-title-static muted">
          <UiSpinner decorative /> загрузка названия…
        </span>
        <span class="daemon" :class="t.readOnly ? 'idle' : (t.stall ? 'stall' : (t.daemonAlive ? 'alive' : 'idle'))">
          {{ t.readOnly ? '◌ только чтение' : t.stall ? (t.stall.kind === 'crashed' ? '✖ оборвалась' : '🛑 встала') : (t.daemonAlive ? '● идёт' : '○ стоит') }}
        </span>
        <span
          v-if="b24TimerState(t)"
          class="b24-timer mono"
          :class="b24TimerState(t)"
          data-role="pipeline-b24-timer"
          :data-state="b24TimerState(t)"
          v-tooltip="'Таймер Битрикс24 по этой задаче'"
        >
          {{ b24TimerLabel(t) }}
        </span>
        <!-- Чистая работа узлов: все петли входят, ожидание человека на воротах — нет. -->
        <span v-if="t.graph.timing" class="elapsed mono" v-tooltip="elapsedTitle(t)">⏱ {{ elapsedLabel(t) }}</span>
      </header>

      <div class="progress">
        <div class="pbar-wrap">
          <div class="pbar" :class="progressClass(t.graph)"
               :style="{ width: (t.graph.progress.done / t.graph.progress.total * 100) + '%' }"></div>
        </div>
        <span class="pnum mono">{{ t.graph.progress.done }}/{{ t.graph.progress.total }}</span>
        <span class="pw">{{ currentLabel(t.graph) }}</span>
      </div>

      <LoopStatus v-if="!t.stall || !isCollapsed(t.task)" :graph="t.graph" />

      <!-- Ждёт тебя (видно и в свёрнутом виде) -->
      <div v-if="!t.readOnly && waitingReason(t.graph)" class="waitme" :class="{ premature: waitingReason(t.graph)!.premature }">
        ⏳ ждёт тебя: {{ waitingReason(t.graph)!.text }}
        <span v-if="waitingReason(t.graph)!.premature" class="pm">(преждевременно — хвост не доделан)</span>
      </div>

      <PipelineStopPanel
        v-if="!t.readOnly && t.stall"
        :view="graphStallView(t.graph, t.stall)"
        :identity="`${t.task}:${t.attempt}:${t.stall.since || ''}`"
        :collapsed="isCollapsed(t.task)"
        :arbitrating="t.arbitrating"
        :arbiter-note="t.stall.arbiter ? arbiterCardLabel(t.stall.arbiter) : ''"
        :arbiter-model="t.stall.arbiter?.model"
        :arbiter-verdict="t.stall.arbiter?.verdict"
        :conversation="t.stall.conversation"
      >
        <PipelineCardActions :actions="cardActions(t)" @action="(id) => runCardAction(t, id)" />
      </PipelineStopPanel>

      <div v-if="!isCollapsed(t.task)" class="gwrap">
        <FactoryGraph
          :graph="t.graph"
          :show-stop-banner="t.readOnly || !t.stall"
          :loops-on="loopsOn"
          :arbitrating="t.arbitrating"
          :arbitrated="arbitratedNodes(t.graph)"
          @node="(n) => openStage(t, n)"
        />
      </div>

      <footer v-if="!isCollapsed(t.task) || !t.stall" class="strip">
        <template v-if="!isCollapsed(t.task)">
        <span v-if="t.graph.fePort" class="chunk">
          <span class="sdot" :class="t.daemonAlive ? 'on' : 'off'"></span>
          стенд · <a :href="sandboxUrl(t.graph.fePort, t.graph.serviceHost) || undefined"
                     target="_blank" rel="noopener">фронт :{{ t.graph.fePort }}</a>
          <a v-if="t.graph.apiPort" :href="sandboxUrl(t.graph.apiPort, t.graph.serviceHost) || undefined"
             target="_blank" rel="noopener">API :{{ t.graph.apiPort }}</a>
        </span>
        <!-- Стенд ещё строится: живой прогресс сборки песочницы из t*.stage -->
        <span v-else-if="t.graph.sandbox" class="chunk building">
          <UiSpinner decorative />
          стенд строится · {{ t.graph.sandbox.step }}/{{ t.graph.sandbox.total }} · {{ t.graph.sandbox.label }}
        </span>
        <span v-if="loopList(t.graph).length" class="chunk warn">↻ возвраты: {{ loopList(t.graph).join(', ') }}</span>
        <span v-if="t.graph.halted && !t.stall" class="chunk halted">
          ⚠ застряла на {{ stripEmoji(t.graph.nodes[t.graph.halted]?.[1]) || t.graph.halted }}
        </span>
        </template>
        <PipelineCardActions
          v-if="!t.stall"
          :actions="cardActions(t)"
          @action="(id) => runCardAction(t, id)"
        />
      </footer>
    </article>

    <!-- Таймеры вне фабрики: активные задачи B24, которых нет на конвейере -->
    <section v-if="outsideTimers.length" class="outside">
      <h3 class="ttl">Таймер идёт вне фабрики</h3>
      <div v-for="t in outsideTimers" :key="t.id" class="orow">
        <span class="oid mono">#{{ t.id }}</span>
        <UiButton
          class="otitle"
          data-role="pipeline-title"
          variant="text"
          @click="ui.openTask(t.id)"
        >
          {{ t.title }}
        </UiButton>
        <span class="otimer mono">⏱ {{ secToHMS(outsideElapsed(t)) }}</span>
      </div>
    </section>

    <!-- Модалка этапа (клик по узлу графа): инфо + управление -->
    <UiDialog
      :open="Boolean(stage)"
      class="smodal"
      data-role="pipeline-stage"
      size="workspace"
      :label="stage?.label || 'Этап конвейера'"
      :body-inset="false"
      fade-only
      @update:open="onStageDialogOpenChange"
    >
        <header class="sh">
          <div class="shead-copy">
            <span class="shead-kicker">Этап конвейера</span>
            <h3 id="stage-modal-title">{{ stage!.label }}</h3>
          </div>
          <!-- Статус этапа и признак жизни хода — один вопрос человека («этап идёт
               или встал?»), поэтому они стоят рядом. Раньше ответ был разнесён по двум
               полосам: бейдж в шапке, «нет событий 28 мин» — строкой ниже среди чипов. -->
          <div class="shead-state">
            <span v-if="stageActivity" class="smchip jf" :class="{ on: stageActivity.journalFresh }">{{
              agentActivityLabel(stageActivity)
            }}</span>
            <span class="sbadge" :class="stageArbitrating ? 'arb' : stage!.status">{{
              stageArbitrating ? 'арбитр разбирает' : stageStatusHint(stage!)
            }}</span>
          </div>
          <UiIconButton
            class="sx"
            data-context="pipeline-stage-close"
            label="Закрыть этап"
            v-tooltip="'Закрыть (Esc)'"
            @click="closeStage()"
          >
            ✕
          </UiIconButton>
        </header>

        <!-- Разбор ИДЁТ. Стоит первой строкой тела: узел открывают с вопросом «что от
             меня хотят», и пока арбитр читает код, честный ответ — «сейчас ничего».
             Ниже по модалке остаются и вердикт узла, и кнопки: решение арбитра можно
             не дожидаться, но делать это следует осознанно. -->
        <div v-if="stageArbitrating" class="sarbrun sarbnode">
          <span class="sarbspin" aria-hidden="true"></span>
          <span class="sarbtxt">Арбитр разбирает эту остановку — ожидается результат</span>
          <span class="sarbmeta mono">{{ arbiterRunLabel(stageArbitrating) }}</span>
        </div>

        <!-- Контекст решения: задачу и её стенд видно, пока ворота открыты. Ссылки те же,
             что в подвале карточки конвейера; нового действия или отдельного API здесь нет. -->
        <div id="stage-task-context" class="stage-context">
          <div class="stage-task-context">
            <span class="stage-context-label">Задача <b class="mono">#{{ stage!.task }}</b></span>
            <span v-if="stageTaskTitle" class="stage-task-title" v-tooltip="stageTaskTitle">{{ stageTaskTitle }}</span>
            <span v-else class="stage-task-title muted">Название загружается…</span>
          </div>
          <div class="stage-stand-context">
            <span class="stage-context-label">Стенд</span>
            <template v-if="stageGraph?.fePort">
              <a class="stage-stand-link" :href="sandboxUrl(stageGraph.fePort, stageGraph.serviceHost) || undefined"
                 target="_blank" rel="noopener">
                Фронт <b class="mono">:{{ stageGraph.fePort }}</b> <span aria-hidden="true">↗</span>
              </a>
              <a v-if="stageGraph.apiPort" class="stage-stand-link" :href="sandboxUrl(stageGraph.apiPort, stageGraph.serviceHost) || undefined"
                 target="_blank" rel="noopener">
                API <b class="mono">:{{ stageGraph.apiPort }}</b> <span aria-hidden="true">↗</span>
              </a>
            </template>
            <span v-else-if="stageGraph?.sandbox" class="stage-stand-state building">
              <UiSpinner decorative />
              строится · {{ stageGraph.sandbox.step }}/{{ stageGraph.sandbox.total }} · {{ stageGraph.sandbox.label }}
            </span>
            <span v-else class="stage-stand-state">не поднят</span>
          </div>
        </div>

        <div v-if="stageUsesConversation" class="sconversation">
          <ArbiterConversation :task="String(stage!.task)" :node="stage!.id"
                               :conversation-id="stageConversationId" :legacy-card="stageArbiterCard"
                               :history="stageGraph?.arbiterConversations"
                               @current-stop="openStallStage(stageTask!)" />
        </div>
        <div v-else-if="stageHasMain || stageHasRail" class="sworkspace"
             :class="{ 'main-only': stageHasMain && !stageHasRail, 'rail-only': stageHasRail && !stageHasMain }">
          <!-- Управление стоит первым в DOM: в мобильной колонке решение человека не
               прячется под длинной телеметрией. На широком экране CSS ставит его справа. -->
          <aside v-if="stageHasRail" class="srail">
            <!-- Ситуация: чем закончился заход и что от человека нужно. Стоит В ОДНОЙ
                 колонке с решением и прямо над ним — это его условие, а не справка.
                 Раньше причина занимала три полосы шапки, у каждой был свой потолок высоты
                 и свой скролл: замер модалки 1230x898 показал 409 px преамбулы против 430 px
                 рабочей области, причём «почему этап остановился» обрезалось посреди фразы. -->
            <div v-if="stageHasSituation" class="sect situation-sect">
              <div class="secth">Что случилось</div>
              <!-- Разбор арбитра здесь — ПРИЗНАК со входом, а не текст. Узел отвечает на
                   вопрос «чем занят исполнитель и чем кончился заход», разбор — на «что мне
                   решить»; вместе они не поместились: четыре его абзаца делили колонку с
                   причиной остановки, находками и формой, а длинный путь в «чем проверял»
                   растягивал её в горизонтальный скролл. Текст и решение — своей модалкой. -->
              <div v-if="stageArbiterCard" class="sarbnote sarbopen" :class="stageArbiterCard.verdict">
                <span class="sarbicon" aria-hidden="true">⚖</span>
                <span class="sarbnote-text">{{ arbiterCardLabel(stageArbiterCard) }}</span>
                <UiButton
                  class="sarbmore"
                  data-role="pipeline-stage-arbiter-open"
                  variant="text"
                  tone="warning"
                  @click="openArbiterFromStage()"
                >
                  разбор и решение
                </UiButton>
              </div>
              <div v-if="stage!.meta.stall" class="scomment failed">
                <span class="sclbl">Почему этап остановился</span>
                <b>{{ stage!.meta.stall.title }}</b>
                <div>{{ stage!.meta.stall.hint }}</div>
              </div>
              <!-- Что узел СКАЗАЛ, закрывая заход: типизированные находки с якорями на файлы.
                   Блокирующие уезжают отсюда, когда ниже стоит форма возврата: там у каждой
                   своё поле ответа, и вторая копия того же текста показывала человеку один
                   вопрос дважды на одном экране. Текст пишет агент, поэтому только
                   интерполяция: `v-html` здесь запрещён. -->
              <div
                v-if="verdictFindings.length && !stage!.meta.bootstrapStop"
                class="sverdict"
                :class="{ human: stage!.meta.verdict!.stop === 'human' && !verdictDeferredOnly }"
              >
                <div class="svhead">
                  <span class="sclbl">{{ verdictLabel(stage!.meta.verdict!, verdictDeferredOnly) }}</span>
                </div>
                <ul class="svlist">
                  <li
                    v-for="(f, i) in verdictFindings"
                    :key="f.id || i"
                    :class="f.severity"
                  >
                    <span v-if="f.anchor" class="svanchor mono" v-tooltip="f.anchor">{{ shortAnchor(f.anchor) }}</span>
                    <span class="svsum">{{ f.summary }}</span>
                  </li>
                </ul>
                <div v-if="stage!.meta.verdict!.omitted" class="svmore">
                  …и ещё {{ stage!.meta.verdict!.omitted }} — остальные в журнале попытки
                </div>
              </div>
              <div v-if="stage!.meta.comment" class="snotices">
                <div
                  class="scomment"
                  :class="{ failed: ['skipbad', 'stall'].includes(stage!.status) }"
                >
                  <span class="sclbl">{{ stageCommentLabel(stage!) }}</span>
                  {{ stage!.meta.comment }}
                </div>
              </div>
            </div>

            <BootstrapDecision
              v-if="stage!.meta.bootstrapStop && !stageTask?.readOnly"
              :task="stageTask!.task"
              :profile="stageTask!.profile"
              :attempt="stageTask!.attempt == null ? undefined : String(stageTask!.attempt)"
              :stop="stage!.meta.bootstrapStop"
              :running="stageTask!.daemonAlive"
              @changed="load"
            />
            <DeferredFindings
              v-if="stage!.id === 'gate_accept' && !stage!.readOnly"
              :task="stage!.task"
              :profile="stageTask?.profile"
              :attempt="stageTask?.attempt == null ? undefined : String(stageTask.attempt)"
              @ready="stageFindingsReady = $event"
            />

            <!-- Ворота: принять/отклонить. Поле пояснения принадлежит ОТКЛОНЕНИЮ и
                 раскрывается по кнопке: при принятии текст никуда не уходит. -->
            <div v-if="gateDecidable" class="sect gate-sect">
              <div class="secth">Ворота — твоё решение</div>
              <!-- Что арбитр решил за человека по дороге. Ворота — единственная точка его
                   контроля, а карточка разбора живёт в плашке ОСТАНОВКИ, которой здесь нет.
                   Без этой сводки он принимал бы план и результат, не зная, какие развилки
                   закрыли без него. Первым идёт решение о границе задачи: оно требует
                   проверки сильнее, чем снятый технический тупик. -->
              <div v-if="gateArbiterLog.length" class="gwal">
                <div class="gwalh">Решено арбитром, пока тебя не звали</div>
                <div v-for="(row, i) in gateArbiterLog" :key="i" class="gwrow" :class="row.verdict">
                  <span class="gwtag">{{ row.verdict === 'deferred' ? 'за тебя' : 'тупик' }}</span>
                  <span class="gwwhat">{{ row.card!.what }}</span>
                </div>
                <p class="gate-hint">Не согласен — отклони ворота либо верни конвейер
                  на нужный узел: решение арбитра отменяется тем же возвратом.</p>
              </div>
              <template v-if="gateRejecting">
                <label class="gate-lbl" for="gate-note">Что доработать</label>
                <UiTextarea
                  id="gate-note"
                  ref="gateNoteEl"
                  v-model="gateComment"
                  data-role="pipeline-stage-note"
                  rows="6"
                  placeholder="Что не так и что сделать иначе"
                />
                <p class="gate-hint">Текст станет заданием агенту на следующем заходе — целиком, вместе с разметкой и абзацами (до 20 000 символов). Можно и без него — тогда узел вернётся без пояснения.</p>
                <div class="gbtns">
                  <UiButton
                    class="btn bad"
                    tone="danger"
                    variant="solid"
                    :loading="stageBusy === 'gate'"
                    :disabled="stageBusy === 'gate'"
                    loading-label="Отправляю на доработку"
                    @click="gateDecide('reject')"
                  >
                    ✗ Отправить на доработку
                  </UiButton>
                  <UiButton
                    class="btn"
                    :disabled="stageBusy === 'gate'"
                    @click="cancelGateReject()"
                  >
                    Отмена
                  </UiButton>
                </div>
              </template>
              <template v-else>
                <p class="gate-hint">Принять — маршрут пойдёт дальше. Отклонить — вернём агенту, там же напишешь, что доработать.</p>
                <div class="gbtns">
                  <UiButton
                    class="btn good"
                    tone="success"
                    variant="solid"
                    :loading="stageBusy === 'gate'"
                    :disabled="stageBusy === 'gate' || (stage!.id === 'gate_accept' && !stageFindingsReady)"
                    loading-label="Принимаю решение"
                    @click="gateDecide('approve')"
                  >
                    ✓ Принять
                  </UiButton>
                  <UiButton
                    class="btn bad"
                    tone="danger"
                    variant="solid"
                    :disabled="stageBusy === 'gate'"
                    @click="startGateReject()"
                  >
                    ✗ Отклонить
                  </UiButton>
                </div>
              </template>
            </div>

            <!-- Возврат на узел. Своя секция рядом с отправляющей его кнопкой. -->
            <div v-if="stageHasRewind" class="sect rewind-sect">
              <div class="secth">Вернуть конвейер сюда</div>
              <p class="gate-hint">Результаты этого узла и всех следующих за ним будут сброшены. Указание движок подмешает в промпт захода.</p>
              <!-- Вопросы узла — своими полями. Агент вернул их СТРУКТУРНО (у каждого свой
                   id и формулировка), а ответить можно было только сплошным текстом: человек
                   руками восстанавливал нумерацию, а агент получал сплошняк вместо ответа,
                   привязанного к его же вопросу. Поля появляются только у блокирующих
                   находок: отложенные вопросом к человеку не являются. -->
              <div v-if="rewindQuestions.length" class="rwq">
                <div class="rwqhead">Ответы на вопросы узла</div>
                <div v-for="(q, i) in rewindQuestions" :key="q.id" class="rwqitem">
                  <label class="rwqlbl" :for="`rwq-${i}`">
                    <span class="rwqnum">{{ i + 1 }}</span>
                    <span class="rwqsum">
                      {{ q.summary }}
                      <!-- Якорь ушёл сюда вместе с самой находкой: без него человек знает,
                           ЧТО не так, но не знает где, а второго списка находок больше нет. -->
                      <span v-if="q.anchor" class="svanchor mono" v-tooltip="q.anchor">{{ shortAnchor(q.anchor) }}</span>
                    </span>
                  </label>
                  <UiTextarea
                    :id="`rwq-${i}`"
                    v-model="rewindAnswers[q.id]"
                    data-role="pipeline-stage-note"
                    rows="2"
                    placeholder="Ответ на этот вопрос"
                  />
                </div>
              </div>
              <label v-if="rewindQuestions.length" class="rwqlbl rwqfree" for="rewind-free">
                Что ещё сказать агенту
              </label>
              <UiTextarea
                id="rewind-free"
                v-model="rewindComment"
                data-role="pipeline-stage-note"
                :rows="rewindQuestions.length ? 4 : 8"
                :placeholder="rewindQuestions.length
                  ? 'Необязательно: остальное по задаче'
                  : 'Указание агенту — что сделать иначе (необязательно)'"
              />
              <UiButton
                class="btn play"
                tone="warning"
                variant="outline"
                block
                :loading="stageBusy === 'force'"
                :disabled="stageBusy === 'force'"
                loading-label="Возвращаю конвейер"
                @click="forceStatus('running')"
              >
                ▶ Перейти сюда
              </UiButton>
            </div>
          </aside>

          <main v-if="stageHasMain" class="smain">
            <!-- Телеметрия захода: время, длительность, расход. Живёт рядом с исполнителем,
                 которому принадлежит, а не полосой в шапке — вопрос «что от меня хотят»
                 она не решает, а место занимала всегда, даже когда сообщать было нечего. -->
            <div v-if="stageHasMeta" class="smeta" aria-label="Показатели этапа">
              <span v-if="stage!.meta.at" class="smchip mono">{{ stage!.meta.at.slice(11, 16) || stage!.meta.at }}</span>
              <span v-if="stage!.meta.dur != null" class="smchip">{{ stage!.meta.dur }} мин</span>
              <!-- Ноль субагентов не сообщает ничего: заход без них — обычное дело, а чип
                   ради нуля занимал всю полосу метаданных. То же правило, что у отказов прав. -->
              <span v-if="stage!.meta.fanout" class="smchip">{{ stage!.meta.fanout }} субаг.</span>
              <!-- Отказ политики прав показываем ТОЛЬКО когда он был: ноль и «не знаем»
                   одинаково означают «беспокоиться не о чем», а нулевой чип в каждой строке
                   обесценил бы ненулевой. Он предупреждает о подмене проверки: агент, которому
                   запретили нужный запуск, склонен подобрать похожий и выдать его результат за
                   доказательство. -->
              <span v-if="stage!.meta.denials" class="smchip failed"
                v-tooltip="'Отказов политики прав внутри хода. Проверь, не подменил ли агент запрещённую проверку похожей.'">
                {{ stage!.meta.denials }} отказ. прав</span>
              <span v-if="stage!.meta.tokens" class="smchip mono">{{ stage!.meta.tokens.toLocaleString('ru') }} ток.</span>
              <span v-if="stage!.meta.fails" class="smchip failed">{{ stage!.meta.fails }} возвр.</span>
              <span v-if="stage!.sub" class="smchip">{{ stage!.sub }}</span>
              <span v-if="stage!.meta.verdict?.reviewed?.length" class="smchip"
                v-tooltip="stage!.meta.verdict!.reviewed.join('\n')">
                просм. файлов: {{ stage!.meta.verdict!.reviewed.length }}</span>
            </div>

            <!-- Выбор исполнителя этапа + та runner-chain, по которой движок принимает решение. -->
            <div v-if="stage!.meta.runner" class="sect runner-sect">
              <div class="secth">
                Исполнитель
                <span class="runner-source">{{ RUNNER_SOURCE[stage!.meta.runner.source || ''] || stage!.meta.runner.source }}</span>
              </div>
              <!-- Главное действие узла: выбрать исполнителя одним кликом, не закрывая модалку. -->
              <div v-if="!stage!.readOnly && !stageRunnerLive && stageRunnerOptions.length" class="runner-override">
                <div class="runner-override-row">
                  <span class="runner-override-lbl">Исполнитель этапа</span>
                  <UiButton
                    v-if="stage!.meta.runner.source === 'task-stage'"
                    class="btn runner-reset"
                    data-role="pipeline-compact-action"
                    variant="text"
                    tone="warning"
                    :disabled="stageBusy === 'runner-override'"
                    @click="setStageRunner('')"
                  >
                    Сбросить
                  </UiButton>
                </div>
                <div class="runner-picks">
                  <UiButton
                    v-for="id in stageRunnerOptions"
                    :key="id"
                    class="runner-pick"
                    :class="{ on: id === stageRunnerActive, busy: runnerPending === id }"
                    data-role="pipeline-runner"
                    tone="accent"
                    variant="outline"
                    :pressed="id === stageRunnerActive"
                    :loading="runnerPending === id"
                    :disabled="stageBusy === 'runner-override'"
                    :loading-label="`Выбираю ${providerLabel(id)}`"
                    @click="pickStageRunner(id)"
                  >
                    <b>{{ providerLabel(id) }}</b>
                    <small v-if="runnerModelEffortLabel(stage!.meta.runner, id)">{{ runnerModelEffortLabel(stage!.meta.runner, id) }}</small>
                  </UiButton>
                </div>
                <p v-if="stage!.meta.runner.source === 'task-stage'" class="runner-hint">
                  Сброс вернёт этап к исполнителю, заданному при запуске задачи, а без него — к политике профиля.
                </p>
                <p v-if="stage!.status === 'run' && !stage!.daemonAlive" class="runner-hint">
                  Прогон остановлен — выбранный исполнитель запустится после «Продолжить прогон».
                </p>
              </div>
              <!-- Цепочка вторична: она объясняет, кто подхватит этап при аварии, и решения не требует. -->
              <div class="runner-chain">
                <span class="runner-chain-lbl">цепочка</span>
                <template v-for="(id, i) in stage!.meta.runner.chain" :key="id">
                  <span v-if="i" class="runner-arrow">→</span>
                  <span class="runner-hop"
                        :class="{ actual: id === stage!.meta.runner.actual, reserve: i > 0 }"
                        v-tooltip="i
                          ? 'резерв: подхватит этап, если основной отпадёт'
                          : 'основной исполнитель'">
                    {{ providerLabel(id) }}
                    <small v-if="runnerModelEffortLabel(stage!.meta.runner, id)">{{ runnerModelEffortLabel(stage!.meta.runner, id) }}</small>
                  </span>
                </template>
              </div>
              <div v-if="stage!.meta.runner.actual" class="runner-current"
                   :class="{ switched: stage!.meta.runner.switched }">
                Сейчас: <b>{{ runnerNodeLabel(stage!.meta.runner) }}</b>
                <span v-if="stage!.meta.runner.reason"> · {{ runnerReasonLabel(stage!.meta.runner.reason) }}</span>
              </div>
              <div v-if="stage!.meta.runner.attempts?.length" class="runner-attempts">
                <div class="runner-attempt-title">Попытки запуска</div>
                <div v-for="a in stage!.meta.runner.attempts" :key="a.id" class="runner-attempt">
                  <span class="mono">#{{ a.epoch ?? '—' }}</span>
                  <b>{{ providerLabel(a.runner) }}</b>
                  <span v-if="runnerAttemptModelLabel(a)" class="runner-attempt-model mono">{{ runnerAttemptModelLabel(a) }}</span>
                  <span v-if="attemptCostLabel(a)" class="runner-attempt-cost mono"
                        v-tooltip="attemptCostTitle(a)">{{ attemptCostLabel(a) }}</span>
                  <span class="runner-result" :class="{
                    success: a.result === 'ok',
                    switched: a.result === 'manual_switch',
                    failed: a.result && !['ok', 'manual_switch'].includes(a.result),
                  }">
                    {{ attemptResultLabel(a.result) }}
                  </span>
                </div>
              </div>
              <div v-if="!stage!.readOnly && stageRunnerLive" class="runner-switches">
                <UiButton
                  v-for="id in stage!.meta.runner.chain.filter((x) => x !== stage!.meta.runner!.actual)"
                  :key="id"
                  class="btn runner-switch"
                  tone="warning"
                  variant="outline"
                  :loading="stageBusy === 'runner-switch'"
                  :disabled="stageBusy === 'runner-switch'"
                  :loading-label="`Переключаю на ${providerLabel(id)}`"
                  @click="switchRunner(id)"
                >
                  Переключить сейчас на {{ providerLabel(id) }}
                </UiButton>
              </div>
            </div>

            <!-- Живая лента действий агента (для идущего этапа) -->
            <div v-if="stage!.status === 'run' && stageActivity?.live" class="sect content-sect">
              <div class="secth"><span class="live-dot"></span> Агент сейчас</div>
              <div v-if="stageActivity.live.actions.length" class="live-feed" ref="liveFeed">
                <div v-for="(a, i) in stageActivity.live.actions" :key="i" class="lf-row" :class="a.status">
                  <span class="lf-icon">{{ liveIcon(a) }}</span>
                  <span class="lf-body">
                    <template v-if="a.type === 'tool' || a.type === 'subagent'">
                      <span class="lf-name">{{ a.name }}</span>
                      <span v-if="a.desc" class="lf-desc">{{ a.desc }}</span>
                      <span v-if="a.type === 'subagent' && a.tokens" class="lf-sub mono">{{ (a.tokens / 1000).toFixed(1) }}k ток · {{ a.tools }} инстр.{{ a.lastTool ? ' · ' + a.lastTool : '' }}</span>
                    </template>
                    <template v-else>
                      <span class="lf-text">{{ a.text }}</span>
                    </template>
                  </span>
                  <span class="lf-st" :class="a.status">{{ a.status === 'run' ? '●' : a.status === 'error' ? '✗' : '✓' }}</span>
                </div>
              </div>
              <p v-else class="muted small">Ожидание действий агента…</p>
              <div v-if="stageActivity.live.model" class="lf-model mono">{{ stageActivity.live.model }}</div>
            </div>

            <!-- Журнал этапов (stages.log) — сворачиваемый -->
            <div v-if="stage!.status === 'run' && stageActivity?.tail?.length" class="sect content-sect">
              <UiDisclosureButton
                class="stage-disclosure"
                data-role="pipeline-section-disclosure"
                controls="pipeline-stage-log"
                density="compact"
                :open="stageLogOpen"
                @update:open="stageLogOpen = $event"
              >
                Журнал этапов
                <span class="muted small" style="margin-left:auto">{{ stageActivity.tail.length }}</span>
              </UiDisclosureButton>
              <div v-if="stageLogOpen" id="pipeline-stage-log" class="log">
                <div v-for="(l, i) in stageActivity.tail" :key="i" class="logline"><span class="mono muted">{{ l.ts.slice(11) }}</span> {{ l.event }}</div>
              </div>
            </div>

            <!-- Документ этапа: план у ворот плана, диагноз у ворот причины, отчёт на приёмке -->
            <div v-if="stageDocLoading" class="sect content-sect">
              <div class="secth">Документ этапа</div>
              <UiLoadingState label="Документ этапа" variant="document" />
            </div>
            <div v-else-if="stageDoc" class="sect content-sect document-sect">
              <UiDisclosureButton
                class="stage-disclosure"
                data-role="pipeline-section-disclosure"
                controls="pipeline-stage-document"
                density="compact"
                :open="stageDocOpen"
                @update:open="stageDocOpen = $event"
              >
                Документ этапа
              </UiDisclosureButton>
              <div
                v-if="stageDocOpen"
                id="pipeline-stage-document"
                class="sdoc md"
                v-html="mdToHtml(stageDoc)"
              ></div>
            </div>
          </main>
        </div>

        <!-- Универсальные действия закреплены внизу и не уезжают за длинным документом. -->
        <footer class="sactions">
          <span class="sactions-context"><b class="mono">#{{ stage!.task }}</b> · действия с задачей</span>
          <div class="sactions-buttons">
            <OpenDiffButton :task-id="stage!.task" />
          </div>
        </footer>
    </UiDialog>

  </div>
</template>

<script setup lang="ts">
import DeferredFindings from './pipeline/DeferredFindings.vue';
import BootstrapDecision from './pipeline/BootstrapDecision.vue';
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { api } from '../shared/apiClient.ts';
import { isRecord } from '../../../shared/lib/objects.ts';
import { errorMessage } from '../../../shared/lib/errors.ts';
import {
  decodePipelineTasks, decodePipelineViewGraph, decodeFactoryRunners,
  decodePipelineActivity, decodePipelineReply,
} from '../shared/pipelineContracts.ts';
import type {
  PipelineViewTask, PipelineViewGraph, PipelineNotice, TaskObservation,
  NodeMetadata, NodeVerdict, ArbiterCard, PipelineActivity, PipelineReply,
} from '../shared/pipelineContracts.ts';
import type { BoardTask } from '../shared/boardContracts.ts';

type TaskId = string | number;
interface Stage {
  task: TaskId;
  id: string;
  key: string;
  runnerKey: string;
  isGate: boolean;
  label: string;
  sub?: string;
  readOnly: boolean;
  daemonAlive: boolean;
  status: string;
  meta: NodeMetadata;
}
interface StageNode {
  id: string;
  label: string;
  subtitle?: string;
  status: string;
}

import { useSse } from '../composables/useSse.ts';
import { useUiContextSource } from '../composables/useUiContextSource.ts';
import { useUiStore } from '../stores/ui.ts';
import { useTasksStore } from '../stores/tasks.ts';
import { useBoardStore } from '../stores/board.ts';
import { liveTimerSec, pipelineWorkSec, secToHMS } from '../shared/format.ts';
import { mdToHtml } from '../shared/md.ts';
import {
  alertDialog,
  confirmDialog,
  UiButton,
  UiDialog,
  UiDisclosureButton,
  UiIconButton,
  UiPopover,
  UiSpinner,
  UiTextarea,
  vTooltip,
  UiLoadingState,
  t as translate,
} from '../ui';
import { sandboxUrl } from '../shared/sandbox.ts';
import { agentActivityLabel, silenceReason } from '../../../shared/pipeline/agentActivity.ts';
import { arbiterRunLabel, nodeIsArbitrated } from '../shared/arbiterRun.ts';
import { buildRewindNote, rewindQuestionsOf } from '../shared/rewindNote.ts';
// «Ждёт тебя» и подписи узлов — общие с чипом в навигации и оповещениями:
// цифра на чипе обязана сходиться с тем, что нарисовано на этой странице.
import { waitingReason, stripEmoji } from '../../../shared/pipeline/pipelineWait.ts';
import {
  pipelineBadgeSummary,
  pipelineTopbarItems,
} from '../shared/pipelineNavBadge.ts';
import {
  attemptCostLabel,
  attemptCostTitle,
  attemptResultLabel,
  providerLabel,
  runnerAttemptModelLabel,
  runnerModelEffortLabel,
  runnerNodeLabel,
  runnerReasonLabel,
} from '../shared/runnerDisplay.ts';
import ArbiterConversation from './pipeline/ArbiterConversation.vue';
import FactoryGraph from './pipeline/FactoryGraph.vue';
import PipelineStopPanel from './pipeline/PipelineStopPanel.vue';
import PipelineCardActions from './pipeline/PipelineCardActions.vue';
import { graphStallView } from '../shared/graphStall.ts';
import type { PipelineCardAction, PipelineCardActionId } from '../shared/pipelineCardActions.ts';
import LoopStatus from './pipeline/LoopStatus.vue';
import OpenDiffButton from './OpenDiffButton.vue';

const ui = useUiStore();
const taskStore = useTasksStore();
const board = useBoardStore();

const tasks = ref<PipelineViewTask[]>([]);
const error = ref<string | null>(null);
const loaded = ref(false);
const now = ref(Date.now());
const silenceWindow = ref(0);

// Тикет — обязательный вход route-прогона, поэтому его заголовок доступен и задачам
// без трекера. Живое название B24 оставляем приоритетным и только его делаем
// кликабельным: ручной тикет не должен открывать модалку несуществующей B24-задачи.
/**
 * Сохранённый список карточек проверяет контейнер до создания локального Set.
 * Ошибка JSON сохраняет прежний отказ, автоматического восстановления здесь нет.
 */
function collapsedCards(value: unknown): TaskId[] {
  if (!Array.isArray(value) || !value.every((id) => typeof id === 'string' || typeof id === 'number')) {
    throw new TypeError('Неверный список свёрнутых карточек');
  }

  return value;
}

function b24Title(taskNum: TaskId) {
  return taskStore.title(taskNum);
}


/**
 * Показывает живой заголовок B24 с запасным названием ручного тикета.
 * Числовой вход сначала связывается с текущим списком конвейера.
 */
function title(taskOrNum: PipelineViewTask | TaskId) {
  const taskNum = typeof taskOrNum === 'object' ? taskOrNum.task : taskOrNum;
  const task = typeof taskOrNum === 'object'
    ? taskOrNum
    : tasks.value.find((item) => Number(item.task) === Number(taskNum));

  return task?.source === 'grigdesk' ? task.title || null : b24Title(taskNum) || task?.title || null;
}

const boardTasksById = computed(() => new Map(
  (board.data?.tasks || []).map((task) => [Number(task.id), task]),
));

function boardTask(t: PipelineViewTask) {
  return boardTasksById.value.get(Number(t.task));
}

/**
 * Не превращаем отсутствие портальной задачи в ложное состояние «таймер стоит».
 * Статус существует только для явного булева значения из снимка доски.
 */
function b24TimerState(t: PipelineViewTask) {
  const timerRunning = boardTask(t)?.timerRunning;

  if (timerRunning === true) {
    return 'running';
  }
  if (timerRunning === false) {
    return 'stopped';
  }

  return null;
}


/**
 * Подписывает только явно известное состояние портального таймера.
 * Отсутствие задачи остаётся пустой подписью, а не остановленным таймером.
 */
function b24TimerLabel(t: PipelineViewTask) {
  const task = boardTask(t);

  if (!task || typeof task.timerRunning !== 'boolean') {
    return '';
  }

  return task.timerRunning
    ? `B24-таймер идёт · ${secToHMS(liveTimerSec(task, now.value))}`
    : 'B24-таймер стоит';
}

// Таймеры, идущие ВНЕ фабрики: активные задачи доски, которых нет на конвейере.
const factoryIds = computed(() => new Set(tasks.value.map((t) => Number(t.task))));
const outsideTimers = computed(() => {

  const d = board.data;

  if (!d) {
    return [];
  }

  return (d.tasks || []).filter((t) => (
    t.timerRunning && !factoryIds.value.has(Number(t.id))
  ));
});

function outsideElapsed(t: BoardTask) {
  return liveTimerSec(t, now.value);
}

// Чистая работа узлов конвейера (не путать с таймером B24). Для закреплённого маршрута
// сервер складывает фактические runner-запуски текущей попытки: паузы между ними и
// ожидание человека на воротах сюда не попадают.
function elapsedSec(t: PipelineViewTask) {
  return pipelineWorkSec(t.graph?.timing, now.value);
}


/**
 * Показывает длительность работы с признаком приблизительного расчёта.
 * Отсутствующая длительность не превращается в ноль.
 */
function elapsedLabel(t: PipelineViewTask) {
  const sec = elapsedSec(t);

  if (sec == null) {
    return '';
  }

  return `${t.graph?.timing?.approximate ? '≈' : ''}${secToHMS(sec)}`;
}


/**
 * Объясняет источник показанной длительности работы узлов.
 * Ожидание человека исключено при обоих поддерживаемых источниках.
 */
function elapsedTitle(t: PipelineViewTask) {
  if (t.graph?.timing?.source === 'runner-telemetry') {
    return 'фактическое время запущенных агентов текущей попытки: '
      + 'паузы между запусками и ожидание человека на воротах не входят';
  }

  return t.graph?.timing
    ? 'оценка по журналу маршрута: ожидание человека на воротах не входит'
    : '';
}

let ticker: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  ticker = setInterval(() => {
    now.value = Date.now();
  }, 1000);
});
onUnmounted(() => {
  if (ticker) {
    clearInterval(ticker ?? undefined);
  }

  clearInterval(actPoll ?? undefined);
  clearTimeout(stateReloadTimer ?? undefined);
});

// Тумблеры (переживают перезагрузку — как в старом дашборде).
const compact = ref(localStorage.getItem('grigdesk-compact') === '1');
const loopsOn = ref(localStorage.getItem('grigdesk-loops') === '1');

function toggleCompact(value: boolean) {
  compact.value = value;
  localStorage.setItem('grigdesk-compact', value ? '1' : '0');
}

function toggleLoops(value: boolean) {
  loopsOn.value = value;
  localStorage.setItem('grigdesk-loops', value ? '1' : '0');
}

// Две независимые оси фильтра: проект отвечает «где», состояние — «что требует внимания».
// Обе настройки локальны устройству, как компактный режим страницы.
const savedProject = localStorage.getItem('grigdesk-pipeline-project')
  || localStorage.getItem('grigdesk-project')
  || 'all';
const activeProject = ref(savedProject);

function setProject(project: string) {
  activeProject.value = project;
  localStorage.setItem('grigdesk-pipeline-project', project);
}

const projects = computed(() => [...new Set(
  tasks.value.map((t) => t.profile).filter((profile): profile is string => !!profile),
)]);
const projectCounts = computed(() => {
  const counts = new Map();

  for (const task of tasks.value) {
    if (task.profile) {
      counts.set(task.profile, (counts.get(task.profile) || 0) + 1);
    }
  }

  return counts;
});
const projectOptions = computed(() => [
  {
    id: 'all',
    label: 'Все',
    count: tasks.value.length,
  },
  ...projects.value.map((project) => ({
    id: project,
    label: project,
    count: projectCounts.value.get(project) || 0,
  })),
]);

// Тот же приём, что у адаптивных легенд графиков: скрытый ряд даёт натуральную
// ширину каждой кнопки, а ResizeObserver пересчитывает хвост без breakpoint-магии.
const projectStrip = ref<HTMLElement | null>(null);
const projectMeasure = ref<HTMLElement | null>(null);
const visibleProjectIds = ref<string[]>([]);
let projectResizeObserver: ResizeObserver | null = null;

const visibleProjectOptions = computed(() => {
  if (!visibleProjectIds.value.length) {
    return projectOptions.value;
  }

  const visible = new Set(visibleProjectIds.value);

  return projectOptions.value.filter((option) => visible.has(option.id));
});
const hiddenProjectOptions = computed(() => {
  const visible = new Set(visibleProjectOptions.value.map((option) => option.id));

  return projectOptions.value.filter((option) => !visible.has(option.id));
});


/**
 * Суммирует измеренные ширины выбранных кнопок в исходном порядке.
 * Промежуток добавляется только между присутствующими элементами.
 */
function projectWidth(ids: Set<string>, widths: Map<string, number>, gap: number) {
  let width = 0;
  let count = 0;

  for (const option of projectOptions.value) {
    if (!ids.has(option.id)) {
      continue;
    }
    if (count) {
      width += gap;
    }

    width += widths.get(option.id) || 0;
    count += 1;
  }

  return width;
}


/**
 * Оставляет в видимом ряду выбранный проект и доступные соседние кнопки.
 * Остальные проекты уходят в меню после измерения настоящей ширины DOM.
 */
function measureProjectStrip() {
  const strip = projectStrip.value;
  const measure = projectMeasure.value;

  // Без DOM сохраняем полный ряд кнопок. Реальная геометрия применяется,
  // когда браузер сообщает положительную ширину контейнера.
  if (!strip || !measure || strip.clientWidth <= 0) {
    visibleProjectIds.value = [];

    return;
  }

  const widths = new Map<string, number>();

  for (const element of measure.querySelectorAll<HTMLElement>('[data-project-measure]')) {
    widths.set(
      element.dataset.projectMeasure!,
      element.getBoundingClientRect().width || element.offsetWidth,
    );
  }

  const options = projectOptions.value;

  if (!options.length || widths.size !== options.length) {
    return;
  }

  const style = getComputedStyle(measure);
  const gap = Number.parseFloat(style.columnGap || style.gap) || 6;
  const available = strip.clientWidth;
  const everyId = new Set(options.map((option) => option.id));

  if (projectWidth(everyId, widths, gap) <= available) {
    visibleProjectIds.value = options.map((option) => option.id);

    return;
  }

  const more = measure.querySelector<HTMLElement>('[data-project-more-measure]');
  const moreWidth = more
    ? (more.getBoundingClientRect().width || more.offsetWidth)
    : 0;
  const budget = Math.max(0, available - moreWidth - gap);
  const selected = everyId.has(activeProject.value) ? activeProject.value : 'all';
  const chosen = new Set([selected]);

  // «Все» остаётся быстрым возвратом, пока вместе с выбранным проектом помещается.
  if (selected !== 'all') {
    const withAll = new Set(chosen).add('all');

    if (projectWidth(withAll, widths, gap) <= budget) {
      chosen.add('all');
    }
  }

  // Остаток заполняется в исходном порядке, но место выбранного уже зарезервировано:
  // проект, взятый из +N, не исчезает сразу после клика.
  for (const option of options) {
    if (chosen.has(option.id)) {
      continue;
    }

    const candidate = new Set(chosen).add(option.id);

    if (projectWidth(candidate, widths, gap) <= budget) {
      chosen.add(option.id);
    }
  }

  visibleProjectIds.value = options
    .filter((option) => chosen.has(option.id))
    .map((option) => option.id);
}

watch([projectOptions, activeProject], async () => {
  await nextTick();
  measureProjectStrip();
}, { flush: 'post' });

onMounted(async () => {
  await nextTick();
  measureProjectStrip();

  if (typeof ResizeObserver === 'function' && projectStrip.value) {
    projectResizeObserver = new ResizeObserver(measureProjectStrip);
    projectResizeObserver.observe(projectStrip.value);
  }
});
onUnmounted(() => {
  projectResizeObserver?.disconnect();
});

const projectTasks = computed(() => (activeProject.value === 'all'
  ? tasks.value
  : tasks.value.filter((task) => task.profile === activeProject.value)));

const STATUS_IDS = new Set(['all', 'running', 'waiting', 'error', 'inactive']);
const savedStatus = localStorage.getItem('grigdesk-pipeline-status') || 'all';
const activeStatus = ref(STATUS_IDS.has(savedStatus) ? savedStatus : 'all');

function setStatus(status: string) {
  activeStatus.value = STATUS_IDS.has(status) ? status : 'all';
  localStorage.setItem('grigdesk-pipeline-status', activeStatus.value);
}

// Строим ту же взаимоисключающую сводку, что чип навигации и popover топбара:
// проблема сильнее штатного ожидания, ожидание сильнее обычной работы.
const pipelineState = computed(() => {
  const state = {
    stalled: [] as PipelineNotice[],
    silent: [] as PipelineNotice[],
    waiting: [] as PipelineNotice[],
    running: [] as PipelineNotice[],
    observedByTask: {} as Record<string, Pick<TaskObservation, 'stage' | 'progress'>>,
  };

  for (const task of projectTasks.value) {
    const taskId = String(task.task);
    const taskTitle = title(task) || '';
    const wait = waitingReason(task.graph);
    const silence = silenceReason(task, silenceWindow.value);
    const currentStage = task.graph?.progress?.current || null;
    const progressDone = Number(task.graph?.progress?.done);
    const progressTotal = Number(task.graph?.progress?.total);

    state.observedByTask[taskId] = {
      progress: Number.isSafeInteger(progressDone) && progressDone >= 0
        && Number.isSafeInteger(progressTotal) && progressTotal >= 0
        ? { done: progressDone, total: progressTotal }
        : null,
      stage: currentStage
        ? {
          id: currentStage,
          label: stripEmoji(task.graph?.nodes?.[currentStage]?.[1]) || currentStage,
          state: task.graph?.statuses?.[currentStage] || null,
        }
        : null,
    };

    if (!task.readOnly && task.stall) {
      state.stalled.push({
        task: taskId,
        taskTitle,
        title: task.stall.title || task.stall.hint || 'Конвейер встал',
      });
    }
    if (!task.readOnly && silence) {
      state.silent.push({
        task: taskId,
        taskTitle,
        text: silence.text,
      });
    }
    if (!task.readOnly && wait) {
      state.waiting.push({
        task: taskId,
        taskTitle,
        text: wait.text,
      });
    }
    if (!task.readOnly && task.daemonAlive) {
      state.running.push({
        task: taskId,
        taskTitle,
      });
    }
  }

  return state;
});
const statusSummary = computed(() => pipelineBadgeSummary(pipelineState.value));
const statusItems = computed(() => pipelineTopbarItems(pipelineState.value));
const statusKindByTask = computed(() => {
  const kinds = new Map(statusItems.value.map((item) => [item.task, item.kind]));

  for (const task of projectTasks.value) {
    const taskId = String(task.task);

    if (!kinds.has(taskId)) {
      kinds.set(taskId, 'inactive');
    }
  }

  return kinds;
});

/**
 * Подсказка раскрывает не только цифру, но и конкретные задачи с причиной.
 * Для пустой категории честно говорит, что таких задач в выбранном проекте нет.
 */
function statusHint(kind: string, emptyText: string) {
  const items = kind === 'inactive'
    ? projectTasks.value
      .filter((task) => statusKindByTask.value.get(String(task.task)) === 'inactive')
      .map((task) => ({
        task: String(task.task),
        title: title(task) || '',
        detail: task.result ? `результат: ${task.result}` : '',
      }))
    : statusItems.value.filter((item) => item.kind === kind);

  if (!items.length) {
    return emptyText;
  }

  return items.map((item) => {
    const detail = item.detail || ('stage' in item ? item.stage : '') || item.title;

    return detail ? `#${item.task}: ${detail}` : `#${item.task}`;
  }).join('\n');
}

const statusOptions = computed(() => [
  {
    id: 'all',
    label: 'Все',
    count: projectTasks.value.length,
    tone: 'neutral' as const,
    hint: 'Все задачи выбранного проекта',
  },
  {
    id: 'running',
    label: 'В работе',
    count: statusSummary.value.runningCount,
    tone: 'accent' as const,
    hint: statusHint('running', 'Сейчас нет задач в обычной работе'),
  },
  {
    id: 'waiting',
    label: 'Ждут решения',
    count: statusSummary.value.waitingCount,
    tone: 'warning' as const,
    hint: statusHint('waiting', 'Сейчас никто не ждёт твоего решения'),
  },
  {
    id: 'error',
    label: 'Проблемы',
    count: statusSummary.value.errorCount,
    tone: 'danger' as const,
    hint: statusHint('error', 'Сейчас нет вставших или молчащих прогонов'),
  },
  {
    id: 'inactive',
    label: 'Неактивные',
    count: projectTasks.value.length - statusSummary.value.totalCount,
    tone: 'neutral' as const,
    hint: statusHint(
      'inactive',
      'Нет завершённых, остановленных или доступных только для чтения прогонов',
    ),
  },
]);
const currentStatusOption = computed(() => (
  statusOptions.value.find((option) => option.id === activeStatus.value)
  || statusOptions.value[0]!
));

const filteredTasks = computed(() => {
  if (activeStatus.value === 'all') {
    return projectTasks.value;
  }

  return projectTasks.value.filter((task) => (
    statusKindByTask.value.get(String(task.task)) === activeStatus.value
  ));
});

function resetStatusFilter() {
  setStatus('all');
}

// Исчезнувший профиль не оставляет страницу в невидимом пустом состоянии.
watch(tasks, (list) => {
  if (activeProject.value === 'all') {
    return;
  }

  if (!list.some((task) => task.profile === activeProject.value)) {
    setProject('all');
  }
});

// По-карточное сворачивание (запоминается). Свёрнута, если глобальный compact ИЛИ отмечена.
const collapsedSet = ref(new Set<TaskId>(collapsedCards(
  JSON.parse(localStorage.getItem('grigdesk-cards-collapsed') || '[]'),
)));


/**
 * Меняет свёрнутость одной карточки через новый Set для реактивности.
 * Порядок записи локальной настройки остаётся прежним.
 */
function toggleCard(task: TaskId) {
  const s = new Set(collapsedSet.value);

  s.has(task) ? s.delete(task) : s.add(task);
  collapsedSet.value = s;
  localStorage.setItem('grigdesk-cards-collapsed', JSON.stringify([...s]));
}

function isCollapsed(task: TaskId) {
  return compact.value || collapsedSet.value.has(task);
}

// Модалка этапа (клик по узлу графа): инфо + управление (ворота/форс/указание/активность).
const stage = ref<Stage | null>(null);
const stageBusy = ref<string | null>(null);
// Два РАЗНЫХ текста, а не один на обе кнопки: у ворот пояснение доезжает до агента только
// при отклонении, у возврата — всегда. Общий ref переносил бы набранное из одного смысла
// в другой и подсказывал, что при «Принять» текст тоже куда-то уйдёт (он не уходит).
const gateComment = ref('');
const stageFindingsReady = ref(false);
const gateRejecting = ref(false);
const gateNoteEl = ref<InstanceType<typeof UiTextarea> | null>(null);
const rewindComment = ref('');
// Ответы на вопросы узла: id находки → текст. Отдельно от свободного поля, потому что
// каждый ответ обязан приехать агенту привязанным к ЕГО вопросу, а не сплошняком.
const rewindAnswers = ref<Record<string, string>>({});
const stageActivity = ref<PipelineActivity | null>(null);
const stageDoc = ref('');       // документ этапа (план/разведнота/диагноз…) — рендерится в модалке
const stageDocOpen = ref(true);
const stageLogOpen = ref(false);
const pipelineContext = useUiContextSource('pipeline', { layer: 'overlay', active: false });
const liveFeed = ref<HTMLElement | null>(null);
const stageDocLoading = ref(false);
let actPoll: ReturnType<typeof setInterval> | null = null;
// Какой документ показывать на каком узле: у ворот плана — сам план, у приёмки — отчёт.
const NODE_DOC: Record<string, string> = {
  gate_plan: 'plan',
  plan: 'plan',
  skeptic: 'plan',
  validate: 'plan',
  translator: 'plan',
  scout: 'recon',
  diagnose: 'diag',
  hyposkeptic: 'diag',
  proof: 'diag',
  gate_cause: 'diag',
  hunt_access: 'diag',
  hunt_data: 'diag',
  hunt_errors: 'diag',
  hunt_race: 'diag',
  verify: 'diag',
  baseline: 'diag',
  perfplan: 'plan',
  perfskeptic: 'plan',
  ship: 'ship',
  gate_accept: 'report',
  browser: 'report',
  triage: 'report',
  measure: 'report',
  measurecheck: 'report',
  // У аудита свой документ — досье приёмки. Ворота рядом продолжают показывать
  // отчёт: сводку аудита узел дописывает и туда, поэтому человеку на воротах
  // видно главное, а полное досье — в клике по узлу.
  audit: 'audit',
  // Ревью пишет собственный t<TASK>.review.md с первого дня, но в карте его не
  // было: документ существовал и не открывался нигде.
  review: 'review',
};


/**
 * Описывает открытый узел и выбранную поверхность для общего контекста UI.
 * Закрытая модалка не публикует сведения о прежнем узле.
 */
function pipelineContextDetails() {
  if (!stage.value) {
    return null;
  }

  const document = stageDocOpen.value ? NODE_DOC[stage.value!.id] || null : null;
  const tab = stageLogOpen.value ? 'activity' : document ? 'document' : 'overview';
  const details = {
    taskId: String(stage.value!.task),
    stageId: String(stage.value!.id),
    tab,
  };

  return { ...details, ...(document ? { document } : {}) };
}

const pipelineContextIdentity = computed(() => (
  stage.value ? `${stage.value!.task}:${stage.value!.id}` : ''
));

watch(pipelineContextIdentity, (identity, previous) => {

  if (!identity) {
    pipelineContext.blur();

    return;
  }

  const taskId = String(stage.value!.task);
  const next = {
    routingScope: { kind: 'task', taskId },
    details: pipelineContextDetails(),
  };

  if (identity !== previous) {
    pipelineContext.focus(next);
  } else {
    pipelineContext.update(next);
  }
}, { immediate: true });
watch(
  () => [pipelineContextIdentity.value, stageDocOpen.value, stageLogOpen.value],
  () => {
    if (stage.value) {
      pipelineContext.update({ details: pipelineContextDetails() });
    }
  },
  { immediate: true },
);

const STAGE_HINT: Record<string, string> = {
  done: 'пройден',
  run: 'выполняется сейчас',
  wait: 'ждёт твоего решения',
  pending: 'ещё не начинался',
  skip: 'пропущен осознанно',
  idle: 'нет данных (прогон по прежней схеме)',
  stall: 'завис — агент молчит',
  skipbad: 'пропущен без причины — аномалия',
  premature: 'преждевременно: хвост не доделан',
  fail: 'провалился — стенд не поднялся',
};
// Подпись статуса узла. Обычно берётся из карты, но у остановки есть два случая, когда карта
// врёт: узел со `stall` подписан «завис — агент молчит», а он не молчал — он отработал и
// САМ вернул решение человеку, объявив это классом провала. Разница для читателя
// принципиальная: молчание зовут чинить, вынесенное решение — принимать.
// Второй случай — исчерпанный бюджет повторов: агент не молчал, он работал и был убит по
// лимиту (или лежал провайдер), а результата не получил раннер. Источник признака тот же,
// что и у причины остановки в карточке (`meta.stall`), чтобы бейдж и причина рассказывали
// одну историю: на t7989 бейдж говорил «молчит», причина — «вернул решение», замечание —
// «исчерпан бюджет повторов».
function stageStatusHint(s: Stage) {
  if (s.status === 'stall' && s.meta?.stall?.outcome === 'exhausted') {
    return 'раннер не получил результат';
  }
  if (s.status === 'stall' && s.meta?.verdict?.stop === 'human') {
    return 'вернул решение человеку';
  }

  return STAGE_HINT[s.status] || s.status;
}

const FORCE_STATUSES = ['running', 'done', 'skipped', 'pending'];
const RUNNER_SOURCE: Record<string, string> = {
  'profile-project': 'политика проекта',
  'profile-stage': 'политика этапа',
  task: 'переопределение задачи',
  'task-stage': 'переопределение этапа задачи',
};

const LIVE_ICONS: Record<string, string> = {
  tool: '⚙',
  subagent: '🤖',
  text: '💬',
  think: '🧠',
};

function liveIcon(a: { type: string }) {
  return LIVE_ICONS[a.type] || '·';
}

/**
 * FactoryGraph эмитит нормализованный `id`, а API-граф хранит метаданные по этому же ключу.
 * Один canonical id нужен всему снимку модалки, иначе ошибка возникает ещё до её открытия.
 */
function openStage(t: PipelineViewTask, node: StageNode) {
  const origin = t.graph.nodeOrigins?.[node.id];

  if (origin && !origin.executable) {
    return;
  }

  const nodeId = origin?.originId || node.id;
  const currentStop = t.stall?.arbitrable && stallNodeId(t) === nodeId;

  stageConversationId.value = currentStop ? t.stall?.conversation?.conversationId
    : t.graph.arbiterConversations?.find((row) => row.identity.node === nodeId)?.conversationId;

  stage.value = {
    task: t.task,
    id: nodeId,
    key: t.graph.keys?.[nodeId] || nodeId.toUpperCase(),
    runnerKey: t.graph.runnerKeys?.[nodeId]
      || t.graph.keys?.[nodeId]
      || nodeId.toUpperCase(),
    isGate: nodeId.startsWith('gate_'),
    label: stripEmoji(node.label),
    sub: node.subtitle,
    readOnly: Boolean(t.readOnly || t.graph.readOnly),
    daemonAlive: Boolean(t.graph.daemonAlive),
    status: node.status,
    meta: t.graph.nodeMeta?.[nodeId] || {},
  };
  loadFactoryRunners();
  gateComment.value = '';
  gateRejecting.value = false;
  rewindComment.value = '';
  rewindAnswers.value = {};
  runnerPending.value = null;
  stageActivity.value = null;
  stageDoc.value = '';
  stageDocOpen.value = true;
  stageDocLoading.value = false;
  stageLogOpen.value = false;

  const doc = NODE_DOC[nodeId];

  if (doc) {
    stageDocLoading.value = true;
    api.get(`/api/tasks/${t.task}/doc/${doc}`)
      .then((r) => {
        stageDoc.value = decodePipelineReply(r).text || '';
      })
      .catch(() => { /* документа нет — секция не показывается */ })
      .finally(() => {
        stageDocLoading.value = false;
      });
  }

  clearInterval(actPoll ?? undefined);

  if (node.status === 'run' && t.graph.daemonAlive) {
    pollActivity();
    actPoll = setInterval(pollActivity, 3000);
  }
}

function closeStage() {
  stage.value = null;
  clearInterval(actPoll ?? undefined);
}

function onStageDialogOpenChange(open: boolean) {
  if (!open) {
    closeStage();
  }
}


/**
 * Обновляет активность только открытого узла существующим опросом.
 * Отказ не закрывает модалку и не стирает последний успешный снимок.
 */
async function pollActivity() {
  if (!stage.value) {
    return;
  }

  try {
    stageActivity.value = decodePipelineActivity(await api.get(`/api/tasks/${stage.value!.task}/activity`));
  } catch { /* игнор */ }
}
// Модалка живёт дольше этапа: её открывают на бегущем узле и не закрывают. Статус в ней
// обязан идти за графом, иначе она навсегда остаётся «выполняется сейчас» и продолжает
// опрашивать активность уже закончившегося этапа, пока конвейер стоит у ворот.
const stageLive = computed(() => {
  if (!stage.value) {
    return null;
  }

  const g = tasks.value.find((x) => Number(x.task) === Number(stage.value!.task))?.graph;

  if (!g?.statuses?.[stage.value!.id]) {
    return null;
  }

  return {
    status: g.statuses[stage.value!.id]!,
    meta: g.nodeMeta?.[stage.value!.id] || {},
    daemonAlive: Boolean(g.daemonAlive),
  };
});

watch(stageLive, (live) => {
  if (!stage.value || !live) {
    return;
  }
  // Мета (время, длительность, токены, попытки runner-а) обновляется всегда: этап
  // дописывает её и после того, как перестал быть активным.
  stage.value!.meta = live.meta;

  if (live.status === stage.value!.status && live.daemonAlive === stage.value!.daemonAlive) {
    return;
  }

  stage.value!.status = live.status;
  stage.value!.daemonAlive = live.daemonAlive;
  clearInterval(actPoll ?? undefined);

  if (live.status === 'run' && live.daemonAlive) {
    pollActivity();
    actPoll = setInterval(pollActivity, 3000);
  }
  else {
    stageActivity.value = null;
  }
});

// Автопрокрутка ленты действий агента вниз при обновлении.
watch(() => stageActivity.value?.live?.actions?.length, () => {
  nextTick(() => {
    if (liveFeed.value) {
      liveFeed.value.scrollTop = liveFeed.value.scrollHeight;
    }
  });
});
// Решение и возврат курсора уходят в журнал попытки СРАЗУ, а продолжение прогона —
// отдельным resume, который может не подняться (например, профиль правили при живой
// попытке). Сервер отвечает 200 с resumed:false, и молчать об этом нельзя: карточка
// выглядит принятой, а конвейер стоит — так несколько попыток продолжить
// прошли «успешно» и ничего не поехало.
async function warnIfNotResumed(res: PipelineReply | null) {
  if (!res || res.resumed !== false) {
    return;
  }

  await alertDialog(
    `Записано, но прогон не поехал: ${res.resumeError || 'причина — в журнале этапов задачи'}`,
  );
}
// Ворота — состояние, в котором решение вообще принимают. Отдельным computed, потому что
// на него смотрят и секция решения, и подпись комментария под шапкой.
const gateDecidable = computed(() => Boolean(
  stage.value && !stage.value!.readOnly && stage.value!.isGate
  && ['wait', 'premature'].includes(stage.value!.status),
));
// Только компоновка модалки: на широком экране информационная колонка и управление
// живут рядом, но пустую колонку не держим ради одной рамки. Условия действий остаются
// теми же, что и у самих секций ниже.
// Сводка решений арбитра для ворот. `deferred` — решение о границе задачи, принятое за
// человека: оно требует проверки сильнее, чем снятый технический тупик, поэтому идёт
// первым. Отказы арбитра (`human`) сюда не входят: они конвейер останавливали, человек
// их уже видел в плашке остановки.
const gateArbiterLog = computed(() => {
  const graph = tasks.value.find((x) => Number(x.task) === Number(stage.value?.task))?.graph;
  const log = graph?.arbiterLog;

  if (!Array.isArray(log)) {
    return [];
  }

  const rows = log.filter((row) => row?.card?.what && row.verdict !== 'human');

  return [...rows].sort((a, b) => Number(b.verdict === 'deferred') - Number(a.verdict === 'deferred'));
});

const stageHasRewind = computed(() => Boolean(
  stage.value && !stage.value!.readOnly && !stage.value!.isGate
  && !stageUsesConversation.value
  && stageTask.value?.graph?.nodeOrigins?.[stage.value!.id]?.scope !== 'bootstrap',
));
// Вопросом к человеку является только БЛОКИРУЮЩАЯ находка: правило общее с отдельной
// модалкой разбора, поэтому живёт в `shared/rewindNote.ts`.
const rewindQuestions = computed(() => rewindQuestionsOf(stage.value?.meta?.verdict));

/**
 * Находки для блока «что сказал узел».
 *
 * Блокирующие уезжают отсюда, когда рядом стоит форма возврата: там у каждой из них
 * своё поле ответа с тем же текстом, и список выше показывал человеку один и тот же
 * вопрос дважды на одном экране. Отложенные остаются: полей под них нет по замыслу —
 * это замечание на будущее, а не вопрос к человеку.
 */
const verdictFindings = computed(() => {
  const findings = stage.value?.meta?.verdict?.findings;

  if (!Array.isArray(findings)) {
    return [];
  }
  if (!stageHasRewind.value || !rewindQuestions.value.length) {
    return findings;
  }

  return findings.filter((f) => f.severity !== 'blocking');
});

const stageArbiterCard = computed(() => (
  stage.value ? arbiterCardFor(stageTask.value, stage.value!.id) : null
));

// Блокирующие вопросы ушли в форму ответа — значит список стал списком отложенного.
const verdictDeferredOnly = computed(() => (
  verdictFindings.value.length > 0 && verdictFindings.value.every((f) => f.severity === 'deferred')
));

// Чем закончился заход: разбор арбитра, причина остановки, находки узла и дайджест.
const stageHasSituation = computed(() => Boolean(
  stage.value && (stage.value!.meta.stall || stage.value!.meta.comment
    || verdictFindings.value.length || stageArbiterCard.value),
));
// Телеметрия захода. Нулевой fanout сюда не входит: чип ради нуля держал целую полосу.
const stageHasMeta = computed(() => Boolean(
  stage.value && (stage.value!.meta.at || stage.value!.meta.dur != null || stage.value!.meta.fanout
    || stage.value!.meta.denials || stage.value!.meta.tokens || stage.value!.meta.fails || stage.value!.sub
    || stage.value!.meta.verdict?.reviewed?.length),
));

const stageHasMain = computed(() => Boolean(
  stage.value?.meta?.runner
  || stageHasMeta.value
  || stageDocLoading.value
  || stageDoc.value
  || (stage.value?.status === 'run' && (stageActivity.value?.live || stageActivity.value?.tail?.length)),
));
// Колонка решения показывается и без кнопок: у read-only узла причина остановки — всё,
// что человеку нужно, и прятать её в телеметрию слева значило бы прятать сам ответ.
const stageHasRail = computed(() => (
  gateDecidable.value || stageHasRewind.value || stageHasSituation.value || stage.value?.id === 'gate_accept'
  || Boolean(stage.value?.meta?.bootstrapStop)
));
// Контекст открытого этапа остаётся живым: название задачи может догрузиться из B24 уже
// после открытия модалки, а стенд — появиться после очередного SSE-обновления графа.
// Снимок в openStage здесь дал бы устаревшие название и порты до повторного открытия.
const stageTask = computed(() => {
  if (!stage.value) {
    return null;
  }

  return tasks.value.find((item) => Number(item.task) === Number(stage.value!.task)) || null;
});
const stageTaskTitle = computed(() => (
  stage.value ? title(stageTask.value || stage.value!.task) : null
));
const stageGraph = computed(() => stageTask.value?.graph || null);
const stageConversationId = ref<string | undefined>();
const stageUsesConversation = computed(() => {
  const opened = stage.value;
  const task = stageTask.value;

  if (!opened || !task || opened.isGate || task.stall?.phase === 'bootstrap') {
    return false;
  }

  return Boolean(stageConversationId.value || stageArbiterCard.value
    || task.stall?.arbitrable && stallNodeId(task) === opened.id);
});
// Пояснение — часть ОТКЛОНЕНИЯ, а не ворот вообще: при «Принять» движок его выбрасывает
// (`route_v2_gate_decide`: reject_feedback обнуляется на любом исходе кроме rejected).
// Пока поле висело всегда, интерфейс обещал доставку текста, которой при принятии нет.
function startGateReject() {
  gateRejecting.value = true;
  nextTick(() => {
    gateNoteEl.value?.focus();
  });
}

function cancelGateReject() {
  gateRejecting.value = false;
  gateComment.value = '';
}
// Движок отказывает, когда rejected-пояснение некому доставить: возврат ведёт в узел,
// который исполняет не агент. Голое «Ошибка: …» тут ничего не подсказывает, а выход есть.
function gateErrorText(e: unknown) {
  const base = `Решение не принято: ${errorMessage(e, '')}`;

  return /нельзя доставить/.test(errorMessage(e, '') || '')
    ? `${base}\n\nОтклони без текста либо верни конвейер кнопкой «▶ Перейти сюда» `
      + 'на тот узел, чей агент должен прочитать указание.'
    : base;
}


/**
 * Отправляет решение по текущим воротам и обновляет снимок конвейера.
 * Комментарий передаётся только при отклонении, как требует маршрут.
 */
async function gateDecide(decision: string) {
  stageBusy.value = 'gate';
  // При принятии комментарий не отправляем вовсе: пустое поле честнее, чем текст,
  // который движок молча выбросит, а проекция реестра потом покажет как «Замечание».
  const comment = decision === 'reject' ? gateComment.value : '';

  try {
    const res = decodePipelineReply(await api.post(
      `/api/tasks/${stage.value!.task}/gate/${stage.value!.key}/${decision}`, {
      comment,
      profile: stageTask.value?.profile,
      attempt: stageTask.value?.attempt,
    }));

    await load();
    closeStage();
    await warnIfNotResumed(res);
  }
  catch (e) {
    await alertDialog(gateErrorText(e));
  } finally {
    stageBusy.value = null;
  }
}


/**
 * Переводит курсор после подтверждения сброса последующих результатов.
 * Указание человека уходит вместе с прежним запросом смены статуса.
 */
async function forceStatus(status: string) {
  // Возврат курсора сбрасывает НЕ ТОЛЬКО этот узел, но и весь хвост маршрута за ним.
  // Возврат с приёмки на план сносит результаты всего, что между.
  const question = `Вернуть конвейер на «${stage.value!.label}»? `
    + 'Результаты этого узла и всех следующих за ним будут сброшены.';

  if (!await confirmDialog(question, { okText: 'Вернуть' })) {
    return;
  }

  stageBusy.value = 'force';
  // Указание уезжает тем же запросом, что и сам возврат: сервер кладёт его в журнал
  // попытки причиной human-rewind, движок оттуда подмешивает его в промпт захода.
  try {
    const res = decodePipelineReply(await api.post(
      `/api/tasks/${stage.value!.task}/stage/${stage.value!.key}/${status}`,
      { comment: buildRewindNote(rewindQuestions.value, rewindAnswers.value, rewindComment.value) }));

    await load();
    closeStage();
    await warnIfNotResumed(res);
  }
  catch (e) {
    alertDialog(`Ошибка: ${errorMessage(e, '')}`);
  } finally {
    stageBusy.value = null;
  }
}
// Выбор исполнителя модалку НЕ закрывает: человек сравнивает варианты и перебирает их,
// а закрытие после каждого клика заставляло открывать узел заново. Новое состояние узла
// приезжает обычным путём — load() → watch(stageLive) → stage.meta.
async function switchRunner(target: string) {
  if (!await confirmDialog(
    `Остановить текущий запуск ${providerLabel(stage.value!.meta.runner!.actual)} `
      + `и продолжить этап через ${providerLabel(target)}?`,
    { okText: 'Переключить' },
  )) {
    return;
  }

  stageBusy.value = 'runner-switch';

  try {
    await api.post(`/api/tasks/${stage.value!.task}/runner/switch`, {
      stage: stage.value!.runnerKey,
      target,
    });
    await load();
  } catch (e) {
    alertDialog(`Не удалось переключить исполнителя: ${errorMessage(e, '')}`);
  } finally {
    stageBusy.value = null;
  }
}
// Исполнители, установленные на фабрике — для override этапа. Тянем один раз,
// при первом открытии узла; сервер не отдал — блок выбора просто не показываем.
const factoryRunners = ref<string[]>([]);
let factoryRunnersRequested = false;

function loadFactoryRunners() {
  if (factoryRunnersRequested) {
    return;
  }

  factoryRunnersRequested = true;
  api.get('/api/factory/runners')
    .then((r) => {
      factoryRunners.value = decodeFactoryRunners(r);
    })
    .catch(() => { /* без списка блок выбора скрыт */ });
}
// Текущий primary могли снять с фабрики — тогда добавляем его в список сами,
// иначе селект соврал бы про действующее значение этапа.
const stageRunnerOptions = computed(() => {
  const list = [...factoryRunners.value];
  const primary = stage.value?.meta?.runner?.primary;

  if (primary && !list.includes(primary)) {
    list.unshift(primary);
  }

  return list;
});
// status=run и runner.actual остаются в проекции после ручного stop. Live-switch
// безопасен только при живом оркестраторе; остановленному прогону показываем override,
// который будет применён следующим «Продолжить прогон».
const stageRunnerLive = computed(() => Boolean(
  stage.value?.daemonAlive
  && stage.value?.status === 'run'
  && stage.value?.meta?.runner?.actual,
));
// Кого выбрали прямо сейчас: подсветка обязана переехать по клику, а не через секунду,
// когда доедет полный load() всех задач с графами.
const runnerPending = ref<string | null>(null);
const stageRunnerActive = computed(() => (
  runnerPending.value ?? (stage.value?.meta?.runner?.primary || '')
));
// Override исполнителя до запуска этапа (бегущий переключают только кнопки switch).
// '' — снять override этапа: вернётся переопределение задачи с запуска или профиль.
async function setStageRunner(primary: string) {
  if (stageBusy.value) {
    return;
  }

  stageBusy.value = 'runner-override';
  // У сброса будущего значения нет (его решит профиль) — подсветку до ответа не двигаем.
  runnerPending.value = primary || null;

  try {
    await taskStore.setStageRunner(stage.value!.task, stage.value!.runnerKey, primary);
    await load();
  } catch (e) {
    alertDialog(`Не удалось сменить исполнителя этапа: ${errorMessage(e, '')}`);
  } finally {
    stageBusy.value = null;
    runnerPending.value = null;
  }
}

function pickStageRunner(primary: string) {
  if (primary === stageRunnerActive.value) {
    return;
  }

  setStageRunner(primary);
}
// Подпись у `meta.comment`: один и тот же ключ реестра (`<КЛЮЧ>_COMMENT`) значит разное.
// У ворот это текст ЧЕЛОВЕКА, и его судьба зависит от решения: отклонение уезжает агенту
// заданием, а комментарий при принятии движок выбрасывает — назвать его «Замечанием»
// значит соврать про доставку (старые прогоны такие записи ещё содержат).
function stageCommentLabel(s: Stage) {
  if (['skip', 'skipbad'].includes(s.status)) {
    return 'Почему пропущен';
  }
  if (!s.isGate) {
    return 'Замечание';
  }

  return s.status === 'done'
    ? 'Комментарий при принятии — агенту он не уходил'
    : 'Отправлено агенту на доработку';
}

// Заголовок блока находок. Он обязан отвечать на «что мне с этим делать», а не
// называть структуру данных: остановка на человеке и рядовое замечание перед возвратом
// требуют от читателя разного. Класс владельца (`owner`) в заголовок не выносим — он
// служебный и для человека ничего не добавляет к самому факту остановки.
//
// Когда блокирующие уехали в форму ответа, в списке остаются только отложенные — и
// «узел вернул решение человеку» над строчкой «подпись оси не выровнена» приписывало бы
// остановку косметике: решение вернули из-за вопроса, который теперь стоит ниже полем.
function verdictLabel(v: NodeVerdict, deferredOnly = false) {
  if (deferredOnly) {
    return 'Замечания на будущее';
  }
  if (v.stop === 'human') {
    return 'Узел вернул решение человеку';
  }
  if (v.rewind) {
    return `Замечания — маршрут вернулся на ${v.rewind}`;
  }

  return 'Замечания узла';
}

// Якорь находки — путь внутри репозитория. Целиком он съедает строку и обрезается
// с конца, то есть теряет как раз имя файла; полный путь остаётся в подсказке.
function shortAnchor(anchor: unknown) {
  const parts = String(anchor).split('/').filter(Boolean);

  return parts.length ? parts[parts.length - 1] : anchor;
}

// Снос идёт до пары минут (docker + схемы БД) — на это время кнопка превращается
// в индикатор «сношу…», повторный клик заблокирован.
const sandboxBusy = ref(new Set<TaskId>());


/**
 * Сносит стенд после подтверждения и блокирует повторный клик по задаче.
 * После ответа перечитывает список, а индикатор снимает и при отказе.
 */
async function sandboxDown(task: TaskId) {
  if (sandboxBusy.value.has(task)) {
    return;
  }
  if (!await confirmDialog(
    `Снести стенд задачи #${task}? Текущий прогон уйдёт в архив, `
      + 'после чего задачу можно будет отправить на конвейер заново. '
      + 'Ветка и незакоммиченные изменения сохранятся.',
    { danger: true, okText: 'Снести' },
  )) {
    return;
  }

  sandboxBusy.value = new Set([...sandboxBusy.value, task]);

  try {
    await api.post(`/api/tasks/${task}/sandbox/down`);
    await load();
  }
  catch (e) {
    alertDialog(isRecord(e) && e.status === 501
      ? 'Снос стенда не настроен: нет GRIGDESK_SANDBOX_DOWN_CMD и down.sh у профиля.'
      : `Ошибка: ${errorMessage(e, '')}`);
  }

  finally {
    const s = new Set(sandboxBusy.value);

    s.delete(task);
    sandboxBusy.value = s;
  }
}

// Ручная архивация нужна задаче, стенд которой GrigDesk не сносит: его либо уже нет
// (подъём оборвался до выдачи порта), либо он не наш (shared checkout). Там, где стенд
// наш, прогон архивирует сам «снести стенд».
async function closeTask(t: PipelineViewTask) {
  const task = t.task;

  if (sandboxBusy.value.has(task)) {
    return;
  }

  // Идущий прогон закрытие ПРЕРЫВАЕТ: сервер закрывает попытку как оборванную и гасит
  // её юнит. Молчать об этом нельзя. Кнопка стоит прямо под работающим конвейером, а у
  // shared-профиля она там вообще единственная («снести стенд» не показывается по
  // определению) — то есть прежний текст про «ветки не затрагиваются» успокаивал ровно
  // там, где терялась работа. Живой случай: закрытая по ошибке задача на планировании.
  // Узел называем поимённо: «прогон будет прерван» без места читается абстракцией.
  const runNote = t.daemonAlive
    ? `Прогон ИДЁТ — узел «${currentLabel(t.graph)}». Закрытие прервёт его: попытка `
      + 'закроется как оборванная, продолжить её будет нельзя, задачу придётся '
      + 'запускать заново.\n\n'
    : '';

  // Про ветки говорим только там, где GrigDesk их правда трогает: в shared-режиме
  // основное рабочее дерево не наше, и никакой branch lifecycle к нему не применяется.
  const branchNote = canDestroySandbox(t)
    ? ' Пустая ветка будет удалена (ветка с коммитами останется).'
    : ' Общий checkout и его ветки не затрагиваются.';

  if (!await confirmDialog(
    `${runNote}Закрыть задачу #${task}? Реестр уйдёт в архив.${branchNote}`,
    { danger: true, okText: t.daemonAlive ? 'Прервать и закрыть' : 'Закрыть' },
  )) {
    return;
  }

  sandboxBusy.value = new Set([...sandboxBusy.value, task]);

  try {
    const r = decodePipelineReply(await api.post(`/api/tasks/${task}/close`));
    const branches = (r.branches || []).map((b) => `${b.repo}: ${b.state}`).join('; ');

    await alertDialog(`Задача #${task} закрыта.${branches ? ` Ветки — ${branches}.` : ''}`);
    await load();
  } catch (e) {
    alertDialog(`Ошибка: ${errorMessage(e, '')}`);
  }

  finally {
    const s = new Set(sandboxBusy.value);

    s.delete(task);
    sandboxBusy.value = s;
  }
}

// Стенд не поднялся — вернуть задачу в работу одной кнопкой. Двумя действиями это было
// невозможно: «снести стенд» показывается только у живого стенда, а его-то и нет.
// Пересборки стенда отдельно от прогона в движке не существует, поэтому здесь именно
// перезапуск конвейера (resume) — со сносом остатков упавшей песочницы перед ним.
async function sandboxRetry(task: TaskId) {
  if (sandboxBusy.value.has(task)) {
    return;
  }
  if (!await confirmDialog(
    `Перезапустить стенд задачи #${task}? Остатки упавшей песочницы будут снесены, `
      + 'конвейер продолжит с того места, где встал.',
    { okText: 'Перезапустить' },
  )) {
    return;
  }

  sandboxBusy.value = new Set([...sandboxBusy.value, task]);

  try {
    const r = decodePipelineReply(await api.post(`/api/tasks/${task}/sandbox/retry`));

    await load();
    // Снос мог оставить за собой worktree с незакоммиченными изменениями — тогда новый
    // подъём упрётся в тот же гард. Сказать об этом надо сразу, а не через двадцать минут
    // провижининга: в плашке это будет выглядеть как «стенд опять не поднялся» без причины.
    const warn = (r.downOutput || '').split('\n').filter((s) => s.includes('ВНИМАНИЕ')).join('\n');

    if (warn) {
      alertDialog(`Конвейер перезапущен, но снос сообщил:\n${warn}`);
    }
    else if (r.note) {
      alertDialog(r.note);
    }
  } catch (e) {
    alertDialog(isRecord(e) && e.status === 501
      ? 'Снос стенда не настроен: нет GRIGDESK_SANDBOX_DOWN_CMD и down.sh у профиля.'
      : `Не удалось перезапустить: ${errorMessage(e, '')}`);

  } finally {
    const s = new Set(sandboxBusy.value);

    s.delete(task);
    sandboxBusy.value = s;
  }
}

// Арбитр типизированной остановки. Гейт по МАШИННОМУ виду остановки (`stall.stop`), а не
// по разбору заголовка: текст пишется человеку и меняется, а решение «можно ли отдать это
// арбитру» обязано быть точным. `no-progress` — единственный вид, где решение выводится из
// вердиктов дуги; `human` (упал стенд, не хватило прав) выводить не из чего.
// --- Решение человека по остановке ----------------------------------------------------
//
// Ответ пишется в модалке узла: там разбор арбитра целиком, причина остановки, вопросы
// узла своими полями и ручка `stage/<КЛЮЧ>/running` (движок пишет указание причиной
// human-rewind и сам делает resume). Плашка ленты отвечает на другой вопрос — «где стоит
// и на ком», — поэтому в ней остаются признак и вход, а не форма и четыре абзаца разбора.

/**
 * Относится ли сохранённый разбор арбитра к ТОЙ остановке, что видна сейчас.
 *
 * Карточка привязана к попытке, но не к узлу: после ответа человека маршрут может встать
 * дальше, и прежний разбор той же попытки остался бы на экране как свежий.
 */
function arbiterAsksHuman(t: PipelineViewTask) {
  const card = t.stall?.arbiter;

  if (!card || card.verdict !== 'human') {
    return false;
  }
  if (!card.node) {
    return true;
  }

  return t.graph?.keys?.[card.node] === t.stall!.stage;
}
// Подпись разбора одна на ленту и модалку: две копии разошлись бы на первой же правке.

/**
 * Объясняет человеку исход сохранённого разбора арбитра.
 * Решение на человеке и отложенное решение получают разные подписи.
 */
function arbiterCardLabel(card: ArbiterCard | null | undefined) {
  if (card?.verdict === 'human') {
    return 'Арбитр разобрал: решать тебе';
  }
  if (card?.verdict === 'deferred') {
    return 'Арбитр решил за тебя — проверишь на воротах';
  }

  return 'Арбитр снял тупик';
}
/**
 * След арбитра по узлам попытки для схемы: узел → вердикт последнего разбора.
 *
 * Идущий разбор виден статусом `arb` и гаснет вместе с ним; без этого следа человек,
 * открыв схему, не знает, что курсор на узле двигал не он. История принадлежит попытке
 * и приезжает тем же ответом графа (`arbiterLog`).
 */
function arbitratedNodes(graph: PipelineViewGraph | null) {
  const log = graph?.arbiterLog;

  if (!Array.isArray(log) || !log.length) {
    return null;
  }

  const nodes: Record<string, string> = {};

  for (const row of log) {
    if (row?.node && row.verdict && !nodes[row.node]) {
      nodes[row.node] = row.verdict;
    }
  }

  return Object.keys(nodes).length ? nodes : null;
}

function canAnswerStall(t: PipelineViewTask) {
  if (t.readOnly || t.daemonAlive || t.arbitrating || !t.stall) {
    return false;
  }

  return Boolean(stallNodeId(t)) && t.stall.stage !== 'SANDBOX' && t.stall.kind !== 'crashed';
}

/**
 * Вопрос bootstrap открывает узел своей фазы при совпадении имён scout.
 * Карта registry keys сама по себе не различает отдельную разведку и основной маршрут.
 */
function stallNodeId(t: PipelineViewTask) {
  if (t.stall?.phase === 'bootstrap') {
    return Object.entries(t.graph?.nodeOrigins || {}).find(([, origin]) => (
      origin.scope === 'bootstrap' && origin.originId === 'scout'
    ))?.[0] || '';
  }

  const keys = t.graph?.keys || {};

  return Object.keys(keys).find((id) => keys[id] === t.stall?.stage) || '';
}
/**
 * Разбор арбитра, относящийся к УЗЛУ.
 *
 * Источник — история арбитражей попытки (`graph.arbiterLog`), поэтому разбор виден и на
 * пройденном узле: «кто двигал курсор» остаётся вопросом и после того, как маршрут поехал
 * дальше. Последняя карточка остановки берётся запасным путём — для записей, сохранённых
 * до появления истории, — и только если она про этот же узел: карточка привязана к
 * попытке, и чужой разбор выглядел бы ответом на сегодняшний вопрос.
 */
function arbiterCardFor(task: PipelineViewTask | null, nodeId: string) {
  const log = task?.graph?.arbiterLog;
  const fromLog = Array.isArray(log)
    ? log.find((row) => row?.node === nodeId && row?.card?.what)
    : null;

  if (fromLog) {
    return fromLog;
  }

  const card = task?.stall?.arbiter;

  if (!card?.card?.what) {
    return null;
  }

  return !card.node || card.node === nodeId ? card : null;
}

/**
 * Вход из узла фокусирует тот же блок, сохраняя окно и черновик.
 * Отдельная форма применения поверх окна этапа больше не создаётся.
 */
function openArbiterFromStage() {
  document.querySelector<HTMLElement>('[data-role="arbiter-conversation"] textarea')?.focus();
}

/**
 * Все входы остановки открывают один и тот же узел и его диалог.
 * У ворот и разведки сохраняется существующий порядок ответа.
 */
function openStallAnswer(task: PipelineViewTask) {
  openStallStage(task);
}

/** Открывает узел, на котором стоит остановка: решение принимают там. */

/**
 * Открывает узел текущей остановки по ключам того же графа.
 * При отсутствии узла не создаёт пустую модалку.
 */
function openStallStage(t: PipelineViewTask) {
  const nodeId = stallNodeId(t);

  if (!nodeId) {
    return;
  }

  const definition = t.graph?.nodes?.[nodeId] || [];

  openStage(t, {
    id: nodeId,
    label: definition[1] || nodeId,
    subtitle: definition[2] || '',
    status: t.graph?.statuses?.[nodeId] || 'stall',
  });
}

// Отдельный разбор арбитра: узел, его карточка и вопросы. Живёт рядом с модалкой узла,
// а не внутри неё — вопрос у него один, и ширина нужна вся.

const arbiterBusy = ref(new Set<TaskId>());

function canArbitrate(t: PipelineViewTask) {
  // Признак считает СЕРВЕР одним правилом (`stopIsArbitrable`), общим с гейтом самого
  // арбитра: раньше здесь стояла своя копия сравнения с `no-progress`, и после
  // расширения арбитра на вызов человека узлом она бы молча разошлась с ним.
  return !t.readOnly && !t.daemonAlive && t.stall?.arbitrable === true && !t.arbitrating;
}

// Идёт ли разбор ПРЯМО СЕЙЧАС — знает сервер, а не окно. Прежний признак жил только в
// нажавшем окне, поэтому автоматический обход вотчера не показывался нигде: задача
// выглядела вставшей, и человек шёл делать руками работу, которую в этот момент делал
// арбитр. Ровно то ложное чувство «конвейер встал, надо быть курьером».
//
// Подпись — общая (`shared/arbiterRun.ts`): её показывают три поверхности (свёрнутая
// карточка, узел схемы и модалка узла), и своя копия в каждой разъехалась бы.

/**
 * Разбирается ли ОТКРЫТЫЙ узел. Плашка на соседнем узле обещала бы работу там, где её
 * нет: арбитр занимается остановкой, а она принадлежит одному узлу.
 */
const stageArbitrating = computed(() => {
  if (!stage.value) {
    return null;
  }

  const task = tasks.value.find((x) => Number(x.task) === Number(stage.value!.task));

  if (!task?.arbitrating) {
    return null;
  }

  return nodeIsArbitrated(stage.value!.status, task.arbitrating) ? task.arbitrating : null;
});


/**
 * Передаёт остановку читающему арбитру по нажатию человека.
 * Открывает диалог узла после сохранения операции разбора.
 */
async function arbitrate(task: TaskId) {
  if (arbiterBusy.value.has(task)) {
    return;
  }

  arbiterBusy.value = new Set([...arbiterBusy.value, task]);

  try {
    await api.post(`/api/tasks/${task}/arbitrate`);
    await load();

    const current = tasks.value.find((row) => Number(row.task) === Number(task));

    if (current) {
      openStallStage(current);
    }
  } catch (error) {
    await alertDialog(`Разбор не удалось начать: ${errorMessage(error, '')}`);
  } finally {
    const remaining = new Set(arbiterBusy.value);

    remaining.delete(task);
    arbiterBusy.value = remaining;
  }
}

// Оборвавшийся прогон продолжает человек кнопкой: новый start движок отклонит,
// пока у задачи есть открытая попытка. Исторические записи остаются только чтением.
function canResume(t: PipelineViewTask) {
  return !t.readOnly && !t.daemonAlive && !!t.attempt
    && !['completed', 'abandoned'].includes(t.result || '');
}

function canRetrySandbox(t: PipelineViewTask) {
  return !t.readOnly && t.workspaceMode !== 'shared' && t.stall?.stage === 'SANDBOX';
}

function canDestroySandbox(t: PipelineViewTask) {
  return !t.readOnly && t.workspaceMode !== 'shared';
}
// «Закрыть задачу» = убрать прогон с экрана в архив. Разрешено, когда GrigDesk нечего
// сносить: стенда нет ЛИБО стенд не его. Прежнее условие смотрело только на порт фронта
// и молча означало «есть порт = есть НАША песочница, закрывать через снос стенда». В
// shared-режиме порт есть всегда (стенд общий, живёт вне задачи и переживает её), а
// кнопки «снести стенд» там нет по определению — доведённый до конца прогон оставался
// на экране НАВСЕГДА: убрать его было нечем ни одной кнопкой. Ровно так залипла
// выполненная задача тестового профиля. Сервер в shared-режиме при закрытии не
// трогает ни стенд, ни ветки — только переносит проекцию реестра в архив.
function canCloseTask(t: PipelineViewTask) {
  return !t.readOnly && !t.graph.sandbox && (!t.graph.fePort || !canDestroySandbox(t));
}


/**
 * Один список сохраняет независимые гейты и действия во всех видах карточки.
 * Главное действие выбирается после отбора: retry не вытесняет доступный resume.
 */
function cardActions(t: PipelineViewTask): PipelineCardAction[] {
  const actions: PipelineCardAction[] = [];
  const busy = sandboxBusy.value.has(t.task);

  /**
   * Общие атрибуты действия задаются один раз после проверки права в родителе.
   * Локальный список не меняет загрузку, подтверждения и эффекты обработчиков.
   */
  const add = (
    id: PipelineCardActionId,
    label: string,
    hint: string,
    loadingLabel: string,
    className: string,
  ) => {
    actions.push({
      id,
      label,
      hint,
      loadingLabel,
      className,
      role: id === 'answer' ? 'pipeline-stall-answer-open' : 'pipeline-compact-action',
      tone: ['stop', 'down', 'close'].includes(id) ? 'danger' : 'accent',
      busy: id === 'arbitrate' ? arbiterBusy.value.has(t.task) : busy,
      primary: false,
    });
  };

  if (canAnswerStall(t)) {
    const dialogEntry = t.stall?.phase !== 'bootstrap'
      && Boolean(t.stall?.arbitrable || t.stall?.conversation || arbiterAsksHuman(t));

    add(
      'answer', dialogEntry ? translate('core.arbiterDialogTitle') : '✍ ответить и продолжить',
      dialogEntry ? translate('core.arbiterEntryHint')
        : t.stall?.phase === 'bootstrap' ? 'Откроет вопрос разведки и поле ответа следующему SCOUT.'
          : 'Откроет узел: там указание агенту и возврат конвейера на него.',
      'Открываю решение', 'sbretry',
    );
  }

  if (canArbitrate(t)) {
    add(
      'arbitrate', `⚖ ${translate('core.arbiterAnalyzeStop')}`,
      arbiterAsksHuman(t) ? 'Арбитр уже отдал решение тебе; повтор нужен, только если условия изменились.'
        : 'Арбитр изучит остановку и предложит следующий шаг. Исправление выбираете вы.',
      'Арбитр разбирает', 'sbretry',
    );
  }

  if (canRetrySandbox(t)) {
    add(
      'retry', '↻ перезапустить стенд',
      'Снесёт остатки песочницы и продолжит конвейер с этого места.',
      'Перезапускаю стенд', 'sbretry',
    );
  }

  if (canResume(t)) {
    add(
      'resume', '▶ продолжить прогон', 'Та же попытка поедет дальше с узла, на котором оборвалась.',
      'Продолжаю прогон', 'sbresume',
    );
  }

  if (canStop(t)) {
    add('stop', '■ остановить', 'Остановит прогон; попытку можно будет продолжить.',
      'Останавливаю прогон', 'sbstop');
  }

  if (t.graph.fePort && canDestroySandbox(t)) {
    add('down', '⏏ снести стенд', 'Снесёт стенд задачи после подтверждения.', 'Сношу стенд', 'sbdown');
  }

  if (canCloseTask(t)) {
    add('close', '✓ закрыть задачу', 'Уберёт прогон с экрана в архив после подтверждения.',
      'Закрываю задачу', 'sbdown sbclose');
  }

  const human = t.stall?.stop === 'human' || (!t.stall?.stop && t.stall?.kind === 'human');
  const question = t.stall?.phase === 'bootstrap' || arbiterAsksHuman(t)
    || (human && t.stall?.outcome !== 'exhausted');
  const priority: PipelineCardActionId[] = question
    ? ['answer', 'retry', 'arbitrate', 'resume', 'stop', 'down', 'close']
    : ['retry', 'arbitrate', 'resume', 'answer', 'stop', 'down', 'close'];
  const primary = priority.find((id) => actions.some((action) => action.id === id));

  return actions.map((action) => ({ ...action, primary: action.id === primary }));
}

/**
 * Компонент действий только сообщает выбор, а эффекты остаются в родителе.
 * Прежние обработчики сохраняют подтверждения, HTTP и блокировку повторного запроса.
 */
function runCardAction(t: PipelineViewTask, id: PipelineCardActionId) {
  const handlers = {
    answer: () => openStallAnswer(t),
    arbitrate: () => arbitrate(t.task),
    retry: () => sandboxRetry(t.task),
    resume: () => resumeRun(t.task),
    stop: () => stopRun(t.task),
    down: () => sandboxDown(t.task),
    close: () => closeTask(t),
  };

  return handlers[id]();
}

/**
 * Продолжает оборвавшийся прогон после подтверждения человека.
 * Повторная команда блокируется до завершения запроса и обновления списка.
 */
async function resumeRun(task: TaskId) {
  if (sandboxBusy.value.has(task)) {
    return;
  }
  if (!await confirmDialog(
    `Продолжить прогон задачи #${task}? Конвейер поедет с того узла, на котором оборвался.`,
    { okText: 'Продолжить' },
  )) {
    return;
  }

  sandboxBusy.value = new Set([...sandboxBusy.value, task]);

  try {
    await api.post(`/api/tasks/${task}/resume`);
    await load();
  }
  catch (e) {
    alertDialog(`Не удалось продолжить: ${errorMessage(e, '')}`);
  }

  finally {
    const s = new Set(sandboxBusy.value);

    s.delete(task);
    sandboxBusy.value = s;
  }
}

// Работающий конвейер останавливает человек кнопкой: движок получает TERM и
// убирает за собой сам, попытка остаётся открытой для «продолжить прогон».
function canStop(t: PipelineViewTask) {
  return !t.readOnly && t.daemonAlive;
}


/**
 * Останавливает работающий прогон после подтверждения человека.
 * Состояние перечитывается перед снятием блокировки повторной команды.
 */
async function stopRun(task: TaskId) {
  if (sandboxBusy.value.has(task)) {
    return;
  }
  if (!await confirmDialog(
    `Остановить конвейер задачи #${task}? Текущий этап будет прерван, `
      + 'прогон встанет — продолжить его можно будет кнопкой «продолжить прогон».',
    { danger: true, okText: 'Остановить' },
  )) {
    return;
  }

  sandboxBusy.value = new Set([...sandboxBusy.value, task]);

  try {
    await api.post(`/api/tasks/${task}/stop`);
    await load();
  }
  catch (e) {
    alertDialog(`Не удалось остановить: ${errorMessage(e, '')}`);
  }

  finally {
    const s = new Set(sandboxBusy.value);

    s.delete(task);
    sandboxBusy.value = s;
  }
}

const ROUTE_ICON: Record<string, string> = {
  feature: '✨',
  debug: '🔍',
  trivial: '⚡',
  hunt: '🕵',
  perf: '⏱',
  dev: '🛠',
  quick: '⚡',
};

let loadPromise: Promise<void> | null = null;
let loadQueued = false;
let stateReloadTimer: ReturnType<typeof setTimeout> | null = null;
const STATE_RELOAD_DELAY_MS = 800;

/**
 * Один снимок страницы читает дешёвые state-файлы и их графы, затем обновляет уже
 * существующие B24-кеши. Вызов сериализован обёрткой `load`, чтобы старый ответ
 * никогда не перезаписал более свежий.
 */
async function loadSnapshot() {
  try {
    const { tasks: list = [], silenceWindow: nextSilenceWindow }
      = decodePipelineTasks(await api.get('/api/tasks'));
    const graphs = await Promise.all(
      list.map((t) => api.get(`/api/tasks/${t.task}/graph`).catch(() => null)
        .then((graph) => graph == null ? null : decodePipelineViewGraph(graph))),
    );

    silenceWindow.value = Number.isFinite(nextSilenceWindow) ? nextSilenceWindow! : 0;
    tasks.value = list.flatMap((task, index) => {
      const graph = graphs[index];

      return graph ? [{ ...task, graph }] : [];
    });
    // Названия задач из B24 (для заголовка) + доска (для «таймеров вне фабрики»).
    tasks.value.filter((task) => task.source !== 'grigdesk')
      .forEach((task) => taskStore.load(task.task).catch(() => {}));
    board.load();
    error.value = null;
  } catch (e) {
    error.value = errorMessage(e, '');
  } finally {
    loaded.value = true;
  }
}

/**
 * Single-flight с одним trailing-проходом: частые SSE не создают параллельный веер
 * `/graph`, но изменение, пришедшее во время чтения, обязательно будет перечитано.
 */
function load(): Promise<void> {
  if (loadPromise) {
    loadQueued = true;

    return loadPromise;
  }

  loadPromise = (async () => {
    do {
      loadQueued = false;
      await loadSnapshot();
    } while (loadQueued);
  })().finally(() => {
    loadPromise = null;
  });

  return loadPromise;
}

// `state-change` может приходить каждые 300 мс. Небольшой throttle сохраняет живость
// страницы, но не превращает каждый fs.watch-event в полный перечит всех графов.
function scheduleStateReload() {
  if (stateReloadTimer) {
    return;
  }

  stateReloadTimer = setTimeout(() => {
    stateReloadTimer = null;
    load();
  }, STATE_RELOAD_DELAY_MS);
}

useSse((name) => {
  // Разбор арбитра не меняет файлы состояния, поэтому `state-change` его не приносит:
  // у начала и конца хода своё событие. Без него окно узнавало бы о работающем арбитре
  // только на следующем перечитывании — то есть тогда, когда всё уже кончилось.
  if (name === 'state-change' || name === 'arbiter-live') {
    scheduleStateReload();
  }
});
load();

// Класс полосы прогресса по текущему статусу.

/**
 * Выбирает цвет полосы по текущему статусу узла конвейера.
 * Ожидание и аварийная остановка сохраняют свои отдельные состояния.
 */
function progressClass(g: PipelineViewGraph) {
  const cur = g.progress.current;
  const s = cur ? g.statuses[cur] : 'done';

  if (s === 'run') {
    return 'pk-run';
  }
  if (s === 'wait' || s === 'premature') {
    return 'pk-wait';
  }
  if (['stall', 'fail', 'skipbad'].includes(s || '')) {
    return 'pk-stall';
  }

  return 'pk-done';
}

function currentLabel(g: PipelineViewGraph) {
  const cur = g.progress.current;

  return cur ? stripEmoji(g.nodes[cur]?.[1]) : 'готово';
}

function loopList(g: PipelineViewGraph) {
  return Object.entries(g.loops || {}).map(([k, n]) => `${stripEmoji(g.nodes[k]?.[1]) || k} ×${n}`);
}


/**
 * Определяет состояние карточки по всем статусам графа.
 * Остановка имеет приоритет над ожиданием и выполняющимися узлами.
 */
function cardState(g: PipelineViewGraph) {
  const vals = Object.values(g.statuses);

  if (vals.some((s) => ['stall', 'fail', 'skipbad'].includes(s || ''))) {
    return 'stall';
  }
  if (vals.includes('wait') || vals.includes('premature')) {
    return 'attn';
  }
  if (vals.includes('run')) {
    return 'act';
  }

  return '';
}
</script>

<style scoped>
.pipeline {
  container-name: pipeline-view;
  container-type: inline-size;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* Панель заполняет верхний отступ оболочки и оставляет до карточек 12 px.
   Проекты получают свободное место, состояния и вид собраны справа. */
.toolbar {
  --pipeline-content-gutter: var(--page-gutter);
  position: sticky;
  top: calc(var(--pipeline-content-gutter) * -1);
  z-index: 30;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  min-height: calc(var(--toolbar-control-h) + 8px);
  margin: calc(var(--pipeline-content-gutter) * -1)
    calc(var(--pipeline-content-gutter) * -1)
    -2px;
  padding: 3px var(--pipeline-content-gutter) 4px;
  border-bottom: 1px solid var(--line);
  background: var(--topbar);
}

.status-filter-copy {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}

.status-dot {
  flex: none;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--ink-mid);
}

/* Цвет точки задаётся её собственным тоном, а не классом кнопки. Селектор вида
   `.status-filter … .status-dot` означал бы, что раздел перекрашивает общий control,
   и упирался бы в границу UI-библиотеки; заодно исчезает вторая карта «статус → цвет»
   рядом с той, что уже уехала в `tone` самой кнопки. */
.status-dot[data-tone='accent'] {
  background: var(--accent);
}

.status-dot[data-tone='warning'] {
  background: var(--warn);
}

.status-dot[data-tone='danger'] {
  background: var(--bad);
}

.status-count {
  min-width: 1ch;
  color: currentColor;
  font-size: 11px;
  line-height: 1;
  text-align: center;
}

.toolbar-icon {
  width: 16px;
  height: 16px;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.filter-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-height: 92px;
  border: 1px dashed var(--line-2);
  border-radius: var(--radius);
  color: var(--ink-mid);
  font-size: 12.5px;
}

.ttl {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0;
  color: var(--ink-mid);
  font-size: 12px;
  letter-spacing: .14em;
  text-transform: uppercase;
}

@container pipeline-view (max-width: 620px) {
  .filter-empty {
    align-items: flex-start;
    flex-direction: column;
    padding: 14px;
  }
}

/* Главный ряд измеряет только реально доступный ему левый участок. */
.project-strip {
  position: relative;
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  min-width: 0;
  overflow: clip visible;
}

.project-button-frame {
  display: inline-flex;
  flex: none;
  min-width: 0;
  max-width: 220px;
}

.project-option-copy,
.project-menu-copy {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.project-option-label,
.project-menu-copy > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.project-count {
  flex: none;
  color: currentColor;
  font-size: 11px;
  font-weight: 500;
}

.project-more-icon {
  width: 14px;
  height: 14px;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.project-menu {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.project-menu-copy {
  max-width: 260px;
}

.project-menu-copy > span {
  max-width: 220px;
}

.project-measure {
  position: absolute;
  top: 0;
  left: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  overflow: hidden;
  visibility: hidden;
  pointer-events: none;
  white-space: nowrap;
  contain: layout style;
}

.toolbar-secondary {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
}

.status-scroll {
  flex: none;
}

.secondary-status-filters {
  display: flex;
  align-items: center;
  gap: 3px;
  width: max-content;
}

.secondary-status-filters > .ui-button {
  flex: none;
}

.status-menu {
  display: none;
  flex: none;
}

.status-menu-options {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.status-menu-option-copy {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.status-menu-trigger-copy {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}

.status-menu-current {
  min-width: 0;
  max-width: 110px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.compact-view-controls {
  display: flex;
  align-items: center;
  gap: 2px;
  padding-left: 8px;
  border-left: 1px solid var(--line);
}

/* Состояния вторичны: сначала у них исчезает текст, но точки, числа и доступные
   названия остаются. Проекты получают освободившуюся ширину автоматически. */
@container pipeline-view (max-width: 1160px) {
  .secondary-status-filters .status-filter-label:not(.is-all) {
    display: none;
  }
}

/* На узком экране пять состояний становятся одним меню справа, а не выталкивают
   проекты на вторую строку. */
@container pipeline-view (max-width: 760px) {
  .status-scroll {
    display: none;
  }

  .status-menu {
    display: block;
  }
}

@container pipeline-view (max-width: 620px) {
  .project-button-frame {
    max-width: 130px;
  }

  .status-menu-label {
    display: none;
  }
}

@container pipeline-view (max-width: 420px) {
  .project-button-frame {
    max-width: 90px;
  }

  .project-more .project-more-icon {
    display: none;
  }

  .status-menu-current {
    display: none;
  }

  .toolbar,
  .toolbar-secondary {
    gap: 4px;
  }

  .compact-view-controls {
    padding-left: 4px;
  }
}

/* Очередь и слоты не входят в графы: у каждого блока собственные loading/error и
   последний удачный снимок. Поэтому визуально это одна операционная полоса, но не
   одна карточка с общим условием отображения. */
.waitme { margin: 6px 0 0; font-size: 12.5px; color: var(--warn);
  background: color-mix(in srgb, var(--warn) 12%, transparent); border: 1px solid color-mix(in srgb, var(--warn) 30%, transparent);
  border-radius: 8px; padding: 6px 10px; }
.waitme.premature { color: var(--bad); background: color-mix(in srgb, var(--bad) 12%, transparent); border-color: color-mix(in srgb, var(--bad) 30%, transparent); }
.waitme .pm { color: var(--bad); }

/* Признак разбора в ленте: одна строка вместо четырёх абзацев. Полный текст живёт в
   модалке узла — лента отвечает на «где стоит и на ком», а не заменяет собой карточку. */
.sarbnote { display: flex; align-items: baseline; gap: 8px; margin-top: 8px; padding: 6px 10px;
  border-left: 3px solid var(--ink-mid); border-radius: 8px; background: var(--surface-2);
  color: var(--ink-mid); font-size: 12px; }
.sarbnote.human { border-left-color: var(--warn); color: var(--ink);
  background: color-mix(in srgb, var(--warn) 8%, transparent); }
.sarbicon { flex: none; }
.sarbnote-text { min-width: 0; font-weight: 600; }
.sarbnote .samodel { margin-left: auto; }
.sarbopen { margin-top: 0; align-items: center; }
.sarbmore { margin-left: auto; flex: none; }
.err { color: var(--bad); }

.card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius);
  padding: 14px 16px; box-shadow: var(--shadow); border-left: 3px solid var(--line); }
.card.attn { border-left-color: var(--warn); }
.card.act { border-left-color: var(--accent); }
.card.stall { border-left-color: var(--bad); }

.head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.route { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, transparent); padding: 2px 8px; border-radius: 999px; }
.spacer { flex: 1; }
.daemon { font-size: 12px; white-space: nowrap; }
.daemon.alive { color: var(--good); }
.daemon.idle { color: var(--ink-mid); }
.daemon.stall { color: var(--bad); font-weight: 600; }
.b24-timer { flex: none; font-size: 12px; white-space: nowrap; }
.b24-timer.running { color: var(--good); }
.b24-timer.stopped { color: var(--ink-mid); }
.elapsed { font-size: 12px; color: var(--ink-mid); white-space: nowrap; }

.progress { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
.pbar-wrap { flex: 1; height: 6px; background: var(--surface-2); border-radius: 999px; overflow: hidden; }
.pbar { height: 100%; border-radius: 999px; transition: width .3s; }
.pbar.pk-run { background: var(--accent); }
.pbar.pk-wait { background: var(--warn); }
.pbar.pk-stall { background: var(--bad); }
.pbar.pk-done { background: var(--good); }
.pnum { font-size: 12px; color: var(--ink-mid); flex: none; }
.pw { font-size: 12px; color: var(--ink); flex: none; }

.gwrap { min-width: 0; margin: 8px 0; }

.strip { display: flex; flex-wrap: wrap; gap: 14px; font-size: 12.5px; color: var(--ink-mid);
  border-top: 1px solid var(--line); padding-top: 10px; }
.chunk { display: inline-flex; align-items: center; gap: 6px; }
.chunk.warn { color: var(--warn); }
.chunk.halted { color: var(--bad); }
.chunk.building { color: var(--accent); }
.strip a { color: var(--accent); margin-left: 6px; }
.sdot { width: 8px; height: 8px; border-radius: 50%; }
.sdot.on { background: var(--good); }
.sdot.off { background: var(--ink-mid); }

.pipeline-title-static { flex: 1; min-width: 0; overflow: hidden; color: var(--ink);
  font-size: 14px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }

.outside { margin-top: 4px; }
.outside .ttl { font-size: 12px; text-transform: uppercase; letter-spacing: .14em; color: var(--ink-mid); margin: 0 0 8px; }
.orow { display: flex; align-items: center; gap: 12px; background: var(--surface); border: 1px solid var(--line);
  border-radius: 10px; padding: 10px 14px; margin-bottom: 8px; }
.oid { color: var(--ink-mid); font-size: 13px; flex: none; }
.otimer { color: var(--good); font-size: 15px; flex: none; }

/* Модалка этапа */
.sh { min-height: 64px; flex: none; display: grid; grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center; gap: 14px; padding: 10px 14px 10px 18px; border-bottom: 1px solid var(--line);
  background: var(--topbar); }
.shead-copy { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.shead-kicker { color: var(--ink-mid); font-size: 10.5px; line-height: 1.25; text-transform: uppercase;
  letter-spacing: .08em; }
.sh h3 { min-width: 0; margin: 0; overflow: hidden; color: var(--ink); font-size: 17px; font-weight: 650;
  line-height: 1.3; text-overflow: ellipsis; white-space: nowrap; }
.shead-state { min-width: 0; display: flex; align-items: center; justify-content: flex-end;
  gap: 8px; flex-wrap: wrap; }

/* Контекст открытого решения: название задачи слева, прямой вход на её стенд справа. */
.stage-context { min-height: 56px; flex: none; display: grid;
  grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 18px;
  padding: 8px 18px; border-bottom: 1px solid var(--line);
  background: color-mix(in srgb, var(--ground) 72%, var(--surface)); }
.stage-task-context { min-width: 0; display: flex; align-items: baseline; gap: 10px; }
.stage-context-label { flex: none; color: var(--ink-mid); font-size: 10px; line-height: 1.3;
  text-transform: uppercase; letter-spacing: .065em; white-space: nowrap; }
.stage-context-label b { color: var(--ink); font-weight: 600; letter-spacing: 0; }
.stage-task-title { min-width: 0; overflow: hidden; color: var(--ink); font-size: 13.5px; font-weight: 600;
  line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }
.stage-stand-context { min-width: 0; display: flex; align-items: center; justify-content: flex-end;
  gap: 7px; }
.stage-stand-link { min-height: 30px; display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px;
  border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--line)); border-radius: 7px;
  background: color-mix(in srgb, var(--accent) 8%, var(--surface-2)); color: var(--accent);
  font-size: 11.5px; text-decoration: none; white-space: nowrap; }
.stage-stand-link:hover { border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, var(--surface-2)); }
.stage-stand-link b { color: inherit; font-weight: 550; }
.stage-stand-state { max-width: 310px; color: var(--ink-mid); font-size: 12px; line-height: 1.35;
  overflow-wrap: anywhere; }
.stage-stand-state.building { display: inline-flex; align-items: center; gap: 6px; color: var(--accent); }

/* Компактная строка метаданных */
.smeta { min-width: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.sbadge { flex: none; padding: 5px 11px; border-radius: 999px; font-size: 10.5px; font-weight: 650;
  line-height: 1.15; text-transform: uppercase; letter-spacing: .055em; white-space: nowrap; }
.sbadge.run { background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent); }
.sbadge.done { background: color-mix(in srgb, var(--good) 18%, transparent); color: var(--good); }
/* Разбор идёт: цвет тот же, что у узла на схеме, но со своим словом — «done» и
   «арбитр разбирает» не должны выглядеть одинаково. */
.sbadge.arb { background: color-mix(in srgb, var(--good) 18%, transparent); color: var(--good);
  animation: sarbfade 1.8s ease-in-out infinite; }
@keyframes sarbfade { 50% { opacity: .62; } }
@media (prefers-reduced-motion: reduce) { .sbadge.arb { animation: none; } }
.sbadge.wait, .sbadge.premature { background: color-mix(in srgb, var(--warn) 18%, transparent); color: var(--warn); }
.sbadge.pending, .sbadge.idle { background: var(--surface-2); color: var(--ink-mid); }
.sbadge.stall, .sbadge.skipbad, .sbadge.fail { background: color-mix(in srgb, var(--bad) 18%, transparent); color: var(--bad); }
.sbadge.skip { background: var(--surface-2); color: var(--ink-mid); }
.smchip { flex: none; padding: 3px 8px; border-radius: 6px; background: var(--surface-2); color: var(--ink-mid);
  font-size: 11.5px; line-height: 1.35; white-space: nowrap; }
.smchip.failed { color: var(--bad); background: color-mix(in srgb, var(--bad) 12%, transparent); }
/* Разбор арбитра в плашке остановки. Человеческая формулировка стоит выше сырых находок
   по значимости, поэтому у неё акцентная рамка, а не приглушённый вид справки. */
/* Идущий разбор. Акцентная, но НЕ тревожная плашка: работа не стоит, а движется —
   красный и жёлтый здесь означали бы обратное. Вертится только точка: полоса прогресса
   обещала бы известную длительность, а ход арбитра длится сколько потребуется. */
.sarbrun { display: flex; align-items: center; gap: 8px; margin-top: 8px;
  padding: 8px 11px; border-radius: 8px;
  border-left: 3px solid var(--good);
  background: color-mix(in srgb, var(--good) 8%, transparent);
  color: var(--ink); font-size: 12.5px; }
/* В модалке плашка стоит первой строкой тела, поэтому верхнего отступа ей не нужно. */
.sarbrun.sarbnode { margin: 0 0 10px; }
.sarbspin { width: 9px; height: 9px; flex: none; border-radius: 50%;
  background: var(--good); animation: sarbpulse 1.1s ease-in-out infinite; }
.sarbtxt { font-weight: 600; }
.sarbmeta { margin-left: auto; color: var(--ink-mid); font-size: 10.5px; opacity: .8; }
@keyframes sarbpulse { 0%, 100% { opacity: .35; transform: scale(.82); }
  50% { opacity: 1; transform: scale(1); } }
@media (prefers-reduced-motion: reduce) { .sarbspin { animation: none; opacity: .9; } }
.samodel { margin-left: auto; color: var(--ink-mid); font-size: 10.5px; opacity: .8; }

/* Находки узла. Свой блок и свой скролл, а не строка внутри `.snotices`: пять
   замечаний по три строки каждое не помещаются в 130px дайджеста, а обрезать здесь
   нечего — это и есть то, ради чего человека позвали. */
.sverdict { min-width: 0; }
.svhead { display: flex; align-items: baseline; gap: 8px; }
.svhead .sclbl { margin-bottom: 6px; }
.svfiles { margin-left: auto; color: var(--ink-mid); font-size: 10.5px; opacity: .75; }
.svlist { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 7px; }
.svlist li { padding: 8px 11px; border-left: 3px solid var(--warn); border-radius: 8px;
  background: var(--surface-2); color: var(--ink); font-size: 12.5px; line-height: 1.45;
  overflow-wrap: anywhere; }
/* Отложенная находка не требует действия сейчас — она обязана визуально уступать
   блокирующей, иначе список из пяти пунктов читается как пять срочных дел. */
.svlist li.deferred { border-left-color: var(--line); color: var(--ink-mid); }
.svanchor { display: block; margin-bottom: 3px; color: var(--ink-mid); font-size: 11px; opacity: .85; }
.svmore { margin-top: 7px; color: var(--ink-mid); font-size: 11.5px; }
/* Остановка на человеке — единственный случай, где блок сам является вызовом. */
.sverdict.human .sclbl { color: var(--warn); opacity: 1; }
.snotices { min-width: 0; display: flex; flex-direction: column; gap: 7px; }
.scomment { margin: 0; padding: 8px 11px; border-left: 3px solid var(--line); border-radius: 8px;
  background: var(--surface-2); color: var(--ink-mid); font-size: 12.5px; line-height: 1.45;
  white-space: pre-wrap; overflow-wrap: anywhere; }
.scomment.failed { color: var(--ink); border-left-color: var(--bad);
  background: color-mix(in srgb, var(--bad) 9%, transparent); }
.sclbl { display: block; margin-bottom: 2px; color: var(--ink-mid); font-size: 10px; text-transform: uppercase;
  letter-spacing: .055em; opacity: .8; }
.jf { font-size: 11px; color: var(--ink-mid); padding: 2px 8px; border-radius: 6px;
  background: var(--surface-2); text-transform: none; letter-spacing: 0; margin-left: auto; }
.jf.on { color: var(--good); background: color-mix(in srgb, var(--good) 12%, transparent); }

/* Рабочая область: информация слева, действия справа. Обе колонки скроллятся внутри
   viewport-рамки, поэтому шапка и нижние действия всегда остаются на экране. */
.sconversation { flex: 1; min-height: 0; overflow-y: auto; padding: 16px 18px; }
.sworkspace { min-width: 0; min-height: 0; flex: 1; display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(380px, 470px); grid-template-areas: "main rail";
  overflow: hidden; background: var(--surface); }
.sworkspace.main-only { grid-template-columns: minmax(0, 1fr); grid-template-areas: "main"; }
.sworkspace.rail-only { grid-template-columns: minmax(0, 1fr); grid-template-areas: "rail"; }
.smain, .srail { min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: 14px;
  overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; padding: 16px 18px; }
.smain { grid-area: main; }
.srail { grid-area: rail; border-left: 1px solid var(--line);
  background: color-mix(in srgb, var(--ground) 45%, var(--surface)); }
.sworkspace.rail-only .srail { border-left: 0; background: var(--surface); }
.sect { min-width: 0; display: flex; flex-direction: column; gap: 10px; }
.secth { min-width: 0; display: flex; align-items: center; gap: 8px; color: var(--ink-mid); font-size: 11px;
  font-weight: 600; line-height: 1.3; text-transform: uppercase; letter-spacing: .08em; }
.content-sect { padding: 13px 14px; border: 1px solid var(--line); border-radius: 11px; background: var(--ground); }

/* Фактическая multi-AI цепочка этапа и история аварийных переключений. */
.runner-sect { padding: 14px; border: 1px solid var(--line); border-radius: 11px; background: var(--ground); }
.runner-source { margin-left: auto; font-size: 10.5px; text-transform: none;
  letter-spacing: 0; font-weight: 400; text-align: right; opacity: .8; }
/* Цепочка — справка, а не выбор: одна мелкая строка чипов, без заливки и веса. */
.runner-chain { display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  font-size: 11px; color: var(--ink-mid); }
.runner-chain-lbl { text-transform: uppercase; letter-spacing: .06em; font-size: 10px; opacity: .8; }
.runner-arrow { flex: none; opacity: .7; }
.runner-hop { min-width: 0; display: inline-flex; align-items: baseline; gap: 5px; padding: 2px 8px;
  border: 1px solid color-mix(in srgb, var(--line) 75%, transparent); border-radius: 999px; }
.runner-hop small { color: var(--ink-mid); font: 10px/1.4 var(--mono); opacity: .75; overflow-wrap: anywhere; }
.runner-hop.reserve { border-style: dashed; }
.runner-hop.actual { color: var(--ink); border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); }
.runner-current { padding: 7px 9px; border-radius: 8px; background: var(--surface-2); color: var(--ink-mid);
  font-size: 12px; line-height: 1.4; overflow-wrap: anywhere; }
.runner-current.switched { color: var(--warn); }
.runner-attempts { max-height: min(250px, 30vh); display: flex; flex-direction: column; gap: 2px;
  overflow-y: auto; padding-top: 9px; border-top: 1px solid var(--line); }
.runner-attempt-title { position: sticky; top: 0; z-index: 1; padding: 0 4px 5px; background: var(--ground);
  color: var(--ink-mid); font-size: 10px; text-transform: uppercase; letter-spacing: .065em; }
.runner-attempt { min-height: 27px; display: grid;
  grid-template-columns: 34px 72px minmax(110px, 1fr) auto auto;
  align-items: center; gap: 8px; padding: 3px 6px; border-radius: 6px; color: var(--ink-mid); font-size: 11.5px; }
.runner-attempt:nth-child(odd) { background: color-mix(in srgb, var(--surface-2) 55%, transparent); }
.runner-attempt-model { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.runner-attempt-cost { justify-self: end; white-space: nowrap; color: var(--ink-low); }
.runner-result { justify-self: end; white-space: nowrap; }
.runner-result.success { color: var(--good); }
.runner-result.switched { color: var(--accent); }
.runner-result.failed { color: var(--warn); }
.runner-switches { display: flex; flex-wrap: wrap; gap: 7px; }
/* Выбор исполнителя до запуска этапа (override) — главное действие блока, отсюда карточки. */
.runner-override { display: flex; flex-direction: column; gap: 8px; }
.runner-override-lbl { color: var(--ink-mid); font-size: 10px; text-transform: uppercase; letter-spacing: .06em; }
.runner-override-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.runner-picks { display: flex; align-items: stretch; gap: 8px; flex-wrap: wrap; }
.runner-reset { align-self: center; margin-left: auto; }
.runner-hint { margin: 0; font-size: 11.5px; color: var(--ink-mid); line-height: 1.4; }

/* Живая лента действий */
.live-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--bad);
  animation: live-pulse 1.2s ease-in-out infinite; display: inline-block; }
@keyframes live-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
.live-feed { max-height: 280px; overflow-y: auto; background: color-mix(in srgb, var(--ground) 88%, #000);
  border: 1px solid var(--line); border-radius: 9px; padding: 4px 0; }
.lf-row { display: flex; align-items: flex-start; gap: 8px; padding: 5px 12px; font-size: 12.5px;
  border-bottom: 1px solid color-mix(in srgb, var(--line) 40%, transparent); }
.lf-row:last-child { border-bottom: none; }
.lf-row.run { background: color-mix(in srgb, var(--accent) 6%, transparent); }
.lf-icon { flex: none; width: 18px; text-align: center; font-size: 13px; line-height: 1.4; }
.lf-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.lf-name { font-weight: 600; color: var(--ink); }
.lf-desc { color: var(--ink-mid); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lf-text { color: var(--ink-mid); font-style: italic; overflow-wrap: anywhere; }
.lf-sub { font-size: 11px; color: var(--ink-mid); }
.lf-st { flex: none; width: 16px; text-align: center; font-size: 11px; }
.lf-st.done { color: var(--good); }
.lf-st.run { color: var(--accent); animation: live-pulse 1s ease-in-out infinite; }
.lf-st.error { color: var(--bad); }
.lf-model { font-size: 10.5px; color: var(--ink-mid); margin-top: 6px; text-align: right; }

.log { max-height: 180px; overflow: auto; padding: 8px 10px; border: 1px solid var(--line);
  border-radius: 8px; background: color-mix(in srgb, var(--ground) 88%, #000); }
.logline { padding: 2px 0; font-size: 12px; overflow-wrap: anywhere; }
.small { font-size: 12px; }
.sdoc { min-width: 0; overflow-x: auto; overflow-wrap: anywhere; padding: 12px 14px;
  border: 1px solid var(--line); border-radius: 9px; background: color-mix(in srgb, var(--ground) 88%, #000);
  font-size: 13px; line-height: 1.55; }
.sdoc :deep(h1) { font-size: 15px; margin: 4px 0 8px; }
.sdoc :deep(h2) { font-size: 13.5px; margin: 12px 0 6px; }
.sdoc :deep(h3) { font-size: 12.5px; margin: 10px 0 4px; }
.sdoc :deep(code) { background: var(--surface-2); border-radius: 4px; padding: 1px 5px; font-size: 12px; }
.sdoc :deep(pre) { background: var(--surface-2); border-radius: 8px; padding: 10px; overflow-x: auto; }
.sdoc :deep(table) { border-collapse: collapse; }
.sdoc :deep(td), .sdoc :deep(th) { border: 1px solid var(--line); padding: 4px 8px; font-size: 12px; }
/* Вопросы узла. Номер и формулировка стоят НАД полем, а не сбоку: вопрос агента бывает
   в две строки, и боковая колонка сжимала бы поле ответа до нечитаемого. */
.rwq { display: flex; flex-direction: column; gap: 10px; margin-bottom: 10px; }
.rwqhead { color: var(--warn); font-size: 10.5px; text-transform: uppercase;
  letter-spacing: .055em; }
.rwqitem { display: flex; flex-direction: column; gap: 4px; }
.rwqlbl { display: flex; align-items: baseline; gap: 6px;
  color: var(--ink); font-size: 12px; line-height: 1.4; }
.rwqnum { flex: none; min-width: 15px; color: var(--warn); font-weight: 600; }
.rwqsum { flex: 1; min-width: 0; }
.rwqfree { margin-bottom: 4px; color: var(--ink-mid); font-size: 11.5px; }
/* Сводка решений арбитра в воротах. Приглушённая: это справка перед решением человека,
   а не само решение — акцент здесь принадлежит кнопкам «Принять»/«Отклонить». */
.gwal { margin-bottom: 12px; padding-bottom: 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--line) 70%, transparent); }
.gwalh { margin-bottom: 6px; color: var(--ink-mid); font-size: 10.5px;
  text-transform: uppercase; letter-spacing: .055em; }
.gwrow { display: flex; align-items: baseline; gap: 7px; margin-bottom: 4px;
  font-size: 12px; line-height: 1.4; }
.gwtag { flex: none; padding: 1px 6px; border-radius: 5px; font-size: 10px;
  background: color-mix(in srgb, var(--ink-mid) 18%, transparent); color: var(--ink-mid); }
/* Решение о границе задачи проверяют пристальнее снятого технического тупика. */
.gwrow.deferred .gwtag { background: color-mix(in srgb, var(--warn) 20%, transparent);
  color: var(--warn); }
.gwwhat { flex: 1; min-width: 0; color: var(--ink); }
/* Ситуация — условие решения, поэтому она в той же колонке и в том же ритме, что кнопки,
   но тише их: рамка нейтральная, тревожность несут сами блоки внутри. */
.situation-sect { padding: 14px; border: 1px solid var(--line); border-radius: 11px;
  background: var(--ground); }
.gate-sect, .rewind-sect { padding: 14px; border-radius: 11px; }
.gate-sect { border: 1px solid color-mix(in srgb, var(--warn) 35%, var(--line));
  background: color-mix(in srgb, var(--warn) 7%, var(--ground)); }
.gate-sect .secth { color: var(--warn); }
.rewind-sect { border: 1px solid color-mix(in srgb, var(--warn) 22%, var(--line));
  background: color-mix(in srgb, var(--warn) 4%, var(--ground)); }
.gate-lbl { font-size: 12.5px; color: var(--ink); }
.gate-hint { margin: 0; color: var(--ink-mid); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.gbtns { display: flex; flex-wrap: wrap; gap: 8px; }

/* Чат и диф закреплены в подвале модалки. */
.sactions { min-height: 58px; flex: none; display: flex; align-items: center; justify-content: space-between;
  gap: 14px; margin-top: auto; padding: 9px 16px 9px 18px; border-top: 1px solid var(--line); background: var(--topbar); }
.sactions-context { color: var(--ink-mid); font-size: 11.5px; white-space: nowrap; }
.sactions-context b { color: var(--ink); font-weight: 550; }
.sactions-buttons { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }

/* Планшет: одна внутренняя колонка; управление идёт первым благодаря порядку DOM. */
@media (max-width: 980px) {
  .sworkspace, .sworkspace.main-only, .sworkspace.rail-only { display: flex; flex-direction: column;
    gap: 12px; overflow-y: auto; padding: 12px; }
  .smain, .srail { flex: none; overflow: visible; padding: 0; border: 0; background: transparent;
    scrollbar-gutter: auto; }
}

/* Телефон: тот же fullscreen-паттерн, что у просмотра документа. */
@media (max-width: 600px) {
  .sh { min-height: 66px; grid-template-columns: minmax(0, 1fr) var(--control-height); grid-template-rows: auto auto;
    column-gap: 10px; row-gap: 5px; padding: 8px 10px 8px 14px; }
  .shead-copy { grid-column: 1; grid-row: 1; }
  .shead-state { grid-column: 1; grid-row: 2; justify-content: flex-start; }
  .sx { grid-column: 2; grid-row: 1 / span 2; }
  .sh h3 { font-size: 15px; }
  .shead-kicker { font-size: 9.5px; }
  .stage-context { min-height: 0; grid-template-columns: minmax(0, 1fr); gap: 7px; padding: 8px 12px 9px; }
  .stage-task-context { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 8px; }
  .stage-task-title { display: -webkit-box; overflow: hidden; font-size: 13px; white-space: normal;
    overflow-wrap: anywhere; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
  .stage-stand-context { justify-content: flex-start; gap: 6px; overflow-x: auto; }
  .stage-stand-link { min-height: 34px; }
  .stage-stand-state { max-width: none; }
  .jf { margin-left: 0; }
  .sworkspace, .sworkspace.main-only, .sworkspace.rail-only { gap: 10px; padding: 10px; }
  .smain, .srail { gap: 10px; }
  .runner-sect, .content-sect, .gate-sect, .rewind-sect, .situation-sect { padding: 12px; }
  .secth { flex-wrap: wrap; }
  .runner-source { width: 100%; margin-left: 0; text-align: left; }
  .runner-attempt { grid-template-columns: 32px minmax(0, 1fr) auto; grid-template-rows: auto auto;
    align-items: baseline; gap: 2px 7px; padding: 5px 6px; }
  .runner-attempt-model { grid-column: 2 / 3; grid-row: 2; white-space: normal; overflow-wrap: anywhere; }
  /* Цена — под результатом своей же попытки: колонки узкие, и в первой строке
     она вытолкнула бы имя исполнителя за край. */
  .runner-attempt-cost { grid-column: 3; grid-row: 2; }
  .runner-result { grid-column: 3; grid-row: 1; }
  .gbtns .btn { flex: 1 1 140px; }
  .sactions { min-height: 62px; padding: 9px 10px calc(9px + env(safe-area-inset-bottom)); }
  .sactions-context { display: none; }
  .sactions-buttons { width: 100%; }
  .sactions-buttons > .btn, .sactions :deep(.oc) { flex: 1; }
}

@media (max-height: 700px) and (min-width: 601px) {
  .sh { min-height: 56px; }
  .live-feed { max-height: 190px; }
  .runner-attempts { max-height: 200px; }
}
@media (max-width: 600px) {
  .head { flex-wrap: wrap; gap: 6px 8px; }
  .head .ctitle { order: 10; flex: 1 0 100%; white-space: normal; overflow-wrap: anywhere; }
}
</style>

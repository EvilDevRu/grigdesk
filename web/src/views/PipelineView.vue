<template>
  <div class="pipeline">
    <div class="toolbar">
      <div class="tbrow">
        <h2 class="ttl">Задачи в работе <span class="cnt">{{ filteredTasks.length }}</span>
          <span v-if="waitingCount" class="needme">⏳ ждут тебя: {{ waitingCount }}</span>
          <span v-if="stalledCount" class="stalledme" :title="stalledTitles">🛑 встали: {{ stalledCount }}</span>
        </h2>
        <div class="tools">
          <UiToggleButton
            :model-value="loopsOn"
            data-role="pipeline-toolbar"
            tone="accent"
            variant="outline"
            @update:model-value="toggleLoops"
          >
            ↻ петли
          </UiToggleButton>
          <UiToggleButton
            :model-value="compact"
            data-role="pipeline-toolbar"
            tone="accent"
            variant="outline"
            @update:model-value="toggleCompact"
          >
            {{ compact ? '▤ подробно' : '☰ компактно' }}
          </UiToggleButton>
        </div>
      </div>
      <div v-if="projects.length" class="projects">
        <UiButton
          class="pchip"
          data-role="pipeline-project"
          tone="accent"
          variant="outline"
          :pressed="activeProject === 'all'"
          @click="setProject('all')"
        >
          все <b>{{ tasks.length }}</b>
        </UiButton>
        <UiButton
          v-for="p in projects"
          :key="p"
          class="pchip"
          data-role="pipeline-project"
          tone="accent"
          variant="outline"
          :pressed="activeProject === p"
          @click="setProject(p)"
        >
          {{ p }} <b>{{ tasks.filter(t => t.profile === p).length }}</b>
        </UiButton>
      </div>
    </div>

    <p v-if="!loaded" class="muted">Загрузка…</p>
    <p v-else-if="error" class="err">Ошибка: {{ error }}</p>
    <p v-else-if="!tasks.length" class="muted">Задач в состоянии фабрики нет.</p>

    <article v-for="t in filteredTasks" :key="t.task" class="card" :class="[t.readOnly ? 'readonly' : cardState(t.graph), { collapsed: isCollapsed(t.task) }]">
      <header class="head">
        <UiIconButton
          v-if="!compact"
          class="chev"
          role="rail"
          :label="isCollapsed(t.task) ? 'Развернуть' : 'Свернуть'"
          :title="isCollapsed(t.task) ? 'Развернуть' : 'Свернуть'"
          @click="toggleCard(t.task)"
        >
          {{ collapsedSet.has(t.task) ? '▸' : '▾' }}
        </UiIconButton>
        <UiButton
          class="task mono"
          data-role="pipeline-task-id"
          title="Свернуть/развернуть"
          variant="text"
          @click="toggleCard(t.task)"
        >
          #{{ t.task }}
        </UiButton>
        <span class="route">{{ ROUTE_ICON[t.route] || '•' }} {{ t.route }}</span>
        <span v-if="t.graph.runnerPolicy?.chain?.length" class="runner-policy"
              :title="`Аварийная цепочка проекта: ${runnerChainLabel(t.graph.runnerPolicy)}`">
          ИИ {{ runnerChainLabel(t.graph.runnerPolicy) }}
        </span>
        <UiButton
          v-if="b24Title(t.task)"
          class="ctitle"
          data-role="pipeline-title"
          :title="title(t)"
          variant="text"
          @click="ui.openTask(t.task)"
        >
          {{ title(t) }}
        </UiButton>
        <span
          v-else-if="title(t)"
          class="ctitle pipeline-title-static ticket"
          :title="title(t)"
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
          title="Таймер Битрикс24 по этой задаче"
        >
          {{ b24TimerLabel(t) }}
        </span>
        <!-- Чистая работа узлов: все петли входят, ожидание человека на воротах — нет. -->
        <span v-if="t.graph.timing" class="elapsed mono" :title="elapsedTitle(t)">⏱ {{ elapsedLabel(t) }}</span>
      </header>

      <div class="progress">
        <div class="pbar-wrap">
          <div class="pbar" :class="progressClass(t.graph)"
               :style="{ width: (t.graph.progress.done / t.graph.progress.total * 100) + '%' }"></div>
        </div>
        <span class="pnum mono">{{ t.graph.progress.done }}/{{ t.graph.progress.total }}</span>
        <span class="pw">{{ currentLabel(t.graph) }}</span>
      </div>

      <!-- Ждёт тебя (видно и в свёрнутом виде) -->
      <div v-if="!t.readOnly && waitingReason(t.graph)" class="waitme" :class="{ premature: waitingReason(t.graph).premature }">
        ⏳ ждёт тебя: {{ waitingReason(t.graph).text }}
        <span v-if="waitingReason(t.graph).premature" class="pm">(преждевременно — хвост не доделан)</span>
      </div>

      <!-- ПОЧЕМУ КОНВЕЙЕР СТОИТ. Движок останавливается сам и зовёт человека, но до сих
           пор писал причину только в logs/tNNNN.stages.log — в интерфейсе её не было
           вовсе. Поэтому плашка живёт рядом с «ждёт тебя» и видна в свёрнутом виде:
           затык надо замечать в списке, а не открывая карточку. -->
      <div v-if="!t.readOnly && t.stall && isCollapsed(t.task)" class="stalled" :class="t.stall.kind">
        <div class="srow">
          <span class="sico">{{ t.stall.kind === 'crashed' ? '✖' : '🛑' }}</span>
          <span class="stitle">{{ t.stall.title }}</span>
          <span v-if="t.stall.since" class="ssince mono">{{ t.stall.since }}</span>
        </div>
        <div class="shint">{{ t.stall.hint }}</div>
        <div v-if="t.stall.comment" class="scomment">замечание движка: {{ t.stall.comment }}</div>
        <!-- Единственный затык, который чинится прямо отсюда: упавший подъём стенда.
             Кнопки «снести стенд» в подвале карточки в этот момент нет — она привязана
             к живому порту фронта, — поэтому починка живёт в самой плашке. -->
        <!-- Типизированное топтание разбирает арбитр: собирает оба вердикта дуги,
             проверяет спорное в рабочем дереве и возвращает курсор с указанием. Это
             замена курьерской работы человека, а не «ещё одна модель»: замер по
             журналам — 28 таких остановок, сумма ожидания 59.7 часа. -->
        <div v-if="canArbitrate(t)" class="sfix">
          <UiButton
            class="sbretry"
            data-role="pipeline-compact-action"
            tone="accent"
            variant="outline"
            :loading="arbiterBusy.has(t.task)"
            :disabled="arbiterBusy.has(t.task)"
            loading-label="Арбитр разбирает"
            @click="arbitrate(t.task)"
          >
            ⚖ разобрать и продолжить
          </UiButton>
          <span class="sfixhint">арбитр проверит спор по коду и вернёт узел с указанием;
            границу задачи он менять не вправе и отдаст её тебе</span>
        </div>
        <div v-if="canRetrySandbox(t) || canResume(t)" class="sfix">
          <UiButton
            v-if="canRetrySandbox(t)"
            class="sbretry"
            data-role="pipeline-compact-action"
            tone="accent"
            variant="outline"
            :loading="sandboxBusy.has(t.task)"
            :disabled="sandboxBusy.has(t.task)"
            loading-label="Перезапускаю стенд"
            @click="sandboxRetry(t.task)"
          >
            ↻ перезапустить стенд
          </UiButton>
          <!-- Оборвавшийся прогон: стенд на месте, продолжать нужно ту же попытку. -->
          <UiButton
            v-else
            class="sbretry"
            data-role="pipeline-compact-action"
            tone="accent"
            variant="outline"
            :loading="sandboxBusy.has(t.task)"
            :disabled="sandboxBusy.has(t.task)"
            loading-label="Продолжаю прогон"
            @click="resumeRun(t.task)"
          >
            ▶ продолжить прогон
          </UiButton>
          <span class="sfixhint">{{ canRetrySandbox(t)
            ? 'снесёт остатки песочницы и продолжит конвейер с этого места'
            : 'та же попытка поедет дальше с узла, на котором оборвалась' }}</span>
        </div>
      </div>

      <div v-if="!isCollapsed(t.task)" class="gwrap">
        <FactoryGraph :graph="t.graph" :loops-on="loopsOn" @node="(n) => openStage(t, n)" />
      </div>

      <footer v-if="!isCollapsed(t.task)" class="strip">
        <span v-if="t.graph.fePort" class="chunk">
          <span class="sdot" :class="t.daemonAlive ? 'on' : 'off'"></span>
          стенд · <a :href="sandboxUrl(t.graph.fePort)" target="_blank" rel="noopener">фронт :{{ t.graph.fePort }}</a>
          <a v-if="t.graph.apiPort" :href="sandboxUrl(t.graph.apiPort)" target="_blank" rel="noopener">API :{{ t.graph.apiPort }}</a>
        </span>
        <!-- Стенд ещё строится: живой прогресс сборки песочницы из t*.stage -->
        <span v-else-if="t.graph.sandbox" class="chunk building">
          <UiSpinner decorative />
          стенд строится · {{ t.graph.sandbox.step }}/{{ t.graph.sandbox.total }} · {{ t.graph.sandbox.label }}
        </span>
        <!-- Развёрнутая карточка: продолжение прогона рядом с остальными действиями —
             плашка затыка видна только у свёрнутой. -->
        <UiButton
          v-if="canStop(t)"
          class="sbstop"
          data-role="pipeline-compact-action"
          tone="danger"
          variant="outline"
          :loading="sandboxBusy.has(t.task)"
          :disabled="sandboxBusy.has(t.task)"
          loading-label="Останавливаю прогон"
          @click="stopRun(t.task)"
        >
          ■ остановить
        </UiButton>
        <UiButton
          v-if="canResume(t)"
          class="sbresume"
          data-role="pipeline-compact-action"
          tone="accent"
          variant="outline"
          :loading="sandboxBusy.has(t.task)"
          :disabled="sandboxBusy.has(t.task)"
          loading-label="Продолжаю прогон"
          @click="resumeRun(t.task)"
        >
          ▶ продолжить прогон
        </UiButton>
        <UiButton
          v-if="t.graph.fePort && canDestroySandbox(t)"
          class="sbdown"
          data-role="pipeline-compact-action"
          tone="danger"
          variant="outline"
          :loading="sandboxBusy.has(t.task)"
          :disabled="sandboxBusy.has(t.task)"
          loading-label="Сношу стенд"
          @click="sandboxDown(t.task)"
        >
          ⏏ снести стенд
        </UiButton>
        <!-- Класс sbclose — только адрес кнопки (оформление общее с «снести стенд»):
             обе выглядят одинаково, а различать их надо и тесту, и глазами в разметке. -->
        <UiButton
          v-if="canCloseTask(t)"
          class="sbdown sbclose"
          data-role="pipeline-compact-action"
          tone="danger"
          variant="outline"
          :loading="sandboxBusy.has(t.task)"
          :disabled="sandboxBusy.has(t.task)"
          loading-label="Закрываю задачу"
          @click="closeTask(t)"
        >
          ✓ закрыть задачу
        </UiButton>
        <span v-if="loopList(t.graph).length" class="chunk warn">↻ возвраты: {{ loopList(t.graph).join(', ') }}</span>
        <span v-if="t.graph.halted" class="chunk halted">⚠ застряла на {{ stripEmoji(t.graph.nodes[t.graph.halted]?.[1]) || t.graph.halted }}</span>
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
            <h3 id="stage-modal-title">{{ stage.label }}</h3>
          </div>
          <span class="sbadge" :class="stage.status">{{ STAGE_HINT[stage.status] || stage.status }}</span>
          <UiIconButton
            class="sx"
            data-context="pipeline-stage-close"
            label="Закрыть этап"
            title="Закрыть (Esc)"
            @click="closeStage()"
          >
            ✕
          </UiIconButton>
        </header>

        <!-- Контекст решения: задачу и её стенд видно, пока ворота открыты. Ссылки те же,
             что в подвале карточки конвейера; нового действия или отдельного API здесь нет. -->
        <div id="stage-task-context" class="stage-context">
          <div class="stage-task-context">
            <span class="stage-context-label">Задача <b class="mono">#{{ stage.task }}</b></span>
            <span v-if="stageTaskTitle" class="stage-task-title" :title="stageTaskTitle">{{ stageTaskTitle }}</span>
            <span v-else class="stage-task-title muted">Название загружается…</span>
          </div>
          <div class="stage-stand-context">
            <span class="stage-context-label">Стенд</span>
            <template v-if="stageGraph?.fePort">
              <a class="stage-stand-link" :href="sandboxUrl(stageGraph.fePort)" target="_blank" rel="noopener">
                Фронт <b class="mono">:{{ stageGraph.fePort }}</b> <span aria-hidden="true">↗</span>
              </a>
              <a v-if="stageGraph.apiPort" class="stage-stand-link" :href="sandboxUrl(stageGraph.apiPort)"
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

        <!-- Компактная строка метаданных -->
        <div v-if="stage.meta.at || stage.meta.dur != null || stage.meta.fanout != null
          || stage.meta.denials || stage.meta.tokens || stage.meta.fails || stage.sub || stageActivity"
          class="smeta" aria-label="Показатели этапа">
          <span v-if="stage.meta.at" class="smchip mono">{{ stage.meta.at.slice(11, 16) || stage.meta.at }}</span>
          <span v-if="stage.meta.dur != null" class="smchip">{{ stage.meta.dur }} мин</span>
          <span v-if="stage.meta.fanout != null" class="smchip">{{ stage.meta.fanout }} субаг.</span>
          <!-- Отказ политики прав показываем ТОЛЬКО когда он был: ноль и «не знаем»
               одинаково означают «беспокоиться не о чем», а нулевой чип в каждой строке
               обесценил бы ненулевой. Он предупреждает о подмене проверки: агент, которому
               запретили нужный запуск, склонен подобрать похожий и выдать его результат за
               доказательство. -->
          <span v-if="stage.meta.denials" class="smchip failed"
            title="Отказов политики прав внутри хода. Проверь, не подменил ли агент запрещённую проверку похожей.">
            {{ stage.meta.denials }} отказ. прав</span>
          <span v-if="stage.meta.tokens" class="smchip mono">{{ stage.meta.tokens.toLocaleString('ru') }} ток.</span>
          <span v-if="stage.meta.fails" class="smchip failed">{{ stage.meta.fails }} возвр.</span>
          <span v-if="stage.sub" class="smchip">{{ stage.sub }}</span>
          <span v-if="stageActivity" class="smchip jf" :class="{ on: stageActivity.journalFresh }">{{ agentActivityLabel(stageActivity) }}</span>
        </div>

        <!-- Объяснение статуса: причина пропуска или замечание провалившегося этапа.
             Для skipped это единственное, что отличает «нечего было проверять» от
             «агент сдался» — раньше оно оставалось в журнале прогона. -->
        <div v-if="stage.meta.comment || stage.meta.stall" class="snotices">
          <div
            v-if="stage.meta.comment"
            class="scomment"
            :class="{ failed: ['skipbad', 'stall'].includes(stage.status) }"
          >
            <span class="sclbl">{{ stageCommentLabel(stage) }}</span>
            {{ stage.meta.comment }}
          </div>
          <div v-if="stage.meta.stall" class="scomment failed">
            <span class="sclbl">Почему этап остановился</span>
            <b>{{ stage.meta.stall.title }}</b>
            <div>{{ stage.meta.stall.hint }}</div>
          </div>
        </div>

        <div v-if="stageHasMain || stageHasRail" class="sworkspace"
             :class="{ 'main-only': stageHasMain && !stageHasRail, 'rail-only': stageHasRail && !stageHasMain }">
          <!-- Управление стоит первым в DOM: в мобильной колонке решение человека не
               прячется под длинной телеметрией. На широком экране CSS ставит его справа. -->
          <aside v-if="stageHasRail" class="srail">
            <!-- Ворота: принять/отклонить. Поле пояснения принадлежит ОТКЛОНЕНИЮ и
                 раскрывается по кнопке: при принятии текст никуда не уходит. -->
            <div v-if="gateDecidable" class="sect gate-sect">
              <div class="secth">Ворота — твоё решение</div>
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
                    :disabled="stageBusy === 'gate'"
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
              <UiTextarea
                v-model="rewindComment"
                data-role="pipeline-stage-note"
                rows="6"
                placeholder="Указание агенту — что сделать иначе (необязательно)"
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
            <!-- Выбор исполнителя этапа + та runner-chain, по которой движок принимает решение. -->
            <div v-if="stage.meta.runner" class="sect runner-sect">
              <div class="secth">
                Исполнитель
                <span class="runner-source">{{ RUNNER_SOURCE[stage.meta.runner.source] || stage.meta.runner.source }}</span>
              </div>
              <!-- Главное действие узла: выбрать исполнителя одним кликом, не закрывая модалку. -->
              <div v-if="!stage.readOnly && !stageRunnerLive && stageRunnerOptions.length" class="runner-override">
                <div class="runner-override-row">
                  <span class="runner-override-lbl">Исполнитель этапа</span>
                  <UiButton
                    v-if="stage.meta.runner.source === 'task-stage'"
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
                    <small v-if="runnerModelEffortLabel(stage.meta.runner, id)">{{ runnerModelEffortLabel(stage.meta.runner, id) }}</small>
                  </UiButton>
                </div>
                <p v-if="stage.meta.runner.source === 'task-stage'" class="runner-hint">
                  Сброс вернёт этап к исполнителю, заданному при запуске задачи, а без него — к политике профиля.
                </p>
                <p v-if="stage.status === 'run' && !stage.daemonAlive" class="runner-hint">
                  Прогон остановлен — выбранный исполнитель запустится после «Продолжить прогон».
                </p>
              </div>
              <!-- Цепочка вторична: она объясняет, кто подхватит этап при аварии, и решения не требует. -->
              <div class="runner-chain">
                <span class="runner-chain-lbl">цепочка</span>
                <template v-for="(id, i) in stage.meta.runner.chain" :key="id">
                  <span v-if="i" class="runner-arrow">→</span>
                  <span class="runner-hop"
                        :class="{ actual: id === stage.meta.runner.actual, reserve: i > 0 }"
                        :title="i ? 'резерв: подхватит этап, если основной отпадёт' : 'основной исполнитель'">
                    {{ providerLabel(id) }}
                    <small v-if="runnerModelEffortLabel(stage.meta.runner, id)">{{ runnerModelEffortLabel(stage.meta.runner, id) }}</small>
                  </span>
                </template>
              </div>
              <div v-if="stage.meta.runner.actual" class="runner-current"
                   :class="{ switched: stage.meta.runner.switched }">
                Сейчас: <b>{{ runnerNodeLabel(stage.meta.runner) }}</b>
                <span v-if="stage.meta.runner.reason"> · {{ runnerReasonLabel(stage.meta.runner.reason) }}</span>
              </div>
              <div v-if="stage.meta.runner.attempts?.length" class="runner-attempts">
                <div class="runner-attempt-title">Попытки запуска</div>
                <div v-for="a in stage.meta.runner.attempts" :key="a.id" class="runner-attempt">
                  <span class="mono">#{{ a.epoch ?? '—' }}</span>
                  <b>{{ providerLabel(a.runner) }}</b>
                  <span v-if="runnerAttemptModelLabel(a)" class="runner-attempt-model mono">{{ runnerAttemptModelLabel(a) }}</span>
                  <span v-if="attemptCostLabel(a)" class="runner-attempt-cost mono"
                        :title="attemptCostTitle(a)">{{ attemptCostLabel(a) }}</span>
                  <span class="runner-result" :class="{
                    success: a.result === 'ok',
                    switched: a.result === 'manual_switch',
                    failed: a.result && !['ok', 'manual_switch'].includes(a.result),
                  }">
                    {{ attemptResultLabel(a.result) }}
                  </span>
                </div>
              </div>
              <div v-if="!stage.readOnly && stageRunnerLive" class="runner-switches">
                <UiButton
                  v-for="id in stage.meta.runner.chain.filter((x) => x !== stage.meta.runner.actual)"
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
            <div v-if="stage.status === 'run' && stageActivity?.live" class="sect content-sect">
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
            <div v-if="stage.status === 'run' && stageActivity?.tail?.length" class="sect content-sect">
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
              <div class="secth"><UiSpinner decorative /> Документ этапа</div>
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
          <span class="sactions-context"><b class="mono">#{{ stage.task }}</b> · действия с задачей</span>
          <div class="sactions-buttons">
            <UiButton
              class="btn"
              @click="companion.openForTask(stage.task); closeStage()"
            >
              💬 Обсудить с агентом
            </UiButton>
            <OpenDiffButton :task-id="stage.task" />
          </div>
        </footer>
    </UiDialog>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { api } from '../shared/api-client.js';
import { useSse } from '../composables/useSse.js';
import { useUiContextSource } from '../composables/useUiContextSource.js';
import { useUiStore } from '../stores/ui.js';
import { useTasksStore } from '../stores/tasks.js';
import { useBoardStore } from '../stores/board.js';
import { useCompanionStore } from '../stores/companion.js';
import { liveTimerSec, pipelineWorkSec, secToHMS } from '../shared/format.js';
import { mdToHtml } from '../shared/md.js';
import {
  alertDialog,
  confirmDialog,
  UiButton,
  UiDialog,
  UiDisclosureButton,
  UiIconButton,
  UiSpinner,
  UiTextarea,
  UiToggleButton,
} from '../ui';
import { sandboxUrl } from '../shared/sandbox.js';
import { agentActivityLabel } from '../shared/agent-activity.js';
// «Ждёт тебя» и подписи узлов — общие с чипом в навигации и оповещениями:
// цифра на чипе обязана сходиться с тем, что нарисовано на этой странице.
import { waitingReason, stripEmoji } from '../shared/pipeline-wait.js';
import {
  attemptCostLabel,
  attemptCostTitle,
  attemptResultLabel,
  providerLabel,
  runnerAttemptModelLabel,
  runnerChainLabel,
  runnerModelEffortLabel,
  runnerNodeLabel,
  runnerReasonLabel,
} from '../shared/runner-display.js';
import FactoryGraph from './pipeline/FactoryGraph.vue';
import OpenDiffButton from './OpenDiffButton.vue';

const ui = useUiStore();
const companion = useCompanionStore();
const taskStore = useTasksStore();
const board = useBoardStore();

const tasks = ref([]);
const error = ref(null);
const loaded = ref(false);
const now = ref(Date.now());

// Тикет — обязательный вход route-прогона, поэтому его заголовок доступен и задачам
// без трекера. Живое название B24 оставляем приоритетным и только его делаем
// кликабельным: ручной тикет не должен открывать модалку несуществующей B24-задачи.
function b24Title(taskNum) { return taskStore.title(taskNum); }
function title(taskOrNum) {
  const taskNum = typeof taskOrNum === 'object' ? taskOrNum.task : taskOrNum;
  const task = typeof taskOrNum === 'object'
    ? taskOrNum
    : tasks.value.find((item) => Number(item.task) === Number(taskNum));
  return b24Title(taskNum) || task?.title || null;
}

const boardTasksById = computed(() => new Map(
  (board.data?.tasks || []).map((task) => [Number(task.id), task]),
));

function boardTask(t) {
  return boardTasksById.value.get(Number(t.task));
}

/**
 * Не превращаем отсутствие портальной задачи в ложное состояние «таймер стоит».
 * Статус существует только для явного булева значения из снимка доски.
 */
function b24TimerState(t) {
  const timerRunning = boardTask(t)?.timerRunning;
  if (timerRunning === true) return 'running';
  if (timerRunning === false) return 'stopped';
  return null;
}

function b24TimerLabel(t) {
  const task = boardTask(t);
  if (!task || typeof task.timerRunning !== 'boolean') return '';
  return task.timerRunning
    ? `B24-таймер идёт · ${secToHMS(liveTimerSec(task, now.value))}`
    : 'B24-таймер стоит';
}

// Таймеры, идущие ВНЕ фабрики: активные задачи доски, которых нет на конвейере.
const factoryIds = computed(() => new Set(tasks.value.map((t) => Number(t.task))));
const outsideTimers = computed(() => {
  const d = board.data; if (!d) return [];
  return (d.tasks || []).filter((t) => (
    t.timerRunning && !factoryIds.value.has(Number(t.id))
  ));
});
function outsideElapsed(t) {
  return liveTimerSec(t, now.value);
}

// Чистая работа узлов конвейера (не путать с таймером B24). Для закреплённого маршрута
// сервер складывает фактические runner-запуски текущей попытки: паузы между ними и
// ожидание человека на воротах сюда не попадают.
function elapsedSec(t) {
  return pipelineWorkSec(t.graph?.timing, now.value);
}
function elapsedLabel(t) {
  const sec = elapsedSec(t);
  if (sec == null) return '';
  return `${t.graph?.timing?.approximate ? '≈' : ''}${secToHMS(sec)}`;
}
function elapsedTitle(t) {
  if (t.graph?.timing?.source === 'runner-telemetry') {
    return 'фактическое время запущенных агентов текущей попытки: паузы между запусками и ожидание человека на воротах не входят';
  }
  return t.graph?.timing
    ? 'оценка по журналу маршрута: ожидание человека на воротах не входит'
    : '';
}

let ticker = null;
onMounted(() => {
  ticker = setInterval(() => { now.value = Date.now(); }, 1000);
});
onUnmounted(() => {
  if (ticker) clearInterval(ticker);
  clearInterval(actPoll);
});

// Тумблеры (переживают перезагрузку — как в старом дашборде).
const compact = ref(localStorage.getItem('cockpit-compact') === '1');
const loopsOn = ref(localStorage.getItem('cockpit-loops') === '1');
function toggleCompact(value) {
  compact.value = value;
  localStorage.setItem('cockpit-compact', value ? '1' : '0');
}
function toggleLoops(value) {
  loopsOn.value = value;
  localStorage.setItem('cockpit-loops', value ? '1' : '0');
}

// Фильтр по проектам (профилям).
const activeProject = ref(localStorage.getItem('cockpit-project') || 'all');
function setProject(p) { activeProject.value = p; localStorage.setItem('cockpit-project', p); }
const projects = computed(() => [...new Set(tasks.value.map((t) => t.profile).filter(Boolean))]);
const filteredTasks = computed(() => (activeProject.value === 'all'
  ? tasks.value : tasks.value.filter((t) => t.profile === activeProject.value)));

// По-карточное сворачивание (запоминается). Свёрнута, если глобальный compact ИЛИ отмечена.
const collapsedSet = ref(new Set(JSON.parse(localStorage.getItem('cockpit-cards-collapsed') || '[]')));
function toggleCard(task) {
  const s = new Set(collapsedSet.value);
  s.has(task) ? s.delete(task) : s.add(task);
  collapsedSet.value = s;
  localStorage.setItem('cockpit-cards-collapsed', JSON.stringify([...s]));
}
function isCollapsed(task) { return compact.value || collapsedSet.value.has(task); }
const waitingCount = computed(() => filteredTasks.value
  .filter((t) => !t.readOnly && waitingReason(t.graph)).length);
// Встали — это НЕ то же, что «ждут тебя». У ворот конвейер стоит штатно и с кнопкой,
// а тут движок упёрся и сам позвал человека (или оборвался). Без этого различия REPRO failed
// выглядит под тем же значком «○ стоит», что и доделанная задача, и ожидание человека незаметно.
const stalledCount = computed(() => filteredTasks.value.filter((t) => !t.readOnly && t.stall).length);
const stalledTitles = computed(() => filteredTasks.value
  .filter((t) => !t.readOnly && t.stall).map((t) => `#${t.task}: ${t.stall.title}`).join('\n'));

// Модалка этапа (клик по узлу графа): инфо + управление (ворота/форс/указание/активность).
const stage = ref(null);
const stageBusy = ref(null);
// Два РАЗНЫХ текста, а не один на обе кнопки: у ворот пояснение доезжает до агента только
// при отклонении, у возврата — всегда. Общий ref переносил бы набранное из одного смысла
// в другой и подсказывал, что при «Принять» текст тоже куда-то уйдёт (он не уходит).
const gateComment = ref('');
const gateRejecting = ref(false);
const gateNoteEl = ref(null);
const rewindComment = ref('');
const stageActivity = ref(null);
const stageDoc = ref('');       // документ этапа (план/разведнота/диагноз…) — рендерится в модалке
const stageDocOpen = ref(true);
const stageLogOpen = ref(false);
const pipelineContext = useUiContextSource('pipeline', { layer: 'overlay', active: false });
const liveFeed = ref(null);
const stageDocLoading = ref(false);
let actPoll = null;
// Какой документ показывать на каком узле: у ворот плана — сам план, у приёмки — отчёт.
const NODE_DOC = {
  gate_plan: 'plan', plan: 'plan', skeptic: 'plan', validate: 'plan', translator: 'plan',
  scout: 'recon', diagnose: 'diag', hyposkeptic: 'diag', proof: 'diag', gate_cause: 'diag',
  hunt_access: 'diag', hunt_data: 'diag', hunt_errors: 'diag', hunt_race: 'diag', verify: 'diag',
  baseline: 'diag', perfplan: 'plan', perfskeptic: 'plan',
  ship: 'ship', gate_accept: 'report', browser: 'report', triage: 'report',
  measure: 'report', measurecheck: 'report',
  // У аудита свой документ — досье приёмки. Ворота рядом продолжают показывать
  // отчёт: сводку аудита узел дописывает и туда, поэтому человеку на воротах
  // видно главное, а полное досье — в клике по узлу.
  audit: 'audit',
  // Ревью пишет собственный t<TASK>.review.md с первого дня, но в карте его не
  // было: документ существовал и не открывался нигде.
  review: 'review',
};
function pipelineContextDetails() {
  if (!stage.value) return null;
  const document = stageDocOpen.value ? NODE_DOC[stage.value.id] || null : null;
  const tab = stageLogOpen.value ? 'activity' : document ? 'document' : 'overview';
  const details = { taskId: String(stage.value.task), stageId: String(stage.value.id), tab };
  return { ...details, ...(document ? { document } : {}) };
}
const pipelineContextIdentity = computed(() => (
  stage.value ? `${stage.value.task}:${stage.value.id}` : ''
));
watch(pipelineContextIdentity, (identity, previous) => {
  if (!identity) { pipelineContext.blur(); return; }
  const taskId = String(stage.value.task);
  const next = {
    routingScope: { kind: 'task', taskId },
    details: pipelineContextDetails(),
  };
  if (identity !== previous) pipelineContext.focus(next);
  else pipelineContext.update(next);
}, { immediate: true });
watch(
  () => [pipelineContextIdentity.value, stageDocOpen.value, stageLogOpen.value],
  () => { if (stage.value) pipelineContext.update({ details: pipelineContextDetails() }); },
  { immediate: true },
);
const STAGE_HINT = {
  done: 'пройден', run: 'выполняется сейчас', wait: 'ждёт твоего решения', pending: 'ещё не начинался',
  skip: 'пропущен осознанно', idle: 'нет данных (прогон по прежней схеме)', stall: 'завис — агент молчит',
  skipbad: 'пропущен без причины — аномалия', premature: 'преждевременно: хвост не доделан',
  fail: 'провалился — стенд не поднялся',
};
const FORCE_STATUSES = ['running', 'done', 'skipped', 'pending'];
const RUNNER_SOURCE = {
  'profile-project': 'политика проекта',
  'profile-stage': 'политика этапа',
  task: 'переопределение задачи',
  'task-stage': 'переопределение этапа задачи',
};

const LIVE_ICONS = { tool: '⚙', subagent: '🤖', text: '💬', think: '🧠' };
function liveIcon(a) { return LIVE_ICONS[a.type] || '·'; }

/**
 * FactoryGraph эмитит нормализованный `id`, а API-граф хранит метаданные по этому же ключу.
 * Один canonical id нужен всему снимку модалки, иначе ошибка возникает ещё до её открытия.
 */
function openStage(t, node) {
  const nodeId = node.id;

  stage.value = {
    task: t.task, id: nodeId, key: t.graph.keys?.[nodeId] || nodeId.toUpperCase(),
    runnerKey: t.graph.runnerKeys?.[nodeId]
      || t.graph.keys?.[nodeId]
      || nodeId.toUpperCase(),
    isGate: nodeId.startsWith('gate_'), label: stripEmoji(node.label), sub: node.subtitle,
    readOnly: Boolean(t.readOnly || t.graph.readOnly),
    daemonAlive: Boolean(t.graph.daemonAlive),
    status: node.status, meta: t.graph.nodeMeta?.[nodeId] || {},
  };
  loadFactoryRunners();
  gateComment.value = ''; gateRejecting.value = false; rewindComment.value = '';
  runnerPending.value = null;
  stageActivity.value = null;
  stageDoc.value = ''; stageDocOpen.value = true; stageDocLoading.value = false;
  stageLogOpen.value = false;
  const doc = NODE_DOC[nodeId];
  if (doc) {
    stageDocLoading.value = true;
    api.get(`/api/tasks/${t.task}/doc/${doc}`)
      .then((r) => { stageDoc.value = r.text || ''; })
      .catch(() => { /* документа нет — секция не показывается */ })
      .finally(() => { stageDocLoading.value = false; });
  }
  clearInterval(actPoll);
  if (node.status === 'run' && t.graph.daemonAlive) {
    pollActivity(); actPoll = setInterval(pollActivity, 3000);
  }
}
function closeStage() { stage.value = null; clearInterval(actPoll); }
function onStageDialogOpenChange(open) {
  if (!open) {
    closeStage();
  }
}
async function pollActivity() {
  if (!stage.value) return;
  try { stageActivity.value = await api.get(`/api/tasks/${stage.value.task}/activity`); } catch { /* игнор */ }
}
// Модалка живёт дольше этапа: её открывают на бегущем узле и не закрывают. Статус в ней
// обязан идти за графом, иначе она навсегда остаётся «выполняется сейчас» и продолжает
// опрашивать активность уже закончившегося этапа, пока конвейер стоит у ворот.
const stageLive = computed(() => {
  if (!stage.value) return null;
  const g = tasks.value.find((x) => Number(x.task) === Number(stage.value.task))?.graph;
  if (!g?.statuses?.[stage.value.id]) return null;
  return {
    status: g.statuses[stage.value.id],
    meta: g.nodeMeta?.[stage.value.id] || {},
    daemonAlive: Boolean(g.daemonAlive),
  };
});
watch(stageLive, (live) => {
  if (!stage.value || !live) return;
  // Мета (время, длительность, токены, попытки runner-а) обновляется всегда: этап
  // дописывает её и после того, как перестал быть активным.
  stage.value.meta = live.meta;
  if (live.status === stage.value.status && live.daemonAlive === stage.value.daemonAlive) return;
  stage.value.status = live.status;
  stage.value.daemonAlive = live.daemonAlive;
  clearInterval(actPoll);
  if (live.status === 'run' && live.daemonAlive) {
    pollActivity(); actPoll = setInterval(pollActivity, 3000);
  }
  else { stageActivity.value = null; }
});

// Автопрокрутка ленты действий агента вниз при обновлении.
watch(() => stageActivity.value?.live?.actions?.length, () => {
  nextTick(() => { if (liveFeed.value) liveFeed.value.scrollTop = liveFeed.value.scrollHeight; });
});
// Решение и возврат курсора уходят в журнал попытки СРАЗУ, а продолжение прогона —
// отдельным resume, который может не подняться (например, профиль правили при живой
// попытке). Сервер отвечает 200 с resumed:false, и молчать об этом нельзя: карточка
// выглядит принятой, а конвейер стоит — так несколько попыток продолжить
// прошли «успешно» и ничего не поехало.
async function warnIfNotResumed(res) {
  if (!res || res.resumed !== false) return;
  await alertDialog(`Записано, но прогон не поехал: ${res.resumeError || 'причина — в журнале этапов задачи'}`);
}
// Ворота — состояние, в котором решение вообще принимают. Отдельным computed, потому что
// на него смотрят и секция решения, и подпись комментария под шапкой.
const gateDecidable = computed(() => Boolean(
  stage.value && !stage.value.readOnly && stage.value.isGate
  && ['wait', 'premature'].includes(stage.value.status),
));
// Только компоновка модалки: на широком экране информационная колонка и управление
// живут рядом, но пустую колонку не держим ради одной рамки. Условия действий остаются
// теми же, что и у самих секций ниже.
const stageHasRewind = computed(() => Boolean(
  stage.value && !stage.value.readOnly && !stage.value.isGate,
));
const stageHasMain = computed(() => Boolean(
  stage.value?.meta?.runner
  || stageDocLoading.value
  || stageDoc.value
  || (stage.value?.status === 'run' && (stageActivity.value?.live || stageActivity.value?.tail?.length)),
));
const stageHasRail = computed(() => gateDecidable.value || stageHasRewind.value);
// Контекст открытого этапа остаётся живым: название задачи может догрузиться из B24 уже
// после открытия модалки, а стенд — появиться после очередного SSE-обновления графа.
// Снимок в openStage здесь дал бы устаревшие название и порты до повторного открытия.
const stageTask = computed(() => {
  if (!stage.value) return null;
  return tasks.value.find((item) => Number(item.task) === Number(stage.value.task)) || null;
});
const stageTaskTitle = computed(() => (
  stage.value ? title(stageTask.value || stage.value.task) : null
));
const stageGraph = computed(() => stageTask.value?.graph || null);
// Пояснение — часть ОТКЛОНЕНИЯ, а не ворот вообще: при «Принять» движок его выбрасывает
// (`route_v2_gate_decide`: reject_feedback обнуляется на любом исходе кроме rejected).
// Пока поле висело всегда, интерфейс обещал доставку текста, которой при принятии нет.
function startGateReject() {
  gateRejecting.value = true;
  nextTick(() => { gateNoteEl.value?.focus(); });
}
function cancelGateReject() {
  gateRejecting.value = false;
  gateComment.value = '';
}
// Движок отказывает, когда rejected-пояснение некому доставить: возврат ведёт в узел,
// который исполняет не агент. Голое «Ошибка: …» тут ничего не подсказывает, а выход есть.
function gateErrorText(e) {
  const base = `Решение не принято: ${e.message}`;
  return /нельзя доставить/.test(e.message || '')
    ? `${base}\n\nОтклони без текста либо верни конвейер кнопкой «▶ Перейти сюда» на тот узел, чей агент должен прочитать указание.`
    : base;
}
async function gateDecide(decision) {
  stageBusy.value = 'gate';
  // При принятии комментарий не отправляем вовсе: пустое поле честнее, чем текст,
  // который движок молча выбросит, а проекция реестра потом покажет как «Замечание».
  const comment = decision === 'reject' ? gateComment.value : '';
  try {
    const res = await api.post(`/api/tasks/${stage.value.task}/gate/${stage.value.key}/${decision}`, { comment });
    await load(); closeStage();
    await warnIfNotResumed(res);
  }
  catch (e) { await alertDialog(gateErrorText(e)); } finally { stageBusy.value = null; }
}
async function forceStatus(status) {
  // Возврат курсора сбрасывает НЕ ТОЛЬКО этот узел, но и весь хвост маршрута за ним.
  // Возврат с приёмки на план сносит результаты всего, что между.
  const question = `Вернуть конвейер на «${stage.value.label}»? Результаты этого узла и всех следующих за ним будут сброшены.`;
  if (!await confirmDialog(question, { okText: 'Вернуть' })) return;
  stageBusy.value = 'force';
  // Указание уезжает тем же запросом, что и сам возврат: сервер кладёт его в журнал
  // попытки причиной human-rewind, движок оттуда подмешивает его в промпт захода.
  try {
    const res = await api.post(`/api/tasks/${stage.value.task}/stage/${stage.value.key}/${status}`,
      { comment: rewindComment.value });
    await load(); closeStage();
    await warnIfNotResumed(res);
  }
  catch (e) { alertDialog(`Ошибка: ${e.message}`); } finally { stageBusy.value = null; }
}
// Выбор исполнителя модалку НЕ закрывает: человек сравнивает варианты и перебирает их,
// а закрытие после каждого клика заставляло открывать узел заново. Новое состояние узла
// приезжает обычным путём — load() → watch(stageLive) → stage.meta.
async function switchRunner(target) {
  if (!await confirmDialog(
    `Остановить текущий запуск ${providerLabel(stage.value.meta.runner.actual)} и продолжить этап через ${providerLabel(target)}?`,
    { okText: 'Переключить' },
  )) return;
  stageBusy.value = 'runner-switch';
  try {
    await api.post(`/api/tasks/${stage.value.task}/runner/switch`, {
      stage: stage.value.runnerKey,
      target,
    });
    await load();
  } catch (e) {
    alertDialog(`Не удалось переключить исполнителя: ${e.message}`);
  } finally {
    stageBusy.value = null;
  }
}
// Исполнители, установленные на фабрике — для override этапа. Тянем один раз,
// при первом открытии узла; сервер не отдал — блок выбора просто не показываем.
const factoryRunners = ref([]);
let factoryRunnersRequested = false;
function loadFactoryRunners() {
  if (factoryRunnersRequested) return;
  factoryRunnersRequested = true;
  api.get('/api/factory/runners')
    .then((r) => { factoryRunners.value = r.runners || []; })
    .catch(() => { /* без списка блок выбора скрыт */ });
}
// Текущий primary могли снять с фабрики — тогда добавляем его в список сами,
// иначе селект соврал бы про действующее значение этапа.
const stageRunnerOptions = computed(() => {
  const list = [...factoryRunners.value];
  const primary = stage.value?.meta?.runner?.primary;
  if (primary && !list.includes(primary)) list.unshift(primary);
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
const runnerPending = ref(null);
const stageRunnerActive = computed(() => (
  runnerPending.value ?? (stage.value?.meta?.runner?.primary || '')
));
// Override исполнителя до запуска этапа (бегущий переключают только кнопки switch).
// '' — снять override этапа: вернётся переопределение задачи с запуска или профиль.
async function setStageRunner(primary) {
  if (stageBusy.value) return;
  stageBusy.value = 'runner-override';
  // У сброса будущего значения нет (его решит профиль) — подсветку до ответа не двигаем.
  runnerPending.value = primary || null;
  try {
    await taskStore.setStageRunner(stage.value.task, stage.value.runnerKey, primary);
    await load();
  } catch (e) {
    alertDialog(`Не удалось сменить исполнителя этапа: ${e.message}`);
  } finally {
    stageBusy.value = null;
    runnerPending.value = null;
  }
}
function pickStageRunner(primary) {
  if (primary === stageRunnerActive.value) return;
  setStageRunner(primary);
}
// Подпись у `meta.comment`: один и тот же ключ реестра (`<КЛЮЧ>_COMMENT`) значит разное.
// У ворот это текст ЧЕЛОВЕКА, и его судьба зависит от решения: отклонение уезжает агенту
// заданием, а комментарий при принятии движок выбрасывает — назвать его «Замечанием»
// значит соврать про доставку (старые прогоны такие записи ещё содержат).
function stageCommentLabel(s) {
  if (['skip', 'skipbad'].includes(s.status)) return 'Почему пропущен';
  if (!s.isGate) return 'Замечание';
  return s.status === 'done'
    ? 'Комментарий при принятии — агенту он не уходил'
    : 'Отправлено агенту на доработку';
}

// Снос идёт до пары минут (docker + схемы БД) — на это время кнопка превращается
// в индикатор «сношу…», повторный клик заблокирован.
const sandboxBusy = ref(new Set());
async function sandboxDown(task) {
  if (sandboxBusy.value.has(task)) return;
  if (!await confirmDialog(
    `Снести стенд задачи #${task}? Текущий прогон уйдёт в архив, после чего задачу можно будет отправить на конвейер заново. Ветка и незакоммиченные изменения сохранятся.`,
    { danger: true, okText: 'Снести' },
  )) return;
  sandboxBusy.value = new Set([...sandboxBusy.value, task]);
  try { await api.post(`/api/tasks/${task}/sandbox/down`); await load(); }
  catch (e) { alertDialog(e.status === 501 ? 'Снос стенда не настроен: нет COCKPIT_SANDBOX_DOWN_CMD и down.sh у профиля.' : `Ошибка: ${e.message}`); }
  finally { const s = new Set(sandboxBusy.value); s.delete(task); sandboxBusy.value = s; }
}

// Ручная архивация нужна задаче, стенд которой кокпит не сносит: его либо уже нет
// (подъём оборвался до выдачи порта), либо он не наш (shared checkout). Там, где стенд
// наш, прогон архивирует сам «снести стенд».
async function closeTask(t) {
  const task = t.task;
  if (sandboxBusy.value.has(task)) return;

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

  // Про ветки говорим только там, где кокпит их правда трогает: в shared-режиме
  // основное рабочее дерево не наше, и никакой branch lifecycle к нему не применяется.
  const branchNote = canDestroySandbox(t)
    ? ' Пустая ветка будет удалена (ветка с коммитами останется).'
    : ' Общий checkout и его ветки не затрагиваются.';
  if (!await confirmDialog(
    `${runNote}Закрыть задачу #${task}? Реестр уйдёт в архив.${branchNote}`,
    { danger: true, okText: t.daemonAlive ? 'Прервать и закрыть' : 'Закрыть' },
  )) return;
  sandboxBusy.value = new Set([...sandboxBusy.value, task]);
  try {
    const r = await api.post(`/api/tasks/${task}/close`);
    const branches = (r.branches || []).map((b) => `${b.repo}: ${b.state}`).join('; ');
    await alertDialog(`Задача #${task} закрыта.${branches ? ` Ветки — ${branches}.` : ''}`);
    await load();
  } catch (e) { alertDialog(`Ошибка: ${e.message}`); }
  finally { const s = new Set(sandboxBusy.value); s.delete(task); sandboxBusy.value = s; }
}

// Стенд не поднялся — вернуть задачу в работу одной кнопкой. Двумя действиями это было
// невозможно: «снести стенд» показывается только у живого стенда, а его-то и нет.
// Пересборки стенда отдельно от прогона в движке не существует, поэтому здесь именно
// перезапуск конвейера (resume) — со сносом остатков упавшей песочницы перед ним.
async function sandboxRetry(task) {
  if (sandboxBusy.value.has(task)) return;
  if (!await confirmDialog(
    `Перезапустить стенд задачи #${task}? Остатки упавшей песочницы будут снесены, конвейер продолжит с того места, где встал.`,
    { okText: 'Перезапустить' },
  )) return;
  sandboxBusy.value = new Set([...sandboxBusy.value, task]);
  try {
    const r = await api.post(`/api/tasks/${task}/sandbox/retry`);
    await load();
    // Снос мог оставить за собой worktree с незакоммиченными изменениями — тогда новый
    // подъём упрётся в тот же гард. Сказать об этом надо сразу, а не через двадцать минут
    // провижининга: в плашке это будет выглядеть как «стенд опять не поднялся» без причины.
    const warn = (r.downOutput || '').split('\n').filter((s) => s.includes('ВНИМАНИЕ')).join('\n');
    if (warn) alertDialog(`Конвейер перезапущен, но снос сообщил:\n${warn}`);
    else if (r.note) alertDialog(r.note);
  } catch (e) {
    alertDialog(e.status === 501
      ? 'Снос стенда не настроен: нет COCKPIT_SANDBOX_DOWN_CMD и down.sh у профиля.'
      : `Не удалось перезапустить: ${e.message}`);
  } finally { const s = new Set(sandboxBusy.value); s.delete(task); sandboxBusy.value = s; }
}

// Арбитр типизированной остановки. Гейт по МАШИННОМУ виду остановки (`stall.stop`), а не
// по разбору заголовка: текст пишется человеку и меняется, а решение «можно ли отдать это
// арбитру» обязано быть точным. `no-progress` — единственный вид, где решение выводится из
// вердиктов дуги; `human` (упал стенд, не хватило прав) выводить не из чего.
const arbiterBusy = ref(new Set());
function canArbitrate(t) {
  return !t.readOnly && !t.daemonAlive && t.stall?.stop === 'no-progress';
}
async function arbitrate(task) {
  if (arbiterBusy.value.has(task)) return;
  if (!await confirmDialog(
    `Отдать тупик задачи #${task} арбитру? Он прочитает оба вердикта, проверит спорное по коду рабочего дерева и вернёт узел с указанием. Решение будет записано в журнал как машинное.`,
    { okText: 'Разобрать' },
  )) return;
  arbiterBusy.value = new Set([...arbiterBusy.value, task]);
  try {
    const r = await api.post(`/api/tasks/${task}/arbitrate`);
    await load();
    // Два разных исхода, и путать их нельзя. `resolved: false` — не отказ: арбитр
    // отработал и вернул то, что обязан вернуть, когда решение меняет границу задачи.
    if (r.resolved) {
      alertDialog(`Арбитр вернул узел «${r.node}».

${r.card.what}

Почему: ${r.card.why}
Чем доказал: ${r.card.proof}
Чем грозит ошибка: ${r.card.risk}`);
    } else {
      alertDialog(`Это решает человек, а не арбитр.

${r.card.what}

Почему: ${r.card.why}
Чем доказал: ${r.card.proof}
Чем грозит ошибка: ${r.card.risk}`);
    }
  } catch (e) {
    alertDialog(`Арбитр не разобрал: ${e.message}`);
  } finally { const s = new Set(arbiterBusy.value); s.delete(task); arbiterBusy.value = s; }
}

// Оборвавшийся прогон продолжает человек кнопкой: новый start движок отклонит,
// пока у задачи есть открытая попытка. Исторические записи остаются только чтением.
function canResume(t) {
  return !t.readOnly && !t.daemonAlive && !!t.attempt
    && !['completed', 'abandoned'].includes(t.result || '');
}
function canRetrySandbox(t) {
  return !t.readOnly && t.workspaceMode !== 'shared' && t.stall?.stage === 'SANDBOX';
}
function canDestroySandbox(t) {
  return !t.readOnly && t.workspaceMode !== 'shared';
}
// «Закрыть задачу» = убрать прогон с экрана в архив. Разрешено, когда кокпиту нечего
// сносить: стенда нет ЛИБО стенд не его. Прежнее условие смотрело только на порт фронта
// и молча означало «есть порт = есть НАША песочница, закрывать через снос стенда». В
// shared-режиме порт есть всегда (стенд общий, живёт вне задачи и переживает её), а
// кнопки «снести стенд» там нет по определению — доведённый до конца прогон оставался
// на экране НАВСЕГДА: убрать его было нечем ни одной кнопкой. Ровно так залипла
// выполненная задача тестового профиля. Сервер в shared-режиме при закрытии не
// трогает ни стенд, ни ветки — только переносит проекцию реестра в архив.
function canCloseTask(t) {
  return !t.readOnly && !t.graph.sandbox && (!t.graph.fePort || !canDestroySandbox(t));
}
async function resumeRun(task) {
  if (sandboxBusy.value.has(task)) return;
  if (!await confirmDialog(
    `Продолжить прогон задачи #${task}? Конвейер поедет с того узла, на котором оборвался.`,
    { okText: 'Продолжить' },
  )) return;
  sandboxBusy.value = new Set([...sandboxBusy.value, task]);
  try { await api.post(`/api/tasks/${task}/resume`); await load(); }
  catch (e) { alertDialog(`Не удалось продолжить: ${e.message}`); }
  finally { const s = new Set(sandboxBusy.value); s.delete(task); sandboxBusy.value = s; }
}

// Работающий конвейер останавливает человек кнопкой: движок получает TERM и
// убирает за собой сам, попытка остаётся открытой для «продолжить прогон».
function canStop(t) {
  return !t.readOnly && t.daemonAlive;
}
async function stopRun(task) {
  if (sandboxBusy.value.has(task)) return;
  if (!await confirmDialog(
    `Остановить конвейер задачи #${task}? Текущий этап будет прерван, прогон встанет — продолжить его можно будет кнопкой «продолжить прогон».`,
    { danger: true, okText: 'Остановить' },
  )) return;
  sandboxBusy.value = new Set([...sandboxBusy.value, task]);
  try { await api.post(`/api/tasks/${task}/stop`); await load(); }
  catch (e) { alertDialog(`Не удалось остановить: ${e.message}`); }
  finally { const s = new Set(sandboxBusy.value); s.delete(task); sandboxBusy.value = s; }
}

const ROUTE_ICON = {
  feature: '✨', debug: '🔍', trivial: '⚡', hunt: '🕵', perf: '⏱', dev: '🛠', quick: '⚡',
};

async function load() {
  try {
    const { tasks: list } = await api.get('/api/tasks');
    const graphs = await Promise.all(
      list.map((t) => api.get(`/api/tasks/${t.task}/graph`).catch(() => null)),
    );
    tasks.value = list.map((t, i) => ({ ...t, graph: graphs[i] })).filter((x) => x.graph);
    // Названия задач из B24 (для заголовка) + доска (для «таймеров вне фабрики»).
    tasks.value.forEach((t) => taskStore.load(t.task).catch(() => {}));
    board.load();
    error.value = null;
  } catch (e) {
    error.value = e.message;
  } finally {
    loaded.value = true;
  }
}
load();

// Класс полосы прогресса по текущему статусу.
function progressClass(g) {
  const cur = g.progress.current;
  const s = cur ? g.statuses[cur] : 'done';
  if (s === 'run') return 'pk-run';
  if (s === 'wait' || s === 'premature') return 'pk-wait';
  if (['stall', 'fail', 'skipbad'].includes(s)) return 'pk-stall';
  return 'pk-done';
}
function currentLabel(g) {
  const cur = g.progress.current;
  return cur ? stripEmoji(g.nodes[cur]?.[1]) : 'готово';
}
function loopList(g) {
  return Object.entries(g.loops || {}).map(([k, n]) => `${stripEmoji(g.nodes[k]?.[1]) || k} ×${n}`);
}
function cardState(g) {
  const vals = Object.values(g.statuses);
  if (vals.some((s) => ['stall', 'fail', 'skipbad'].includes(s))) return 'stall';
  if (vals.includes('wait') || vals.includes('premature')) return 'attn';
  if (vals.includes('run')) return 'act';
  return '';
}
</script>

<style scoped>
.pipeline { display: flex; flex-direction: column; gap: 14px; }
/* Липкий тулбар: full-bleed по бокам; top:-22px компенсирует padding-top .content,
   иначе sticky прилипает ниже паддинга и над ним светит прокрученный контент. */
.toolbar { position: sticky; top: -22px; z-index: 30; background: var(--ground);
  padding: 14px 22px 12px; margin: 0 -22px 6px; display: flex; flex-direction: column; gap: 8px;
  border-bottom: 1px solid var(--line); }
.tbrow { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.ttl { font-size: 12px; text-transform: uppercase; letter-spacing: .14em; color: var(--ink-mid); margin: 0; display: flex; align-items: center; gap: 10px; }
.needme { color: var(--warn); text-transform: none; letter-spacing: 0; font-size: 12px; }
.stalledme { color: var(--bad); text-transform: none; letter-spacing: 0; font-size: 12px; margin-left: 8px; cursor: help; }
.projects { display: flex; flex-wrap: wrap; gap: 6px; }

/* Очередь и слоты не входят в графы: у каждого блока собственные loading/error и
   последний удачный снимок. Поэтому визуально это одна операционная полоса, но не
   одна карточка с общим условием отображения. */
.waitme { margin: 6px 0 0; font-size: 12.5px; color: var(--warn);
  background: color-mix(in srgb, var(--warn) 12%, transparent); border: 1px solid color-mix(in srgb, var(--warn) 30%, transparent);
  border-radius: 8px; padding: 6px 10px; }
.waitme.premature { color: var(--bad); background: color-mix(in srgb, var(--bad) 12%, transparent); border-color: color-mix(in srgb, var(--bad) 30%, transparent); }
.waitme .pm { color: var(--bad); }

/* Затык: сильнее «ждёт тебя» по тону — у ворот конвейер стоит штатно, а здесь он упёрся. */
.stalled { margin: 6px 0 0; font-size: 12.5px; color: var(--bad); border-radius: 8px; padding: 6px 10px;
  background: color-mix(in srgb, var(--bad) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--bad) 35%, transparent); }
.stalled.crashed { color: var(--ink-mid);
  background: color-mix(in srgb, var(--ink-mid) 10%, transparent);
  border-color: color-mix(in srgb, var(--ink-mid) 30%, transparent); }
.stalled .srow { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
.stalled .stitle { font-weight: 600; }
.stalled .ssince { margin-left: auto; opacity: .7; font-size: 11.5px; }
.stalled .shint { margin-top: 2px; opacity: .85; }
.stalled .scomment { margin-top: 2px; opacity: .85; font-style: italic; }
.stalled .sfix { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
.stalled .sfixhint { opacity: .75; font-size: 11.5px; }
.cnt { color: var(--ink); background: var(--surface-2); border-radius: 999px; padding: 1px 8px; margin-left: 6px; }
.tools { display: flex; gap: 6px; }

.err { color: var(--bad); }

.card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius);
  padding: 14px 16px; box-shadow: var(--shadow); border-left: 3px solid var(--line); }
.card.attn { border-left-color: var(--warn); }
.card.act { border-left-color: var(--accent); }
.card.stall { border-left-color: var(--bad); }

.head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.route { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, transparent); padding: 2px 8px; border-radius: 999px; }
.runner-policy { font-size: 11px; color: var(--ink-mid); border: 1px solid var(--line);
  background: var(--surface-2); padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
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

.gwrap { overflow-x: auto; margin: 8px 0; }
.gwrap :deep(svg.graph) { min-width: 1160px; }

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
.smeta { min-height: 40px; max-height: 76px; flex: none; display: flex; flex-wrap: wrap; align-items: center;
  gap: 6px; overflow-y: auto; padding: 7px 18px; border-bottom: 1px solid var(--line); background: var(--ground); }
.sbadge { flex: none; padding: 5px 11px; border-radius: 999px; font-size: 10.5px; font-weight: 650;
  line-height: 1.15; text-transform: uppercase; letter-spacing: .055em; white-space: nowrap; }
.sbadge.run { background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent); }
.sbadge.done { background: color-mix(in srgb, var(--good) 18%, transparent); color: var(--good); }
.sbadge.wait, .sbadge.premature { background: color-mix(in srgb, var(--warn) 18%, transparent); color: var(--warn); }
.sbadge.pending, .sbadge.idle { background: var(--surface-2); color: var(--ink-mid); }
.sbadge.stall, .sbadge.skipbad, .sbadge.fail { background: color-mix(in srgb, var(--bad) 18%, transparent); color: var(--bad); }
.sbadge.skip { background: var(--surface-2); color: var(--ink-mid); }
.smchip { flex: none; padding: 3px 8px; border-radius: 6px; background: var(--surface-2); color: var(--ink-mid);
  font-size: 11.5px; line-height: 1.35; white-space: nowrap; }
.smchip.failed { color: var(--bad); background: color-mix(in srgb, var(--bad) 12%, transparent); }
.snotices { max-height: 130px; flex: none; display: flex; flex-direction: column; gap: 7px; overflow-y: auto;
  padding: 9px 18px; border-bottom: 1px solid var(--line); background: var(--surface); }
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
.sworkspace { min-width: 0; min-height: 0; flex: 1; display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(360px, 400px); grid-template-areas: "main rail";
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
  .sh { min-height: 66px; grid-template-columns: minmax(0, 1fr) 44px; grid-template-rows: auto auto;
    column-gap: 10px; row-gap: 5px; padding: 8px 10px 8px 14px; }
  .shead-copy { grid-column: 1; grid-row: 1; }
  .sh > .sbadge { grid-column: 1; grid-row: 2; justify-self: start; }
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
  .smeta { min-height: 38px; max-height: none; flex-wrap: nowrap; overflow-x: auto; overflow-y: hidden;
    padding: 6px 12px; }
  .jf { margin-left: 0; }
  .snotices { max-height: 110px; padding: 8px 12px; }
  .sworkspace, .sworkspace.main-only, .sworkspace.rail-only { gap: 10px; padding: 10px; }
  .smain, .srail { gap: 10px; }
  .runner-sect, .content-sect, .gate-sect, .rewind-sect { padding: 12px; }
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
</style>

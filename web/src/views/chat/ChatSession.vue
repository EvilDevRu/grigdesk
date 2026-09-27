<template>
  <div v-if="sess" class="cs" :class="{ frozen }" :style="composerStyle"
       @dragenter.prevent="onDragEnter" @dragover.prevent @dragleave="onDragLeave" @drop.prevent="onDrop">
    <!-- Оверлей при перетаскивании файла -->
    <div v-if="dragOver" class="drop-overlay">
      <div class="drop-box">📎 Отпусти, чтобы приложить</div>
    </div>
    <!-- Шапка в два ряда: сверху название и задача, снизу — настройки хода.
         Высота фиксирована токеном --chat-head-h: линия под шапкой чата идёт по той же
         горизонтали, что и линия под шапкой списка чатов слева. -->
    <div class="cs-top">
      <div class="hrow">
        <!-- Назад к списку — только когда список и чат делят одну колонку (мобила) -->
        <UiIconButton
          class="back"
          role="rail"
          label="К списку чатов"
          title="К списку чатов"
          data-context="chat-session-back"
          @click="emit('back')"
        >
          ←
        </UiIconButton>
        <div class="ttl">
          <UiInput
            v-if="editingTitle"
            ref="titleEl"
            v-model="titleVal"
            class="ctitle-edit"
            data-role="chat-title"
            @keydown.enter="commitTitle"
            @keydown.esc="editingTitle = false"
            @blur="commitTitle"
          />
          <template v-else>
            <span class="ctitle" :title="chat.tabLabel(sess)">
              {{ chat.tabLabel(sess) }}
            </span>
            <!-- Единственная точка переименования доступна мышью, клавиатурой и touch. -->
            <UiIconButton
              class="tedit"
              role="embedded"
              label="Переименовать чат"
              title="Переименовать чат"
              data-context="chat-title-edit"
              @click="startTitleEdit"
            >
              ✎
            </UiIconButton>
          </template>
        </div>
        <UiTooltip
          :text="activeTaskLabel"
          placement="top-start"
          :surface-style="{ maxWidth: 'min(520px, calc(100vw - 16px))' }"
        >
          <template #trigger>
            <span class="task-tip sel task">
              <span class="lbl">задача</span>
              <UiSelect
                compact
                data-context="chat-session-toolbar"
                :model-value="sess.taskId || ''"
                :disabled="frozen || sess.purpose === 'companion'"
                @change="onTaskChange"
              >
                <option value="">без задачи</option>
                <option v-for="o in taskOpts" :key="o.task" :value="o.task">
                  {{ optLabel(o) }}
                </option>
              </UiSelect>
            </span>
          </template>
        </UiTooltip>
      </div>
      <div class="col bar">
        <!-- Последний завершённый запуск. «Факт» пишем только когда модель назвал сам CLI;
             иначе показываем запрошенный id и не откатываемся к старому ходу другого ИИ. -->
        <div v-if="lastRunView.model || modelUnknown" class="factbar">
          <template v-if="lastRun">
            <span class="fb" :class="{ warn: lastRunView.mismatch }">
              последний ход · {{ lastRunView.source }}: <b>{{ modelLabelOf(lastRunView.model) }}</b>
              <template v-if="lastRun.effort"> · усилие {{ lastRun.effort }}</template>
            </span>
            <span v-if="lastRunView.mismatch" class="fb warn">— запрошено «{{ lastRequestedName }}»</span>
          </template>
          <span v-if="modelUnknown" class="fb warn"
                title="установленный CLI не знает эту модель — обнови его в настройках">
            установленный CLI не знает эту модель — обнови его в настройках
          </span>
        </div>
        <div class="spacer"></div>
        <div class="sel model">
          <span class="lbl">модель</span>
          <UiSelect
            compact
            data-context="chat-session-toolbar"
            :model-value="modelId"
            :disabled="frozen"
            :title="currentModelTitle"
            @change="onModelChange"
          >
            <template v-if="provGroups.length">
              <!-- «недоступен» — итог последней проверки исполнителя, а не запрет: причина
                   бывает временной (сеть, тайм-аут probe, минутный разлогин), и блокировка выбора
                   отбирала у человека решение из-за одного неудачного опроса. Пометка остаётся,
                   отказ приходит от самого запуска и называет настоящую причину. -->
              <optgroup v-for="p in provGroups" :key="p.id"
                        :label="p.name + (p.available ? '' : ' — недоступен')">
                <!-- «?» — модели нет в каталоге установленного CLI (он про неё не знает) -->
                <option v-for="m in p.models" :key="m.id" :value="m.id"
                        :title="modelOptionTitle(m, p)">
                  {{ modelOptionLabel(m) }}
                </option>
              </optgroup>
            </template>
            <template v-else>
              <option v-for="m in FALLBACK_MODELS" :key="m" :value="m">{{ m }}</option>
            </template>
          </UiSelect>
        </div>
        <!-- Режим прав: как агент поступает с действиями (спрашивать / сам / только план) -->
        <div v-if="modes.length" class="sel mode">
          <span class="lbl">режим</span>
          <UiSelect
            compact
            data-context="chat-session-toolbar"
            :model-value="currentMode"
            :disabled="frozen"
            :title="modeHint"
            @change="chat.setMode(sid, $event.target.value)"
          >
            <option v-for="m in modes" :key="m.id" :value="m.id" :title="m.hint">{{ m.label }}</option>
          </UiSelect>
        </div>
        <!-- Обёртки быть не должно: соседние правила (`.sel + .eff`, `.eff + .ctx-tip`)
             рисуют разделители по сиблингам, и лишний узел их погасил бы. -->
        <EffortSlider v-if="effortLevels.length" :model-value="effortValue" :levels="effortLevels"
                      :disabled="frozen" @update:model-value="chat.setEffort(sid, $event)" />
        <!-- Контекст: точная активная заполненность; при недоступной метрике дуга пустая.
             Клик — сжатие контекста (с подтверждением), Alt+клик — сброс памяти агента.
             Подсказка штатная, а не browser title: так она не обрезается и вмещает
             раздельные числа, состояние и действия. -->
        <UiTooltip
          placement="top-end"
          :surface-style="{ maxWidth: 'min(300px, calc(100vw - 16px))' }"
        >
          <template #trigger>
            <UiIconButton
              class="ctx-tip ctx-ring"
              :class="[ctxClass, { estimate: ctxIsEstimate, compacting: sess.compacting }]"
              role="embedded"
              :label="ctxTitle"
              :aria-disabled="ctxRingDisabled"
              data-context="chat-context"
              @click="onCtxClick"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle class="rbg" cx="12" cy="12" r="9" fill="none" stroke-width="3" />
                <circle
                  class="rfg"
                  cx="12"
                  cy="12"
                  r="9"
                  fill="none"
                  stroke-width="3"
                  stroke-linecap="round"
                  :stroke-dasharray="RING_C"
                  :stroke-dashoffset="ringDash"
                  transform="rotate(-90 12 12)"
                />
              </svg>
            </UiIconButton>
          </template>
          <template #tip>
            <span class="ctx-pop" data-testid="context-tooltip">
              <span class="ctx-pop-head">
                <span><b>{{ ctxTooltip.title }}</b><span class="ctx-pop-unit"> · токены</span></span>
                <span v-if="ctxTooltip.percent" class="ctx-pop-pct" :class="ctxTooltip.tone">
                  {{ ctxTooltip.percent }}
                </span>
              </span>
              <span v-if="ctxTooltip.status" class="ctx-pop-status" :class="ctxTooltip.tone">
                {{ ctxTooltip.status }}
              </span>
              <span v-if="ctxTooltip.detail" class="ctx-pop-detail">{{ ctxTooltip.detail }}</span>
              <span v-if="ctxTooltip.rows.length" class="ctx-pop-rows">
                <span v-for="row in ctxTooltip.rows" :key="row.label"
                      class="ctx-pop-row" :class="{ unverified: row.unverified, cache: row.cache }">
                  <span class="ctx-pop-label">{{ row.label }}</span>
                  <span class="ctx-pop-value">{{ row.value }}</span>
                </span>
              </span>
              <span v-if="ctxTooltip.actions" class="ctx-pop-actions">
                <span class="ctx-pop-action"><b>Клик</b><span>сжать</span></span>
                <span class="ctx-pop-action"><b>Alt + клик</b><span>сбросить</span></span>
              </span>
            </span>
          </template>
        </UiTooltip>
      </div>
    </div>

    <!-- Плашки «переписка не сохраняется» здесь НЕТ намеренно: saveError — состояние
         общее (сервер не принимает запись вообще), а рисовалась бы она внутри открытого
         чата и висела бы в каждом, куда ни зайди. Об этой беде сообщает разовое
         оповещение из стора (_saveFailed), а сама переписка держится снимком в браузере. -->

    <!-- Сообщения: ты — справа, агент — слева, ошибка — компактная плашка -->
    <div ref="body" class="cs-body" @scroll.passive="onBodyScroll">
      <div class="col flow">
        <div v-if="!sess.messages?.length" class="empty">
          <div class="e-title">{{ sess.taskId ? chat.tabLabel(sess) : 'Спроси агента' }}</div>
          <p class="e-sub muted">
            {{ sess.taskId ? 'Агент видит код задачи (worktree).' : 'Свободный вопрос без привязки к задаче.' }}<br>
            Модель и усилие — сверху. Enter — отправить, Shift+Enter — перенос.
            «/» — команды, «$» — навыки Codex.
          </p>
        </div>
        <div v-for="(m, i) in sess.messages || []" :key="i" class="msg" :class="m.role"
             :style="runBrandStyle(m)">
          <div v-if="m.attachments?.length" class="m-atts">
            <a v-for="a in m.attachments" :key="a.file" :href="api.url(a.url)" target="_blank" rel="noopener"
               @click="onAttachmentClick($event, a)">
              <img v-if="isImg(a)" :src="api.url(a.url)" :alt="a.name" :title="a.name" />
              <span v-else class="m-file">📄 {{ a.name }}</span>
            </a>
          </div>
          <!-- Подпись агента: ответ визуально отличим от системных плашек и твоих пузырей.
               Знак и цвет — исполнителя ИМЕННО ЭТОГО хода, а не вшитый Claude: ИИ меняют
               посреди разговора, и прошлые ответы обязаны остаться за прежним. -->
          <div v-if="m.role === 'assistant'" class="ahead">
            <ProviderIcon v-if="runProvider(m)" :provider="runProvider(m)" :size="12" />
            <span>Агент</span>
            <span v-if="m.actualModel || m.model" class="amodel">
              {{ runModelLabel(m) }}<template v-if="!m.actualModel"> · запрошено</template><template v-if="m.effort"> · {{ m.effort }}</template>
            </span>
          </div>
          <!-- Сообщение принято, но агент ещё занят предыдущим: ходы идут по очереди,
               а не наперегонки (два CLI на одну сессию убивают друг друга). -->
          <div v-if="m.queued" class="m-queued">⏳ ждёт очереди — уйдёт, когда агент закончит текущий ход</div>
          <!-- Сервер ещё не подтвердил приём сообщения. Пока подтверждения нет, агент не
               работает, поэтому здесь честное состояние доставки, а не «думает…». -->
          <div
            v-if="m.role === 'user' && m.delivery === 'sending'"
            class="m-delivery"
            :class="deliveryView(m).tone"
            data-role="chat-delivery"
          >
            <span>{{ deliveryView(m).text }}</span>
            <UiButton
              v-if="deliveryView(m).retry"
              variant="outline"
              tone="accent"
              data-role="chat-delivery-retry"
              :disabled="frozen"
              @click="retryDelivery(m)"
            >
              Отправить ещё раз
            </UiButton>
          </div>
          <!-- Ход агента: чем он занимался до ответа (свёрнуто, как в VS Code).
               У упавшего хода лента тем важнее: по ней видно, докуда он дошёл. -->
          <StepList
            v-if="(m.role === 'assistant' || m.role === 'error') && m.steps?.length"
            :steps="m.steps"
            :model-label="modelLabelOf"
          />
          <div v-if="m.text || (m.role === 'user' && validMessageTime(m.sentAt))" class="mrow">
            <!-- Ответ агента — безопасный GFM; raw HTML экранируется в md.js -->
            <div v-if="m.role === 'assistant'" class="text md"
                 v-html="mdToHtml(m.text, { resolveHref: chatFileLinkHref })"
                 @click="onMarkdownClick"></div>
            <div v-else class="text"><span v-if="m.text" class="m-copy">{{ m.text }}</span><time
              v-if="m.role === 'user' && validMessageTime(m.sentAt)" class="m-time"
              :datetime="messageTimeIso(m.sentAt)" :title="messageTimeTitle(m.sentAt)"
              :aria-label="messageTimeTitle(m.sentAt)">{{ messageTime(m.sentAt) }}</time></div>
            <UiIconButton
              v-if="m.text"
              class="copy"
              :class="{ done: copiedIdx === i }"
              role="stepper"
              :label="copiedIdx === i ? 'Скопировано' : 'Копировать сообщение'"
              :title="copiedIdx === i ? 'Скопировано' : 'Копировать сообщение'"
              data-context="chat-message-copy"
              @click="copyMsg(m, i)"
            >
              <svg v-if="copiedIdx === i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            </UiIconButton>
          </div>
          <!-- Ход прерван перезапуском сервера или самим CLI (сеть, лимит): память сессии
               цела, продолжение — обычное сообщение в ту же сессию. Только у последнего
               сообщения свободного чата. -->
          <div v-if="isResumeOffer(m, i)" class="m-resume">
            <UiButton
              variant="outline"
              tone="accent"
              data-role="chat-resume-interrupted"
              @click="resumeInterrupted"
            >
              ▶ Продолжить ход
            </UiButton>
          </div>
        </div>
        <div v-if="sess.sending" class="msg assistant" :style="liveBrandStyle">
          <!-- Шапка идущего хода — та же, что у готового ответа: знак исполнителя виден
               с первой секунды, а не только когда ответ дописан. Модель здесь — выбор
               чата, поэтому честно помечена «запрошено»; факт из потока CLI называют
               строка «старт» в ленте и шапка готового ответа. -->
          <div class="ahead">
            <ProviderIcon v-if="liveProvider" :provider="liveProvider" :size="12" />
            <span>Агент</span>
            <span v-if="modelId" class="amodel">
              {{ modelLabelOf(modelId) }} · запрошено<template v-if="effortValue"> · {{ effortValue }}</template>
            </span>
          </div>
          <!-- Живая лента текущего хода: инструменты и размышления по мере поступления -->
          <StepList v-if="sess.steps?.length" :steps="sess.steps" :model-label="modelLabelOf" live />
          <!-- Живая строка хода — последняя строка ЭТОГО блока, сразу под лентой шагов: она
               про тот же ход и идёт под переписку, а не отдельной полосой у поля ввода.
               Знак и слово стоят в тех же столбцах, что знак и заголовок строки шага. Ряд
               всегда один, поэтому смена слова («Думаю» ↔ «Выполняю команду») высоту блока
               не меняет. Число — расход вывода хода (0 = исполнитель его не публикует):
               заполненность контекста живёт в кольце и означает другое. -->
          <ChatThinking
            :steps="sess.steps"
            :tokens="sess.progressTokens"
            :tokens-estimate="sess.progressTokensEstimate"
            :started-at="sess.turnStartedAt"
          />
        </div>
        <!-- Связь этого окна с сервером оборвалась посреди хода. Сам ход при этом идёт:
             он живёт в процессе сервера, а не во вкладке, и ответ вернётся через
             chats/pending. Плашка ЛОКАЛЬНАЯ (поле offline в историю не едет) — порвалось
             у этого окна, другим устройствам показывать нечего. -->
        <div v-if="sess.offline" class="msg offline">
          <div class="text">📡 Связь с сервером прервалась — ход продолжается, ответ появится, когда связь вернётся.</div>
        </div>
      </div>
    </div>

    <!-- Действия задачи: конвейер или отдельный Debug-чат в той же песочнице. -->
    <div v-if="sess.taskId && (sess.messages?.length || sess.purpose !== 'debug')" class="cs-act">
      <div class="col act-row">
        <UiButton
          v-if="sess.messages?.length"
          class="act"
          :class="{ onconv: onConveyor }"
          variant="outline"
          :tone="onConveyor ? 'accent' : 'neutral'"
          data-role="chat-task-action"
          :disabled="frozen"
          @click="toConveyor"
        >
          🏭 {{ onConveyor ? 'Уже на конвейере →' : 'На конвейер' }}
        </UiButton>
        <UiTooltip
          v-if="sess.purpose !== 'debug'"
          :text="DEBUG_HINT"
          placement="top-start"
        >
          <template #trigger>
            <UiButton
              class="act debug-act"
              variant="outline"
              data-role="chat-task-action"
              :disabled="frozen || debugOpening"
              @click="openDebug"
            >
              🐞 {{ debugOpening ? 'Открываю…' : 'Исправлять' }}
            </UiButton>
          </template>
        </UiTooltip>
        <span v-if="launchMsg" class="lm muted">{{ launchMsg }}</span>
        <span v-if="debugMsg" class="lm muted">{{ debugMsg }}</span>
      </div>
    </div>

    <!-- Диалог: агент задал вопрос и ждёт ответа (не разрешение — выбор по существу) -->
    <ChatQuestion
      v-if="question"
      :req="question"
      @answer="answerQuestion"
      @skip="skipQuestion"
    />

    <!-- Всплывашка разрешения: агент хочет выполнить действие -->
    <ChatPermission v-if="perm" :req="perm"
                    @answer="(allow, remember, comment, choice) => chat.answerPerm(perm.pid, allow, remember, comment, choice)" />

    <!-- Ввод: единый композер, кнопки внутри (📎 фото, 🎤 диктовка) -->
    <div class="cs-input">
      <!-- Разделитель высоты поля ввода: стоит на верхней кромке (поверх линии),
           поэтому места в раскладке не занимает и ничего не сдвигает. -->
      <div class="cs-resize" role="separator" aria-orientation="horizontal" tabindex="0"
           aria-label="Высота поля ввода"
           :aria-valuemin="COMPOSER_MIN" :aria-valuemax="composerMax()"
           :aria-valuenow="Math.round(composerH ?? COMPOSER_MIN)"
           title="Потяни — высота поля ввода. Двойной клик — вернуть обычную"
           @pointerdown.prevent="startComposerResize" @pointermove.prevent="moveComposerResize"
           @pointerup.prevent="finishComposerResize" @pointercancel.prevent="cancelComposerResize"
           @dblclick="resetComposerHeight" @keydown="onComposerResizeKey">
        <span></span>
      </div>
      <div class="col">
        <!-- Чипы ещё не отправленных вложений -->
        <div v-if="pending.length || attachBusy" class="pend">
          <div v-for="(a, i) in pending" :key="a.file" class="chip">
            <img v-if="isImg(a)" :src="api.url(a.url)" alt="" />
            <span class="nm">{{ a.name }}</span>
            <UiIconButton
              class="x"
              role="stepper"
              label="Убрать вложение"
              title="Убрать"
              data-context="chat-pending-remove"
              @click="removePending(i)"
            >
              ×
            </UiIconButton>
          </div>
          <UiSpinner v-if="attachBusy" decorative />
        </div>
        <!-- Меню команд/навыков над композером: секция кокпита + секция исполнителя модели -->
        <div v-if="cmdMenu.length" ref="cmdMenuEl" class="cmd-menu">
          <template v-for="item in cmdMenu" :key="item.key">
            <div v-if="item.header" class="cmd-head">
              <span v-if="item.color" class="dot" :style="{ background: item.color }"></span>{{ item.header }}
            </div>
            <UiButton
              v-else
              class="cmd"
              :class="{ on: item.nav >= 0 && item.nav === cmdIndex, off: item.run === 'none' }"
              variant="ghost"
              data-role="chat-command"
              block
              :disabled="item.run === 'none'"
              @mouseenter="item.nav >= 0 && (cmdIndex = item.nav)"
              @click="runCommand(item)"
            >
              <span class="c-cmd">{{ item.cmd }}</span>
              <span class="c-desc">{{ item.desc }}</span>
              <span v-if="item.hint" class="c-hint">{{ item.hint }}</span>
            </UiButton>
          </template>
        </div>
        <div v-if="consentPending" class="speech-prompt" data-testid="speech-consent">
          <div>
            <b>Перед первой диктовкой</b>
            <p>Браузер может обработать звук на этом устройстве или передать своему сервису.
              До подтверждения микрофон не включается.</p>
          </div>
          <div class="speech-actions">
            <UiButton
              class="speech-primary"
              variant="solid"
              tone="accent"
              data-role="chat-speech-action"
              data-testid="speech-consent-browser"
              @click="confirmBrowserConsent"
            >
              Продолжить в браузере
            </UiButton>
            <UiButton
              variant="outline"
              data-role="chat-speech-action"
              data-testid="speech-consent-whisper"
              @click="useWhisperFromPrompt"
            >
              Использовать Whisper
            </UiButton>
            <UiButton
              variant="outline"
              data-role="chat-speech-action"
              @click="stopSpeech({ cancel: true })"
            >
              Отмена
            </UiButton>
          </div>
        </div>
        <div v-else-if="browserInstallPending" class="speech-prompt" data-testid="speech-browser-install">
          <div>
            <b>Нужна локальная языковая модель</b>
            <p>Браузер может скачать её и после этого распознавать речь только на этом устройстве.</p>
          </div>
          <div class="speech-actions">
            <UiButton
              class="speech-primary"
              variant="solid"
              tone="accent"
              data-role="chat-speech-action"
              data-testid="speech-install-browser"
              @click="installBrowserLanguage"
            >
              Скачать и продолжить
            </UiButton>
            <UiButton
              variant="outline"
              data-role="chat-speech-action"
              data-testid="speech-install-whisper"
              @click="useWhisperFromPrompt"
            >
              Использовать Whisper
            </UiButton>
            <UiButton
              variant="outline"
              data-role="chat-speech-action"
              @click="stopSpeech({ cancel: true })"
            >
              Отмена
            </UiButton>
          </div>
        </div>
        <div v-if="interimSpeech" class="speech-interim" data-testid="speech-interim">Слышу: {{ interimSpeech }}</div>
        <div class="composer">
          <UiFilePicker
            data-role="chat-attachment"
            density="compact"
            multiple
            :busy="attachBusy"
            :show-summary="false"
            :show-reset="false"
            label="Приложить файл"
            loading-label="Прикладываю файл"
            title="Приложить файл (или перетащи/вставь из буфера)"
            @change="onPick"
          >
            <template #leading>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            </template>
          </UiFilePicker>
          <UiTextarea
            ref="taEl"
            v-model="input"
            rows="2"
            data-role="chat-composer"
            :placeholder="recording ? 'Говори… (клик по микрофону — стоп, Esc — отмена)' : drainingSpeech ? 'Завершаю распознавание…' : speechBusy ? 'Подготавливаю диктовку…' : 'Сообщение агенту…'"
            @keydown="onKey"
            @paste="onPaste"
          />
          <UiTooltip
            placement="top-end"
            :text="recording ? 'Остановить · Ctrl+D; отменить · Esc' : drainingSpeech ? 'Завершаю распознавание… Esc — отмена' : transcribing ? 'Расшифровываю запись…' : preparingSpeech || browserInstalling ? 'Подготавливаю… Esc — отмена' : 'Надиктовать голосом · Ctrl+D'"
          >
            <template #trigger>
              <UiIconButton
                class="tool mic"
                :class="{ rec: recording, wait: transcribing || preparingSpeech || browserInstalling || drainingSpeech }"
                role="peer"
                :label="recording ? 'Остановить диктовку' : 'Начать диктовку'"
                :pressed="recording"
                :disabled="transcribing || drainingSpeech"
                data-context="chat-microphone"
                @click="toggleMic"
              >
                <!-- Расшифровка: крутящийся спиннер -->
                <svg v-if="transcribing || preparingSpeech || browserInstalling || drainingSpeech" class="spin-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
                  <path d="M21 12a9 9 0 1 1-6.2-8.56" />
                </svg>
                <!-- Запись: квадрат-стоп -->
                <svg v-else-if="recording" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6.5" y="6.5" width="11" height="11" rx="2" />
                </svg>
                <!-- Покой: микрофон -->
                <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="12" x2="12" y1="19" y2="22" />
                </svg>
              </UiIconButton>
            </template>
          </UiTooltip>
          <!-- Пока агент работает, рядом появляется «стоп». Отправку при этом НЕ прячем:
               следующее сообщение можно готовить и слать сразу — сервер поставит его
               в очередь и пустит следом (раньше оно молча пропадало). -->
          <UiIconButton
            v-if="sess.sending || sess.compacting"
            class="send stop"
            role="peer"
            variant="solid"
            tone="danger"
            :disabled="sess.stopping"
            :label="sess.stopping ? 'Останавливаю…'
              : sess.compacting ? 'Прервать сжатие контекста' : 'Остановить агента'"
            :title="sess.stopping ? 'Останавливаю…'
              : sess.compacting ? 'Прервать сжатие контекста' : 'Остановить агента'"
            data-context="chat-stop"
            @click="chat.stop(sid)"
          >
            <span class="sq"></span>
          </UiIconButton>
          <UiIconButton
            class="send"
            role="peer"
            variant="solid"
            tone="accent"
            :disabled="frozen || speechBusy || (!input.trim() && !pending.length)"
            :label="speechBusy ? 'Сначала заверши диктовку'
              : frozen ? frozenHint
              : sess.sending ? 'Отправить следом — уйдёт, когда агент закончит текущий ход (Enter)' : 'Отправить (Enter)'"
            :title="speechBusy ? 'Сначала заверши диктовку'
              : frozen ? frozenHint
              : sess.sending ? 'Отправить следом — уйдёт, когда агент закончит текущий ход (Enter)' : 'Отправить (Enter)'"
            data-context="chat-send"
            @click="submit"
          >
            ↑
          </UiIconButton>
        </div>
        <div v-if="speechNotice" class="speech-note" data-testid="speech-notice">{{ speechNotice }}</div>
        <div v-if="inputErr" class="in-err">{{ inputErr }}</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../../shared/apiClient.ts';
import { useDictationController } from '../../features/speech/provider.js';
import { useChatStore, CONTEXT_WINDOW } from '../../stores/chat.js';
import { contextFill } from '../../../../shared/chatContext.ts';
import { writeClipboardText } from '../../shared/clipboard.ts';
import { useTasksStore } from '../../stores/tasks.js';
import { useUiStore } from '../../stores/ui.js';
import { useProvidersStore } from '../../stores/providers.js';
import EffortSlider from './EffortSlider.vue';
import StepList from './StepList.vue';
import ChatThinking from './ChatThinking.vue';
import ChatQuestion from './ChatQuestion.vue';
import ChatPermission from './ChatPermission.vue';
import ProviderIcon from '../../shared/ProviderIcon.vue';
import {
  confirmDialog,
  UiButton,
  UiFilePicker,
  UiIconButton,
  UiInput,
  UiSelect,
  UiSpinner,
  UiTextarea,
  UiTooltip,
} from '../../ui';
import { mdToHtml } from '../../shared/md.ts';
import { documentLinkFromClick } from '../../features/documents/links.js';
import { chatFileLinkHref, codeLinkFromClick, loadCodeRoots } from '../../features/code/links.ts';
import { useToolLauncher } from '../../shared/tools/launcher.ts';
import { useDocumentPreviewStore } from '../../stores/documentPreview.ts';
import { lastModelRun, modelRunView } from '../../shared/chat-model-run.js';

// Полноразмерная сессия на единственной странице «Чаты».
const props = defineProps({
  sid: { type: String, required: true },
});
// back — «назад к списку чатов»: кнопка живёт в шапке, но видна только на узком экране,
// где список и чат делят одну колонку (показом управляет CSS, не JS).
const emit = defineEmits(['back']);

const router = useRouter();
const chat = useChatStore();
const tasks = useTasksStore();
const ui = useUiStore();
const documentPreview = useDocumentPreviewStore();
const { openTool } = useToolLauncher();
// Карта деревьев репозиториев для моста «ссылка на файл кода → панель „Код“».
// Пока она не приехала (или плагин «Код» выключен), такие ссылки честно рендерятся
// текстом; резолвер читает реактивный ref, поэтому лента дорисуется сама.
loadCodeRoots();

function onMarkdownClick(event) {
  if (!isPlainClick(event)) return;
  const image = event.target?.closest?.('img');
  if (image) {
    event.preventDefault();
    documentPreview.showImage({
      src: image.currentSrc || image.getAttribute('src'),
      name: image.getAttribute('alt') || image.getAttribute('title') || 'Изображение',
      mime: '',
    });
    return;
  }
  const href = documentLinkFromClick(event);
  if (href) {
    event.preventDefault();
    documentPreview.show(href);
    return;
  }
  const codeTarget = codeLinkFromClick(event);
  if (!codeTarget) return;
  event.preventDefault();
  openTool('code', { type: 'open-file', ...codeTarget });
}

function isPlainClick(event) {
  return event?.button === 0
    && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

function onAttachmentClick(event, attachment) {
  if (!isImg(attachment) || !isPlainClick(event)) return;
  event.preventDefault();
  documentPreview.showImage({
    src: api.url(attachment.url),
    name: attachment.name,
    mime: attachment.mime,
  });
}

// Архивный разговор открывается для чтения прямо из архива. Отправка сообщения
// сама перенесёт тот же объект в активные (stores/chat.js), отдельной копии нет.
const sess = computed(() => chat.sessions.find((s) => s.id === props.sid)
  || (chat.archived || []).find((s) => s.id === props.sid)
  || null);

// ── Название чата в шапке страницы «Чаты» ──
const editingTitle = ref(false);
const titleVal = ref('');
const titleEl = ref(null);
async function startTitleEdit() {
  titleVal.value = chat.tabLabel(sess.value);
  editingTitle.value = true;
  await nextTick();
  titleEl.value?.focus();
  titleEl.value?.select();
}
function commitTitle() {
  if (editingTitle.value) chat.setTitle(props.sid, titleVal.value.trim());
  editingTitle.value = false;
}

// ── Модели из реестра исполнителей (/api/providers): группы по ИИ, сила — сверху,
// у каждой модели свои уровни эффорта и своё окно контекста. Хардкода нет:
// новая модель/уровень появляется из реестра сама. ──
const prov = useProvidersStore();
prov.load();
// Модель чата: пустая = «по умолчанию»; сохранённый алиас (`opus`) резолвится в ту модель,
// на которую он указывает у текущего CLI. Решаем здесь, а не при создании чата: реестр
// к тому моменту может быть не загружен, да и бинарь потом обновится.
const current = computed(() => prov.modelOf(sess.value?.modelRef || sess.value?.model));
const modelId = computed(() => current.value.id);
const effortValue = computed(() => sess.value?.effort || '');
const currentModel = computed(() => current.value.model);
const fmtTokens = (value) => Math.max(0, Number(value) || 0).toLocaleString('ru');

/**
 * Каталог Codex намеренно не сообщает окно. Для выбранной модели точнее всего замер
 * живой thread; до него вместо паспортной или сохранённой заглушки показываем источник
 * будущего факта. Остальные исполнители сохраняют прежний каталожный контракт.
 */
function modelContextTitle(model, label) {
  const runtimeWindow = model?.id === currentModel.value?.id
    ? Math.max(0, Number(sess.value?.contextWindow) || 0)
    : 0;

  if (runtimeWindow) {
    return `${label} · рабочее окно ${fmtTokens(runtimeWindow)} токенов`;
  }
  if (model?.contextRuntimeOnly) {
    return `${label} · рабочее окно появится после первого хода`;
  }

  const context = Math.max(0, Number(model?.context) || 0);
  if (!context) {
    return `${label} · окно контекста неизвестно`;
  }

  return `${label} · контекст ${fmtTokens(context)} токенов`
    + (model.contextUnverified ? ' · окно не подтверждено' : '');
}

const currentModelTitle = computed(() => (
  currentModel.value ? modelContextTitle(currentModel.value, currentModel.value.name) : 'Модель'
));
// Подсказка пункта: окно модели и оговорки каталога. Недоступность исполнителя
// названа здесь же и словами: она предупреждает о вероятном отказе, но выбор не отменяет.
const modelOptionTitle = (model, provider) => modelContextTitle(model, model.id)
  + (model.unknown ? ' · нет в каталоге установленного CLI' : '')
  + (provider?.available === false ? ' · исполнитель недоступен по последней проверке' : '');
const modelOptionLabel = (model) => model.name
  + (model.contextUnverified && !model.contextRuntimeOnly ? ' · окно не подтверждено' : '')
  + (model.unknown ? ' ?' : '');
// Группы моделей для селекта (что именно видно — решает стор, правило одно на весь кокпит).
const provGroups = computed(() => prov.providers
  .map((p) => ({ ...p, models: prov.visibleModels(p, modelId.value) }))
  .filter((p) => p.models.length));
const FALLBACK_MODELS = ['opus', 'sonnet', 'haiku', 'fable']; // пока реестр не загрузился
const effortLevels = computed(() => currentModel.value?.efforts || []);
// Режимы прав исполнителя (список даёт его CLI). Пока чат не выбрал свой — показываем
// «вручную»: именно так работает чат по умолчанию (спрашивает разрешение на действия).
const modes = computed(() => prov.modesOf(sess.value?.modelRef || sess.value?.model));
const currentMode = computed(() => {
  const want = sess.value?.mode;
  const list = modes.value;
  if (want && list.some((m) => m.id === want)) return want;
  return list.some((m) => m.id === 'manual') ? 'manual' : (list[0]?.id || '');
});
const modeHint = computed(() => modes.value.find((m) => m.id === currentMode.value)?.hint || 'Режим прав агента');
// Codex сообщает эффективное окно только в token usage конкретной сессии (например,
// 272k × 95% = 258.4k). Каталог его не обещает; 200k ниже — только внутренний fallback,
// который не показываем человеку как свойство модели.
const ctxUsage = computed(() => {
  const s = sess.value;

  return {
    contextWindow: s?.contextWindow,
    contextMetric: s?.contextMetric,
    contextIsEstimate: s?.contextIsEstimate,
    ...(s?.sending ? s.liveContextUsage : null),
  };
});
const ctxWindow = computed(() => (
  ctxUsage.value?.contextWindow || currentModel.value?.context || CONTEXT_WINDOW
));
// Модель выбрана, но установленный CLI про неё не знает (реестр помечает `unknown`):
// полный id он обычно всё равно принимает, а вот алиас/подпись могут врать — предупреждаем.
const modelUnknown = computed(() => !!currentModel.value?.unknown);
// Ключ хода — ЗАПРОШЕННАЯ модель: она из реестра и разворачивает алиасы. Факт из потока
// CLI берём вторым: у Claude это полный версионный id, которого в каталоге может не быть.
function runModelId(message) {
  const id = message.model || message.actualModel || '';

  return typeof id === 'string' ? id : '';
}

// Модель хода → исполнитель. Считаем разом по всей переписке: modelOf ходит по всему
// реестру, а из шаблона он звался бы на каждый рендер каждого сообщения.
const runProviders = computed(() => {
  const map = new Map();

  for (const message of sess.value?.messages || []) {
    const id = message?.role === 'assistant' ? runModelId(message) : '';

    if (!id || map.has(id)) continue;
    const found = prov.modelOf(id);
    map.set(id, { provider: found.provider || null, label: found.model?.name || id });
  }

  return map;
});

// Подпись модели для человека: имя из каталога (`Opus 5`, `DeepSeek-V4-Flash`), а не
// машинный id. У DeepSeek id — opaque JSON-массив, и без каталога шапка чата и шаг
// «старт» показывали его как есть. Незнакомый реестру id остаётся сырым: он всё ещё
// обязан называть, чем отвечали.
function modelLabelOf(id) {
  if (!id) return '';
  const found = prov.modelOf(id);

  return found.model?.name || found.id || id;
}

/** Подпись модели готового ответа: факт из потока или запрошенная, но именем из каталога. */
function runModelLabel(message) {
  const id = runModelId(message);

  return runProviders.value.get(id)?.label || id;
}

/**
 * Исполнитель конкретного ответа: знак и цвет шапки берутся из модели ЭТОГО хода, а не
 * из селекта сессии — иначе смена ИИ задним числом переписывает всю прошлую переписку.
 * Незнакомую реестру модель оставляем без знака: чужой фирменный знак хуже, чем никакого.
 */
function runProvider(message) {
  if (message?.role !== 'assistant') return null;

  return runProviders.value.get(runModelId(message))?.provider || null;
}

// Фирменный цвет исполнителя одной переменной на всё сообщение: её берут и полоска
// слева, и сам знак. Нет исполнителя — нет переменной, и оба остаются нейтральными.
function runBrandStyle(message) {
  const color = runProvider(message)?.color;

  return color ? { '--prov': color } : null;
}

// Идущий ход ещё не сообщение, и своей модели у него нет: исполнителя берём из выбора
// чата — работает сейчас именно он. Знак в шапке и полоска слева идут от одного
// исполнителя: без этого живой ход получал цвет без знака, а знак — только вместе с ответом.
const liveProvider = computed(() => current.value.provider || null);
const liveBrandStyle = computed(() => {
  const color = liveProvider.value?.color;

  return color ? { '--prov': color } : null;
});

// Последний завершённый ход с моделью. Claude сообщает `actualModel` из потока,
// Codex JSONL пока его не отдаёт — у него честно показываем «запрошено», иначе
// поиск последнего непустого факта откатывался к старому Claude-ответу.
const lastRun = computed(() => lastModelRun(sess.value?.messages || []));
const lastRunView = computed(() => modelRunView(lastRun.value));
const lastRequestedName = computed(() => {
  const id = lastRun.value?.model;
  return id ? (prov.modelOf(id).model?.name || id) : '';
});
async function onModelChange(e) {
  // Reset Kimi асинхронный и на время запроса перерисовывает select со старой моделью.
  // Поэтому выбранный id надо снять с DOM до await, иначе после подтверждения здесь
  // снова окажется K3 и визуально успешный reset отменит саму смену модели.
  const select = e.target;
  const nextModelId = select.value;
  const oldProvider = current.value.provider;
  const oldProv = oldProvider?.id;
  const newProv = prov.modelOf(nextModelId).provider?.id;
  // Сменили ИИ (claude ↔ gpt) — sessionId прежнего исполнителя несовместим,
  // резюмить им нельзя: сбрасываем контекст, история чата остаётся.
  // У старого фронта Kimi reset был только локальным: в истории id уже мог быть null,
  // а server-owned binding — всё ещё жив. Поэтому для Kimi сбрасываем sidecar даже без
  // видимого sessionId; revision позволяет стору отличить сохранённый чат от нового.
  if (oldProv && newProv && oldProv !== newProv
      && (sess.value?.sessionId || oldProvider?.sessionBinding === true)) {
    // Для capability reset меняет server-owned binding. Модель переключаем только после
    // подтверждения, иначе при сетевой ошибке старую сессию было бы уже не сбросить.
    if (!await chat.resetContext(props.sid)) {
      select.value = modelId.value;
      return;
    }
  }
  chat.setModel(props.sid, nextModelId);
  // У новой модели может не быть текущего уровня эффорта — снимаем явный выбор.
  // Выбирать другую ступень за пользователя нельзя.
  const lv = effortLevels.value;
  if (sess.value?.effort && lv.length && !lv.includes(sess.value.effort)) {
    chat.setEffort(props.sid, '');
  }
}

// Реестр загружается асинхронно и может обновиться уже после открытия чата.
// Когда он принёс достоверный список, старое неподдерживаемое значение не сохраняем.
watch(effortLevels, (levels) => {
  if (sess.value?.effort && levels.length && !levels.includes(sess.value.effort)) {
    chat.setEffort(props.sid, '');
  }
}, { immediate: true });

// ── Список задач для селекта (с ЗАГОЛОВКАМИ, не только номером) ──
let taskListPromise = null;
function fetchTaskList() {
  if (!taskListPromise) taskListPromise = api.get('/api/tasks').then((r) => r.tasks || []).catch(() => []);
  return taskListPromise;
}
const taskOpts = ref([]); // [{ task, route, title }]
onMounted(async () => {
  // При открытии — сразу в конец истории
  await nextTick();
  scrollDown();
  chat.loadConveyor();
  const list = await fetchTaskList();
  taskOpts.value = list.map((t) => ({ task: String(t.task), route: t.route, title: '' }));
  // Подтягиваем названия из B24 (для «#<TASK> · Название задачи…»).
  list.forEach((t) => tasks.load(t.task).then((d) => {
    const o = taskOpts.value.find((x) => x.task === String(t.task));
    if (o && d?.title) o.title = d.title;
  }).catch(() => {}));
});
function optLabel(o) { return `#${o.task} · ${o.title || o.route || 'задача'}`; }
const activeTaskLabel = computed(() => {
  const id = String(sess.value?.taskId || '');
  if (!id) return 'Без привязки к задаче';
  const option = taskOpts.value.find((o) => o.task === id);
  return option ? optLabel(option) : `#${id}`;
});
function onTaskChange(e) {
  const val = e.target.value;
  const o = taskOpts.value.find((x) => x.task === val);
  chat.setTask(props.sid, val || null, o ? (o.title || `#${o.task}`) : '');
}

// ── Контекст (окно — у каждой модели своё, из реестра) ──
// Пока ход идёт, кольцо показывает ЖИВОЙ размер (`liveContext` — вход каждого обращения
// к модели, если исполнитель его сообщает), а не цифру с прошлого хода. Разница не косметическая:
// автокомпакт CLI срабатывает на границе хода, и без живого замера кольцо весь ход горело
// бы красным по уже сжатому контексту.
const ctxHasLiveUsage = computed(() => sess.value?.sending
  && (sess.value?.liveContextUsage?.contextTokens !== undefined || sess.value?.liveContext > 0));
const ctxTokens = computed(() => (
  ctxHasLiveUsage.value
    ? (sess.value?.liveContextUsage?.contextTokens ?? sess.value.liveContext)
    : (sess.value?.contextTokens || 0)
));
// ── Ближайший практический порог контекста ────────────────────────────────────
// Кольцо считает заполненность только по объёму активного контекста: до настроенного
// автосжатия или безопасного потолка окна. Кэш — отдельный факт последнего запроса;
// он не меняет ни шкалу, ни цвет кольца.
// Абсолютное число без потолка врало бы в другую сторону: у модели с окном 200k порог
// 200k недостижим, кольцо осталось бы зелёным до самого конца разговора.
// Сама арифметика — в `shared/chatContext.ts`: тот же порог показывает карточка
// Telegram-пульта, и две копии этой шкалы разъехались бы на первой же правке.
const ctxFill = computed(() => contextFill({
  tokens: ctxTokens.value,
  window: ctxWindow.value,
  compactWindow: current.value.provider?.capabilities?.chatAutoCompact === true
    ? (chat.compactWindow || 0) : 0,
}));
const ctxLimit = computed(() => ctxFill.value.limit);
// Заполненность — доля ТОГО ЖЕ порога, по которому кольцо красится. Раньше цвет считался
// от порога, а дуга и подсказка — от окна модели, и на 1M это расходилось втрое: 168k
// давали жёлтый цвет (84% порога) при дуге, залитой на 17%. Человек читает форму, а не
// оттенок, поэтому почти пустое кольцо перевешивало предупреждение — «места ещё дофига»,
// пока CLI уже сжимал контекст по кругу.
const ctxPct = computed(() => ctxFill.value.pct);
const ctxRuntimeWindowPending = computed(() => (
  !ctxUsage.value?.contextWindow
    && (!!currentModel.value?.contextRuntimeOnly || !(currentModel.value?.context > 0))
));
const ctxUnavailable = computed(() => (!!sess.value?.sessionId || ctxHasLiveUsage.value)
  && (['legacy-unavailable', 'unavailable'].includes(ctxUsage.value?.contextMetric)
    || ctxRuntimeWindowPending.value || ctxWindowUnverified.value));
const ctxClass = computed(() => (ctxUnavailable.value ? '' : ctxFill.value.tone));
const ctxIsEstimate = computed(() => !!ctxUsage.value?.contextIsEstimate);
const ctxSampleHint = computed(() => {
  if (!sess.value?.sending) return '';

  return ctxHasLiveUsage.value ? ' · этот ход' : ' · прошлый ход, ждём замер';
});
const ctxWindowUnverified = computed(() => (
  !ctxUsage.value?.contextWindow && !!currentModel.value?.contextUnverified
));
const fmtSessionTokens = (value) => {
  const tokens = Math.max(0, Number(value) || 0);
  if (tokens < 1_000_000) return fmtTokens(tokens);
  return `${(tokens / 1_000_000).toLocaleString('ru', { maximumFractionDigits: 1 })} млн`;
};
const fmtCompactTokens = (value) => {
  const tokens = Math.max(0, Number(value) || 0);
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toLocaleString('ru', { maximumFractionDigits: 1 })} млн`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toLocaleString('ru', { maximumFractionDigits: 1 })} тыс.`;
  }
  return fmtTokens(tokens);
};
const spentHint = computed(() => {
  const total = sess.value?.totalInputTokens || 0;
  return total ? ` · за сессию обработано ${fmtTokens(total)} входных токенов` : '';
});
const contextCache = computed(() => {
  const live = sess.value?.sending ? sess.value?.liveContextCache : null;
  const cache = live || sess.value?.contextCache;
  if (cache?.scope !== 'request'
    || !['reported', 'unavailable', 'not-applicable'].includes(cache?.status)) {
    return { scope: 'request', status: 'unavailable' };
  }
  if (cache.status === 'reported'
    && !['readTokens', 'writeTokens', 'uncachedTokens'].some((key) => cacheMetric(cache, key) !== null)) {
    return { scope: 'request', status: 'unavailable' };
  }
  return cache;
});
const cacheMetric = (cache, key) => (
  Number.isSafeInteger(cache?.[key]) && cache[key] >= 0 ? cache[key] : null
);
const contextCacheValue = computed(() => {
  const cache = contextCache.value;
  if (cache.status === 'unavailable') return 'нет данных';
  if (cache.status === 'not-applicable') return 'без тарифа';
  const read = cacheMetric(cache, 'readTokens');
  const write = cacheMetric(cache, 'writeTokens');
  const uncached = cacheMetric(cache, 'uncachedTokens');
  const parts = [];
  // Долю считаем только из одного и того же request-снимка. Размер кольца — другая
  // метрика и может относиться к иному этапу хода; смешивать их в знаменателе нельзя.
  if (read !== null && uncached !== null) {
    const measured = read + (write || 0) + uncached;
    const percent = (measured > 0 ? (read / measured) * 100 : 0)
      .toLocaleString('ru', { maximumFractionDigits: 1 });
    parts.push(`${percent}%`);
  }
  if (read !== null) parts.push(`чт. ${fmtCompactTokens(read)}`);
  if (write !== null) parts.push(`зап. ${fmtCompactTokens(write)}`);
  if (uncached !== null) parts.push(`мимо ${fmtCompactTokens(uncached)}`);
  return parts.join(' · ');
});
const cacheHint = computed(() => ` · кэш: ${contextCacheValue.value}`);
const ctxAtWarning = computed(() => !!ctxFill.value.tone);
const ctxLimitReached = computed(() => ctxFill.value.tone === 'hi');
const ctxLimitWhat = computed(() => ctxFill.value.limitWhat);
const ctxLimitShort = computed(() => ctxFill.value.limitShort);

// Визуальная подсказка не собирается из одной длинной строки: у штатного UiTooltip есть
// форматированный слот, поэтому числа, предупреждение и действия остаются отдельными
// смысловыми блоками. `ctxTitle` ниже — только компактная доступная подпись кнопки.
const ctxTooltip = computed(() => {
  const s = sess.value;
  const modelWindow = `${fmtTokens(ctxWindow.value)}${ctxWindowUnverified.value ? ' · неточно' : ''}`;
  const rows = ctxRuntimeWindowPending.value
    ? []
    : [{ label: 'Окно', value: modelWindow, unverified: ctxWindowUnverified.value }];
  const total = s?.totalInputTokens || 0;
  const addSessionRows = () => {
    if (total) rows.push({ label: 'За сессию', value: fmtSessionTokens(total) });
    rows.push({ label: 'Кэш', value: contextCacheValue.value, cache: true });
  };

  if (s?.compacting) {
    return {
      title: 'Контекст', percent: '', tone: 'active', status: 'Сжимаю контекст…',
      detail: 'Агент готовит рабочую выжимку разговора.', rows: [], actions: false,
    };
  }
  if (!s?.sessionId && !ctxHasLiveUsage.value) {
    return {
      title: 'Контекст', percent: '', tone: '',
      status: s?.pendingSeed ? 'Контекст сжат' : 'Контекст пуст',
      detail: s?.pendingSeed
        ? 'Выжимка уедет агенту со следующим сообщением.'
        : 'Размер появится после первого хода.',
      rows, actions: false,
    };
  }
  if (s?.compactedAt && !ctxTokens.value) {
    addSessionRows();
    return {
      title: 'Контекст', percent: '', tone: '', status: 'Контекст сжат',
      detail: 'Новый размер появится после следующего хода.', rows, actions: true,
    };
  }
  if (ctxUnavailable.value) {
    addSessionRows();
    return {
      title: 'Контекст', percent: '', tone: '', status: 'Точная заполненность пока недоступна',
      detail: 'Исполнитель пока не сообщил свежий размер контекста.', rows, actions: true,
    };
  }

  rows.unshift(
    {
      label: 'Сейчас',
      value: `${ctxIsEstimate.value ? '≈ ' : ''}${fmtTokens(ctxTokens.value)}${ctxSampleHint.value}`,
    },
    { label: 'Порог', value: `${fmtTokens(ctxLimit.value)} · ${ctxLimitShort.value}` },
  );
  addSessionRows();
  return {
    title: 'Контекст',
    percent: `${ctxPct.value}%`,
    tone: ctxLimitReached.value ? 'bad' : (ctxAtWarning.value ? 'warn' : ''),
    status: ctxLimitReached.value
      ? 'Порог достигнут — пора сжать'
      : (ctxAtWarning.value ? 'Порог близко — пора сжать' : ''),
    detail: '',
    rows,
    actions: true,
  };
});
const ctxTitle = computed(() => {
  const s = sess.value;
  const tokens = fmtTokens(ctxTokens.value);
  if (s?.compacting) return 'Сжимаю контекст…';
  if (!s?.sessionId && !ctxHasLiveUsage.value) {
    const empty = s?.pendingSeed
      ? 'Контекст сжат — выжимка уедет со следующим сообщением'
      : 'Контекст: пусто';
    if (ctxRuntimeWindowPending.value) {
      return `${empty} · рабочее окно появится после первого хода`;
    }
    return ctxWindowUnverified.value
      ? `${empty} · окно модели ${fmtTokens(ctxWindow.value)} (не подтверждено)`
      : empty;
  }
  if (s?.compactedAt && !ctxTokens.value) return 'Контекст сжат — размер покажется после следующего хода';
  const hint = 'клик — сжать (Alt+клик — сбросить память агента)';
  if (ctxUnavailable.value) {
    return `Точная заполненность пока недоступна${spentHint.value}${cacheHint.value} · ${hint}`;
  }
  const warn = ctxLimitReached.value
    ? ' · порог достигнут — пора сжать'
    : (ctxAtWarning.value ? ' · порог близко — пора сжать' : '');
  const estimate = ctxIsEstimate.value ? 'примерно ' : '';
  // Пока ход идёт, цифра замерена ЭТИМ ходом — про это стоит сказать прямо: иначе
  // упавший на глазах контекст (автокомпакт CLI) выглядит сбоем кольца.
  const live = s?.sending
    ? (ctxHasLiveUsage.value ? ' (замер этого хода)' : ' (замер прошлого хода)') : '';
  // Считаем от того же порога, что рисует дугу. Окно модели остаётся в подсказке
  // справочно: на 1M оно вводило в заблуждение как основная шкала — «из 1 000 000»
  // читается как огромный запас там, где до сжатия остались проценты.
  const limit = fmtTokens(ctxLimit.value);
  // Подпись называет ТО событие, которое случится первым, иначе цифра порога
  // необъяснима: «до потолка окна 250 000» при окне в миллион читается как ошибка.
  // «Не подтверждено» — разбор таблицы моделей в бинаре CLI сломался (обновился CLI,
  // сменился формат), и окно ниже это заглушка, а не факт. Молчать нельзя: именно по
  // этой цифре человек решает, пора ли сжимать. Замер самой сессии (Codex сообщает своё
  // окно) сильнее каталога, и к нему оговорка не относится.
  const window = ` · окно модели ${fmtTokens(ctxWindow.value)}${ctxWindowUnverified.value ? ' (не подтверждено)' : ''}`;
  return `Контекст: ${estimate}${tokens} из ${limit} ${ctxLimitWhat.value} (${ctxPct.value}%)${live}${warn}${window}${spentHint.value}${cacheHint.value} · ${hint}`;
});
// Кольцо-индикатор контекста (клик — сжатие, Alt+клик — сброс памяти).
const RING_C = 2 * Math.PI * 9;
// На время сжатия дуга — короткий бегунок: кольцо в этот момент вращается, а полное
// (или почти полное) кольцо при вращении выглядело бы неподвижным.
const SPIN_DASH = RING_C * 0.75;
const ringDash = computed(() => {
  if (sess.value?.compacting) return SPIN_DASH;
  if (ctxUnavailable.value) return RING_C;

  return RING_C * (1 - ctxPct.value / 100);
});
// Нативный disabled выкидывает кнопку из Tab-порядка вместе с её подсказкой. Кольцо
// остаётся фокусируемым и честно объявляет недоступность через aria-disabled; обработчик
// ниже всё равно не запускает действие, пока нет сессии или идёт ход/сжатие.
const ctxRingDisabled = computed(() => !sess.value?.sessionId
  || !!sess.value?.compacting || !!sess.value?.sending);

/**
 * Клик по кольцу. Основное действие — СЖАТИЕ: агент пересказывает разговор сам и
 * продолжает с выжимки. Alt+клик оставлен под прежнее поведение кольца — полный сброс
 * памяти агента: путать эти два действия дорого (после сброса переписка на экране
 * остаётся, а агент не помнит ничего), поэтому у каждого свой вопрос и свой текст.
 */
async function onCtxClick(e) {
  const s = sess.value;
  if (!s?.sessionId || s.compacting || s.sending) return;
  if (e.altKey) {
    const ok = await confirmDialog(
      'Агент забудет весь разговор: следующее сообщение начнёт его с нуля. Переписка на экране останется, но вернуть агенту контекст будет уже нельзя.',
      { title: 'Сбросить память агента?', okText: 'Сбросить', danger: true },
    );
    if (ok) await chat.resetContext(props.sid);
    return;
  }
  const contextNow = ctxUnavailable.value
    ? 'Точный размер текущего контекста пока недоступен.'
    : `Сейчас в контексте ${fmtTokens(ctxTokens.value)} токенов.`;
  const ok = await confirmDialog(
    `${contextNow} Агент соберёт из разговора рабочую выжимку и продолжит с неё — что решили, чего касались, что осталось. Это полноценный ход: он займёт время и потратит токены один раз, зато каждый следующий ход станет дешевле.`,
    { title: 'Сжать контекст чата?', okText: 'Сжать' },
  );
  if (ok) chat.compact(props.sid);
}

// Сжатие или server-owned reset замораживают управление: менять модель/задачу/права
// посреди перехода нельзя. Поле ввода, вложения и диктовка остаются живыми; сама кнопка
// отправки ждёт завершения перехода.
const frozen = computed(() => !!sess.value?.compacting || !!sess.value?.sessionResetting);
const frozenHint = computed(() => (sess.value?.sessionResetting
  ? 'Сбрасывается память агента — отправка будет доступна после подтверждения сервера'
  : 'Идёт сжатие контекста — отправка будет доступна сразу после него'));

// ── «Прочитано» ──
// Открытый на экране чат читается сам: компонент рисуется ровно тогда, когда на чат
// смотрят на странице «Чаты». Ответ, пришедший в свёрнутую вкладку ОС,
// остаётся непрочитанным до возврата — поэтому слушаем ещё и visibilitychange.
function markRead() { if (!document.hidden) chat.markRead(props.sid); }
watch(() => [props.sid, sess.value?.unread], markRead, { immediate: true });
document.addEventListener('visibilitychange', markRead);
onUnmounted(() => document.removeEventListener('visibilitychange', markRead));

// ── Ввод ──
const input = ref(sess.value?.draft || '');
const body = ref(null);
function scrollDown() { if (body.value) body.value.scrollTop = body.value.scrollHeight; }

// ── Высота поля ввода ───────────────────────────────────────────────────────────
// Настройка устройства (localStorage, как ширина дока и списка чатов). Пусто =
// высоту решает CSS, как раньше.
const COMPOSER_KEY = 'cockpit-chat-composer-h';
// Минимум совпадает с CSS (`[data-role='chat-composer'] { min-height: 48px }`): иначе
// нижняя часть хода разделителя мертва — тянешь, число меняется, поле стоит.
const COMPOSER_MIN = 48;
// Потолок тот же, что в CSS (`max-height: 46vh`) — вторая цифра рядом с первой
// разъезжается, и разделитель снова получает мёртвый ход.
const COMPOSER_MAX_VH = 0.46;
const taEl = ref(null);

function storedComposerHeight() {
  try {
    const raw = Number(localStorage.getItem(COMPOSER_KEY));
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  } catch { return null; }
}
const composerH = ref(storedComposerHeight());
const composerStyle = computed(() => (composerH.value == null ? null : { '--composer-h': `${composerH.value}px` }));

function composerMax() {
  const view = typeof window === 'undefined' ? 0 : window.innerHeight;
  return Math.max(COMPOSER_MIN, Math.round((view || 720) * COMPOSER_MAX_VH));
}
function clampComposer(value) {
  return Math.round(Math.min(Math.max(COMPOSER_MIN, value), composerMax()));
}
// Тянем от ФАКТИЧЕСКОЙ высоты поля, а не от сохранённого числа: после смены окна
// (поворот планшета) CSS уже подрезал поле по 46vh, и старое число дало бы скачок.
function composerHeightNow() {
  const h = taEl.value?.el?.getBoundingClientRect?.().height;
  return clampComposer(h > 0 ? h : (composerH.value ?? COMPOSER_MIN));
}
function saveComposerHeight() {
  if (composerH.value == null) return;
  try { localStorage.setItem(COMPOSER_KEY, String(composerH.value)); } catch { /* приватный режим может запретить storage */ }
}

let composerPointer = null;
let composerFrom = null; // { y, h } на момент захвата
function startComposerResize(event) {
  if (event.button !== undefined && event.button !== 0) return;
  composerPointer = event.pointerId;
  event.currentTarget?.setPointerCapture?.(event.pointerId);
  composerFrom = { y: event.clientY, h: composerHeightNow() };
}
function moveComposerResize(event) {
  if (composerPointer !== event.pointerId || !composerFrom) return;
  // Вверх = выше: разделитель на верхней кромке поля, и поле растёт за курсором.
  composerH.value = clampComposer(composerFrom.h + (composerFrom.y - event.clientY));
}
function finishComposerResize(event) {
  if (composerPointer !== event.pointerId) return;
  composerPointer = null;
  composerFrom = null;
  event.currentTarget?.releasePointerCapture?.(event.pointerId);
  saveComposerHeight();
}
function cancelComposerResize(event) {
  if (composerPointer !== event.pointerId) return;
  composerPointer = null;
  composerFrom = null;
  event.currentTarget?.releasePointerCapture?.(event.pointerId);
  saveComposerHeight();
}
function onComposerResizeKey(event) {
  const step = event.shiftKey ? 48 : 16;
  if (event.key === 'ArrowUp') composerH.value = clampComposer(composerHeightNow() + step);
  else if (event.key === 'ArrowDown') composerH.value = clampComposer(composerHeightNow() - step);
  else if (event.key === 'Home') composerH.value = COMPOSER_MIN;
  else if (event.key === 'End') composerH.value = composerMax();
  else return;
  event.preventDefault();
  saveComposerHeight();
}
// Двойной клик — вернуть обычную CSS-высоту. Настройку стираем, а не пишем минимум,
// чтобы будущие изменения layout-default не перекрывались старым числом.
function resetComposerHeight() {
  composerH.value = null;
  try { localStorage.removeItem(COMPOSER_KEY); } catch { /* ignore */ }
}

// ── Автопрокрутка ──
// Едем вниз на всё новое (сообщения, шаги ленты, «думает…»), но ТОЛЬКО если пользователь
// и так внизу: отлистал историю вверх — не дёргаем, иначе читать невозможно.
const NEAR_BOTTOM_PX = 120;
const atBottom = ref(true);
function onBodyScroll() {
  const el = body.value;
  if (!el) return;
  atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
}
async function autoScroll() {
  if (!atBottom.value) return;
  await nextTick();
  scrollDown();
}
watch(() => [
  sess.value?.messages?.length,
  sess.value?.steps?.length,
  sess.value?.sending,
  chat.permFor(props.sid)?.pid,
  chat.questionFor(props.sid)?.pid,
], autoScroll);
// Переключение на другой чат: подставляем его черновик и — в конец истории.
watch(() => props.sid, async () => {
  input.value = sess.value?.draft || '';
  atBottom.value = true; // новый чат открываем в конце истории
  await nextTick();
  scrollDown();
});
// Набранный, но не отправленный текст живёт в чате (и на сервере): переключение чатов,
// перезагрузка страницы и второе окно его не теряют. Пишем с задержкой — не на каждую букву.
let draftTimer = null;
watch(input, (v) => {
  clearTimeout(draftTimer);
  const sid = props.sid;
  draftTimer = setTimeout(() => chat.setDraft(sid, v), 400);
});
// Уход со страницы/закрытие вкладки — дописываем черновик немедленно, дебаунс не успел бы.
function flushDraft() { clearTimeout(draftTimer); chat.setDraft(props.sid, input.value); }
window.addEventListener('beforeunload', flushDraft);
onUnmounted(() => { flushDraft(); window.removeEventListener('beforeunload', flushDraft); });
async function submit() {
  if (speechBusy.value) return;
  const t = input.value.trim();
  const atts = pending.value.slice();
  if ((!t && !atts.length) || !sess.value || frozen.value) return;
  // Точное имя пункта выполняем через его dispatch. `/`-команды провайдера идут
  // служебным ходом, `$skill` — обычным prompt; run:'none' остаётся обычным сообщением.
  // Сверка регистронезависимая — как в меню: имя навыка приходит от исполнителя.
  const exact = allCommands.value.find((c) => c.cmd.toLowerCase() === t.toLowerCase() && c.run !== 'none');
  if (exact) { runCommand(exact); return; }
  input.value = '';
  atBottom.value = true; // своё сообщение всегда показываем — как в мессенджерах
  // Черновик отправленного сообщения гасим сразу: дебаунс успел бы записать его
  // уже после отправки, и в списке чат остался бы «с черновиком».
  clearTimeout(draftTimer);
  chat.setDraft(props.sid, '');
  pending.value = [];
  const accepted = await chat.send(props.sid, t, atts);
  if (accepted === false) {
    input.value = t;
    pending.value = atts;
    chat.setDraft(props.sid, t);
  }
}

// Ход прерван перезапуском сервера или оборван самим CLI (сеть, лимит): сессия
// исполнителя цела (транскрипт CLI живёт на диске отдельно от кокпита), поэтому
// продолжение — обычное сообщение в ту же сессию. Текст называет причину по метке:
// агент должен сверить сделанное, а не переделывать с нуля.
const RESUME_TAIL = 'Продолжай с места остановки: сверь, что уже сделано, и доведи работу до конца.';
const RESUME_TEXT = Object.freeze({
  server_shutdown: `Сервер кокпита перезапустился, и твой ход был прерван. ${RESUME_TAIL}`,
  delivery_failure: 'Твой прошлый ход оборвал сам CLI (сеть или лимит), ответ до меня не дошёл. '
    + RESUME_TAIL,
});

/** Текст продолжения по метке прерывания; без известной метки продолжать нечего. */
function resumeTextFor(m) {
  const reason = m?.interruptedBy;
  return typeof reason === 'string' && Object.hasOwn(RESUME_TEXT, reason) ? RESUME_TEXT[reason] : '';
}

// Строка доставки реплики, приём которой сервер ещё не подтвердил, — по состоянию из
// стора. Без записи о доставке окно ещё сверяет реплику с сервером (после F5 или hello).
const DELIVERY_VIEWS = Object.freeze({
  posting: {
    text: '⏳ Отправляется…',
    tone: '',
    retry: false,
  },
  retrying: {
    text: '📡 Нет связи с сервером — повторяю отправку…',
    tone: 'warn',
    retry: false,
  },
  lost: {
    text: '⚠ Не доставлено: сервер не подтвердил приём.',
    tone: 'warn',
    retry: true,
  },
  checking: {
    text: '⏳ Проверяю доставку…',
    tone: '',
    retry: false,
  },
});

function deliveryView(m) {
  return DELIVERY_VIEWS[chat.deliveries[m.turnId]?.state] || DELIVERY_VIEWS.checking;
}

// Повтор идёт тем же turnId: если прежний запрос всё-таки дошёл, второго запуска не будет.
async function retryDelivery(m) {
  if (!sess.value || frozen.value) {
    return;
  }

  atBottom.value = true;
  await chat.retryDelivery(props.sid, m.turnId);
}

/** Кнопку показываем только у последнего сообщения и только свободному чату. */
function isResumeOffer(m, i) {
  if (!resumeTextFor(m)) return false;
  const messages = sess.value?.messages || [];
  if (i !== messages.length - 1) return false;
  return !sess.value?.sending && !sess.value?.compacting && !frozen.value;
}

async function resumeInterrupted() {
  if (!sess.value || frozen.value) return;
  const text = resumeTextFor(sess.value.messages?.at(-1));
  if (!text) return;
  atBottom.value = true;
  await chat.send(props.sid, text, []);
}
function onKey(e) {
  // Открыто меню команд — стрелки/Enter/Tab/Esc управляют им.
  // Навигация по выбираемым пунктам (cmdNav): заголовки и run:'none' пропускаются.
  const m = cmdNav.value;
  if (cmdMatches.value.length) {
    if (e.key === 'ArrowDown' && m.length) { e.preventDefault(); cmdIndex.value = (cmdIndex.value + 1) % m.length; return; }
    if (e.key === 'ArrowUp' && m.length) { e.preventDefault(); cmdIndex.value = (cmdIndex.value - 1 + m.length) % m.length; return; }
    if ((e.key === 'Enter' || e.key === 'Tab') && m.length) { e.preventDefault(); runCommand(m[Math.min(cmdIndex.value, m.length - 1)]); return; }
    if (e.key === 'Escape') { input.value = ''; return; }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); submit(); }
}

// ── Команды и навыки: «/» открывает CLI-команды, «$» — skills Codex ──
// Две секции: клиентские команды кокпита и команды CLI выбранной модели (провайдерский
// список приезжает в /api/providers, контракт — server/src/lib/executors/index.js).
const COMMANDS = [
  { cmd: '/compact', desc: 'Сжать контекст: агент пересказывает разговор и продолжает с выжимки', source: 'cockpit', run: 'local' },
  { cmd: '/clear', desc: 'Очистить историю и сбросить контекст агента', source: 'cockpit', run: 'local' },
  { cmd: '/reset', desc: 'Сбросить только контекст (история остаётся)', source: 'cockpit', run: 'local' },
  { cmd: '/new', desc: 'Открыть новый чат', source: 'cockpit', run: 'local' },
];
// Команды исполнителя текущей модели. Резолвер тот же, что у селекта модели: для
// legacy-чатов без modelRef провайдер достаётся из сохранённого id модели.
const providerInfo = computed(() => current.value.provider || null);
const providerCommands = computed(() => {
  const p = providerInfo.value;
  return (Array.isArray(p?.commands) ? p.commands : [])
    .map((c) => ({ ...c, source: p.id }));
});
// Объединённый список: команда кокпита глушит провайдерскую с тем же именем
// (/compact уже есть у кокпита — дубль не показываем, поведение не меняется).
const allCommands = computed(() => {
  const merged = [...COMMANDS];
  for (const c of providerCommands.value) {
    if (!merged.some((x) => x.cmd === c.cmd)) merged.push(c);
  }
  return merged;
});
const cmdIndex = ref(0);
const cmdMatches = computed(() => {
  const t = input.value.trimStart().toLowerCase();
  if (!/^[/$]/.test(t) || /[\s\n]/.test(t)) return [];
  // Имя навыка приходит от Codex и заглавные в нём законны (`$Review-Agent`),
  // поэтому сверяем в нижнем регистре: иначе такой пункт нельзя было бы найти.
  return allCommands.value.filter((c) => c.cmd.toLowerCase().startsWith(t));
});
// Навигация идёт только по выбираемым пунктам: заголовки секций и пункты run:'none'
// (команда живёт в TUI исполнителя) пропускаются стрелками и не выбираются Enter/кликом.
const cmdNav = computed(() => cmdMatches.value.filter((c) => c.run !== 'none'));
// Плоский список для рендера: заголовки секций + пункты с их индексом навигации.
const cmdMenu = computed(() => {
  const items = [];
  let nav = 0;
  const push = (c) => items.push({ ...c, key: `${c.source}:${c.cmd}`, nav: c.run === 'none' ? -1 : nav++ });
  const cockpit = cmdMatches.value.filter((c) => c.source === 'cockpit');
  const own = cmdMatches.value.filter((c) => c.source !== 'cockpit');
  if (cockpit.length) items.push({ header: 'Cockpit', key: 'h:cockpit' });
  cockpit.forEach(push);
  if (own.length) items.push({ header: providerInfo.value?.name || 'Исполнитель', color: providerInfo.value?.color || '', key: 'h:provider' });
  own.forEach(push);
  return items;
});
watch(cmdNav, (m) => { if (cmdIndex.value >= m.length) cmdIndex.value = 0; });
// Меню ограничено по высоте и скроллится — при навигации стрелками подгоняем
// выбранный пункт в видимую область.
const cmdMenuEl = ref(null);
watch(cmdIndex, async () => {
  await nextTick();
  cmdMenuEl.value?.querySelector('.cmd.on')?.scrollIntoView({ block: 'nearest' });
});
async function runCommand(command) {
  if (speechBusy.value) return;
  const c = typeof command === 'string'
    ? allCommands.value.find((x) => x.cmd === command)
    : command;
  if (!c || c.run === 'none') return;
  if (c.source !== 'cockpit') {
    // Провайдерская команда/навык. Гард тот же, что у submit():
    // пока чат заморожен (сжатие/reset), ничего не выполняем и ввод не трогаем.
    if (!sess.value || frozen.value) return;
    // Команда с обязательным аргументом не отправляется: подставляем в композер.
    if (c.args) {
      input.value = `${c.cmd} `;
      cmdIndex.value = 0;
      return;
    }
    // `$skill` — обычный model prompt: Codex сам раскрывает явное упоминание в
    // содержимое SKILL.md. `slashCommand` нужен только локальным `/`-командам CLI.
    // Вложения тоже уезжают только с навыком: у служебного хода их не бывает,
    // а «переделай вот эту картинку» — обычный сценарий $-навыка.
    const skill = c.cmd.startsWith('$');
    const atts = skill ? pending.value.slice() : [];
    input.value = '';
    cmdIndex.value = 0;
    clearTimeout(draftTimer);
    chat.setDraft(props.sid, '');
    if (skill) pending.value = [];
    const accepted = skill
      ? await chat.send(props.sid, c.cmd, atts)
      : await chat.send(props.sid, c.cmd, [], { slashCommand: c.cmd });
    // Как в submit(): отклонённая отправка не теряет ни набранное, ни вложения.
    if (accepted === false) {
      input.value = c.cmd;
      if (skill) pending.value = atts;
      chat.setDraft(props.sid, c.cmd);
    }
    return;
  }
  input.value = '';
  cmdIndex.value = 0;
  if (c.cmd === '/compact') {
    // Тот же путь, что у кольца: подтверждение обязательно — сжатие тратит ход агента.
    onCtxClick({ altKey: false });
  } else if (c.cmd === '/clear') {
    pending.value = [];
    chat.clearChat(props.sid);
    // Историю только что вычистили — плашка о сбросе осталась бы единственной записью.
    chat.resetContext(props.sid, { note: false });
  } else if (c.cmd === '/reset') {
    chat.resetContext(props.sid);
  } else if (c.cmd === '/new') {
    chat.newSession();
  }
}

// ── Вложения (фото): кнопка 📎 + вставка из буфера. Файл сразу уходит на сервер
// (chats/attachments/), к сообщению прикладывается ссылка — агент читает через Read. ──
const pending = ref([]); // [{ file, name, url, mime }]
const attachBusy = ref(false);
async function addFiles(files) {
  for (const f of files) {
    if (!f) continue;
    attachBusy.value = true;
    try {
      const fd = new FormData();
      fd.append('file', f, f.name || 'image.png');
      pending.value.push(await api.upload('/api/chat/upload', fd));
    } catch (e) {
      inputErr.value = `Загрузка: ${e.message}`;
    } finally { attachBusy.value = false; }
  }
}
function onPick(files) {
  addFiles(files);
}
function onPaste(e) {
  const imgs = [...(e.clipboardData?.items || [])].filter((i) => i.type.startsWith('image/'));
  if (!imgs.length) return;
  e.preventDefault();
  addFiles(imgs.map((i) => i.getAsFile()).filter(Boolean));
}
function removePending(i) { pending.value.splice(i, 1); }
function isImg(a) { return (a.mime || '').startsWith('image/'); }

// Drag&drop файлов на весь чат: счётчик enter/leave (leave стреляет на каждом
// дочернем элементе), оверлей-подсказка поверх.
const dragDepth = ref(0);
const dragOver = computed(() => dragDepth.value > 0);
function onDragEnter(e) { if (e.dataTransfer?.types?.includes('Files')) dragDepth.value++; }
function onDragLeave() { if (dragDepth.value > 0) dragDepth.value--; }
function onDrop(e) {
  dragDepth.value = 0;
  const files = [...(e.dataTransfer?.files || [])];
  if (files.length) addFiles(files);
}

// ── Диктовка: единый root-owned controller ──
// Компонент владеет только политикой composer-а: устойчивые куски дописывает в
// текущий draft, но terminal final сам не отправляет. TaskModal использует тот же
// controller для карточки ответа на вопрос триажа.
const inputErr = ref('');

function appendDictationText(text) {
  const piece = String(text || '').trim();
  if (!piece) return;
  const before = input.value;
  input.value = before ? before + (/\s$/.test(before) ? '' : ' ') + piece : piece;
}

const dictation = useDictationController();
const dictationLease = dictation.acquire(Symbol('chat-session'), {
  onCommit: appendDictationText,
  onFinal() {},
  onError(error) {
    inputErr.value = error?.message || 'Диктовка завершилась с ошибкой';
  },
});
const speechState = dictationLease.state;
const recording = computed(() => speechState.phase === 'recording');
const transcribing = computed(() => speechState.phase === 'transcribing');
const preparingSpeech = computed(() => speechState.phase === 'preparing');
const drainingSpeech = computed(() => speechState.phase === 'draining');
const interimSpeech = computed(() => speechState.interim || '');
const consentPending = computed(() => speechState.prompt === 'browser-consent');
const browserInstallPending = computed(() => speechState.prompt === 'browser-install');
const browserInstalling = computed(() => speechState.phase === 'installing');
const speechNotice = computed(() => speechState.notice || '');
const speechBusy = computed(() => speechState.busy);

function stopSpeech({ cancel = false } = {}) {
  if (cancel) return dictationLease.cancel();
  return dictationLease.stop();
}

function toggleMic() {
  inputErr.value = '';
  if (transcribing.value || drainingSpeech.value) return;
  if (speechBusy.value) {
    if (consentPending.value || browserInstallPending.value) {
      void stopSpeech({ cancel: true });
    } else {
      void stopSpeech();
    }
    return;
  }
  void dictationLease.start().catch((error) => {
    inputErr.value = error?.message || 'Не удалось запустить диктовку';
  });
}

function confirmBrowserConsent() {
  inputErr.value = '';
  void dictationLease.confirmBrowserConsent();
}
function useWhisperFromPrompt() {
  inputErr.value = '';
  void dictationLease.useWhisper();
}
function installBrowserLanguage() {
  inputErr.value = '';
  void dictationLease.installBrowserLanguage();
}

function onGlobalKey(e) {
  if (e.key === 'Escape' && speechBusy.value) {
    e.preventDefault();
    void stopSpeech({ cancel: true });
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyD' && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    toggleMic();
  }
}

watch(() => props.sid, () => {
  if (speechBusy.value) void stopSpeech({ cancel: true });
}, { flush: 'sync' });
onMounted(() => window.addEventListener('keydown', onGlobalKey));
onUnmounted(() => {
  void dictationLease.release();
  window.removeEventListener('keydown', onGlobalKey);
});
// ── Копирование сообщения (иконка при наведении) ──
const copiedIdx = ref(-1);
async function copyMsg(m, i) {
  const text = m.text || '';
  const copied = await writeClipboardText(text);

  if (!copied) {
    return;
  }

  copiedIdx.value = i;
  setTimeout(() => {
    if (copiedIdx.value === i) {
      copiedIdx.value = -1;
    }
  }, 1500);
}

// Как в мессенджере: в пузыре показываем только компактные часы и минуты, а полную
// локальную дату оставляем в подсказке и семантическом <time>. Старым сообщениям без
// sentAt время не придумываем — updatedAt относится ко всему чату, а не к запросу.
const messageTimeFormatter = new Intl.DateTimeFormat('ru-RU', {
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const messageDateTimeFormatter = new Intl.DateTimeFormat('ru-RU', {
  dateStyle: 'medium', timeStyle: 'short',
});
function validMessageTime(value) {
  const time = Number(value);
  return Number.isSafeInteger(time) && time > 0 ? time : 0;
}
function messageTime(value) {
  const time = validMessageTime(value);
  return time ? messageTimeFormatter.format(new Date(time)) : '';
}
function messageTimeTitle(value) {
  const time = validMessageTime(value);
  return time ? `Отправлено ${messageDateTimeFormatter.format(new Date(time))}` : '';
}
function messageTimeIso(value) {
  const time = validMessageTime(value);
  return time ? new Date(time).toISOString() : '';
}

// ── Спросы агента: разрешение на действие и вопрос (AskUserQuestion). Все висящие
// запросы лежат в сторе (приходят по SSE, после F5 — из /api/chat/waiting);
// берём адресованные этому чату. Висят, пока не ответишь: агент их ждёт. ──
const perm = computed(() => chat.permFor(props.sid));
const question = computed(() => chat.questionFor(props.sid));
function answerQuestion(payload) {
  if (question.value) void chat.answerQuestion(question.value.pid, payload);
}
function skipQuestion() {
  if (question.value) void chat.answerQuestion(question.value.pid, []);
}

// ── Действие «На конвейер» с защитой ──
const onConveyor = computed(() => chat.isOnConveyor(sess.value?.taskId));
const launchMsg = ref(null);
async function toConveyor() {
  const s = sess.value; if (!s?.taskId) return;
  if (onConveyor.value) { router.push('/pipeline'); return; }
  ui.openTaskLaunch(s.taskId);
  launchMsg.value = 'выбери маршрут и проверь параметры запуска в карточке задачи';
}

// Debug открывается отдельным разговором, но остаётся в worktree этой же задачи.
// Здесь только готовим черновик: ни отправки агенту, ни запуска конвейера по клику нет.
const DEBUG_HINT = 'Откроется отдельный Debug-чат в той же песочнице задачи. Новый конвейер не создаётся, черновик останется неотправленным.';
const debugOpening = ref(false);
const debugMsg = ref('');
const debugTaskTitle = computed(() => {
  const task = String(sess.value?.taskId || '');
  return taskOpts.value.find((o) => o.task === task)?.title || sess.value?.title || '';
});
function recentDebugContext(messages = []) {
  return messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && String(m.text || '').trim())
    .slice(-6)
    .map((m) => `${m.role === 'user' ? 'Пользователь' : 'Агент'}: ${String(m.text).trim()}`)
    .join('\n\n')
    .slice(-3000);
}
async function openDebug() {
  const s = sess.value;
  if (!s?.taskId || s.purpose === 'debug' || debugOpening.value) return;
  debugOpening.value = true;
  debugMsg.value = '';
  try {
    await chat.openDebugFor({
      taskId: s.taskId,
      taskTitle: debugTaskTitle.value,
      sourceChatId: s.id,
      context: recentDebugContext(s.messages),
    });
    await router.push('/chats');
  } catch (e) {
    debugMsg.value = `ошибка: ${e.message}`;
  } finally {
    debugOpening.value = false;
  }
}
</script>

<style scoped>
/* min-width: 0 обязателен: без него флекс-элемент не сжимается ниже min-content своего
   содержимого — одна длинная команда в ленте или во всплывашке раздувала всю колонку
   чата, и кнопки «Разрешить/Отклонить» уезжали за правый край экрана. */
.cs { display: flex; flex-direction: column; min-height: 0; min-width: 0; height: 100%; }

.col { width: 100%; min-width: 0; }

.cs-top { display: flex; flex-direction: column; gap: 4px; padding: 8px 22px; border-bottom: 1px solid var(--line);
  min-height: var(--chat-head-h); justify-content: center; }
/* На странице высота шапки — общий с левым списком токен, иначе две разделительные линии
   расходятся. min-height, а не height: редкое предупреждение о модели важнее ровной линии —
   пусть шапка подрастёт, чем текст обрежется. */
/* Ряд настроек на странице НЕ переносится: перенос — это плюс 30px к шапке и разъехавшиеся
   линии. Вместо переноса ряд ужимается (см. shrink у .factbar), а на узком экране страница
   и так уходит в одну колонку, где шапке разрешено расти. */
.hrow { display: flex; align-items: center; gap: 8px; min-width: 0; }
/* Назад к списку: на широком экране список виден всегда, кнопка нужна только на мобиле */
.back { display: none; flex: none; margin-left: -6px; place-items: center; }
/* Название чата — как заголовок карточки, рядом карандаш переименования */
.ttl { display: flex; align-items: center; gap: 3px; flex: 1 1 auto; min-width: 0; }
.ctitle { font-size: 15px; font-weight: 600; cursor: default; line-height: 1.3;
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Карандаш приглушён, пока не наводишь на шапку, но остаётся виден и доступен с клавиатуры. */
.tedit { flex: none; }
.ctitle-edit { width: 100%; }
.bar { display: flex; gap: 6px; align-items: center; flex-wrap: nowrap; }
.spacer { flex: 1; }
.sel { position: relative; }
/* На странице задача делит верхний ряд с названием чата: ей — правая половина, но
   ужимается она первой (название важнее). Полное название задачи доступно по ховеру
   в общем UiTooltip — внешний overflow страницы его не обрежет. */
.task-tip { flex: 0 1 420px; max-width: 520px; min-width: 150px; }
.sel.task { width: 100%; min-width: 0; }
/* Селект модели сжимаемый: ряд «модель + эффорт + кольцо» должен оставаться
   одним рядом, а не разъезжаться на три. */
.sel.model { flex: 0 1 140px; min-width: 84px; }
/* Строка состояния — не отдельная форма: у контролов нет своих коробок, только
   подпись-метка, значение и шеврон. Разделители — тонкие вертикальные линии. */
.sel { position: relative; display: flex; align-items: center; gap: 7px; padding: 0 2px; }
.sel .lbl { flex: none; font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em; color: var(--ink-mid); opacity: .75; }
/* Заморозка на время сжатия (см. frozen): селекты и кнопки выключены атрибутом, слайдеру
   усилия своего disabled не заводили — гасим его вместе с рядом действий. Композер не
   трогаем: печатать во время сжатия можно, нельзя только отправить. */
.cs.frozen .bar :deep(.eff), .cs.frozen .cs-act { opacity: .5; pointer-events: none; }

/* Кольцо контекста — маленькое, кликабельное (сжатие; Alt — сброс) */
.ctx-tip { flex: none; align-items: center; }

/* Форматированная подсказка кольца. Содержимое слота телепортируется UiTooltip в body,
   но сохраняет scope этого компонента, поэтому локальные стили работают и не текут. */
.ctx-pop { display: flex; flex-direction: column; gap: 7px; width: 260px; max-width: 100%; text-align: left; }
.ctx-pop-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
.ctx-pop-unit { color: var(--ink-mid); font-weight: 400; }
.ctx-pop-pct { color: var(--good); font-size: 13px; font-weight: 700; font-variant-numeric: tabular-nums; }
.ctx-pop-pct.warn { color: var(--warn); }
.ctx-pop-pct.bad { color: var(--bad); }
.ctx-pop-status { display: block; font-weight: 600; }
.ctx-pop-status.warn { color: var(--warn); }
.ctx-pop-status.bad { color: var(--bad); }
.ctx-pop-status.active { color: var(--accent); }
.ctx-pop-detail { display: block; color: var(--ink-mid); }
.ctx-pop-rows { display: flex; flex-direction: column; gap: 4px; padding-top: 7px; border-top: 1px solid var(--line); }
.ctx-pop-row { display: grid; grid-template-columns: minmax(76px, auto) minmax(0, 1fr); gap: 14px; align-items: baseline; }
.ctx-pop-label { color: var(--ink-mid); }
.ctx-pop-value { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.ctx-pop-row.cache .ctx-pop-value { white-space: normal; }
.ctx-pop-row.unverified .ctx-pop-value { color: var(--warn); }
.ctx-pop-actions { display: flex; flex-direction: column; gap: 3px; padding-top: 7px; border-top: 1px solid var(--line); color: var(--ink-mid); }
.ctx-pop-action { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 8px; }
.ctx-pop-action b { color: var(--ink); font-weight: 600; }

/* Воздух сверху/снизу — margin'ом самого скролл-контейнера (не паддингом:
   нижний паддинг при прокрутке до конца ненадёжен). Правый паддинг меньше
   на ширину скроллбара (11px, base.css) — края совпадают с композером.
   scrollbar-gutter: stable — место под скролл зарезервировано всегда, сообщения
   не «скачут» по горизонтали, когда полоса появляется/исчезает. */
.cs-body { flex: 1; overflow-y: auto; overflow-x: hidden; scrollbar-gutter: stable; padding: 0 11px 0 22px; margin: 26px 0; }
/* min-height 100% — пустое состояние центрируется */
.flow { display: flex; flex-direction: column; gap: 14px; min-height: 100%; }

/* Пустое состояние — по центру, а не подсказка в углу */
.empty { margin: auto; text-align: center; padding: 24px; }
.e-title { font-size: 17px; font-weight: 600; }
.e-sub { font-size: 13px; line-height: 1.6; margin-top: 8px; }

.msg { display: flex; flex-direction: column; gap: 4px; }
/* Текст + иконка копирования рядом (в потоке, не поверх текста). У пользовательских
   сообщений порядок обратный — иконка слева от пузыря. */
.mrow { display: flex; align-items: flex-end; gap: 6px; min-width: 0; }
.msg.user .mrow { flex-direction: row-reverse; }
.m-resume { margin-top: 8px; }
.msg .text { font-size: 14.5px; white-space: pre-wrap; line-height: 1.55; overflow-wrap: anywhere; min-width: 0; }
/* Ты — справа, пузырь с акцентом; роль ясна по стороне, лейблы не нужны */
.msg.user { align-self: flex-end; align-items: flex-end; max-width: min(78%, 720px); }
.msg.user .text { display: flow-root; background: color-mix(in srgb, var(--accent) 18%, transparent);
  padding: 9px 13px; border-radius: 14px 14px 4px 14px; }
/* Время запроса — внутри нижнего правого угла пузыря, как в Telegram: часы и минуты
   не спорят с текстом, полная дата доступна по наведению. */
.m-time { float: right; margin: .72em 0 0 9px; color: color-mix(in srgb, var(--ink-mid) 82%, transparent);
  font-size: 10px; font-weight: 400; line-height: 1; white-space: nowrap; user-select: none; }
/* Агент — слева, с подписью и акцентной полоской, текст маркдауном. Полоска и знак идут
   в цвете исполнителя этого хода (`--prov` ставит runBrandStyle); пока исполнитель
   неизвестен — переменной нет, и оба остаются нейтральными. */
.msg.assistant { align-self: stretch; padding-left: 13px;
  border-left: 2px solid color-mix(in srgb, var(--prov, var(--ink-mid)) 45%, transparent); }
.ahead { display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600;
  letter-spacing: .04em; text-transform: uppercase; color: var(--ink-mid); }
/* Знак берём чистым фирменным цветом, без подмешивания белого, как в списке чатов: там
   он лежит на своей заливке, здесь — прямо на `--surface`. Замер контраста к #151b24
   держит графический порог 3:1 у всех: claude 5.54, codex 5.41, kimi 3.24, ollama 9.43.
   Селектор ловит и svg, и кружок-фоллбэк: оба — корень ProviderIcon, scope-атрибут на них есть. */
.ahead svg, .ahead .fb { color: var(--prov, var(--ink-mid)); }
.ahead svg { width: 12px; height: 12px; }
/* Модель хода: факт из потока CLI либо честно помеченный запрос */
.amodel { font-weight: 400; text-transform: none; letter-spacing: 0; opacity: .75;
  font-family: var(--mono, monospace); font-size: 10.5px; }

/* Строка последнего хода — слева в ряду настроек (она и селект модели про одно и то же),
   поэтому ужимается многоточием: своим рядом она раздувала шапку и рвала выравнивание.
   shrink 100 — при нехватке места ряд отбирает ширину у неё, а не у селектов: подпись
   информационная, а контролами пользуются. */
.factbar { display: flex; align-items: center; gap: 8px; min-width: 0; overflow: hidden;
  flex: 0 100 auto; font-size: 11px; color: var(--ink-mid); }
.fb { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fb b { font-weight: 600; font-family: var(--mono, monospace); color: var(--ink); }
.fb.warn { color: var(--warn, #e0a33a); }
.fb.warn b { color: var(--warn, #e0a33a); }
/* Маркдаун ответа */
.text.md :deep(p) { margin: 0 0 8px; }
.text.md :deep(p:last-child) { margin-bottom: 0; }
.text.md :deep(h1), .text.md :deep(h2), .text.md :deep(h3),
.text.md :deep(h4), .text.md :deep(h5), .text.md :deep(h6) {
  margin: 14px 0 6px; font-size: 14px; line-height: 1.35; }
.text.md :deep(ul), .text.md :deep(ol) { margin: 4px 0 8px; padding-left: 20px; }
.text.md :deep(li) { margin: 2px 0; }
.text.md :deep(a) { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
.text.md :deep(a:hover) { color: color-mix(in srgb, var(--accent) 75%, white); }
.text.md :deep(blockquote) { margin: 6px 0 8px; padding: 2px 0 2px 10px;
  border-left: 2px solid var(--line); color: var(--ink-mid); }
.text.md :deep(code) { background: var(--surface-2); border-radius: 4px; padding: 1px 5px; font-size: 12px; }
.text.md :deep(pre) { background: var(--ground); border: 1px solid var(--line); border-radius: 8px;
  padding: 10px 12px; overflow-x: auto; margin: 6px 0 8px; }
.text.md :deep(pre code) { background: none; padding: 0; }
.text.md :deep(table) { display: block; max-width: 100%; overflow-x: auto;
  border-collapse: collapse; margin: 6px 0 8px; }
.text.md :deep(th), .text.md :deep(td) { border: 1px solid var(--line); padding: 5px 8px; text-align: left; }
.text.md :deep(th) { background: var(--surface-2); }
.text.md :deep(hr) { border: 0; border-top: 1px solid var(--line); margin: 10px 0; }
.text.md :deep(img) { display: block; max-width: min(100%, 760px); height: auto; border-radius: 8px; margin: 6px 0 8px;
  cursor: zoom-in; }
/* md-текст не pre-wrap (маркдаун сам управляет блоками) */
.msg.assistant .text.md { white-space: normal; }
/* Ошибка — компактная плашка по содержимому, а не баннер во всю ширину */
/* Обрыв связи — предупреждение, а не провал: цвет «внимание», не «ошибка». */
.msg.offline { align-self: flex-start; max-width: 80%; }
.msg.offline .text { background: color-mix(in srgb, var(--warn) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--warn) 30%, transparent); color: var(--muted); }
.msg.error { align-self: flex-start; max-width: 80%; }
.msg.error .text { background: color-mix(in srgb, var(--bad) 12%, transparent); border: 1px solid color-mix(in srgb, var(--bad) 30%, transparent);
  color: var(--bad); padding: 8px 12px; border-radius: 10px; font-size: 12.5px; }
.msg.error .text::before { content: '⚠ '; }

/* Служебная плашка самого кокпита (сжали контекст, сбросили память агента) — это не
   реплика: её не говорил ни агент, ни человек. Поэтому по центру, без пузыря и подписи. */
.msg.note { align-self: center; max-width: 90%; }
.msg.note .text { font-size: 12.5px; color: var(--ink-mid); background: var(--surface-2);
  border: 1px solid var(--line); border-radius: 10px; padding: 6px 12px; text-align: center; }

/* Запись истории не проходит — предупреждение поперёк всей ширины, над лентой:
   это не ошибка одного сообщения, а риск потерять весь разговор. */
.cs-act { padding: 8px 22px; border-top: 1px solid var(--line); }
.act-row { display: flex; align-items: center; gap: 10px; }
.lm { font-size: 12px; }

/* Вложения в сообщениях: картинка открывается в общем viewer-е, файл — как оригинал. */
.m-queued { font-size: 12px; color: var(--ink-mid); margin-bottom: 4px; }
.msg.user .m-queued { text-align: right; }
.m-delivery { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 8px;
  font-size: 12px; color: var(--ink-mid); margin-bottom: 4px; }
.m-delivery.warn { color: var(--warn); }
.m-atts { display: flex; gap: 8px; flex-wrap: wrap; }
.msg.user .m-atts { justify-content: flex-end; }
.m-atts img { max-width: 220px; max-height: 160px; border-radius: 10px; border: 1px solid var(--line); display: block;
  cursor: zoom-in; }
.m-file { font-size: 12.5px; color: var(--ink-mid); border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; display: inline-block; }
.m-atts a { text-decoration: none; }

/* position — опора для разделителя высоты поля (.cs-resize) */
.cs-input { position: relative; padding: 12px 22px 16px; border-top: 1px solid var(--line); }
/* Чипы вложений до отправки */
.pend { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 8px; }
.chip { display: flex; align-items: center; gap: 6px; background: var(--surface-2); border: 1px solid var(--line); border-radius: 8px; padding: 4px 6px; }
.chip img { width: 30px; height: 30px; object-fit: cover; border-radius: 5px; }
.chip .nm { font-size: 11.5px; color: var(--ink-mid); max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.in-err { margin-top: 6px; font-size: 12px; color: var(--bad); }
.speech-interim, .speech-note { font-size: 12px; color: var(--ink-mid); }
.speech-interim { margin-bottom: 6px; font-style: italic; }
.speech-note { margin-top: 6px; }
.speech-prompt { display: grid; gap: 9px; margin-bottom: 8px; padding: 11px 12px; border: 1px solid var(--line-2);
  border-radius: 11px; background: color-mix(in srgb, var(--accent) 8%, var(--surface)); font-size: 13px; }
.speech-prompt p { margin: 3px 0 0; color: var(--ink-mid); line-height: 1.4; }
.speech-actions { display: flex; flex-wrap: wrap; gap: 7px; }

/* Меню команд и навыков: якорится над композером */
.cs-input .col { position: relative; }
.cmd-menu { position: absolute; bottom: calc(100% + 8px); left: 0; right: 0; z-index: 6;
  background: var(--surface); border: 1px solid var(--line-2); border-radius: 12px; overflow: hidden;
  max-height: min(440px, 55vh); overflow-y: auto;
  box-shadow: 0 10px 30px rgba(0, 0, 0, .45); }
.cmd-head { display: flex; align-items: center; gap: 7px; padding: 7px 14px 4px; font-size: 11px;
  text-transform: uppercase; letter-spacing: .06em; color: var(--ink-mid); border-top: 1px solid var(--line); }
.cmd-head:first-child { border-top: none; }
.cmd-head .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.c-cmd { font-family: var(--mono, monospace); font-size: 13px; color: var(--accent); flex: none; }
.c-desc { font-size: 12.5px; color: var(--ink-mid); }
.c-hint { margin-left: auto; font-size: 11px; color: var(--ink-mid); flex: none; }

/* Оверлей drag&drop поверх всего чата */
.cs { position: relative; }
.drop-overlay { position: absolute; inset: 0; z-index: 5; background: color-mix(in srgb, var(--ground) 65%, transparent);
  display: grid; place-items: center; pointer-events: none; }
.drop-box { border: 2px dashed var(--accent); border-radius: 14px; padding: 18px 28px; font-size: 14px;
  color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); }

.composer { display: flex; gap: 6px; align-items: flex-end; background: var(--ground); border: 1px solid var(--line); border-radius: 12px; padding: 8px; }
.composer:focus-within { border-color: var(--line-2); }

/* Разделитель высоты поля ввода — на верхней кромке блока, поверх его линии
   (как разделитель дока): собственного места не занимает, включение ресайза
   ничего не сдвинуло. */
.cs-resize { position: absolute; left: 0; right: 0; top: -5px; height: 11px; z-index: 3;
  display: grid; place-items: center; cursor: row-resize; touch-action: none; outline: none; }
/* Ручка ярче и толще, чем у дока: она лежит поверх уже нарисованной границы блока,
   и `--line-2` на `--line` неотличим (проверено замером пикселей). */
.cs-resize span { width: 46px; height: 3px; border-radius: 999px;
  background: color-mix(in srgb, var(--ink-mid) 42%, transparent); transition: background .12s; }
.cs-resize:hover span, .cs-resize:focus-visible span { background: var(--accent); }

/* ── Планшет (до 1099): ряд настроек без подписей-меток ─────────────────────────
   Рядом со списком чату остаётся ~400px, и в такую ширину ряд влезает только так.
   Значение каждого контрола говорит само за себя (модель, режим, уровень), а полное
   название есть в подсказке по ховеру. Поля страницы тоже ужимаем. */
@media (max-width: 1099px) {
  .cs-top { padding: 8px 14px; }
  .cs-body { padding: 0 11px 0 14px; }
  .cs-act, .cs-input { padding-left: 14px; padding-right: 14px; }
  .task-tip { flex: 0 1 300px; }
  .sel.model .lbl, .sel.mode .lbl, .bar :deep(.eff .cap) { display: none; }
  .sel.model { flex: 0 1 118px; }
}

/* ── Планшет-портрет и телефон: список и чат делят одну колонку ──────────────────
   Порог 900, а не 760: в 400px, что остаётся чату рядом со списком, ряд настроек уже
   не помещается, а резать контролы хуже, чем показывать по одной колонке (так же
   ведут себя почтовики и мессенджеры на планшете в портрете). Строение шапки то же —
   ширины теперь хватает: колонка одна. */
@media (max-width: 899px) {
  .back { display: grid; }
  .task-tip { flex: 0 1 380px; }
}

/* ── Телефон: шапке разрешено расти ──────────────────────────────────────────────
   Выравнивать тут нечего (шапка на экране одна), а ряд контролов в 340px не влезает:
   название с задачей и настройки расходятся по своим рядам, поля — к минимуму. */
@media (max-width: 759px) {
  .cs-top { min-height: 0; justify-content: flex-start; padding: 8px 10px; }
  /* Переносится только задача: «назад» и название остаются одной строкой — иначе
     кнопка занимает целый ряд в одиночку и шапка съедает пятую часть экрана. */
  .hrow { flex-wrap: wrap; }
  .task-tip { flex: 1 1 100%; max-width: none; min-width: 0; }
  .bar { flex-wrap: wrap; }
  /* Факт-строка своим рядом — в одном ряду с контролами от неё осталось бы три буквы */
  .factbar { order: 9; flex: 1 1 100%; }
  .spacer { display: none; }
  .sel.model { flex: 1 1 0; }
  .sel.task .lbl { display: none; }
  :deep(.eff .track) { width: 62px; }
  .cs-body { padding: 0 0px 0 12px; margin: 18px 0; }
  .cs-act, .cs-input { padding-left: 12px; padding-right: 12px; }
  .cs-input { padding-bottom: 12px; }
  /* Иначе длинный текст режется в узкий столбик */
  .msg.user { max-width: 92%; }
  .msg .text { font-size: 14px; }
  .m-atts img { max-width: 62vw; }
}
</style>

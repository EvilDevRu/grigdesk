<template>
  <div v-if="sess" class="cs" :class="{ frozen, 'options-open': optionsOpen }" :style="composerStyle"
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
          v-tooltip="'К списку чатов'"
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
            <span class="ctitle" v-tooltip="chat.tabLabel(sess)">
              {{ chat.tabLabel(sess) }}
            </span>
            <!-- Единственная точка переименования доступна мышью, клавиатурой и touch. -->
            <UiIconButton
              class="tedit"
              role="embedded"
              label="Переименовать чат"
              v-tooltip="'Переименовать чат'"
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
                v-model="taskChoice"
                compact
                data-context="chat-session-toolbar"
                :disabled="frozen || sess.sending || sess.purpose === 'companion'"
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
        <ChatWorkdir :sid="sid" />
        <UiIconButton class="phone-options" role="rail" :label="t('core.conversationOptions')"
                      :pressed="optionsOpen" :aria-expanded="optionsOpen"
                      @click="optionsOpen = !optionsOpen">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
               stroke-linecap="round" aria-hidden="true">
            <path d="M4 7h16M4 17h16M8 4v6M16 14v6" />
          </svg>
        </UiIconButton>
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
                v-tooltip="'установленный CLI не знает эту модель — обнови его в настройках'">
            установленный CLI не знает эту модель — обнови его в настройках
          </span>
        </div>
        <div class="spacer"></div>
        <div class="sel model">
          <span class="lbl">модель</span>
          <UiSelect
            compact
            data-context="chat-session-toolbar"
            data-role="chat-model"
            :model-value="modelId"
            :disabled="frozen"
            v-tooltip="currentModelTitle" :aria-description="currentModelTitle"
            @change="onModelChange"
          >
            <option v-if="modelId && !currentModel" :value="modelId" disabled>
              {{ modelId }} — нет в реестре
            </option>
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
        <div v-if="modes.length || modeUnavailable" class="sel mode">
          <span class="lbl">режим</span>
          <UiSelect
            compact
            data-context="chat-session-toolbar"
            :model-value="currentMode"
            :disabled="frozen"
            v-tooltip="modeHint" :aria-description="modeHint"
            @change="chat.setMode(sid, ($event.target as HTMLSelectElement).value)"
          >
            <option v-for="m in modes" :key="m.id" :value="m.id" :title="m.hint">{{ m.label }}</option>
            <option v-if="!modeState.available" :value="currentMode" disabled>
              {{ currentMode }} · {{ t('core.chatModeUnavailable') }}
            </option>
          </UiSelect>
        </div>
        <EffortSlider v-if="effortLevels.length" :model-value="effortValue" :levels="effortLevels"
                      :hints="currentModel?.effortHints || {}"
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
          <div class="e-sub muted">
            <p class="e-workdir">
              Работаем в: {{ sess.workdirPreview?.target?.cwd
                || sess.workdirState?.committed?.cwd || chatWorkdirLabel(sess.workdir) }}
            </p>
            <p>
              Модель и усилие — сверху. Enter — отправить, Shift+Enter — перенос.
              «/» — команды, «$» — навыки Codex.
            </p>
          </div>
        </div>
        <div v-for="group in timelineGroups" :key="group.key" class="conversation-group"
             :class="{ turn: group.turn }" :style="group.brandStyle"
             :data-role="group.turn ? 'chat-turn' : undefined">
          <div v-for="{ key, message: m, index: i, steps, heading, compact, live, current, thinking } in group.rows"
               :key="key" class="msg" :class="[m.role, { compact }]"
               :style="m.role === 'assistant' ? group.brandStyle : null">
            <div v-if="m.attachments?.length" class="m-atts">
              <a v-for="a in m.attachments" :key="a.file" :href="api.url(a.url || '')" target="_blank" rel="noopener"
                 @click="onAttachmentClick($event, a)">
                <img v-if="isImg(a)" :src="api.url(a.url || '')" :alt="a.name" v-tooltip="a.name" />
                <span v-else class="m-file">📄 {{ a.name }}</span>
              </a>
            </div>
            <!-- Подпись агента: ответ визуально отличим от системных плашек и твоих пузырей.
                 Знак и цвет — исполнителя ИМЕННО ЭТОГО хода, а не вшитый Claude: ИИ меняют
                 посреди разговора, и прошлые ответы обязаны остаться за прежним. -->
            <div v-if="heading" class="ahead">
              <span class="ahead-mark">
                <ProviderIcon v-if="group.provider" :provider="group.provider" :size="12" />
              </span>
              <span>Агент</span>
              <span v-if="current && status.modelId" class="amodel">
                {{ status.modelLabel }} · {{ status.modelKind }}<template v-if="effortValue"> · {{ effortValue }}</template>
              </span>
              <span v-else-if="m.actualModel || m.model" class="amodel">
                {{ runModelLabel(m) }}<template v-if="!m.actualModel"> · запрошено</template><template v-if="m.effort"> · {{ m.effort }}</template>
              </span>
            </div>
            <div v-if="m.kind === 'in-turn'" class="m-delivery" data-role="chat-in-turn-delivery">
              {{ inTurnDeliveryText(m.receipt?.state, m.receipt?.error) }}
            </div>
            <!-- Действия стоят между репликами в порядке хода. После завершения
                 участки свёрнуты отдельно, а старт остаётся перед первым ответом. -->
            <StepList
              v-if="steps.length"
              :steps="steps"
              :model-label="modelLabelOf"
              :live="live"
              :section="group.turn"
              :chat-id="sid"
              @click="onMarkdownClick"
            />
            <div v-if="m.kind === 'assistant-block' && compact" class="agent-reply">
              <span class="reply-mark" role="img" aria-label="Ответ агента">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </span>
              <ChatInTurnReply :block="m" :chat-id="sid" :live="current" @click="onMarkdownClick" />
            </div>
            <div v-else-if="m.text || (m.role === 'user' && validMessageTime(m.sentAt))
                   || deliveryMark(m)" class="mrow"
                 :class="{ 'agent-reply': m.role === 'assistant' }">
              <span v-if="m.role === 'assistant'" class="reply-mark" role="img" aria-label="Ответ агента">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </span>
              <!-- Ответ агента — безопасный GFM; raw HTML экранируется в md.js -->
              <ChatMarkdown v-if="m.role === 'assistant'" :text="m.text || ''" :chat-id="sid"
                            @click="onMarkdownClick" />
              <div v-else class="text"><span v-if="m.text" class="m-copy">{{ m.text }}</span><span
                v-if="m.role === 'user' && (validMessageTime(m.sentAt) || deliveryMark(m)?.kind === 'pending')"
                class="m-meta">
                <time v-if="validMessageTime(m.sentAt)" class="m-time"
                  :datetime="messageTimeIso(m.sentAt)" v-tooltip="messageTimeTitle(m.sentAt)"
                  :aria-label="messageTimeTitle(m.sentAt)">{{ messageTime(m.sentAt) }}</time>
                <span v-if="deliveryMark(m)?.kind === 'pending'" class="m-pending" role="img"
                  data-role="chat-message-pending" :aria-label="deliveryMark(m)?.label"
                  v-tooltip="deliveryMark(m)?.label">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                       stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <template v-if="deliveryIcon(m) === 'offline'">
                      <line x1="1" y1="1" x2="23" y2="23" />
                      <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
                      <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
                      <path d="M10.71 5.05A16 16 0 0 1 22.58 9" />
                      <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
                      <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
                      <line x1="12" y1="20" x2="12.01" y2="20" />
                    </template>
                    <template v-else>
                      <circle cx="12" cy="12" r="9" />
                      <polyline points="12 7 12 12 15 14" />
                    </template>
                  </svg>
                </span>
              </span></div>
              <!-- Сервер не подтвердил приём: значок у пузыря, как в Telegram. Повтор идёт тем же
                   turnId, поэтому дошедшее всё-таки сообщение второй раз агента не запустит. -->
              <UiIconButton
                v-if="deliveryMark(m)?.kind === 'failed'"
                :label="`${deliveryMark(m)?.label}. Повторить отправку`"
                v-tooltip="`${deliveryMark(m)?.label}. Нажмите, чтобы повторить отправку`"
                data-context="chat-delivery-retry"
                :disabled="frozen"
                @click="confirmRetryDelivery(m)"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" />
                  <line x1="12" y1="7.5" x2="12" y2="12.5" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              </UiIconButton>
              <UiIconButton
                v-if="m.text"
                class="copy"
                :class="{ done: copiedIdx === i }"
                role="stepper"
                :label="copiedIdx === i ? 'Скопировано' : 'Копировать сообщение'"
                v-tooltip="copiedIdx === i ? 'Скопировано' : 'Копировать сообщение'"
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
                size="compact"
                data-role="chat-resume-interrupted"
                @click="resumeInterrupted"
              >
                ▶ Продолжить ход
              </UiButton>
            </div>
            <!-- Индикатор остаётся последней строкой запуска внутри ленты.
                 Модель, папка и лимиты дополняют ту же линию только справа. -->
            <ChatStatusBar v-if="thinking" :chat-key="sid" :status="status" :usage="statusUsage"
                           :steps="sess.steps" :tokens="sess.progressTokens"
                           :tokens-estimate="sess.progressTokensEstimate" :started-at="sess.turnStartedAt" />
          </div>
        </div>
        <ChatStatusBar v-if="status.phase === 'compact'"
                       :chat-key="sid" :status="status" :usage="statusUsage" />
        <!-- Связь этого окна с сервером оборвалась посреди хода. Сам ход при этом идёт:
             он живёт в процессе сервера, а не во вкладке, и ответ вернётся через
             chats/pending. Плашка ЛОКАЛЬНАЯ (поле offline в историю не едет) — порвалось
             у этого окна, другим устройствам показывать нечего. -->
        <div v-if="sess.offline" class="msg offline">
          <div class="text">📡 Связь с сервером прервалась — ход продолжается, ответ появится, когда связь вернётся.</div>
        </div>
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
                    @answer="(allow, remember, comment, choice) => chat.answerPerm(perm!.pid, allow, remember, comment, choice)" />

    <!-- Ввод: единый композер, кнопки внутри (📎 фото, 🎤 диктовка) -->
    <div class="cs-input">
      <!-- Разделитель высоты поля ввода: стоит на верхней кромке (поверх линии),
           поэтому места в раскладке не занимает и ничего не сдвигает. -->
      <div class="cs-resize" role="separator" aria-orientation="horizontal" tabindex="0"
           aria-label="Высота поля ввода"
           :aria-valuemin="COMPOSER_MIN" :aria-valuemax="composerMax()"
           :aria-valuenow="Math.round(composerH ?? COMPOSER_MIN)"
           v-tooltip="'Потяни — высота поля ввода. Двойной клик — вернуть обычную'"
           @pointerdown.prevent="startComposerResize" @pointermove.prevent="moveComposerResize"
           @pointerup.prevent="finishComposerResize" @pointercancel.prevent="cancelComposerResize"
           @dblclick="resetComposerHeight" @keydown="onComposerResizeKey">
        <span></span>
      </div>
      <div class="col">
        <!-- Чипы ещё не отправленных вложений -->
        <div v-if="pending.length || attachBusy" class="pend">
          <div v-for="(a, i) in pending" :key="a.file" class="chip">
            <UiButton
              v-if="isImg(a)"
              variant="text"
              size="compact"
              data-context="chat-pending-preview"
              v-tooltip="a.name"
              @click="onAttachmentClick($event, a)"
            >
              <template #leading>
                <img :src="api.url(a.url || '')" :alt="a.name" aria-hidden="true" />
              </template>
              <span class="nm">{{ a.name }}</span>
            </UiButton>
            <span v-else class="nm">{{ a.name }}</span>
            <UiIconButton
              class="x"
              role="stepper"
              label="Убрать вложение"
              v-tooltip="'Убрать'"
              data-context="chat-pending-remove"
              @click="removePending(i)"
            >
              ×
            </UiIconButton>
          </div>
          <UiSpinner v-if="attachBusy" decorative />
        </div>
        <!-- Меню команд/навыков над композером: секция GrigDesk + секция исполнителя модели -->
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
            v-tooltip="'Приложить файл (или перетащи/вставь из буфера)'"
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
          <!-- Одна кнопка отправляет текст в активный ход, если его канал готов,
               иначе ставит сообщение в очередь. Остановка остаётся отдельным действием. -->
          <UiIconButton
            v-if="sess.sending || sess.compacting"
            class="send stop"
            role="peer"
            variant="solid"
            tone="danger"
            :disabled="sess.stopping"
            :label="sess.stopping ? 'Останавливаю…'
              : sess.compacting ? 'Прервать сжатие контекста' : 'Остановить агента'"
            v-tooltip="sess.stopping ? 'Останавливаю…'
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
            :disabled="frozen || speechBusy || modeUnavailable || (!input.trim() && !pending.length)"
            :label="modeUnavailable ? t('core.chatModeUnavailable') : speechBusy ? 'Сначала заверши диктовку'
              : frozen ? frozenHint
              : sess.sending ? (inTurnComposer.ready
                ? 'Уточнить сейчас (Enter)' : 'Отправить после текущего хода (Enter)')
              : 'Отправить (Enter)'"
            v-tooltip="modeUnavailable ? t('core.chatModeUnavailable') : speechBusy ? 'Сначала заверши диктовку'
              : frozen ? frozenHint
              : sess.sending ? (inTurnComposer.ready
                ? 'Уточнить сейчас (Enter)' : 'Отправить после текущего хода (Enter)')
              : 'Отправить (Enter)'"
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

<script setup lang="ts">
import ChatWorkdir from './ChatWorkdir.vue';
import { chatWorkdirLabel } from '../../../../shared/chat/chatWorkdir.ts';
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { api } from '../../shared/apiClient.ts';
import { errorMessage } from '../../../../shared/lib/errors.ts';
import { decodeChatAttachment } from '../../shared/chatContracts.ts';
import { resolvePermissionMode } from '../../shared/chatPermissionMode.ts';
import { decodePipelineTasks } from '../../shared/pipelineContracts.ts';
import type {
  ChatAttachment, HistoryAttachment, ChatMessage, ContextCache,
} from '../../shared/chatContracts.ts';
import type { PipelineTask } from '../../shared/pipelineContracts.ts';
import type { ProviderEntry, ProviderModelEntry } from '../../../../shared/chat/providersContracts.ts';

import { useDictationController } from '../../features/speech/provider.ts';
import { useChatStore, CONTEXT_WINDOW } from '../../stores/chat.ts';
import { contextFill } from '../../../../shared/chat/chatContext.ts';
import { writeClipboardText } from '../../shared/clipboard.ts';
import { useTasksStore } from '../../stores/tasks.ts';
import { useProvidersStore } from '../../stores/providers.ts';
import EffortSlider from './EffortSlider.vue';
import StepList from './StepList.vue';
import ChatInTurnReply from './ChatInTurnReply.vue';
import { inTurnComposerState, inTurnDeliveryText } from './chatInTurn.ts';
import { createChatTimelineProjector, groupChatTimeline } from './chatTimeline.ts';
import ChatStatusBar from './ChatStatusBar.vue';
import { messageDeliveryMark } from './messageDeliveryMark.ts';
import { chatStatus } from './chatStatus.ts';
import { providerUsageSummary } from '../../features/providers/providerUsageSummary.ts';
import { providerUsageFreshness } from '../../../../shared/chat/providerUsageFreshness.ts';
import ChatQuestion from './ChatQuestion.vue';
import ChatPermission from './ChatPermission.vue';
import ProviderIcon from '../../shared/ProviderIcon.vue';
import {
  confirmDialog,
  t,
  UiButton,
  UiFilePicker,
  UiIconButton,
  UiInput,
  UiSelect,
  UiSpinner,
  UiTextarea,
  UiTooltip,
  vTooltip,
} from '../../ui';
import ChatMarkdown from './ChatMarkdown.vue';
import { documentLinkFromClick } from '../../features/documents/links.ts';
import { codeLinkFromClick, loadCodeRoots } from '../../features/code/links.ts';
import { useToolLauncher } from '../../shared/tools/launcher.ts';
import { useDocumentPreviewStore } from '../../stores/documentPreview.ts';
import { lastModelRun, modelRunView } from '../../shared/chatModelRun.ts';

// Полноразмерная сессия на единственной странице «Чаты».
const props = defineProps({
  sid: { type: String, required: true },
});
// back — «назад к списку чатов»: кнопка живёт в шапке, но видна только на узком экране,
// где список и чат делят одну колонку (показом управляет CSS, не JS).
const emit = defineEmits<{ back: [] }>();
const optionsOpen = ref(false);

const chat = useChatStore();
const tasks = useTasksStore();
const documentPreview = useDocumentPreviewStore();
const { openTool } = useToolLauncher();
// Карта деревьев репозиториев для моста «ссылка на файл кода → панель „Код“».
// Пока она не приехала (или плагин «Код» выключен), такие ссылки честно рендерятся
// текстом; резолвер читает реактивный ref, поэтому лента дорисуется сама.
loadCodeRoots();


/**
 * Открывает изображение, документ или файл кода по обычному клику в ленте.
 * Модифицированные клики сохраняют стандартное поведение браузера.
 */
function onMarkdownClick(event: MouseEvent) {
  if (!isPlainClick(event)) {
    return;
  }

  const image = (event.target instanceof Element ? event.target.closest('img') : null);

  if (image) {
    event.preventDefault();
    documentPreview.showImage({
      src: image.currentSrc || image.getAttribute('src') || '',
      name: image.getAttribute('alt') || image.getAttribute('title') || 'Изображение',
      mime: '',
    }, feedImages(image));

    return;
  }

  const href = documentLinkFromClick(event);

  if (href) {
    event.preventDefault();
    documentPreview.show(href);

    return;
  }

  const codeTarget = codeLinkFromClick(event);

  if (!codeTarget) {
    return;
  }

  event.preventDefault();
  openTool('code', { type: 'open-file', ...codeTarget });
}

function isPlainClick(event: MouseEvent) {
  return event?.button === 0
    && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/**
 * Картинка-вложение открывается с соседними картинками ленты или черновика.
 * Клики по файлам и клики с модификаторами сохраняют поведение исходного элемента.
 */
function onAttachmentClick(event: MouseEvent, attachment: HistoryAttachment) {
  if (!isImg(attachment) || !isPlainClick(event)) {
    return;
  }

  event.preventDefault();
  documentPreview.showImage({
    src: api.url(attachment.url || ''),
    name: attachment.name || '',
    mime: attachment.mime || '',
  }, event.currentTarget instanceof Element ? feedImages(event.currentTarget) : []);
}

/**
 * Собирает картинки в порядке показа для стрелок просмотра внутри ленты или черновика.
 * Область ищется от нажатого элемента: неотправленные вложения не смешиваются с историей.
 */
function feedImages(target: Element) {
  const feed = target.closest('.pend') || target.closest('.conversation-group')?.parentElement;
  const images = feed?.querySelectorAll<HTMLImageElement>('.conversation-group img, .pend img');

  return images ? [...images].map((item) => ({
    src: item.currentSrc || item.getAttribute('src') || '',
    name: item.getAttribute('alt') || item.getAttribute('title') || '',
  })) : [];
}

// Архивный разговор открывается для чтения прямо из архива. Отправка сообщения
// сама перенесёт тот же объект в активные (stores/chat.ts), отдельной копии нет.
const sess = computed(() => chat.sessions.find((s) => s.id === props.sid)
  || (chat.archived || []).find((s) => s.id === props.sid)
  || null);
const runtime = computed(() => chat.runtimeFor?.(props.sid) || null);
const inTurnRun = computed(() => chat.inTurnFor?.(props.sid) || null);
const inTurnComposer = computed(() => inTurnComposerState({
  run: inTurnRun.value,
  protocol: chat.inTurnProtocol,
  capability: current.value.provider?.inTurn,
  pendingCount: pending.value.length,
  pendingImages: pending.value.every(isImg),
  text: input.value,
}));
const timelineProjector = createChatTimelineProjector();
const timeline = computed(() => timelineProjector.project(
  sess.value?.messages || [],
  sess.value?.steps || [],
  ['running', 'legacy', 'background'].includes(status.value.phase),
  inTurnRun.value,
  runtime.value?.active ? runtime.value.runId : '',
));

watch(() => props.sid, () => timelineProjector.clear(), { flush: 'sync' });
onUnmounted(() => timelineProjector.clear());

const timelineGroups = computed(() => groupChatTimeline(timeline.value).map((group) => {
  const provider = group.current ? liveProvider.value : runProvider(group.agent);

  return {
    ...group,
    provider,
    brandStyle: provider?.color ? { '--prov': provider.color } : null,
  };
}));

// ── Название чата в шапке страницы «Чаты» ──
const editingTitle = ref(false);
const titleVal = ref('');
const titleEl = ref<InstanceType<typeof UiInput> | null>(null);


/**
 * Открывает редактор с фактической подписью текущего чата.
 * Фокус и выделение устанавливаются после появления поля в DOM.
 */
async function startTitleEdit() {
  titleVal.value = chat.tabLabel(sess.value || {});
  editingTitle.value = true;
  await nextTick();
  titleEl.value?.focus();
  titleEl.value?.select();
}

function commitTitle() {
  if (editingTitle.value) {
    chat.setTitle(props.sid, titleVal.value.trim());
  }

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
const status = computed(() => {
  const view = chatStatus(sess.value || { id: props.sid }, runtime.value, {
    providerId: current.value.provider?.id || sess.value?.modelRef?.provider || '',
    modelId: current.value.id,
    modelLabel: current.value.model?.name || current.value.id,
  });

  if (view.providerId && view.modelId) {
    view.modelLabel = prov.modelOf({ provider: view.providerId, model: view.modelId }).model?.name
      || view.modelLabel;
  }

  return view;
});
const usageNow = ref(Date.now());
let usageResetTimer: ReturnType<typeof setTimeout> | null = null;

const statusUsage = computed(() => providerUsageSummary(
  status.value.providerId,
  prov.usage?.[status.value.providerId],
  prov.usageTransport,
  !!prov.providers.find((provider) => provider.id === status.value.providerId),
  usageNow.value,
));

/**
 * Один таймер на ближайший сброс помечает сохранённый замер устаревшим без опроса API.
 * Часы принадлежат компоненту: смена данных переставляет таймер, размонтирование снимает его.
 */
function scheduleUsageReset() {
  if (usageResetTimer !== null) {
    clearTimeout(usageResetTimer);
    usageResetTimer = null;
  }

  usageNow.value = Date.now();

  const future = statusUsage.value.windows
    .map((item) => item.resetsAt ? Date.parse(item.resetsAt) : NaN)
    .filter((at) => Number.isFinite(at) && at > usageNow.value);
  const freshness = providerUsageFreshness(prov.usage?.[status.value.providerId], usageNow.value);

  if (freshness.enabled && freshness.expiresAt !== null && freshness.expiresAt >= usageNow.value) {
    future.push(freshness.expiresAt + 1);
  }

  const nearest = Math.min(...future);

  if (Number.isFinite(nearest)) {
    usageResetTimer = setTimeout(scheduleUsageReset, Math.min(2147483647, nearest - usageNow.value + 1));
  }
}

watch([
  () => status.value.providerId,
  () => prov.usage?.[status.value.providerId],
], scheduleUsageReset, {
  immediate: true,
});
onUnmounted(() => {
  if (usageResetTimer !== null) {
    clearTimeout(usageResetTimer);
    usageResetTimer = null;
  }
});

const modelId = computed(() => current.value.id);
const effortValue = computed(() => sess.value?.effort || '');
const currentModel = computed(() => current.value.model);
const fmtTokens = (value: unknown) => Math.max(0, Number(value) || 0).toLocaleString('ru');

/**
 * Каталог Codex намеренно не сообщает окно. Для выбранной модели точнее всего замер
 * живой thread; до него вместо паспортной или сохранённой заглушки показываем источник
 * будущего факта. Остальные исполнители сохраняют прежний каталожный контракт.
 */
function modelContextTitle(model: ProviderModelEntry | null, label: string) {
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
    + (model?.contextUnverified ? ' · окно не подтверждено' : '');
}

const currentModelTitle = computed(() => (
  currentModel.value ? modelContextTitle(currentModel.value, currentModel.value.name) : 'Модель'
));
// Подсказка пункта: окно модели и оговорки каталога. Недоступность исполнителя
// названа здесь же и словами: она предупреждает о вероятном отказе, но выбор не отменяет.
const modelOptionTitle = (
  model: ProviderModelEntry, provider: { available?: boolean } | null,
) => modelContextTitle(model, model.id)
  + (model.unknown ? ' · нет в каталоге установленного CLI' : '')
  + (provider?.available === false ? ' · исполнитель недоступен по последней проверке' : '');
const modelOptionLabel = (model: ProviderModelEntry) => model.name
  + (model.contextUnverified && !model.contextRuntimeOnly ? ' · окно не подтверждено' : '')
  + (model.unknown ? ' ?' : '');
// Группы моделей для селекта (что именно видно — решает стор, правило одно на весь GrigDesk).
const provGroups = computed(() => prov.providers
  .map((p) => ({ ...p, models: prov.visibleModels(p, modelId.value) }))
  .filter((p) => p.models.length));
const FALLBACK_MODELS = ['opus', 'sonnet', 'haiku', 'fable']; // пока реестр не загрузился
const effortLevels = computed(() => currentModel.value?.efforts || []);
// Режимы прав исполнителя (список даёт его CLI). Пока чат не выбрал свой — показываем
// «вручную»: именно так работает чат по умолчанию (спрашивает разрешение на действия).
const modes = computed(() => prov.modesOf(sess.value?.modelRef || sess.value?.model));
const modeState = computed(() => resolvePermissionMode(sess.value?.mode, modes.value,
  prov.modelOf(sess.value?.modelRef || sess.value?.model).provider
    || { permissionModeSelectionPolicy: 'preserve-explicit' },
  sess.value?.modeSelection, sess.value?.id));
const currentMode = computed(() => modeState.value.mode);
const modeUnavailable = computed(() => !modeState.value.available
  && prov.modelOf(sess.value?.modelRef || sess.value?.model).provider
    ?.permissionModeSelectionPolicy === 'preserve-explicit');
const activeModeLabel = computed(() => (
  modes.value.find((mode) => mode.id === runtime.value?.snapshot?.permissionMode)?.label
    || runtime.value?.snapshot?.permissionMode || '…'
));
const modeHint = computed(() => (
  !modeState.value.available ? t('core.chatModeUnavailable')
    : `${modes.value.find((m) => m.id === currentMode.value)?.hint || 'Режим прав агента'}${
      sess.value?.sending ? ` ${t('core.chatModeCurrent', { mode: activeModeLabel.value })} ${
        t('core.chatModeNextTurn')}` : ''}`
));
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
function runModelId(message: ChatMessage) {
  const id = message.model || message.actualModel || '';

  return typeof id === 'string' ? id : '';
}

// Модель хода → исполнитель. Считаем разом по всей переписке: modelOf ходит по всему
// реестру, а из шаблона он звался бы на каждый рендер каждого сообщения.
const runProviders = computed(() => {
  const map = new Map();

  for (const message of sess.value?.messages || []) {
    const id = message?.role === 'assistant' ? runModelId(message) : '';

    if (!id || map.has(id)) {
      continue;
    }

    const found = prov.modelOf(id);

    map.set(id, { provider: found.provider || null, label: found.model?.name || id });
  }

  return map;
});

// Подпись модели для человека: имя из каталога (`Opus 5`, `DeepSeek-V4-Flash`), а не
// машинный id. У DeepSeek id — opaque JSON-массив, и без каталога шапка чата и шаг
// «старт» показывали его как есть. Незнакомый реестру id остаётся сырым: он всё ещё
// обязан называть, чем отвечали.
function modelLabelOf(id: unknown) {
  if (!id) {
    return '';
  }

  const found = prov.modelOf(id);

  return found.model?.name || found.id || String(id);
}

/** Подпись модели готового ответа: факт из потока или запрошенная, но именем из каталога. */
function runModelLabel(message: ChatMessage) {
  const id = runModelId(message);

  return runProviders.value.get(id)?.label || id;
}

/**
 * Исполнитель конкретного ответа: знак и цвет шапки берутся из модели ЭТОГО хода, а не
 * из селекта сессии — иначе смена ИИ задним числом переписывает всю прошлую переписку.
 * Незнакомую реестру модель оставляем без знака: чужой фирменный знак хуже, чем никакого.
 */
function runProvider(message: ChatMessage) {
  if (message?.role !== 'assistant') {
    return null;
  }

  return runProviders.value.get(runModelId(message))?.provider || null;
}

// Исполнитель работающего запуска берётся из его серверного снимка.
// Смена выбора следующего хода не перекрашивает уже идущую линию и её шапку.
const liveProvider = computed(() => (
  prov.providers.find((provider) => provider.id === status.value.providerId) || null
));

// Последний завершённый ход с моделью. Claude сообщает `actualModel` из потока,
// Codex JSONL пока его не отдаёт — у него честно показываем «запрошено», иначе
// поиск последнего непустого факта откатывался к старому Claude-ответу.
const lastRun = computed(() => lastModelRun(sess.value?.messages || []));
const lastRunView = computed(() => modelRunView(lastRun.value));
const lastRequestedName = computed(() => {
  const id = lastRun.value?.model;

  return id ? (prov.modelOf(id).model?.name || id) : '';
});

/**
 * Смена исполнителя требует сбросить несовместимую сессию или server-owned binding.
 * У сохранённого чата без адаптера могла остаться память и seed даже без sessionId.
 */
function requiresContextReset(nextModelId: string) {
  const session = sess.value;
  const oldProvider = current.value.provider;
  const oldProviderId = oldProvider?.id || session?.modelRef?.provider;
  const nextProviderId = prov.modelOf(nextModelId).provider?.id;

  if (!oldProviderId || !nextProviderId || oldProviderId === nextProviderId) {
    return false;
  }

  return Boolean(session?.sessionId)
    || oldProvider?.sessionBinding === true
    || (!oldProvider && (session?.revision || 0) > 0);
}

/**
 * Смена исполнителя подтверждает сброс прежней памяти до записи новой модели.
 * Отказ сервера возвращает селект к прежней паре и сохраняет историю и память.
 */
async function onModelChange(e: Event) {
  // Reset Kimi асинхронный и на время запроса перерисовывает select со старой моделью.
  // Поэтому выбранный id надо снять с DOM до await, иначе после подтверждения здесь
  // снова окажется K3 и визуально успешный reset отменит саму смену модели.
  const select = e.target as HTMLSelectElement;
  const nextModelId = select.value;

  const hasTurns = sess.value?.messages.some((message) => (
    message.role === 'user' || message.role === 'assistant'
  )) || false;

  if (requiresContextReset(nextModelId) && !await chat.resetContext(props.sid, { note: hasTurns })) {
    select.value = modelId.value;

    return;
  }

  chat.setModel(props.sid, nextModelId);
}

// Реестр загружается асинхронно и может обновиться уже после открытия чата.
// Когда он принёс достоверный список, старое неподдерживаемое значение не сохраняем.
watch(effortLevels, (levels) => {
  if (sess.value?.effort && levels.length && !levels.includes(sess.value.effort)) {
    chat.setEffort(props.sid, '');
  }
}, { immediate: true });

// ── Список задач для селекта (с ЗАГОЛОВКАМИ, не только номером) ──
let taskListPromise: Promise<PipelineTask[]> | null = null;

function fetchTaskList() {
  if (!taskListPromise) {
    taskListPromise = api.get('/api/tasks')
      .then((r) => decodePipelineTasks(r).tasks || [])
      .catch(() => []);
  }

  return taskListPromise;
}

const taskOpts = ref<Array<{
  task: string;
  route: unknown;
  title: string;
}>>([]); // [{ task, route, title }]

onMounted(async () => {
  // При открытии — сразу в конец истории
  await nextTick();
  scrollDown();

  const list = await fetchTaskList();

  taskOpts.value = list.map((t) => ({
    task: String(t.task),
    route: t.route,
    title: '',
  }));
  // Подтягиваем названия из B24 (для «#<TASK> · Название задачи…»).
  list.forEach((t) => tasks.load(t.task).then((d) => {
    const o = taskOpts.value.find((x) => x.task === String(t.task));

    if (o && d?.title) {
      o.title = d.title;
    }
  }).catch(() => {}));
});

function optLabel(o: {
  task: string;
  title: string;
  route?: unknown;
}) {
  return `#${o.task} · ${o.title || o.route || 'задача'}`;
}

const activeTaskLabel = computed(() => {
  const id = String(sess.value?.taskId || '');

  if (!id) {
    return 'Без привязки к задаче';
  }

  const option = taskOpts.value.find((o) => o.task === id);

  return option ? optLabel(option) : `#${id}`;
});
// Селект задачи показывает фактическую привязку чата. Смена задачи идёт через переход
// рабочей папки: пока он ждёт решения в окне выбора или получил отказ, селект
// возвращается к записи чата, а не к выбору, которого у чата нет.
const taskChoice = ref('');

watch(() => sess.value?.taskId || '', (taskId) => {
  taskChoice.value = String(taskId);
}, { immediate: true });

/**
 * Выбор задачи в селекте — просьба о переходе, а не готовая привязка: название задачи
 * передаётся стору для чата, а при отказе или ожидании решения селект откатывается.
 */
async function onTaskChange(e: Event) {
  const val = (e.target as HTMLSelectElement).value;
  const o = taskOpts.value.find((x) => x.task === val);
  const done = await chat.setTask(props.sid, val || null, o ? (o.title || `#${o.task}`) : '');

  if (!done) {
    taskChoice.value = String(sess.value?.taskId || '');
  }
}

// ── Контекст (окно — у каждой модели своё, из реестра) ──
// Пока ход идёт, кольцо показывает ЖИВОЙ размер (`liveContext` — вход каждого обращения
// к модели, если исполнитель его сообщает), а не цифру с прошлого хода. Разница не косметическая:
// автокомпакт CLI срабатывает на границе хода, и без живого замера кольцо весь ход горело
// бы красным по уже сжатому контексту.
const ctxHasLiveUsage = computed(() => sess.value?.sending
  && (sess.value?.liveContextUsage?.contextTokens !== undefined || (sess.value?.liveContext || 0) > 0));
const ctxTokens = computed(() => (
  ctxHasLiveUsage.value
    ? (sess.value?.liveContextUsage?.contextTokens ?? sess.value?.liveContext)
    : (sess.value?.contextTokens || 0)
));
// ── Ближайший практический порог контекста ────────────────────────────────────
// Кольцо считает заполненность только по объёму активного контекста: до настроенного
// автосжатия или безопасного потолка окна. Кэш — отдельный факт последнего запроса;
// он не меняет ни шкалу, ни цвет кольца.
// Абсолютное число без потолка врало бы в другую сторону: у модели с окном 200k порог
// 200k недостижим, кольцо осталось бы зелёным до самого конца разговора.
// Сама арифметика — в `shared/chat/chatContext.ts`: тот же порог показывает карточка
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
    && (!!currentModel.value?.contextRuntimeOnly || !((currentModel.value?.context || 0) > 0))
));
const ctxUnavailable = computed(() => (!!sess.value?.sessionId || ctxHasLiveUsage.value)
  && (['legacy-unavailable', 'unavailable'].includes(ctxUsage.value?.contextMetric || '')
    || ctxRuntimeWindowPending.value || ctxWindowUnverified.value));
const ctxClass = computed(() => (ctxUnavailable.value ? '' : ctxFill.value.tone));
const ctxIsEstimate = computed(() => !!ctxUsage.value?.contextIsEstimate);
const ctxSampleHint = computed(() => {
  if (!sess.value?.sending) {
    return '';
  }

  return ctxHasLiveUsage.value ? ' · этот ход' : ' · прошлый ход, ждём замер';
});
const ctxWindowUnverified = computed(() => (
  !ctxUsage.value?.contextWindow && !!currentModel.value?.contextUnverified
));
const fmtSessionTokens = (value: unknown) => {
  const tokens = Math.max(0, Number(value) || 0);

  if (tokens < 1_000_000) {
    return fmtTokens(tokens);
  }

  return `${(tokens / 1_000_000).toLocaleString('ru', { maximumFractionDigits: 1 })} млн`;
};

/**
 * Сокращает счётчики кэша до тысяч и миллионов для компактной строки.
 * Малые значения остаются в прежнем формате токенов.
 */
const fmtCompactTokens = (value: unknown) => {
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
const cacheMetric = (cache: ContextCache, key: string): number | null => {
  const value = cache[key as keyof ContextCache];

  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
};
const contextCacheValue = computed(() => {
  const cache = contextCache.value;

  if (cache.status === 'unavailable') {
    return 'нет данных';
  }
  if (cache.status === 'not-applicable') {
    return 'без тарифа';
  }

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
  if (read !== null) {
    parts.push(`чт. ${fmtCompactTokens(read)}`);
  }
  if (write !== null) {
    parts.push(`зап. ${fmtCompactTokens(write)}`);
  }
  if (uncached !== null) {
    parts.push(`мимо ${fmtCompactTokens(uncached)}`);
  }

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
  const rows: Array<{
    label: string;
    value: string;
    unverified?: boolean;
    cache?: boolean;
  }> = ctxRuntimeWindowPending.value
    ? []
    : [{
      label: 'Окно',
      value: modelWindow,
      unverified: ctxWindowUnverified.value,
    }];
  const total = s?.totalInputTokens || 0;
  const addSessionRows = () => {
    if (total) {
      rows.push({ label: 'За сессию', value: fmtSessionTokens(total) });
    }

    rows.push({
      label: 'Кэш',
      value: contextCacheValue.value,
      cache: true,
    });
  };

  if (s?.compacting) {
    return {
      title: 'Контекст сессии',
      percent: '',
      tone: 'active',
      status: 'Сжимаю контекст…',
      detail: 'Агент готовит рабочую выжимку разговора.',
      rows: [],
      actions: false,
    };
  }
  if (!s?.sessionId && !ctxHasLiveUsage.value) {
    return {
      title: 'Контекст сессии',
      percent: '',
      tone: '',
      status: s?.pendingSeed ? 'Контекст сжат' : 'Контекст пуст',
      detail: s?.pendingSeed
        ? 'Выжимка уедет агенту со следующим сообщением.'
        : 'Размер появится после первого хода.',
      rows,
      actions: false,
    };
  }
  if (s?.compactedAt && !ctxTokens.value) {
    addSessionRows();

    return {
      title: 'Контекст сессии',
      percent: '',
      tone: '',
      status: 'Контекст сжат',
      detail: 'Новый размер появится после следующего хода.',
      rows,
      actions: true,
    };
  }
  if (ctxUnavailable.value) {
    addSessionRows();

    return {
      title: 'Контекст сессии',
      percent: '',
      tone: '',
      status: 'Точная заполненность пока недоступна',
      detail: 'Исполнитель пока не сообщил свежий размер контекста.',
      rows,
      actions: true,
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
    title: 'Контекст сессии',
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

  if (s?.compacting) {
    return 'Сжимаю контекст…';
  }
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
  if (s?.compactedAt && !ctxTokens.value) {
    return 'Контекст сжат — размер покажется после следующего хода';
  }

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
  const window = ` · окно модели ${fmtTokens(ctxWindow.value)}`
    + `${ctxWindowUnverified.value ? ' (не подтверждено)' : ''}`;

  return `Контекст: ${estimate}${tokens} из ${limit} ${ctxLimitWhat.value} (${ctxPct.value}%)`
    + `${live}${warn}${window}${spentHint.value}${cacheHint.value} · ${hint}`;
});
// Кольцо-индикатор контекста (клик — сжатие, Alt+клик — сброс памяти).
const RING_C = 2 * Math.PI * 9;
// На время сжатия дуга — короткий бегунок: кольцо в этот момент вращается, а полное
// (или почти полное) кольцо при вращении выглядело бы неподвижным.
const SPIN_DASH = RING_C * 0.75;
const ringDash = computed(() => {
  if (sess.value?.compacting) {
    return SPIN_DASH;
  }
  if (ctxUnavailable.value) {
    return RING_C;
  }

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
async function onCtxClick(e: { altKey: boolean }) {
  const s = sess.value;

  if (!s?.sessionId || s.compacting || s.sending) {
      return;
    }
  if (e.altKey) {
    const ok = await confirmDialog(
      'Агент забудет весь разговор: следующее сообщение начнёт его с нуля. '
        + 'Переписка на экране останется, но вернуть агенту контекст будет уже нельзя.',
      {
        title: 'Сбросить память агента?',
        okText: 'Сбросить',
        danger: true,
      },
    );

    if (ok) {
      await chat.resetContext(props.sid);
    }

    return;
  }

  const contextNow = ctxUnavailable.value
    ? 'Точный размер текущего контекста пока недоступен.'
    : `Сейчас в контексте ${fmtTokens(ctxTokens.value)} токенов.`;
  const ok = await confirmDialog(
    `${contextNow} Агент соберёт из разговора рабочую выжимку и продолжит с неё — `
      + 'что решили, чего касались, что осталось. Это полноценный ход: '
      + 'он займёт время и потратит токены один раз, зато каждый следующий ход станет дешевле.',
    { title: 'Сжать контекст чата?', okText: 'Сжать' },
  );

  if (ok) {
    chat.compact(props.sid);
  }
}

// Сжатие или server-owned reset замораживают управление: менять модель/задачу/права
// посреди перехода нельзя. Поле ввода, вложения и диктовка остаются живыми; сама кнопка
// отправки ждёт завершения перехода.
const frozen = computed(() => !!sess.value?.compacting || !!sess.value?.sessionResetting
  || !!sess.value?.workdirChanging || !!sess.value?.workdirProposal
  || ['preparing', 'ready', 'resetting'].includes(sess.value?.workdirState?.transition?.phase || ''));
const frozenHint = computed(() => (sess.value?.sessionResetting
  ? 'Сбрасывается память агента — отправка будет доступна после подтверждения сервера'
  : sess.value?.compacting
    ? 'Идёт сжатие контекста — отправка будет доступна сразу после него'
    : 'Подтвердите перенос и дождитесь смены рабочей папки'));

// ── «Прочитано» ──
// Открытый на экране чат читается сам: компонент рисуется ровно тогда, когда на чат
// смотрят на странице «Чаты». Ответ, пришедший в свёрнутую вкладку ОС,
// остаётся непрочитанным до возврата — поэтому слушаем ещё и visibilitychange.
function markRead() {
  if (!document.hidden) {
    chat.markRead(props.sid);
  }
}

watch(() => [props.sid, sess.value?.unread], markRead, { immediate: true });
document.addEventListener('visibilitychange', markRead);
onUnmounted(() => document.removeEventListener('visibilitychange', markRead));

// ── Ввод ──
const input = ref(sess.value?.draft || '');
const body = ref<HTMLElement | null>(null);

function scrollDown() {
  if (body.value) {
    body.value.scrollTop = body.value.scrollHeight;
  }
}

// ── Высота поля ввода ───────────────────────────────────────────────────────────
// Настройка устройства (localStorage, как ширина дока и списка чатов). Пусто =
// высоту решает CSS, как раньше.
const COMPOSER_KEY = 'grigdesk-chat-composer-h';
// Минимум совпадает с CSS (`[data-role='chat-composer'] { min-height: 48px }`): иначе
// нижняя часть хода разделителя мертва — тянешь, число меняется, поле стоит.
const COMPOSER_MIN = 48;
// Потолок тот же, что в CSS (`max-height: 46vh`) — вторая цифра рядом с первой
// разъезжается, и разделитель снова получает мёртвый ход.
const COMPOSER_MAX_VH = 0.46;
const taEl = ref<InstanceType<typeof UiTextarea> | null>(null);


/**
 * Читает сохранённую положительную высоту поля ввода.
 * Отказ storage и неверное число оставляют управление размером CSS.
 */
function storedComposerHeight() {
  try {
    const raw = Number(localStorage.getItem(COMPOSER_KEY));

    return Number.isFinite(raw) && raw > 0 ? raw : null;
  } catch {
    return null;
  }
}

const composerH = ref<number | null>(storedComposerHeight());
const composerStyle = computed(() => (
  composerH.value == null ? null : { '--composer-h': `${composerH.value}px` }
));

function composerMax() {
  const view = typeof window === 'undefined' ? 0 : window.innerHeight;

  return Math.max(COMPOSER_MIN, Math.round((view || 720) * COMPOSER_MAX_VH));
}

function clampComposer(value: number) {
  return Math.round(Math.min(Math.max(COMPOSER_MIN, value), composerMax()));
}
// Тянем от ФАКТИЧЕСКОЙ высоты поля, а не от сохранённого числа: после смены окна
// (поворот планшета) CSS уже подрезал поле по 46vh, и старое число дало бы скачок.
function composerHeightNow() {
  const h = taEl.value?.el?.getBoundingClientRect?.().height;

  return clampComposer(h !== undefined && h > 0 ? h : (composerH.value ?? COMPOSER_MIN));
}


/**
 * Сохраняет явно выбранную высоту поля ввода на этом устройстве.
 * Запрет storage в приватном режиме не прерывает работу чата.
 */
function saveComposerHeight() {
  if (composerH.value == null) {
    return;
  }

  try {
    localStorage.setItem(COMPOSER_KEY, String(composerH.value));
  } catch { /* приватный режим может запретить storage */ }
}

let composerPointer: number | null = null;
let composerFrom: { y: number; h: number } | null = null; // { y, h } на момент захвата


/**
 * Захватывает указатель и фактическую высоту поля в начале перетаскивания.
 * Правые и вспомогательные кнопки не начинают изменение размера.
 */
function startComposerResize(event: PointerEvent) {
  if (event.button !== undefined && event.button !== 0) {
    return;
  }

  composerPointer = event.pointerId;
  (event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId);
  composerFrom = { y: event.clientY, h: composerHeightNow() };
}

function moveComposerResize(event: PointerEvent) {
  if (composerPointer !== event.pointerId || !composerFrom) {
    return;
  }
  // Вверх = выше: разделитель на верхней кромке поля, и поле растёт за курсором.
  composerH.value = clampComposer(composerFrom.h + (composerFrom.y - event.clientY));
}


/**
 * Завершает изменение размера только указателем текущего захвата.
 * После освобождения указателя сохраняет выбранную высоту.
 */
function finishComposerResize(event: PointerEvent) {
  if (composerPointer !== event.pointerId) {
    return;
  }

  composerPointer = null;
  composerFrom = null;
  (event.currentTarget as HTMLElement | null)?.releasePointerCapture?.(event.pointerId);
  saveComposerHeight();
}


/**
 * Снимает отменённый захват только у его собственного указателя.
 * Текущая высота сохраняется тем же способом, что при завершении.
 */
function cancelComposerResize(event: PointerEvent) {
  if (composerPointer !== event.pointerId) {
    return;
  }

  composerPointer = null;
  composerFrom = null;
  (event.currentTarget as HTMLElement | null)?.releasePointerCapture?.(event.pointerId);
  saveComposerHeight();
}


/**
 * Изменяет высоту поля доступными клавишами с прежними границами.
 * Необработанные клавиши сохраняют стандартное поведение браузера.
 */
function onComposerResizeKey(event: KeyboardEvent) {
  const step = event.shiftKey ? 48 : 16;

  if (event.key === 'ArrowUp') {
    composerH.value = clampComposer(composerHeightNow() + step);
  } else if (event.key === 'ArrowDown') {
    composerH.value = clampComposer(composerHeightNow() - step);
  } else if (event.key === 'Home') {
    composerH.value = COMPOSER_MIN;
  } else if (event.key === 'End') {
    composerH.value = composerMax();
  } else {
    return;
  }

  event.preventDefault();
  saveComposerHeight();
}
// Двойной клик — вернуть обычную CSS-высоту. Настройку стираем, а не пишем минимум,
// чтобы будущие изменения layout-default не перекрывались старым числом.
function resetComposerHeight() {
  composerH.value = null;

  try {
    localStorage.removeItem(COMPOSER_KEY);
  } catch { /* приватный режим может запретить storage */ }
}

// ── Автопрокрутка ──
// Едем вниз на всё новое (сообщения, шаги ленты, «думает…»), но ТОЛЬКО если пользователь
// и так внизу: отлистал историю вверх — не дёргаем, иначе читать невозможно.
const NEAR_BOTTOM_PX = 120;
const atBottom = ref(true);

function onBodyScroll() {
  const el = body.value;

  if (!el) {
    return;
  }

  atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
}

async function autoScroll() {
  if (!atBottom.value) {
    return;
  }

  await nextTick();
  scrollDown();
}

watch(() => [
  sess.value?.messages?.length,
  sess.value?.steps?.length,
  inTurnRun.value?.entries.map((entry) => `${entry.sequence}:${entry.revision}`).join(','),
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
let draftTimer: ReturnType<typeof setTimeout> | null = null;

watch(input, (v) => {
  clearTimeout(draftTimer ?? undefined);

  const sid = props.sid;

  draftTimer = setTimeout(() => chat.setDraft(sid, v), 400);
});
// Уход со страницы/закрытие вкладки — дописываем черновик немедленно, дебаунс не успел бы.
function flushDraft() {
  clearTimeout(draftTimer ?? undefined);
  chat.setDraft(props.sid, input.value);
}

window.addEventListener('beforeunload', flushDraft);
onUnmounted(() => {
  flushDraft();
  window.removeEventListener('beforeunload', flushDraft);
});
/**
 * Кнопка и Enter используют один маршрут: готовый канал текущего хода или обычную очередь.
 * Отказ уже начатой передачи сохраняет черновик и не создаёт второй запрос другим путём.
 */
async function submit() {
  if (speechBusy.value) {
    return;
  }

  const t = input.value.trim();
  const atts = pending.value.slice();

  if ((!t && !atts.length) || !sess.value || frozen.value || modeUnavailable.value) {
    return;
  }

  // Точное имя пункта выполняем через его dispatch. `/`-команды провайдера идут
  // служебным ходом, `$skill` — обычным prompt; run:'none' остаётся обычным сообщением.
  // Сверка регистронезависимая — как в меню: имя навыка приходит от исполнителя.
  const exact = allCommands.value.find((c) => c.cmd.toLowerCase() === t.toLowerCase() && c.run !== 'none');

  if (exact && exact.cmd.startsWith('/')) {
    runCommand(exact);

    return;
  }
  if (sess.value.sending && inTurnComposer.value.ready) {
    const accepted = await chat.sendInTurn(props.sid, t, atts);

    if (!accepted) {
      inputErr.value = chat.inTurnError || 'Не удалось отправить уточнение.';

      return;
    }

    inputErr.value = '';
    input.value = '';
    clearTimeout(draftTimer ?? undefined);
    chat.setDraft(props.sid, '');

    if (atts.length) {
      chat.setDraftAttachments(props.sid, []);
    }

    atBottom.value = true;

    return;
  }

  inputErr.value = '';
  input.value = '';
  atBottom.value = true; // своё сообщение всегда показываем — как в мессенджерах
  // Черновик отправленного сообщения гасим сразу: дебаунс успел бы записать его
  // уже после отправки, и в списке чат остался бы «с черновиком».
  clearTimeout(draftTimer ?? undefined);
  chat.setDraft(props.sid, '');

  if (atts.length) {
    chat.setDraftAttachments(props.sid, []);
  }

  const accepted = await chat.send(props.sid, t, atts);

  if (accepted === false) {
    input.value = t;
    chat.setDraft(props.sid, t);

    if (atts.length) {
      chat.setDraftAttachments(props.sid, atts);
    }
  }
}

// Ход прерван перезапуском сервера или оборван самим CLI (сеть, лимит): сессия
// исполнителя цела (транскрипт CLI живёт на диске отдельно от GrigDesk), поэтому
// продолжение — обычное сообщение в ту же сессию. Текст называет причину по метке:
// агент должен сверить сделанное, а не переделывать с нуля.
const RESUME_TAIL = 'Продолжай с места остановки: сверь, что уже сделано, и доведи работу до конца.';
const RESUME_TEXT: Readonly<Record<string, string>> = Object.freeze({
  server_shutdown: `Сервер GrigDesk перезапустился, и твой ход был прерван. ${RESUME_TAIL}`,
  delivery_failure: 'Твой прошлый ход оборвал сам CLI (сеть или лимит), ответ до меня не дошёл. '
    + RESUME_TAIL,
});

/** Текст продолжения по метке прерывания; без известной метки продолжать нечего. */
function resumeTextFor(m: ChatMessage | undefined) {
  const reason = m?.interruptedBy;

  return typeof reason === 'string' && Object.hasOwn(RESUME_TEXT, reason) ? RESUME_TEXT[reason] : '';
}

function deliveryIcon(m: ChatMessage) {
  const mark = deliveryMark(m);

  return mark?.kind === 'pending' ? mark.icon : undefined;
}

function deliveryMark(m: ChatMessage) {
  return messageDeliveryMark(m, chat.deliveries?.[m.turnId || '']?.state);
}

/**
 * Повтор недоставленного сообщения — осознанное действие: значок мог быть задет случайно.
 * Общий диалог проекта спрашивает подтверждение и только потом отправляет тот же turnId.
 */
async function confirmRetryDelivery(m: ChatMessage) {
  if (!sess.value || frozen.value) {
    return;
  }

  const ok = await confirmDialog(
    'Сервер не подтвердил приём этого сообщения. Повтор безопасен: если оно всё-таки дошло, '
      + 'агент не выполнит его второй раз.',
    { title: 'Сообщение не доставлено', okText: 'Повторить отправку' },
  );

  if (ok) {
    await retryDelivery(m);
  }
}

// Повтор идёт тем же turnId: если прежний запрос всё-таки дошёл, второго запуска не будет.
async function retryDelivery(m: ChatMessage) {
  if (!sess.value || frozen.value) {
    return;
  }

  atBottom.value = true;
  await chat.retryDelivery(props.sid, m.turnId || '');
}

/** Кнопку показываем только у последнего сообщения и только свободному чату. */

/**
 * Предлагает продолжение только у последнего прерванного сообщения.
 * Занятый или замороженный чат не получает новую кнопку отправки.
 */
function isResumeOffer(m: ChatMessage, i: number) {
  if (!resumeTextFor(m)) {
    return false;
  }

  const messages = sess.value?.messages || [];

  if (i !== messages.length - 1) {
    return false;
  }

  return !sess.value?.sending && !sess.value?.compacting && !frozen.value;
}


/**
 * Отправляет текст продолжения из последнего прерванного сообщения.
 * Пустое предложение и замороженный чат остаются без новой отправки.
 */
async function resumeInterrupted() {
  if (!sess.value || frozen.value) {
    return;
  }

  const text = resumeTextFor(sess.value.messages?.at(-1));

  if (!text) {
    return;
  }

  atBottom.value = true;
  await chat.send(props.sid, text, []);
}


/**
 * Направляет клавиши в открытое меню команд или обычную отправку.
 * Ввод через IME не отправляет незавершённый текст.
 */
function onKey(e: KeyboardEvent) {
  if (e.isComposing || e.keyCode === 229) {
    return;
  }
  // Открыто меню команд — стрелки/Enter/Tab/Esc управляют им.
  // Навигация по выбираемым пунктам (cmdNav): заголовки и run:'none' пропускаются.
  const m = cmdNav.value;

  if (cmdMatches.value.length) {

    if (e.key === 'ArrowDown' && m.length) {
      e.preventDefault();
      cmdIndex.value = (cmdIndex.value + 1) % m.length;

      return;
    }

    if (e.key === 'ArrowUp' && m.length) {
      e.preventDefault();
      cmdIndex.value = (cmdIndex.value - 1 + m.length) % m.length;

      return;
    }

    if ((e.key === 'Enter' || e.key === 'Tab') && m.length) {
      e.preventDefault();
      runCommand(m[Math.min(cmdIndex.value, m.length - 1)]!);

      return;
    }

    if (e.key === 'Escape') {
      input.value = '';

      return;
    }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    submit();
  }
}

// ── Команды и навыки: «/» открывает CLI-команды, «$» — skills Codex ──
// Две секции: клиентские команды GrigDesk и команды CLI выбранной модели (провайдерский
// список приезжает в /api/providers, контракт — server/src/lib/executors/index.js).
interface ChatCommand {
  cmd: string;
  desc?: string;
  source: string;
  run?: string;
  args?: boolean | string;
  hint?: string;
}

const COMMANDS: ChatCommand[] = [
  {
    cmd: '/compact',
    desc: 'Сжать контекст: агент пересказывает разговор и продолжает с выжимки',
    source: 'grigdesk',
    run: 'local',
  },
  {
    cmd: '/clear',
    desc: 'Очистить историю и сбросить контекст агента',
    source: 'grigdesk',
    run: 'local',
  },
  {
    cmd: '/reset',
    desc: 'Сбросить только контекст (история остаётся)',
    source: 'grigdesk',
    run: 'local',
  },
  {
    cmd: '/new',
    desc: 'Открыть новый чат',
    source: 'grigdesk',
    run: 'local',
  },
];
// Команды исполнителя текущей модели. Резолвер тот же, что у селекта модели: для
// legacy-чатов без modelRef провайдер достаётся из сохранённого id модели.
const providerInfo = computed(() => current.value.provider || null);
const providerCommands = computed(() => {
  const p = providerInfo.value;

  return (Array.isArray(p?.commands) ? p.commands : [])
    .map((c) => ({ ...c, source: p?.id || '' }));
});
// Объединённый список: команда GrigDesk глушит провайдерскую с тем же именем
// (/compact уже есть у GrigDesk — дубль не показываем, поведение не меняется).
const allCommands = computed(() => {
  const merged = [...COMMANDS];

  for (const c of providerCommands.value) {
    if (!merged.some((x) => x.cmd === c.cmd)) {
      merged.push(c);
    }
  }

  return merged;
});
const cmdIndex = ref(0);
const cmdMatches = computed(() => {
  const t = input.value.trimStart().toLowerCase();

  if (!/^[/$]/.test(t) || /[\s\n]/.test(t)) {
    return [];
  }
  // Имя навыка приходит от Codex и заглавные в нём законны (`$Review-Agent`),
  // поэтому сверяем в нижнем регистре: иначе такой пункт нельзя было бы найти.
  return allCommands.value.filter((c) => c.cmd.toLowerCase().startsWith(t));
});
// Навигация идёт только по выбираемым пунктам: заголовки секций и пункты run:'none'
// (команда живёт в TUI исполнителя) пропускаются стрелками и не выбираются Enter/кликом.
const cmdNav = computed(() => cmdMatches.value.filter((c) => c.run !== 'none'));
// Плоский список для рендера: заголовки секций + пункты с их индексом навигации.
const cmdMenu = computed(() => {
  const items: Array<ChatCommand & {
    key: string;
    header?: string;
    color?: string;
    nav: number;
  }> = [];
  let nav = 0;
  const push = (c: ChatCommand) => items.push({
    ...c,
    key: `${c.source}:${c.cmd}`,
    nav: c.run === 'none' ? -1 : nav++,
  });
  const grigdesk = cmdMatches.value.filter((c) => c.source === 'grigdesk');
  const own = cmdMatches.value.filter((c) => c.source !== 'grigdesk');

  if (grigdesk.length) {
    items.push({
      header: 'GrigDesk',
      key: 'h:grigdesk',
      cmd: '',
      source: '',
      nav: -1,
    });
  }

  grigdesk.forEach(push);

  if (own.length) {
    items.push({
      header: providerInfo.value?.name || 'Исполнитель',
      color: providerInfo.value?.color || '',
      key: 'h:provider',
      cmd: '',
      source: '',
      nav: -1,
    });
  }

  own.forEach(push);

  return items;
});

watch(cmdNav, (m) => {
  if (cmdIndex.value >= m.length) {
    cmdIndex.value = 0;
  }
});
// Меню ограничено по высоте и скроллится — при навигации стрелками подгоняем
// выбранный пункт в видимую область.
const cmdMenuEl = ref<HTMLElement | null>(null);

watch(cmdIndex, async () => {
  await nextTick();
  cmdMenuEl.value?.querySelector('.cmd.on')?.scrollIntoView({ block: 'nearest' });
});


/**
 * Выполняет выбранную локальную команду либо передаёт её исполнителю.
 * Отклонённая отправка восстанавливает черновик и его вложения.
 */
async function runCommand(command: string | ChatCommand) {
  if (speechBusy.value) {
    return;
  }

  const c = typeof command === 'string'
    ? allCommands.value.find((x) => x.cmd === command)
    : command;

  if (!c || c.run === 'none') {
    return;
  }
  if (c.source !== 'grigdesk') {
    // Провайдерская команда/навык. Гард тот же, что у submit():
    // пока чат заморожен (сжатие/reset), ничего не выполняем и ввод не трогаем.
    if (!sess.value || frozen.value) {
    return;
  }
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

    if (skill && sess.value.sending) {
      input.value = c.cmd;
      cmdIndex.value = 0;
      await submit();

      return;
    }

    const atts = skill ? pending.value.slice() : [];

    input.value = '';
    cmdIndex.value = 0;
    clearTimeout(draftTimer ?? undefined);
    chat.setDraft(props.sid, '');

    if (atts.length) {
      chat.setDraftAttachments(props.sid, []);
    }

    const accepted = skill
      ? await chat.send(props.sid, c.cmd, atts)
      : await chat.send(props.sid, c.cmd, [], { slashCommand: c.cmd });
    // Как в submit(): отклонённая отправка не теряет ни набранное, ни вложения.
    if (accepted === false) {
      input.value = c.cmd;
      chat.setDraft(props.sid, c.cmd);

      if (atts.length) {
        chat.setDraftAttachments(props.sid, atts);
      }
    }

    return;
  }

  input.value = '';
  cmdIndex.value = 0;

  if (c.cmd === '/compact') {
    // Тот же путь, что у кольца: подтверждение обязательно — сжатие тратит ход агента.
    onCtxClick({ altKey: false });
  } else if (c.cmd === '/clear') {
    if (pending.value.length) {
      chat.setDraftAttachments(props.sid, []);
    }

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
// (chats/attachments/), к сообщению прикладывается ссылка — агент читает через Read.
// Неотправленные вложения — часть черновика чата в сторе, а не этого компонента:
// при переключении чатов компонент пересоздаётся, и локальный список терялся. ──
const pending = computed(() => sess.value?.draftAttachments || []); // [{ file, name, url, mime }]
const attachBusy = ref(false);

/**
 * Загружает файлы по одному и дописывает их в черновик того чата, где их приложили.
 * Чат фиксируется до первой загрузки: ответ сервера может прийти уже после переключения.
 */
async function addFiles(files: Iterable<File | null>) {
  const sid = props.sid;

  for (const f of files) {
    if (!f) {
      continue;
    }

    attachBusy.value = true;

    try {
      const fd = new FormData();

      fd.append('file', f, f.name || 'image.png');
      chat.addDraftAttachment(sid, decodeChatAttachment(await api.upload('/api/chat/upload', fd)));
    } catch (e) {
      inputErr.value = `Загрузка: ${errorMessage(e, '')}`;
    } finally {
      attachBusy.value = false;
    }
  }
}

function onPick(files: File[]) {
  addFiles(files);
}


/**
 * Забирает изображения из буфера в прежний путь загрузки вложений.
 * Вставка без изображений остаётся стандартной операцией браузера.
 */
function onPaste(e: ClipboardEvent) {
  const imgs = [...(e.clipboardData?.items || [])].filter((i) => i.type.startsWith('image/'));

  if (!imgs.length) {
    return;
  }

  e.preventDefault();
  addFiles(imgs.map((i) => i.getAsFile()).filter(Boolean));
}

function removePending(i: number) {
  chat.setDraftAttachments(props.sid, pending.value.filter((_, at) => at !== i));
}

function isImg(a: HistoryAttachment) {
  return (a.mime || '').startsWith('image/');
}

// Drag&drop файлов на весь чат: счётчик enter/leave (leave стреляет на каждом
// дочернем элементе), оверлей-подсказка поверх.
const dragDepth = ref(0);
const dragOver = computed(() => dragDepth.value > 0);

function onDragEnter(e: DragEvent) {
  if (e.dataTransfer?.types?.includes('Files')) {
    dragDepth.value++;
  }
}

function onDragLeave() {
  if (dragDepth.value > 0) {
    dragDepth.value--;
  }
}

function onDrop(e: DragEvent) {
  dragDepth.value = 0;

  const files = [...(e.dataTransfer?.files || [])];

  if (files.length) {
    addFiles(files);
  }
}

// ── Диктовка: единый root-owned controller ──
// Компонент владеет только политикой composer-а: устойчивые куски дописывает в
// текущий draft, но terminal final сам не отправляет. TaskModal использует тот же
// controller для карточки ответа на вопрос триажа.
const inputErr = ref('');


/**
 * Дописывает устойчивый фрагмент диктовки в текущий черновик.
 * Пустые фрагменты пропускаются, граница слов сохраняется пробелом.
 */
function appendDictationText(text: string) {
  const piece = String(text || '').trim();

  if (!piece) {
    return;
  }

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
  if (cancel) {
    return dictationLease.cancel();
  }

  return dictationLease.stop();
}


/**
 * Переключает диктовку через единственный захваченный controller.
 * Подготовка ответа и завершение потока блокируют повторный запуск.
 */
function toggleMic() {
  inputErr.value = '';

  if (transcribing.value || drainingSpeech.value) {
    return;
  }
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


/**
 * Обрабатывает общую клавишу диктовки и отмену активного захвата.
 * Комбинации с лишними модификаторами остаются за браузером.
 */
function onGlobalKey(e: KeyboardEvent) {
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
  if (speechBusy.value) {
    void stopSpeech({ cancel: true });
  }
}, { flush: 'sync' });
onMounted(() => window.addEventListener('keydown', onGlobalKey));
onUnmounted(() => {
  void dictationLease.release();
  window.removeEventListener('keydown', onGlobalKey);
});
// ── Копирование сообщения (иконка при наведении) ──
const copiedIdx = ref(-1);


/**
 * Копирует текст сообщения через общий адаптер буфера обмена.
 * Краткий индикатор успеха снимается только у того же сообщения.
 */
async function copyMsg(m: ChatMessage, i: number) {
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
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const messageDateTimeFormatter = new Intl.DateTimeFormat('ru-RU', {
  dateStyle: 'medium', timeStyle: 'short',
});

function validMessageTime(value: unknown) {
  const time = Number(value);

  return Number.isSafeInteger(time) && time > 0 ? time : 0;
}

function messageTime(value: unknown) {
  const time = validMessageTime(value);

  return time ? messageTimeFormatter.format(new Date(time)) : '';
}

function messageTimeTitle(value: unknown) {
  const time = validMessageTime(value);

  return time ? `Отправлено ${messageDateTimeFormatter.format(new Date(time))}` : '';
}

function messageTimeIso(value: unknown) {
  const time = validMessageTime(value);

  return time ? new Date(time).toISOString() : '';
}

// ── Спросы агента: разрешение на действие и вопрос (AskUserQuestion). Все висящие
// запросы лежат в сторе (приходят по SSE, после F5 — из /api/chat/waiting);
// берём адресованные этому чату. Висят, пока не ответишь: агент их ждёт. ──
const perm = computed(() => chat.permFor(props.sid));
const question = computed(() => chat.questionFor(props.sid));

function answerQuestion(payload: unknown) {
  if (question.value) {
    void chat.answerQuestion(question.value.pid, payload);
  }
}

function skipQuestion() {
  if (question.value) {
    void chat.answerQuestion(question.value.pid, []);
  }
}
</script>

<style scoped>
/* min-width: 0 обязателен: без него флекс-элемент не сжимается ниже min-content своего
   содержимого — одна длинная команда в ленте или во всплывашке раздувала всю колонку
   чата, и кнопки «Разрешить/Отклонить» уезжали за правый край экрана. */
.cs { display: flex; flex-direction: column; min-height: 0; min-width: 0; height: 100%; }
.cs {
  --chat-reply-size: .78125rem;
  --chat-reply-leading: 1.5;
  --chat-reply-heading-size: .875rem;
  --chat-reply-preview-lines: 4;
}

.col { width: 100%; min-width: 0; }
/* Шапка подстраивается под ширину самого чата, а не окна: рядом со списком, ширину
   которого тянут мышью, чату на одном и том же экране остаётся от 400 до 1300 px. */
.cs { container: chat / inline-size; }

.cs-top { --chat-head-gap: 16px; display: flex; flex-direction: column; gap: 4px; padding: 4px var(--chat-gutter);
  border-bottom: 1px solid var(--line); min-height: var(--chat-head-h); justify-content: center; }
/* На странице высота шапки — общий с левым списком токен, иначе две разделительные линии
   расходятся. min-height, а не height: редкое предупреждение о модели важнее ровной линии —
   пусть шапка подрастёт, чем текст обрежется. */
/* Ряд настроек на странице НЕ переносится: перенос — это плюс 30px к шапке и разъехавшиеся
   линии. Вместо переноса ряд ужимается (см. shrink у .factbar), а на узком экране страница
   и так уходит в одну колонку, где шапке разрешено расти. */
.hrow { display: flex; align-items: center; column-gap: var(--chat-head-gap); min-width: 0; }
/* Назад к списку: на широком экране список виден всегда, кнопка нужна только на мобиле */
.back { display: none; flex: none; margin: 0 calc(8px - var(--chat-head-gap)) 0 -6px; place-items: center; }
.phone-options { display: none; flex: none; }
/* Название чата — как заголовок карточки, рядом карандаш переименования */
.ttl { display: flex; align-items: center; gap: 3px; flex: 1 1 auto; min-width: 0; }
.ctitle { font-size: 15px; font-weight: 600; cursor: default; line-height: 1.3;
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Карандаш приглушён, пока не наводишь на шапку, но остаётся виден и доступен с клавиатуры. */
.tedit { flex: none; }
.ctitle-edit { width: 100%; }
.bar { display: flex; column-gap: var(--chat-head-gap); align-items: center; flex-wrap: nowrap; }
.spacer { flex: 1; }
.sel { position: relative; }
/* Задача делит верхний ряд с названием чата и стоит у папки. Ширина — по выбранному
   значению (field-sizing в скине селекта), а не пустая половина ряда с шевроном на краю;
   при нехватке места ужимается первой (shrink 100): название важнее. Полное название
   задачи доступно по ховеру в общем UiTooltip — внешний overflow страницы его не обрежет. */
.task-tip { flex: 0 100 auto; max-width: min(420px, 50%); }
/* Минимум — целое «без задачи»: дальше ужимается название чата. Это тот же элемент,
   что .task-tip (класс триггера подсказки), поэтому min-width задаётся здесь. */
.sel.task { min-width: 104px; }
.sel.task :deep(.ui-select-wrap) { flex: 0 1 auto; width: auto; min-width: 0; }
/* Модель получает ширину выбранного названия, а не фиксированные 140px.
   При нехватке места первой сокращается информационная строка последнего хода. */
.sel.model { flex: 0 1 auto; min-width: 0; max-width: 100%; }
/* Строка состояния — не отдельная форма: у контролов нет своих коробок, только
   подпись-метка, значение и шеврон. Вертикальных черт между ними нет ни в одном ряду и ни
   на одной ширине: группы разводит один зазор --chat-head-gap, а подписи-метки и так
   отмечают начало каждой. Черты по соседству элементов ложились через раз. */
.sel { position: relative; display: flex; align-items: center; gap: 7px; padding: 0 2px; }
.sel .lbl { flex: none; font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em; color: var(--ink-mid); opacity: .75; }
/* Заморозка на время сжатия (см. frozen): селекты и кнопки выключены атрибутом, а слайдеру
   усилия своего disabled не заводили — гасим его отдельно. Композер не трогаем: печатать
   во время сжатия можно, нельзя только отправить. */
.cs.frozen .bar :deep(.eff) { opacity: .5; pointer-events: none; }

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
.cs-body { flex: 1; overflow-y: auto; overflow-x: hidden; scrollbar-gutter: stable; padding: 0 max(0px, calc(var(--chat-gutter) - 11px)) 0 var(--chat-gutter);
  margin: var(--chat-flow-inset) 0; }
/* min-height 100% — пустое состояние центрируется */
.flow { display: flex; flex-direction: column; gap: var(--chat-flow-gap); min-height: 100%; }
.conversation-group { display: contents; }
/* Линия принадлежит всему запуску: раскрытие действий и реплики человека
   меняют высоту группы, но не разрывают её и не добавляют вложенных полос. */
.conversation-group.turn {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 3px 0 3px 12px;
  border-left: 2px solid color-mix(in srgb, var(--prov, var(--ink-mid)) 55%, transparent);
}

/* Пустое состояние — по центру, а не подсказка в углу */
.empty { margin: auto; min-width: 0; max-width: 100%; text-align: center; padding: 24px; }
.e-title { font-size: 17px; font-weight: 600; }
.e-sub { display: grid; gap: 8px; font-size: 13px; line-height: 1.6; margin-top: 8px; }
.e-sub p { margin: 0; }
.e-workdir { overflow-wrap: anywhere; }

.msg { display: flex; flex-direction: column; gap: 4px; }
/* Текст + иконка копирования рядом (в потоке, не поверх текста). У пользовательских
   сообщений порядок обратный — иконка слева от пузыря. */
.mrow { display: flex; align-items: flex-end; gap: 6px; min-width: 0; }
.msg.user .mrow { flex-direction: row-reverse; }
.m-resume { margin-top: 8px; }
.msg .text { font-size: 14.5px; white-space: pre-wrap; line-height: 1.55; overflow-wrap: anywhere; min-width: 0; }
.msg.assistant .text { font-size: var(--chat-reply-size); line-height: var(--chat-reply-leading); }
/* Ты — справа, пузырь с акцентом; роль ясна по стороне, лейблы не нужны */
.msg.user { align-self: flex-end; align-items: flex-end; max-width: min(78%, 720px); }
.msg.user .text { display: flow-root; background: color-mix(in srgb, var(--accent) 18%, transparent);
  padding: 9px 13px; border-radius: 14px 14px 4px 14px; }
/* Время запроса — внутри нижнего правого угла пузыря, как в Telegram: часы и минуты
   не спорят с текстом, полная дата доступна по наведению. */
.m-meta {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  float: right;
  margin: .72em 0 0 9px;
  color: color-mix(in srgb, var(--ink-mid) 82%, transparent);
  font-size: 10px;
  font-weight: 400;
  line-height: 1;
  white-space: nowrap;
  user-select: none;
}
.m-pending {
  display: inline-flex;
}
.m-pending svg {
  width: 11px;
  height: 11px;
}
/* Нейтральный знак ответа занимает тот же столбец, что и знак действия в StepList.
   5px слева учитывают поле и рамку кнопки; текст всех строк начинается после 27px. */
.msg.assistant { align-self: stretch; }
.agent-reply { display: flex; align-items: flex-start; gap: 7px; min-width: 0; padding-left: 5px; }
.reply-mark {
  display: grid;
  place-items: center;
  flex: none;
  width: 15px;
  height: 20px;
  color: var(--ink-mid);
}
.agent-reply > .chat-in-turn-reply, .agent-reply > .text { flex: 1; min-width: 0; }
.agent-reply > .copy { align-self: flex-end; }
.turn .msg.assistant .m-atts, .turn .m-resume { padding-left: 27px; }
.ahead-mark { display: grid; place-items: center; flex: none; width: 15px; }
.ahead { display: flex; align-items: center; gap: 7px; padding-left: 5px; font-size: 11px; font-weight: 600;
  letter-spacing: .04em; text-transform: uppercase; color: var(--ink-mid); }
/* Знак берём чистым фирменным цветом, без подмешивания белого, как в списке чатов: там
   он лежит на своей заливке, здесь — прямо на `--surface`. Замер контраста к #151b24
   держит графический порог 3:1 у всех: claude 5.54, codex 5.41, kimi 3.24.
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
.fb b { font-weight: 600; color: var(--ink); }
.fb.warn {
  color: var(--warn, #e0a33a); white-space: normal; overflow-wrap: anywhere;
  overflow: visible; text-overflow: clip;
}
.factbar:has(.warn) { flex-wrap: wrap; overflow: visible; }
.fb.warn b { color: var(--warn, #e0a33a); }
/* Маркдаун ответа */
.text.md :deep(p) { margin: 0 0 4px; }
.text.md :deep(p:last-child) { margin-bottom: 0; }
.text.md :deep(h1), .text.md :deep(h2), .text.md :deep(h3),
.text.md :deep(h4), .text.md :deep(h5), .text.md :deep(h6) {
  margin: 8px 0 4px; font-size: var(--chat-reply-heading-size); line-height: 1.35; }
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

/* Служебная плашка самого GrigDesk (сжали контекст, сбросили память агента) — это не
   реплика: её не говорил ни агент, ни человек. Поэтому по центру, без пузыря и подписи. */
.msg.note { align-self: center; max-width: 90%; }
.msg.note .text { font-size: 12.5px; color: var(--ink-mid); background: var(--surface-2);
  border: 1px solid var(--line); border-radius: 10px; padding: 6px 12px; text-align: center; }

/* Вложения в сообщениях: картинка открывается в общем viewer-е, файл — как оригинал. */
.m-delivery { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 8px;
  font-size: 12px; color: var(--ink-mid); margin-bottom: 4px; }
.m-atts { display: flex; gap: 8px; flex-wrap: wrap; }
.msg.user .m-atts { justify-content: flex-end; }
.m-atts img { max-width: 220px; max-height: 160px; border-radius: 10px; border: 1px solid var(--line); display: block;
  cursor: zoom-in; }
.m-file { font-size: 12.5px; color: var(--ink-mid); border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; display: inline-block; }
.m-atts a { text-decoration: none; }

/* position — опора для разделителя высоты поля (.cs-resize) */
.cs-input { position: relative; padding: 12px var(--chat-gutter) 16px; border-top: 1px solid var(--line); }
/* Чипы вложений до отправки */
.pend { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 8px; }
.chip { display: flex; align-items: center; gap: 6px; background: var(--surface-2); border: 1px solid var(--line); border-radius: 8px; padding: 4px 6px; }
.chip img { width: 30px; height: 30px; object-fit: cover; border-radius: 5px; }
.chip .nm {
  display: inline-block;
  font-size: 11.5px;
  color: var(--ink-mid);
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
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

/* ── Шапка уже 900 px: ряд настроек без подписей-меток ──────────────────────────
   Значение каждого контрола говорит само за себя (задача, модель, режим, уровень), а
   полное название есть в подсказке по ховеру. Порог — по ширине чата: на 1440 рядом с
   широким списком шапка уже, чем на планшете без списка. */
@container chat (max-width: 899px) {
  .sel .lbl, .bar :deep(.eff .cap) { display: none; }
}

/* ── Шапка уже 640 px: строка последнего хода уходит ───────────────────────────
   Рядом с контролами от неё оставалось «пос…». То же видно в заголовке каждого ответа
   («АГЕНТ Opus 5.5 · xhigh»). Предупреждение о модели не прячется: оно встаёт своим
   рядом, шапка ради него подрастает. */
@container chat (max-width: 639px) {
  .factbar:not(:has(.warn)) { display: none; }
  .factbar:has(.warn) { order: 9; flex: 1 1 100%; }
  .bar:has(.factbar .warn) { flex-wrap: wrap; }
}

/* ── Шапка уже 480 px (телефон): блоки раскладываются по рядам ──────────────────
   Название с «назад» занимает верхний ряд целиком — рядом с папкой от него оставалось
   «Мете…». Ниже задача делит ряд с папкой, затем модель, режим, усилие и кольцо, последней —
   строка хода. Зазор между контролами здесь меньше: на 320 px иначе кольцо уходило бы
   своим рядом. */
@container chat (max-width: 479px) {
  .cs-top { --chat-head-gap: 12px; }
  .hrow { flex-wrap: wrap; row-gap: 6px; }
  .ttl { flex: 1 1 calc(100% - 44px); }
  .task-tip { flex: 1 1 0; max-width: none; }
  .bar { flex-wrap: wrap; row-gap: 6px; }
  .factbar { order: 9; flex: 1 1 100%; }
  .spacer { display: none; }
  /* Резерв под самое длинное слово уровня снят: на 320 px он сталкивал кольцо в свой ряд */
  :deep(.eff .eff-slider) { width: 56px; }
  :deep(.eff .val) { min-width: 0; }
}

/* ── Планшет-портрет и телефон: список и чат делят одну колонку ──────────────────
   Порог 900, а не 760: в 400px, что остаётся чату рядом со списком, ряд настроек уже
   не помещается, а резать контролы хуже, чем показывать по одной колонке (так же
   ведут себя почтовики и мессенджеры на планшете в портрете). Строение шапки то же —
   ширины теперь хватает: колонка одна. */
@media (max-width: 899px) {
  .back { display: grid; }
}

/* Узкие сообщения сохраняют прежние размеры текста и предел ширины вложений. */
@media (max-width: 759px) {
  .cs-top { justify-content: flex-start; }
  .cs-input { padding-bottom: 12px; }
  /* Иначе длинный текст режется в узкий столбик */
  .msg.user { max-width: 92%; }
  .msg .text { font-size: 14px; }
  .m-atts img { max-width: 62vw; }
}

/* При чтении на телефоне шапка занимает один ряд. Настройки раскрываются явно,
   сохраняя те же экземпляры controls и все предупреждения о неизвестной модели. */
@media (max-width: 600px) {
  .cs-top { min-height: 56px; padding-block: 6px; flex: none; }
  .hrow { column-gap: 6px; row-gap: 4px; }
  .ttl { flex: 1 1 0; }
  .ctitle { font-size: 16px; }
  .phone-options { display: grid; order: 2; }
  .task-tip { order: 3; }
  .hrow > :deep([data-context='chat-workdir']) { order: 4; }
  .cs:not(.options-open) .task-tip,
  .cs:not(.options-open) .tedit,
  .cs:not(.options-open) :deep([data-context='chat-workdir']) { display: none; }
  .cs:not(.options-open) .bar > :not(.factbar) { display: none; }
  .cs:not(.options-open) .bar:not(:has(.warn)) { display: none; }
  .cs.options-open .ttl { flex-basis: calc(100% - 100px); }
  .bar { gap: 6px 12px; }
  .cs-body { min-height: 0; scrollbar-gutter: auto; padding-inline: var(--chat-gutter); }
  .cs-input { padding: 8px var(--chat-gutter); flex: none; }
  .cs-resize { display: none; }
  .composer { flex-wrap: wrap; padding: 6px; }
  .composer > :deep([data-role='chat-composer']) {
    flex: 1 0 100%;
    order: -1;
  }
  .composer > :deep([data-role='chat-attachment']) { margin-right: auto; }
  .cs { --chat-reply-size: .9375rem; --chat-reply-heading-size: 1rem; }
  .conversation-group.turn { padding-left: 6px; }
  .agent-reply { gap: 4px; padding-left: 0; }
}
</style>

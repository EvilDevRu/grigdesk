<script setup>
import { computed, ref } from 'vue';

const props = defineProps({
  id: { type: String, default: 'cockpit-companion-bubble' },
  draft: { type: String, default: '' },
  interim: { type: String, default: '' },
  scopeLabel: { type: String, default: 'Общий контекст' },
  runLabel: { type: String, default: '' },
  runTitle: { type: String, default: '' },
  contextView: { type: Object, default: null },
  interaction: { type: String, default: 'open' },
  attention: { type: Object, default: () => ({ kind: 'none', count: 0 }) },
  attentionDestination: { type: String, default: '' },
  statusLabel: { type: String, default: 'Готов к сообщению' },
  lastReply: { type: String, default: '' },
  speechBusy: { type: Boolean, default: false },
  transcribing: { type: Boolean, default: false },
  thinking: { type: Boolean, default: false },
  stopping: { type: Boolean, default: false },
  canSend: { type: Boolean, default: false },
  muted: { type: Boolean, default: true },
  outputAvailable: { type: Boolean, default: false },
  ttsConsentPrompt: { type: Boolean, default: false },
  prompt: { type: String, default: '' },
  speechError: { type: String, default: '' },
  chatError: { type: String, default: '' },
  outputError: { type: String, default: '' },
  conflict: { type: Boolean, default: false },
});
const emit = defineEmits([
  'update:draft', 'send', 'mic', 'cancel', 'stop', 'mute', 'open-chat', 'close',
  'consent-browser', 'use-whisper', 'install-browser',
  'confirm-tts', 'dismiss-tts',
  'open-pipeline',
]);
const composer = ref(null);
const titleId = computed(() => `${props.id}-title`);
const statusId = computed(() => `${props.id}-status`);
const attentionAction = computed(() => !!props.attentionDestination && props.attention?.kind !== 'none');
const attentionText = computed(() => {
  if (props.attentionDestination === 'chats') {
    return props.attention?.kind === 'wait'
      ? 'Агент ждёт решения. Ответить на запрос безопасно можно в полном чате.'
      : 'В разговоре есть новый ответ.';
  }
  if (props.attention?.kind === 'stall') return 'В конвейере остановилась задача — открой его для диагностики.';
  if (props.attention?.kind === 'wait') return 'Конвейер ждёт решения на воротах.';
  return 'В конвейере продолжаются активные задачи.';
});

function updateDraft(event) {
  emit('update:draft', event.target?.value || '');
}
function composerKey(event) {
  if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
  event.preventDefault();
  if (props.canSend) emit('send');
}

defineExpose({ focusComposer: () => composer.value?.focus?.() });
</script>

<template>
  <section
    :id="id"
    class="companion-bubble"
    :class="[`is-${interaction}`, `attention-${attention?.kind || 'none'}`]"
    :data-interaction="interaction"
    :data-attention="attention?.kind || 'none'"
    role="dialog"
    aria-modal="false"
    :aria-labelledby="titleId"
    :aria-describedby="statusId"
  >
    <header class="bubble-head">
      <div>
        <strong :id="titleId">Голосовой компаньон</strong>
        <span class="scope-chip">{{ scopeLabel }}</span>
        <!-- Только показ: селекторов здесь нет и не будет — их место на полной
             странице. Но чем уйдёт ход и сколько накопилось, человек знать обязан. -->
        <span v-if="runLabel" class="run-chip" :title="runTitle" data-testid="companion-run">
          {{ runLabel }}
        </span>
        <span
          v-if="contextView"
          class="ctx-chip"
          :class="contextView.tone"
          :title="contextView.title"
          data-testid="companion-context"
        >{{ contextView.percent }}%</span>
      </div>
      <button type="button" class="icon-control close" aria-label="Закрыть компаньона" @click="emit('close')">×</button>
    </header>

    <div :id="statusId" class="status-line" role="status" aria-live="polite" aria-atomic="true">
      <span class="status-dot" aria-hidden="true"></span>
      <span>{{ statusLabel }}</span>
    </div>

    <div v-if="attentionAction" class="wait-card" data-testid="companion-wait">
      <p>{{ attentionText }}</p>
      <button
        type="button"
        class="text-control open-wait"
        @click="emit(attentionDestination === 'chats' ? 'open-chat' : 'open-pipeline')"
      >{{ attentionDestination === 'chats' ? 'Открыть чат' : 'Открыть конвейер' }}</button>
    </div>

    <p v-if="lastReply" class="last-reply" data-testid="companion-reply">
      <span>Ответ</span>{{ lastReply }}
    </p>

    <label class="composer-wrap">
      <span class="visually-hidden">Сообщение компаньону</span>
      <textarea
        ref="composer"
        data-testid="companion-composer"
        rows="3"
        :value="draft"
        :aria-describedby="statusId"
        placeholder="Спроси о текущем экране…"
        @input="updateDraft"
        @keydown="composerKey"
      ></textarea>
      <span v-if="interim" class="interim" aria-hidden="true">{{ interim }}</span>
    </label>

    <div v-if="prompt === 'browser-consent'" class="speech-prompt">
      <p>Браузеру нужно один раз разрешить обработку речи на этом устройстве.</p>
      <button type="button" class="text-control primary" @click="emit('consent-browser')">Продолжить в браузере</button>
      <button type="button" class="text-control" @click="emit('use-whisper')">Использовать локальный Whisper</button>
    </div>
    <div v-else-if="prompt === 'browser-install'" class="speech-prompt">
      <p>Для языка диктовки нужен локальный пакет браузера.</p>
      <button type="button" class="text-control primary" @click="emit('install-browser')">Скачать и продолжить</button>
      <button type="button" class="text-control" @click="emit('use-whisper')">Использовать локальный Whisper</button>
    </div>

    <div v-if="ttsConsentPrompt" class="tts-consent" role="group" aria-labelledby="companion-tts-consent-title">
      <strong id="companion-tts-consent-title">Включить озвучку на этом устройстве?</strong>
      <p>
        Голос браузера или операционной системы может использовать внешний облачный сервис.
        Cockpit передаёт ему только сокращённый текст прямого голосового ответа; настройка
        сохраняется лишь на этом устройстве.
      </p>
      <div>
        <button type="button" class="text-control primary" data-testid="companion-tts-confirm" @click="emit('confirm-tts')">
          Включить озвучку
        </button>
        <button type="button" class="text-control" @click="emit('dismiss-tts')">Не сейчас</button>
      </div>
    </div>

    <p v-if="speechError" class="feedback error" data-testid="companion-speech-error">{{ speechError }}</p>
    <p v-if="chatError" class="feedback error" data-testid="companion-chat-error">{{ chatError }}</p>
    <p v-if="outputError" class="feedback output" data-testid="companion-output-error">Ответ сохранён текстом. Озвучка недоступна.</p>

    <div class="primary-actions">
      <button
        type="button"
        class="round-control mic"
        data-testid="companion-mic"
        :class="{ active: speechBusy }"
        :disabled="transcribing || thinking"
        :aria-label="speechBusy ? 'Остановить диктовку' : 'Начать диктовку'"
        @click="emit('mic')"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
          <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z M5.5 11.5a6.5 6.5 0 0 0 13 0 M12 18v3 M9 21h6" />
        </svg>
      </button>
      <button
        v-if="speechBusy"
        type="button"
        class="text-control"
        data-testid="companion-cancel"
        @click="emit('cancel')"
      >Отмена</button>
      <button
        v-if="thinking"
        type="button"
        class="text-control danger grow"
        data-testid="companion-stop"
        :disabled="stopping"
        @click="emit('stop')"
      >{{ stopping ? 'Останавливаю…' : 'Остановить ход' }}</button>
      <button
        v-else
        type="button"
        class="text-control primary grow"
        data-testid="companion-send"
        :disabled="!canSend"
        @click="emit('send')"
      >Отправить</button>
    </div>

    <footer class="secondary-actions">
      <button
        type="button"
        class="icon-control"
        data-testid="companion-mute"
        :disabled="!outputAvailable"
        :aria-pressed="outputAvailable ? muted : true"
        :aria-label="!outputAvailable
          ? 'Озвучка недоступна в этом браузере'
          : (muted ? 'Включить озвучку ответов' : 'Выключить озвучку ответов')"
        :title="outputAvailable ? 'Озвучка средствами браузера' : 'Озвучка недоступна в этом браузере'"
        @click="emit('mute')"
      >{{ !outputAvailable || muted ? '🔇' : '🔊' }}</button>
      <span class="privacy">Озвучка выключена по умолчанию и хранится только на устройстве.</span>
      <button type="button" class="open-full" data-testid="companion-open-chat" @click="emit('open-chat')">
        {{ conflict ? 'Открыть список чатов' : 'Открыть разговор' }}
      </button>
    </footer>
  </section>
</template>

<style scoped>
.companion-bubble {
  width: min(390px, calc(100vw - 28px));
  max-height: min(620px, calc(100dvh - 110px));
  overflow: auto;
  padding: 15px;
  border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--line));
  border-radius: 18px;
  background:
    radial-gradient(circle at 88% 0, color-mix(in srgb, var(--accent) 11%, transparent), transparent 38%),
    var(--surface);
  color: var(--ink);
  box-shadow: 0 22px 62px #000c, inset 0 1px 0 #ffffff0d;
  transition: opacity .14s ease, transform .14s ease;
}
.bubble-head, .bubble-head > div, .primary-actions, .secondary-actions, .status-line { display: flex; align-items: center; }
.bubble-head { justify-content: space-between; gap: 12px; }
.bubble-head > div { min-width: 0; gap: 8px; flex-wrap: wrap; }
.bubble-head strong { font-size: 14px; }
.scope-chip {
  max-width: 190px;
  overflow: hidden;
  padding: 2px 8px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--ink-mid);
  background: var(--surface-2);
  font-size: 10.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Чипы «чем уйдёт ход» и «сколько накоплено» — тем же чипом, что и область:
   это справка, а не контрол, поэтому ни рамки-кнопки, ни курсора-указателя. */
.run-chip, .ctx-chip {
  padding: 2px 8px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--ink-mid);
  background: var(--surface-2);
  font-size: 10.5px;
  white-space: nowrap;
}
.run-chip { max-width: 170px; overflow: hidden; text-overflow: ellipsis; }
.ctx-chip { font-variant-numeric: tabular-nums; }
.ctx-chip.mid { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, var(--line)); }
.ctx-chip.hi { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 45%, var(--line)); }
.status-line { gap: 7px; min-height: 25px; margin: 8px 0; color: var(--ink-mid); font-size: 11.5px; }
.status-dot { width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--accent); }
.is-listening .status-dot { background: var(--bad); }
.is-transcribing .status-dot, .is-thinking .status-dot, .attention-wait .status-dot { background: var(--warn); }
.is-speaking .status-dot { background: var(--good); }
.attention-stall .status-dot { background: var(--bad); }
.wait-card {
  margin: 8px 0 10px;
  padding: 10px;
  border: 1px solid color-mix(in srgb, var(--warn) 42%, var(--line));
  border-radius: 11px;
  background: color-mix(in srgb, var(--warn) 8%, var(--surface-2));
}
.wait-card p, .speech-prompt p, .tts-consent p { margin: 0 0 8px; color: var(--ink-mid); font-size: 12px; line-height: 1.45; }
.last-reply {
  max-height: 164px;
  overflow: auto;
  margin: 8px 0 11px;
  padding: 10px 11px;
  border: 1px solid var(--line);
  border-radius: 11px;
  background: color-mix(in srgb, var(--surface-2) 78%, transparent);
  font-size: 12.5px;
  line-height: 1.5;
  white-space: pre-wrap;
}
.last-reply span { display: block; margin-bottom: 3px; color: var(--accent); font-size: 9.5px; font-weight: 720; letter-spacing: .08em; text-transform: uppercase; }
.composer-wrap { position: relative; display: block; }
textarea {
  display: block;
  width: 100%;
  min-height: 76px;
  max-height: 190px;
  resize: vertical;
  padding: 10px 11px;
  border: 1px solid var(--line-2);
  border-radius: 11px;
  outline: none;
  color: var(--ink);
  background: var(--ground);
  font: inherit;
  line-height: 1.45;
}
textarea:focus-visible { border-color: var(--accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 20%, transparent); }
.interim { display: block; padding: 4px 3px 0; color: var(--ink-mid); font-size: 11px; font-style: italic; }
.speech-prompt { margin-top: 9px; padding: 10px; border: 1px solid var(--line); border-radius: 11px; background: var(--surface-2); }
.speech-prompt .text-control + .text-control { margin-left: 6px; }
.tts-consent { margin-top: 9px; padding: 10px; border: 1px solid color-mix(in srgb, var(--accent) 38%, var(--line)); border-radius: 11px; background: var(--surface-2); }
.tts-consent strong { display: block; margin-bottom: 5px; font-size: 12.5px; }
.tts-consent > div { display: flex; gap: 6px; flex-wrap: wrap; }
.feedback { margin: 7px 0 0; font-size: 11px; }
.feedback.error { color: var(--bad); }
.feedback.output { color: var(--warn); }
.primary-actions { gap: 8px; margin-top: 10px; }
.secondary-actions { gap: 8px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line); }
.round-control, .icon-control, .text-control, .open-full {
  min-width: 44px;
  min-height: 44px;
  border: 1px solid var(--line);
  border-radius: 11px;
  color: var(--ink);
  background: var(--surface-2);
  cursor: pointer;
}
.round-control { display: grid; place-items: center; border-radius: 50%; }
.round-control svg { width: 20px; height: 20px; }
.round-control.active { border-color: var(--bad); color: var(--bad); }
.icon-control { display: grid; place-items: center; padding: 0; font-size: 18px; }
.icon-control.close { min-width: 44px; }
.text-control { padding: 8px 12px; font-size: 12px; }
.text-control.grow { flex: 1; }
.text-control.primary { border-color: color-mix(in srgb, var(--accent) 52%, var(--line)); color: var(--accent); }
.text-control.danger { border-color: color-mix(in srgb, var(--bad) 52%, var(--line)); color: var(--bad); }
.open-full { min-width: max-content; margin-left: auto; padding: 8px 11px; color: var(--accent); font-size: 11.5px; }
.privacy { max-width: 150px; color: var(--ink-mid); font-size: 9.5px; line-height: 1.3; }
button:hover:not(:disabled) { border-color: var(--line-2); }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
button:disabled { cursor: default; opacity: .48; }
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
@media (max-width: 430px) {
  .companion-bubble { padding: 13px; border-radius: 16px; }
  .privacy { display: none; }
  .open-full { margin-left: 0; flex: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .companion-bubble, button, textarea { animation: none !important; transition: none !important; }
}
</style>

<template>
  <div
    :id="id"
    class="companion-bubble"
    :class="[`is-${interaction}`, `attention-${attention?.kind || 'none'}`]"
    :data-interaction="interaction"
    :data-attention="attention?.kind || 'none'"
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
      <UiIconButton
        class="icon-control close"
        role="peer"
        label="Закрыть компаньона"
        title="Закрыть компаньона"
        @click="emit('close')"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.9"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      </UiIconButton>
    </header>

    <div :id="statusId" class="status-line" role="status" aria-live="polite" aria-atomic="true">
      <span class="status-dot" aria-hidden="true"></span>
      <span>{{ statusLabel }}</span>
    </div>

    <div v-if="attentionAction" class="wait-card" data-testid="companion-wait">
      <p>{{ attentionText }}</p>
      <UiButton
        class="text-control open-wait"
        variant="outline"
        tone="warning"
        @click="openAttentionDestination"
      >
        {{ attentionDestination === 'chats' ? 'Открыть чат' : 'Открыть конвейер' }}
      </UiButton>
    </div>

    <p v-if="lastReply" class="last-reply" data-testid="companion-reply">
      <span>Ответ</span>{{ lastReply }}
    </p>

    <label class="composer-wrap">
      <span class="visually-hidden">Сообщение компаньону</span>
      <UiTextarea
        ref="composer"
        v-model="draftModel"
        data-testid="companion-composer"
        rows="3"
        :aria-describedby="statusId"
        placeholder="Спроси о текущем экране…"
        @keydown="composerKey"
      />
      <span v-if="interim" class="interim" aria-hidden="true">{{ interim }}</span>
    </label>

    <div v-if="prompt === 'browser-consent'" class="speech-prompt">
      <p>Браузеру нужно один раз разрешить обработку речи на этом устройстве.</p>
      <div class="speech-actions">
        <UiButton
          class="text-control primary"
          variant="outline"
          tone="accent"
          @click="emit('consent-browser')"
        >
          Продолжить в браузере
        </UiButton>
        <UiButton class="text-control" @click="emit('use-whisper')">
          Использовать локальный Whisper
        </UiButton>
      </div>
    </div>
    <div v-else-if="prompt === 'browser-install'" class="speech-prompt">
      <p>Для языка диктовки нужен локальный пакет браузера.</p>
      <div class="speech-actions">
        <UiButton
          class="text-control primary"
          variant="outline"
          tone="accent"
          @click="emit('install-browser')"
        >
          Скачать и продолжить
        </UiButton>
        <UiButton class="text-control" @click="emit('use-whisper')">
          Использовать локальный Whisper
        </UiButton>
      </div>
    </div>

    <div v-if="ttsConsentPrompt" class="tts-consent" role="group" aria-labelledby="companion-tts-consent-title">
      <strong id="companion-tts-consent-title">Включить озвучку на этом устройстве?</strong>
      <p>
        Голос браузера или операционной системы может использовать внешний облачный сервис.
        Cockpit передаёт ему только сокращённый текст прямого голосового ответа; настройка
        сохраняется лишь на этом устройстве.
      </p>
      <div class="tts-actions">
        <UiButton
          class="text-control primary"
          variant="outline"
          tone="accent"
          data-testid="companion-tts-confirm"
          @click="emit('confirm-tts')"
        >
          Включить озвучку
        </UiButton>
        <UiButton class="text-control" @click="emit('dismiss-tts')">Не сейчас</UiButton>
      </div>
    </div>

    <UiInlineMessage
      v-if="speechError"
      class="feedback"
      tone="danger"
      data-testid="companion-speech-error"
    >
      {{ speechError }}
    </UiInlineMessage>
    <UiInlineMessage
      v-if="chatError"
      class="feedback"
      tone="danger"
      data-testid="companion-chat-error"
    >
      {{ chatError }}
    </UiInlineMessage>
    <UiInlineMessage
      v-if="outputError"
      class="feedback"
      tone="warning"
      data-testid="companion-output-error"
    >
      Ответ сохранён текстом. Озвучка недоступна.
    </UiInlineMessage>

    <div class="primary-actions">
      <UiIconButton
        class="round-control mic"
        role="peer"
        variant="outline"
        :tone="speechBusy ? 'danger' : 'neutral'"
        data-testid="companion-mic"
        :disabled="transcribing || thinking"
        :pressed="speechBusy"
        :label="speechBusy ? 'Остановить диктовку' : 'Начать диктовку'"
        :title="speechBusy ? 'Остановить диктовку' : 'Начать диктовку'"
        @click="emit('mic')"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
          <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z M5.5 11.5a6.5 6.5 0 0 0 13 0 M12 18v3 M9 21h6" />
        </svg>
      </UiIconButton>
      <UiButton
        v-if="speechBusy"
        class="text-control"
        data-testid="companion-cancel"
        @click="emit('cancel')"
      >
        Отмена
      </UiButton>
      <UiButton
        v-if="thinking"
        class="text-control danger grow"
        variant="outline"
        tone="danger"
        data-testid="companion-stop"
        :disabled="stopping"
        @click="emit('stop')"
      >
        {{ stopping ? 'Останавливаю…' : 'Остановить ход' }}
      </UiButton>
      <UiButton
        v-else
        class="text-control primary grow"
        variant="outline"
        tone="accent"
        data-testid="companion-send"
        :disabled="!canSend"
        @click="emit('send')"
      >
        Отправить
      </UiButton>
    </div>

    <footer class="secondary-actions">
      <UiIconButton
        class="icon-control"
        role="peer"
        data-testid="companion-mute"
        :disabled="!outputAvailable"
        :pressed="outputAvailable ? muted : true"
        :label="!outputAvailable
          ? 'Озвучка недоступна в этом браузере'
          : (muted ? 'Включить озвучку ответов' : 'Выключить озвучку ответов')"
        :title="outputAvailable ? 'Озвучка средствами браузера' : 'Озвучка недоступна в этом браузере'"
        @click="emit('mute')"
      >
        {{ !outputAvailable || muted ? '🔇' : '🔊' }}
      </UiIconButton>
      <span class="privacy">Озвучка выключена по умолчанию и хранится только на устройстве.</span>
      <UiButton
        class="open-full"
        variant="outline"
        tone="accent"
        data-testid="companion-open-chat"
        @click="emit('open-chat')"
      >
        {{ conflict ? 'Открыть список чатов' : 'Открыть разговор' }}
      </UiButton>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  UiButton,
  UiIconButton,
  UiInlineMessage,
  UiTextarea,
} from '../../ui';

interface CompanionAttention {
  kind: string;
  count: number;
}

interface CompanionContextView {
  percent: number;
  tone: string;
  title: string;
}

const props = withDefaults(
  defineProps<{
    id?: string;
    interim?: string;
    scopeLabel?: string;
    runLabel?: string;
    runTitle?: string;
    contextView?: CompanionContextView | null;
    interaction?: string;
    attention?: CompanionAttention;
    attentionDestination?: string;
    statusLabel?: string;
    lastReply?: string;
    speechBusy?: boolean;
    transcribing?: boolean;
    thinking?: boolean;
    stopping?: boolean;
    canSend?: boolean;
    muted?: boolean;
    outputAvailable?: boolean;
    ttsConsentPrompt?: boolean;
    prompt?: string;
    speechError?: string;
    chatError?: string;
    outputError?: string;
    conflict?: boolean;
  }>(),
  {
    id: 'cockpit-companion-bubble',
    interim: '',
    scopeLabel: 'Общий контекст',
    runLabel: '',
    runTitle: '',
    contextView: null,
    interaction: 'open',
    attention: () => ({ kind: 'none', count: 0 }),
    attentionDestination: '',
    statusLabel: 'Готов к сообщению',
    lastReply: '',
    speechBusy: false,
    transcribing: false,
    thinking: false,
    stopping: false,
    canSend: false,
    muted: true,
    outputAvailable: false,
    ttsConsentPrompt: false,
    prompt: '',
    speechError: '',
    chatError: '',
    outputError: '',
    conflict: false,
  },
);
const emit = defineEmits<{
  send: [];
  mic: [];
  cancel: [];
  stop: [];
  mute: [];
  'open-chat': [];
  close: [];
  'consent-browser': [];
  'use-whisper': [];
  'install-browser': [];
  'confirm-tts': [];
  'dismiss-tts': [];
  'open-pipeline': [];
}>();
const draftModel = defineModel<string>('draft', { default: '' });
const composer = ref<InstanceType<typeof UiTextarea> | null>(null);
const titleId = computed(() => `${props.id}-title`);
const statusId = computed(() => `${props.id}-status`);
const attentionAction = computed(
  () => Boolean(props.attentionDestination) && props.attention.kind !== 'none',
);
const attentionText = computed(() => {
  if (props.attentionDestination === 'chats') {
    return props.attention.kind === 'wait'
      ? 'Агент ждёт решения. Ответить на запрос безопасно можно в полном чате.'
      : 'В разговоре есть новый ответ.';
  }

  if (props.attention.kind === 'stall') {
    return 'В конвейере остановилась задача — открой его для диагностики.';
  }

  if (props.attention.kind === 'wait') {
    return 'Конвейер ждёт решения на воротах.';
  }

  return 'В конвейере продолжаются активные задачи.';
});

/*
 * Направление внимания задаёт host, а bubble лишь переводит его в одно из двух
 * публичных событий. Явная развилка не позволяет случайно эмитить произвольное имя.
 */
function openAttentionDestination(): void {
  if (props.attentionDestination === 'chats') {
    emit('open-chat');

    return;
  }

  emit('open-pipeline');
}

/*
 * Enter отправляет сообщение только как самостоятельный ввод: модификаторы,
 * перенос строки и незавершённая IME-композиция должны остаться внутри textarea.
 */
function composerKey(event: KeyboardEvent): void {
  const modified = event.shiftKey || event.altKey || event.ctrlKey || event.metaKey;

  if (event.key !== 'Enter' || modified || event.isComposing) {
    return;
  }

  event.preventDefault();

  if (props.canSend) {
    emit('send');
  }
}

defineExpose({
  focusComposer: () => composer.value?.focus(),
});
</script>

<style scoped>
.companion-bubble {
  width: 100%;
  min-width: 0;
  color: var(--ink);
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
.interim { display: block; padding: 4px 3px 0; color: var(--ink-mid); font-size: 11px; font-style: italic; }
.speech-prompt { margin-top: 9px; padding: 10px; border: 1px solid var(--line); border-radius: 11px; background: var(--surface-2); }
.speech-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.tts-consent { margin-top: 9px; padding: 10px; border: 1px solid color-mix(in srgb, var(--accent) 38%, var(--line)); border-radius: 11px; background: var(--surface-2); }
.tts-consent strong { display: block; margin-bottom: 5px; font-size: 12.5px; }
.tts-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.feedback { margin: 7px 0 0; }
.primary-actions { gap: 8px; margin-top: 10px; }
.secondary-actions { gap: 8px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line); }
.text-control.grow { flex: 1; }
.open-full { min-width: max-content; margin-left: auto; }
.privacy { max-width: 150px; color: var(--ink-mid); font-size: 9.5px; line-height: 1.3; }
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
  .privacy { display: none; }
  .open-full { margin-left: 0; flex: 1; }
}
</style>

<template>
  <!-- На /chats единственным полем ввода остаётся полная страница чата. -->
  <div v-if="hostVisible" class="companion-host">
    <UiFloatingDialog
      class="companion-floating-dialog"
      :open="bubbleVisible"
      label="Голосовой компаньон"
      focus-policy="none"
      placement="top-end"
      layer="companion"
      :offset="10"
      @update:open="setBubbleOpen"
    >
      <template #trigger>
        <CompanionAvatar
          :expanded="bubbleVisible"
          :controls="BUBBLE_ID"
          :interaction="companion.interaction"
          :attention="companion.attention"
        />
      </template>
      <template #default="{ close }">
        <CompanionBubble
          ref="bubble"
          :id="BUBBLE_ID"
          :draft="companion.draft"
          :interim="companion.dictationState.interim"
          :scope-label="scopeLabel"
          :run-label="runLabel"
          :run-title="runTitle"
          :context-view="contextView"
          :interaction="companion.interaction"
          :attention="companion.attention"
          :attention-destination="companion.attentionDestination"
          :status-label="companion.statusLabel"
          :last-reply="companion.lastReply"
          :speech-busy="companion.speechBusy"
          :transcribing="companion.transcribing"
          :thinking="companion.thinking"
          :stopping="companion.stopping"
          :can-send="companion.canSend"
          :muted="companion.muted"
          :output-available="companion.outputState.available"
          :tts-consent-prompt="companion.ttsConsentPrompt"
          :prompt="companion.dictationState.prompt || ''"
          :speech-error="companion.speechError"
          :chat-error="companion.chatError"
          :output-error="companion.outputError"
          :conflict="companion.chatErrorCode === 'companion_chat_conflict'"
          @update:draft="companion.setDraft"
          @send="companion.sendText"
          @mic="companion.toggleVoice"
          @cancel="companion.cancelVoice"
          @stop="companion.stopTurn"
          @mute="companion.toggleMute"
          @confirm-tts="companion.confirmTtsConsent"
          @dismiss-tts="companion.dismissTtsConsent"
          @open-chat="openConversation"
          @open-pipeline="router.push('/pipeline')"
          @close="close('action')"
          @consent-browser="companion.confirmBrowserConsent"
          @use-whisper="companion.useWhisper"
          @install-browser="companion.installBrowserLanguage"
        />
      </template>
    </UiFloatingDialog>
  </div>
</template>

<script setup>
import {
  computed,
  nextTick,
  onUnmounted,
  ref,
  watch,
  watchEffect,
} from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { UiFloatingDialog } from '../../ui';
import { useChatStore, CONTEXT_WINDOW } from '../../stores/chat.js';
import { useCompanionStore } from '../../stores/companion.js';
import { useProvidersStore } from '../../stores/providers.js';
import { contextFill } from '../../shared/chat-context.js';
import { useNotifyWatchStore } from '../../stores/notify-watch.js';
import { useUiContextStore } from '../../stores/ui-context.js';
import { useDictationController } from '../speech/provider.js';
import { createCompanionChatBridge } from './chat-bridge.js';
import { createSpeechOutput } from './speech-output.js';
import CompanionAvatar from './CompanionAvatar.vue';
import CompanionBubble from './CompanionBubble.vue';

const BUBBLE_ID = 'cockpit-companion-bubble';
const route = useRoute();
const router = useRouter();
const chat = useChatStore();
const companion = useCompanionStore();
const providers = useProvidersStore();
const notifyWatch = useNotifyWatchStore();
const uiContext = useUiContextStore();
const dictation = useDictationController();
const bubble = ref(null);

const bridge = createCompanionChatBridge({
  chat,
  uiContext,
  router,
  onTarget: (target) => companion.handleTarget(target),
});
const speechOutput = createSpeechOutput({
  language: () => chat.speech?.language || document.documentElement.lang || 'ru',
  onState: (snapshot) => companion.updateOutput(snapshot),
});
const disconnect = companion.connect({ bridge, dictation, output: speechOutput, chat });

const onChats = computed(() => route.path === '/chats');
const hostVisible = computed(() => companion.deviceEnabled && !onChats.value);
const bubbleVisible = computed(() => hostVisible.value && companion.bubbleOpen);
const capturedScope = computed(() => {
  try { return uiContext.capture(route).routingScope; }
  catch { return null; }
});
const scopeTaskId = computed(() => (
  capturedScope.value?.kind === 'task' ? String(capturedScope.value.taskId || '') : ''
));
const effectiveTaskId = computed(() => (
  companion.contextPinned ? (companion.pinnedTaskId || '') : scopeTaskId.value
));
const scopeLabel = computed(() => (effectiveTaskId.value ? `Задача #${effectiveTaskId.value}` : 'Общий контекст'));

// Чем именно уйдёт ход и сколько уже накоплено. Пузырь селекторов не содержит и
// содержать не будет (менять это — в «Настройки → Приложение → Голосовой компаньон»),
// но молчать об этом нельзя: история компаньона живёт долго и копится сама.
const companionSession = computed(() => {
  const id = companion.currentChatId;
  return id ? chat.session?.(id) : null;
});
// Владелец модели и усилия — server-owned настройка, а не запись разговора: она одна
// на общий и задачные чаты компаньона. Пустая настройка = модель по умолчанию из реестра.
const companionModel = computed(() => providers.modelOf(chat.companion?.modelRef || ''));
const companionEffort = computed(() => {
  const efforts = companionModel.value?.model?.efforts || [];
  const wanted = chat.companion?.effort || '';
  return efforts.includes(wanted) ? wanted : '';
});
const runLabel = computed(() => {
  const model = companionModel.value?.model;
  if (!model) return '';
  return [model.name || model.id, companionEffort.value].filter(Boolean).join(' · ');
});
const runTitle = computed(() => {
  // Настройка указывает на модель, которой в реестре сейчас нет (сняли CLI, обновился
  // каталог). Молчать об этом нельзя: ход не уйдёт вовсе, пока её не сменят.
  const configured = chat.companion?.modelRef;
  if (!runLabel.value) {
    return configured
      ? `Выбранной модели (${configured.provider}:${configured.model}) нет в реестре —`
        + ' ход не уйдёт. Смените её в «Настройки → Приложение → Голосовой компаньон».'
      : 'Модель определится при первом ходе';
  }
  // Режим компаньона всегда `plan`: быстрый ход только читает и отвечает.
  return `Ход уйдёт: ${runLabel.value} · режим «план». Модель и усилие меняются`
    + ' в «Настройки → Приложение → Голосовой компаньон»; режим у компаньона всегда «план».';
});
const contextView = computed(() => {
  const session = companionSession.value;
  if (!session) return null;
  const used = (session.sending && session.liveContext) || session.contextTokens || 0;
  if (!used) return null;
  const model = companionModel.value?.model;
  if (!session.contextWindow && model?.contextRuntimeOnly) return null;
  const fill = contextFill({
    tokens: used,
    window: session.contextWindow || model?.context || CONTEXT_WINDOW,
    compactWindow: chat.compactWindow || 0,
  });
  return {
    percent: fill.pct,
    tone: fill.tone,
    title: `Контекст: ${used.toLocaleString('ru')} из ${fill.limit.toLocaleString('ru')} `
      + `${fill.limitWhat} (${fill.pct}%). История компаньона копится — сжать или очистить`
      + ' можно на полной странице чатов.',
  };
});

watchEffect(() => {
  // Поля идентичности служат триггером подхвата после F5 только для чтения. Вызывать ensure/create
  // здесь нельзя: некорректные или дублирующиеся записи отвергает стор компаньона.
  for (const session of [...(chat.sessions || []), ...(chat.archived || [])]) {
    void session?.id;
    void session?.purpose;
    void session?.taskId;
    void session?.logicalIdentity;
  }
  companion.syncPageScope(scopeTaskId.value || null);
});
watch(() => companion.contextPinned, (pinned) => {
  if (!pinned) companion.syncPageScope(scopeTaskId.value || null);
}, { flush: 'sync' });

function exactAssistantReply() {
  const id = companion.currentChatId;
  const session = id ? chat.session?.(id) : null;
  if (!id || !session) return null;
  const messages = session?.messages || [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'assistant' || !String(message.text || '').trim()) continue;
    return {
      chatId: id,
      messageId: String(message.pid || message.id || `${id}:${index}:assistant`),
      text: String(message.text),
    };
  }
  // Авторитетно загруженный чат без ответа ассистента тоже означает смену состояния:
  // другое окно могло явно очистить именно эту историю.
  return { chatId: id, messageId: '', text: '' };
}

watchEffect(() => {
  const id = companion.currentChatId;
  const session = id ? chat.session?.(id) : null;
  companion.setAttentionSnapshot({
    pipeline: {
      waiting: notifyWatch.waiting,
      stalled: notifyWatch.stalled,
      silent: notifyWatch.silent,
      running: notifyWatch.running,
    },
    chat: {
      id: id || '',
      unread: !!session?.unread,
      pending: Object.values(chat.pending || {}),
    },
  });
});

watch(exactAssistantReply, (reply) => {
  if (reply) companion.syncReply(reply);
}, { deep: true, immediate: true });

function syncSurfaceVisibility() {
  companion.setSurfaceVisible(bubbleVisible.value && !document.hidden);
}
watch([bubbleVisible, () => companion.currentChatId], syncSurfaceVisibility, { immediate: true });
document.addEventListener('visibilitychange', syncSurfaceVisibility);

async function closeBubble() {
  await companion.closeBubble({ cancelVoice: true });
  companion.syncPageScope(scopeTaskId.value || null);
}

function setBubbleOpen(open) {
  if (open && !onChats.value) {
    companion.openBubble();

    return;
  }
  if (!open && companion.bubbleOpen) {
    void closeBubble();
  }
}

function openConversation() {
  void companion.openConversation(effectiveTaskId.value || null);
}

watch(bubbleVisible, (visible) => {
  if (!visible) {
    return;
  }

  nextTick(() => bubble.value?.focusComposer?.());
}, { immediate: true });

watch(onChats, (value) => {
  if (value && companion.bubbleOpen) void closeBubble();
}, { flush: 'sync' });
watch(() => companion.deviceEnabled, (enabled) => {
  if (!enabled && companion.bubbleOpen) void closeBubble();
}, { flush: 'sync' });

onUnmounted(() => {
  document.removeEventListener('visibilitychange', syncSurfaceVisibility);
  disconnect();
});
</script>

<style scoped>
.companion-host {
  position: fixed;
  right: calc(62px + env(safe-area-inset-right, 0px));
  bottom: calc(18px + env(safe-area-inset-bottom, 0px));
  z-index: 95;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 10px;
  pointer-events: none;
}
.companion-host > * { pointer-events: auto; }
@media (max-width: 899px) and (min-width: 760px) {
  .companion-host { right: calc(18px + env(safe-area-inset-right, 0px)); }
}
@media (max-width: 759px) {
  .companion-host {
    right: calc(10px + env(safe-area-inset-right, 0px));
    bottom: calc(72px + env(safe-area-inset-bottom, 0px));
    left: calc(10px + env(safe-area-inset-left, 0px));
  }
}
</style>

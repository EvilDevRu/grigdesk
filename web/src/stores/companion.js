import { computed, reactive, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import { reduceCompanionState } from '../features/companion/attention.js';

// Хранит локальное состояние пузыря компаньона, прямого хода, диктовки и озвучивания.
const EMPTY_DICTATION = Object.freeze({
  phase: 'idle', busy: false, prompt: null, interim: '', notice: '', error: null,
  blockedByOther: false,
});
const EMPTY_OUTPUT = Object.freeze({
  available: false,
  status: 'unavailable',
  enabled: false,
  muted: true,
  prefs: Object.freeze({
    enabled: true, ttsEnabled: false, ttsConsent: false, voiceURI: '', rate: 1, volume: 1,
  }),
  voices: Object.freeze([]),
});
const VOICE_PHASES = new Set(['preparing', 'installing', 'prompt', 'recording']);
const TRANSCRIBING_PHASES = new Set(['draining', 'transcribing']);

function messageOf(error, fallback) {
  return String(error?.message || error || fallback).slice(0, 240);
}

function finalPayload(value, meta) {
  // `onFinal(text, { generation })` — публичный контракт контроллера. Поддержка
  // краткоживущей объектной формы ничего не стоит и не даёт горячему обновлению во время хода
  // превратить корректный финальный результат в "[object Object]".
  if (value && typeof value === 'object') {
    return { text: String(value.text || ''), generation: value.generation ?? meta?.generation };
  }
  return { text: String(value || ''), generation: meta?.generation };
}

function appendPiece(base, piece) {
  const left = String(base || '');
  const right = String(piece || '').trim();
  if (!right) return left;
  return left ? `${left}${/\s$/u.test(left) ? '' : ' '}${right}` : right;
}

/**
 * Состояние компаньона, локальное для окна. Долговечная история целиком остаётся в сторе чата;
 * этот стор владеет только пузырём, одной арендой речи и идентичностью прямого локального хода.
 */
export const useCompanionStore = defineStore('companion', () => {
  const bubbleOpen = ref(false);
  const draft = ref('');
  const lastReply = ref('');
  const lastReplyId = ref('');
  const currentChatId = ref(null);
  const currentTaskId = ref(null);
  const contextPinned = ref(false);
  const pinnedTaskId = ref(null);
  const localThinking = ref(false);
  const stopping = ref(false);
  const chatError = ref('');
  const chatErrorCode = ref('');
  const chatConflictIds = ref([]);
  const speechError = ref('');
  const outputError = ref('');
  const ttsConsentPrompt = ref(false);
  const dictationState = reactive({ ...EMPTY_DICTATION });
  const outputState = reactive({ ...EMPTY_OUTPUT, prefs: { ...EMPTY_OUTPUT.prefs }, voices: [] });
  const attentionInput = ref({ pipeline: {}, chat: {} });
  const runtimeEpoch = ref(0);

  let bridge = null;
  let speechOutput = null;
  let speechLease = null;
  let chatStore = null;
  let chatSurface = null;
  let surfaceVisible = false;
  let bindingGeneration = 0;
  let scopeGeneration = 0;
  let audioEligibilityGeneration = 0;
  let voiceSequence = 0;
  let activeVoice = null;
  let pinnedIntent = null;
  let activeTargetToken = null;
  // Точная цель единственного локального хода модели. Навигация UI может сменить
  // currentChatId, пока запрос ещё выполняется; Stop не должен следовать за этой сменой.
  let activeTurnTarget = null;

  const listening = computed(() => VOICE_PHASES.has(dictationState.phase));
  const transcribing = computed(() => TRANSCRIBING_PHASES.has(dictationState.phase));
  const speechBusy = computed(() => !!dictationState.busy || listening.value || transcribing.value);
  const deviceEnabled = computed(() => outputState.prefs?.enabled !== false);
  const muted = computed(() => (typeof outputState.muted === 'boolean'
    ? outputState.muted
    : !(outputState.prefs?.ttsEnabled && outputState.prefs?.ttsConsent)));
  const thinking = computed(() => {
    runtimeEpoch.value;
    const session = currentChatId.value ? chatStore?.session?.(currentChatId.value) : null;
    return localThinking.value || (!!session?.sending && !session?.compacting);
  });
  const projection = computed(() => reduceCompanionState({
    ...attentionInput.value,
    interaction: {
      listening: listening.value,
      transcribing: transcribing.value,
      speaking: outputState.status === 'speaking',
      thinking: thinking.value,
      open: bubbleOpen.value,
    },
  }));
  const interaction = computed(() => projection.value.interaction);
  const attention = computed(() => projection.value.attention);
  const attentionDestination = computed(() => {
    if (attention.value.chatId) return 'chats';
    if (attention.value.taskIds?.length) return 'pipeline';
    return '';
  });
  const canSend = computed(() => !!draft.value.trim() && !speechBusy.value && !thinking.value);
  const statusLabel = computed(() => {
    if (speechError.value) return speechError.value.slice(0, 160);
    if (chatError.value) return chatError.value.slice(0, 160);
    if (interaction.value === 'listening') return dictationState.prompt ? 'Нужно выбрать способ диктовки' : 'Слушаю…';
    if (interaction.value === 'transcribing') return 'Распознаю речь…';
    if (interaction.value === 'thinking') return stopping.value ? 'Останавливаю ход…' : 'Думаю…';
    if (interaction.value === 'speaking') return 'Озвучиваю ответ…';
    if (attention.value.kind === 'stall') return 'Конвейер: есть остановившаяся задача';
    if (attention.value.kind === 'wait') return attentionDestination.value === 'chats'
      ? 'Нужно решение в полном чате' : 'Конвейер ждёт решения';
    if (attention.value.kind === 'info') return attentionDestination.value === 'chats'
      ? 'В разговоре есть новый ответ' : 'В конвейере есть активные задачи';
    if (dictationState.notice) return String(dictationState.notice).slice(0, 160);
    return bubbleOpen.value ? 'Готов к сообщению' : 'Компаньон свернут';
  });

  function clearChatFailure() {
    chatError.value = '';
    chatErrorCode.value = '';
    chatConflictIds.value = [];
  }

  function setChatFailure(error, fallback) {
    chatError.value = messageOf(error, fallback);
    chatErrorCode.value = String(error?.code || error?.data?.code || error?.data?.error || '');
    const conflicts = error?.conflicts || error?.data?.conflicts || [];
    chatConflictIds.value = Array.isArray(conflicts)
      ? conflicts.map((item) => String(item?.id || '')).filter(Boolean).slice(0, 16)
      : [];
  }

  function applyOutputSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    outputState.available = snapshot.available === true;
    outputState.status = String(snapshot.status || (outputState.available ? 'off' : 'unavailable'));
    outputState.enabled = snapshot.enabled === true;
    outputState.muted = typeof snapshot.muted === 'boolean'
      ? snapshot.muted
      : !(snapshot.prefs?.ttsEnabled && snapshot.prefs?.ttsConsent);
    outputState.prefs = { ...(snapshot.prefs || {}) };
    outputState.voices = Array.isArray(snapshot.voices) ? [...snapshot.voices] : [];
  }

  function refreshSurface() {
    chatSurface?.update?.({ chatId: currentChatId.value, visible: surfaceVisible });
    if (surfaceVisible && currentChatId.value) chatStore?.markRead?.(currentChatId.value);
  }

  function setCurrentChat(chatId, taskId = null) {
    const next = chatId == null || chatId === '' ? null : String(chatId);
    const changed = currentChatId.value !== next;
    currentChatId.value = next;
    currentTaskId.value = taskId == null || taskId === '' ? null : String(taskId);
    if (changed) speechOutput?.setChat?.(next);
    refreshSurface();
  }

  function clearCurrentChat() {
    if (!currentChatId.value && !lastReply.value && !lastReplyId.value) return false;
    currentChatId.value = null;
    lastReply.value = '';
    lastReplyId.value = '';
    speechOutput?.setChat?.(null);
    refreshSurface();
    return true;
  }

  function normalizeTaskId(taskId) {
    if (taskId == null || taskId === '') return null;
    const value = String(taskId).trim();
    return /^[1-9][0-9]{0,18}$/u.test(value) ? value : null;
  }

  function applyScope(taskId = null) {
    const nextTask = normalizeTaskId(taskId);
    if (currentTaskId.value === nextTask) return false;
    scopeGeneration += 1;
    activeTargetToken = null;
    currentTaskId.value = nextTask;
    activeVoice = null;
    activeTargetToken = null;
    if (speechBusy.value) void speechLease?.cancel?.();
    try { speechOutput?.cancel?.('scope-change'); } catch { /* Отменяется только локальная озвучка. */ }
    if (currentChatId.value) {
      clearCurrentChat();
    }
    return true;
  }

  function clearPinnedContext() {
    if (!contextPinned.value) return false;
    pinnedIntent = null;
    contextPinned.value = false;
    pinnedTaskId.value = null;
    return true;
  }

  function setScope(taskId = null) {
    clearPinnedContext();
    return applyScope(taskId);
  }

  function knownCompanion(taskId = null) {
    if (!chatStore) return null;
    const exactTask = normalizeTaskId(taskId);
    const identity = exactTask ? `companion:task:${exactTask}` : 'companion:global';
    const byId = new Map();
    for (const session of [...(chatStore.sessions || []), ...(chatStore.archived || [])]) {
      if (session?.id) byId.set(String(session.id), session);
    }
    const recordTask = (value) => {
      if (value === null || value === undefined) return { valid: true, value: null };
      const text = typeof value === 'string' ? value : '';
      return /^[1-9][0-9]{0,18}$/u.test(text)
        ? { valid: true, value: text }
        : { valid: false, value: null };
    };
    const relevant = [...byId.values()].filter((session) => {
      if (session?.purpose !== 'companion') return false;
      const parsed = recordTask(session.taskId);
      return session.logicalIdentity === identity || (parsed.valid && parsed.value === exactTask);
    });
    if (relevant.length !== 1) return null;
    const [session] = relevant;
    const parsed = recordTask(session.taskId);
    if (!parsed.valid || session.logicalIdentity !== identity || parsed.value !== exactTask) return null;
    return session;
  }

  function adoptKnownCompanion(taskId = currentTaskId.value) {
    if (contextPinned.value) return false;
    const known = knownCompanion(taskId);
    if (!known) return false;
    setCurrentChat(known.id, normalizeTaskId(taskId));
    return known.id;
  }

  function syncPageScope(taskId = null) {
    if (contextPinned.value) return false;
    const changed = applyScope(taskId);
    const adopted = adoptKnownCompanion(taskId);
    if (adopted) return adopted;
    const cleared = clearCurrentChat();
    return changed || cleared;
  }

  function setSurfaceVisible(visible) {
    const next = visible === true;
    if (surfaceVisible && !next) {
      audioEligibilityGeneration += 1;
      try { speechOutput?.cancel?.('surface-hidden'); } catch { /* Состояние текста переживает сбой озвучивания. */ }
    }
    surfaceVisible = next;
    refreshSurface();
  }

  function resetDictationState() {
    Object.assign(dictationState, EMPTY_DICTATION);
  }

  function cleanupRuntime({ close = true } = {}) {
    bindingGeneration += 1;
    activeVoice = null;
    pinnedIntent = null;
    contextPinned.value = false;
    pinnedTaskId.value = null;
    localThinking.value = false;
    stopping.value = false;
    activeTurnTarget = null;
    const lease = speechLease;
    speechLease = null;
    if (lease) void lease.release?.();
    chatSurface?.dispose?.();
    chatSurface = null;
    surfaceVisible = false;
    try { speechOutput?.cancel?.('unmount'); } catch { /* Визуальное состояние переживает сбой озвучивания. */ }
    try { speechOutput?.dispose?.(); } catch { /* Адаптер браузера вызывается по возможности. */ }
    speechOutput = null;
    bridge = null;
    chatStore = null;
    runtimeEpoch.value += 1;
    resetDictationState();
    ttsConsentPrompt.value = false;
    if (close) bubbleOpen.value = false;
  }

  async function sendTurn(text, { voiceTurnId = null, binding = bindingGeneration } = {}) {
    const normalized = String(text || '').trim();
    if (!normalized || !bridge || thinking.value) return false;
    localThinking.value = true;
    stopping.value = false;
    clearChatFailure();
    const sentDraft = draft.value;
    const turnScopeGeneration = scopeGeneration;
    const turnAudioEligibility = audioEligibilityGeneration;
    const targetToken = Object.freeze({ binding, scope: turnScopeGeneration, intent: pinnedIntent });
    const intendedTaskId = targetToken.intent
      ? normalizeTaskId(targetToken.intent.taskId)
      : currentTaskId.value;
    const turnTarget = {
      token: targetToken,
      // После привязки этот id намеренно не меняется из-за смены страницы или области.
      chatId: currentTaskId.value === intendedTaskId ? currentChatId.value : null,
    };
    activeTurnTarget = turnTarget;
    activeTargetToken = targetToken;
    try {
      const result = voiceTurnId
        ? await bridge.sendVoice(normalized, { voiceTurnId, intent: pinnedIntent, targetToken })
        : await bridge.sendText(normalized, { intent: pinnedIntent, targetToken });
      if (binding !== bindingGeneration) return false;
      const sameScope = turnScopeGeneration === scopeGeneration;
      if (sameScope) setCurrentChat(result?.chatId, result?.taskId);
      if (sameScope && result?.directReply) {
        // Текст сохраняется до необязательной озвучки: сбой или отключение TTS его не скрывает.
        lastReply.value = String(result.directReply);
        lastReplyId.value = String(result.messageId || '');
      }
      if (sameScope && result?.error) chatError.value = String(result.error).slice(0, 240);
      if (sameScope && result?.accepted && (!result.error || result.offline || result.directReply)
        && draft.value === sentDraft) draft.value = '';
      if (sameScope && voiceTurnId && result?.voiceTurnId === voiceTurnId && result.directReply
        && bubbleOpen.value && surfaceVisible
        && turnAudioEligibility === audioEligibilityGeneration) {
        try {
          speechOutput?.speak?.({
            role: 'assistant',
            text: result.directReply,
            chatId: result.chatId,
            messageId: result.messageId,
            voiceTurnId,
            speechSafe: result.speechSafe === true,
            // Отсутствующие метаданные не доказывают безопасность прямого ответа.
            steps: Array.isArray(result.steps) ? result.steps : [{ kind: 'unknown' }],
          });
        } catch (error) {
          outputError.value = messageOf(error, 'Не удалось озвучить ответ');
        }
      }
      return result?.accepted === true;
    } catch (error) {
      if (binding === bindingGeneration && turnScopeGeneration === scopeGeneration) {
        setChatFailure(error, 'Не удалось отправить сообщение');
      }
      return false;
    } finally {
      if (activeTargetToken === targetToken) activeTargetToken = null;
      if (activeTurnTarget === turnTarget) activeTurnTarget = null;
      if (binding === bindingGeneration) {
        localThinking.value = false;
        stopping.value = false;
      }
    }
  }

  function handleTarget({ chatId, taskId = null, targetToken = null } = {}) {
    if (!targetToken || targetToken.binding !== bindingGeneration || !chatId) return false;
    // Мост отправки сообщает точную цель до chat.sendTurn(). Запоминаем её для Stop
    // даже если явный openForTask() затем изменит видимую область.
    if (activeTurnTarget?.token === targetToken && !activeTurnTarget.chatId) {
      activeTurnTarget.chatId = String(chatId);
    }
    if (targetToken !== activeTargetToken || targetToken.scope !== scopeGeneration) return false;
    const exactTask = normalizeTaskId(taskId);
    if (exactTask !== currentTaskId.value) return false;
    setCurrentChat(chatId, exactTask);
    return true;
  }

  async function acceptFinal(value, meta, ownBinding) {
    const payload = finalPayload(value, meta);
    const turn = activeVoice;
    if (!turn || turn.binding !== ownBinding || ownBinding !== bindingGeneration || turn.sent) return false;
    if (payload.generation != null && turn.finalGeneration != null
      && payload.generation !== turn.finalGeneration) return false;
    turn.finalGeneration = payload.generation ?? turn.finalGeneration;
    turn.sent = true;
    activeVoice = null;
    const finalText = payload.text.trim();
    if (!finalText) return false;
    // Боевые контроллеры передают каждый устойчивый фрагмент через onCommit до
    // итоговой сводки. Сохраняем ранний текст и правки человека; старый или тестовый
    // контроллер, который вызывает только onFinal, всё равно добавляет расшифровку один раз.
    if (!turn.committed) draft.value = appendPiece(draft.value, finalText);
    const text = draft.value.trim();
    if (!text) return false;
    return sendTurn(text, { voiceTurnId: turn.id, binding: ownBinding });
  }

  function connect({ bridge: nextBridge, dictation, output, chat }) {
    if (!nextBridge?.sendText || !nextBridge?.sendVoice || !dictation?.acquire) {
      throw new TypeError('Companion runtime требует chat bridge и dictation controller');
    }
    cleanupRuntime({ close: false });
    const ownBinding = bindingGeneration;
    bridge = nextBridge;
    speechOutput = output || null;
    chatStore = chat || null;
    runtimeEpoch.value += 1;
    chatSurface = chatStore?.registerSurface?.('companion-bubble', {
      chatId: currentChatId.value,
      visible: false,
    }) || null;
    if (currentChatId.value) speechOutput?.setChat?.(currentChatId.value);
    applyOutputSnapshot(speechOutput?.snapshot?.());
    speechLease = dictation.acquire(Symbol('companion'), {
      onState(snapshot) {
        if (ownBinding !== bindingGeneration || !snapshot) return;
        Object.assign(dictationState, snapshot);
      },
      onInterim(text) {
        if (ownBinding === bindingGeneration) dictationState.interim = String(text || '');
      },
      onCommit(piece) {
        if (ownBinding !== bindingGeneration || !activeVoice) return;
        activeVoice.committed = true;
        draft.value = appendPiece(draft.value, piece);
      },
      onFinal(value, meta) { void acceptFinal(value, meta, ownBinding); },
      onError(error) {
        if (ownBinding !== bindingGeneration) return;
        // CAS согласия (409) намеренно возвращает к тому же живому запросу и ходу. Сохраняем
        // локальную голосовую идентичность, чтобы повторное явное подтверждение всё ещё дало
        // один финальный результат; терминальные ошибки очищают её как обычно.
        if (dictationState.prompt !== 'browser-consent') activeVoice = null;
        speechError.value = messageOf(error, 'Диктовка завершилась с ошибкой');
      },
    });
    Object.assign(dictationState, speechLease.state || EMPTY_DICTATION);
    refreshSurface();
    let disposed = false;
    return () => {
      if (disposed || ownBinding !== bindingGeneration) return false;
      disposed = true;
      cleanupRuntime();
      return true;
    };
  }

  function updateOutput(snapshot) {
    applyOutputSnapshot(snapshot);
  }

  function setAttentionSnapshot({ pipeline = {}, chat = {} } = {}) {
    attentionInput.value = { pipeline, chat };
  }

  function openBubble() {
    bubbleOpen.value = true;
    clearChatFailure();
  }

  async function closeBubble({ cancelVoice = true } = {}) {
    bubbleOpen.value = false;
    // Отменяем прямой локальный голосовой ответ, даже если тест или встраивание ещё не
    // опубликовали видимость поверхности. Повторное открытие не должно оживить его поздний звук.
    audioEligibilityGeneration += 1;
    setSurfaceVisible(false);
    try { speechOutput?.cancel?.('bubble-close'); } catch { /* Текст остаётся видимым. */ }
    ttsConsentPrompt.value = false;
    if (cancelVoice && speechBusy.value) await cancelVoiceTurn();
    clearPinnedContext();
  }

  function toggleBubble() {
    if (bubbleOpen.value) void closeBubble();
    else openBubble();
  }

  function setDraft(value) {
    draft.value = String(value || '');
  }

  async function sendText() {
    if (speechBusy.value || thinking.value) return false;
    return sendTurn(draft.value);
  }

  async function startVoice() {
    if (!speechLease || speechBusy.value || thinking.value || dictationState.blockedByOther) return false;
    speechError.value = '';
    outputError.value = '';
    // Это должно быть синхронно и до `start()`: тот уже может захватить оборудование.
    speechOutput?.micStart?.();
    const turn = {
      id: `voice-${Date.now().toString(36)}-${(++voiceSequence).toString(36)}`,
      binding: bindingGeneration,
      sent: false,
      committed: false,
      finalGeneration: null,
    };
    activeVoice = turn;
    try {
      const started = await speechLease.start();
      if (started === false && activeVoice === turn) activeVoice = null;
      return started !== false;
    } catch (error) {
      if (activeVoice === turn) activeVoice = null;
      speechError.value = messageOf(error, 'Не удалось запустить диктовку');
      return false;
    }
  }

  async function stopVoice() {
    if (!speechLease || !speechBusy.value || transcribing.value) return false;
    if (dictationState.prompt) return cancelVoiceTurn();
    return speechLease.stop?.() ?? false;
  }

  async function cancelVoiceTurn() {
    activeVoice = null;
    return speechLease?.cancel?.() ?? false;
  }

  function toggleVoice() {
    if (speechBusy.value) return stopVoice();
    return startVoice();
  }

  async function stopTurn() {
    if (!thinking.value || stopping.value || !bridge) return false;
    // Пока существует локальный ход, отсутствие его цели закрывает действие: переход к
    // только что показанному разговору мог бы остановить постороннего агента.
    const exact = activeTurnTarget
      ? activeTurnTarget.chatId
      : currentChatId.value;
    if (!exact) return false;
    stopping.value = true;
    try { return await bridge.stop(exact); }
    finally { if (!thinking.value) stopping.value = false; }
  }

  async function openConversation(taskId = currentTaskId.value) {
    if (!bridge) return false;
    if (chatErrorCode.value === 'companion_chat_conflict') {
      try { return await bridge.openList?.(); }
      catch (error) { setChatFailure(error, 'Не удалось открыть список чатов'); return false; }
    }
    const requestedTask = normalizeTaskId(taskId);
    let intentGeneration = scopeGeneration;
    let targetToken = null;
    try {
      if (currentTaskId.value !== requestedTask) {
        setScope(requestedTask);
        intentGeneration = scopeGeneration;
      }
      let exact = currentChatId.value;
      if (!exact) {
        targetToken = Object.freeze({ binding: bindingGeneration, scope: intentGeneration, intent: pinnedIntent });
        activeTargetToken = targetToken;
        exact = requestedTask
          ? await bridge.openForTask(requestedTask, { targetToken })
          : await bridge.openGlobal({ targetToken });
        if (intentGeneration !== scopeGeneration || currentTaskId.value !== requestedTask) {
          if (activeTargetToken === targetToken) activeTargetToken = null;
          return false;
        }
        setCurrentChat(exact, requestedTask);
      }
      if (intentGeneration !== scopeGeneration || currentTaskId.value !== requestedTask) {
        if (activeTargetToken === targetToken) activeTargetToken = null;
        return false;
      }
      if (activeTargetToken === targetToken) activeTargetToken = null;
      return await bridge.openConversation(exact);
    } catch (error) {
      if (activeTargetToken === targetToken) activeTargetToken = null;
      if (intentGeneration === scopeGeneration) {
        setChatFailure(error, 'Не удалось открыть разговор');
      }
      return false;
    }
  }

  async function openForTask(taskId) {
    const exactTask = String(taskId || '').trim();
    if (!/^[1-9][0-9]{0,18}$/u.test(exactTask) || !bridge) return false;
    let targetToken = null;
    let intentGeneration = scopeGeneration;
    try {
      const intent = bridge.captureTaskIntent?.(exactTask);
      if (!intent) throw new Error('Не удалось зафиксировать контекст задачи.');
      pinnedIntent = intent;
      contextPinned.value = true;
      pinnedTaskId.value = exactTask;
      applyScope(exactTask);
      openBubble();
      intentGeneration = scopeGeneration;
      targetToken = Object.freeze({ binding: bindingGeneration, scope: intentGeneration, intent });
      activeTargetToken = targetToken;
      const exact = await bridge.openForTask(exactTask, { targetToken });
      if (intentGeneration !== scopeGeneration || !contextPinned.value
        || pinnedIntent !== intent || currentTaskId.value !== exactTask) {
        if (activeTargetToken === targetToken) activeTargetToken = null;
        return false;
      }
      setCurrentChat(exact, exactTask);
      if (activeTargetToken === targetToken) activeTargetToken = null;
      return exact;
    } catch (error) {
      if (activeTargetToken === targetToken) activeTargetToken = null;
      if (intentGeneration === scopeGeneration) {
        setChatFailure(error, 'Не удалось открыть companion-чат задачи');
      }
      return false;
    }
  }

  async function openGlobal() {
    if (!bridge) return false;
    let targetToken = null;
    let intentGeneration = scopeGeneration;
    try {
      const intent = bridge.captureGlobalIntent?.();
      if (!intent) throw new Error('Не удалось зафиксировать общий контекст.');
      pinnedIntent = intent;
      contextPinned.value = true;
      pinnedTaskId.value = null;
      applyScope(null);
      openBubble();
      intentGeneration = scopeGeneration;
      targetToken = Object.freeze({ binding: bindingGeneration, scope: intentGeneration, intent });
      activeTargetToken = targetToken;
      const exact = await bridge.openGlobal({ targetToken });
      if (intentGeneration !== scopeGeneration || !contextPinned.value
        || pinnedIntent !== intent || currentTaskId.value !== null) {
        if (activeTargetToken === targetToken) activeTargetToken = null;
        return false;
      }
      setCurrentChat(exact, null);
      if (activeTargetToken === targetToken) activeTargetToken = null;
      return exact;
    } catch (error) {
      if (activeTargetToken === targetToken) activeTargetToken = null;
      if (intentGeneration === scopeGeneration) {
        setChatFailure(error, 'Не удалось открыть общий companion-чат');
      }
      return false;
    }
  }

  function confirmBrowserConsent() {
    speechError.value = '';
    return speechLease?.confirmBrowserConsent?.() ?? false;
  }

  function useWhisper() {
    speechError.value = '';
    return speechLease?.useWhisper?.() ?? false;
  }

  function installBrowserLanguage() {
    speechError.value = '';
    return speechLease?.installBrowserLanguage?.() ?? false;
  }

  function toggleMute() {
    if (!speechOutput || !outputState.available) return false;
    outputError.value = '';
    try {
      if (muted.value && outputState.prefs?.ttsConsent !== true) {
        ttsConsentPrompt.value = true;
        return true;
      }
      let snapshot;
      if (!muted.value) snapshot = speechOutput.mute?.();
      else if (outputState.prefs?.ttsEnabled === true) snapshot = speechOutput.unmute?.();
      else snapshot = speechOutput.enable?.();
      applyOutputSnapshot(snapshot || speechOutput.snapshot?.());
      return true;
    } catch (error) {
      outputError.value = messageOf(error, 'Не удалось изменить озвучку');
      return false;
    }
  }

  function confirmTtsConsent() {
    if (!speechOutput || !ttsConsentPrompt.value) return false;
    outputError.value = '';
    try {
      const snapshot = speechOutput.enable?.();
      applyOutputSnapshot(snapshot || speechOutput.snapshot?.());
      ttsConsentPrompt.value = false;
      return true;
    } catch (error) {
      outputError.value = messageOf(error, 'Не удалось включить озвучку');
      return false;
    }
  }

  function dismissTtsConsent() {
    ttsConsentPrompt.value = false;
  }

  function setTtsEnabled(enabled) {
    if (!speechOutput) return false;
    outputError.value = '';
    try {
      if (enabled === true && outputState.prefs?.ttsConsent !== true) {
        ttsConsentPrompt.value = true;
        return true;
      }
      const snapshot = enabled === true ? speechOutput.enable?.() : speechOutput.disable?.();
      applyOutputSnapshot(snapshot || speechOutput.snapshot?.());
      if (enabled !== true) ttsConsentPrompt.value = false;
      return true;
    } catch (error) {
      outputError.value = messageOf(error, 'Не удалось изменить озвучку');
      return false;
    }
  }

  function setOutputPrefs(patch = {}) {
    if (!speechOutput || !patch || typeof patch !== 'object') return false;
    const safe = {};
    if (Object.hasOwn(patch, 'voiceURI')) safe.voiceURI = String(patch.voiceURI || '');
    if (Object.hasOwn(patch, 'rate')) safe.rate = Number(patch.rate);
    if (Object.hasOwn(patch, 'volume')) safe.volume = Number(patch.volume);
    if (!Object.keys(safe).length) return false;
    outputError.value = '';
    try {
      const snapshot = speechOutput.updatePrefs?.(safe);
      applyOutputSnapshot(snapshot || speechOutput.snapshot?.());
      return true;
    } catch (error) {
      outputError.value = messageOf(error, 'Не удалось сохранить параметры голоса');
      return false;
    }
  }

  function setDeviceEnabled(enabled) {
    if (!speechOutput) return false;
    try {
      const snapshot = speechOutput.updatePrefs?.({ enabled: enabled === true });
      applyOutputSnapshot(snapshot || speechOutput.snapshot?.());
      if (!deviceEnabled.value) void closeBubble({ cancelVoice: true });
      return true;
    } catch (error) {
      outputError.value = messageOf(error, 'Не удалось изменить состояние компаньона');
      return false;
    }
  }

  function syncReply({ chatId, messageId = '', text = '' } = {}) {
    if (!currentChatId.value || String(chatId || '') !== currentChatId.value) return false;
    const next = String(text);
    if (!next.trim()) {
      const changed = !!lastReply.value || !!lastReplyId.value;
      lastReply.value = '';
      lastReplyId.value = '';
      return changed;
    }
    lastReply.value = next;
    lastReplyId.value = String(messageId || '');
    return true;
  }

  watch(thinking, (active) => {
    if (!active) stopping.value = false;
  });

  return {
    bubbleOpen,
    draft,
    lastReply,
    lastReplyId,
    currentChatId,
    currentTaskId,
    contextPinned,
    pinnedTaskId,
    thinking,
    stopping,
    chatError,
    chatErrorCode,
    chatConflictIds,
    speechError,
    outputError,
    ttsConsentPrompt,
    dictationState,
    outputState,
    listening,
    transcribing,
    speechBusy,
    deviceEnabled,
    muted,
    interaction,
    attention,
    attentionDestination,
    canSend,
    statusLabel,
    connect,
    handleTarget,
    updateOutput,
    setAttentionSnapshot,
    setSurfaceVisible,
    setScope,
    syncPageScope,
    adoptKnownCompanion,
    clearPinnedContext,
    setCurrentChat,
    openBubble,
    closeBubble,
    toggleBubble,
    setDraft,
    sendText,
    startVoice,
    stopVoice,
    cancelVoice: cancelVoiceTurn,
    toggleVoice,
    stopTurn,
    openForTask,
    openGlobal,
    openConversation,
    confirmBrowserConsent,
    useWhisper,
    installBrowserLanguage,
    toggleMute,
    setTtsEnabled,
    setOutputPrefs,
    confirmTtsConsent,
    dismissTtsConsent,
    setDeviceEnabled,
    syncReply,
  };
});

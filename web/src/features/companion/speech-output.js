import {
  DEVICE_PREFS_KEY,
  readDevicePrefs,
  updateDevicePrefs,
} from './device-prefs.js';
import { spokenText } from './spoken-text.js';

// Управляет браузерной озвучкой безопасных ответов компаньона и её локальными настройками.
const SPOKEN_CACHE_LIMIT = 256;
const BENIGN_STEP_KINDS = new Set(['start', 'text', 'think']);

/**
 * Метаданные шагов исполнителя образуют белый список, а не общий запрет. Обычный ответ всегда
 * содержит шаги жизненного цикла и текста провайдера; озвучивание запрещают лишь действия,
 * результаты, служебные уведомления и неизвестная форма. Проверяются и `k` (текущий нормализатор),
 * и `kind` (старые метаданные взаимодействия), чтобы конфликтующий алиас не скрыл небезопасный шаг.
 */
function speechSafeSteps(steps) {
  if (steps == null) return true;
  if (!Array.isArray(steps)) return false;
  return steps.every((step) => {
    if (!step || typeof step !== 'object') return false;
    const kinds = ['k', 'kind']
      .filter((key) => Object.hasOwn(step, key))
      .map((key) => step[key]);
    return kinds.length > 0
      && kinds.every((kind) => typeof kind === 'string' && BENIGN_STEP_KINDS.has(kind));
  });
}

function speechLanguage(value) {
  const language = String(typeof value === 'function' ? value() : value || '').toLowerCase();
  if (language.startsWith('en')) return 'en-US';
  return 'ru-RU';
}

export function createSpeechOutput({
  synthesis = globalThis.speechSynthesis,
  Utterance = globalThis.SpeechSynthesisUtterance,
  storage = globalThis.localStorage,
  documentRef = globalThis.document,
  eventTarget = globalThis.window,
  language = () => 'ru',
  onState = null,
} = {}) {
  const available = !!synthesis?.speak && !!synthesis?.cancel && typeof Utterance === 'function';
  let prefs = readDevicePrefs(storage);
  let status = available ? 'off' : 'unavailable';
  let voices = available ? (synthesis.getVoices?.() || []) : [];
  let generation = 0;
  let currentChatId = null;
  // Приглушение намеренно ограничено текущим документом. Долговечная настройка `ttsEnabled`
  // отвечает, разрешён ли звук на устройстве; быстрое приглушение в пузыре не должно молча выключать
  // эту настройку во всех будущих вкладках.
  let windowMuted = false;
  let disposed = false;
  const spoken = new Set();

  const effectiveEnabled = () => available && prefs.enabled && prefs.ttsEnabled
    && prefs.ttsConsent && !windowMuted;
  const emit = () => {
    if (!available) status = 'unavailable';
    else if (!effectiveEnabled() && status !== 'speaking') status = 'off';
    try { onState?.(snapshot()); } catch { /* Обратный вызов UI не ломает жизненный цикл озвучивания. */ }
  };
  const remember = (key) => {
    if (spoken.has(key)) return false;
    spoken.add(key);
    if (spoken.size > SPOKEN_CACHE_LIMIT) spoken.delete(spoken.values().next().value);
    return true;
  };
  const updateVoices = () => { voices = synthesis?.getVoices?.() || []; emit(); };
  const onVisibility = () => { if (documentRef?.hidden) cancel('hidden'); };
  const onStorage = (event = {}) => {
    if (disposed || (event.key != null && event.key !== DEVICE_PREFS_KEY)) return;
    const next = readDevicePrefs(storage);
    if (JSON.stringify(next) === JSON.stringify(prefs)) return;
    const wasSpeaking = status === 'speaking';
    prefs = next;
    // Запрет звука на всём устройстве из другой вкладки должен остановить уже поставленную
    // в очередь озвучку. Смена голоса, скорости или громкости также отменяет старую реплику,
    // а не доигрывает её с устаревшими настройками; следующий прямой голосовой ход возьмёт новые.
    if (wasSpeaking || !effectiveEnabled()) cancel('storage');
    else {
      status = effectiveEnabled() ? 'idle' : (available ? 'off' : 'unavailable');
      emit();
    }
  };

  function snapshot() {
    return Object.freeze({
      available,
      status,
      enabled: effectiveEnabled(),
      muted: !available || windowMuted || !prefs.ttsEnabled || !prefs.ttsConsent,
      prefs: Object.freeze({ ...prefs }),
      voices: Object.freeze(voices.map((voice) => ({
        voiceURI: voice.voiceURI || '', name: voice.name || '', lang: voice.lang || '',
      }))),
    });
  }

  function cancel(_reason = 'cancel') {
    generation += 1;
    try { synthesis?.cancel?.(); } catch { /* По возможности используем API браузера. */ }
    status = effectiveEnabled() ? 'idle' : (available ? 'off' : 'unavailable');
    emit();
  }

  function updatePrefs(patch) {
    const wasEnabled = effectiveEnabled();
    prefs = updateDevicePrefs(storage, prefs, patch);
    if (wasEnabled && !effectiveEnabled()) cancel('prefs');
    else {
      status = effectiveEnabled() ? (status === 'speaking' ? status : 'idle') : (available ? 'off' : 'unavailable');
      emit();
    }
    return snapshot();
  }

  function mute() {
    if (!windowMuted) {
      windowMuted = true;
      cancel('window-mute');
    } else {
      emit();
    }
    return snapshot();
  }

  function unmute() {
    windowMuted = false;
    status = effectiveEnabled() ? 'idle' : (available ? 'off' : 'unavailable');
    emit();
    return snapshot();
  }

  function enable() {
    windowMuted = false;
    return updatePrefs({ ttsEnabled: true, ttsConsent: true });
  }

  function disable() {
    windowMuted = false;
    return updatePrefs({ ttsEnabled: false });
  }

  function chooseVoice(lang) {
    const selected = prefs.voiceURI && voices.find((voice) => voice.voiceURI === prefs.voiceURI);
    if (selected) return selected;
    const exact = voices.find((voice) => String(voice.lang || '').toLowerCase() === lang.toLowerCase());
    if (exact) return exact;
    const base = lang.split('-')[0].toLowerCase();
    return voices.find((voice) => String(voice.lang || '').toLowerCase().startsWith(`${base}-`)) || null;
  }

  function speak(message = {}) {
    if (disposed || !effectiveEnabled() || documentRef?.hidden) return false;
    // Монотонный флаг выставляет сервер во время хода.
    // Ограниченный скользящий хвост шагов не доказывает отсутствие раннего инструмента, вопроса
    // или разрешения, поэтому отсутствие явного безопасного вердикта закрывает озвучивание.
    if (message.role !== 'assistant' || message.kind || message.speechSafe !== true
      || !speechSafeSteps(message.steps)) return false;
    const voiceTurnId = String(message.voiceTurnId || '');
    const chatId = String(message.chatId || '');
    const messageId = String(message.messageId || '');
    if (!voiceTurnId || !chatId || !messageId) return false;
    if (currentChatId && currentChatId !== chatId) return false;
    const text = spokenText(message.text);
    if (!text) return false;
    const identity = `${voiceTurnId}:${chatId}:${messageId}`;
    if (!remember(identity)) return false;

    cancel('replace');
    const ownGeneration = ++generation;
    currentChatId = chatId;
    const utterance = new Utterance(text);
    const lang = speechLanguage(language);
    utterance.lang = lang;
    utterance.rate = prefs.rate;
    utterance.volume = prefs.volume;
    const voice = chooseVoice(lang);
    if (voice) utterance.voice = voice;
    utterance.onend = () => {
      if (disposed || ownGeneration !== generation) return;
      status = effectiveEnabled() ? 'idle' : 'off';
      emit();
    };
    utterance.onerror = utterance.onend;
    status = 'speaking';
    emit();
    try {
      synthesis.speak(utterance);
      return true;
    } catch {
      if (ownGeneration === generation) {
        generation += 1;
        status = effectiveEnabled() ? 'idle' : 'off';
        emit();
      }
      return false;
    }
  }

  if (available) synthesis.addEventListener?.('voiceschanged', updateVoices);
  documentRef?.addEventListener?.('visibilitychange', onVisibility);
  eventTarget?.addEventListener?.('storage', onStorage);
  status = effectiveEnabled() ? 'idle' : (available ? 'off' : 'unavailable');
  emit();

  return Object.freeze({
    snapshot,
    speak,
    cancel,
    micStart() { cancel('mic'); },
    setChat(chatId) {
      const next = chatId == null ? null : String(chatId);
      if (currentChatId !== next) cancel('chat-change');
      currentChatId = next;
    },
    updatePrefs,
    mute,
    unmute,
    enable,
    disable,
    dispose() {
      if (disposed) return;
      disposed = true;
      synthesis?.removeEventListener?.('voiceschanged', updateVoices);
      documentRef?.removeEventListener?.('visibilitychange', onVisibility);
      eventTarget?.removeEventListener?.('storage', onStorage);
      cancel('dispose');
    },
  });
}

// Единый контроллер диктовки: управляет захватом речи, распознаванием и состоянием всех потребителей UI.
import { reactive, readonly } from 'vue';
import { api as defaultApi } from '../../shared/apiClient.ts';
import { createSpeechStream } from '../../shared/speech-stream.js';

const DEFAULT_BROWSER_DRAIN_TIMEOUT_MS = 1800;
const DEFAULT_LOCAL_STREAM_LAG_NOTICE_MS = 4000;
const DEFAULT_LOCAL_RECORDER_STOP_TIMEOUT_MS = 2000;
const DEFAULT_LOCAL_WARMUP_TIMEOUT_MS = 1500;

const FALLBACK_SPEECH = Object.freeze({
  engine: 'browser',
  browserProcessing: 'auto',
  browserAutoConsent: false,
  language: 'auto',
  dictionary: '',
  local: Object.freeze({ ready: false, reason: '' }),
  revision: '',
});

const EXECUTION_FIELDS = Object.freeze([
  'revision',
  'engine',
  'browserProcessing',
  'browserAutoConsent',
  'language',
  'dictionary',
  'quality',
  'model',
  'device',
  'computeType',
  'beamSize',
  'vadSilenceMs',
  'conditionOnPreviousText',
]);

export function speechExecutionFingerprint(value) {
  const speech = value && typeof value === 'object' ? value : FALLBACK_SPEECH;
  return JSON.stringify(EXECUTION_FIELDS.map((field) => speech[field] ?? null));
}

function speechError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeCall(callback, ...args) {
  if (typeof callback !== 'function') return;
  try { callback(...args); } catch { /* consumer не должен ломать cleanup речи */ }
}

function normalizedPiece(value) {
  return String(value || '').trim();
}

function joinPieces(parts) {
  return parts.map(normalizedPiece).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function responseSnapshot(response) {
  const raw = response?.speech || response?.settings || response;
  if (!raw || typeof raw !== 'object') return null;
  return {
    ...raw,
    revision: raw.revision ?? response?.revision,
    local: raw.local || response?.capabilities?.local,
  };
}

function browserErrorText(error) {
  const texts = {
    'not-allowed': 'Нет доступа к микрофону.',
    'audio-capture': 'Браузер не нашёл доступный микрофон.',
    'language-not-supported': 'Браузер не поддерживает выбранный язык.',
    'service-not-allowed': 'Сервис распознавания браузера недоступен.',
    network: 'Браузерное распознавание не доступно из-за сети.',
  };
  return texts[error] || `Браузерное распознавание завершилось с ошибкой: ${error}.`;
}

function defaultBrowser() {
  return {
    isSecureContext: () => globalThis.window?.isSecureContext !== false,
    recognitionCtor: () => globalThis.window?.SpeechRecognition
      || globalThis.window?.webkitSpeechRecognition || null,
    phraseCtor: () => globalThis.window?.SpeechRecognitionPhrase || null,
    uiLanguage: () => globalThis.document?.documentElement?.lang
      || globalThis.navigator?.language || 'ru-RU',
  };
}

function defaultMedia() {
  return {
    getUserMedia: (constraints) => globalThis.navigator?.mediaDevices?.getUserMedia?.(constraints),
    hasGetUserMedia: () => typeof globalThis.navigator?.mediaDevices?.getUserMedia === 'function',
    recorderCtor: () => globalThis.window?.MediaRecorder || null,
    BlobCtor: globalThis.Blob,
    FormDataCtor: globalThis.FormData,
    AbortControllerCtor: globalThis.AbortController,
  };
}

function defaultLocalStream() {
  return {
    supported: () => typeof globalThis.window?.WebSocket === 'function'
      && typeof (globalThis.window?.AudioContext || globalThis.window?.webkitAudioContext) === 'function'
      && typeof globalThis.window?.AudioWorkletNode === 'function',
    open: (options) => createSpeechStream(options),
  };
}

function defaultClock() {
  return {
    now: () => Date.now(),
    randomUUID: () => globalThis.crypto?.randomUUID?.() || '',
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: (timer) => clearTimeout(timer),
  };
}

/**
 * Единая машина диктовки одного browser window.
 *
 * acquire() только регистрирует consumer. Эксклюзивный mic-owner выбирается атомарно
 * внутри start(), поэтому одновременно смонтированные ChatSession и TaskModal не
 * блокируют друг друга до явного пользовательского жеста.
 */
export function createDictationController({
  settings,
  apiClient = defaultApi,
  browser: browserOverrides = {},
  media: mediaOverrides = {},
  localStream: localStreamOverrides = {},
  clock: clockOverrides = {},
  limits: limitOverrides = {},
} = {}) {
  if (!settings || typeof settings.read !== 'function') {
    throw new TypeError('Dictation controller требует settings.read()');
  }

  const browser = { ...defaultBrowser(), ...browserOverrides };
  const media = { ...defaultMedia(), ...mediaOverrides };
  const localStream = { ...defaultLocalStream(), ...localStreamOverrides };
  const clock = { ...defaultClock(), ...clockOverrides };
  const limits = {
    browserDrainTimeoutMs: DEFAULT_BROWSER_DRAIN_TIMEOUT_MS,
    localStreamLagNoticeMs: DEFAULT_LOCAL_STREAM_LAG_NOTICE_MS,
    localRecorderStopTimeoutMs: DEFAULT_LOCAL_RECORDER_STOP_TIMEOUT_MS,
    localWarmupTimeoutMs: DEFAULT_LOCAL_WARMUP_TIMEOUT_MS,
    ...limitOverrides,
  };

  const leases = new Set();
  const publicState = reactive({
    active: false,
    phase: 'idle',
    prompt: null,
    interim: '',
  });
  let disposed = false;
  let activeLease = null;
  let activeRun = null;
  let generation = 0;
  let settingsEpoch = 0;
  let expectedSettingsFingerprint = '';

  function speechPrefs() {
    const current = settings.read();
    return current && typeof current === 'object' ? current : FALLBACK_SPEECH;
  }

  function publish(lease, patch = {}) {
    if (!lease || lease.released) return;
    Object.assign(lease.mutableState, patch);
    if (lease === activeLease) {
      publicState.active = !!lease.mutableState.busy;
      publicState.phase = lease.mutableState.phase;
      publicState.prompt = lease.mutableState.prompt;
      publicState.interim = lease.mutableState.interim;
    }
    safeCall(lease.handlers.onState, { ...lease.mutableState });
  }

  function refreshBlocked() {
    for (const lease of leases) {
      publish(lease, { blockedByOther: !!activeLease && activeLease !== lease });
    }
  }

  function setPhase(run, phase, patch = {}) {
    if (!isCurrent(run)) return;
    publish(run.lease, {
      phase,
      busy: phase !== 'idle',
      prompt: null,
      ...patch,
    });
  }

  function setNotice(run, notice) {
    if (!isCurrent(run)) return;
    publish(run.lease, { notice: String(notice || '') });
  }

  function setInterim(run, text) {
    if (!isCurrent(run)) return;
    const interim = String(text || '').trim();
    publish(run.lease, { interim });
    safeCall(run.lease.handlers.onInterim, interim);
  }

  function commit(run, text) {
    if (!isCurrent(run) || run.cancelled) return;
    const piece = normalizedPiece(text);
    if (!piece) return;
    run.committed.push(piece);
    safeCall(run.lease.handlers.onCommit, piece);
  }

  function emitTerminalFinal(run) {
    if (!isCurrent(run) || run.cancelled || run.terminalSent) return;
    run.terminalSent = true;
    const text = joinPieces(run.committed);
    if (!text) return;
    safeCall(run.lease.handlers.onFinal, text, { generation: run.generation });
  }

  function isCurrent(run) {
    return !!run && !disposed && activeRun === run && activeLease === run.lease
      && run.generation === generation && !run.lease.released;
  }

  function clearTimer(run, key) {
    if (run?.[key]) clock.clearTimeout(run[key]);
    if (run) run[key] = null;
  }

  function stopTracks(stream) {
    for (const track of stream?.getTracks?.() || []) {
      try { track.stop(); } catch { /* дорожка уже закрыта */ }
    }
  }

  function releaseRun(run, { final = false, notice = null } = {}) {
    if (!isCurrent(run)) return;
    if (final) emitTerminalFinal(run);
    clearTimer(run, 'browserDrainTimer');
    clearTimer(run, 'browserRestartTimer');
    run.desired = false;
    setInterim(run, '');
    const lease = run.lease;
    activeRun = null;
    activeLease = null;
    publicState.active = false;
    publicState.phase = 'idle';
    publicState.prompt = null;
    publicState.interim = '';
    publish(lease, {
      phase: 'idle',
      busy: false,
      prompt: null,
      interim: '',
      ...(notice !== null ? { notice } : {}),
    });
    refreshBlocked();
  }

  function failRun(run, rawError, fallbackCode = 'speech_failed') {
    if (!isCurrent(run)) return;
    const error = rawError instanceof Error
      ? rawError
      : speechError(fallbackCode, String(rawError || 'Диктовка завершилась с ошибкой'));
    if (!error.code) error.code = fallbackCode;
    publish(run.lease, { error, interim: '' });
    safeCall(run.lease.handlers.onError, error);
    releaseRun(run);
  }

  function makeRun(lease) {
    return {
      lease,
      generation: ++generation,
      settingsEpoch,
      desired: false,
      cancelled: false,
      terminalSent: false,
      committed: [],
      activeRecognition: null,
      drainingRecognition: null,
      browserDrainTimer: null,
      browserRestartTimer: null,
      browserRecognitionCtor: null,
      browserRetries: { network: 0, noSpeech: 0 },
      phrasesDisabled: false,
      pendingBrowserInstall: null,
      localCapture: null,
      localTranscription: null,
      transcriptionAbort: null,
      pendingMutation: false,
    };
  }

  function claim(lease) {
    if (disposed) throw speechError('speech_disposed', 'Машина диктовки уже остановлена');
    if (lease.released || !leases.has(lease)) {
      throw speechError('speech_lease_released', 'Владелец диктовки уже освобождён');
    }
    if (activeLease && activeLease !== lease) {
      throw speechError('speech_busy', 'Микрофон уже используется в другом интерфейсе');
    }
    if (activeRun) {
      throw speechError('speech_busy', 'Диктовка уже запущена');
    }
    activeLease = lease;
    activeRun = makeRun(lease);
    publish(lease, {
      phase: 'preparing',
      busy: true,
      prompt: null,
      interim: '',
      notice: '',
      error: null,
      blockedByOther: false,
    });
    refreshBlocked();
    return activeRun;
  }

  function browserLanguage(language = speechPrefs().language) {
    if (language === 'ru') return 'ru-RU';
    if (language === 'en') return 'en-US';
    const uiLanguage = browser.uiLanguage() || 'ru-RU';
    if (/^en(?:-|$)/i.test(uiLanguage)) return 'en-US';
    if (/^ru(?:-|$)/i.test(uiLanguage)) return 'ru-RU';
    return uiLanguage;
  }

  function dictionaryPhrases() {
    return String(speechPrefs().dictionary || '')
      .split(/\r?\n/)
      .map((term) => term.trim())
      .filter(Boolean)
      .slice(0, 128)
      .map((term) => term.slice(0, 100));
  }

  function captureSettingsContext(run) {
    const prefs = speechPrefs();
    return {
      generation: run.generation,
      epoch: settingsEpoch,
      revision: prefs.revision || '',
      engine: prefs.engine,
      browserProcessing: prefs.browserProcessing,
      browserAutoConsent: prefs.browserAutoConsent === true,
    };
  }

  function settingsContextMatches(run, context) {
    if (!isCurrent(run) || run.generation !== context.generation || settingsEpoch !== context.epoch) return false;
    const current = speechPrefs();
    return (current.revision || '') === context.revision
      && current.engine === context.engine
      && current.browserProcessing === context.browserProcessing
      && (current.browserAutoConsent === true) === context.browserAutoConsent;
  }

  function responseMatchesCurrent(response) {
    const snapshot = responseSnapshot(response);
    if (!snapshot || typeof snapshot.revision !== 'string' || !snapshot.revision) return false;
    const current = speechPrefs();
    if (current.revision !== snapshot.revision) return false;
    if (snapshot.engine && current.engine !== snapshot.engine) return false;
    if (snapshot.browserProcessing && current.browserProcessing !== snapshot.browserProcessing) return false;
    if (typeof snapshot.browserAutoConsent === 'boolean'
      && current.browserAutoConsent !== snapshot.browserAutoConsent) return false;
    return true;
  }

  function responseDisposition(run, context, response) {
    if (settingsContextMatches(run, context)) return 'apply';
    if (responseMatchesCurrent(response)) return 'current';
    return 'stale';
  }

  function applySpeechResponse(response) {
    const snapshot = responseSnapshot(response);
    if (!snapshot) return speechPrefs();
    const before = settingsEpoch;
    expectedSettingsFingerprint = speechExecutionFingerprint(snapshot);
    try {
      settings.apply?.((response?.settings || response?.speech)
        ? { settings: snapshot, revision: snapshot.revision, capabilities: response.capabilities }
        : snapshot);
    } finally {
      expectedSettingsFingerprint = '';
    }
    if (settingsEpoch === before) settingsEpoch += 1;
    return speechPrefs();
  }

  function releaseRecognition(run, recognition, method = 'abort') {
    if (!recognition) return;
    recognition.onstart = null;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    try { recognition[method]?.(); } catch { /* API уже в idle */ }
    if (run.drainingRecognition === recognition) {
      run.drainingRecognition = null;
      clearTimer(run, 'browserDrainTimer');
    }
    if (run.activeRecognition === recognition) run.activeRecognition = null;
  }

  function finishBrowserNormally(run, recognition) {
    if (!isCurrent(run) || recognition !== run.activeRecognition) return;
    run.activeRecognition = null;
    if (run.drainingRecognition === recognition) {
      run.drainingRecognition = null;
      clearTimer(run, 'browserDrainTimer');
    }
    releaseRun(run, { final: true });
  }

  function beginBrowserDrain(run, recognition) {
    clearTimer(run, 'browserDrainTimer');
    run.drainingRecognition = recognition;
    setPhase(run, 'draining');
    run.browserDrainTimer = clock.setTimeout(() => {
      run.browserDrainTimer = null;
      if (!isCurrent(run) || run.drainingRecognition !== recognition) return;
      releaseRecognition(run, recognition, 'abort');
      releaseRun(run, { final: true });
    }, limits.browserDrainTimeoutMs);
  }

  function browserOptions() {
    return { langs: [browserLanguage()], processLocally: true };
  }

  function scheduleBrowserRestart(run, delay) {
    if (!isCurrent(run) || !run.desired) return;
    clearTimer(run, 'browserRestartTimer');
    setPhase(run, 'preparing');
    run.browserRestartTimer = clock.setTimeout(() => {
      run.browserRestartTimer = null;
      if (!isCurrent(run) || !run.desired) return;
      void startBrowserRecognitionGuarded(run, run.browserRecognitionCtor);
    }, delay);
  }

  function fallbackToWhisper(run, reason) {
    if (!isCurrent(run) || !run.desired) return;
    clearTimer(run, 'browserRestartTimer');
    if (run.activeRecognition) releaseRecognition(run, run.activeRecognition);
    setInterim(run, '');
    void startWhisper(run, reason);
  }

  function handleBrowserError(run, recognition, error) {
    if (!isCurrent(run) || recognition !== run.activeRecognition) return;
    releaseRecognition(run, recognition);
    setInterim(run, '');

    if (error === 'phrases-not-supported' && !run.phrasesDisabled) {
      run.phrasesDisabled = true;
      setNotice(run, 'Этот браузер не применил словарь — продолжаю без подсказок.');
      scheduleBrowserRestart(run, 0);
      return;
    }
    if (error === 'network') {
      run.browserRetries.network += 1;
      if (run.browserRetries.network <= 2) {
        scheduleBrowserRestart(run, run.browserRetries.network * 300);
        return;
      }
      fallbackToWhisper(run, browserErrorText(error));
      return;
    }
    if (error === 'no-speech') {
      run.browserRetries.noSpeech += 1;
      if (run.browserRetries.noSpeech <= 2) {
        setNotice(run, 'Речь не услышана, пробую ещё раз…');
        scheduleBrowserRestart(run, run.browserRetries.noSpeech * 250);
        return;
      }
      failRun(run, speechError('speech_not_recognized', 'Речь не услышана — попробуй ещё раз'));
      return;
    }
    if (error === 'service-not-allowed' || error === 'language-not-supported') {
      fallbackToWhisper(run, browserErrorText(error));
      return;
    }
    if (error === 'aborted') {
      releaseRun(run);
      return;
    }
    failRun(run, speechError(`speech_browser_${error || 'unknown'}`, browserErrorText(error)));
  }

  function startBrowserRecognition(run, Ctor) {
    if (!Ctor || !isCurrent(run) || !run.desired) return;
    let recognition;
    try {
      recognition = new Ctor();
      recognition.lang = browserLanguage();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
      if (speechPrefs().browserProcessing === 'local') recognition.processLocally = true;

      const terms = dictionaryPhrases();
      if (terms.length && !run.phrasesDisabled) {
        const Phrase = browser.phraseCtor();
        if ('phrases' in recognition && typeof Phrase === 'function') {
          try { recognition.phrases = terms.map((term) => new Phrase(term, 5)); }
          catch {
            run.phrasesDisabled = true;
            setNotice(run, 'Этот браузер не применил словарь; диктовка продолжается без него.');
          }
        } else {
          run.phrasesDisabled = true;
          setNotice(run, 'Словарь не поддерживается этим браузером; диктовка продолжается без него.');
        }
      }
    } catch (error) {
      failRun(run, speechError('speech_prepare_failed', `Не удалось подготовить диктовку: ${error.message}`));
      return;
    }

    const finalResults = new Set();
    run.activeRecognition = recognition;
    recognition.onstart = () => {
      if (!isCurrent(run) || recognition !== run.activeRecognition || !run.desired) return;
      setPhase(run, 'recording');
    };
    recognition.onresult = (event) => {
      const draining = recognition === run.drainingRecognition;
      if (!isCurrent(run) || recognition !== run.activeRecognition || (!run.desired && !draining)) return;
      let interim = '';
      const start = Number.isInteger(event.resultIndex) ? event.resultIndex : 0;
      for (let index = start; index < (event.results?.length || 0); index += 1) {
        const result = event.results[index];
        const transcript = result?.[0]?.transcript || result?.item?.(0)?.transcript || '';
        if (result?.isFinal) {
          if (!finalResults.has(index)) {
            finalResults.add(index);
            commit(run, transcript);
          }
        } else if (!draining) {
          interim += `${interim ? ' ' : ''}${transcript.trim()}`;
        }
      }
      setInterim(run, draining ? '' : interim);
    };
    recognition.onerror = (event) => handleBrowserError(run, recognition, event.error || 'unknown');
    recognition.onend = () => finishBrowserNormally(run, recognition);
    try {
      recognition.start();
      // Safari и test doubles не всегда присылают onstart.
      setPhase(run, 'recording');
    } catch (error) {
      releaseRecognition(run, recognition);
      failRun(run, speechError(
        'speech_browser_start_failed',
        error?.name === 'InvalidStateError'
          ? 'Диктовка уже запущена в этом браузере'
          : `Не удалось запустить диктовку: ${error.message}`,
      ));
    }
  }

  async function validateBrowserAutoStart(run) {
    if (!isCurrent(run) || !run.desired) return false;
    const context = captureSettingsContext(run);
    if (context.engine !== 'browser' || context.browserProcessing !== 'auto'
      || !context.browserAutoConsent || !context.revision) {
      failRun(run, speechError(
        'speech_consent_unconfirmed',
        'Сервер не подтвердил актуальное согласие для браузерной диктовки',
      ));
      return false;
    }
    try {
      const response = await apiClient.post('/api/settings/speech/browser-consent', {
        confirm: true,
        revision: context.revision,
      });
      if (!isCurrent(run) || !run.desired) return false;
      const disposition = responseDisposition(run, context, response);
      const candidate = responseSnapshot(response);
      if (disposition === 'stale' || candidate?.engine !== 'browser'
        || candidate.browserProcessing !== 'auto' || candidate.browserAutoConsent !== true) {
        failRun(run, speechError(
          'speech_settings_stale',
          'Настройки речи изменились в другом окне — браузерная диктовка не запущена',
        ));
        return false;
      }
      if (disposition === 'apply') applySpeechResponse(response);
      const current = speechPrefs();
      if (!isCurrent(run) || current.engine !== 'browser' || current.browserProcessing !== 'auto'
        || current.browserAutoConsent !== true || !responseMatchesCurrent(response)) {
        failRun(run, speechError(
          'speech_settings_stale',
          'Настройки речи изменились в другом окне — браузерная диктовка не запущена',
        ));
        return false;
      }
      return true;
    } catch (error) {
      if (!isCurrent(run) || !run.desired) return false;
      failRun(run, speechError(
        error?.status === 409 ? 'speech_settings_stale' : 'speech_consent_check_failed',
        error?.status === 409
          ? 'Настройки речи изменились в другом окне — браузерная диктовка не запущена'
          : 'Не удалось проверить согласие на обработку речи — браузерная диктовка не запущена',
      ));
      return false;
    }
  }

  async function startBrowserRecognitionGuarded(run, Ctor, validatedRevision = '') {
    if (!Ctor || !isCurrent(run) || !run.desired) return;
    const prefs = speechPrefs();
    if (prefs.engine !== 'browser') return;
    if (prefs.browserProcessing === 'auto') {
      const alreadyValidated = !!validatedRevision
        && prefs.revision === validatedRevision && prefs.browserAutoConsent === true;
      if (!alreadyValidated && !await validateBrowserAutoStart(run)) return;
      if (!isCurrent(run) || !run.desired) return;
      const current = speechPrefs();
      if (current.engine !== 'browser' || current.browserProcessing !== 'auto'
        || current.browserAutoConsent !== true) {
        failRun(run, speechError(
          'speech_settings_stale',
          'Настройки речи изменились в другом окне — браузерная диктовка не запущена',
        ));
        return;
      }
    } else if (prefs.browserProcessing !== 'local') return;
    startBrowserRecognition(run, Ctor);
  }

  async function startBrowser(run, validatedRevision = '') {
    if (!isCurrent(run) || !run.desired) return;
    if (!browser.isSecureContext()) {
      fallbackToWhisper(run, 'Браузерная диктовка требует HTTPS.');
      return;
    }
    const Ctor = browser.recognitionCtor();
    if (!Ctor) {
      fallbackToWhisper(run, 'Браузерная диктовка на этом устройстве недоступна.');
      return;
    }
    if (speechPrefs().browserProcessing === 'auto' && !speechPrefs().browserAutoConsent) {
      run.desired = false;
      setPhase(run, 'prompt', { prompt: 'browser-consent' });
      return;
    }

    run.browserRecognitionCtor = Ctor;
    if (speechPrefs().browserProcessing === 'local') {
      const supportsLocal = 'processLocally' in (Ctor.prototype || {})
        && typeof Ctor.available === 'function';
      if (!supportsLocal) {
        fallbackToWhisper(run, 'Этот браузер не умеет распознавать речь на устройстве.');
        return;
      }
      setPhase(run, 'preparing');
      try {
        const availability = await Ctor.available(browserOptions());
        if (!isCurrent(run) || !run.desired) return;
        if (availability === 'downloadable') {
          if (typeof Ctor.install !== 'function') {
            fallbackToWhisper(run, 'Браузер не умеет устанавливать локальную языковую модель.');
            return;
          }
          run.desired = false;
          run.pendingBrowserInstall = {
            Ctor,
            context: captureSettingsContext(run),
            options: browserOptions(),
          };
          setPhase(run, 'prompt', { prompt: 'browser-install' });
          return;
        }
        if (availability !== 'available' && availability !== true) {
          fallbackToWhisper(run, availability === 'downloading'
            ? 'Браузер ещё скачивает языковую модель.'
            : 'Локальная языковая модель браузера недоступна.');
          return;
        }
      } catch {
        if (isCurrent(run)) fallbackToWhisper(run, 'Не удалось проверить локальную модель браузера.');
        return;
      }
    }
    await startBrowserRecognitionGuarded(run, Ctor, validatedRevision);
  }

  function localSessionId(run) {
    return clock.randomUUID() || `dictation-${clock.now()}-${run.generation}`;
  }

  function finishLocalCapture(run, state) {
    if (!state || state.released) return;
    state.released = true;
    stopTracks(state.stream);
    if (run.localCapture === state) run.localCapture = null;
  }

  function cancelLocalStream(state) {
    if (!state || state.cancelled) return Promise.resolve();
    state.cancelled = true;
    try { state.liveAbort?.abort(); } catch { /* уже закрыт */ }
    try { return Promise.resolve(state.liveController?.cancel?.()).catch(() => {}); }
    catch { return Promise.resolve(); }
  }

  function stopLocalStream(state) {
    if (!state || state.liveStopPromise || state.cancelled) return state?.liveStopPromise;
    state.liveStopPromise = (async () => {
      const stream = state.liveController || await state.livePromise;
      if (!stream || state.cancelled || state.liveError) return null;
      return stream.stop();
    })();
    state.liveStopPromise.catch(() => {});
    return state.liveStopPromise;
  }

  function cancelLocalWarmup(state) {
    if (!state) return;
    state.warmupCancelled = true;
    if (state.warmupTimer) clock.clearTimeout(state.warmupTimer);
    state.warmupTimer = null;
    if (state.resolveWarmup) {
      const resolve = state.resolveWarmup;
      state.resolveWarmup = null;
      resolve(null);
    }
    const warmupId = state.warmupId;
    if (!warmupId || state.warmupDeleteSent) return;
    state.warmupDeleteSent = true;
    apiClient.del?.(`/api/chat/transcribe/warmup/${encodeURIComponent(warmupId)}`).catch(() => {});
  }

  function startLocalWarmup(state) {
    if (!state || state.warmupStarted || state.warmupCancelled) return state?.warmupPromise;
    state.warmupStarted = true;
    state.warmupPromise = new Promise((resolve) => {
      state.resolveWarmup = resolve;
      state.warmupTimer = clock.setTimeout(() => {
        state.warmupTimer = null;
        state.warmupCancelled = true;
        state.resolveWarmup = null;
        resolve(null);
      }, limits.localWarmupTimeoutMs);
    });
    Promise.resolve()
      .then(() => apiClient.post('/api/chat/transcribe/warmup', {}))
      .then((result) => {
        const warmupId = typeof result?.warmupId === 'string' ? result.warmupId : '';
        state.warmupId = warmupId;
        if (state.warmupCancelled) {
          cancelLocalWarmup(state);
          return;
        }
        if (state.warmupTimer) clock.clearTimeout(state.warmupTimer);
        state.warmupTimer = null;
        const resolve = state.resolveWarmup;
        state.resolveWarmup = null;
        resolve?.(warmupId || null);
      })
      .catch(() => {
        if (state.warmupTimer) clock.clearTimeout(state.warmupTimer);
        state.warmupTimer = null;
        const resolve = state.resolveWarmup;
        state.resolveWarmup = null;
        resolve?.(null);
      });
    return state.warmupPromise;
  }

  function markLocalStreamFailure(run, state, rawError) {
    if (!state || state.liveError || state.cancelled) return;
    state.liveError = rawError instanceof Error
      ? rawError : speechError('speech_stream_failed', String(rawError || 'live stream failed'));
    if (!isCurrent(run)) return;
    setInterim(run, '');
    if (state.livePreflightUnsupported) startLocalWarmup(state);
    setNotice(run, 'Live-предпросмотр недоступен — итог распознаю после остановки.');
  }

  function onLocalStreamEvent(run, state, event) {
    if (!state || state.cancelled || !isCurrent(run)) return;
    if (event?.type === 'ready') {
      state.liveReady = true;
      return;
    }
    if (event?.type !== 'partial' && event?.type !== 'final' && event?.type !== 'done') return;
    if (event.type === 'partial' && state.stopRequested) return;
    if (typeof event.text === 'string') state.liveFinalText = event.text;
    if (event.type === 'partial') {
      setInterim(run, event.text);
      const lagMs = Number(event.lagMs);
      if (Number.isFinite(lagMs) && lagMs >= limits.localStreamLagNoticeMs) {
        setNotice(run, `Распознавание отстаёт примерно на ${Math.ceil(lagMs / 1000)} с.`);
      } else if (run.lease.mutableState.notice.startsWith('Распознавание отстаёт')) {
        setNotice(run, '');
      }
    }
  }

  function startLocalStream(run, state) {
    if (!localStream.supported()) {
      state.livePreflightUnsupported = true;
      markLocalStreamFailure(run, state, speechError(
        'speech_stream_unsupported',
        'Браузер не поддерживает live AudioWorklet/WebSocket',
      ));
      state.livePromise = Promise.resolve(null);
      return;
    }
    const AbortControllerCtor = media.AbortControllerCtor || globalThis.AbortController;
    const controller = new AbortControllerCtor();
    state.liveSessionId = localSessionId(run);
    state.liveAbort = controller;
    state.livePromise = localStream.open({
      mediaStream: state.stream,
      sessionId: state.liveSessionId,
      revision: speechPrefs().revision,
      signal: controller.signal,
      onEvent: (event) => onLocalStreamEvent(run, state, event),
      onError: (error) => markLocalStreamFailure(run, state, error),
    }).then((stream) => {
      state.liveController = stream;
      if (state.cancelled || !isCurrent(run)) {
        void stream.cancel().catch(() => {});
        return null;
      }
      return stream;
    }).catch((error) => {
      markLocalStreamFailure(run, state, error);
      return null;
    });
  }

  async function transcribeLocal(run, state) {
    if (!state.commit || !isCurrent(run) || state.completionGeneration !== run.generation) return;
    const AbortControllerCtor = media.AbortControllerCtor || globalThis.AbortController;
    const controller = new AbortControllerCtor();
    run.transcriptionAbort?.abort();
    run.transcriptionAbort = controller;
    run.localTranscription = state;
    setPhase(run, 'transcribing');
    try {
      const warmupId = await state.warmupPromise;
      if (!isCurrent(run) || controller.signal.aborted) return;
      const BlobCtor = media.BlobCtor || globalThis.Blob;
      const FormDataCtor = media.FormDataCtor || globalThis.FormData;
      const blob = new BlobCtor(state.chunks, { type: state.recorder.mimeType || 'audio/webm' });
      const form = new FormDataCtor();
      form.append('file', blob, 'dictation.webm');
      if (warmupId) form.append('warmupId', warmupId);
      if (state.liveSessionId) form.append('streamSessionId', state.liveSessionId);
      const result = await apiClient.upload('/api/chat/transcribe', form, { signal: controller.signal });
      if (!isCurrent(run) || controller.signal.aborted) return;
      const text = normalizedPiece(result?.text);
      if (text) {
        commit(run, text);
        setNotice(run, '');
        releaseRun(run, { final: true });
      } else {
        failRun(run, speechError('speech_not_recognized', 'Речь не распознана — попробуй ещё раз'));
      }
    } catch (error) {
      if (!controller.signal.aborted && isCurrent(run)) {
        failRun(run, speechError('speech_transcribe_failed', `Распознавание: ${error.message}`));
      }
    } finally {
      if (run.transcriptionAbort === controller) run.transcriptionAbort = null;
      if (run.localTranscription === state) run.localTranscription = null;
    }
  }

  async function finishLocalTranscription(run, state) {
    run.localTranscription = state;
    try {
      const stream = await state.livePromise;
      if (state.cancelled || !isCurrent(run)) return;
      if (stream && !state.liveError) {
        try {
          const done = await (state.liveStopPromise || stream.stop());
          if (state.cancelled || !isCurrent(run)) return;
          const text = normalizedPiece(done?.text || state.liveFinalText);
          setInterim(run, '');
          setNotice(run, '');
          if (text) {
            commit(run, text);
            releaseRun(run, { final: true });
            return;
          }
          setNotice(run, 'Live-результат пуст — перепроверяю полную запись.');
        } catch (error) {
          markLocalStreamFailure(run, state, error);
        }
      }
      if (state.cancelled || !isCurrent(run)) return;
      setInterim(run, '');
      await transcribeLocal(run, state);
    } finally {
      if (run.localTranscription === state) run.localTranscription = null;
    }
  }

  function localRecorderStopped(run, state) {
    if (!state || state.stopped) return;
    state.stopped = true;
    if (state.recorderStopTimer) clock.clearTimeout(state.recorderStopTimer);
    state.recorderStopTimer = null;
    finishLocalCapture(run, state);
    if (state.commit && isCurrent(run)) {
      setPhase(run, 'draining');
      void finishLocalTranscription(run, state);
    }
  }

  async function startWhisper(run, fallbackReason = '') {
    if (!isCurrent(run) || !run.desired) return;
    const local = speechPrefs().local || {};
    if (!local.ready) {
      const why = local.reason ? ` ${local.reason}` : '';
      failRun(run, speechError(
        'speech_local_unavailable',
        `${fallbackReason ? `${fallbackReason} ` : ''}Локальный Whisper недоступен.${why}`.trim(),
      ));
      return;
    }
    if (!browser.isSecureContext() || !media.hasGetUserMedia()) {
      failRun(run, speechError(
        'speech_secure_context_required',
        'Микрофон требует https или localhost — открой кокпит по защищённому адресу',
      ));
      return;
    }
    const Recorder = media.recorderCtor();
    if (!Recorder) {
      failRun(run, speechError('speech_recorder_unsupported', 'MediaRecorder не поддерживается этим браузером'));
      return;
    }
    setPhase(run, 'preparing');
    let stream = null;
    let captureState = null;
    try {
      stream = await media.getUserMedia({ audio: true });
      if (!isCurrent(run) || !run.desired) {
        stopTracks(stream);
        return;
      }
      const mime = typeof Recorder.isTypeSupported === 'function'
        && Recorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
      const recorder = new Recorder(stream, mime ? { mimeType: mime } : undefined);
      const state = {
        recorder,
        stream,
        chunks: [],
        generation: run.generation,
        completionGeneration: run.generation,
        commit: false,
        stopped: false,
        released: false,
        warmupId: '',
        warmupPromise: Promise.resolve(null),
        warmupStarted: false,
        warmupCancelled: false,
        warmupDeleteSent: false,
        warmupTimer: null,
        resolveWarmup: null,
        liveAbort: null,
        livePromise: Promise.resolve(null),
        liveController: null,
        liveSessionId: '',
        liveStopPromise: null,
        liveError: null,
        liveReady: false,
        liveFinalText: '',
        stopRequested: false,
        cancelled: false,
        livePreflightUnsupported: false,
        recorderStopTimer: null,
      };
      captureState = state;
      run.localCapture = state;
      recorder.ondataavailable = (event) => {
        if (event.data?.size) state.chunks.push(event.data);
      };
      recorder.onstop = () => localRecorderStopped(run, state);
      recorder.onerror = (event) => {
        state.commit = false;
        run.desired = false;
        void cancelLocalStream(state);
        cancelLocalWarmup(state);
        if (isCurrent(run)) {
          failRun(run, speechError(
            'speech_microphone_failed',
            `Микрофон: ${event.error?.message || 'ошибка записи'}`,
          ));
        }
        localRecorderStopped(run, state);
      };
      recorder.start();
      startLocalStream(run, state);
      setPhase(run, 'recording');
      if (fallbackReason) setNotice(run, `${fallbackReason} Использую локальный Whisper.`);
    } catch (error) {
      if (captureState) finishLocalCapture(run, captureState);
      else stopTracks(stream);
      if (isCurrent(run)) {
        failRun(run, speechError('speech_microphone_failed', `Микрофон: ${error.message}`));
      }
    }
  }

  async function beginRun(run, { browserAutoValidationRevision = '' } = {}) {
    if (!isCurrent(run)) return;
    run.desired = true;
    run.browserRetries = { network: 0, noSpeech: 0 };
    run.phrasesDisabled = false;
    setInterim(run, '');
    setNotice(run, '');
    setPhase(run, 'preparing');
    if (speechPrefs().engine === 'browser') {
      await startBrowser(run, browserAutoValidationRevision);
    } else {
      await startWhisper(run);
    }
  }

  async function startLease(lease) {
    const run = claim(lease);
    const prefs = speechPrefs();
    if (prefs.engine === 'browser' && prefs.browserProcessing === 'auto'
      && !prefs.browserAutoConsent) {
      run.desired = false;
      setPhase(run, 'prompt', { prompt: 'browser-consent' });
      return lease;
    }
    await beginRun(run);
    return lease;
  }

  async function confirmBrowserConsent(lease) {
    const run = activeRun;
    if (!isCurrent(run) || run.lease !== lease || lease.mutableState.prompt !== 'browser-consent') return false;
    run.pendingMutation = true;
    setPhase(run, 'preparing');
    const context = captureSettingsContext(run);
    try {
      const response = await apiClient.post('/api/settings/speech/browser-consent', {
        confirm: true,
        revision: context.revision,
      });
      if (!isCurrent(run)) return false;
      const disposition = responseDisposition(run, context, response);
      const candidate = responseSnapshot(response);
      if (disposition === 'stale' || candidate?.engine !== 'browser'
        || candidate.browserProcessing !== 'auto' || candidate.browserAutoConsent !== true) {
        failRun(run, speechError(
          'speech_settings_stale',
          'Настройки речи изменились в другом окне — запусти диктовку ещё раз',
        ));
        return false;
      }
      const snapshot = disposition === 'current' ? speechPrefs() : applySpeechResponse(response);
      if (!isCurrent(run) || snapshot.engine !== 'browser'
        || snapshot.browserProcessing !== 'auto' || snapshot.browserAutoConsent !== true
        || !responseMatchesCurrent(response)) {
        failRun(run, speechError('speech_consent_unconfirmed', 'Сервер не подтвердил согласие'));
        return false;
      }
      run.pendingMutation = false;
      await beginRun(run, { browserAutoValidationRevision: snapshot.revision });
      return true;
    } catch (error) {
      if (!isCurrent(run)) return false;
      run.pendingMutation = false;
      if (error?.status === 409) {
        try {
          const latest = await apiClient.get('/api/settings/speech');
          if (isCurrent(run)) applySpeechResponse(latest);
        } catch { /* fail-closed ниже */ }
        if (isCurrent(run) && speechPrefs().engine === 'browser'
          && speechPrefs().browserProcessing === 'auto' && !speechPrefs().browserAutoConsent) {
          setPhase(run, 'prompt', { prompt: 'browser-consent' });
          const stale = speechError(
            'speech_settings_stale',
            'Настройки речи изменились в другом окне — проверь выбор ещё раз',
          );
          publish(lease, { error: stale });
          safeCall(lease.handlers.onError, stale);
          return false;
        }
      }
      failRun(run, speechError(
        'speech_consent_save_failed',
        `Не удалось сохранить согласие: ${error.message}`,
      ));
      return false;
    }
  }

  async function useWhisper(lease) {
    const run = activeRun;
    if (!isCurrent(run) || run.lease !== lease || lease.mutableState.phase !== 'prompt') return false;
    run.pendingMutation = true;
    setPhase(run, 'preparing');
    const context = captureSettingsContext(run);
    try {
      const response = await apiClient.post('/api/settings/speech', { engine: 'whisper' });
      if (!isCurrent(run)) return false;
      const disposition = responseDisposition(run, context, response);
      const candidate = responseSnapshot(response);
      if (disposition === 'stale' || candidate?.engine !== 'whisper') {
        failRun(run, speechError(
          'speech_settings_stale',
          'Настройки речи изменились в другом окне — запусти диктовку ещё раз',
        ));
        return false;
      }
      const snapshot = disposition === 'current' ? speechPrefs() : applySpeechResponse(response);
      if (!isCurrent(run) || snapshot.engine !== 'whisper' || !responseMatchesCurrent(response)) {
        failRun(run, speechError('speech_settings_stale', 'Настройки речи изменились — Whisper не запущен'));
        return false;
      }
      run.pendingMutation = false;
      await beginRun(run);
      return true;
    } catch (error) {
      if (isCurrent(run)) {
        run.pendingMutation = false;
        failRun(run, speechError(
          'speech_engine_change_failed',
          `Не удалось выбрать Whisper: ${error.message}`,
        ));
      }
      return false;
    }
  }

  async function installBrowserLanguage(lease) {
    const run = activeRun;
    const pending = run?.pendingBrowserInstall;
    if (!isCurrent(run) || run.lease !== lease || lease.mutableState.prompt !== 'browser-install'
      || !pending?.Ctor || !pending.context) return false;
    if (!settingsContextMatches(run, pending.context)
      || pending.context.engine !== 'browser' || pending.context.browserProcessing !== 'local') {
      failRun(run, speechError(
        'speech_settings_stale',
        'Настройки речи изменились — локальная модель не будет установлена',
      ));
      return false;
    }
    run.desired = true;
    setPhase(run, 'installing');
    try {
      const installed = await pending.Ctor.install(pending.options);
      if (!isCurrent(run) || !run.desired) return false;
      if (!settingsContextMatches(run, pending.context)
        || speechPrefs().engine !== 'browser' || speechPrefs().browserProcessing !== 'local') {
        failRun(run, speechError(
          'speech_settings_stale',
          'Настройки речи изменились — установленная модель не будет запускать старый режим',
        ));
        return false;
      }
      if (installed !== true) {
        fallbackToWhisper(run, 'Браузер не смог установить языковую модель.');
        return false;
      }
      run.pendingBrowserInstall = null;
      run.browserRecognitionCtor = pending.Ctor;
      await startBrowserRecognitionGuarded(run, pending.Ctor);
      return true;
    } catch (error) {
      if (isCurrent(run)) fallbackToWhisper(run, `Не удалось установить языковую модель: ${error.message}.`);
      return false;
    }
  }

  function stopRunNormally(run) {
    if (!isCurrent(run)) return Promise.resolve(false);
    run.desired = false;
    clearTimer(run, 'browserRestartTimer');
    setInterim(run, '');
    if (run.activeRecognition) {
      const recognition = run.activeRecognition;
      beginBrowserDrain(run, recognition);
      try { recognition.stop?.(); }
      catch {
        releaseRecognition(run, recognition);
        releaseRun(run, { final: true });
      }
      return Promise.resolve(true);
    }
    if (run.localCapture) {
      const state = run.localCapture;
      state.commit = true;
      state.stopRequested = true;
      state.completionGeneration = run.generation;
      setPhase(run, 'draining');
      stopLocalStream(state);
      try {
        if (state.recorder.state && state.recorder.state !== 'inactive') {
          try { state.recorder.requestData?.(); } catch { /* stop обязателен */ }
          state.recorderStopTimer = clock.setTimeout(() => {
            state.recorderStopTimer = null;
            localRecorderStopped(run, state);
          }, limits.localRecorderStopTimeoutMs);
          state.recorder.stop();
        } else localRecorderStopped(run, state);
      } catch {
        state.commit = false;
        void cancelLocalStream(state);
        cancelLocalWarmup(state);
        localRecorderStopped(run, state);
        failRun(run, speechError('speech_recorder_stop_failed', 'Не удалось завершить запись'));
      }
      return Promise.resolve(true);
    }
    // Stop до открытия hardware равен отмене: terminal результата ещё нет.
    return cancelRun(run);
  }

  function cancelRun(run, { notice = '' } = {}) {
    if (!isCurrent(run)) return Promise.resolve(false);
    run.cancelled = true;
    run.desired = false;
    clearTimer(run, 'browserRestartTimer');
    clearTimer(run, 'browserDrainTimer');
    setInterim(run, '');
    if (run.activeRecognition) releaseRecognition(run, run.activeRecognition, 'abort');
    if (run.transcriptionAbort) {
      run.transcriptionAbort.abort();
      run.transcriptionAbort = null;
    }
    const cleanup = [];
    if (run.localTranscription) {
      run.localTranscription.commit = false;
      cleanup.push(cancelLocalStream(run.localTranscription));
      cancelLocalWarmup(run.localTranscription);
    }
    if (run.localCapture) {
      const state = run.localCapture;
      state.commit = false;
      state.stopRequested = true;
      cleanup.push(cancelLocalStream(state));
      cancelLocalWarmup(state);
      try {
        if (state.recorder.state && state.recorder.state !== 'inactive') state.recorder.stop();
        else localRecorderStopped(run, state);
      } catch { localRecorderStopped(run, state); }
      finishLocalCapture(run, state);
    }
    releaseRun(run, { notice });
    return Promise.allSettled(cleanup).then(() => true);
  }

  function acquire(owner, handlers = {}) {
    if (disposed) throw speechError('speech_disposed', 'Машина диктовки уже остановлена');
    if (owner === null || owner === undefined) throw new TypeError('Для lease нужен owner');
    const mutableState = reactive({
      phase: 'idle',
      busy: false,
      prompt: null,
      interim: '',
      notice: '',
      error: null,
      blockedByOther: !!activeLease,
    });
    const lease = {
      owner,
      handlers: handlers && typeof handlers === 'object' ? handlers : {},
      mutableState,
      state: readonly(mutableState),
      released: false,
      start: () => startLease(lease),
      stop: () => (activeRun?.lease === lease ? stopRunNormally(activeRun) : Promise.resolve(false)),
      cancel: () => (activeRun?.lease === lease ? cancelRun(activeRun) : Promise.resolve(false)),
      confirmBrowserConsent: () => confirmBrowserConsent(lease),
      useWhisper: () => useWhisper(lease),
      installBrowserLanguage: () => installBrowserLanguage(lease),
      release() {
        if (lease.released) return Promise.resolve(false);
        const cleanup = activeRun?.lease === lease ? cancelRun(activeRun) : Promise.resolve(false);
        lease.released = true;
        lease.handlers = {};
        leases.delete(lease);
        refreshBlocked();
        return cleanup;
      },
    };
    leases.add(lease);
    return lease;
  }

  function syncSettings(next) {
    settingsEpoch += 1;
    const fingerprint = speechExecutionFingerprint(next || speechPrefs());
    if (expectedSettingsFingerprint && fingerprint === expectedSettingsFingerprint) return;
    const run = activeRun;
    if (!isCurrent(run) || run.pendingMutation) return;
    void cancelRun(run, { notice: 'Диктовка остановлена: настройки речи изменились.' });
  }

  function dispose() {
    if (disposed) return Promise.resolve();
    const cleanup = activeRun ? cancelRun(activeRun) : Promise.resolve();
    disposed = true;
    generation += 1;
    for (const lease of leases) {
      lease.released = true;
      lease.handlers = {};
    }
    leases.clear();
    activeLease = null;
    activeRun = null;
    publicState.active = false;
    publicState.phase = 'idle';
    publicState.prompt = null;
    publicState.interim = '';
    return cleanup;
  }

  return {
    acquire,
    syncSettings,
    dispose,
    state: readonly(publicState),
  };
}

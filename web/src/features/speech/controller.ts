// Единый контроллер диктовки: управляет захватом речи, распознаванием и состоянием всех потребителей UI.
import { reactive, readonly } from 'vue';
import { isRecord } from '../../../../shared/lib/objects.ts';
import { isSpeechSettings, type SpeechSettings, type SpeechWindow, type SpeechError, type LeaseState,
  type Lease, type Run, type Capture, type Recognition, type RecognitionCtor, type SettingsContext,
  type LeaseHandlers, type ControllerOptions, type Timer } from './contracts.ts';
import { api as defaultApi, failureText } from '../../shared/apiClient.ts';
import { createSpeechStream } from '../../shared/speechStream.ts';

const DEFAULT_BROWSER_DRAIN_TIMEOUT_MS = 1800;
const DEFAULT_LOCAL_STREAM_LAG_NOTICE_MS = 4000;
const DEFAULT_LOCAL_RECORDER_STOP_TIMEOUT_MS = 2000;
const DEFAULT_LOCAL_WARMUP_TIMEOUT_MS = 1500;

const FALLBACK_SPEECH: SpeechSettings = Object.freeze({
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

/**
 * Изменение параметров исполнения останавливает текущую диктовку.
 * Служебные поля capabilities не меняют этот отпечаток и не перезапускают захват.
 */
export function speechExecutionFingerprint(value: unknown) {
  const speech = isRecord(value) ? value : FALLBACK_SPEECH;

  return JSON.stringify(EXECUTION_FIELDS.map((field) => speech[field] ?? null));
}

function speechError(code: string, message: string) {
  const error: SpeechError = new Error(message);

  error.code = code;

  return error;
}

/**
 * Ошибка внешнего слушателя не должна прервать освобождение микрофона.
 * Вызываем только функцию, сохраняя прежнее поглощение ошибок потребителя.
 */
function safeCall(callback: unknown, ...args: unknown[]) {
  if (typeof callback !== 'function') {
    return;
  }

  try {
    callback(...args);
  } catch {
    // Ошибка потребителя не должна ломать cleanup речи.
  }
}

function normalizedPiece(value: unknown) {
  return String(value || '').trim();
}

function joinPieces(parts: string[]) {
  return parts.map(normalizedPiece).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Проверяем переданные настройки до сравнения revision и применения consent.
 * Не достраиваем отсутствующие поля и сохраняем расширения исходного ответа.
 */
function responseSnapshot(response: unknown): SpeechSettings | null {
  if (!isRecord(response)) {
    return null;
  }

  const raw = response.speech || response.settings || response;

  if (!isSpeechSettings(raw)) {
    return null;
  }

  const revision = raw.revision ?? response.revision;
  const local = raw.local || (isRecord(response.capabilities) ? response.capabilities.local : undefined);
  const snapshot = {
    ...raw,
    revision,
    local,
  };

  return isSpeechSettings(snapshot) ? snapshot : null;
}

function browserErrorText(error: string) {
  const texts: Record<string, string> = {
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
    recognitionCtor: () => (globalThis.window as SpeechWindow)?.SpeechRecognition
      || (globalThis.window as SpeechWindow)?.webkitSpeechRecognition || null,
    phraseCtor: () => (globalThis.window as SpeechWindow)?.SpeechRecognitionPhrase || null,
    uiLanguage: () => 'ru',
  };
}

function defaultMedia() {
  return {
    getUserMedia: (constraints: MediaStreamConstraints) => (
      globalThis.navigator?.mediaDevices?.getUserMedia?.(constraints)
    ),
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
      && typeof (globalThis.window?.AudioContext
        || (globalThis.window as SpeechWindow)?.webkitAudioContext) === 'function'
      && typeof globalThis.window?.AudioWorkletNode === 'function',
    open: (options: Parameters<typeof createSpeechStream>[0]) => createSpeechStream(options),
  };
}

function defaultClock() {
  return {
    now: () => Date.now(),
    randomUUID: () => globalThis.crypto?.randomUUID?.() || '',
    setTimeout: (callback: () => void, timeout: number) => setTimeout(callback, timeout),
    clearTimeout: (timer: Timer) => clearTimeout(timer ?? undefined),
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
}: ControllerOptions = {}) {
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

  const leases = new Set<Lease>();
  const publicState = reactive<{
    active: boolean;
    phase: string;
    prompt: string | null;
    interim: string;
  }>({
    active: false,
    phase: 'idle',
    prompt: null,
    interim: '',
  });
  let disposed = false;
  let activeLease: Lease | null = null;
  let activeRun: Run | null = null;
  let generation = 0;
  let settingsEpoch = 0;
  let expectedSettingsFingerprint = '';

  function speechPrefs() {
    const current = settings!.read();

    return isSpeechSettings(current) ? current : FALLBACK_SPEECH;
  }

  /**
   * Публикует состояние только существующему владельцу микрофона.
   * Ошибка слушателя не мешает обновлению общей проекции контроллера.
   */
  function publish(lease: Lease | null, patch: Partial<LeaseState> = {}) {
    if (!lease || lease.released) {
      return;
    }

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

  function setPhase(run: Run, phase: string, patch: Partial<LeaseState> = {}) {
    if (!isCurrent(run)) {
      return;
    }

    publish(run.lease, {
      phase,
      busy: phase !== 'idle',
      prompt: null,
      ...patch,
    });
  }

  function setNotice(run: Run, notice: unknown) {
    if (!isCurrent(run)) {
      return;
    }

    publish(run.lease, { notice: String(notice || '') });
  }

  /**
   * Частичный текст принадлежит только текущему поколению диктовки.
   * Потребитель получает ту же нормализованную строку, что и общая проекция.
   */
  function setInterim(run: Run, text: unknown) {
    if (!isCurrent(run)) {
      return;
    }

    const interim = String(text || '').trim();

    publish(run.lease, { interim });
    safeCall(run.lease.handlers.onInterim, interim);
  }

  /**
   * Подтверждённая часть добавляется один раз живому владельцу.
   * Пустые результаты и отменённые поколения не меняют его черновик.
   */
  function commit(run: Run, text: unknown) {
    if (!isCurrent(run) || run.cancelled) {
      return;
    }

    const piece = normalizedPiece(text);

    if (!piece) {
      return;
    }

    run.committed.push(piece);
    safeCall(run.lease.handlers.onCommit, piece);
  }

  /**
   * Итоговая строка собирается только после завершения текущего запуска.
   * Флаг исключает повторную доставку при нескольких путях завершения.
   */
  function emitTerminalFinal(run: Run) {
    if (!isCurrent(run) || run.cancelled || run.terminalSent) {
      return;
    }

    run.terminalSent = true;

    const text = joinPieces(run.committed);

    if (!text) {
      return;
    }

    safeCall(run.lease.handlers.onFinal, text, { generation: run.generation });
  }

  function isCurrent(run: Run | null): run is Run {
    return !!run && !disposed && activeRun === run && activeLease === run.lease
      && run.generation === generation && !run.lease.released;
  }

  /**
   * Снимает только таймер указанного запуска и забывает его ручку.
   * Повторное освобождение безопасно при гонке остановки и отмены.
   */
  function clearTimer(run: Run | null, key: 'browserDrainTimer' | 'browserRestartTimer') {
    if (run?.[key]) {
      clock.clearTimeout(run[key]);
    }
    if (run) {
      run[key] = null;
    }
  }

  /**
   * Все дорожки освобождаются независимо от ошибки одной из них.
   * Уже закрытый поток не мешает cleanup оставшегося оборудования.
   */
  function stopTracks(stream: MediaStream | null) {
    for (const track of stream?.getTracks?.() || []) {
      try { track.stop(); } catch { /* дорожка уже закрыта */ }
    }
  }

  /**
   * Освобождает единственного владельца и возвращает контроллер в idle.
   * Итог отправляется до снятия поколения, блокировка остальных lease обновляется после него.
   */
  function releaseRun(
    run: Run,
    { final = false, notice = null }: { final?: boolean; notice?: string | null } = {},
  ) {
    if (!isCurrent(run)) {
      return;
    }
    if (final) {
      emitTerminalFinal(run);
    }

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

  /**
   * Ошибка сообщается текущему потребителю до освобождения микрофона.
   * Исходный Error сохраняется вместе с кодом, чтобы UI различал штатные отказы.
   */
  function failRun(run: Run, rawError: unknown, fallbackCode = 'speech_failed') {
    if (!isCurrent(run)) {
      return;
    }

    const error: SpeechError = rawError instanceof Error
      ? rawError
      : speechError(fallbackCode, String(rawError || 'Диктовка завершилась с ошибкой'));

    if (!error.code) {
      error.code = fallbackCode;
    }

    publish(run.lease, { error, interim: '' });
    safeCall(run.lease.handlers.onError, error);
    releaseRun(run);
  }

  function makeRun(lease: Lease): Run {
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

  /**
   * Право на микрофон захватывается до любой асинхронной подготовки.
   * Уже занятый или освобождённый lease не создаёт второго запуска.
   */
  function claim(lease: Lease) {
    if (disposed) {
      throw speechError('speech_disposed', 'Машина диктовки уже остановлена');
    }
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

  /**
   * Язык речи выбирается отдельно от перевода элементов интерфейса.
   * Автоматический режим сохраняет прежний язык браузера и региональный суффикс.
   */
  function browserLanguage(language = speechPrefs().language) {
    if (language === 'ru') {
      return 'ru-RU';
    }
    if (language === 'en') {
      return 'en-US';
    }

    const uiLanguage = browser.uiLanguage() || 'ru-RU';

    if (/^en(?:-|$)/i.test(uiLanguage)) {
      return 'en-US';
    }
    if (/^ru(?:-|$)/i.test(uiLanguage)) {
      return 'ru-RU';
    }

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

  function captureSettingsContext(run: Run) {
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

  function settingsContextMatches(run: Run, context: SettingsContext) {
    if (!isCurrent(run) || run.generation !== context.generation || settingsEpoch !== context.epoch) {
      return false;
    }

    const current = speechPrefs();

    return (current.revision || '') === context.revision
      && current.engine === context.engine
      && current.browserProcessing === context.browserProcessing
      && (current.browserAutoConsent === true) === context.browserAutoConsent;
  }

  /**
   * Ответ на изменение настроек должен подтверждать актуальную revision.
   * Поздний consent другого окна не разрешает запуск со старыми параметрами.
   */
  function responseMatchesCurrent(response: unknown) {
    const snapshot = responseSnapshot(response);

    if (!snapshot || typeof snapshot.revision !== 'string' || !snapshot.revision) {
      return false;
    }

    const current = speechPrefs();

    if (current.revision !== snapshot.revision) {
      return false;
    }
    if (snapshot.engine && current.engine !== snapshot.engine) {
      return false;
    }
    if (snapshot.browserProcessing && current.browserProcessing !== snapshot.browserProcessing) {
      return false;
    }
    if (typeof snapshot.browserAutoConsent === 'boolean'
      && current.browserAutoConsent !== snapshot.browserAutoConsent) {
      return false;
    }

    return true;
  }

  /**
   * Различает ответ нашего поколения, уже применённый снимок и устаревший ответ.
   * Эта классификация не изменяет параметры до завершения проверок consent.
   */
  function responseDisposition(run: Run, context: SettingsContext, response: unknown) {
    if (settingsContextMatches(run, context)) {
      return 'apply';
    }
    if (responseMatchesCurrent(response)) {
      return 'current';
    }

    return 'stale';
  }

  /**
   * Применяет проверенный снимок через порт владельца настроек.
   * Отпечаток отличает собственное обновление от внешней смены режима во время записи.
   */
  function applySpeechResponse(response: unknown) {
    const snapshot = responseSnapshot(response);

    if (!snapshot) {
      return speechPrefs();
    }

    const before = settingsEpoch;

    expectedSettingsFingerprint = speechExecutionFingerprint(snapshot);

    try {
      settings!.apply?.((isRecord(response) && (response.settings || response.speech))
        ? {
          settings: snapshot,
          revision: snapshot.revision,
          capabilities: isRecord(response) ? response.capabilities : undefined,
        }
        : snapshot);
    } finally {
      expectedSettingsFingerprint = '';
    }

    if (settingsEpoch === before) {
      settingsEpoch += 1;
    }

    return speechPrefs();
  }

  /**
   * Отвязывает callbacks до остановки браузерного распознавателя.
   * Поздние события уже освобождённого экземпляра не меняют новый запуск.
   */
  function releaseRecognition(run: Run, recognition: Recognition | null, method: 'abort' | 'stop' = 'abort') {
    if (!recognition) {
      return;
    }

    recognition.onstart = null;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;

    try { recognition[method]?.(); } catch { /* API уже в idle */ }

    if (run.drainingRecognition === recognition) {
      run.drainingRecognition = null;
      clearTimer(run, 'browserDrainTimer');
    }
    if (run.activeRecognition === recognition) {
      run.activeRecognition = null;
    }
  }

  /**
   * Нормальный onend завершает только текущий распознаватель.
   * Drain-таймер снимается до финальной публикации, чтобы не повторить результат.
   */
  function finishBrowserNormally(run: Run, recognition: Recognition) {
    if (!isCurrent(run) || recognition !== run.activeRecognition) {
      return;
    }

    run.activeRecognition = null;

    if (run.drainingRecognition === recognition) {
      run.drainingRecognition = null;
      clearTimer(run, 'browserDrainTimer');
    }

    releaseRun(run, { final: true });
  }

  /**
   * После Stop даёт браузеру ограниченное время вернуть последние слова.
   * Таймаут завершает тот же запуск и не создаёт нового распознавателя.
   */
  function beginBrowserDrain(run: Run, recognition: Recognition) {
    clearTimer(run, 'browserDrainTimer');
    run.drainingRecognition = recognition;
    setPhase(run, 'draining');
    run.browserDrainTimer = clock.setTimeout(() => {
      run.browserDrainTimer = null;

      if (!isCurrent(run) || run.drainingRecognition !== recognition) {
        return;
      }

      releaseRecognition(run, recognition, 'abort');
      releaseRun(run, { final: true });
    }, limits.browserDrainTimeoutMs);
  }

  function browserOptions() {
    return { langs: [browserLanguage()], processLocally: true };
  }

  /**
   * Повтор браузерного распознавания принадлежит текущему поколению.
   * Отложенный callback проверяет владельца до нового обращения к браузеру.
   */
  function scheduleBrowserRestart(run: Run, delay: number) {
    if (!isCurrent(run) || !run.desired) {
      return;
    }

    clearTimer(run, 'browserRestartTimer');
    setPhase(run, 'preparing');
    run.browserRestartTimer = clock.setTimeout(() => {
      run.browserRestartTimer = null;

      if (!isCurrent(run) || !run.desired) {
        return;
      }

      void startBrowserRecognitionGuarded(run, run.browserRecognitionCtor);
    }, delay);
  }

  /**
   * Переход к Whisper сохраняет единственного владельца микрофона.
   * Старый распознаватель и его таймер снимаются до подготовки локальной записи.
   */
  function fallbackToWhisper(run: Run, reason: string) {
    if (!isCurrent(run) || !run.desired) {
      return;
    }

    clearTimer(run, 'browserRestartTimer');

    if (run.activeRecognition) {
      releaseRecognition(run, run.activeRecognition);
    }

    setInterim(run, '');
    void startWhisper(run, reason);
  }

  /**
   * Ошибки браузера имеют ограниченное число повторов по прежним правилам.
   * Неподдерживаемый режим уходит в Whisper, а отказ микрофона завершает запуск.
   */
  function handleBrowserError(run: Run, recognition: Recognition, error: string) {
    if (!isCurrent(run) || recognition !== run.activeRecognition) {
      return;
    }

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

  /**
   * Подготавливает один распознаватель с текущим языком и словарём.
   * Все callbacks сверяют поколение, финальные куски принимаются только один раз.
   */
  function startBrowserRecognition(run: Run, Ctor: RecognitionCtor | null) {
    if (!Ctor || !isCurrent(run) || !run.desired) {
      return;
    }

    let recognition;

    try {
      recognition = new Ctor();
      recognition.lang = browserLanguage();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;

      if (speechPrefs().browserProcessing === 'local') {
        recognition.processLocally = true;
      }

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
      failRun(run, speechError(
        'speech_prepare_failed',
        `Не удалось подготовить диктовку: ${failureText(error)}`,
      ));

      return;
    }

    const finalResults = new Set<number>();

    run.activeRecognition = recognition;
    recognition.onstart = () => {
      if (!isCurrent(run) || recognition !== run.activeRecognition || !run.desired) {
        return;
      }

      setPhase(run, 'recording');
    };
    recognition.onresult = (event) => {
      const draining = recognition === run.drainingRecognition;

      if (!isCurrent(run) || recognition !== run.activeRecognition || (!run.desired && !draining)) {
        return;
      }

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
        error instanceof Error && error.name === 'InvalidStateError'
          ? 'Диктовка уже запущена в этом браузере'
          : `Не удалось запустить диктовку: ${failureText(error)}`,
      ));
    }
  }

  /**
   * Автоматическая обработка речи требует подтверждённого согласия сервера.
   * Поздний ответ или смена revision прекращают запуск до обращения к браузеру.
   */
  async function validateBrowserAutoStart(run: Run) {
    if (!isCurrent(run) || !run.desired) {
      return false;
    }

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

      if (!isCurrent(run) || !run.desired) {
        return false;
      }

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
      if (disposition === 'apply') {
        applySpeechResponse(response);
      }

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
      if (!isCurrent(run) || !run.desired) {
        return false;
      }

      failRun(run, speechError(
        isRecord(error) && error.status === 409 ? 'speech_settings_stale' : 'speech_consent_check_failed',
        isRecord(error) && error.status === 409
          ? 'Настройки речи изменились в другом окне — браузерная диктовка не запущена'
          : 'Не удалось проверить согласие на обработку речи — браузерная диктовка не запущена',
      ));

      return false;
    }
  }

  /**
   * Повторное начало распознавания проходит ту же проверку consent.
   * Ранее подтверждённая revision пригодна только при неизменных настройках.
   */
  async function startBrowserRecognitionGuarded(
    run: Run, Ctor: RecognitionCtor | null, validatedRevision = '',
  ) {
    if (!Ctor || !isCurrent(run) || !run.desired) {
      return;
    }

    const prefs = speechPrefs();

    if (prefs.engine !== 'browser') {
      return;
    }
    if (prefs.browserProcessing === 'auto') {
      const alreadyValidated = !!validatedRevision
        && prefs.revision === validatedRevision && prefs.browserAutoConsent === true;

      if (!alreadyValidated && !await validateBrowserAutoStart(run)) {
        return;
      }
      if (!isCurrent(run) || !run.desired) {
        return;
      }

      const current = speechPrefs();

      if (current.engine !== 'browser' || current.browserProcessing !== 'auto'
        || current.browserAutoConsent !== true) {
        failRun(run, speechError(
          'speech_settings_stale',
          'Настройки речи изменились в другом окне — браузерная диктовка не запущена',
        ));

        return;
      }
    } else if (prefs.browserProcessing !== 'local') {
      return;
    }

    startBrowserRecognition(run, Ctor);
  }

  /**
   * Выбирает браузерный режим по возможностям устройства и настройкам.
   * Установка языка и согласие требуют отдельного действия текущего владельца.
   */
  async function startBrowser(run: Run, validatedRevision = '') {
    if (!isCurrent(run) || !run.desired) {
      return;
    }
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
        const availability = await Ctor.available!(browserOptions());

        if (!isCurrent(run) || !run.desired) {
          return;
        }
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
        if (isCurrent(run)) {
          fallbackToWhisper(run, 'Не удалось проверить локальную модель браузера.');
        }

        return;
      }
    }

    await startBrowserRecognitionGuarded(run, Ctor, validatedRevision);
  }

  function localSessionId(run: Run) {
    return clock.randomUUID() || `dictation-${clock.now()}-${run.generation}`;
  }

  /**
   * Освобождает дорожки завершённой записи ровно один раз.
   * Указатель снимается только если захват всё ещё принадлежит этому запуску.
   */
  function finishLocalCapture(run: Run, state: Capture | null) {
    if (!state || state.released) {
      return;
    }

    state.released = true;
    stopTracks(state.stream);

    if (run.localCapture === state) {
      run.localCapture = null;
    }
  }

  /**
   * Отмена live-пути безопасна при повторном cleanup.
   * Ошибка закрытия не мешает освобождению остального оборудования.
   */
  function cancelLocalStream(state: Capture | null) {
    if (!state || state.cancelled) {
      return Promise.resolve();
    }

    state.cancelled = true;

    try { state.liveAbort?.abort(); } catch { /* уже закрыт */ }
    try { return Promise.resolve(state.liveController?.cancel?.()).catch(() => {}); }
    catch { return Promise.resolve(); }
  }

  /**
   * Все пути Stop разделяют одно ожидание остановки live-транспорта.
   * Отменённая или сломанная сессия не получает второй команды завершения.
   */
  function stopLocalStream(state: Capture | null) {
    if (!state || state.liveStopPromise || state.cancelled) {
      return state?.liveStopPromise;
    }

    state.liveStopPromise = (async () => {
      const stream = state.liveController || await state.livePromise;

      if (!stream || state.cancelled || state.liveError) {
        return null;
      }

      return stream.stop();
    })();
    state.liveStopPromise.catch(() => {});

    return state.liveStopPromise;
  }

  /**
   * Отменяет ожидание прогрева и удаляет только выданный ему идентификатор.
   * Поздний ответ не продлевает удержание модели и не повторяет DELETE.
   */
  function cancelLocalWarmup(state: Capture | null) {
    if (!state) {
      return;
    }

    state.warmupCancelled = true;

    if (state.warmupTimer) {
      clock.clearTimeout(state.warmupTimer);
    }

    state.warmupTimer = null;

    if (state.resolveWarmup) {
      const resolve = state.resolveWarmup;

      state.resolveWarmup = null;
      resolve(null);
    }

    const warmupId = state.warmupId;

    if (!warmupId || state.warmupDeleteSent) {
      return;
    }

    state.warmupDeleteSent = true;
    apiClient.del?.(`/api/chat/transcribe/warmup/${encodeURIComponent(warmupId)}`).catch(() => {});
  }

  /**
   * Прогрев имеет ограниченное ожидание независимо от готовности сервера.
   * Поздний результат отменённого прогрева освобождается прежним путём.
   */
  function startLocalWarmup(state: Capture | null) {
    if (!state || state.warmupStarted || state.warmupCancelled) {
      return state?.warmupPromise;
    }

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
        const warmupId = isRecord(result) && typeof result.warmupId === 'string' ? result.warmupId : '';

        state.warmupId = warmupId;

        if (state.warmupCancelled) {
          cancelLocalWarmup(state);

          return;
        }
        if (state.warmupTimer) {
          clock.clearTimeout(state.warmupTimer);
        }

        state.warmupTimer = null;

        const resolve = state.resolveWarmup;

        state.resolveWarmup = null;
        resolve?.(warmupId || null);
      })
      .catch(() => {
        if (state.warmupTimer) {
          clock.clearTimeout(state.warmupTimer);
        }

        state.warmupTimer = null;

        const resolve = state.resolveWarmup;

        state.resolveWarmup = null;
        resolve?.(null);
      });

    return state.warmupPromise;
  }

  /**
   * Отказ live-предпросмотра сохраняет полную запись для batch fallback.
   * UI получает предупреждение только от ещё актуального владельца.
   */
  function markLocalStreamFailure(run: Run, state: Capture | null, rawError: unknown) {
    if (!state || state.liveError || state.cancelled) {
      return;
    }

    state.liveError = rawError instanceof Error
      ? rawError : speechError('speech_stream_failed', String(rawError || 'live stream failed'));

    if (!isCurrent(run)) {
      return;
    }

    setInterim(run, '');

    if (state.livePreflightUnsupported) {
      startLocalWarmup(state);
    }

    setNotice(run, 'Live-предпросмотр недоступен — итог распознаю после остановки.');
  }

  /**
   * События live-пути меняют только текущую незавершённую запись.
   * После Stop частичный текст больше не публикуется вместо итогового.
   */
  function onLocalStreamEvent(run: Run, state: Capture | null, event: Record<string, unknown>) {
    if (!state || state.cancelled || !isCurrent(run)) {
      return;
    }
    if (event?.type === 'ready') {
      state.liveReady = true;

      return;
    }
    if (event?.type !== 'partial' && event?.type !== 'final' && event?.type !== 'done') {
      return;
    }
    if (event.type === 'partial' && state.stopRequested) {
      return;
    }
    if (typeof event.text === 'string') {
      state.liveFinalText = event.text;
    }
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

  /**
   * Запускает один live-транспорт поверх уже захваченного микрофона.
   * Несовместимость браузера оставляет полный рекордер для прежнего fallback.
   */
  function startLocalStream(run: Run, state: Capture) {
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

  /**
   * Полная запись распознаётся только после подтверждённой остановки.
   * Abort и поколение защищают черновик от результата отменённого запроса.
   */
  async function transcribeLocal(run: Run, state: Capture) {
    if (!state.commit || !isCurrent(run) || state.completionGeneration !== run.generation) {
      return;
    }

    const AbortControllerCtor = media.AbortControllerCtor || globalThis.AbortController;
    const controller = new AbortControllerCtor();

    run.transcriptionAbort?.abort();
    run.transcriptionAbort = controller;
    run.localTranscription = state;
    setPhase(run, 'transcribing');

    try {
      const warmupId = await state.warmupPromise;

      if (!isCurrent(run) || controller.signal.aborted) {
        return;
      }

      const BlobCtor = media.BlobCtor || globalThis.Blob;
      const FormDataCtor = media.FormDataCtor || globalThis.FormData;
      const blob = new BlobCtor(state.chunks, { type: state.recorder.mimeType || 'audio/webm' });

      const form = new FormDataCtor();

      form.append('file', blob, 'dictation.webm');

      if (warmupId) {
        form.append('warmupId', warmupId);
      }
      if (state.liveSessionId) {
        form.append('streamSessionId', state.liveSessionId);
      }

      const result = await apiClient.upload('/api/chat/transcribe', form, { signal: controller.signal });

      if (!isCurrent(run) || controller.signal.aborted) {
        return;
      }

      const text = normalizedPiece(isRecord(result) && typeof result.text === 'string' ? result.text : '');

      if (text) {
        commit(run, text);
        setNotice(run, '');
        releaseRun(run, { final: true });
      } else {
        failRun(run, speechError('speech_not_recognized', 'Речь не распознана — попробуй ещё раз'));
      }
    } catch (error) {
      if (!controller.signal.aborted && isCurrent(run)) {
        failRun(run, speechError('speech_transcribe_failed', `Распознавание: ${failureText(error)}`));
      }
    } finally {
      if (run.transcriptionAbort === controller) {
        run.transcriptionAbort = null;
      }
      if (run.localTranscription === state) {
        run.localTranscription = null;
      }
    }
  }

  /**
   * Сначала принимается итог live-пути, затем при необходимости полная запись.
   * Пустой или ошибочный live-результат не теряет произнесённую человеком фразу.
   */
  async function finishLocalTranscription(run: Run, state: Capture) {
    run.localTranscription = state;

    try {
      const stream = await state.livePromise;

      if (state.cancelled || !isCurrent(run)) {
        return;
      }
      if (stream && !state.liveError) {
        try {
          const done = await (state.liveStopPromise || stream.stop());

          if (state.cancelled || !isCurrent(run)) {
            return;
          }

          const text = normalizedPiece((isRecord(done) ? done.text : '') || state.liveFinalText);

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
      if (state.cancelled || !isCurrent(run)) {
        return;
      }

      setInterim(run, '');
      await transcribeLocal(run, state);
    } finally {
      if (run.localTranscription === state) {
        run.localTranscription = null;
      }
    }
  }

  /**
   * Событие остановки и страховочный таймер сходятся в одном завершении.
   * Дорожки освобождаются до обработки полного результата записи.
   */
  function localRecorderStopped(run: Run, state: Capture | null) {
    if (!state || state.stopped) {
      return;
    }

    state.stopped = true;

    if (state.recorderStopTimer) {
      clock.clearTimeout(state.recorderStopTimer);
    }

    state.recorderStopTimer = null;
    finishLocalCapture(run, state);

    if (state.commit && isCurrent(run)) {
      setPhase(run, 'draining');
      void finishLocalTranscription(run, state);
    }
  }

  /**
   * Локальная запись начинается только при готовом движке и доступном микрофоне.
   * Позднее получение media stream освобождает дорожки отменённого поколения.
   */
  async function startWhisper(run: Run, fallbackReason = '') {
    if (!isCurrent(run) || !run.desired) {
      return;
    }

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
        'Микрофон требует https или localhost — открой GrigDesk по защищённому адресу',
      ));

      return;
    }

    const Recorder = media.recorderCtor();

    if (!Recorder) {
      failRun(run, speechError(
        'speech_recorder_unsupported',
        'MediaRecorder не поддерживается этим браузером',
      ));

      return;
    }

    setPhase(run, 'preparing');

    let stream: MediaStream | null = null;
    let captureState: Capture | null = null;

    try {
      stream = await media.getUserMedia({ audio: true });

      if (!isCurrent(run) || !run.desired) {
        stopTracks(stream);

        return;
      }

      const mime = typeof Recorder.isTypeSupported === 'function'
        && Recorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
      const recorder = new Recorder(stream, mime ? { mimeType: mime } : undefined);

      const state: Capture = {
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
        if (event.data?.size) {
          state.chunks.push(event.data);
        }
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
            `Микрофон: ${('error' in event && event.error instanceof Error
              ? event.error.message : '') || 'ошибка записи'}`,
          ));
        }

        localRecorderStopped(run, state);
      };
      recorder.start();
      startLocalStream(run, state);
      setPhase(run, 'recording');

      if (fallbackReason) {
        setNotice(run, `${fallbackReason} Использую локальный Whisper.`);
      }
    } catch (error) {
      if (captureState) {
        finishLocalCapture(run, captureState);
      } else {
        stopTracks(stream);
      }
      if (isCurrent(run)) {
        failRun(run, speechError('speech_microphone_failed', `Микрофон: ${failureText(error)}`));
      }
    }
  }

  /**
   * Подготовка нового запуска сбрасывает только его временные результаты.
   * Выбор транспорта следует текущим настройкам без автоматической смены согласия.
   */
  async function beginRun(run: Run, { browserAutoValidationRevision = '' } = {}) {
    if (!isCurrent(run)) {
      return;
    }

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

  /**
   * Жест потребителя сначала захватывает исключительное право на микрофон.
   * Неподтверждённый auto-режим останавливается на прежнем запросе consent.
   */
  async function startLease(lease: Lease) {
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

  /**
   * Согласие сохраняется с revision и проверяется перед запуском браузера.
   * Конфликт другого окна возвращает актуальную форму без тихого включения режима.
   */
  async function confirmBrowserConsent(lease: Lease) {
    const run = activeRun;

    if (!isCurrent(run) || run.lease !== lease || lease.mutableState.prompt !== 'browser-consent') {
      return false;
    }

    run.pendingMutation = true;
    setPhase(run, 'preparing');

    const context = captureSettingsContext(run);

    try {
      const response = await apiClient.post('/api/settings/speech/browser-consent', {
        confirm: true,
        revision: context.revision,
      });

      if (!isCurrent(run)) {
        return false;
      }

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
      if (!isCurrent(run)) {
        return false;
      }

      run.pendingMutation = false;

      if (isRecord(error) && error.status === 409) {
        try {
          const latest = await apiClient.get('/api/settings/speech');

          if (isCurrent(run)) {
            applySpeechResponse(latest);
          }
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
        `Не удалось сохранить согласие: ${failureText(error)}`,
      ));

      return false;
    }
  }

  /**
   * Ручной выбор Whisper подтверждается сервером до начала захвата.
   * Устаревший ответ настроек не запускает отменённый режим.
   */
  async function useWhisper(lease: Lease) {
    const run = activeRun;

    if (!isCurrent(run) || run.lease !== lease || lease.mutableState.phase !== 'prompt') {
      return false;
    }

    run.pendingMutation = true;
    setPhase(run, 'preparing');

    const context = captureSettingsContext(run);

    try {
      const response = await apiClient.post('/api/settings/speech', { engine: 'whisper' });

      if (!isCurrent(run)) {
        return false;
      }

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
          `Не удалось выбрать Whisper: ${failureText(error)}`,
        ));
      }

      return false;
    }
  }

  /**
   * Установка языковой модели привязана к исходному запросу и настройкам.
   * После ожидания проверяется поколение, чтобы не запустить прежний язык.
   */
  async function installBrowserLanguage(lease: Lease) {
    const run = activeRun;
    const pending = run?.pendingBrowserInstall;

    if (!isCurrent(run) || run.lease !== lease || lease.mutableState.prompt !== 'browser-install'
      || !pending?.Ctor || !pending.context) {
      return false;
    }
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
      const installed = await pending.Ctor.install!(pending.options);

      if (!isCurrent(run) || !run.desired) {
        return false;
      }
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
      if (isCurrent(run)) {
        fallbackToWhisper(run, `Не удалось установить языковую модель: ${failureText(error)}.`);
      }

      return false;
    }
  }

  /**
   * Нормальная остановка ждёт последние слова браузера или рекордера.
   * Stop до получения оборудования равен отмене и не создаёт пустого результата.
   */
  function stopRunNormally(run: Run) {
    if (!isCurrent(run)) {
      return Promise.resolve(false);
    }

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
        } else {
          localRecorderStopped(run, state);
        }
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

  /**
   * Отмена снимает оба транспорта и запрещает публикацию итогового текста.
   * Cleanup независимых ресурсов завершается даже при ошибке одного из них.
   */
  function cancelRun(run: Run, { notice = '' } = {}) {
    if (!isCurrent(run)) {
      return Promise.resolve(false);
    }

    run.cancelled = true;
    run.desired = false;
    clearTimer(run, 'browserRestartTimer');
    clearTimer(run, 'browserDrainTimer');
    setInterim(run, '');

    if (run.activeRecognition) {
      releaseRecognition(run, run.activeRecognition, 'abort');
    }
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
        if (state.recorder.state && state.recorder.state !== 'inactive') {
          state.recorder.stop();
        } else {
          localRecorderStopped(run, state);
        }
      } catch { localRecorderStopped(run, state); }

      finishLocalCapture(run, state);
    }

    releaseRun(run, { notice });

    return Promise.allSettled(cleanup).then(() => true);
  }

  /**
   * Регистрирует потребителя без захвата микрофона до его явного старта.
   * Методы lease освобождают только принадлежащий этому потребителю запуск.
   */
  function acquire(owner: unknown, handlers: LeaseHandlers = {}): Lease {
    if (disposed) {
      throw speechError('speech_disposed', 'Машина диктовки уже остановлена');
    }
    if (owner === null || owner === undefined) {
      throw new TypeError('Для lease нужен owner');
    }

    const mutableState = reactive<LeaseState>({
      phase: 'idle',
      busy: false,
      prompt: null,
      interim: '',
      notice: '',
      error: null,
      blockedByOther: !!activeLease,
    });

    const lease: Lease = {
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
      /**
       * Снятие потребителя отменяет только принадлежащую ему запись.
       * Повторный release не затрагивает владельца другого интерфейса.
       */
      release() {
        if (lease.released) {
          return Promise.resolve(false);
        }

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

  /**
   * Внешняя смена настроек отменяет запись прежнего поколения.
   * Собственное подтверждение consent отличает ожидаемый отпечаток ответа.
   */
  function syncSettings(next: unknown) {
    settingsEpoch += 1;

    const fingerprint = speechExecutionFingerprint(next || speechPrefs());

    if (expectedSettingsFingerprint && fingerprint === expectedSettingsFingerprint) {
      return;
    }

    const run = activeRun;

    if (!isCurrent(run) || run.pendingMutation) {
      return;
    }

    void cancelRun(run, { notice: 'Диктовка остановлена: настройки речи изменились.' });
  }

  /**
   * Остановка контроллера отзывает все lease и активное оборудование.
   * Повторный вызов безопасен и не создаёт новых запросов или таймеров.
   */
  function dispose() {
    if (disposed) {
      return Promise.resolve();
    }

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

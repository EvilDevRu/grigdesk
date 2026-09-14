// Точный план монтажа одной сцены по измеренным шкалам речи и записи.
//
// Модуль остаётся чистым: он не читает артефакты, не вызывает ffmpeg и не меняет
// проект. Этап 2 подаёт измерения фикстурами; будущий production-путь сможет
// заменить их JSON-документами той же формы после отдельной проверки хешей.
// Старый монтаж возвращается отдельным результатом `legacy` и потому никогда не
// выдаётся за точную синхронизацию.

import type { ShowcaseTiming } from '../../../../../shared/showcaseContracts.ts';
import {
  validateShowcaseSyncBindings,
} from '../../../../../shared/showcaseSync.ts';
import type {
  ShowcaseSyncCue,
  ShowcaseSyncCueKind,
  ShowcaseSyncValidationInput,
} from '../../../../../shared/showcaseSync.ts';
import {
  planScene,
  POST_ROLL_MS,
  PRE_ROLL_MS,
} from '../../../../../shared/showcaseTimeline.ts';

export interface SpeechSpanTiming {
  from: number;
  to: number;
  startMs: number;
  endMs: number;
  precision: 'word' | 'phrase';
}

export interface SpeechPhraseTiming {
  id: string;
  from: number;
  to: number;
  startMs: number;
  endMs: number;
}

export interface SafeSpeechPause {
  id: string;
  textAt: number;
  atMs: number;
  quietFromMs: number;
  quietToMs: number;
}

export interface SpeechFixtureTiming {
  canonicalText: string;
  durationMs: number;
  sampleRate: number;
  sampleCount: number;
  quality: 'word-exact' | 'phrase' | 'approximate';
  spans: readonly SpeechSpanTiming[];
  phrases: readonly SpeechPhraseTiming[];
  safePauses: readonly SafeSpeechPause[];
}

export interface RecordingActionTiming {
  actionIndex: number;
  kind: string;
  startMs: number;
  anchorMs: number;
  endMs: number;
  readyMs: number | null;
}

export interface StableVideoInterval {
  id: string;
  fromMs: number;
  toMs: number;
  frameMs: number;
  afterActionIndex: number | null;
  beforeActionIndex: number | null;
}

export interface RemovableVideoWait {
  id: string;
  fromMs: number;
  toMs: number;
  // `null`/отсутствует у хвоста. Для legacy-разметки достаточно
  // beforeActionIndex; measured recorder дополнительно называет явное действие
  // wait, внутри которого разрешён cut.
  actionIndex?: number | null;
  beforeActionIndex: number | null;
}

export interface HighlightGeometry {
  actionIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  validFromMs: number;
  validToMs: number;
  stableIntervalId: string;
}

export interface RecordingFixtureTiming {
  durationMs: number;
  calibration: 'fixture-exact' | 'calibrated' | 'unavailable';
  calibrationErrorMs: number;
  actions: readonly RecordingActionTiming[];
  stableIntervals: readonly StableVideoInterval[];
  removableWaits: readonly RemovableVideoWait[];
  highlights: readonly HighlightGeometry[];
}

export interface SyncPlanInput {
  bindingInput: ShowcaseSyncValidationInput | null;
  speech: SpeechFixtureTiming | null;
  recording: RecordingFixtureTiming | null;
  legacy: {
    audioMs: number;
    clipMs: number;
  };
  style: {
    width: number;
    height: number;
    fps: number;
  };
  limits: {
    maxSceneMs: number;
    remainingFilmMs: number;
  };
  options?: {
    preRollMs?: number;
    postRollMs?: number;
    maxCueErrorMs?: number;
    maxRecordingErrorMs?: number;
  };
}

export type SyncDiagnosticSeverity = 'info' | 'warning' | 'conflict';

export type SyncDiagnosticCode =
  | 'missing_bindings'
  | 'missing_speech_timing'
  | 'missing_recording_timing'
  | 'approximate_speech_timing'
  | 'uncalibrated_recording'
  | 'stale_bindings'
  | 'invalid_bindings'
  | 'invalid_options'
  | 'invalid_speech_timing'
  | 'invalid_recording_timing'
  | 'unmapped_text_range'
  | 'missing_action_event'
  | 'action_event_mismatch'
  | 'reverse_video_order'
  | 'no_stable_frame'
  | 'no_safe_pause'
  | 'missing_highlight_geometry'
  | 'scene_limit_exceeded'
  | 'film_limit_exceeded'
  | 'cue_tolerance_exceeded'
  | 'video_hold_added'
  | 'empty_wait_removed'
  | 'silence_inserted';

export interface SyncDiagnostic {
  severity: SyncDiagnosticSeverity;
  code: SyncDiagnosticCode;
  message: string;
  cueId: string | null;
  actionIndex: number | null;
  requiredMs: number | null;
  availableMs: number | null;
}

export interface SourceVideoPart {
  kind: 'source';
  sourceFromMs: number;
  sourceToMs: number;
  outputFromMs: number;
  outputToMs: number;
}

export interface HoldVideoPart {
  kind: 'hold';
  sourceAtMs: number;
  outputFromMs: number;
  outputToMs: number;
  stableIntervalId: string;
  cueId: string | null;
}

export type SyncVideoPart = SourceVideoPart | HoldVideoPart;

export interface SourceAudioPart {
  kind: 'source';
  sourceFromSample: number;
  sourceToSample: number;
  outputFromMs: number;
  outputToMs: number;
}

export interface SilenceAudioPart {
  kind: 'silence';
  sampleCount: number;
  sampleRate: number;
  outputFromMs: number;
  outputToMs: number;
  reason: 'pre-roll' | 'cue-delay' | 'tail';
  cueId: string | null;
}

export type SyncAudioPart = SourceAudioPart | SilenceAudioPart;

export interface RemovedVideoWait {
  id: string;
  sourceFromMs: number;
  sourceToMs: number;
  removedMs: number;
  cueId: string;
}

export interface SyncHighlightTiming {
  cueId: string;
  actionIndex: number;
  startMs: number;
  endMs: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SyncCueTiming {
  cueId: string;
  kind: ShowcaseSyncCueKind;
  actionIndex: number;
  textFrom: number;
  textTo: number;
  speechStartMs: number;
  speechEndMs: number;
  eventMs: number;
  errorMs: number;
}

export interface SyncPhraseOutputTiming {
  id: string;
  from: number;
  to: number;
  startMs: number;
  endMs: number;
}

// Точный план хранит дробные миллисекунды. Общий `ShowcaseTiming` декодируется как
// целые значения и остаётся контрактом legacy-пути до появления manifest codec.
export interface ExactSyncTiming {
  preRollMs: number;
  narrationStartMs: number;
  speechEndMs: number;
  actionsEndMs: number;
  postRollMs: number;
  totalMs: number;
}

export interface ExactSyncSourceAudio {
  sampleRate: number;
  sampleCount: number;
  durationMs: number;
}

export interface ExactSyncSourceVideo {
  durationMs: number;
  fps: number;
}

export interface ExactSyncPlan {
  version: 1;
  mode: 'exact';
  timing: ExactSyncTiming;
  sourceAudio: ExactSyncSourceAudio;
  sourceVideo: ExactSyncSourceVideo;
  videoParts: readonly SyncVideoPart[];
  audioParts: readonly SyncAudioPart[];
  removedWaits: readonly RemovedVideoWait[];
  highlights: readonly SyncHighlightTiming[];
  cues: readonly SyncCueTiming[];
  phrases: readonly SyncPhraseOutputTiming[];
}

export type SyncPlanResult =
  | {
    status: 'exact';
    plan: ExactSyncPlan;
    diagnostics: SyncDiagnostic[];
  }
  | {
    status: 'legacy';
    timing: ShowcaseTiming;
    diagnostics: SyncDiagnostic[];
  }
  | {
    status: 'conflict';
    diagnostics: SyncDiagnostic[];
  };

interface PlannerOptions {
  preRollMs: number;
  postRollMs: number;
  maxCueErrorMs: number;
  maxRecordingErrorMs: number;
}

interface VideoHoldEdit {
  sourceAtMs: number;
  durationMs: number;
  stableIntervalId: string;
  cueId: string | null;
}

interface VideoCutEdit {
  id: string;
  sourceFromMs: number;
  sourceToMs: number;
  cueId: string;
}

interface AudioSilenceEdit {
  sourceAtSample: number;
  sampleCount: number;
  reason: 'pre-roll' | 'cue-delay' | 'tail';
  cueId: string | null;
  safePauseId: string | null;
  textAt: number | null;
}

interface ProcessedCue {
  id: string;
  kind: ShowcaseSyncCueKind;
  from: number;
  to: number;
}

interface ResolvedSpeechRange {
  startMs: number;
  endMs: number;
}

interface PlanningState {
  holds: VideoHoldEdit[];
  cuts: VideoCutEdit[];
  silences: AudioSilenceEdit[];
  diagnostics: SyncDiagnostic[];
  protectedVideoUntilMs: number;
  protectedVideoSourceUntilMs: number;
  protectedTextTo: number;
  processedCues: ProcessedCue[];
  frameMs: number;
}

const EPSILON_MS = 0.001;
const SIGNIFICANT_TEXT = /[\p{L}\p{N}]/u;
const SPEECH_QUALITIES = new Set(['word-exact', 'phrase', 'approximate']);
const SPAN_PRECISIONS = new Set(['word', 'phrase']);
const RECORDING_CALIBRATIONS = new Set(['fixture-exact', 'calibrated', 'unavailable']);

function diagnostic(
  severity: SyncDiagnosticSeverity,
  code: SyncDiagnosticCode,
  message: string,
  details: Partial<Pick<
  SyncDiagnostic,
  'cueId' | 'actionIndex' | 'requiredMs' | 'availableMs'
  >> = {},
): SyncDiagnostic {
  return {
    severity,
    code,
    message,
    cueId: details.cueId ?? null,
    actionIndex: details.actionIndex ?? null,
    requiredMs: details.requiredMs ?? null,
    availableMs: details.availableMs ?? null,
  };
}

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function rangeInside(from: number, to: number, length: number): boolean {
  return Number.isSafeInteger(from)
    && Number.isSafeInteger(to)
    && from >= 0
    && from < to
    && to <= length;
}

/** Ошибка одной из внешних шкал завершает точный путь, а не исправляется сортировкой. */
function conflict(
  code: SyncDiagnosticCode,
  message: string,
  details: Partial<Pick<
  SyncDiagnostic,
  'cueId' | 'actionIndex' | 'requiredMs' | 'availableMs'
  >> = {},
): SyncPlanResult {
  return { status: 'conflict', diagnostics: [diagnostic('conflict', code, message, details)] };
}

/** Legacy остаётся тем же расписанием и всегда несёт объяснение запасного режима. */
function legacy(
  input: SyncPlanInput,
  code: SyncDiagnosticCode,
  message: string,
): SyncPlanResult {
  return {
    status: 'legacy',
    timing: planScene(input.legacy),
    diagnostics: [diagnostic('warning', code, message)],
  };
}

/** Проверяет общие настройки раньше любых вычислений с временными шкалами. */
function optionsOf(input: SyncPlanInput): PlannerOptions | null {
  const options: PlannerOptions = {
    preRollMs: input.options?.preRollMs ?? PRE_ROLL_MS,
    postRollMs: input.options?.postRollMs ?? POST_ROLL_MS,
    maxCueErrorMs: input.options?.maxCueErrorMs ?? 250,
    maxRecordingErrorMs: input.options?.maxRecordingErrorMs ?? 100,
  };
  const values = Object.values(options);

  if (
    values.some((value) => !finiteNonNegative(value))
    || !positiveInteger(input.style.width)
    || !positiveInteger(input.style.height)
    || !positiveInteger(input.style.fps)
    || !finiteNonNegative(input.limits.maxSceneMs)
    || !finiteNonNegative(input.limits.remainingFilmMs)
    || !finiteNonNegative(input.legacy.audioMs)
    || !finiteNonNegative(input.legacy.clipMs)
  ) {
    return null;
  }

  return options;
}

/** Граница текстовой метки не должна разрезать UTF-16 surrogate pair. */
function splitsUtf16Character(text: string, at: number): boolean {
  if (at <= 0 || at >= text.length) {
    return false;
  }

  const before = text.charCodeAt(at - 1);
  const after = text.charCodeAt(at);

  return before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF;
}

/**
 * Метки речи уже сопоставлены с каноническим текстом, но остаются недоверенным
 * производным JSON: ни порядок, ни длительность здесь не восстанавливаются молча.
 */
function validateSpeechTiming(speech: SpeechFixtureTiming): string | null {
  if (
    typeof speech.canonicalText !== 'string'
    || !finiteNonNegative(speech.durationMs)
    || speech.durationMs <= 0
    || !positiveInteger(speech.sampleRate)
    || !positiveInteger(speech.sampleCount)
    || !SPEECH_QUALITIES.has(speech.quality)
    || !Array.isArray(speech.spans)
    || !Array.isArray(speech.phrases)
    || !Array.isArray(speech.safePauses)
  ) {
    return 'Длительность или PCM-профиль меток речи некорректны.';
  }

  const pcmDurationMs = speech.sampleCount * 1000 / speech.sampleRate;
  const sampleMs = 1000 / speech.sampleRate;

  if (Math.abs(pcmDurationMs - speech.durationMs) > sampleMs + EPSILON_MS) {
    return 'Длительность меток речи не совпадает с числом PCM-отсчётов.';
  }

  let previousTextTo = 0;
  let previousAudioEnd = 0;

  for (const span of speech.spans) {
    if (
      typeof span !== 'object'
      || span === null
      || !SPAN_PRECISIONS.has(span.precision)
      || !rangeInside(span.from, span.to, speech.canonicalText.length)
      || splitsUtf16Character(speech.canonicalText, span.from)
      || splitsUtf16Character(speech.canonicalText, span.to)
      || !finiteNonNegative(span.startMs)
      || !finiteNonNegative(span.endMs)
      || span.startMs >= span.endMs
      || span.endMs > speech.durationMs + EPSILON_MS
      || span.from < previousTextTo
      || span.startMs + EPSILON_MS < previousAudioEnd
    ) {
      return 'Словесные метки речи выходят за текст, WAV или нарушают исходный порядок.';
    }

    previousTextTo = span.to;
    previousAudioEnd = span.endMs;
  }

  const phraseIds = new Set<string>();

  previousTextTo = 0;
  previousAudioEnd = 0;

  for (const phrase of speech.phrases) {
    if (
      typeof phrase !== 'object'
      || phrase === null
      || typeof phrase.id !== 'string'
      || phrase.id.trim() === ''
      || phraseIds.has(phrase.id)
      || !rangeInside(phrase.from, phrase.to, speech.canonicalText.length)
      || splitsUtf16Character(speech.canonicalText, phrase.from)
      || splitsUtf16Character(speech.canonicalText, phrase.to)
      || !finiteNonNegative(phrase.startMs)
      || !finiteNonNegative(phrase.endMs)
      || phrase.startMs >= phrase.endMs
      || phrase.endMs > speech.durationMs + EPSILON_MS
      || phrase.from < previousTextTo
      || phrase.startMs + EPSILON_MS < previousAudioEnd
    ) {
      return 'Фразовые метки речи повторяются, выходят за WAV или нарушают порядок.';
    }

    phraseIds.add(phrase.id);
    previousTextTo = phrase.to;
    previousAudioEnd = phrase.endMs;
  }

  if (speech.quality === 'word-exact' && speech.spans.some((span) => span.precision !== 'word')) {
    return 'Точный режим получил фразовую метку вместо словесной.';
  }

  if (speech.quality === 'word-exact') {
    const wordOutsidePhrase = speech.spans.some((span) => !speech.phrases.some((phrase) => (
      phrase.from <= span.from
      && span.to <= phrase.to
      && phrase.startMs <= span.startMs + EPSILON_MS
      && span.endMs <= phrase.endMs + EPSILON_MS
    )));

    if (speech.phrases.length === 0 || wordOutsidePhrase) {
      return 'Точные словесные метки не покрыты согласованными фразовыми интервалами.';
    }
  }

  const pauseIds = new Set<string>();
  let previousPauseAt = -1;

  for (const pause of speech.safePauses) {
    if (
      typeof pause !== 'object'
      || pause === null
      || typeof pause.id !== 'string'
      || pause.id.trim() === ''
      || pauseIds.has(pause.id)
      || !Number.isSafeInteger(pause.textAt)
      || pause.textAt < 0
      || pause.textAt > speech.canonicalText.length
      || splitsUtf16Character(speech.canonicalText, pause.textAt)
      || !finiteNonNegative(pause.quietFromMs)
      || !finiteNonNegative(pause.atMs)
      || !finiteNonNegative(pause.quietToMs)
      || pause.quietFromMs > pause.atMs
      || pause.atMs > pause.quietToMs
      || pause.quietFromMs >= pause.quietToMs
      || pause.quietToMs > speech.durationMs + EPSILON_MS
      || pause.atMs + EPSILON_MS < previousPauseAt
    ) {
      return 'Безопасные паузы речи повторяются, выходят за WAV или нарушают порядок.';
    }

    const previousPhrase = [...speech.phrases]
      .filter((phrase) => phrase.to <= pause.textAt)
      .sort((left, right) => right.to - left.to || right.endMs - left.endMs)[0];
    const nextPhrase = [...speech.phrases]
      .filter((phrase) => phrase.from >= pause.textAt)
      .sort((left, right) => left.from - right.from || left.startMs - right.startMs)[0];

    if (
      !previousPhrase
      || !nextPhrase
      || previousPhrase.endMs > pause.quietFromMs + EPSILON_MS
      || nextPhrase.startMs + EPSILON_MS < pause.quietToMs
    ) {
      return 'Безопасная пауза не подтверждена границей двух законченных фраз.';
    }

    const crossesWord = speech.spans.some((span) => (
      span.precision === 'word' && span.from < pause.textAt && pause.textAt < span.to
    ));
    const overlapsSpeech = speech.spans.some((span) => (
      span.startMs < pause.quietToMs && pause.quietFromMs < span.endMs
    ));

    if (crossesWord || overlapsSpeech) {
      return 'Безопасная пауза пересекает слово или измеренный звук речи.';
    }

    pauseIds.add(pause.id);
    previousPauseAt = pause.atMs;
  }

  return null;
}

/** Журнал записи обязан перечислять действия в том порядке, в котором снят клип. */
function validateRecordingTiming(
  recording: RecordingFixtureTiming,
  input: SyncPlanInput,
): string | null {
  if (!finiteNonNegative(recording.durationMs) || recording.durationMs <= 0) {
    return 'Длительность журнала записи некорректна.';
  }

  const frameMs = 1000 / input.style.fps;

  if (Math.abs(recording.durationMs - nearestFrameDuration(recording.durationMs, frameMs)) > 0.01) {
    return 'Длительность записи не лежит на границе кадров заданной частоты.';
  }

  if (!finiteNonNegative(recording.calibrationErrorMs)) {
    return 'Погрешность калибровки записи некорректна.';
  }

  if (
    !RECORDING_CALIBRATIONS.has(recording.calibration)
    || !Array.isArray(recording.actions)
    || !Array.isArray(recording.stableIntervals)
    || !Array.isArray(recording.removableWaits)
    || !Array.isArray(recording.highlights)
  ) {
    return 'Режим калибровки или списки журнала записи некорректны.';
  }

  const expectedActions = input.bindingInput?.actions ?? [];

  if (recording.actions.length !== expectedActions.length) {
    return 'Журнал записи перечисляет не все действия сцены.';
  }

  let previousActionEnd = 0;

  for (const [index, action] of recording.actions.entries()) {
    if (
      typeof action !== 'object'
      || action === null
      || action.actionIndex !== index
      || action.kind !== expectedActions[index]?.kind
      || !finiteNonNegative(action.startMs)
      || !finiteNonNegative(action.anchorMs)
      || !finiteNonNegative(action.endMs)
      || action.startMs > action.anchorMs
      || action.anchorMs > action.endMs
      || action.endMs > recording.durationMs + EPSILON_MS
      || action.startMs + EPSILON_MS < previousActionEnd
      || (action.readyMs !== null && (
        !finiteNonNegative(action.readyMs)
        || action.readyMs < action.anchorMs
        || action.readyMs > action.endMs
      ))
    ) {
      return 'События действий не совпадают со сценой или нарушают шкалу записи.';
    }

    previousActionEnd = action.endMs;
  }

  const stableIds = new Set<string>();
  let previousStableFrom = -1;

  for (const interval of recording.stableIntervals) {
    if (typeof interval !== 'object' || interval === null) {
      return 'Устойчивые интервалы записи содержат некорректный элемент.';
    }

    const afterIsValid = interval.afterActionIndex === null
      || Number.isSafeInteger(interval.afterActionIndex)
        && interval.afterActionIndex >= 0
        && interval.afterActionIndex < recording.actions.length;
    const beforeIsValid = interval.beforeActionIndex === null
      || Number.isSafeInteger(interval.beforeActionIndex)
        && interval.beforeActionIndex >= 0
        && interval.beforeActionIndex < recording.actions.length;
    const afterAction = interval.afterActionIndex === null
      ? null
      : recording.actions[interval.afterActionIndex];
    const beforeAction = interval.beforeActionIndex === null
      ? null
      : recording.actions[interval.beforeActionIndex];

    if (
      typeof interval.id !== 'string'
      || interval.id.trim() === ''
      || stableIds.has(interval.id)
      || !finiteNonNegative(interval.fromMs)
      || !finiteNonNegative(interval.frameMs)
      || !finiteNonNegative(interval.toMs)
      || interval.fromMs > interval.frameMs
      || interval.frameMs > interval.toMs
      || interval.frameMs >= recording.durationMs
      || Math.abs(interval.frameMs - nearestFrameDuration(interval.frameMs, frameMs)) > 0.01
      || interval.fromMs >= interval.toMs
      || interval.toMs > recording.durationMs + EPSILON_MS
      || interval.fromMs + EPSILON_MS < previousStableFrom
      || !afterIsValid
      || !beforeIsValid
      || (afterAction && interval.fromMs + EPSILON_MS < afterAction.endMs)
      || (beforeAction && interval.toMs > beforeAction.startMs + EPSILON_MS)
      || (
        interval.afterActionIndex !== null
        && interval.beforeActionIndex !== null
        && interval.afterActionIndex >= interval.beforeActionIndex
      )
    ) {
      return 'Устойчивые интервалы записи повторяются или выходят за шкалу клипа.';
    }

    stableIds.add(interval.id);
    previousStableFrom = interval.fromMs;
  }

  const waitIds = new Set<string>();
  let previousWaitTo = 0;

  for (const wait of recording.removableWaits) {
    if (typeof wait !== 'object' || wait === null) {
      return 'Удаляемые ожидания содержат некорректный элемент.';
    }

    const before = wait.beforeActionIndex === null
      ? null
      : recording.actions[wait.beforeActionIndex];
    const previous = wait.beforeActionIndex === null
      ? recording.actions.at(-1)
      : recording.actions[wait.beforeActionIndex - 1];
    const explicit = wait.actionIndex === null || wait.actionIndex === undefined
      ? null
      : recording.actions[wait.actionIndex];
    const explicitValid = explicit
      ? explicit.kind === 'wait'
        && wait.fromMs + EPSILON_MS >= explicit.startMs
        && wait.toMs <= explicit.endMs + EPSILON_MS
        && (wait.beforeActionIndex === null || wait.beforeActionIndex === explicit.actionIndex + 1)
      : wait.actionIndex === null || wait.actionIndex === undefined;
    const beforeIndexValid = wait.beforeActionIndex === null
      || Number.isSafeInteger(wait.beforeActionIndex)
        && wait.beforeActionIndex >= 0
        && wait.beforeActionIndex < recording.actions.length;
    const implicitValid = explicit
      ? true
      : Boolean(before)
        && wait.toMs <= (before?.startMs ?? -1) + EPSILON_MS
        && wait.fromMs + EPSILON_MS >= (previous?.endMs ?? 0);

    if (
      typeof wait.id !== 'string'
      || wait.id.trim() === ''
      || waitIds.has(wait.id)
      || (wait.beforeActionIndex !== null && !Number.isSafeInteger(wait.beforeActionIndex))
      || (wait.actionIndex !== null
        && wait.actionIndex !== undefined
        && !Number.isSafeInteger(wait.actionIndex))
      || !finiteNonNegative(wait.fromMs)
      || !finiteNonNegative(wait.toMs)
      || wait.fromMs >= wait.toMs
      || wait.toMs > recording.durationMs + EPSILON_MS
      || !explicitValid
      || !beforeIndexValid
      || !implicitValid
      || wait.fromMs + EPSILON_MS < previousWaitTo
    ) {
      return 'Удаляемые ожидания пересекают действия или нарушают порядок записи.';
    }

    waitIds.add(wait.id);
    previousWaitTo = wait.toMs;
  }

  const geometryActions = new Set<number>();

  for (const geometry of recording.highlights) {
    if (typeof geometry !== 'object' || geometry === null) {
      return 'Геометрия подсветки содержит некорректный элемент.';
    }

    const action = recording.actions[geometry.actionIndex];
    const interval = recording.stableIntervals.find(
      (candidate) => candidate.id === geometry.stableIntervalId,
    );

    if (
      !Number.isSafeInteger(geometry.actionIndex)
      || !action
      || action.kind !== 'highlight'
      || geometryActions.has(geometry.actionIndex)
      || !interval
      || !finiteNonNegative(geometry.x)
      || !finiteNonNegative(geometry.y)
      || !finiteNonNegative(geometry.width)
      || !finiteNonNegative(geometry.height)
      || geometry.width <= 0
      || geometry.height <= 0
      || geometry.x + geometry.width > input.style.width + EPSILON_MS
      || geometry.y + geometry.height > input.style.height + EPSILON_MS
      || !finiteNonNegative(geometry.validFromMs)
      || !finiteNonNegative(geometry.validToMs)
      || geometry.validFromMs >= geometry.validToMs
      || geometry.validToMs > recording.durationMs + EPSILON_MS
      || interval.frameMs < geometry.validFromMs
      || interval.frameMs > geometry.validToMs
    ) {
      return 'Геометрия подсветки не соответствует действию или устойчивому кадру.';
    }

    geometryActions.add(geometry.actionIndex);
  }

  return null;
}

/** Значимые буквы и числа диапазона должны целиком покрываться словесными метками. */
function resolveSpeechRange(
  speech: SpeechFixtureTiming,
  cue: ShowcaseSyncCue,
): ResolvedSpeechRange | null {
  const spans = speech.spans.filter((span) => span.from < cue.to && cue.from < span.to);

  if (spans.length === 0 || spans.some((span) => span.from < cue.from || span.to > cue.to)) {
    return null;
  }

  let cursor = cue.from;

  for (const span of spans) {
    if (SIGNIFICANT_TEXT.test(speech.canonicalText.slice(cursor, span.from))) {
      return null;
    }

    cursor = span.to;
  }

  if (SIGNIFICANT_TEXT.test(speech.canonicalText.slice(cursor, cue.to))) {
    return null;
  }

  return {
    startMs: spans[0]?.startMs ?? 0,
    endMs: spans.at(-1)?.endMs ?? 0,
  };
}

function sampleAt(ms: number, sampleRate: number): number {
  return Math.max(0, Math.round(ms * sampleRate / 1000));
}

function samplesFor(ms: number, sampleRate: number): number {
  return Math.max(0, Math.ceil(ms * sampleRate / 1000));
}

function samplesMs(samples: number, sampleRate: number): number {
  return samples * 1000 / sampleRate;
}

function nearestFrameDuration(ms: number, frameMs: number): number {
  return Math.max(0, Math.round(ms / frameMs)) * frameMs;
}

function frameDurationAtLeast(ms: number, frameMs: number): number {
  // Малый сдвиг защищает от лишнего кадра только на арифметически точной границе.
  const frames = Math.ceil(Math.max(0, ms) / frameMs - 1e-9);

  return Math.max(0, frames) * frameMs;
}

function frameAtOrBefore(ms: number, frameMs: number): number {
  return Math.max(0, Math.floor(ms / frameMs + 1e-9)) * frameMs;
}

function gcd(left: number, right: number): number {
  let a = left;
  let b = right;

  while (b !== 0) {
    const remainder = a % b;

    a = b;
    b = remainder;
  }

  return a;
}

interface CommonMediaBoundary {
  frames: number;
  samples: number;
  ms: number;
}

/** Находит первую границу, представимую и целым кадром, и PCM-отсчётом. */
function commonMediaBoundaryAtLeast(
  requiredMs: number,
  sampleRate: number,
  fps: number,
): CommonMediaBoundary | null {
  const commonRate = gcd(sampleRate, fps);
  const quantumMs = 1000 / commonRate;
  const quanta = Math.ceil(requiredMs / quantumMs - 1e-9);
  const frames = quanta * (fps / commonRate);
  const samples = quanta * (sampleRate / commonRate);

  if (!Number.isSafeInteger(frames) || !Number.isSafeInteger(samples)) {
    return null;
  }

  return { frames, samples, ms: samplesMs(samples, sampleRate) };
}

/** Переводит исходное время видео после уже выбранных вырезов и удержаний. */
function videoOutputAt(
  sourceMs: number,
  state: PlanningState,
  edge: 'event' | 'end' = 'event',
): number {
  let outputMs = sourceMs;

  for (const cut of state.cuts) {
    if (sourceMs >= cut.sourceToMs) {
      outputMs -= cut.sourceToMs - cut.sourceFromMs;
    } else if (sourceMs > cut.sourceFromMs) {
      outputMs -= sourceMs - cut.sourceFromMs;
    }
  }

  for (const hold of state.holds) {
    // Стоп-кадр начинается в момент исходного кадра. Событие ровно на этом PTS
    // уже показано в начале hold и не должно задним числом уезжать в его конец.
    if (sourceMs > hold.sourceAtMs || (edge === 'end' && sourceMs >= hold.sourceAtMs)) {
      outputMs += hold.durationMs;
    }
  }

  return outputMs;
}

/**
 * Тишина в позиции границы относится к следующему фрагменту. Поэтому начало
 * слова включает вставку на той же позиции, а конец предыдущего слова — нет.
 */
function audioOutputAt(
  sourceMs: number,
  edge: 'start' | 'end',
  speech: SpeechFixtureTiming,
  state: PlanningState,
): number {
  const sourceSample = sourceMs * speech.sampleRate / 1000;
  let outputMs = sourceMs;

  for (const silence of state.silences) {
    const beforeSource = silence.sourceAtSample < sourceSample - EPSILON_MS;
    const atSourceStart = edge === 'start'
      && silence.sourceAtSample <= sourceSample + EPSILON_MS;

    if (silence.reason === 'pre-roll' || beforeSource || atSourceStart) {
      outputMs += samplesMs(silence.sampleCount, speech.sampleRate);
    }
  }

  return outputMs;
}

/** Удержание берётся только после уже зафиксированного состояния и до движения действия. */
function stableBeforeAction(
  action: RecordingActionTiming,
  recording: RecordingFixtureTiming,
  state: PlanningState,
): StableVideoInterval | null {
  const candidates = recording.stableIntervals.filter((interval) => (
    // Кадр на самой границе действия уже может содержать нажатый курсор или
    // первый кадр анимации и потому не годится как состояние «до действия».
    interval.frameMs + EPSILON_MS < action.startMs
    && interval.frameMs + EPSILON_MS >= state.protectedVideoSourceUntilMs
    && videoOutputAt(interval.frameMs, state) + EPSILON_MS >= state.protectedVideoUntilMs
    && !state.cuts.some((cut) => (
      cut.sourceFromMs < interval.frameMs && interval.frameMs < cut.sourceToMs
    ))
  ));

  return candidates.sort((left, right) => right.frameMs - left.frameMs)[0] ?? null;
}

/** Удаляет только явно размеченное пустое ожидание и не трогает уже принятый кадр. */
function removeWaitBeforeAction(
  requiredMs: number,
  action: RecordingActionTiming,
  recording: RecordingFixtureTiming,
  cue: ShowcaseSyncCue,
  state: PlanningState,
): number {
  let leftMs = requiredMs;
  const used = new Set(state.cuts.map((cut) => cut.id));
  const candidates = recording.removableWaits
    .filter((wait) => (
      wait.beforeActionIndex === action.actionIndex
      && !used.has(wait.id)
      && wait.fromMs + EPSILON_MS >= state.protectedVideoSourceUntilMs
      && videoOutputAt(wait.fromMs, state) + EPSILON_MS >= state.protectedVideoUntilMs
    ))
    .sort((left, right) => right.toMs - left.toMs);

  for (const wait of candidates) {
    if (leftMs <= EPSILON_MS) {
      break;
    }

    const sourceToMs = frameAtOrBefore(wait.toMs, state.frameMs);
    const availableMs = Math.max(0, sourceToMs - wait.fromMs);
    // Частичный вырез на CFR-видео содержит только целые кадры. Неудалимый
    // остаток позже компенсируется PCM-тишиной на безопасной границе.
    const removedMs = Math.floor(
      Math.min(leftMs, availableMs) / state.frameMs + 1e-9,
    ) * state.frameMs;

    if (removedMs <= 0) {
      continue;
    }

    const sourceFromMs = sourceToMs - removedMs;

    state.cuts.push({
      id: wait.id,
      sourceFromMs,
      sourceToMs,
      cueId: cue.id,
    });
    state.diagnostics.push(diagnostic(
      'info',
      'empty_wait_removed',
      `Перед действием ${cue.actionIndex} удалено ${removedMs.toFixed(1)} мс пустого ожидания.`,
      {
        cueId: cue.id,
        actionIndex: cue.actionIndex,
        requiredMs,
        availableMs,
      },
    ));
    leftMs -= removedMs;
  }

  return Math.max(0, leftMs);
}

/**
 * Задерживает текущую и последующую речь целым числом PCM-отсчётов. До первого
 * cue расширяется безопасный pre-roll; позже нужна измеренная тихая граница.
 */
function insertSafeSilence(
  requiredMs: number,
  cue: ShowcaseSyncCue,
  speech: SpeechFixtureTiming,
  state: PlanningState,
): boolean {
  const count = samplesFor(requiredMs, speech.sampleRate);

  if (count === 0) {
    return true;
  }

  if (state.protectedTextTo === 0) {
    const preRoll = state.silences.find((silence) => silence.reason === 'pre-roll');

    if (!preRoll) {
      return false;
    }

    preRoll.sampleCount += count;
  } else {
    // Уже выбранную паузу можно расширить для общей реплики, только если это не
    // меняет ни один завершённый cue. Перекрывающий `ready-before` — безопасное
    // исключение: более позднее начало речи лишь усиливает его неравенство.
    const reusable = state.silences
      .filter((silence) => silence.reason === 'cue-delay' && silence.safePauseId !== null)
      .map((silence) => ({
        silence,
        pause: speech.safePauses.find((pause) => pause.id === silence.safePauseId),
      }))
      .filter((candidate): candidate is {
        silence: AudioSilenceEdit;
        pause: SafeSpeechPause;
      } => candidate.pause !== undefined)
      .filter(({ silence, pause }) => (
        pause.textAt <= cue.from
        && silence.textAt === pause.textAt
        && silence.sourceAtSample === sampleAt(pause.atMs, speech.sampleRate)
        && state.processedCues.every((processed) => (
          processed.to <= pause.textAt
          || (
            processed.kind === 'ready-before'
            && processed.from < cue.to
            && cue.from < processed.to
          )
        ))
      ))
      .sort((left, right) => right.pause.textAt - left.pause.textAt)[0];

    if (reusable) {
      reusable.silence.sampleCount += count;
    } else {
      const pause = [...speech.safePauses]
      .filter((candidate) => (
        candidate.textAt >= state.protectedTextTo
        && candidate.textAt <= cue.from
      ))
      .sort((left, right) => right.textAt - left.textAt || right.atMs - left.atMs)[0];

      if (!pause) {
        return false;
      }

      state.silences.push({
        sourceAtSample: sampleAt(pause.atMs, speech.sampleRate),
        sampleCount: count,
        reason: 'cue-delay',
        cueId: cue.id,
        safePauseId: pause.id,
        textAt: pause.textAt,
      });
    }
  }

  state.diagnostics.push(diagnostic(
    'info',
    'silence_inserted',
    `Перед привязкой «${cue.id}» добавлено ${samplesMs(count, speech.sampleRate).toFixed(1)} мс тишины.`,
    {
      cueId: cue.id,
      actionIndex: cue.actionIndex,
      requiredMs,
      availableMs: samplesMs(count, speech.sampleRate),
    },
  ));

  return true;
}

/** Выравнивает точное событие, не меняя скорость исходного движения. */
function alignEvent(
  cue: ShowcaseSyncCue,
  speechRange: ResolvedSpeechRange,
  action: RecordingActionTiming,
  speech: SpeechFixtureTiming,
  recording: RecordingFixtureTiming,
  state: PlanningState,
): SyncDiagnostic | null {
  let speechStartMs = audioOutputAt(speechRange.startMs, 'start', speech, state);
  let eventMs = videoOutputAt(action.anchorMs, state);

  if (eventMs + EPSILON_MS < speechStartMs) {
    const requiredMs = speechStartMs - eventMs;
    const durationMs = nearestFrameDuration(requiredMs, state.frameMs);

    // Разница меньше половины кадра остаётся измеримой ошибкой cue: добавлять
    // нулевой hold и требовать для него устойчивый кадр было бы ложным конфликтом.
    if (durationMs === 0) {
      return null;
    }

    const hold = stableBeforeAction(action, recording, state);

    if (!hold) {
      return diagnostic(
        'conflict',
        'no_stable_frame',
        `Перед привязкой «${cue.id}» нет устойчивого кадра для удержания.`,
        {
          cueId: cue.id,
          actionIndex: cue.actionIndex,
          requiredMs,
        },
      );
    }

    state.holds.push({
      sourceAtMs: hold.frameMs,
      durationMs,
      stableIntervalId: hold.id,
      cueId: cue.id,
    });
    state.diagnostics.push(diagnostic(
      'info',
      'video_hold_added',
      `Перед привязкой «${cue.id}» удержан устойчивый кадр ${durationMs.toFixed(1)} мс.`,
      {
        cueId: cue.id,
        actionIndex: cue.actionIndex,
        requiredMs,
        availableMs: durationMs,
      },
    ));
  } else if (eventMs > speechStartMs + EPSILON_MS) {
    let leftMs = removeWaitBeforeAction(
      eventMs - speechStartMs,
      action,
      recording,
      cue,
      state,
    );

    eventMs = videoOutputAt(action.anchorMs, state);
    speechStartMs = audioOutputAt(speechRange.startMs, 'start', speech, state);
    leftMs = Math.max(leftMs, eventMs - speechStartMs);

    if (leftMs > EPSILON_MS && !insertSafeSilence(leftMs, cue, speech, state)) {
      return diagnostic(
        'conflict',
        'no_safe_pause',
        `Позднее действие ${cue.actionIndex} нельзя совместить с речью без разреза слова.`,
        {
          cueId: cue.id,
          actionIndex: cue.actionIndex,
          requiredMs: leftMs,
        },
      );
    }
  }

  return null;
}

/** Выполняет ограничение «готово не позже начала фрагмента». */
function makeReadyBefore(
  cue: ShowcaseSyncCue,
  speechRange: ResolvedSpeechRange,
  eventSourceMs: number,
  action: RecordingActionTiming,
  speech: SpeechFixtureTiming,
  recording: RecordingFixtureTiming,
  state: PlanningState,
): SyncDiagnostic | null {
  let speechStartMs = audioOutputAt(speechRange.startMs, 'start', speech, state);
  // Для ограничения «готово до» важна поздняя граница измеренного события:
  // центр шкалы сам по себе не доказывает, что результат уже появился.
  let eventMs = videoOutputAt(eventSourceMs, state) + recording.calibrationErrorMs;

  if (eventMs <= speechStartMs + EPSILON_MS) {
    return null;
  }

  let leftMs = removeWaitBeforeAction(
    eventMs - speechStartMs,
    action,
    recording,
    cue,
    state,
  );

  eventMs = videoOutputAt(eventSourceMs, state) + recording.calibrationErrorMs;
  speechStartMs = audioOutputAt(speechRange.startMs, 'start', speech, state);
  leftMs = Math.max(leftMs, eventMs - speechStartMs);

  if (leftMs > EPSILON_MS && !insertSafeSilence(leftMs, cue, speech, state)) {
    return diagnostic(
      'conflict',
      'no_safe_pause',
      `Результат действия ${cue.actionIndex} появляется после связанной реплики.`,
      {
        cueId: cue.id,
        actionIndex: cue.actionIndex,
        requiredMs: leftMs,
      },
    );
  }

  return null;
}

/** Продлевает состояние подсветки устойчивым кадром до конца выбранной речи. */
function holdHighlightThrough(
  cue: ShowcaseSyncCue,
  speechRange: ResolvedSpeechRange,
  action: RecordingActionTiming,
  geometry: HighlightGeometry,
  speech: SpeechFixtureTiming,
  recording: RecordingFixtureTiming,
  state: PlanningState,
): SyncDiagnostic | null {
  const stateReadySourceMs = Math.max(action.readyMs ?? action.endMs, geometry.validFromMs);
  const readyProblem = makeReadyBefore(
    cue,
    speechRange,
    stateReadySourceMs,
    action,
    speech,
    recording,
    state,
  );

  if (readyProblem) {
    return readyProblem;
  }

  const speechEndMs = audioOutputAt(speechRange.endMs, 'end', speech, state);
  // Геометрия гарантирована только внутри суженного на погрешность интервала.
  const validToMs = videoOutputAt(geometry.validToMs, state, 'end')
    - recording.calibrationErrorMs;

  if (validToMs + EPSILON_MS < speechEndMs) {
    const interval = recording.stableIntervals.find(
      (candidate) => candidate.id === geometry.stableIntervalId,
    );

    if (
      !interval
      || interval.frameMs + EPSILON_MS < state.protectedVideoSourceUntilMs
      || interval.frameMs + EPSILON_MS < stateReadySourceMs
    ) {
      return diagnostic(
        'conflict',
        'no_stable_frame',
        `Подсветку «${cue.id}» нельзя удержать на подтверждённом кадре.`,
        {
          cueId: cue.id,
          actionIndex: cue.actionIndex,
          requiredMs: speechEndMs - validToMs,
        },
      );
    }

    const requiredMs = speechEndMs - validToMs;
    const durationMs = frameDurationAtLeast(requiredMs, state.frameMs);

    state.holds.push({
      sourceAtMs: interval.frameMs,
      durationMs,
      stableIntervalId: interval.id,
      cueId: cue.id,
    });
    state.diagnostics.push(diagnostic(
      'info',
      'video_hold_added',
      `Подсветка «${cue.id}» удержана ещё ${durationMs.toFixed(1)} мс.`,
      {
        cueId: cue.id,
        actionIndex: cue.actionIndex,
        requiredMs,
        availableMs: durationMs,
      },
    ));
  }

  return null;
}

/** Проверяет, что будущая вставка не превысила предел сцены или остаток ролика. */
function durationProblem(
  input: SyncPlanInput,
  speech: SpeechFixtureTiming,
  recording: RecordingFixtureTiming,
  state: PlanningState,
  postRollMs: number,
): SyncDiagnostic | null {
  const videoMs = videoOutputAt(recording.durationMs, state, 'end');
  const audioMs = audioOutputAt(speech.durationMs, 'end', speech, state);
  const requiredMs = Math.max(videoMs, audioMs) + postRollMs;

  if (requiredMs > input.limits.maxSceneMs + EPSILON_MS) {
    return diagnostic(
      'conflict',
      'scene_limit_exceeded',
      'Точный монтаж превышает предел длительности сцены.',
      { requiredMs, availableMs: input.limits.maxSceneMs },
    );
  }

  if (requiredMs > input.limits.remainingFilmMs + EPSILON_MS) {
    return diagnostic(
      'conflict',
      'film_limit_exceeded',
      'Точный монтаж превышает оставшуюся длительность ролика.',
      { requiredMs, availableMs: input.limits.remainingFilmMs },
    );
  }

  return null;
}

/** Строит монотонную последовательность исходных участков и подтверждённых стоп-кадров. */
function buildVideoParts(
  durationMs: number,
  state: PlanningState,
): SyncVideoPart[] | null {
  const operations = [
    ...state.cuts.map((cut) => ({
      kind: 'cut' as const,
      atMs: cut.sourceFromMs,
      endMs: cut.sourceToMs,
      value: cut,
    })),
    ...state.holds.map((hold) => ({
      kind: 'hold' as const,
      atMs: hold.sourceAtMs,
      endMs: hold.sourceAtMs,
      value: hold,
    })),
  ].sort((left, right) => left.atMs - right.atMs || (
    left.kind === 'cut' ? -1 : 1
  ));
  const parts: SyncVideoPart[] = [];
  let sourceCursor = 0;
  let outputCursor = 0;

  for (const operation of operations) {
    if (operation.atMs + EPSILON_MS < sourceCursor || operation.atMs > durationMs + EPSILON_MS) {
      return null;
    }

    if (operation.atMs > sourceCursor + EPSILON_MS) {
      const lengthMs = operation.atMs - sourceCursor;

      parts.push({
        kind: 'source',
        sourceFromMs: sourceCursor,
        sourceToMs: operation.atMs,
        outputFromMs: outputCursor,
        outputToMs: outputCursor + lengthMs,
      });
      outputCursor += lengthMs;
      sourceCursor = operation.atMs;
    }

    if (operation.kind === 'cut') {
      sourceCursor = operation.endMs;
    } else {
      parts.push({
        kind: 'hold',
        sourceAtMs: operation.value.sourceAtMs,
        outputFromMs: outputCursor,
        outputToMs: outputCursor + operation.value.durationMs,
        stableIntervalId: operation.value.stableIntervalId,
        cueId: operation.value.cueId,
      });
      outputCursor += operation.value.durationMs;
    }
  }

  if (sourceCursor < durationMs - EPSILON_MS) {
    parts.push({
      kind: 'source',
      sourceFromMs: sourceCursor,
      sourceToMs: durationMs,
      outputFromMs: outputCursor,
      outputToMs: outputCursor + durationMs - sourceCursor,
    });
  }

  return parts;
}

/** Аудиочасти режутся только по целым отсчётам; речь между границами не меняется. */
function buildAudioParts(
  speech: SpeechFixtureTiming,
  state: PlanningState,
): SyncAudioPart[] | null {
  const edits = state.silences
    .filter((edit) => edit.sampleCount > 0)
    .sort((left, right) => left.sourceAtSample - right.sourceAtSample);
  const parts: SyncAudioPart[] = [];
  let sourceCursor = 0;
  let outputCursor = 0;

  for (const edit of edits) {
    if (edit.sourceAtSample < sourceCursor || edit.sourceAtSample > speech.sampleCount) {
      return null;
    }

    if (edit.sourceAtSample > sourceCursor) {
      const count = edit.sourceAtSample - sourceCursor;
      const durationMs = samplesMs(count, speech.sampleRate);

      parts.push({
        kind: 'source',
        sourceFromSample: sourceCursor,
        sourceToSample: edit.sourceAtSample,
        outputFromMs: outputCursor,
        outputToMs: outputCursor + durationMs,
      });
      outputCursor += durationMs;
      sourceCursor = edit.sourceAtSample;
    }

    const silenceMs = samplesMs(edit.sampleCount, speech.sampleRate);

    parts.push({
      kind: 'silence',
      sampleCount: edit.sampleCount,
      sampleRate: speech.sampleRate,
      outputFromMs: outputCursor,
      outputToMs: outputCursor + silenceMs,
      reason: edit.reason,
      cueId: edit.cueId,
    });
    outputCursor += silenceMs;
  }

  if (sourceCursor < speech.sampleCount) {
    const count = speech.sampleCount - sourceCursor;

    parts.push({
      kind: 'source',
      sourceFromSample: sourceCursor,
      sourceToSample: speech.sampleCount,
      outputFromMs: outputCursor,
      outputToMs: outputCursor + samplesMs(count, speech.sampleRate),
    });
  }

  return parts;
}

function eventSourceMs(
  cue: ShowcaseSyncCue,
  action: RecordingActionTiming,
  geometry: HighlightGeometry | null,
): number | null {
  if (cue.kind === 'align-start') {
    return action.anchorMs;
  }

  if (cue.kind === 'ready-before') {
    return action.readyMs;
  }

  return geometry ? Math.max(action.readyMs ?? action.endMs, geometry.validFromMs) : null;
}

/** Финальная проверка ограничений выполняется после всех последующих вставок. */
function outputCueTimings(
  cues: readonly ShowcaseSyncCue[],
  ranges: ReadonlyMap<string, ResolvedSpeechRange>,
  speech: SpeechFixtureTiming,
  recording: RecordingFixtureTiming,
  state: PlanningState,
  maxCueErrorMs: number,
): { cues: SyncCueTiming[]; highlights: SyncHighlightTiming[]; problem: SyncDiagnostic | null } {
  const output: SyncCueTiming[] = [];
  const highlights: SyncHighlightTiming[] = [];

  for (const cue of cues) {
    const range = ranges.get(cue.id);
    const action = recording.actions[cue.actionIndex];
    const geometry = recording.highlights.find((item) => item.actionIndex === cue.actionIndex) ?? null;

    if (!range || !action) {
      return {
        cues: output,
        highlights,
        problem: diagnostic(
          'conflict',
          'missing_action_event',
          `Для привязки «${cue.id}» потеряно измеренное событие.`,
          { cueId: cue.id, actionIndex: cue.actionIndex },
        ),
      };
    }

    const sourceEventMs = eventSourceMs(cue, action, geometry);

    if (sourceEventMs === null) {
      return {
        cues: output,
        highlights,
        problem: diagnostic(
          'conflict',
          cue.kind === 'hold-through' ? 'missing_highlight_geometry' : 'missing_action_event',
          `Для привязки «${cue.id}» нет нужного события или геометрии.`,
          { cueId: cue.id, actionIndex: cue.actionIndex },
        ),
      };
    }

    const speechStartMs = audioOutputAt(range.startMs, 'start', speech, state);
    const speechEndMs = audioOutputAt(range.endMs, 'end', speech, state);
    const eventMs = videoOutputAt(sourceEventMs, state);
    let errorMs = 0;

    if (cue.kind === 'align-start') {
      // Центр события не двигаем произвольной поправкой, но его неопределённость
      // входит в проверяемое отклонение готового cue.
      errorMs = Math.abs(eventMs - speechStartMs) + recording.calibrationErrorMs;
    } else if (cue.kind === 'ready-before') {
      errorMs = Math.max(
        0,
        eventMs + recording.calibrationErrorMs - speechStartMs,
      );
    } else if (geometry) {
      const validFromMs = videoOutputAt(geometry.validFromMs, state)
        + recording.calibrationErrorMs;
      const validToMs = videoOutputAt(geometry.validToMs, state, 'end')
        - recording.calibrationErrorMs;

      errorMs = Math.max(0, validFromMs - speechStartMs, speechEndMs - validToMs);
      highlights.push({
        cueId: cue.id,
        actionIndex: cue.actionIndex,
        startMs: speechStartMs,
        endMs: speechEndMs,
        x: geometry.x,
        y: geometry.y,
        width: geometry.width,
        height: geometry.height,
      });
    }

    if (errorMs > maxCueErrorMs + EPSILON_MS) {
      return {
        cues: output,
        highlights,
        problem: diagnostic(
          'conflict',
          'cue_tolerance_exceeded',
          `Привязка «${cue.id}» расходится с измеренным событием на ${errorMs.toFixed(1)} мс.`,
          {
            cueId: cue.id,
            actionIndex: cue.actionIndex,
            requiredMs: errorMs,
            availableMs: maxCueErrorMs,
          },
        ),
      };
    }

    output.push({
      cueId: cue.id,
      kind: cue.kind,
      actionIndex: cue.actionIndex,
      textFrom: cue.from,
      textTo: cue.to,
      speechStartMs,
      speechEndMs,
      eventMs,
      errorMs,
    });
  }

  return { cues: output, highlights, problem: null };
}

/**
 * Строит точный либо явно запасной план. Функция детерминирована всеми входами:
 * случайных идентификаторов, часов процесса и чтения файлов внутри нет.
 */
export function planShowcaseSync(input: SyncPlanInput): SyncPlanResult {
  const options = optionsOf(input);

  if (!options) {
    return conflict('invalid_options', 'Настройки, стиль или лимиты sync-плана некорректны.');
  }

  if (!input.bindingInput) {
    return legacy(
      input,
      'missing_bindings',
      'У сцены нет смысловых привязок: используется прежний приблизительный монтаж.',
    );
  }

  const bindingValidation = validateShowcaseSyncBindings(input.bindingInput);

  if (bindingValidation.status !== 'valid') {
    const stale = bindingValidation.status === 'stale';

    return {
      status: 'conflict',
      diagnostics: bindingValidation.issues.map((issue) => diagnostic(
        'conflict',
        stale ? 'stale_bindings' : 'invalid_bindings',
        issue.message,
        { cueId: issue.cueId },
      )),
    };
  }

  if (!input.speech) {
    return legacy(
      input,
      'missing_speech_timing',
      'У звука нет точных меток: используется прежний приблизительный монтаж.',
    );
  }

  const speechProblem = validateSpeechTiming(input.speech);

  if (speechProblem) {
    return conflict('invalid_speech_timing', speechProblem);
  }

  if (!input.recording) {
    return legacy(
      input,
      'missing_recording_timing',
      'У клипа нет журнала событий: используется прежний приблизительный монтаж.',
    );
  }

  const recordingProblem = validateRecordingTiming(input.recording, input);

  if (recordingProblem) {
    return conflict('invalid_recording_timing', recordingProblem);
  }

  if (input.speech.canonicalText !== input.bindingInput.canonicalText) {
    return conflict(
      'invalid_speech_timing',
      'Метки речи относятся к другой канонической строке сцены.',
    );
  }

  if (input.speech.quality !== 'word-exact') {
    return legacy(
      input,
      'approximate_speech_timing',
      'Доступны только фразовые или приблизительные метки речи.',
    );
  }

  if (
    input.recording.calibration === 'unavailable'
    || input.recording.calibrationErrorMs > options.maxRecordingErrorMs
  ) {
    return legacy(
      input,
      'uncalibrated_recording',
      'Шкала событий записи не откалибрована для точного монтажа.',
    );
  }

  const orderedCues = [...input.bindingInput.bindings.cues]
    .sort((left, right) => left.actionIndex - right.actionIndex);
  const ranges = new Map<string, ResolvedSpeechRange>();

  for (const cue of orderedCues) {
    const range = resolveSpeechRange(input.speech, cue);

    if (!range) {
      return conflict(
        'unmapped_text_range',
        `Диапазон привязки «${cue.id}» не покрыт однозначными словесными метками.`,
        { cueId: cue.id, actionIndex: cue.actionIndex },
      );
    }

    ranges.set(cue.id, range);
  }

  const state: PlanningState = {
    holds: [],
    cuts: [],
    silences: [{
      sourceAtSample: 0,
      sampleCount: samplesFor(options.preRollMs, input.speech.sampleRate),
      reason: 'pre-roll',
      cueId: null,
      safePauseId: null,
      textAt: 0,
    }],
    diagnostics: [],
    protectedVideoUntilMs: 0,
    protectedVideoSourceUntilMs: 0,
    protectedTextTo: 0,
    processedCues: [],
    frameMs: 1000 / input.style.fps,
  };

  for (const cue of orderedCues) {
    const action = input.recording.actions[cue.actionIndex];
    const range = ranges.get(cue.id);

    if (!action || !range) {
      return conflict(
        'missing_action_event',
        `Для привязки «${cue.id}» нет измеренного события действия.`,
        { cueId: cue.id, actionIndex: cue.actionIndex },
      );
    }

    let problem: SyncDiagnostic | null = null;

    if (cue.kind === 'align-start') {
      problem = alignEvent(cue, range, action, input.speech, input.recording, state);
    } else if (cue.kind === 'ready-before') {
      if (action.readyMs === null) {
        problem = diagnostic(
          'conflict',
          'missing_action_event',
          `Для действия ${cue.actionIndex} не измерена готовность результата.`,
          { cueId: cue.id, actionIndex: cue.actionIndex },
        );
      } else {
        problem = makeReadyBefore(
          cue,
          range,
          action.readyMs,
          action,
          input.speech,
          input.recording,
          state,
        );
      }
    } else {
      const geometry = input.recording.highlights.find(
        (item) => item.actionIndex === cue.actionIndex,
      );

      if (!geometry) {
        problem = diagnostic(
          'conflict',
          'missing_highlight_geometry',
          `Для привязки «${cue.id}» нет измеренной геометрии подсветки.`,
          { cueId: cue.id, actionIndex: cue.actionIndex },
        );
      } else {
        problem = holdHighlightThrough(
          cue,
          range,
          action,
          geometry,
          input.speech,
          input.recording,
          state,
        );
      }
    }

    if (problem) {
      return { status: 'conflict', diagnostics: [...state.diagnostics, problem] };
    }

    const speechEndMs = audioOutputAt(range.endMs, 'end', input.speech, state);
    const sourceEvent = eventSourceMs(
      cue,
      action,
      input.recording.highlights.find((item) => item.actionIndex === cue.actionIndex) ?? null,
    );

    state.protectedVideoUntilMs = Math.max(
      state.protectedVideoUntilMs,
      cue.kind === 'hold-through'
        ? speechEndMs
        : videoOutputAt(sourceEvent ?? action.anchorMs, state)
          + (cue.kind === 'ready-before' ? input.recording.calibrationErrorMs : 0),
    );
    state.protectedVideoSourceUntilMs = Math.max(
      state.protectedVideoSourceUntilMs,
      sourceEvent ?? action.anchorMs,
    );
    state.protectedTextTo = Math.max(state.protectedTextTo, cue.to);
    state.processedCues.push({
      id: cue.id,
      kind: cue.kind,
      from: cue.from,
      to: cue.to,
    });

    const limitProblem = durationProblem(
      input,
      input.speech,
      input.recording,
      state,
      options.postRollMs,
    );

    if (limitProblem) {
      return { status: 'conflict', diagnostics: [...state.diagnostics, limitProblem] };
    }
  }

  const contentVideoMs = videoOutputAt(input.recording.durationMs, state, 'end');
  const contentAudioSamples = input.speech.sampleCount + state.silences
    .reduce((total, silence) => total + silence.sampleCount, 0);
  const contentAudioMs = samplesMs(contentAudioSamples, input.speech.sampleRate);
  const contentVideoFrames = Math.round(contentVideoMs / state.frameMs);

  if (Math.abs(contentVideoMs - contentVideoFrames * state.frameMs) > 0.01) {
    return conflict(
      'invalid_recording_timing',
      'Карта видео после монтажа не лежит на кадровой сетке.',
    );
  }

  // Конец одновременно представим целым числом кадров и PCM-отсчётов. Для
  // 48 кГц / 30 fps это обычная граница каждого кадра (1600 отсчётов).
  const target = commonMediaBoundaryAtLeast(
    Math.max(contentVideoMs, contentAudioMs) + options.postRollMs,
    input.speech.sampleRate,
    input.style.fps,
  );

  if (!target || target.frames < contentVideoFrames || target.samples < contentAudioSamples) {
    return conflict('invalid_options', 'Общая кадровая и PCM-граница сцены недостижима.');
  }

  const targetSamples = target.samples;
  const targetMs = target.ms;
  const frameMs = state.frameMs;
  const lastActionEnd = input.recording.actions.at(-1)?.endMs ?? 0;
  const terminal = [...input.recording.stableIntervals]
    .filter((interval) => (
      interval.toMs >= input.recording!.durationMs - frameMs - EPSILON_MS
      && (
        input.recording!.actions.length === 0
        || interval.frameMs + EPSILON_MS >= Math.max(
          lastActionEnd,
          state.protectedVideoSourceUntilMs,
        )
      )
    ))
    .sort((left, right) => right.frameMs - left.frameMs)[0];

  const terminalHoldMs = frameDurationAtLeast(targetMs - contentVideoMs, frameMs);

  if (terminalHoldMs > 0) {
    if (!terminal) {
      return {
        status: 'conflict',
        diagnostics: [
          ...state.diagnostics,
          diagnostic(
            'conflict',
            'no_stable_frame',
            'В конце записи нет подтверждённого устойчивого кадра для хвоста сцены.',
            { requiredMs: targetMs - contentVideoMs },
          ),
        ],
      };
    }

    state.holds.push({
      sourceAtMs: terminal.frameMs,
      durationMs: terminalHoldMs,
      stableIntervalId: terminal.id,
      cueId: null,
    });
  }

  const tailSamples = targetSamples - contentAudioSamples;

  if (tailSamples > 0) {
    state.silences.push({
      sourceAtSample: input.speech.sampleCount,
      sampleCount: tailSamples,
      reason: 'tail',
      cueId: null,
      safePauseId: null,
      textAt: null,
    });
  }

  const videoParts = buildVideoParts(input.recording.durationMs, state);
  const audioParts = buildAudioParts(input.speech, state);

  if (!videoParts) {
    return conflict('reverse_video_order', 'Операции монтажа требуют переставить состояния записи.');
  }

  if (!audioParts) {
    return conflict('invalid_speech_timing', 'Вставки тишины нарушают порядок PCM-отсчётов.');
  }

  const output = outputCueTimings(
    orderedCues,
    ranges,
    input.speech,
    input.recording,
    state,
    options.maxCueErrorMs,
  );

  if (output.problem) {
    return { status: 'conflict', diagnostics: [...state.diagnostics, output.problem] };
  }

  const phrases = input.speech.phrases.map((phrase) => ({
    id: phrase.id,
    from: phrase.from,
    to: phrase.to,
    startMs: audioOutputAt(phrase.startMs, 'start', input.speech!, state),
    endMs: audioOutputAt(phrase.endMs, 'end', input.speech!, state),
  }));
  const narrationStartMs = audioOutputAt(0, 'start', input.speech, state);
  // Концы содержимого берутся из реально исполняемых дорожек: PCM-счётчик
  // авторитетнее округлённого `durationMs`, а конец действий — конец клипа,
  // как и в legacy `ShowcaseTiming`, до добавленного финального удержания.
  const speechEndMs = contentAudioMs;
  const actionsEndMs = contentVideoMs;
  const videoTotalMs = videoParts.at(-1)?.outputToMs ?? 0;
  const audioTotalMs = audioParts.at(-1)?.outputToMs ?? 0;

  if (
    Math.abs(videoTotalMs - targetMs) > EPSILON_MS
    || Math.abs(audioTotalMs - targetMs) > EPSILON_MS
  ) {
    return conflict(
      'invalid_options',
      'Внутренняя карта монтажа не сошлась на общей PCM-границе.',
      { requiredMs: targetMs, availableMs: Math.min(videoTotalMs, audioTotalMs) },
    );
  }

  const finalTotalMs = targetMs;
  const timing: ExactSyncTiming = {
    preRollMs: narrationStartMs,
    narrationStartMs,
    speechEndMs,
    actionsEndMs,
    postRollMs: finalTotalMs - Math.max(speechEndMs, actionsEndMs),
    totalMs: finalTotalMs,
  };

  const finalLimitProblem = finalTotalMs > input.limits.maxSceneMs + EPSILON_MS
    ? diagnostic(
      'conflict',
      'scene_limit_exceeded',
      'Округление PCM вывело точный монтаж за предел сцены.',
      { requiredMs: finalTotalMs, availableMs: input.limits.maxSceneMs },
    )
    : finalTotalMs > input.limits.remainingFilmMs + EPSILON_MS
      ? diagnostic(
        'conflict',
        'film_limit_exceeded',
        'Округление PCM вывело точный монтаж за остаток ролика.',
        { requiredMs: finalTotalMs, availableMs: input.limits.remainingFilmMs },
      )
      : null;

  if (finalLimitProblem) {
    return { status: 'conflict', diagnostics: [...state.diagnostics, finalLimitProblem] };
  }

  return {
    status: 'exact',
    plan: {
      version: 1,
      mode: 'exact',
      timing,
      sourceAudio: {
        sampleRate: input.speech.sampleRate,
        sampleCount: input.speech.sampleCount,
        durationMs: samplesMs(input.speech.sampleCount, input.speech.sampleRate),
      },
      sourceVideo: {
        durationMs: input.recording.durationMs,
        fps: input.style.fps,
      },
      videoParts,
      audioParts,
      removedWaits: state.cuts.map((cut) => ({
        id: cut.id,
        sourceFromMs: cut.sourceFromMs,
        sourceToMs: cut.sourceToMs,
        removedMs: cut.sourceToMs - cut.sourceFromMs,
        cueId: cut.cueId,
      })),
      highlights: output.highlights,
      cues: output.cues,
      phrases,
    },
    diagnostics: state.diagnostics,
  };
}

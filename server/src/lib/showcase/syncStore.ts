// Производные измерения синхронизации рядом с медиа сцены.
//
// JSON становится доступен проекту только после атомарной записи и получает
// собственный хеш содержимого. Ссылка связывает сразу редакцию сцены и конкретный
// WAV: метки от прежней озвучки нельзя незаметно приложить к новому звуку с тем
// же текстом.
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { contractDecoders } from '../../../../shared/contractDecoders.ts';
import type {
  ShowcaseDerivedArtifactRef,
} from '../../../../shared/showcaseContracts.ts';
import {
  parseShowcaseFinalManifest,
  SHOWCASE_MANIFEST_ID_RE,
} from '../../../../shared/showcaseTimeline.ts';
import type { ShowcaseFinalManifest } from '../../../../shared/showcaseTimeline.ts';
import type {
  VoiceSpeechSpanTiming,
  VoiceSpeechTiming,
} from './voice/contract.ts';
import type { SpeechTranscript } from '../speech/transport.ts';
import type { SpeechAlignment } from './voice/alignment.ts';
import { syncTextHash } from './scenes.ts';

export const SPEECH_TIMING_VERSION = 1;
export const SPEECH_TIMING_PRODUCER_VERSION = 'speech-timing-2';
export const SPEECH_ALIGNMENT_VERSION = 1;
export const SPEECH_ALIGNMENT_PRODUCER_VERSION = 'speech-alignment-1';

// ffprobe округляет длительность WAV до целой миллисекунды. Исправляется только
// такой хвост; более заметное расхождение означает чужую временную шкалу.
export const SPEECH_TIMING_END_TOLERANCE_MS = 1;

const SPEECH_TIMING_ID = /^speech-timing-[a-f0-9]{12}$/;
const SPEECH_ALIGNMENT_ID = /^speech-alignment-[a-f0-9]{12}$/;
const DERIVED_HASH = /^[a-f0-9]{32}$/;
const MANIFEST_MAX_BYTES = 1024 * 1024;
const NATIVE_VALID_REASON = 'Нативные метки поставщика проверены по длительности WAV.';
const ASR_WORD_VALID_REASON = 'Словесные метки общего распознавателя проверены по длительности WAV.';
const ASR_PHRASE_VALID_REASON = 'Распознаватель дал только проверенные границы фраз.';

export type SpeechTimingSource = VoiceSpeechTiming['source'] | 'whisper';

export interface PublishableSpeechTiming {
  source: SpeechTimingSource;
  readonly words: readonly VoiceSpeechSpanTiming[];
  readonly segments: readonly VoiceSpeechSpanTiming[];
}

export interface SpeechTimingDocument {
  version: 1;
  audioContentHash: string;
  source: SpeechTimingSource;
  // Версия голоса/модели объясняет, откуда получились границы; версия извлечения
  // отдельно старит сам способ разбора provider metadata.
  producerVersion: string;
  extractionVersion: string;
  durationMs: number;
  words: VoiceSpeechSpanTiming[];
  segments: VoiceSpeechSpanTiming[];
  quality: 'word-exact' | 'phrase';
  status: 'valid';
  reason: string;
}

export interface PublishSpeechTimingInput {
  timing: PublishableSpeechTiming | null | undefined;
  sceneInputHash: string;
  audioContentHash: string;
  producerVersion: string;
  durationMs: number;
  targetDir: string;
}

export interface ReadSpeechTimingInput {
  ref: ShowcaseDerivedArtifactRef;
  sceneInputHash: string;
  audioContentHash: string;
  targetDir: string;
}

export interface SpeechAlignmentDocument {
  version: 1;
  textHash: string;
  audioContentHash: string;
  speechTimingContentHash: string;
  producerVersion: string;
  durationMs: number;
  quality: SpeechAlignment['quality'];
  spans: SpeechAlignment['spans'];
  phrases: SpeechAlignment['phrases'];
  safePauses: SpeechAlignment['safePauses'];
  reason: string;
}

export interface PublishSpeechAlignmentInput {
  alignment: SpeechAlignment;
  canonicalText: string;
  textHash: string;
  audioContentHash: string;
  speechTimingContentHash: string;
  targetDir: string;
}

export interface ReadSpeechAlignmentInput {
  ref: ShowcaseDerivedArtifactRef;
  canonicalText: string;
  textHash: string;
  audioContentHash: string;
  speechTimingContentHash: string;
  targetDir: string;
}

export interface PublishFinalManifestInput {
  manifest: ShowcaseFinalManifest;
  targetDir: string;
}

export interface PublishedFinalManifest {
  id: string;
  contentHash: string;
  byteSize: number;
}

export interface ReadFinalManifestInput {
  manifestId: string;
  targetDir: string;
  projectId?: string;
}

class SpeechTimingContractError extends Error {}

const {
  listOf,
  numeric,
  objectOf,
  oneOf,
  text,
  wholeNumber,
} = contractDecoders((field) => {
  throw new SpeechTimingContractError(field);
});

const speechSpan = objectOf({
  text,
  startMs: numeric,
  endMs: numeric,
});

const speechTimingDocument = objectOf({
  version: oneOf(SPEECH_TIMING_VERSION),
  audioContentHash: text,
  source: oneOf('edge', 'yandex', 'whisper'),
  producerVersion: text,
  extractionVersion: text,
  durationMs: numeric,
  words: listOf(speechSpan),
  segments: listOf(speechSpan),
  quality: oneOf('word-exact', 'phrase'),
  status: oneOf('valid'),
  reason: text,
});

const alignedSpan = objectOf({
  from: wholeNumber,
  to: wholeNumber,
  startMs: numeric,
  endMs: numeric,
  precision: oneOf('word', 'phrase'),
});

const alignedPhrase = objectOf({
  id: text,
  from: wholeNumber,
  to: wholeNumber,
  startMs: numeric,
  endMs: numeric,
});

const alignedPause = objectOf({
  id: text,
  textAt: wholeNumber,
  atMs: numeric,
  quietFromMs: numeric,
  quietToMs: numeric,
});

const speechAlignmentDocument = objectOf({
  version: oneOf(SPEECH_ALIGNMENT_VERSION),
  textHash: text,
  audioContentHash: text,
  speechTimingContentHash: text,
  producerVersion: text,
  durationMs: numeric,
  quality: oneOf('word-exact', 'phrase', 'approximate'),
  spans: listOf(alignedSpan),
  phrases: listOf(alignedPhrase),
  safePauses: listOf(alignedPause),
  reason: text,
});

function contentHashOf(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

/** Хеш входов меток включает и редакцию сцены, и байты опубликованного WAV. */
export function speechTimingInputHash(
  sceneInputHash: string,
  audioContentHash: string,
): string {
  return contentHashOf(JSON.stringify({
    version: SPEECH_TIMING_VERSION,
    kind: 'speech-timing',
    sceneInputHash,
    audioContentHash,
  }));
}

/** Alignment старится независимо по тексту, WAV и raw provider/ASR timing. */
export function speechAlignmentInputHash(
  textHash: string,
  audioContentHash: string,
  speechTimingContentHash: string,
): string {
  return contentHashOf(JSON.stringify({
    version: SPEECH_ALIGNMENT_VERSION,
    kind: 'speech-alignment',
    textHash,
    audioContentHash,
    speechTimingContentHash,
  }));
}

/** Отпечаток канонического текста для меток загруженной человеком дорожки. */
export function recordedSpeechTextInputHash(canonicalText: string): string {
  return contentHashOf(JSON.stringify({
    version: SPEECH_TIMING_VERSION,
    kind: 'recorded-speech-text',
    canonicalText,
  }));
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizedSpans(
  value: unknown,
  durationMs: number,
): VoiceSpeechSpanTiming[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const result: VoiceSpeechSpanTiming[] = [];
  let previousEndMs = 0;

  for (const raw of value) {
    const span = recordOf(raw);
    const spanText = span?.text;
    const startMs = span?.startMs;
    const sourceEndMs = span?.endMs;

    if (
      !span
      || typeof spanText !== 'string'
      || spanText.trim().length === 0
      || typeof startMs !== 'number'
      || !Number.isFinite(startMs)
      || typeof sourceEndMs !== 'number'
      || !Number.isFinite(sourceEndMs)
      || startMs < 0
      || startMs < previousEndMs
      || sourceEndMs <= startMs
      || sourceEndMs > durationMs + SPEECH_TIMING_END_TOLERANCE_MS
    ) {
      return null;
    }

    const endMs = Math.min(sourceEndMs, durationMs);

    if (endMs <= startMs) {
      return null;
    }

    result.push({ text: spanText, startMs, endMs });
    previousEndMs = endMs;
  }

  return result;
}

function documentOf(input: PublishSpeechTimingInput): SpeechTimingDocument | null {
  const timing = recordOf(input.timing);

  if (
    !timing
    || (timing.source !== 'edge' && timing.source !== 'yandex' && timing.source !== 'whisper')
    || !Number.isFinite(input.durationMs)
    || input.durationMs < 0
    || input.sceneInputHash.length === 0
    || input.audioContentHash.length === 0
    || input.producerVersion.trim().length === 0
  ) {
    return null;
  }

  const words = normalizedSpans(timing.words, input.durationMs);
  const segments = normalizedSpans(timing.segments, input.durationMs);

  if (!words || !segments || segments.length === 0) {
    return null;
  }

  // Нативные metadata без слов не публикуются: сначала должен сработать общий
  // ASR. Whisper без слов всё ещё даёт честный фразовый fallback.
  if (timing.source !== 'whisper' && words.length === 0) {
    return null;
  }

  const quality = words.length > 0 ? 'word-exact' : 'phrase';
  const reason = timing.source === 'whisper'
    ? (quality === 'word-exact' ? ASR_WORD_VALID_REASON : ASR_PHRASE_VALID_REASON)
    : NATIVE_VALID_REASON;

  return {
    version: SPEECH_TIMING_VERSION,
    audioContentHash: input.audioContentHash,
    source: timing.source,
    producerVersion: input.producerVersion,
    extractionVersion: SPEECH_TIMING_PRODUCER_VERSION,
    durationMs: input.durationMs,
    words,
    segments,
    quality,
    status: 'valid',
    reason,
  };
}

function splitsUtf16Character(textValue: string, at: number): boolean {
  if (at <= 0 || at >= textValue.length) {
    return false;
  }

  const before = textValue.charCodeAt(at - 1);
  const after = textValue.charCodeAt(at);

  return before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF;
}

function alignmentDocumentOf(
  input: PublishSpeechAlignmentInput,
): SpeechAlignmentDocument | null {
  const { alignment, canonicalText } = input;

  if (
    !alignment
    || alignment.canonicalText !== canonicalText
    || !DERIVED_HASH.test(input.textHash)
    || input.textHash !== syncTextHash(canonicalText)
    || !DERIVED_HASH.test(input.audioContentHash)
    || !DERIVED_HASH.test(input.speechTimingContentHash)
    || !Number.isFinite(alignment.durationMs)
    || alignment.durationMs <= 0
    || alignment.reason.trim() === ''
    || !Array.isArray(alignment.spans)
    || !Array.isArray(alignment.phrases)
    || !Array.isArray(alignment.safePauses)
  ) {
    return null;
  }

  const spans: SpeechAlignment['spans'] = [];
  let previousSpanTo = 0;
  let previousSpanEndMs = 0;

  for (const span of alignment.spans) {
    if (
      !Number.isSafeInteger(span.from)
      || !Number.isSafeInteger(span.to)
      || span.from < previousSpanTo
      || span.from < 0
      || span.to <= span.from
      || span.to > canonicalText.length
      || splitsUtf16Character(canonicalText, span.from)
      || splitsUtf16Character(canonicalText, span.to)
      || !Number.isFinite(span.startMs)
      || !Number.isFinite(span.endMs)
      || span.startMs < previousSpanEndMs
      || span.startMs < 0
      || span.endMs <= span.startMs
      || span.endMs > alignment.durationMs
      || (span.precision !== 'word' && span.precision !== 'phrase')
    ) {
      return null;
    }

    spans.push({ ...span });
    previousSpanTo = span.to;
    previousSpanEndMs = span.endMs;
  }

  const phrases: SpeechAlignment['phrases'] = [];
  const phraseIds = new Set<string>();
  let previousPhraseTo = 0;
  let previousPhraseEndMs = 0;

  for (const phrase of alignment.phrases) {
    if (
      phrase.id.trim() === ''
      || phraseIds.has(phrase.id)
      || !Number.isSafeInteger(phrase.from)
      || !Number.isSafeInteger(phrase.to)
      || phrase.from < previousPhraseTo
      || phrase.from < 0
      || phrase.to <= phrase.from
      || phrase.to > canonicalText.length
      || splitsUtf16Character(canonicalText, phrase.from)
      || splitsUtf16Character(canonicalText, phrase.to)
      || !Number.isFinite(phrase.startMs)
      || !Number.isFinite(phrase.endMs)
      || phrase.startMs < previousPhraseEndMs
      || phrase.startMs < 0
      || phrase.endMs <= phrase.startMs
      || phrase.endMs > alignment.durationMs
    ) {
      return null;
    }

    phrases.push({ ...phrase });
    phraseIds.add(phrase.id);
    previousPhraseTo = phrase.to;
    previousPhraseEndMs = phrase.endMs;
  }

  const safePauses: SpeechAlignment['safePauses'] = [];
  const pauseIds = new Set<string>();
  let previousPauseAtMs = 0;

  for (const pause of alignment.safePauses) {
    if (
      pause.id.trim() === ''
      || pauseIds.has(pause.id)
      || !Number.isSafeInteger(pause.textAt)
      || pause.textAt < 0
      || pause.textAt > canonicalText.length
      || splitsUtf16Character(canonicalText, pause.textAt)
      || !Number.isFinite(pause.quietFromMs)
      || !Number.isFinite(pause.atMs)
      || !Number.isFinite(pause.quietToMs)
      || pause.quietFromMs < 0
      || pause.quietFromMs >= pause.quietToMs
      || pause.atMs < pause.quietFromMs
      || pause.atMs > pause.quietToMs
      || pause.quietToMs > alignment.durationMs
      || pause.atMs < previousPauseAtMs
    ) {
      return null;
    }

    safePauses.push({ ...pause });
    pauseIds.add(pause.id);
    previousPauseAtMs = pause.atMs;
  }

  if (
    (alignment.quality === 'word-exact' && (
      spans.length === 0
      || phrases.length === 0
      || spans.some((span) => span.precision !== 'word')
    ))
    || (alignment.quality === 'phrase' && (
      spans.length === 0
      || phrases.length === 0
      || spans.some((span) => span.precision !== 'phrase')
    ))
    || (alignment.quality === 'approximate' && (
      spans.length > 0 || phrases.length > 0 || safePauses.length > 0
    ))
  ) {
    return null;
  }

  return {
    version: SPEECH_ALIGNMENT_VERSION,
    textHash: input.textHash,
    audioContentHash: input.audioContentHash,
    speechTimingContentHash: input.speechTimingContentHash,
    producerVersion: SPEECH_ALIGNMENT_PRODUCER_VERSION,
    durationMs: alignment.durationMs,
    quality: alignment.quality,
    spans,
    phrases,
    safePauses,
    reason: alignment.reason,
  };
}

/** Переводит общий секундный wire-контракт Whisper в шкалу WAV миллисекунд. */
export function speechTimingFromTranscript(
  transcript: SpeechTranscript | null | undefined,
): PublishableSpeechTiming | null {
  if (!transcript) {
    return null;
  }

  const spans = (value: readonly { text: string; start: number; end: number }[]) => value.map(
    (span) => ({ text: span.text, startMs: span.start * 1000, endMs: span.end * 1000 }),
  );

  return {
    source: 'whisper',
    words: transcript.wordTimingStatus === 'valid' ? spans(transcript.words) : [],
    segments: spans(transcript.segments),
  };
}

/**
 * Валидные provider metadata превращаются в неизменяемый JSON. Отсутствующие или
 * неверные метки возвращают null до файловой записи и никогда не мешают WAV.
 */
export async function publishSpeechTiming(
  input: PublishSpeechTimingInput,
): Promise<ShowcaseDerivedArtifactRef | null> {
  const document = documentOf(input);

  if (!document) {
    return null;
  }

  // Собственный декодер проверяет ровно тот контракт, который затем читает.
  speechTimingDocument(document, 'speechTiming');

  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
  const contentHash = contentHashOf(bytes);
  const id = `speech-timing-${randomBytes(6).toString('hex')}`;
  const file = path.join(input.targetDir, `${id}.json`);
  const temporary = `${file}.tmp-${randomBytes(4).toString('hex')}`;

  await fs.mkdir(input.targetDir, { recursive: true, mode: 0o700 });

  try {
    await fs.writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => null);
    throw error;
  }

  return {
    id,
    inputHash: speechTimingInputHash(input.sceneInputHash, input.audioContentHash),
    contentHash,
    producerVersion: SPEECH_TIMING_PRODUCER_VERSION,
    byteSize: bytes.length,
  };
}

/**
 * Чтение производного документа безопасно деградирует в null: битый JSON или
 * несовпавший хеш старит только метки, но не отправляет проект и WAV в карантин.
 */
export async function readSpeechTiming(
  input: ReadSpeechTimingInput,
): Promise<SpeechTimingDocument | null> {
  if (
    !SPEECH_TIMING_ID.test(input.ref.id)
    || input.ref.inputHash !== speechTimingInputHash(input.sceneInputHash, input.audioContentHash)
    || input.ref.producerVersion !== SPEECH_TIMING_PRODUCER_VERSION
  ) {
    return null;
  }

  const file = path.join(input.targetDir, `${input.ref.id}.json`);
  const bytes = await fs.readFile(file).catch(() => null);

  if (
    !bytes
    || bytes.length !== input.ref.byteSize
    || contentHashOf(bytes) !== input.ref.contentHash
  ) {
    return null;
  }

  try {
    const decoded = speechTimingDocument(JSON.parse(bytes.toString('utf8')), 'speechTiming');
    const normalized = documentOf({
      timing: {
        source: decoded.source,
        words: decoded.words,
        segments: decoded.segments,
      },
      sceneInputHash: input.sceneInputHash,
      audioContentHash: decoded.audioContentHash,
      producerVersion: decoded.producerVersion,
      durationMs: decoded.durationMs,
      targetDir: input.targetDir,
    });

    if (
      !normalized
      || decoded.audioContentHash !== input.audioContentHash
      || decoded.extractionVersion !== SPEECH_TIMING_PRODUCER_VERSION
      || decoded.reason !== (
        decoded.source === 'whisper'
          ? (decoded.quality === 'word-exact' ? ASR_WORD_VALID_REASON : ASR_PHRASE_VALID_REASON)
          : NATIVE_VALID_REASON
      )
      || JSON.stringify(normalized) !== JSON.stringify(decoded)
    ) {
      return null;
    }

    return decoded;
  } catch {
    return null;
  }
}

/**
 * Сопоставление публикуется отдельно от raw timing: правка narration старит только
 * диапазоны текста, не заставляя повторно распознавать тот же WAV.
 */
export async function publishSpeechAlignment(
  input: PublishSpeechAlignmentInput,
): Promise<ShowcaseDerivedArtifactRef | null> {
  const document = alignmentDocumentOf(input);

  if (!document) {
    return null;
  }

  speechAlignmentDocument(document, 'speechAlignment');

  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
  const contentHash = contentHashOf(bytes);
  const id = `speech-alignment-${randomBytes(6).toString('hex')}`;
  const file = path.join(input.targetDir, `${id}.json`);
  const temporary = `${file}.tmp-${randomBytes(4).toString('hex')}`;

  await fs.mkdir(input.targetDir, { recursive: true, mode: 0o700 });

  try {
    await fs.writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => null);
    throw error;
  }

  return {
    id,
    inputHash: speechAlignmentInputHash(
      input.textHash,
      input.audioContentHash,
      input.speechTimingContentHash,
    ),
    contentHash,
    producerVersion: SPEECH_ALIGNMENT_PRODUCER_VERSION,
    byteSize: bytes.length,
  };
}

/** Битый alignment старит только производный расчёт и никогда не quarantine project. */
export async function readSpeechAlignment(
  input: ReadSpeechAlignmentInput,
): Promise<SpeechAlignmentDocument | null> {
  if (
    !SPEECH_ALIGNMENT_ID.test(input.ref.id)
    || input.ref.inputHash !== speechAlignmentInputHash(
      input.textHash,
      input.audioContentHash,
      input.speechTimingContentHash,
    )
    || input.ref.producerVersion !== SPEECH_ALIGNMENT_PRODUCER_VERSION
  ) {
    return null;
  }

  const file = path.join(input.targetDir, `${input.ref.id}.json`);
  const bytes = await fs.readFile(file).catch(() => null);

  if (
    !bytes
    || bytes.length !== input.ref.byteSize
    || contentHashOf(bytes) !== input.ref.contentHash
  ) {
    return null;
  }

  try {
    const decoded = speechAlignmentDocument(
      JSON.parse(bytes.toString('utf8')),
      'speechAlignment',
    );
    const normalized = alignmentDocumentOf({
      alignment: {
        canonicalText: input.canonicalText,
        durationMs: decoded.durationMs,
        quality: decoded.quality,
        spans: decoded.spans,
        phrases: decoded.phrases,
        safePauses: decoded.safePauses,
        reason: decoded.reason,
      },
      canonicalText: input.canonicalText,
      textHash: input.textHash,
      audioContentHash: input.audioContentHash,
      speechTimingContentHash: input.speechTimingContentHash,
      targetDir: input.targetDir,
    });

    if (
      !normalized
      || decoded.textHash !== input.textHash
      || decoded.audioContentHash !== input.audioContentHash
      || decoded.speechTimingContentHash !== input.speechTimingContentHash
      || decoded.producerVersion !== SPEECH_ALIGNMENT_PRODUCER_VERSION
      || JSON.stringify(normalized) !== JSON.stringify(decoded)
    ) {
      return null;
    }

    return decoded;
  } catch {
    return null;
  }
}

/**
 * Manifest получает content-addressed имя: latestFinal хранит только ID, поэтому
 * сам ID обязан доказывать целостность JSON без второго sidecar или пути.
 */
export async function publishFinalManifest(
  input: PublishFinalManifestInput,
): Promise<PublishedFinalManifest> {
  const manifest = parseShowcaseFinalManifest(input.manifest);
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const contentHash = contentHashOf(bytes);
  const id = `manifest-${contentHash}`;
  const file = path.join(input.targetDir, `${id}.json`);
  const temporary = `${file}.tmp-${randomBytes(4).toString('hex')}`;

  await fs.mkdir(input.targetDir, { recursive: true, mode: 0o700 });

  try {
    await fs.writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, file);
    await fs.chmod(file, 0o600).catch(() => null);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => null);
    throw error;
  }

  return { id, contentHash, byteSize: bytes.length };
}

/**
 * Читатель проверяет форму имени, хеш точных байтов, общий codec и при необходимости
 * владельца. Любое несовпадение остаётся локальной негодностью manifest.
 */
export async function readFinalManifest(
  input: ReadFinalManifestInput,
): Promise<ShowcaseFinalManifest | null> {
  if (!SHOWCASE_MANIFEST_ID_RE.test(input.manifestId)) {
    return null;
  }

  const file = path.join(input.targetDir, `${input.manifestId}.json`);
  const bytes = await fs.readFile(file).catch(() => null);
  const expectedHash = input.manifestId.slice('manifest-'.length);

  if (
    !bytes
    || bytes.length === 0
    || bytes.length > MANIFEST_MAX_BYTES
    || contentHashOf(bytes) !== expectedHash
  ) {
    return null;
  }

  try {
    const manifest = parseShowcaseFinalManifest(JSON.parse(bytes.toString('utf8')));

    return input.projectId === undefined || manifest.projectId === input.projectId
      ? manifest
      : null;
  } catch {
    return null;
  }
}

// Единая подготовка реплики для полной озвучки и предпрослушивания.
//
// Сохранённый narration остаётся экранным текстом. Движку уходит отдельная
// произносимая строка с локальными заменами, а все диапазоны указаний переводятся
// из координат канонической строки в её координаты. Та же карта возвращает
// измеренные слова обратно к экранному тексту для cue и субтитров.
import type {
  ShowcasePronunciationOverride,
  ShowcaseScene,
} from '../../../../../shared/showcaseContracts.ts';
import {
  applyPronunciationReplacements,
  parseNarration,
  pronunciationOutputOffset,
  pronunciationSourceOffset,
  splitsUtf16Character,
} from '../../../../../shared/showcaseNarration.ts';
import type {
  AppliedPronunciationText,
  NarrationStress,
} from '../../../../../shared/showcaseNarration.ts';
import { ShowcaseError } from '../errors.ts';
import { syncTextHash } from '../scenes.ts';
import type { SpeechAlignment } from './alignment.ts';
import { dictionaryStresses } from './dictionary.ts';
import type { StressEntry } from './dictionary.ts';
import type { VoiceDirection } from './contract.ts';

export interface PronunciationOverrideInput {
  from: number;
  to: number;
  pronunciation: string;
  voiceRef: string;
  // Просьба не сохранять старый hash у смыслово той же записи. Клиент не задаёт
  // сам hash: сервер лишь подписывает диапазон текущей канонической строкой.
  refresh?: true;
}

export interface PronunciationResolution {
  sourceText: string;
  textHash: string;
  overrides: ShowcasePronunciationOverride[];
  applied: AppliedPronunciationText | null;
  issue: string | null;
}

export interface PreparedVoiceText {
  sourceText: string;
  spokenText: string;
  direction: VoiceDirection;
  dictionaryStresses: NarrationStress[];
  overrides: ShowcasePronunciationOverride[];
  applied: AppliedPronunciationText;
}

const MAX_OVERRIDES = 64;
const MAX_PRONUNCIATION_CHARS = 5000;
const VOICE_REF = /^[^:\s]{1,80}:[^:\s]{1,160}$/u;

/** Старший источник ударения выигрывает у следующих источников на том же слове. */
export function mergeStresses(
  ...sources: readonly (readonly NarrationStress[])[]
): NarrationStress[] {
  const seen = new Set<number>();
  const merged: NarrationStress[] = [];

  for (const source of sources) {
    for (const stress of source) {
      if (!seen.has(stress.at)) {
        seen.add(stress.at);
        merged.push(stress);
      }
    }
  }

  return merged;
}

function validateInputs(
  sourceText: string,
  inputs: readonly PronunciationOverrideInput[],
): string | null {
  if (inputs.length > MAX_OVERRIDES) {
    return `В одной реплике допускается не больше ${MAX_OVERRIDES} произносительных замен.`;
  }

  const previousTo = new Map<string, number>();

  for (const [index, input] of inputs.entries()) {
    const label = `Замена ${index + 1}`;

    if (
      !Number.isSafeInteger(input.from)
      || !Number.isSafeInteger(input.to)
      || input.from < 0
      || input.to <= input.from
      || input.to > sourceText.length
    ) {
      return `${label} выходит за границы текста реплики.`;
    }

    if (input.from < (previousTo.get(input.voiceRef) ?? 0)) {
      return `${label} пересекается с предыдущей произносительной заменой.`;
    }

    if (
      splitsUtf16Character(sourceText, input.from)
      || splitsUtf16Character(sourceText, input.to)
    ) {
      return `${label} разрезает один Unicode-символ.`;
    }

    if (!sourceText.slice(input.from, input.to).trim()) {
      return `${label} должна относиться к непустому фрагменту реплики.`;
    }

    const pronunciation = parseNarration(input.pronunciation).text;

    if (!pronunciation) {
      return `${label} не содержит произносимого текста.`;
    }

    if (pronunciation.length > MAX_PRONUNCIATION_CHARS) {
      return `${label} длиннее допустимого текста голосового движка.`;
    }

    if (!VOICE_REF.test(input.voiceRef)) {
      return `${label} содержит некорректную ссылку на голос.`;
    }

    previousTo.set(input.voiceRef, input.to);
  }

  return null;
}

function sameOverride(
  saved: ShowcasePronunciationOverride,
  input: PronunciationOverrideInput,
): boolean {
  return saved.from === input.from
    && saved.to === input.to
    && saved.pronunciation === input.pronunciation
    && saved.voiceRef === input.voiceRef;
}

/**
 * HTTP присылает только смысл замены. Хеш текущего канонического текста ставит
 * сервер: клиент не может пометить старый диапазон как относящийся к новой строке.
 */
export function createPronunciationOverrides(
  narration: string,
  inputs: readonly PronunciationOverrideInput[],
  previous: readonly ShowcasePronunciationOverride[] = [],
): ShowcasePronunciationOverride[] {
  const sourceText = parseNarration(narration).text;
  const sorted = inputs.map((input) => ({ ...input })).sort((left, right) => (
    left.from - right.from || left.to - right.to
  ));
  const textHash = syncTextHash(sourceText);

  if (sorted.length > MAX_OVERRIDES) {
    throw new ShowcaseError(
      'bad_pronunciation_overrides',
      `В одной реплике допускается не больше ${MAX_OVERRIDES} произносительных замен.`,
      400,
    );
  }

  // Неизменённая сохранённая замена сохраняет прежний textHash. Поэтому правка
  // соседней замены не оживит старый диапазон после изменения narration. Новый
  // диапазон всегда подписывается текущим текстом на сервере.
  const stamped = sorted.map((input) => {
    const known = input.refresh
      ? undefined
      : previous.find((entry) => sameOverride(entry, input));

    return {
      from: input.from,
      to: input.to,
      pronunciation: input.pronunciation,
      voiceRef: input.voiceRef,
      textHash: known?.textHash ?? textHash,
    };
  });
  const issue = validateInputs(
    sourceText,
    stamped.filter((entry) => entry.textHash === textHash),
  );

  if (issue) {
    throw new ShowcaseError('bad_pronunciation_overrides', issue, 400);
  }

  return stamped;
}

/** Только замены этой редакции текста и этого голоса влияют на синтез. */
export function resolvePronunciation(
  scene: Pick<ShowcaseScene, 'narration' | 'pronunciationOverrides'>,
  voiceRef: string,
): PronunciationResolution {
  const sourceText = parseNarration(scene.narration).text;
  const textHash = syncTextHash(sourceText);
  const overrides = (scene.pronunciationOverrides ?? [])
    .filter((entry) => entry.textHash === textHash && entry.voiceRef === voiceRef)
    .map((entry) => ({ ...entry }))
    .sort((left, right) => left.from - right.from || left.to - right.to);
  const issue = validateInputs(sourceText, overrides);

  return {
    sourceText,
    textHash,
    overrides,
    applied: issue ? null : applyPronunciationReplacements(sourceText, overrides),
    issue,
  };
}

function pointInsideOverride(
  at: number,
  overrides: readonly ShowcasePronunciationOverride[],
): boolean {
  return overrides.some((entry) => entry.from <= at && at < entry.to);
}

function mapStress(
  applied: AppliedPronunciationText,
  overrides: readonly ShowcasePronunciationOverride[],
  stress: NarrationStress,
): NarrationStress | null {
  const vowelAt = stress.at + stress.vowel;

  // Произносимая замена полностью владеет ударением выбранного фрагмента.
  if (pointInsideOverride(vowelAt, overrides)) {
    return null;
  }

  const at = pronunciationOutputOffset(applied, stress.at, 'start');
  const outputVowel = pronunciationOutputOffset(applied, vowelAt, 'start');

  if (outputVowel < at) {
    return null;
  }

  return { at, vowel: outputVowel - at };
}

/** Готовит тот самый SynthesisInput, который используют preview и полный job. */
export function prepareVoiceText(input: {
  scene: Pick<ShowcaseScene, 'narration' | 'direction' | 'pronunciationOverrides'>;
  voiceRef: string;
  stressDictionary: readonly StressEntry[];
}): PreparedVoiceText {
  const parsed = parseNarration(input.scene.narration);
  const resolution = resolvePronunciation(input.scene, input.voiceRef);

  if (resolution.issue || !resolution.applied) {
    throw new ShowcaseError(
      'bad_pronunciation_overrides',
      resolution.issue ?? 'Произносительные замены не применились.',
      409,
    );
  }

  const applied = resolution.applied;
  const sourceStresses = parsed.stresses.flatMap((stress) => {
    const mapped = mapStress(applied, resolution.overrides, stress);

    return mapped ? [mapped] : [];
  });
  const explicit = mergeStresses(applied.stresses, sourceStresses);
  const fromDictionary = dictionaryStresses(
    applied.text,
    input.stressDictionary,
    explicit.map((stress) => stress.at),
  );
  const directed = input.scene.direction.stresses.flatMap((stress) => {
    const mapped = mapStress(applied, resolution.overrides, stress);

    return mapped ? [mapped] : [];
  });
  const emphasis = input.scene.direction.emphasis.flatMap((range) => {
    const from = pronunciationOutputOffset(applied, range.from, 'start');
    const to = pronunciationOutputOffset(applied, range.to, 'end');

    return to > from ? [{ from, to }] : [];
  });
  const pauses = input.scene.direction.pauses.map((pause) => ({
    at: pronunciationOutputOffset(applied, pause.at, 'end'),
    ms: pause.ms,
  }));

  return {
    sourceText: resolution.sourceText,
    spokenText: applied.text,
    direction: {
      ...input.scene.direction,
      emphasis,
      pauses,
      stresses: mergeStresses(explicit, fromDictionary, directed),
    },
    dictionaryStresses: fromDictionary,
    overrides: resolution.overrides,
    applied,
  };
}

/** Возвращает измеренную шкалу произносимого текста к диапазонам сцены. */
export function alignmentToSource(
  alignment: SpeechAlignment,
  prepared: PreparedVoiceText,
): SpeechAlignment {
  const range = (from: number, to: number) => ({
    from: pronunciationSourceOffset(prepared.applied, from, 'start'),
    to: pronunciationSourceOffset(prepared.applied, to, 'end'),
  });

  return {
    ...alignment,
    canonicalText: prepared.sourceText,
    spans: alignment.spans.flatMap((span) => {
      const mapped = range(span.from, span.to);

      return mapped.to > mapped.from ? [{ ...span, ...mapped }] : [];
    }),
    phrases: alignment.phrases.flatMap((phrase) => {
      const mapped = range(phrase.from, phrase.to);

      return mapped.to > mapped.from ? [{ ...phrase, ...mapped }] : [];
    }),
    safePauses: alignment.safePauses.map((pause) => ({
      ...pause,
      textAt: pronunciationSourceOffset(prepared.applied, pause.textAt, 'end'),
    })),
    reason: prepared.overrides.length > 0
      ? `${alignment.reason} Диапазоны возвращены по явной карте произношения.`
      : alignment.reason,
  };
}

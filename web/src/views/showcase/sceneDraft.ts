// Черновик текста сцены и его сравнение с сохранённой сценой. Живёт отдельно от
// компонентов: экран ролика держит черновики всех сцен, а редактор правит один.
import type {
  ShowcaseAction,
  ShowcaseDirection,
  ShowcaseScene,
  ShowcaseSyncCueKind,
  ShowcaseSyncCueOrigin,
} from '../../../../shared/plugins/showcase/showcaseContracts';
import { parseNarration, plainNarration } from '../../../../shared/plugins/showcase/showcaseNarration';
import { validateShowcaseSyncBindings } from '../../../../shared/plugins/showcase/showcaseSync';

export interface SceneSyncCueDraft {
  id: string | null;
  actionIndex: number;
  from: number;
  to: number;
  kind: ShowcaseSyncCueKind;
  origin: ShowcaseSyncCueOrigin;
}

export interface SceneSyncCuePayload {
  id?: string;
  actionIndex: number;
  from: number;
  to: number;
  kind: ShowcaseSyncCueKind;
  manual?: true;
}

export interface ScenePronunciationDraft {
  from: number;
  to: number;
  pronunciation: string;
  voiceRef: string;
  // null у новой правки: актуальный хеш добавит сервер при сохранении.
  textHash: string | null;
}

export interface ScenePronunciationPayload {
  from: number;
  to: number;
  pronunciation: string;
  voiceRef: string;
  refresh?: true;
}

export interface SceneNarrationPreviewInput {
  voiceRef: string;
  narration: string;
  direction: ShowcaseDirection;
  pronunciationOverrides: ScenePronunciationPayload[];
}

export interface SceneDraft {
  title: string;
  narration: string;
  caption: string;
  subtitleText: string;
  syncCues: SceneSyncCueDraft[];
  pronunciationOverrides: ScenePronunciationDraft[];
}

export interface SceneTextPayload {
  id: string;
  title: string;
  narration: string;
  caption: string;
  subtitleText: string;
  syncCues?: SceneSyncCuePayload[];
  pronunciationOverrides?: ScenePronunciationPayload[];
}

export type SceneBindingStatus = 'missing' | 'valid' | 'stale' | 'invalid' | 'unknown';

/**
 * Сохранённые cue становятся редактируемым, но ещё не доверенным черновиком.
 * Копии не позволяют форме менять объект проекта до явного сохранения.
 */
export function cueDraftsOf(scene: ShowcaseScene): SceneSyncCueDraft[] {
  return (scene.syncBindings?.cues ?? []).map((cue) => ({ ...cue }));
}

// Черновик из сохранённой сцены: с него начинается правка, и с ним же сравнивается
// набранное, чтобы понять, есть ли что сохранять.
export function draftOf(scene: ShowcaseScene): SceneDraft {
  return {
    title: scene.title,
    narration: scene.narration,
    caption: scene.caption,
    subtitleText: scene.subtitleText,
    syncCues: cueDraftsOf(scene),
    pronunciationOverrides: (scene.pronunciationOverrides ?? []).map((entry) => ({
      ...entry,
    })),
  };
}

function sameCueMeaning(left: SceneSyncCueDraft, right: SceneSyncCueDraft): boolean {
  return left.actionIndex === right.actionIndex
    && left.from === right.from
    && left.to === right.to
    && left.kind === right.kind
    && left.origin === right.origin;
}

/**
 * ID новой связи появится после ответа сервера и не делает её вечно несохранённой.
 * Сравнивается смысл cue, а не служебная идентичность объекта.
 */
export function syncCuesChanged(scene: ShowcaseScene, draft: SceneDraft): boolean {
  const current = cueDraftsOf(scene);

  return current.length !== draft.syncCues.length
    || current.some((cue, index) => !sameCueMeaning(cue, draft.syncCues[index] as SceneSyncCueDraft));
}

function samePronunciationMeaning(
  left: ScenePronunciationDraft,
  right: ScenePronunciationDraft,
): boolean {
  return left.from === right.from
    && left.to === right.to
    && left.pronunciation === right.pronunciation
    && left.voiceRef === right.voiceRef;
}

function samePronunciation(
  left: ScenePronunciationDraft,
  right: ScenePronunciationDraft,
): boolean {
  return samePronunciationMeaning(left, right) && left.textHash === right.textHash;
}

/**
 * Подхватывает серверный hash у только что сохранённой локальной замены.
 * Это гасит черновик после ответа, не перетирая следующую несохранённую правку.
 */
export function reconcilePronunciationHashes(scene: ShowcaseScene, draft: SceneDraft): SceneDraft {
  const saved: ScenePronunciationDraft[] = (scene.pronunciationOverrides ?? [])
    .map((entry) => ({ ...entry }));

  return {
    ...draft,
    pronunciationOverrides: draft.pronunciationOverrides.map((entry) => {
      if (entry.textHash !== null) {
        return entry;
      }

      const match = saved.find((candidate) => samePronunciationMeaning(candidate, entry));

      return match ? { ...entry, textHash: match.textHash } : entry;
    }),
  };
}

// Локальная замена считается сохранённой только при совпадении диапазона, голоса,
// произношения и хеша текста; один размер массива этого не доказывает.
export function pronunciationOverridesChanged(scene: ShowcaseScene, draft: SceneDraft): boolean {
  const current: ScenePronunciationDraft[] = (scene.pronunciationOverrides ?? [])
    .map((entry) => ({ ...entry }));

  return current.length !== draft.pronunciationOverrides.length
    || current.some((entry, index) => !samePronunciation(
      entry,
      draft.pronunciationOverrides[index] as ScenePronunciationDraft,
    ));
}

// Есть ли в черновике то, чего нет в сцене. Экран и действия этот редактор не
// трогает, но ручные смысловые связи сохраняются вместе с текстом.
export function draftChanged(scene: ShowcaseScene, draft: SceneDraft): boolean {
  return draft.title !== scene.title
    || draft.narration !== scene.narration
    || draft.caption !== scene.caption
    || draft.subtitleText !== scene.subtitleText
    || syncCuesChanged(scene, draft)
    || pronunciationOverridesChanged(scene, draft);
}

/**
 * Что уходит на сервер при сохранении. Субтитр по умолчанию повторяет речь: пока
 * человек его не правил, он следует за текстом озвучки, и заполнять два поля одним
 * и тем же не нужно. Знаки ударения в субтитр не попадают — зрителю «з+амок»
 * читался бы как опечатка.
 */
export function payloadOf(scene: ShowcaseScene, draft: SceneDraft): SceneTextPayload {
  const subtitleFollows = scene.subtitleText === plainNarration(scene.narration)
    && draft.subtitleText === scene.subtitleText;
  const includeSyncCues = syncCuesChanged(scene, draft);
  const includePronunciation = pronunciationOverridesChanged(scene, draft);

  return {
    id: scene.id,
    title: draft.title,
    narration: draft.narration,
    caption: draft.caption,
    subtitleText: subtitleFollows ? plainNarration(draft.narration) : draft.subtitleText,
    ...(includeSyncCues ? {
      syncCues: draft.syncCues.map((cue) => ({
        ...(cue.id ? { id: cue.id } : {}),
        actionIndex: cue.actionIndex,
        from: cue.from,
        to: cue.to,
        kind: cue.kind,
        ...(cue.origin === 'manual' ? { manual: true as const } : {}),
      })),
    } : {}),
    ...(includePronunciation ? {
      pronunciationOverrides: draft.pronunciationOverrides.map((entry) => ({
        from: entry.from,
        to: entry.to,
        pronunciation: entry.pronunciation,
        voiceRef: entry.voiceRef,
        ...(entry.textHash === null ? { refresh: true as const } : {}),
      })),
    } : {}),
  };
}

function canonicalActions(actions: readonly ShowcaseAction[]): Record<string, unknown>[] {
  return actions.map((action) => {
    if (action.kind === 'scroll') {
      return {
        kind: action.kind,
        targetId: action.targetId,
        delta: action.delta,
      };
    }

    if (action.kind === 'wait') {
      return { kind: action.kind, ms: action.ms };
    }

    return { kind: action.kind, targetId: action.targetId };
  });
}

/**
 * Тот же SHA-256 JSON-контракт, что у сервера, через штатный Web Crypto браузера.
 * При отсутствии API возвращается unknown-ветка, а не самодельный несовместимый хеш.
 */
async function syncHash(domain: 'text' | 'actions', value: unknown): Promise<string | null> {
  if (!globalThis.crypto?.subtle) {
    return null;
  }

  const bytes = new TextEncoder().encode(JSON.stringify({
    version: 1,
    domain,
    value,
  }));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

// Хеш строится по каноническому тексту без управляющих знаков произношения.
// Та же нормализация связывает локальные замены с сохранённой сервером репликой.
export function narrationTextHash(narration: string): Promise<string | null> {
  return syncHash('text', parseNarration(narration).text);
}

/**
 * Проверяет сохранённую связь для редактора. Хеш асинхронный только потому, что
 * браузерный SHA-256 асинхронен; собственная реализация криптографии ради подписи
 * «устарело» разошлась бы с сервером и была бы хуже честного unknown.
 */
export async function bindingStatusOf(
  scene: ShowcaseScene,
  narration = scene.narration,
): Promise<SceneBindingStatus> {
  if (!scene.syncBindings) {
    return 'missing';
  }

  const canonicalText = parseNarration(narration).text;
  const [textHash, actionsHash] = await Promise.all([
    syncHash('text', canonicalText),
    syncHash('actions', canonicalActions(scene.actions)),
  ]);

  if (!textHash || !actionsHash) {
    return 'unknown';
  }

  return validateShowcaseSyncBindings({
    bindings: scene.syncBindings,
    canonicalText,
    actions: scene.actions,
    expectedTextHash: textHash,
    expectedActionsHash: actionsHash,
  }).status;
}

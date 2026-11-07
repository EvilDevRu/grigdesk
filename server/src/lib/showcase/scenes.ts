// Операции над сценами ролика.
//
// Сцена — единица редактирования, и правка одной не должна трогать соседнюю.
// Поэтому здесь нет ни одной операции, которая переписывает чужие артефакты:
// изменённая сцена просто перестаёт совпадать со своими хешами входов, и это
// делает её устаревшей — сама по себе, без флага и без чужого участия.
//
// Порядок хранится числом `order`, а каталоги артефактов — по `sceneId`.
// Перестановка меняет номера, но не трогает файлы: клип третьей сцены остаётся
// клипом той же сцены, куда бы её ни передвинули.
import { createHash, randomBytes } from 'node:crypto';

import type {
  ShowcaseAction,
  ShowcaseProject,
  ShowcaseScene,
} from '../../../../shared/plugins/showcase/showcaseContracts.ts';
import { parseNarration, plainNarration } from '../../../../shared/plugins/showcase/showcaseNarration.ts';
import {
  SHOWCASE_SYNC_BINDING_VERSION,
  validateShowcaseSyncBindings,
} from '../../../../shared/plugins/showcase/showcaseSync.ts';
import type {
  ShowcaseSyncBindings,
  ShowcaseSyncCue,
  ShowcaseSyncValidation,
} from '../../../../shared/plugins/showcase/showcaseSync.ts';
import { ShowcaseError, notFound } from './errors.ts';

export interface SceneDraft {
  title: string;
  screenId: string;
  narration: string;
  caption: string;
  subtitleText: string;
  startState: string | null;
  readyCondition: string | null;
  // Продолжение начинается там, где закончилась предыдущая сцена, а не со своего
  // экрана. Необязательно: сцена без указания открывает экран сама.
  continuesPrevious?: boolean;
  actions: ShowcaseAction[];
  // `undefined` при patch сохраняет прежние связи, `null` удаляет их явно.
  // Хеши и cue создаёт сервер; HTTP первого этапа это поле ещё не принимает.
  syncBindings?: ShowcaseSyncBindings | null;
}

export type SceneSyncCueDraft = Omit<ShowcaseSyncCue, 'id'>;

export type SceneSyncBindingsState = ShowcaseSyncValidation | {
  status: 'missing';
  issues: [];
};

export function newSceneId(): string {
  return `scene-${randomBytes(5).toString('hex')}`;
}

/** Хеш смысловой связи разделён по домену, чтобы текст не совпал с JSON действий. */
function syncHash(domain: 'text' | 'actions', value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify({ version: SHOWCASE_SYNC_BINDING_VERSION, domain, value }))
    .digest('hex')
    .slice(0, 32);
}

/** Хеш всегда считается от канонической строки без `+` и лишних пробелов. */
export function syncTextHash(narration: string): string {
  return syncHash('text', parseNarration(narration).text);
}

/** Хеш охватывает принятые действия целиком и сохраняет их порядок. */
export function syncActionsHash(actions: readonly ShowcaseAction[]): string {
  const canonical = actions.map((action) => {
    if (action.kind === 'scroll') {
      return { kind: action.kind, targetId: action.targetId, delta: action.delta };
    }

    if (action.kind === 'wait') {
      return { kind: action.kind, ms: action.ms };
    }

    return { kind: action.kind, targetId: action.targetId };
  });

  return syncHash('actions', canonical);
}

/**
 * Единая проверка сохранённой привязки сцены. Любой будущий планировщик обязан
 * брать связь отсюда: несовпавшие хеши означают `stale`, а не новые координаты
 * поверх старой ручной работы.
 */
export function sceneSyncBindingsState(scene: ShowcaseScene): SceneSyncBindingsState {
  if (!scene.syncBindings) {
    return { status: 'missing', issues: [] };
  }

  return validateShowcaseSyncBindings({
    bindings: scene.syncBindings,
    canonicalText: parseNarration(scene.narration).text,
    actions: scene.actions,
    expectedTextHash: syncTextHash(scene.narration),
    expectedActionsHash: syncActionsHash(scene.actions),
  });
}

/** Новые cue получают ID и оба хеша на сервере, а не из ответа модели или UI. */
export function createSyncBindings(
  narration: string,
  actions: readonly ShowcaseAction[],
  cues: readonly SceneSyncCueDraft[],
): ShowcaseSyncBindings {
  const bindings: ShowcaseSyncBindings = {
    version: SHOWCASE_SYNC_BINDING_VERSION,
    textHash: syncTextHash(narration),
    actionsHash: syncActionsHash(actions),
    cues: cues.map((cue) => ({
      ...cue,
      id: `cue-${randomBytes(6).toString('hex')}`,
    })),
  };
  const validation = validateShowcaseSyncBindings({
    bindings,
    canonicalText: parseNarration(narration).text,
    actions,
    expectedTextHash: bindings.textHash,
    expectedActionsHash: bindings.actionsHash,
  });

  if (validation.status !== 'valid') {
    throw new ShowcaseError(
      'bad_sync_bindings',
      validation.issues[0]?.message ?? 'Смысловые привязки сцены некорректны.',
      400,
    );
  }

  return bindings;
}

/** Явно присланная привязка обязана подходить итоговой редакции сцены. */
function assertSceneSyncBindings(scene: ShowcaseScene): void {
  const validation = sceneSyncBindingsState(scene);

  if (validation.status === 'valid' || validation.status === 'missing') {
    return;
  }

  throw new ShowcaseError(
    'bad_sync_bindings',
    validation.issues[0]?.message ?? 'Смысловые привязки сцены некорректны.',
    400,
  );
}

const EMPTY_DIRECTION: ShowcaseScene['direction'] = {
  tone: null,
  pace: null,
  emphasis: [],
  pauses: [],
  stresses: [],
};

/**
 * Новая сцена встаёт в конец: вставка в середину — это перестановка, и делать её
 * побочным эффектом добавления нельзя. Звук по умолчанию синтезируется; загрузка
 * готовой записи меняет источник явным действием.
 *
 * Голос и темп наследуются у последней сцены: человек выбирает их для ролика
 * целиком, и новая сцена, заговорившая другим голосом, читалась бы как ошибка.
 * Субтитр по умолчанию повторяет речь без знаков ударения: «з+амок» в субтитре
 * был бы опечаткой.
 */
export function createScene(project: ShowcaseProject, draft: SceneDraft): ShowcaseScene {
  const order = project.scenes.reduce((max, scene) => Math.max(max, scene.order), 0) + 1;
  const previous = [...project.scenes].sort((left, right) => left.order - right.order).at(-1);
  const inheritedVoice = previous?.audioSource.kind === 'tts' ? previous.audioSource.voiceRef : null;

  const created: ShowcaseScene = {
    id: newSceneId(),
    order,
    title: draft.title.trim() || `Сцена ${order}`,
    screenId: draft.screenId,
    startState: draft.startState,
    readyCondition: draft.readyCondition,
    continuesPrevious: draft.continuesPrevious ?? false,
    actions: draft.actions,
    narration: draft.narration,
    caption: draft.caption,
    subtitleText: draft.subtitleText || plainNarration(draft.narration),
    direction: { ...EMPTY_DIRECTION, pace: previous?.direction.pace ?? null },
    pronunciationOverrides: [],
    timing: null,
    syncBindings: draft.syncBindings ?? null,
    speechTiming: null,
    speechAlignment: null,
    recordingTiming: null,
    audioSource: { kind: 'tts', voiceRef: inheritedVoice, artifactId: null },
    audio: null,
    clip: null,
    frame: null,
    checks: [],
    stale: true,
  };

  if (draft.syncBindings !== undefined) {
    assertSceneSyncBindings(created);
  }

  return created;
}

export function sceneOf(project: ShowcaseProject, sceneId: string): ShowcaseScene {
  const scene = project.scenes.find((item) => item.id === sceneId);

  if (!scene) {
    throw notFound('Сцена не найдена.');
  }

  return scene;
}

/**
 * Правка сцены. Меняются только присланные поля: пустая правка не должна обнулять
 * то, чего в ней нет, а «сохранить всё целиком» из интерфейса означало бы затирать
 * работу, сделанную заданием параллельно.
 */
export function patchScene(scene: ShowcaseScene, patch: Partial<SceneDraft>): ShowcaseScene {
  const changed: ShowcaseScene = {
    ...scene,
    title: patch.title?.trim() || scene.title,
    screenId: patch.screenId ?? scene.screenId,
    startState: patch.startState === undefined ? scene.startState : patch.startState,
    readyCondition: patch.readyCondition === undefined
      ? scene.readyCondition
      : patch.readyCondition,
    continuesPrevious: patch.continuesPrevious ?? scene.continuesPrevious ?? false,
    actions: patch.actions ?? scene.actions,
    narration: patch.narration ?? scene.narration,
    caption: patch.caption ?? scene.caption,
    subtitleText: patch.subtitleText ?? scene.subtitleText,
    syncBindings: patch.syncBindings === undefined
      ? scene.syncBindings
      : patch.syncBindings,
  };

  if (patch.syncBindings !== undefined) {
    assertSceneSyncBindings(changed);
  }

  return changed;
}

/**
 * Перестановка. Приходит полный список идентификаторов: частичный порядок пришлось
 * бы домысливать, а домысел здесь означает ролик, собранный не в том порядке.
 */
export function reorderScenes(project: ShowcaseProject, order: string[]): ShowcaseScene[] {
  const known = new Set(project.scenes.map((scene) => scene.id));

  if (order.length !== project.scenes.length || order.some((id) => !known.has(id))) {
    throw new ShowcaseError(
      'bad_order',
      'Новый порядок обязан перечислить все сцены ролика ровно по разу.',
      400,
    );
  }

  if (new Set(order).size !== order.length) {
    throw new ShowcaseError('bad_order', 'В новом порядке есть повторы сцен.', 400);
  }

  return order.map((id, index) => ({
    ...sceneOf(project, id),
    order: index + 1,
  }));
}

/** Удаление сцены сдвигает номера остальных, сохраняя их относительный порядок. */
export function removeScene(project: ShowcaseProject, sceneId: string): ShowcaseScene[] {
  sceneOf(project, sceneId);

  return project.scenes
    .filter((scene) => scene.id !== sceneId)
    .sort((left, right) => left.order - right.order)
    .map((scene, index) => ({ ...scene, order: index + 1 }));
}

/**
 * Замена сцены в списке. Возвращается новый массив: запись ролика неизменяема,
 * и правка на месте оставила бы прежний объект в снимке идущего задания.
 */
export function replaceScene(project: ShowcaseProject, changed: ShowcaseScene): ShowcaseScene[] {
  return project.scenes.map((scene) => (scene.id === changed.id ? changed : scene));
}

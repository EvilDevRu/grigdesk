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
import { randomBytes } from 'node:crypto';

import type {
  ShowcaseAction,
  ShowcaseProject,
  ShowcaseScene,
} from '../../../../shared/showcaseContracts.ts';
import { ShowcaseError, notFound } from './errors.ts';

export interface SceneDraft {
  title: string;
  screenId: string;
  narration: string;
  caption: string;
  subtitleText: string;
  startState: string | null;
  readyCondition: string | null;
  actions: ShowcaseAction[];
}

export function newSceneId(): string {
  return `scene-${randomBytes(5).toString('hex')}`;
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
 */
export function createScene(project: ShowcaseProject, draft: SceneDraft): ShowcaseScene {
  const order = project.scenes.reduce((max, scene) => Math.max(max, scene.order), 0) + 1;

  return {
    id: newSceneId(),
    order,
    title: draft.title.trim() || `Сцена ${order}`,
    screenId: draft.screenId,
    startState: draft.startState,
    readyCondition: draft.readyCondition,
    actions: draft.actions,
    narration: draft.narration,
    caption: draft.caption,
    subtitleText: draft.subtitleText || draft.narration,
    direction: EMPTY_DIRECTION,
    timing: null,
    audioSource: { kind: 'tts', voiceRef: null, artifactId: null },
    audio: null,
    clip: null,
    frame: null,
    checks: [],
    stale: true,
  };
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
  return {
    ...scene,
    title: patch.title?.trim() || scene.title,
    screenId: patch.screenId ?? scene.screenId,
    startState: patch.startState === undefined ? scene.startState : patch.startState,
    readyCondition: patch.readyCondition === undefined
      ? scene.readyCondition
      : patch.readyCondition,
    actions: patch.actions ?? scene.actions,
    narration: patch.narration ?? scene.narration,
    caption: patch.caption ?? scene.caption,
    subtitleText: patch.subtitleText ?? scene.subtitleText,
  };
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

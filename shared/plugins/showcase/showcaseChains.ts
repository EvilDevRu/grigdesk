// Цепочки сцен ролика. Формула общая для сервера и браузера: сервер по ней
// считает свежесть и состав записи, а экран ролика — какие сцены переснимутся и
// какую подписать продолжением. Два независимых расчёта разошлись бы на первом же
// переставленном флаге.
//
// Цепочка — голова, которая открывает свой экран, и идущие за ней подряд
// сцены-продолжения. Продолжение начинается там, где закончилась предыдущая сцена,
// поэтому первая сцена ролика продолжением быть не может: продолжать ей нечего, и
// флаг у неё не считается.

export interface ChainScene {
  id: string;
  order: number;
  continuesPrevious?: boolean | null;
}

/** Сцены в порядке показа. Хранятся они как угодно, а цепочки считаются по порядку. */
export function orderedScenes<Scene extends ChainScene>(scenes: readonly Scene[]): Scene[] {
  return [...scenes].sort((left, right) => left.order - right.order);
}

/**
 * Цепочки в порядке показа. Сцена без флага начинает новую цепочку; первая сцена
 * ролика начинает её всегда, каким бы ни был её флаг.
 */
export function sceneChains<Scene extends ChainScene>(scenes: readonly Scene[]): Scene[][] {
  const chains: Scene[][] = [];

  for (const scene of orderedScenes(scenes)) {
    const current = chains.at(-1);

    if (current && scene.continuesPrevious === true) {
      current.push(scene);
    } else {
      chains.push([scene]);
    }
  }

  return chains;
}

/** Цепочка, в которой стоит сцена. Неизвестная сцена — пустой список, а не отказ. */
export function chainOf<Scene extends ChainScene>(
  scenes: readonly Scene[],
  sceneId: string,
): Scene[] {
  return sceneChains(scenes).find((chain) => chain.some((scene) => scene.id === sceneId)) ?? [];
}

/**
 * Сцены цепочки ДО данной: их экран и действия задают её начальное состояние, и
 * поэтому входят в хеш её записи. У головы цепочки список пуст.
 */
export function chainLineage<Scene extends ChainScene>(
  scenes: readonly Scene[],
  sceneId: string,
): Scene[] {
  const chain = chainOf(scenes, sceneId);
  const index = chain.findIndex((scene) => scene.id === sceneId);

  return index > 0 ? chain.slice(0, index) : [];
}

/** Продолжает ли сцена предыдущую НА ДЕЛЕ, с учётом того, что первой продолжать нечего. */
export function continuesPrevious<Scene extends ChainScene>(
  scenes: readonly Scene[],
  sceneId: string,
): boolean {
  return chainLineage(scenes, sceneId).length > 0;
}

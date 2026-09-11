// Разбор ответа модели: бриф и сценарий.
//
// Ответ модели — недоверенные данные, поэтому здесь он проходит те же ворота, что
// и сетевой JSON: строгая форма, закрытый список видов действий и проверка КАЖДОГО
// идентификатора по принятой карте экранов. Незнакомый экран или элемент не
// «пропускается на всякий случай» — он делает весь ответ негодным.
//
// Негодный ответ не меняет сохранённую редакцию: у человека остаётся то, что он
// уже принял, а не половина новой версии.
import { exactKeys, jsonCandidates, modelText } from '../../modelJson.ts';
import type { ShowcaseAction } from '../../../../../shared/showcaseContracts.ts';
import { BRIEF_MAX, BRIEF_MIN } from './prompt.ts';
import type { ScriptScreen } from './prompt.ts';

export interface DraftScene {
  title: string;
  screenId: string;
  narration: string;
  caption: string;
  subtitleText: string;
  actions: ShowcaseAction[];
}

const TARGET_ACTIONS = new Set(['goto', 'click', 'hover', 'highlight', 'waitVisible']);
const NARRATION_MAX = 400;
const CAPTION_MAX = 120;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Бриф из ответа модели. Число пунктов проверяется по границам плана: слишком
 * короткий список нечего показывать, слишком длинный — не ролик, а пересказ.
 */
export function parseBrief(reply: unknown): string[] | null {
  for (const candidate of jsonCandidates(reply)) {
    if (typeof candidate !== 'string') {
      continue;
    }

    try {
      const parsed: unknown = JSON.parse(candidate);

      if (!isRecord(parsed) || !exactKeys(parsed, ['points']) || !Array.isArray(parsed.points)) {
        continue;
      }

      const points = parsed.points
        .map((point: unknown) => modelText(point).replace(/\s+/gu, ' '))
        .filter(Boolean);

      if (points.length < BRIEF_MIN || points.length > BRIEF_MAX) {
        continue;
      }

      if (points.some((point) => point.length > 300)) {
        continue;
      }

      return points;
    } catch {
      // Следующий кандидат может быть чистым JSON внутри markdown-забора.
    }
  }

  return null;
}

/**
 * Действие сцены. Модель называет идентификатор элемента, а селектор к нему
 * подставляет recorder по карте профиля — сюда селектор не проходит ни в каком виде.
 */
// Переход на экран сцены делает сама запись, поэтому `goto` без цели — не ошибка
// формы, а лишнее слово: такое действие просто выбрасывается из сцены.
const SKIP_ACTION = Symbol('skip');

function parseAction(value: unknown, screen: ScriptScreen): ShowcaseAction | typeof SKIP_ACTION | null {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    return null;
  }

  if (value.kind === 'goto' && (value.targetId === null || value.targetId === undefined)) {
    return SKIP_ACTION;
  }

  if (value.kind === 'wait') {
    const ms = Number(value.ms);

    return Number.isSafeInteger(ms) && ms >= 0 && ms <= 15_000 ? { kind: 'wait', ms } : null;
  }

  if (value.kind === 'scroll') {
    const delta = Number(value.delta);

    if (!Number.isFinite(delta)) {
      return null;
    }

    const targetId = typeof value.targetId === 'string' ? value.targetId : null;

    if (targetId && !screen.elements.some((element) => element.id === targetId)) {
      return null;
    }

    return { kind: 'scroll', targetId, delta };
  }

  if (!TARGET_ACTIONS.has(value.kind) || typeof value.targetId !== 'string') {
    return null;
  }

  if (!screen.elements.some((element) => element.id === value.targetId)) {
    return null;
  }

  return {
    kind: value.kind as 'goto' | 'click' | 'hover' | 'highlight' | 'waitVisible',
    targetId: value.targetId,
  };
}

function parseScene(value: unknown, screens: ScriptScreen[]): DraftScene | null {
  if (!isRecord(value)) {
    return null;
  }

  const expected = ['title', 'screenId', 'narration', 'caption', 'subtitleText', 'actions'];

  if (!exactKeys(value, expected) || !Array.isArray(value.actions)) {
    return null;
  }

  const screen = screens.find((item) => item.id === modelText(value.screenId));

  if (!screen) {
    return null;
  }

  const narration = modelText(value.narration).replace(/\s+/gu, ' ');
  const caption = modelText(value.caption).replace(/\s+/gu, ' ');
  const subtitleText = modelText(value.subtitleText).replace(/\s+/gu, ' ');
  const title = modelText(value.title).replace(/\s+/gu, ' ');

  if (!narration || narration.length > NARRATION_MAX || caption.length > CAPTION_MAX) {
    return null;
  }

  const actions: ShowcaseAction[] = [];

  for (const item of value.actions) {
    const action = parseAction(item, screen);

    if (!action) {
      return null;
    }

    if (action !== SKIP_ACTION) {
      actions.push(action);
    }
  }

  return {
    title: title || screen.title,
    screenId: screen.id,
    narration,
    caption,
    subtitleText: subtitleText || narration,
    actions,
  };
}

/**
 * Сценарий целиком. Одна негодная сцена отменяет весь ответ: сохранить половину
 * значило бы оставить человеку ролик, часть которого он не принимал и не видел.
 */
export function parseScript(
  reply: unknown,
  screens: ScriptScreen[],
  maxScenes: number,
): DraftScene[] | null {
  for (const candidate of jsonCandidates(reply)) {
    if (typeof candidate !== 'string') {
      continue;
    }

    try {
      const parsed: unknown = JSON.parse(candidate);

      if (!isRecord(parsed) || !exactKeys(parsed, ['scenes']) || !Array.isArray(parsed.scenes)) {
        continue;
      }

      if (parsed.scenes.length === 0 || parsed.scenes.length > maxScenes) {
        continue;
      }

      const scenes: DraftScene[] = [];
      let valid = true;

      for (const item of parsed.scenes) {
        const scene = parseScene(item, screens);

        if (!scene) {
          valid = false;

          break;
        }

        scenes.push(scene);
      }

      if (valid) {
        return scenes;
      }
    } catch {
      // Следующий кандидат может быть чистым JSON внутри markdown-забора.
    }
  }

  return null;
}

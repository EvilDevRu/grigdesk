// Разбор ответа модели: бриф и сценарий.
//
// Ответ модели — недоверенные данные, поэтому здесь он проходит те же ворота, что
// и сетевой JSON: строгая форма, закрытый список видов действий и проверка КАЖДОГО
// идентификатора по принятой карте экранов. Незнакомый экран или элемент не
// «пропускается на всякий случай» — он делает весь ответ негодным.
//
// Негодный ответ не меняет сохранённую редакцию: у человека остаётся то, что он
// уже принял, а не половина новой версии.
import { isRecord } from '../../../../../shared/lib/objects.ts';
import { trimmedText } from '../../../../../shared/lib/text.ts';

import { exactKeys, jsonCandidates } from '../../modelJson.ts';
import type { ShowcaseAction } from '../../../../../shared/plugins/showcase/showcaseContracts.ts';
import {
  SHOWCASE_NARRATION_MAX_CHARS,
  parseNarration,
  plainNarration,
} from '../../../../../shared/plugins/showcase/showcaseNarration.ts';
import {
  SHOWCASE_SYNC_ACTIONS_BY_CUE,
  SHOWCASE_SYNC_BINDING_VERSION,
  SHOWCASE_SYNC_CUE_KINDS,
  validateShowcaseSyncBindings,
} from '../../../../../shared/plugins/showcase/showcaseSync.ts';
import type { ShowcaseSyncCueKind } from '../../../../../shared/plugins/showcase/showcaseSync.ts';
import { BRIEF_MAX, BRIEF_MIN } from './prompt.ts';
import type { ScriptScreen } from './prompt.ts';

export interface DraftSyncCue {
  actionIndex: number;
  from: number;
  to: number;
  kind: ShowcaseSyncCueKind;
  origin: 'generated';
}

export interface DraftScene {
  // Только для проверки сохранённых ручных сцен; ответ модели этих полей не принимает.
  startState?: string | null;
  readyCondition?: string | null;
  title: string;
  screenId: string;
  // Сцена продолжает предыдущую с того места, где та закончилась, а не открывает
  // экран заново. У первой сцены сценария всегда false: продолжать ей нечего.
  continuesPrevious: boolean;
  narration: string;
  caption: string;
  subtitleText: string;
  actions: ShowcaseAction[];
  // `null` означает старый годный ответ без поля bindings. Пустой массив — новое
  // явное предложение без связей для сцены, где подходящих действий нет.
  syncCues: DraftSyncCue[] | null;
}

/**
 * Сценарий вместе с честным списком того, чего модели не хватило в карте экранов.
 * Пробелы — текст для человека, а не адреса и не селекторы: по ним он дополняет
 * `showcase/screens.json` профиля, а не расширяет доступ по слову модели.
 */
export interface DraftScript {
  scenes: DraftScene[];
  gaps: string[];
}

export interface ScriptReplyProblem {
  sceneId: string | null;
  sceneIndex: number | null;
  message: string;
}

export type ScriptReplyResult = {
  draft: DraftScript;
  problem: null;
} | {
  draft: null;
  problem: ScriptReplyProblem | null;
};

export interface BindingReplyScene {
  id: string;
  title: string;
  narration: string;
  actions: ShowcaseAction[];
  manualActionIndices: readonly number[];
}

export type BindingReplyResult = {
  bindings: Map<string, DraftSyncCue[]>;
  problem: null;
} | {
  bindings: null;
  problem: ScriptReplyProblem | null;
};

const TARGET_ACTIONS = new Set(['goto', 'click', 'hover', 'highlight', 'waitVisible']);
const CAPTION_MAX = 120;
const GAP_MAX = 240;
const GAPS_MAX = 12;

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
        .map((point: unknown) => trimmedText(point).replace(/\s+/gu, ' '))
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

/**
 * Цель действия — элемент своего экрана по карте или найденный браузером элемент
 * любого экрана: у найденного есть личность и проверка видимости при действии, а
 * клик, уводящий на другую страницу, и ожидание элемента уже на ней — одна сцена.
 */
function knowsTarget(screen: ScriptScreen, screens: readonly ScriptScreen[], targetId: string): boolean {
  return screen.elements.some((element) => element.id === targetId)
    || screens.some((item) => item.elements.some((element) => element.id === targetId && element.observed));
}

function parseAction(
  value: unknown,
  screen: ScriptScreen,
  screens: readonly ScriptScreen[],
): ShowcaseAction | typeof SKIP_ACTION | null {
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

    if (targetId && !knowsTarget(screen, screens, targetId)) {
      return null;
    }

    return { kind: 'scroll', targetId, delta };
  }

  if (!TARGET_ACTIONS.has(value.kind) || typeof value.targetId !== 'string') {
    return null;
  }

  if (!knowsTarget(screen, screens, value.targetId)) {
    return null;
  }

  return {
    kind: value.kind as 'goto' | 'click' | 'hover' | 'highlight' | 'waitVisible',
    targetId: value.targetId,
  };
}

interface ParsedBindingSet {
  cues: DraftSyncCue[] | null;
  problem: string | null;
}

/** Находит указанное появление цитаты, не подменяя повторы первым `indexOf`. */
function quoteRange(
  canonicalText: string,
  quote: string,
  occurrence: number,
): { from: number; to: number } | null {
  let from = 0;
  let found = -1;

  for (let current = 1; current <= occurrence; current += 1) {
    found = canonicalText.indexOf(quote, from);

    if (found < 0) {
      return null;
    }

    // Смещение хотя бы на один UTF-16 code unit сохраняет различимость даже у
    // перекрывающихся цитат. Для обычной фразы следующий поиск начинается дальше.
    from = found + Math.max(1, quote.length);
  }

  return { from: found, to: found + quote.length };
}

/**
 * Переводит модельные цитаты в канонические диапазоны. Числовые from/to от модели
 * форма не принимает; actionIndex сначала проходит карту исходного массива в уже
 * принятый, поэтому выброшенный лишний goto не превращается в соседнее действие.
 */
function parseBindings(
  value: unknown,
  narration: string,
  actions: ShowcaseAction[],
  sourceToAccepted: readonly (number | null)[],
  reservedActions: ReadonlySet<number> = new Set(),
): ParsedBindingSet {
  if (!Array.isArray(value)) {
    return { cues: null, problem: 'поле bindings должно быть массивом.' };
  }

  const canonicalText = parseNarration(narration).text;
  const cues: DraftSyncCue[] = [];
  const boundActions = new Set<number>();

  for (const [bindingIndex, item] of value.entries()) {
    if (!isRecord(item) || !exactKeys(item, ['quote', 'occurrence', 'actionIndex', 'kind'])) {
      return {
        cues: null,
        problem: `связь ${bindingIndex + 1} содержит неизвестные или недостающие поля.`,
      };
    }

    if (
      typeof item.quote !== 'string'
      || !Number.isSafeInteger(item.occurrence)
      || Number(item.occurrence) < 1
      || !Number.isSafeInteger(item.actionIndex)
      || Number(item.actionIndex) < 0
      || typeof item.kind !== 'string'
      || !(SHOWCASE_SYNC_CUE_KINDS as readonly string[]).includes(item.kind)
    ) {
      return { cues: null, problem: `связь ${bindingIndex + 1} имеет неверную форму.` };
    }

    const sourceActionIndex = Number(item.actionIndex);
    const actionIndex = sourceToAccepted[sourceActionIndex];

    if (actionIndex === undefined) {
      return {
        cues: null,
        problem: `связь ${bindingIndex + 1} ссылается на отсутствующее действие ${sourceActionIndex}.`,
      };
    }

    if (actionIndex === null) {
      return {
        cues: null,
        problem: `связь ${bindingIndex + 1} ссылается на удалённое лишнее действие ${sourceActionIndex}.`,
      };
    }

    if (reservedActions.has(actionIndex)) {
      return {
        cues: null,
        problem: `действие ${actionIndex} уже связано вручную и не может быть заменено моделью.`,
      };
    }

    if (boundActions.has(actionIndex)) {
      return { cues: null, problem: `действие ${actionIndex} связано больше одного раза.` };
    }

    const kind = item.kind as ShowcaseSyncCueKind;
    const action = actions[actionIndex] as ShowcaseAction;
    const allowed = SHOWCASE_SYNC_ACTIONS_BY_CUE[kind] as readonly string[];

    if (!allowed.includes(action.kind)) {
      return {
        cues: null,
        problem: `связь «${kind}» неприменима к действию «${action.kind}» ${actionIndex}.`,
      };
    }

    const quote = parseNarration(item.quote).text;

    if (!quote) {
      return { cues: null, problem: `связь ${bindingIndex + 1} содержит пустую цитату.` };
    }

    const range = quoteRange(canonicalText, quote, Number(item.occurrence));

    if (!range) {
      const shown = quote.slice(0, 80);

      return {
        cues: null,
        problem: `цитата «${shown}» не имеет появления ${item.occurrence} в narration.`,
      };
    }

    cues.push({
      actionIndex,
      from: range.from,
      to: range.to,
      kind,
      origin: 'generated',
    });
    boundActions.add(actionIndex);
  }

  const validation = validateShowcaseSyncBindings({
    bindings: {
      version: SHOWCASE_SYNC_BINDING_VERSION,
      textHash: 'draft',
      actionsHash: 'draft',
      cues: cues.map((cue, index) => ({ ...cue, id: `draft-${index}` })),
    },
    canonicalText,
    actions,
    expectedTextHash: 'draft',
    expectedActionsHash: 'draft',
  });

  return validation.status === 'valid'
    ? { cues, problem: null }
    : { cues: null, problem: validation.issues[0]?.message ?? 'связи сцены противоречат друг другу.' };
}

interface ParsedScene {
  scene: DraftScene | null;
  problem: ScriptReplyProblem | null;
}

function parseScene(value: unknown, screens: ScriptScreen[], sceneIndex: number): ParsedScene {
  if (!isRecord(value)) {
    return { scene: null, problem: null };
  }

  const expected = ['title', 'screenId', 'narration', 'caption', 'subtitleText', 'actions'];

  // Признак продолжения необязателен: сцена без него открывает экран сама. Но если
  // он есть, это именно булево — «true» строкой у недоверенного ответа не считается.
  const withContinuation = exactKeys(value, [...expected, 'continuesPrevious']);
  const withBindings = exactKeys(value, [...expected, 'bindings']);
  const withContinuationAndBindings = exactKeys(
    value,
    [...expected, 'continuesPrevious', 'bindings'],
  );

  if (
    (!exactKeys(value, expected) && !withContinuation && !withBindings && !withContinuationAndBindings)
    || !Array.isArray(value.actions)
  ) {
    return { scene: null, problem: null };
  }

  if (
    (withContinuation || withContinuationAndBindings)
    && typeof value.continuesPrevious !== 'boolean'
  ) {
    return { scene: null, problem: null };
  }

  const screen = screens.find((item) => item.id === trimmedText(value.screenId));

  if (!screen) {
    return { scene: null, problem: null };
  }

  const narration = trimmedText(value.narration).replace(/\s+/gu, ' ');
  const caption = trimmedText(value.caption).replace(/\s+/gu, ' ');
  const subtitleText = trimmedText(value.subtitleText).replace(/\s+/gu, ' ');
  const title = trimmedText(value.title).replace(/\s+/gu, ' ');

  if (
    !narration
    || narration.length > SHOWCASE_NARRATION_MAX_CHARS
    || caption.length > CAPTION_MAX
  ) {
    return { scene: null, problem: null };
  }

  const actions: ShowcaseAction[] = [];
  const sourceToAccepted: (number | null)[] = [];

  for (const item of value.actions) {
    const action = parseAction(item, screen, screens);

    if (!action) {
      return { scene: null, problem: null };
    }

    if (action === SKIP_ACTION) {
      sourceToAccepted.push(null);

      continue;
    }

    sourceToAccepted.push(actions.length);
    actions.push(action);
  }

  const hasBindings = withBindings || withContinuationAndBindings;
  const parsedBindings = hasBindings
    ? parseBindings(value.bindings, narration, actions, sourceToAccepted)
    : { cues: null, problem: null };

  if (parsedBindings.problem) {
    return {
      scene: null,
      problem: {
        sceneId: null,
        sceneIndex,
        message: `Сцена ${sceneIndex + 1}: ${parsedBindings.problem}`,
      },
    };
  }

  return {
    scene: {
      title: title || screen.title,
      screenId: screen.id,
      continuesPrevious: value.continuesPrevious === true,
      narration,
      caption,
      // Субтитр без знаков ударения: модель ставит их в речи, а читать их зрителю не надо.
      subtitleText: subtitleText || plainNarration(narration),
      actions,
      syncCues: parsedBindings.cues,
    },
    problem: null,
  };
}

/**
 * Пробелы карты экранов из ответа. Поле необязательное: пустой список и его
 * отсутствие — одно и то же. Строки укорачиваются и ограничиваются числом: это
 * подсказка человеку, а не ещё один канал для длинного недоверенного текста.
 */
function parseGaps(value: unknown): string[] | null {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    return null;
  }

  return value
    .map((item: unknown) => trimmedText(item).replace(/\s+/gu, ' ').trim().slice(0, GAP_MAX))
    .filter(Boolean)
    .slice(0, GAPS_MAX);
}

/**
 * Сценарий целиком. Одна негодная сцена отменяет весь ответ: сохранить половину
 * значило бы оставить человеку ролик, часть которого он не принимал и не видел.
 */
export function parseScriptReplyResult(
  reply: unknown,
  screens: ScriptScreen[],
  maxScenes: number,
): ScriptReplyResult {
  let problem: ScriptReplyProblem | null = null;

  for (const candidate of jsonCandidates(reply)) {
    if (typeof candidate !== 'string') {
      continue;
    }

    try {
      const parsed: unknown = JSON.parse(candidate);

      if (!isRecord(parsed) || !Array.isArray(parsed.scenes)) {
        continue;
      }

      if (!exactKeys(parsed, ['scenes']) && !exactKeys(parsed, ['scenes', 'gaps'])) {
        continue;
      }

      if (parsed.scenes.length === 0 || parsed.scenes.length > maxScenes) {
        continue;
      }

      const gaps = parseGaps(parsed.gaps);

      if (!gaps) {
        continue;
      }

      const scenes: DraftScene[] = [];
      let valid = true;

      for (const [sceneIndex, item] of parsed.scenes.entries()) {
        const parsedScene = parseScene(item, screens, sceneIndex);

        if (!parsedScene.scene) {
          problem = parsedScene.problem ?? problem;
          valid = false;

          break;
        }

        scenes.push(parsedScene.scene);
      }

      if (valid) {
        // Первой сцене продолжать нечего: флаг у неё — оговорка модели, а не
        // причина отвергать весь сценарий.
        return {
          draft: {
            scenes: scenes.map((scene, index) => (
              index === 0 ? { ...scene, continuesPrevious: false } : scene
            )),
            gaps,
          },
          problem: null,
        };
      }
    } catch {
      // Следующий кандидат может быть чистым JSON внутри markdown-забора.
    }
  }

  return { draft: null, problem };
}

/** Совместимая обёртка для прежних потребителей, которым нужна только форма. */
export function parseScriptReply(
  reply: unknown,
  screens: ScriptScreen[],
  maxScenes: number,
): DraftScript | null {
  return parseScriptReplyResult(reply, screens, maxScenes).draft;
}

/** Только сцены сценария — для мест, которым пробелы карты не нужны. */
export function parseScript(
  reply: unknown,
  screens: ScriptScreen[],
  maxScenes: number,
): DraftScene[] | null {
  return parseScriptReply(reply, screens, maxScenes)?.scenes ?? null;
}

/**
 * Ответ отдельного построения связей перечисляет уже сохранённые сцены по ID.
 * Любой пропуск, повтор или незнакомый ID отменяет весь ответ: смешивать связи из
 * разных редакций проекта нельзя даже при совпавших названиях сцен.
 */
export function parseBindingsReply(
  reply: unknown,
  scenes: readonly BindingReplyScene[],
): BindingReplyResult {
  let problem: ScriptReplyProblem | null = null;
  const byId = new Map(scenes.map((scene) => [scene.id, scene]));

  for (const candidate of jsonCandidates(reply)) {
    if (typeof candidate !== 'string') {
      continue;
    }

    try {
      const parsed: unknown = JSON.parse(candidate);

      if (
        !isRecord(parsed)
        || !exactKeys(parsed, ['scenes'])
        || !Array.isArray(parsed.scenes)
        || parsed.scenes.length !== scenes.length
      ) {
        continue;
      }

      const bindings = new Map<string, DraftSyncCue[]>();
      let valid = true;

      for (const item of parsed.scenes) {
        if (
          !isRecord(item)
          || !exactKeys(item, ['sceneId', 'bindings'])
          || typeof item.sceneId !== 'string'
        ) {
          valid = false;

          break;
        }

        const scene = byId.get(item.sceneId);

        if (!scene || bindings.has(scene.id)) {
          problem = {
            sceneId: scene?.id ?? null,
            sceneIndex: scene ? scenes.indexOf(scene) : null,
            message: scene
              ? `Сцена «${scene.title}» перечислена в ответе больше одного раза.`
              : `Ответ ссылается на неизвестную сцену «${item.sceneId.slice(0, 80)}».`,
          };
          valid = false;

          break;
        }

        const sourceToAccepted = scene.actions.map((_, index) => index);
        const parsedBindings = parseBindings(
          item.bindings,
          scene.narration,
          scene.actions,
          sourceToAccepted,
          new Set(scene.manualActionIndices),
        );

        if (!parsedBindings.cues) {
          problem = {
            sceneId: scene.id,
            sceneIndex: scenes.indexOf(scene),
            message: `Сцена «${scene.title}»: ${parsedBindings.problem ?? 'связи не разобраны.'}`,
          };
          valid = false;

          break;
        }

        bindings.set(scene.id, parsedBindings.cues);
      }

      if (valid && bindings.size === scenes.length) {
        return { bindings, problem: null };
      }
    } catch {
      // Следующий кандидат может быть чистым JSON внутри markdown-забора.
    }
  }

  return { bindings: null, problem };
}

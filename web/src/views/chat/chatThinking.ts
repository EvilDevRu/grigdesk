
import { localeTranslator, messageList } from '../../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from '../../shared/uiLocalePort.ts';

const translateUi = localeTranslator(uiLocalePort);

// Живая строка идущего хода: чем агент занят ПРЯМО СЕЙЧАС и что уже потратил.
//
// Строка состоит из трёх независимых фактов, и каждый отвечает за своё:
//   • слово — действие (пока идёт инструмент) или «думаю» (когда модель молчит);
//   • время — сколько ход идёт по часам ЭТОГО окна;
//   • токены — расход вывода хода, если исполнитель его публикует.
// Модуль чистый: компонент отвечает только за анимацию и тик времени, поэтому
// правила выбора слова и формата проверяются без DOM.

// Шаг ленты в том виде, в каком он доехал до окна (см. server/src/lib/chat/streamSteps.ts).
export interface ChatThinkingStep {
  k?: string;
  id?: string;
  name?: string;
  [field: string]: unknown;
}

// «Думаю» — настроение модели, а не факт: моделей несколько, и одно и то же слово
// висело бы минутами. Порядок на каждый ход свой (см. shuffledOrder), поэтому строка живёт
// и не заучивается. Правила для фраз: первое лицо, настоящее время, про работу над ответом —
// без вопросов человеку и без обещаний; длина не больше «Выполняю команду», под которое
// зарезервирована ячейка слова (фраза длиннее сдвинула бы числа справа). Дубли и длину
// сторожит тест THINK-04.
export const THINKING_WORDS = messageList([
  'core.chatThinkingThinking',
  'core.chatThinkingReflecting',
  'core.chatThinkingConsidering',
  'core.chatThinkingReasoning',
  'core.chatThinkingEstimating',
  'core.chatThinkingWeighingOptions',
  'core.chatThinkingExamining',
  'core.chatThinkingWorkingItOut',
  'core.chatThinkingMatchingClues',
  'core.chatThinkingThinkingAhead',
  'core.chatThinkingFormulating',
  'core.chatThinkingMakingSense',
  'core.chatThinkingEvaluating',
  'core.chatThinkingWorkingThrough',
  'core.chatThinkingReasoningItOut',
  'core.chatThinkingThinkingDeeply',
  'core.chatThinkingAnalyzing',
  'core.chatThinkingReadingClosely',
  'core.chatThinkingLookingClosely',
  'core.chatThinkingTakingALook',
  'core.chatThinkingInspecting',
  'core.chatThinkingLookingAround',
  'core.chatThinkingGoingDeeper',
  'core.chatThinkingDivingIn',
  'core.chatThinkingConcentrating',
  'core.chatThinkingFocusing',
  'core.chatThinkingRecalling',
  'core.chatThinkingRemembering',
  'core.chatThinkingReplaying',
  'core.chatThinkingModeling',
  'core.chatThinkingBreakingItDown',
  'core.chatThinkingUntangling',
  'core.chatThinkingDeciphering',
  'core.chatThinkingStructuring',
  'core.chatThinkingOrganizing',
  'core.githubPereproveryayu',
  'core.chatThinkingReviewing',
  'core.chatThinkingRethinking',
  'core.chatThinkingApproaching',
  'core.chatThinkingDeciding',
  'core.chatThinkingSummingUp',
  'core.chatThinkingGeneralizing',
  'core.chatThinkingSummarizing',
  'core.chatThinkingComparing',
  'core.chatThinkingSimplifying',
  'core.chatThinkingGatheringThoughts',
  'core.chatThinkingSeekingASolution',
  'core.chatThinkingStudyingTheIssue',
  'core.chatThinkingStudyingCode',
  'core.chatThinkingDiggingDeeper',
  'core.chatThinkingLookingDeeper',
  'core.chatThinkingShiftingFocus',
  'core.chatThinkingTryingAnAngle',
  'core.chatThinkingSeekingAnApproach',
  'core.chatThinkingSeekingAClue',
  'core.chatThinkingSeekingACause',
  'core.chatThinkingSeekingABetterMove',
  'core.chatThinkingSeekingAnOption',
  'core.chatThinkingFindingMismatches',
  'core.chatThinkingFindingACompromise',
  'core.chatThinkingSeekingAnElegantFix',
  'core.chatThinkingSeekingASimpleWay',
  'core.chatThinkingSeekingAPattern',
  'core.chatThinkingSeekingTheCore',
  'core.chatThinkingFindingTheCore',
  'core.chatThinkingGettingToTheCore',
  'core.chatThinkingGraspingTheCore',
  'core.chatThinkingCheckingDetails',
  'core.chatThinkingCheckingFacts',
  'core.chatThinkingCheckingData',
  'core.chatThinkingCheckingVersions',
  'core.chatThinkingCheckingTheTask',
  'core.chatThinkingCheckingTheGoal',
  'core.chatThinkingCheckingTheCode',
  'core.chatThinkingTestingAHunch',
  'core.chatThinkingCheckingLogic',
  'core.chatThinkingFormingAHypothesis',
  'core.chatThinkingBuildingAPlan',
  'core.chatThinkingBuildingTheLogic',
  'core.chatThinkingBuildingAChain',
  'core.chatThinkingOutliningSteps',
  'core.chatThinkingOutliningAPlan',
  'core.chatThinkingPlanningSteps',
  'core.chatThinkingDraftingAPlan',
  'core.chatThinkingSketchingADiagram',
  'core.chatThinkingExtendingThePlan',
  'core.chatThinkingRefiningThePlan',
  'core.chatThinkingEstimatingScope',
  'core.chatThinkingAssessingRisks',
  'core.chatThinkingAssessingScope',
  'core.chatThinkingWeighingRisks',
  'core.chatThinkingCountingOptions',
  'core.chatThinkingExploringMoves',
  'core.chatThinkingRehearsing',
  'core.chatThinkingChoosingWords',
  'core.chatThinkingFindingASolution',
  'core.chatThinkingTryingASolution',
  'core.chatThinkingChoosingAPath',
  'core.chatThinkingChoosingAnOption',
  'core.chatThinkingChoosingASolution',
  'core.chatThinkingBuildingAPicture',
  'core.chatThinkingSolvingThePuzzle',
  'core.chatThinkingBringingItTogether',
  'core.chatThinkingGatheringFacts',
  'core.chatThinkingAssemblingASolution',
  'core.chatThinkingComposingAnAnswer',
  'core.chatThinkingPreparingAnAnswer',
  'core.chatThinkingKeepingTheThread',
  'core.chatThinkingFollowingTheThread',
  'core.chatThinkingFollowingATrail',
  'core.chatThinkingCatchingAThought',
  'core.chatThinkingDevelopingAThought',
  'core.chatThinkingTryingAnIdea',
  'core.chatThinkingTestingAThought',
  'core.chatThinkingPolishingASolution',
  'core.chatThinkingRefiningTheResult',
  'core.chatThinkingSimplifyingTheTask',
  'core.chatThinkingBreakingIntoSteps',
  'core.chatThinkingSplittingTheTask',
  'core.chatThinkingSortingThoughts',
  'core.chatThinkingRemovingTheExcess',
  'core.chatThinkingIsolatingTheKey',
  'core.chatThinkingHighlightingTheKey',
  'core.chatThinkingConsideringNuances',
  'core.chatThinkingCatchingNuances',
  'core.chatThinkingCatchingDetails',
  'core.chatThinkingNoticingDetails',
  'core.chatThinkingKeepingContext',
  'core.chatThinkingFindingAPath',
  'core.chatThinkingTestingTheGround',
  'core.chatThinkingMappingAPath',
  'core.chatThinkingClearingAPath',
  'core.chatThinkingFindingTheAnswer',
  'core.chatThinkingDrawingConclusions',
  'core.chatThinkingReachingAResult',
], uiLocalePort);

// Действие инструмента — факт, а не настроение: пока он идёт, слово не меняется.
// Имена нейтральные (их даёт нормализатор исполнителя), поэтому таблица одна на всех.
const TOOL_ACTIONS: Record<string, string> = {
  get Bash() {
    return translateUi('core.chatThinkingRunningACommand');
  },
  get Read() {
    return translateUi('core.chatThinkingReadingFiles');
  },
  get Write() {
    return translateUi('core.chatThinkingWritingAFile');
  },
  get Edit() {
    return translateUi('core.chatThinkingEditingCode');
  },
  get NotebookEdit() {
    return translateUi('core.chatThinkingEditingANotebook');
  },
  get Glob() {
    return translateUi('core.chatThinkingFindingFiles');
  },
  get Grep() {
    return translateUi('core.chatThinkingSearchingCode');
  },
  get WebFetch() {
    return translateUi('core.chatThinkingReadingAPage');
  },
  get WebSearch() {
    return translateUi('core.chatThinkingSearchingTheWeb');
  },
  get Task() {
    return translateUi('core.chatThinkingManagingAnAgent');
  },
  get TodoWrite() {
    return translateUi('core.chatThinkingPlanning');
  },
  get ExitPlanMode() {
    return translateUi('core.chatThinkingPreparingAPlan');
  },
  get Skill() {
    return translateUi('core.chatThinkingRunningASkill');
  },
  get AskUserQuestion() {
    return translateUi('core.chatThinkingAwaitingYourReply');
  },
};

/**
 * Незакрытый вызов инструмента: самый поздний шаг `tool`, для которого в ленте ещё нет
 * своего `res`. Смотреть только на последний вызов нельзя: подагент (`Task`) остаётся
 * открытым, пока внутри него закрываются вложенные вызовы, — и слово откатывалось бы к
 * «думаю» посреди его работы. Все нормализаторы закрывают вызов шагом `res` с тем же id,
 * поэтому открытый вызов в ленте и есть работающий инструмент.
 */
export function runningTool(steps: unknown): ChatThinkingStep | null {
  const list = Array.isArray(steps) ? (steps as ChatThinkingStep[]) : [];
  const closed = new Set(
    list
      .filter((step) => step?.k === 'res' && step.id)
      .map((step) => String(step.id)),
  );

  for (let i = list.length - 1; i >= 0; i -= 1) {
    const step = list[i];

    if (step?.k !== 'tool') {
      continue;
    }

    // Вызов без id закрыть нечем: считаем его отработавшим, иначе он завис бы на весь ход.
    if (step.id && !closed.has(String(step.id))) {
      return step;
    }
  }

  return null;
}

/**
 * Порядок слов «думаю» на один ход: перетасовка индексов без повторов (Фишер — Йетс).
 * Слово берётся по тику из этого порядка, поэтому подряд одно и то же не выпадает, круг
 * проходит весь список, а каждый ход начинается по-своему. Источник случайности —
 * параметр: тесты подставляют свой и проверяют порядок детерминированно.
 */
export function shuffledOrder(count: number, random: () => number = Math.random): number[] {
  const order = Array.from({ length: Math.max(0, Math.trunc(count) || 0) }, (_, i) => i);

  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.min(i, Math.max(0, Math.floor(random() * (i + 1))));
    // Запасные значения недостижимы (индексы в границах), но без них тип «number | undefined».
    const current = order[i] ?? i;
    const picked = order[j] ?? j;

    order[i] = picked;
    order[j] = current;
  }

  return order;
}

/**
 * Слово строки: факт о текущем действии, если инструмент ещё работает.
 * Когда модель молчит, слово берётся из списка «думаю» по тику анимации в порядке
 * `order` (перетасовка хода) — поэтому строка меняется, а не висит одним словом весь ход.
 * Без порядка или с порядком чужой длины список идёт как есть.
 */
export function thinkingWord(steps: unknown, tick: number, order: readonly number[] = []): string {
  const tool = runningTool(steps);

  if (tool) {
    const name = String(tool.name || '');

    if (TOOL_ACTIONS[name]) {
      return TOOL_ACTIONS[name];
    }

    // MCP-инструмент называет свой сервер: «Работаю через playwright» честнее «думаю».
    if (name.startsWith('mcp__')) {
      const server = name.split('__')[1];

      return server
        ? translateUi('core.chatThinkingWorkingVia', { server: server })
        : translateUi('core.chatThinkingUsingATool');
    }

    return translateUi('core.chatThinkingUsingATool');
  }

  const slot = Math.abs(Math.trunc(Number(tick) || 0)) % THINKING_WORDS.length;
  const index = order.length === THINKING_WORDS.length ? (order[slot] ?? slot) : slot;

  return THINKING_WORDS[index] || translateUi('core.chatThinkingThinking');
}

/**
 * Сколько идёт ход — как на секундомере: м:сс, после часа ч:мм:сс. Форма цифровая, чтобы
 * ширина не менялась каждую минуту («1 мин» ↔ «1 мин 1 с» двигали расход справа), а
 * табличные цифры держат её и на тике секунд; знак секундомера рядом объясняет число.
 * Пустая строка — начала хода это окно не видело (загрузилось или переподключилось
 * посреди хода, а сервер длительности не назвал): чужое время лучше не показывать вовсе.
 */
export function formatElapsed(startedAt: unknown, now: number): string {
  const start = Number(startedAt);
  const ms = Number(now) - start;

  if (!Number.isFinite(start) || start <= 0 || !Number.isFinite(ms) || ms < 0) {
    return '';
  }

  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');

  if (hours) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`;
  }

  return `${minutes}:${seconds}`;
}

/**
 * Расход вывода за ход. Пустая строка — исполнитель его не публикует (DeepSeek, Kimi):
 * ноль здесь значит «неизвестно», и подставлять вместо него заполненность контекста
 * нельзя — та же цифра уже показана кольцом и означает совсем другое.
 * Отдельная подпись единицы позволяет узкой строке скрыть её без обрезания числа.
 */
export function formatTurnTokens(tokens: unknown, estimate: boolean, includeUnit = true): string {
  const value = Number(tokens);

  if (!Number.isSafeInteger(value) || value <= 0) {
    return '';
  }

  return `${estimate
    ? '≈ '
    : ''}${value.toLocaleString(
      uiLocalePort.value,
    )}${includeUnit ? translateUi('core.chatThinkingTokens') : ''}`;
}

/**
 * Короткая запись расхода для строки хода: от десяти тысяч — «113 тыс.», от миллиона —
 * «1,2 млн». Округление вниз, чтобы разряд не сменялся раньше времени, а строка не
 * мельтешила цифрами на каждом тике. Точное число остаётся в подсказке (formatTurnTokens).
 */
export function formatTurnTokensShort(tokens: unknown, estimate: boolean): string {
  const value = Number(tokens);

  if (!Number.isSafeInteger(value) || value < 10_000) {
    return formatTurnTokens(tokens, estimate, false);
  }

  const mark = estimate ? '≈ ' : '';

  if (value < 1_000_000) {
    return translateUi('core.chatThinkingK', { mark: mark, value: Math.floor(value / 1_000) });
  }

  const millions = Math.floor(value / 100_000) / 10;

  return translateUi(
    'core.chatThinkingM',
    { mark: mark, value: millions.toLocaleString(uiLocalePort.value) },
  );
}

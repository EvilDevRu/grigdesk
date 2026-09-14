// Смысловые привязки речи к действиям сцены.
//
// Диапазоны относятся к каноническому тексту `parseNarration(narration).text` и
// используют индексы UTF-16 с полуинтервалом [from, to), как строки TypeScript.
// Этот модуль не считает хеши: сервер строит их из принятого текста и действий,
// а общий слой только проверяет сохранённую связь перед любым применением.

export const SHOWCASE_SYNC_BINDING_VERSION = 1 as const;

export const SHOWCASE_SYNC_CUE_KINDS = [
  'align-start',
  'ready-before',
  'hold-through',
] as const;

export const SHOWCASE_SYNC_CUE_ORIGINS = ['generated', 'manual'] as const;

export type ShowcaseSyncCueKind = (typeof SHOWCASE_SYNC_CUE_KINDS)[number];
export type ShowcaseSyncCueOrigin = (typeof SHOWCASE_SYNC_CUE_ORIGINS)[number];

export interface ShowcaseSyncCue {
  id: string;
  actionIndex: number;
  from: number;
  to: number;
  kind: ShowcaseSyncCueKind;
  origin: ShowcaseSyncCueOrigin;
}

export interface ShowcaseSyncBindings {
  version: typeof SHOWCASE_SYNC_BINDING_VERSION;
  textHash: string;
  actionsHash: string;
  cues: ShowcaseSyncCue[];
}

export type ShowcaseSyncIssueCode =
  | 'text_hash_mismatch'
  | 'actions_hash_mismatch'
  | 'empty_cue_id'
  | 'duplicate_cue_id'
  | 'range_empty'
  | 'range_out_of_bounds'
  | 'range_splits_surrogate'
  | 'empty_text_range'
  | 'action_index_out_of_bounds'
  | 'action_kind_not_allowed'
  | 'duplicate_action_binding'
  | 'cue_order_conflict';

export interface ShowcaseSyncIssue {
  code: ShowcaseSyncIssueCode;
  message: string;
  cueId: string | null;
}

export interface ShowcaseSyncValidation {
  status: 'valid' | 'stale' | 'invalid';
  issues: ShowcaseSyncIssue[];
}

export interface ShowcaseSyncValidationInput {
  bindings: ShowcaseSyncBindings;
  canonicalText: string;
  actions: readonly { kind: string }[];
  expectedTextHash: string;
  expectedActionsHash: string;
}

// Разрешения первой версии намеренно узкие. `wait` задаёт длительность, но не
// является смысловой опорой речи и потому отсутствует во всех трёх строках.
export const SHOWCASE_SYNC_ACTIONS_BY_CUE = {
  'align-start': ['goto', 'click', 'hover', 'scroll'],
  'ready-before': ['waitVisible'],
  'hold-through': ['highlight'],
} as const satisfies Record<ShowcaseSyncCueKind, readonly string[]>;

function issue(
  code: ShowcaseSyncIssueCode,
  message: string,
  cueId: string | null = null,
): ShowcaseSyncIssue {
  return { code, message, cueId };
}

/** Граница диапазона не может проходить между половинами surrogate pair. */
function splitsUtf16Character(text: string, at: number): boolean {
  if (at <= 0 || at >= text.length) {
    return false;
  }

  const before = text.charCodeAt(at - 1);
  const after = text.charCodeAt(at);

  return before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF;
}

/** Проверяет, разрешено ли данному виду cue опираться на конкретное действие. */
function supportsAction(kind: ShowcaseSyncCueKind, actionKind: string): boolean {
  const allowed = SHOWCASE_SYNC_ACTIONS_BY_CUE[kind] as readonly string[] | undefined;

  return allowed?.includes(actionKind) ?? false;
}

/**
 * Проверяет привязку перед применением. Несовпавший хеш завершает проверку раньше
 * диапазонов: после правки текста старые координаты относятся к другой строке и
 * диагностировать их как текущие было бы опаснее, чем честно назвать устаревание.
 *
 * Порядок считается по началу фрагмента, а не по расположению cue в JSON. Если
 * более поздняя реплика ссылается на более раннее действие, экран пришлось бы
 * прокрутить назад во времени — такой план невыполним без перестановки состояний.
 */
export function validateShowcaseSyncBindings(
  input: ShowcaseSyncValidationInput,
): ShowcaseSyncValidation {
  const freshnessIssues: ShowcaseSyncIssue[] = [];

  if (input.bindings.textHash !== input.expectedTextHash) {
    freshnessIssues.push(issue(
      'text_hash_mismatch',
      'Привязка относится к другой редакции текста сцены.',
    ));
  }

  if (input.bindings.actionsHash !== input.expectedActionsHash) {
    freshnessIssues.push(issue(
      'actions_hash_mismatch',
      'Привязка относится к другому набору или порядку действий сцены.',
    ));
  }

  if (freshnessIssues.length > 0) {
    return { status: 'stale', issues: freshnessIssues };
  }

  const issues: ShowcaseSyncIssue[] = [];
  const cueIds = new Set<string>();
  // Одно экранное событие нельзя совместить с двумя разными началами речи.
  // Если позже появятся составные ограничения, у них будет отдельная версия.
  const boundActions = new Set<number>();
  const orderCandidates: ShowcaseSyncCue[] = [];

  for (const cue of input.bindings.cues) {
    let usableForOrder = true;

    if (cue.id.trim() === '') {
      issues.push(issue('empty_cue_id', 'У смысловой привязки отсутствует идентификатор.'));
      usableForOrder = false;
    } else if (cueIds.has(cue.id)) {
      issues.push(issue(
        'duplicate_cue_id',
        `Идентификатор привязки «${cue.id}» повторяется.`,
        cue.id,
      ));
      usableForOrder = false;
    } else {
      cueIds.add(cue.id);
    }

    const rangeIsInsideText = Number.isSafeInteger(cue.from)
      && Number.isSafeInteger(cue.to)
      && cue.from >= 0
      && cue.from <= cue.to
      && cue.to <= input.canonicalText.length;

    if (!rangeIsInsideText) {
      issues.push(issue(
        'range_out_of_bounds',
        `Диапазон привязки «${cue.id}» выходит за канонический текст сцены.`,
        cue.id || null,
      ));
      usableForOrder = false;
    } else if (cue.from === cue.to) {
      issues.push(issue(
        'range_empty',
        `Диапазон привязки «${cue.id}» пуст.`,
        cue.id || null,
      ));
      usableForOrder = false;
    } else if (
      splitsUtf16Character(input.canonicalText, cue.from)
      || splitsUtf16Character(input.canonicalText, cue.to)
    ) {
      issues.push(issue(
        'range_splits_surrogate',
        `Диапазон привязки «${cue.id}» разделяет один символ Unicode.`,
        cue.id || null,
      ));
      usableForOrder = false;
    } else if (input.canonicalText.slice(cue.from, cue.to).trim() === '') {
      issues.push(issue(
        'empty_text_range',
        `Диапазон привязки «${cue.id}» не содержит текста речи.`,
        cue.id || null,
      ));
      usableForOrder = false;
    }

    const actionIndexIsValid = Number.isSafeInteger(cue.actionIndex)
      && cue.actionIndex >= 0
      && cue.actionIndex < input.actions.length;

    if (!actionIndexIsValid) {
      issues.push(issue(
        'action_index_out_of_bounds',
        `Привязка «${cue.id}» ссылается на отсутствующее действие ${cue.actionIndex}.`,
        cue.id || null,
      ));
      usableForOrder = false;
    } else {
      const action = input.actions[cue.actionIndex] as { kind: string };

      if (boundActions.has(cue.actionIndex)) {
        issues.push(issue(
          'duplicate_action_binding',
          `Действие ${cue.actionIndex} уже связано с другим фрагментом речи.`,
          cue.id || null,
        ));
        usableForOrder = false;
      } else if (!supportsAction(cue.kind, action.kind)) {
        issues.push(issue(
          'action_kind_not_allowed',
          `Связь «${cue.kind}» нельзя применить к действию «${action.kind}».`,
          cue.id || null,
        ));
        usableForOrder = false;
      }

      boundActions.add(cue.actionIndex);
    }

    if (usableForOrder) {
      orderCandidates.push(cue);
    }
  }

  const ordered = [...orderCandidates].sort((left, right) => (
    left.from - right.from
      || left.to - right.to
      || left.actionIndex - right.actionIndex
      || left.id.localeCompare(right.id)
  ));
  let furthestAction = -1;

  for (const cue of ordered) {
    if (cue.actionIndex < furthestAction) {
      issues.push(issue(
        'cue_order_conflict',
        `Привязка «${cue.id}» требует вернуться к уже пройденному действию.`,
        cue.id,
      ));
    }

    furthestAction = Math.max(furthestAction, cue.actionIndex);
  }

  return { status: issues.length === 0 ? 'valid' : 'invalid', issues };
}

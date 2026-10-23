import type { ChatStep } from '../../shared/chatContracts.ts';

export interface StepRow extends ChatStep {
  rowKey: string;
  res?: ChatStep;
  secs?: number;
  times?: number;
}

const stepKeys = new WeakMap<ChatStep, string>();
let nextKey = 0;

/**
 * Вызов сохраняет ключ при досылке подробностей, а шаг без id — при перестановке строк.
 * Ключ проекции размышления переносится вместе с заранее рассчитанной длительностью.
 */
export function chatStepKey(step: ChatStep): string {
  if (typeof step.rowKey === 'string') {
    return step.rowKey;
  }
  if (step.k === 'tool' && step.id) {
    return `tool-${step.id}`;
  }

  let key = stepKeys.get(step);

  if (!key) {
    key = `step-${++nextKey}`;
    stepKeys.set(step, key);
  }

  return key;
}

/**
 * Результаты, обновления вызова и соседние повторы сворачиваются в порядке прихода.
 * Длительность размышления считается здесь, до переноса между участками и группировки.
 */
export function foldChatSteps(
  steps: ChatStep[],
  displayed = new Set<string | undefined>(),
): StepRow[] {
  const out: StepRow[] = [];
  const byId = new Map<string, StepRow>();

  for (const step of steps) {
    if (step.k === 'text' && step.id && displayed.has(step.id)) {
      continue;
    }

    const known = step.id ? byId.get(step.id) : undefined;

    if (step.k === 'res' && known) {
      known.res = step;

      continue;
    }
    if (step.k === 'tool' && known) {
      Object.assign(known, step);

      continue;
    }

    const previous = out.at(-1);

    if (step.k === 'note' && previous?.k === 'note'
      && previous.text === step.text && previous.parent === step.parent) {
      previous.times = (previous.times || 1) + 1;

      continue;
    }

    const row: StepRow = { ...step, rowKey: chatStepKey(step) };

    if (step.k === 'tool' && step.id) {
      byId.set(step.id, row);
    }

    out.push(row);
  }

  for (let index = 0; index < out.length; index += 1) {
    const row = out[index]!;
    const previous = out[index - 1]?.at;

    if (row.k === 'think' && row.secs === undefined) {
      row.secs = row.at && previous && row.at > previous
        ? Math.round((row.at - previous) / 1000)
        : 0;
    }
  }

  return out;
}

/**
 * Дети идут сразу за своим вызовом; внутри каждого блока сохраняется порядок прихода.
 * Без видимого родителя строка остаётся на месте, а защита от циклов не даёт потерять шаги.
 */
export function nestChatStepRows(rows: StepRow[]): StepRow[] {
  const tools = new Map(rows.filter((row) => row.k === 'tool' && row.id)
    .map((row) => [row.id, row]));
  const children = new Map<StepRow, StepRow[]>();
  const roots: StepRow[] = [];

  for (const row of rows) {
    const parent = row.parent ? tools.get(row.parent) : undefined;

    if (!parent || parent === row) {
      roots.push(row);

      continue;
    }

    const siblings = children.get(parent) || [];

    siblings.push(row);
    children.set(parent, siblings);
  }

  const out: StepRow[] = [];
  const visited = new Set<StepRow>();
  /**
   * Обход добавляет весь блок потомков до следующей корневой строки.
   * Посещённый узел повторно не раскрывается даже при повреждённой связи parent.
   */
  const append = (row: StepRow) => {
    if (visited.has(row)) {
      return;
    }

    visited.add(row);
    out.push(row);

    for (const child of children.get(row) || []) {
      append(child);
    }
  };

  for (const row of roots) {
    append(row);
  }
  for (const row of rows) {
    append(row);
  }

  return out;
}

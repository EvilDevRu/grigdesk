/// <reference path="./monacoDiffInternals.d.ts" />

import { MyersDiffAlgorithm } from
  'monaco-editor/editor/common/diff/defaultLinesDiffComputer/algorithms/myersDiffAlgorithm.js';
import { DateTimeout } from
  'monaco-editor/editor/common/diff/defaultLinesDiffComputer/algorithms/diffAlgorithm.js';

export type SequenceChange = {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
};

/**
 * Изолирует внутренний алгоритм установленного Monaco 0.56 от остального продукта.
 * Общий словарь исключает коллизии хешей; приблизительный ответ по таймауту не принимается.
 */
export function compareSequences(left: string[], right: string[], timeout: DateTimeout): SequenceChange[] {
  const dictionary = new Map<string, number>();
  const sequence = (values: string[]) => {
    const ids = values.map((value) => {
      if (!dictionary.has(value)) {
        dictionary.set(value, dictionary.size);
      }

      return dictionary.get(value)!;
    });

    return { length: ids.length, getElement: (index: number) => ids[index]! };
  };
  const result = new MyersDiffAlgorithm().compute(sequence(left), sequence(right), timeout);

  if (result.hitTimeout || !timeout.isValid()) {
    throw new Error('diff_timeout');
  }

  return result.diffs.map((diff) => ({
    oldStart: diff.seq1Range.start,
    oldEnd: diff.seq1Range.endExclusive,
    newStart: diff.seq2Range.start,
    newEnd: diff.seq2Range.endExclusive,
  }));
}

export { DateTimeout };

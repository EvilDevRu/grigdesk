declare module 'monaco-editor/editor/common/diff/defaultLinesDiffComputer/algorithms/myersDiffAlgorithm.js' {
  export class MyersDiffAlgorithm {
    compute(
      left: { length: number; getElement(index: number): number },
      right: { length: number; getElement(index: number): number },
      timeout: { isValid(): boolean },
    ): {
      hitTimeout: boolean;
      diffs: {
        seq1Range: { start: number; endExclusive: number };
        seq2Range: { start: number; endExclusive: number };
      }[];
    };
  }
}

declare module 'monaco-editor/editor/common/diff/defaultLinesDiffComputer/algorithms/diffAlgorithm.js' {
  export class DateTimeout {
    constructor(milliseconds: number);
    isValid(): boolean;
  }
}

<template>
  <div class="code-diff-view" :class="{ paired: sideBySide }">
    <div ref="leftHost" class="diff-pane" v-show="sideBySide"></div>
    <div ref="rightHost" class="diff-pane"></div>
    <UiInlineMessage v-if="failure" tone="danger" class="diff-compute-error">
      {{ t('core.codeDiffComputeFailed') }}
      <UiButton variant="ghost" @click="compute">{{ t('core.codeDiffRetry') }}</UiButton>
    </UiInlineMessage>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { monaco, langOf, READONLY_OPTS } from '../../shared/monaco';
import { UiButton, UiInlineMessage, t } from '../../ui';
import { hiddenDiffLines } from '../../features/code/codeDiffModel';
import type {
  DiffHunk,
  DiffPreferences,
  DiffResult,
  DiffSide,
  SourceRange,
} from '../../features/code/codeDiffModel';
import type { DiffWorkerResponse } from '../../features/code/codeDiffWorker';

const props = defineProps<{
  comparison: {
    path: string;
    oldContent: string;
    newContent: string;
  } | null;
  sideBySide: boolean;
  wrap: boolean;
  preferences: DiffPreferences;
}>();
const emit = defineEmits<{
  computed: [hunks: DiffHunk[]];
  position: [side: DiffSide, line: number];
}>();

type FoldingEditor = monaco.editor.IStandaloneCodeEditor & {
  setHiddenAreas(ranges: readonly SourceRange[], source?: unknown): void;
};

const leftHost = ref<HTMLElement | null>(null);
const rightHost = ref<HTMLElement | null>(null);
const failure = ref(false);
let worker: Worker | null = null;
let generation = 0;
let result: DiffResult | null = null;
let left: monaco.editor.IStandaloneCodeEditor | null = null;
let right: monaco.editor.IStandaloneCodeEditor | null = null;
let models: monaco.editor.ITextModel[] = [];
let collections: monaco.editor.IEditorDecorationsCollection[] = [];
let disposables: { dispose(): void }[] = [];
let leftZones: string[] = [];
let rightZones: string[] = [];
const hiddenRegions = new Map<monaco.editor.IStandaloneCodeEditor, SourceRange[]>();
let activeSide: DiffSide = 'new';
let scrolling = false;
let rendering = false;
let renderQueued = false;
let destroyed = false;

/**
 * Освобождает только ресурсы этого сравнения, не затрагивая обычный просмотр файла.
 * Поколение меняется раньше освобождения, поэтому поздний ответ Worker безопасен.
 */
function clear() {
  generation += 1;
  result = null;
  emit('computed', []);

  for (const disposable of disposables) {
    disposable.dispose();
  }

  disposables = [];
  collections.forEach((collection) => collection.clear());
  collections = [];
  left?.dispose();
  right?.dispose();
  left = null;
  right = null;
  models.forEach((model) => model.dispose());
  models = [];
  leftZones = [];
  rightZones = [];
  hiddenRegions.clear();
}

/**
 * Запускает точный diff с отдельным поколением для текста и параметров подсветки.
 * При повторе ошибки прежние блоки не выдаются за актуальные.
 */
function compute() {
  generation += 1;
  result = null;
  failure.value = false;
  emit('computed', []);

  if (!props.comparison || !worker) {
    return;
  }

  worker.postMessage({
    generation,
    oldContent: props.comparison.oldContent,
    newContent: props.comparison.newContent,
    preferences: {
      detail: props.preferences.detail,
      whitespace: props.preferences.whitespace,
    },
  });
}

/**
 * Переводит строку единой колонки в точную исходную сторону.
 * Удалённые строки сохраняют old-координаты даже рядом со вставками.
 */
function rawLine(side: DiffSide, line: number, paired = props.sideBySide): { side: DiffSide; line: number } {
  if (paired || !result) {
    return { side, line };
  }

  const mapped = result.mapping[line - 1];

  return mapped?.kind === 'old'
    ? { side: 'old', line: mapped.oldLine || 1 }
    : { side: 'new', line: mapped?.newLine || 1 };
}

/**
 * Прокручивает по соответствующему исходному якорю, независимо от выравнивания зон.
 * Защита обратного вызова предотвращает зацикливание двух редакторов.
 */
function synchronize(source: DiffSide) {
  if (scrolling || rendering || !props.sideBySide || !props.preferences.sync || !left || !right) {
    return;
  }

  const from = source === 'old' ? left : right;
  const to = source === 'old' ? right : left;
  const top = from.getScrollTop();

  scrolling = true;

  try {
    if (props.preferences.align || !result) {
      to.setScrollTop(top);
    } else {
      const visible = from.getVisibleRanges?.()[0]?.startLineNumber || Math.floor(top / 20) + 1;
      let target = visible;

      for (const hunk of result.hunks) {
        const start = source === 'old' ? hunk.oldStart : hunk.newStart;
        const end = source === 'old' ? hunk.oldEnd : hunk.newEnd;
        const otherStart = source === 'old' ? hunk.newStart : hunk.oldStart;
        const otherEnd = source === 'old' ? hunk.newEnd : hunk.oldEnd;

        if (visible >= start) {
          target = visible < end
            ? otherStart + Math.min(visible - start, Math.max(0, otherEnd - otherStart - 1))
            : visible + otherEnd - end;
        }
      }

      to.setScrollTop(to.getTopForLineNumber(Math.max(1, target)) + top - from.getTopForLineNumber(visible));
    }
  } finally {
    scrolling = false;
  }
}

/**
 * Создаёт только публичные read-only редакторы; внутренний DiffEditor здесь не нужен.
 * Оба редактора подписываются на собственные курсор и scroll и освобождаются вместе с моделями.
 */
function createEditors() {
  if (!props.comparison || !leftHost.value || !rightHost.value) {
    return;
  }

  const options = {
    ...READONLY_OPTS,
    fontSize: 13,
    lineHeight: 20,
    padding: { top: 8, bottom: 8 },
    overviewRulerLanes: 2,
    renderOverviewRuler: true,
    wordWrap: props.wrap ? 'on' as const : 'off' as const,
    renderWhitespace: props.preferences.renderWhitespace ? 'all' as const : 'none' as const,
  };

  if (props.sideBySide) {
    left = monaco.editor.create(leftHost.value, options);
  }

  right = monaco.editor.create(rightHost.value, options);

  for (const [side, editor] of [['old', left], ['new', right]] as const) {
    if (!editor) {
      continue;
    }

    disposables.push(editor.onDidScrollChange(() => synchronize(side)));
    disposables.push(editor.onDidChangeCursorPosition((event) => {
      const position = rawLine(side, event.position.lineNumber);

      activeSide = position.side;
      emit('position', position.side, position.line);
    }));

    const onLayout = editor.onDidLayoutChange?.(scheduleRender);
    const onSize = editor.onDidContentSizeChange?.(scheduleRender);

    if (onLayout) {
      disposables.push(onLayout);
    }
    if (onSize) {
      disposables.push(onSize);
    }
  }

  setModels();
}

/**
 * Событие размера приходит также из renderText самого Monaco. Изменение зон внутри
 * этого вызова разрушает снимок whitespace для render; обновляем после текущего стека.
 */
function scheduleRender() {
  if (rendering || renderQueued || destroyed) {
    return;
  }

  renderQueued = true;
  queueMicrotask(() => {
    renderQueued = false;

    if (!destroyed) {
      render();
    }
  });
}

/**
 * Сырые модели используются в парном виде, составная модель — в одной колонке.
 * Перестановка модели выполняется до dispose прежней, чтобы Monaco не держал мёртвую ссылку.
 */
function setModels() {
  if (!props.comparison || !right) {
    return;
  }

  const language = langOf(props.comparison.path);
  const previous = models;

  if (props.sideBySide && left) {
    models = [
      monaco.editor.createModel(props.comparison.oldContent, language),
      monaco.editor.createModel(props.comparison.newContent, language),
    ];
    left.setModel(models[0]!);
    right.setModel(models[1]!);
  } else {
    models = [monaco.editor.createModel(result?.unified ?? props.comparison.newContent, language)];
    right.setModel(models[0]!);
  }

  previous.forEach((model) => model.dispose());
}

/**
 * Выравнивает соответствующие блоки пустыми зонами, не меняя текст моделей.
 * Высота берётся из раскладки Monaco, поэтому перенос строк учитывается при resize.
 */
function alignEditors() {
  if (rendering || !left || !right) {
    return;
  }

  rendering = true;

  try {
    for (const [editor, zones] of [[left, leftZones], [right, rightZones]] as const) {
      editor.changeViewZones((accessor) => zones.forEach((id) => accessor.removeZone(id)));
    }

    leftZones = [];
    rightZones = [];

    if (!props.preferences.align || !props.sideBySide || !result) {
      return;
    }

    for (const hunk of result.hunks) {
      const leftHeight = left.getTopForLineNumber(hunk.oldEnd) - left.getTopForLineNumber(hunk.oldStart);
      const rightHeight = right.getTopForLineNumber(hunk.newEnd) - right.getTopForLineNumber(hunk.newStart);
      const difference = rightHeight - leftHeight;

      if (!difference) {
        continue;
      }

      const editor = difference > 0 ? left : right;
      const ids = difference > 0 ? leftZones : rightZones;
      const node = document.createElement('div');

      node.className = 'code-diff-connector';
      editor.changeViewZones((accessor) => {
        ids.push(accessor.addZone({
          afterLineNumber: Math.max(0, (difference > 0 ? hunk.oldEnd : hunk.newEnd) - 1),
          heightInPx: Math.abs(difference),
          domNode: node,
        }));
      });
    }
  } finally {
    rendering = false;
  }
}

/**
 * Показывает диапазоны и обзорные метки поверх неизменённых сырых моделей.
 * Детализация влияет только на decorations, сворачивание — только на hidden areas.
 */
function render() {
  if (!result || !right || rendering) {
    return;
  }

  collections.forEach((collection) => collection.clear());
  collections = [];

  for (const [side, editor] of [['old', left], ['new', right]] as const) {
    if (!editor) {
      continue;
    }

    const decorations: monaco.editor.IModelDeltaDecoration[] = [];
    const changes: { start: number; end: number }[] = [];

    for (const hunk of result.hunks) {
      const start = side === 'old' ? hunk.oldStart : hunk.newStart;
      const end = side === 'old' ? hunk.oldEnd : hunk.newEnd;

      changes.push({ start, end });

      if (props.sideBySide) {
        if (end > start) {
          decorations.push(lineDecoration(start, end - 1, side));
        }

        const ranges = side === 'old' ? hunk.oldRanges : hunk.newRanges;

        decorations.push(...ranges.map((range) => textDecoration(range, side)));
      }
    }

    if (!props.sideBySide) {
      changes.length = 0;

      for (const [index, mapping] of result.mapping.entries()) {
        if (mapping.kind !== 'context') {
          decorations.push(lineDecoration(index + 1, index + 1, mapping.kind));
          changes.push({ start: index + 1, end: index + 2 });
        }
      }

      for (const hunk of result.hunks) {
        for (const rawSide of ['old', 'new'] as const) {
          const ranges = rawSide === 'old' ? hunk.oldRanges : hunk.newRanges;

          for (const range of ranges) {
            const start = displayLine(rawSide, range.startLineNumber);
            const end = displayLine(rawSide, range.endLineNumber);

            decorations.push(textDecoration({
              ...range,
              startLineNumber: start,
              endLineNumber: end,
            }, rawSide));
          }
        }
      }

      editor.updateOptions({
        lineNumbers: (line) => {
          const mapping = result?.mapping[line - 1];

          return `${mapping?.oldLine ?? ''} │ ${mapping?.newLine ?? ''}`;
        },
        lineNumbersMinChars: 9,
      });
    }

    collections.push(editor.createDecorationsCollection(decorations));
    setHiddenAreas(editor, hiddenDiffLines(editor.getModel()!.getLineCount(), changes, props.preferences));
  }

  alignEditors();
}

function lineDecoration(start: number, end: number, side: DiffSide): monaco.editor.IModelDeltaDecoration {
  return {
    range: {
      startLineNumber: start,
      endLineNumber: end,
      startColumn: 1,
      endColumn: 1,
    },
    options: {
      isWholeLine: true,
      className: `code-diff-${side}-line`,
      overviewRuler: { color: side === 'old' ? '#f0564caa' : '#3fb950aa', position: 2 },
    },
  };
}

function textDecoration(range: SourceRange, side: DiffSide): monaco.editor.IModelDeltaDecoration {
  return { range, options: { inlineClassName: `code-diff-${side}-text` } };
}

/**
 * Узкая граница метода CodeEditorWidget в установленном Monaco 0.56.
 * Метод доступен в runtime, но не включён в monaco.d.ts; модели и view model не вскрываются.
 */
function setHiddenAreas(editor: monaco.editor.IStandaloneCodeEditor, ranges: SourceRange[]) {
  hiddenRegions.set(editor, ranges);
  (editor as FoldingEditor).setHiddenAreas(ranges);
}

/**
 * Находит строку единой модели по номеру нужной исходной стороны.
 * В парном виде модель уже имеет исходные номера и преобразование не требуется.
 */
function displayLine(side: DiffSide, line: number): number {
  if (props.sideBySide) {
    return line;
  }

  const index = result?.mapping.findIndex((entry) => (
    (side === 'old' ? entry.oldLine : entry.newLine) === line
  ));

  return index !== undefined && index >= 0 ? index + 1 : 1;
}

/**
 * Раскрывает и показывает исходную строку на нужной стороне, включая единую колонку.
 * Навигация не подменяет исходные координаты отображаемым номером строки.
 */
function reveal(side: DiffSide, line: number) {
  const editor = props.sideBySide && side === 'old' ? left : right;
  const displayed = displayLine(side, line);

  if (editor) {
    const hidden = hiddenRegions.get(editor) || [];

    setHiddenAreas(editor, hidden.filter((range) => (
      displayed < range.startLineNumber || displayed > range.endLineNumber
    )));
  }

  editor?.setPosition({ lineNumber: displayed, column: 1 });
  editor?.revealLineInCenter(displayed);
  activeSide = side;
}

/**
 * Возвращает выделение исходных строк, не текст составной колонки.
 * Смешанное выделение сторон разбивается на однородную часть активной стороны.
 */
function getSelection(paired = props.sideBySide) {
  const editor = paired && activeSide === 'old' ? left : right;
  const selection = editor?.getSelection();
  const position = editor?.getPosition();
  const start = selection?.startLineNumber || position?.lineNumber || 1;
  const end = selection?.endLineNumber || start;
  const first = rawLine(activeSide, start, paired);
  const last = rawLine(activeSide, end, paired);
  const content = first.side === 'old' ? props.comparison?.oldContent : props.comparison?.newContent;
  const lastLine = last.side === first.side ? last.line : first.line;

  return {
    side: first.side,
    from: first.line,
    to: lastLine,
    content: content?.split('\n').slice(first.line - 1, lastLine).join('\n') || '',
  };
}

/**
 * Выделяет исходный диапазон текущего блока для замечания или частичного индекса.
 * Составная колонка получает преобразованные координаты без изменения содержимого.
 */
function selectLines(side: DiffSide, from: number, to: number) {
  reveal(side, from);

  const editor = props.sideBySide && side === 'old' ? left : right;
  const end = displayLine(side, to);

  editor?.setSelection({
    startLineNumber: displayLine(side, from),
    endLineNumber: end,
    startColumn: 1,
    endColumn: editor.getModel()?.getLineMaxColumn(end) || 1,
  });
}

function layout() {
  left?.layout();
  right?.layout();
  alignEditors();
}

watch(() => props.comparison, async () => {
  clear();
  await nextTick();

  if (!destroyed) {
    createEditors();
    compute();
  }
});
watch(() => [props.preferences.detail, props.preferences.whitespace], compute);
watch(() => [props.preferences.collapse, props.preferences.context, props.preferences.align], render);
watch(() => [props.wrap, props.preferences.renderWhitespace], () => {
  for (const editor of [left, right]) {
    editor?.updateOptions({
      wordWrap: props.wrap ? 'on' : 'off',
      renderWhitespace: props.preferences.renderWhitespace ? 'all' : 'none',
    });
  }

  alignEditors();
});
watch(() => props.sideBySide, (_paired, previous) => {
  const selected = getSelection(previous);
  const scroll = (activeSide === 'old' && previous ? left : right)?.getScrollTop() || 0;
  const current = result;

  clear();
  result = current;
  createEditors();
  render();

  if (result) {
    emit('computed', result.hunks);
    reveal(selected.side, selected.from);

    const editor = props.sideBySide && selected.side === 'old' ? left : right;

    editor?.setSelection({
      startLineNumber: displayLine(selected.side, selected.from),
      endLineNumber: displayLine(selected.side, selected.to),
      startColumn: 1,
      endColumn: 1,
    });
    editor?.setScrollTop(scroll);
  } else {
    compute();
  }
});

onMounted(() => {
  worker = new Worker(new URL('../../features/code/codeDiffWorker.ts', import.meta.url), { type: 'module' });
  worker.addEventListener('message', (event: MessageEvent<DiffWorkerResponse>) => {
    if (destroyed || event.data.generation !== generation) {
      return;
    }

    failure.value = Boolean(event.data.error);
    result = event.data.result || null;

    if (result) {
      if (!props.sideBySide) {
        setModels();
      }

      render();
      emit('computed', result.hunks);
    }
  });
  worker.addEventListener('error', () => {
    failure.value = true;
    emit('computed', []);
  });
  createEditors();
  compute();
});
onBeforeUnmount(() => {
  destroyed = true;
  worker?.terminate();
  worker = null;
  clear();
});

defineExpose({
  reveal,
  getSelection,
  selectLines,
  layout,
  clear,
});
</script>

<style scoped>
.code-diff-view { display: grid; grid-template-columns: minmax(0, 1fr); min-height: 0; }
.code-diff-view.paired { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.diff-pane { min-width: 0; min-height: 0; overflow: hidden; }
.diff-compute-error { position: absolute; inset: 8px 8px auto; z-index: 2; }
:global(.code-diff-old-line) { background: #f0564c26; }
:global(.code-diff-new-line) { background: #3fb95026; }
:global(.code-diff-old-text) { background: #f0564c45; }
:global(.code-diff-new-text) { background: #3fb95045; }
:global(.code-diff-connector) { background: repeating-linear-gradient(135deg, #1c222c66 0 2px, transparent 2px 6px); }
</style>

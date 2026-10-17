<template>
  <div ref="reviewHost" class="patch-review" data-view="patch-review">
    <p v-if="truncated" class="patch-limit" role="status">
      Показаны первые {{ orderedFiles.length }} файлов или первые 2 МБ патча;
      остальное открой по отдельному файлу.
    </p>
    <p v-if="!orderedFiles.length" class="patch-empty">В этой группе нет строк для обзора.</p>

    <article v-for="(file, fileIndex) in orderedFiles" :key="`${file.path}:${fileIndex}`"
             class="patch-file" :data-file="file.path">
      <UiPressable class="patch-file-head" data-context="code-patch-file"
                   :data-path="file.path" v-tooltip="file.path"
                   :aria-label="patchFileLabel(file.path, file.status, file.oldPath, file.add, file.del)"
                   @click="emit('open', file.path, 0, 'new')">
        <span class="patch-status" :class="file.status">{{ file.status }}</span>
        <span class="patch-path mono">{{ file.path }}</span>
        <span v-if="file.oldPath" class="patch-old mono">← {{ file.oldPath }}</span>
        <span class="grow"></span>
        <span v-if="file.add || file.del" class="patch-count mono">
          <i v-if="file.add" class="add">+{{ file.add }}</i>
          <i v-if="file.del" class="del">−{{ file.del }}</i>
        </span>
      </UiPressable>

      <p v-if="file.binary" class="patch-special">Бинарные файлы различаются.</p>
      <p v-else-if="!file.hunks.length" class="patch-special">
        Строки файла не попали в ограниченный фрагмент патча.
      </p>
      <section v-for="(hunk, hunkIndex) in file.hunks"
               :key="`${file.path}:hunk:${hunkIndex}`" class="patch-hunk">
        <div class="patch-hunk-head mono">{{ hunk.header }}</div>
        <UiPressable v-for="(line, lineIndex) in hunk.lines"
                     :key="`${file.path}:${hunkIndex}:${lineIndex}`"
                     class="patch-line mono" :class="line.kind"
                     data-context="code-patch-line" data-patch-line
                     :data-line="line.newLine || line.oldLine || 0"
                     :tabindex="(activeLine || firstPatchLineKey)
                       === lineKey(fileIndex, hunkIndex, lineIndex) ? 0 : -1"
                     @focus="activeLine = lineKey(fileIndex, hunkIndex, lineIndex)"
                     @keydown.up.prevent="moveLineFocus($event, -1)"
                     @keydown.down.prevent="moveLineFocus($event, 1)"
                     @click="openLine(file.path, line.oldLine, line.newLine)">
          <span class="patch-number old">{{ line.oldLine ?? '' }}</span>
          <span class="patch-number new">{{ line.newLine ?? '' }}</span>
          <span class="patch-marker" aria-hidden="true">{{ marker(line.kind) }}</span>
          <code v-if="coloredLine(fileIndex, hunkIndex, lineIndex)"
                class="patch-code" v-html="coloredLine(fileIndex, hunkIndex, lineIndex)"></code>
          <code v-else class="patch-code">{{ line.text }}</code>
        </UiPressable>
      </section>
    </article>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { CodeGitEntry } from '../../../../shared/plugins/code/codeContracts';
import { monaco, langOf } from '../../shared/monaco';
import { UiPressable, vTooltip } from '../../ui';
import { parseUnifiedDiff } from '../../shared/patch';
import type { UnifiedDiffLineKind } from '../../shared/patch';

const props = defineProps<{
  patch: string;
  truncated: boolean;
  files: readonly CodeGitEntry[];
}>();
const emit = defineEmits<{
  open: [path: string, line: number, side: 'old' | 'new'];
}>();

const parsed = computed(() => parseUnifiedDiff(props.patch));
const reviewHost = ref<HTMLElement | null>(null);
const activeLine = ref('');
const orderedFiles = computed(() => {
  const byPath = new Map(parsed.value.map((file) => [file.path, file]));
  const known = props.files.flatMap((entry) => {
    const file = byPath.get(entry.path);

    if (!file) {
      return [];
    }

    byPath.delete(entry.path);

    return [{
      ...file,
      status: entry.status,
      oldPath: entry.oldPath || file.oldPath,
      binary: entry.binary || file.binary,
      add: entry.add,
      del: entry.del,
    }];
  });

  return [
    ...known,
    ...[...byPath.values()].map((file) => ({
      ...file,
      add: 0,
      del: 0,
    })),
  ];
});
const firstPatchLineKey = computed(() => {
  for (let fileIndex = 0; fileIndex < orderedFiles.value.length; fileIndex += 1) {
    const file = orderedFiles.value[fileIndex];

    for (let hunkIndex = 0; hunkIndex < (file?.hunks.length || 0); hunkIndex += 1) {
      if (file?.hunks[hunkIndex]?.lines.length) {
        return lineKey(fileIndex, hunkIndex, 0);
      }
    }
  }

  return '';
});
const colored = ref(new Map<string, string>());
let colorRequest = 0;

function lineKey(file: number, hunk: number, line: number): string {
  return `${file}:${hunk}:${line}`;
}

function coloredLine(file: number, hunk: number, line: number): string {
  return colored.value.get(lineKey(file, hunk, line)) || '';
}

/**
 * Доступное имя сохраняет весь видимый контекст и добавляет действие кнопки.
 * Статус и счётчики не теряются после замены видимого текста через aria-label.
 */
function patchFileLabel(path: string, status: string, oldPath: string | undefined, add: number, del: number) {
  const statusLabels: Record<string, string> = {
    A: 'добавлен',
    M: 'изменён',
    D: 'удалён',
    R: 'переименован',
    U: 'конфликт',
  };
  const details = [
    statusLabels[status] || status,
    oldPath ? `прежний путь ${oldPath}` : '',
    add ? `добавлено ${add}` : '',
    del ? `удалено ${del}` : '',
  ].filter(Boolean);

  return `Открыть diff файла ${path}; ${details.join('; ')}`;
}

/**
 * Отделяет визуальный знак строки от её текста. Минус типографский, чтобы не
 * смешиваться с настоящим первым символом исходника внутри соседнего code.
 */
function marker(kind: UnifiedDiffLineKind): string {
  if (kind === 'add') {
    return '+';
  }
  if (kind === 'del') {
    return '−';
  }
  if (kind === 'meta') {
    return '\\';
  }

  return ' ';
}

function openLine(path: string, oldLine: number | null, newLine: number | null) {
  emit('open', path, newLine || oldLine || 0, newLine ? 'new' : 'old');
}

/**
 * Стрелки переводят единственную tab-остановку между строками большого патча.
 * Выход за начало или конец оставляет фокус на текущей строке.
 */
function moveLineFocus(event: KeyboardEvent, direction: -1 | 1) {
  const current = event.currentTarget as HTMLElement;
  const lines = [...(reviewHost.value?.querySelectorAll<HTMLElement>('[data-patch-line]') || [])];
  const index = lines.indexOf(current);
  const target = lines[index + direction];

  target?.focus();
}

/** Monaco возвращает уже экранированный HTML; отказ подсветки оставляет обычный текст. */
watch(orderedFiles, async (files) => {
  const own = ++colorRequest;
  const next = new Map<string, string>();

  activeLine.value = '';

  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const file = files[fileIndex];

    if (!file || file.binary) {
      continue;
    }

    for (let hunkIndex = 0; hunkIndex < file.hunks.length; hunkIndex += 1) {
      const hunk = file.hunks[hunkIndex];

      if (!hunk) {
        continue;
      }

      for (let lineIndex = 0; lineIndex < hunk.lines.length; lineIndex += 1) {
        const line = hunk.lines[lineIndex];

        if (!line || line.kind === 'meta') {
          continue;
        }

        try {
          const html = await monaco.editor.colorize(line.text, langOf(file.path), {});

          if (own !== colorRequest) {
            return;
          }

          next.set(lineKey(fileIndex, hunkIndex, lineIndex), html);
        } catch {
          // Неизвестный язык или отказ tokenizer не мешает читать исходный текст.
        }
      }
    }
  }

  if (own === colorRequest) {
    colored.value = next;
  }
}, { immediate: true });

onBeforeUnmount(() => {
  colorRequest += 1;
});
</script>

<style scoped>
/* Как Monaco в том же теле редактора: absolute + inset, иначе корень растёт по содержимому
   и overflow не включается — обзор обрезался снизу дока без прокрутки. */
.patch-review { position: absolute; inset: 0; overflow: auto; padding: 10px 0 24px; }
.patch-limit, .patch-empty, .patch-special { margin: 0; padding: 9px 14px; color: var(--ink-mid); }
.patch-limit { color: var(--warn); border-bottom: 1px solid var(--line); }
.patch-file { border-bottom: 1px solid var(--line); }
.patch-file-head { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 12px;
  position: sticky; top: 0; z-index: 1; background: var(--surface); text-align: left; }
.patch-status { flex: none; width: 18px; height: 18px; border-radius: 5px;
  font-weight: 700; line-height: 18px; text-align: center; }
.patch-status.A, .patch-count .add { color: var(--good); }
.patch-status.A { background: color-mix(in srgb, var(--good) 12%, transparent); }
.patch-status.D, .patch-status.U, .patch-count .del { color: var(--bad); }
.patch-status.D, .patch-status.U { background: color-mix(in srgb, var(--bad) 12%, transparent); }
.patch-status.M, .patch-status.R { color: var(--warn);
  background: color-mix(in srgb, var(--warn) 12%, transparent); }
.patch-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.patch-old { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--ink-mid); }
.patch-count { display: flex; gap: 6px; font-style: normal; }
.patch-count i { font-style: normal; }
.patch-hunk { min-width: max-content; }
.patch-hunk-head { padding: 4px 12px; color: var(--accent); background: var(--accent-soft); }
/* Строка — кнопка, а кнопка сжимается по содержимому даже как grid: без явной ширины фон
   «+/−» обрывался на самой длинной строке. Хунк не уже самой длинной строки (max-content),
   так что длинный код прокручивается по горизонтали вместе с номерами. */
.patch-line { display: grid; grid-template-columns: 48px 48px 18px minmax(360px, 1fr);
  width: 100%; min-height: 20px; line-height: 20px; cursor: pointer; text-align: left; }
.patch-line.add { background: color-mix(in srgb, var(--good) 14%, transparent); }
.patch-line.del { background: color-mix(in srgb, var(--bad) 14%, transparent); }
.patch-line.meta { color: var(--ink-mid); font-style: italic; }
.patch-number { padding: 0 7px; text-align: right; color: var(--ink-mid); user-select: none;
  border-right: 1px solid color-mix(in srgb, var(--line) 70%, transparent); }
.patch-marker { text-align: center; user-select: none; }
.patch-code { padding-right: 14px; white-space: pre; font: inherit; color: inherit; }
</style>

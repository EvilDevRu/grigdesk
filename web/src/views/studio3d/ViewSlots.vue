<template>
  <div class="studio-view-slots">
    <div v-for="(view, index) in views" :key="view.id" class="studio-view-slot"
      @dragover.prevent @drop.prevent="drop(view.id, $event)" @paste="paste(view.id, $event)">
      <h4>{{ view.label }}</h4>
      <div class="studio-view-image">
        <img v-if="urls[view.id]" :src="urls[view.id]" :alt="view.label" />
        <UiPressable v-for="(line, lineIndex) in guides" :key="line.label" class="studio-view-guide"
          data-context="studio-guide" role="slider" :aria-label="line.label"
          :aria-valuenow="line.at" :aria-valuemin="0" :aria-valuemax="100"
          :style="{ top: `${line.at}%` }" @pointerdown="guideStart(lineIndex, $event)"
          @pointermove="guideMove($event)" @pointerup="guideEnd" @pointercancel="guideEnd"
          @keydown="guideKey(lineIndex, $event)">
          {{ line.label }}
        </UiPressable>
      </div>
      <UiFilePicker :key="urls[view.id] ?? view.id" accept=".png,.jpg,.jpeg,.webp"
        :label="model[view.id]?.name ?? 'Выбрать картинку'"
        @change="choose(view.id, $event[0])" />
      <div class="studio-view-actions">
        <UiButton variant="ghost" :disabled="!model[view.id]" @click="clear(view.id)">Очистить</UiButton>
        <UiButton variant="ghost" @click="swap(view.id, views[(index + 1) % views.length]!.id)">Поменять с соседним</UiButton>
      </div>
    </div>
    <UiInlineMessage v-if="validation" class="studio-view-message" tone="warning">
      {{ validation }}
    </UiInlineMessage>
    <UiInlineMessage v-if="error" class="studio-view-message" tone="danger">{{ error }}</UiInlineMessage>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from 'vue';
import { UiFilePicker, UiButton, UiPressable, UiInlineMessage } from '../../ui.ts';
import { readStudioImage } from '../../features/studio3d/studioImages.ts';
import { studioErrorMessage } from '../../features/studio3d/presentation.ts';

export type StudioViewId = 'front' | 'left' | 'back' | 'right';
export type StudioViewFiles = Record<StudioViewId, File | null>;

const model = defineModel<StudioViewFiles>({ required: true });
const views = [
  { id: 'front' as const, label: 'Спереди' }, { id: 'left' as const, label: 'Слева' },
  { id: 'back' as const, label: 'Сзади' }, { id: 'right' as const, label: 'Справа' },
];
const urls = ref<Partial<Record<StudioViewId, string>>>({});
const guides = ref([{ label: 'Макушка', at: 15 }, { label: 'Глаза', at: 30 },
  { label: 'Подбородок', at: 45 }]);
const error = ref('');
const generations = new Map<StudioViewId, number>();
let dragging: {
  index: number;
  top: number;
  height: number
} | null = null;
const validation = computed(() => !model.value.front
  || Object.values(model.value).filter(Boolean).length < 2
    ? 'Нужен вид спереди и хотя бы ещё один вид.' : '');

/**
 * Проверка вида предшествует object URL, bitmap освобождается сразу после проверки.
 * Поздний decode не заменяет новый файл в той же ячейке.
 */
async function choose(view: StudioViewId, input?: File): Promise<void> {
  if (!input) {
    return;
  }
  
  const generation = (generations.get(view) ?? 0) + 1;
  
  generations.set(view, generation);
  
  try {
    const { file, bitmap } = await readStudioImage(input);
    
    bitmap.close();
    
    if (generations.get(view) !== generation) {
      return;
    }
    
    model.value = { ...model.value, [view]: file };
    error.value = '';
  } catch (cause) {
    if (generations.get(view) === generation) {
      error.value = studioErrorMessage(cause);
    }
  }
}

/**
 * Drop и paste используют тот же ограниченный image decode, что выбор файла.
 * Неизображения не извлекаются в HTML и не открываются по внешней ссылке.
 */
function drop(view: StudioViewId, event: DragEvent): void {
  void choose(view, event.dataTransfer?.files[0]);
}

function paste(view: StudioViewId, event: ClipboardEvent): void {
  const file = [...(event.clipboardData?.items ?? [])].find((item) => item.kind === 'file')?.getAsFile();
  
  if (file) {
    event.preventDefault();
    void choose(view, file);
  }
}

/**
 * Очистка отменяет незавершённый decode этой ячейки и меняет новый объект модели.
 * Swap переставляет сами файлы, не повторно декодирует и не отправляет оплату.
 */
function clear(view: StudioViewId): void {
  generations.set(view, (generations.get(view) ?? 0) + 1);
  model.value = { ...model.value, [view]: null };
}

function swap(first: StudioViewId, second: StudioViewId): void {
  generations.set(first, (generations.get(first) ?? 0) + 1);
  generations.set(second, (generations.get(second) ?? 0) + 1);
  model.value = {
    ...model.value,
    [first]: model.value[second],
    [second]: model.value[first]
  };
}

/**
 * Общие линии меняют одну normalized высоту сразу во всех четырёх ячейках.
 * Native range внутри UiRange даёт pointer и клавиатурное управление.
 */
function moveGuide(index: number, at: number): void {
  const guide = guides.value[index];
  
  if (guide && Number.isFinite(at)) {
    guide.at = Math.max(0, Math.min(100, at));
  }
}

/**
 * Захваченный указатель движет линию по вертикали относительно самой картинки.
 * Общая normalized высота применяется к каждой ячейке без накопления listeners.
 */
function guideStart(index: number, event: PointerEvent): void {
  const target = event.currentTarget as HTMLElement;
  const bounds = target.parentElement!.getBoundingClientRect();
  
  dragging = {
    index,
    top: bounds.top,
    height: bounds.height
  };
  target.setPointerCapture(event.pointerId);
  event.preventDefault();
  guideMove(event);
}

/**
 * Линия следует за pointer только своего жеста, ограничена высотой картинки.
 * После pointer cancel тот же callback больше не меняет geometry.
 */
function guideMove(event: PointerEvent): void {
  if (dragging && dragging.height > 0) {
    moveGuide(dragging.index, Math.round((event.clientY - dragging.top) / dragging.height * 100));
  }
}

function guideEnd(): void {
  dragging = null;
}

/**
 * ArrowUp/Down дают точный шаг высоты, Shift и Home/End крупные изменения.
 * Клавиатура и мышь используют один shared guide state всех четырёх видов.
 */
function guideKey(index: number, event: KeyboardEvent): void {
  const line = guides.value[index];
  
  if (!line) {
    return;
  }
  
  const step = event.shiftKey ? 5 : 1;
  const values: Record<string, number> = {
    ArrowUp: line.at - step,
    ArrowDown: line.at + step,
    Home: 0,
    End: 100
  };
  
  if (values[event.key] === undefined) {
    return;
  }
  
  event.preventDefault();
  moveGuide(index, values[event.key]!);
}

watch(model, (files) => {
  for (const url of Object.values(urls.value)) if (url) {
    URL.revokeObjectURL(url);
  }
  
  urls.value = Object.fromEntries(views.filter((view) => files[view.id])
    .map((view) => [view.id, URL.createObjectURL(files[view.id]!)]));
}, { immediate: true });
onUnmounted(() => {
  for (const view of views) {
    generations.set(view.id, -1);
  }
  for (const url of Object.values(urls.value)) if (url) {
    URL.revokeObjectURL(url);
  }
});
</script>

<style scoped>
.studio-view-slots {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr));
  gap: 12px;
}

.studio-view-slot {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: var(--control-radius);
  background: var(--ground);
}

.studio-view-slot h4 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
}

.studio-view-image {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 190px;
  background: var(--surface);
}

.studio-view-image img {
  width: 100%;
  height: 190px;
  object-fit: contain;
}

.studio-view-guide {
  position: absolute;
  left: 0;
  right: 0;
}

.studio-view-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.studio-view-message {
  grid-column: 1 / -1;
}
</style>

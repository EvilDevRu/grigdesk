<template>
  <UiDialog :open="open" label="Разрезать лист на виды" @close="$emit('close')">
    <h3>Разрезать лист на виды</h3>
    <UiInlineMessage v-if="error" tone="danger">{{ error }}</UiInlineMessage>
    <img v-if="url" class="studio-sheet-source" :src="url" alt="Исходный лист видов" />
    <div class="studio-sheet-settings">
      <UiField label="Порог отличия от фона"><UiNumberField v-model="threshold" :min="0" :max="1020" /></UiField>
      <UiField label="Минимальный промежуток, %"><UiNumberField v-model="gapPercent" :min="0.1" :max="100" :step="0.1" /></UiField>
      <UiButton :disabled="!bitmap || busy" @click="split">Найти области</UiButton>
    </div>
    <div v-for="(region, index) in regions" :key="region.id" class="studio-sheet-region">
      <UiField :label="`Область ${index + 1}`">
        <UiSelect v-model="region.view">
          <option value="">Не использовать</option>
          <option v-for="view in views" :key="view.id" :value="view.id">{{ view.label }}</option>
        </UiSelect>
      </UiField>
      <UiField label="X"><UiNumberField v-model="region.x" :min="0" :max="(bitmap?.width ?? 1) - 1" /></UiField>
      <UiField label="Y"><UiNumberField v-model="region.y" :min="0" :max="(bitmap?.height ?? 1) - 1" /></UiField>
      <UiField label="Ширина"><UiNumberField v-model="region.width" :min="1" :max="bitmap?.width ?? 1" /></UiField>
      <UiField label="Высота"><UiNumberField v-model="region.height" :min="1" :max="bitmap?.height ?? 1" /></UiField>
      <UiButton variant="ghost" @click="regions.splice(index, 1)">Убрать область</UiButton>
    </div>
    <UiInlineMessage v-if="bitmap && !regions.length">Области не найдены. Добавьте прямоугольники вручную.</UiInlineMessage>
    <UiButton :disabled="!bitmap || regions.length >= 50" variant="ghost" @click="addRegion">Добавить область</UiButton>
    <template #footer>
      <UiButton variant="ghost" @click="$emit('close')">Отмена</UiButton>
      <UiButton tone="accent" :loading="busy" :disabled="!bitmap || !valid" @click="confirm">Подтвердить виды</UiButton>
    </template>
  </UiDialog>
</template>

<script setup lang="ts">
import { computed, ref, shallowRef, watch, onUnmounted } from 'vue';
import { UiDialog, UiInlineMessage, UiButton, UiField, UiNumberField, UiSelect } from '../../ui.ts';
import { readStudioImage, studioCanvasBlob } from '../../features/studio3d/studioImages.ts';
import { sheetSplit } from '../../features/studio3d/sheetSplit.ts';
import type { StudioViewFiles, StudioViewId } from './ViewSlots.vue';
import { studioErrorMessage } from '../../features/studio3d/presentation.ts';

const props = defineProps<{ open: boolean; file: File | null }>();
const emit = defineEmits<{ close: []; confirm: [files: Partial<StudioViewFiles>] }>();
const bitmap = shallowRef<ImageBitmap | null>(null);
const url = ref('');
const threshold = ref<number | null | ''>(24);
const gapPercent = ref<number | null | ''>(1);
const busy = ref(false);
const error = ref('');
const regions = ref<{
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  view: string
}[]>([]);
const views = [
  { id: 'front', label: 'Спереди' }, { id: 'left', label: 'Слева' },
  { id: 'back', label: 'Сзади' }, { id: 'right', label: 'Справа' },
];
let generation = 0;
const valid = computed(() => {
  const selected = regions.value.filter((region) => region.view);
  
  return selected.length >= 2 && selected.length <= 4 && selected.some((region) => region.view === 'front')
    && new Set(selected.map((region) => region.view)).size === selected.length
    && selected.every((region) => views.some((view) => view.id === region.view)
      && [region.x, region.y, region.width, region.height].every(Number.isFinite)
      && region.x >= 0 && region.y >= 0 && region.width >= 1 && region.height >= 1
      && region.x + region.width <= (bitmap.value?.width ?? 0)
      && region.y + region.height <= (bitmap.value?.height ?? 0));
});

/**
 * Raster и object URL принадлежат одному поколению диалога.
 * Close, замена файла и unmount освобождают native bitmap и все временные адреса.
 */
function release(): void {
  generation += 1;
  bitmap.value?.close();
  bitmap.value = null;
  
  if (url.value) {
    URL.revokeObjectURL(url.value);
  }
  
  url.value = '';
  regions.value = [];
  busy.value = false;
}

/**
 * Анализ использует только декодированные пиксели и линейный splitter с пределами.
 * Более 50 областей не обрезаются молча: человек получает ручной выбор прямоугольников.
 */
function split(): void {
  const source = bitmap.value;
  const canvas = document.createElement('canvas');
  
  if (!source) {
    return;
  }
  
  try {
    canvas.width = source.width;
    canvas.height = source.height;
    
    const context = canvas.getContext('2d');
    
    if (!context) {
      throw new Error('Canvas недоступен в этом браузере.');
    }
    
    context.drawImage(source, 0, 0);
    
    const rects = sheetSplit(context.getImageData(0, 0, source.width, source.height), {
      threshold: Number(threshold.value), minGap: Number(gapPercent.value) / 100,
    });
    
    canvas.width = 0;
    canvas.height = 0;
    
    if (rects.length > 50) {
      throw new Error('Найдено больше 50 областей. Задайте нужные виды вручную.');
    }
    
    regions.value = rects.map((rect, index) => ({
      ...rect,
      id: crypto.randomUUID(),
      view: views[index]?.id ?? ''
    }));
    error.value = '';
  } catch (cause) {
    error.value = studioErrorMessage(cause);
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

/**
 * Ручная область начинается целым листом и получает явное назначение человеком.
 * После редактирования валидность границ повторяется непосредственно перед crop.
 */
function addRegion(): void {
  if (!bitmap.value) {
    return;
  }
  
  regions.value.push({
    id: crypto.randomUUID(),
    x: 0,
    y: 0,
    width: bitmap.value.width,
    height: bitmap.value.height,
    view: ''
  });
}

/**
 * Crop фиксирует прямоугольники до первого await, без оплаты и серверного разрезания.
 * Закрытый диалог не отдаёт поздние файлы следующему поколению формы.
 */
async function confirm(): Promise<void> {
  if (!valid.value || !bitmap.value || busy.value) {
    return;
  }
  
  const source = bitmap.value;
  const current = generation;
  const snapshot = regions.value.filter((region) => region.view).map((region) => ({ ...region }));
  const files: Partial<StudioViewFiles> = {};
  
  busy.value = true;
  
  try {
    for (const region of snapshot) {
      const canvas = document.createElement('canvas');
      
      canvas.width = Math.floor(region.width);
      canvas.height = Math.floor(region.height);
      
      const context = canvas.getContext('2d');
      
      if (!context) {
        throw new Error('Canvas недоступен в этом браузере.');
      }
      
      context.drawImage(source, region.x, region.y, region.width, region.height, 0, 0,
        canvas.width, canvas.height);
      
      let blob: Blob;
      
      try {
        blob = await studioCanvasBlob(canvas);
      } finally {
        canvas.width = 0;
        canvas.height = 0;
      }
      
      if (current !== generation || !props.open) {
        return;
      }
      
      files[region.view as StudioViewId] = new File([blob], `view-${region.view}.png`, { type: 'image/png' });
    }
    
    emit('confirm', files);
    emit('close');
  } catch (cause) {
    if (current === generation) {
      error.value = studioErrorMessage(cause);
    }
  } finally {
    if (current === generation) {
      busy.value = false;
    }
  }
}

watch(() => [props.open, props.file], async () => {
  release();
  
  if (!props.open || !props.file) {
    return;
  }
  
  const current = generation;
  
  try {
    const image = await readStudioImage(props.file);
    
    if (current !== generation) {
      image.bitmap.close();
      
      return;
    }
    
    bitmap.value = image.bitmap;
    url.value = URL.createObjectURL(image.file);
    split();
  } catch (cause) {
    if (current === generation) {
      error.value = studioErrorMessage(cause);
    }
  }
}, { immediate: true });
onUnmounted(release);
</script>

<style scoped>
.studio-sheet-source { width: 100%; max-height: 280px; object-fit: contain; }
.studio-sheet-settings { display: flex; flex-wrap: wrap; gap: 10px; align-items: end; }
.studio-sheet-region { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin: 12px 0; }
</style>

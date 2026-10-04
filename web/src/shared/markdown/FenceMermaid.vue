<template>
  <figure v-if="image && showDiagram" class="md-diagram">
    <img class="md-diagram__image" :src="image.src" :width="image.width" :height="image.height"
         alt="Схема Mermaid" @error="imageFailed">
    <div class="md-fence__tools">
      <UiIconButton role="embedded" label="Показать код" title="Показать код"
                    data-context="md-diagram-code" @click="showDiagram = false">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="16 18 22 12 16 6" />
          <polyline points="8 6 2 12 8 18" />
        </svg>
      </UiIconButton>
    </div>
  </figure>
  <template v-else>
    <FenceCode :code="code" lang="mermaid" :closed="closed">
      <template v-if="image" #tools>
        <UiIconButton role="embedded" label="Показать схему" title="Показать схему"
                      data-context="md-diagram-show" @click="showDiagram = true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="3" y="3" width="7" height="5" rx="1" />
            <rect x="14" y="16" width="7" height="5" rx="1" />
            <path d="M6.5 8v4h11v4" />
          </svg>
        </UiIconButton>
      </template>
    </FenceCode>
    <p v-if="failed" class="md-diagram__error">Схему не удалось нарисовать, показан код.</p>
  </template>
</template>

<script setup lang="ts">
import { onUnmounted, ref, shallowRef, watch } from 'vue';

import { UiIconButton } from '../../ui';
import FenceCode from './FenceCode.vue';
import { renderMermaid } from './mermaidRender.ts';
import type { MermaidImage } from './mermaidRender.ts';

const props = defineProps<{
  code: string;
  closed: boolean;
}>();

const image = shallowRef<MermaidImage | null>(null);
const failed = ref(false);
const showDiagram = ref(true);
let drawRun = 0;
let controller: AbortController | null = null;

/**
 * Рисует схему только по закрытому блоку: незаконченная схема почти всегда ошибочна.
 * Поздний результат прежнего текста отбрасывается по номеру запуска.
 */
async function draw(): Promise<void> {
  drawRun += 1;

  const run = drawRun;

  controller?.abort();
  controller = null;
  image.value = null;
  failed.value = false;

  if (!props.closed) {
    return;
  }

  controller = new AbortController();

  let result: MermaidImage | null = null;

  try {
    result = await renderMermaid(props.code, { signal: controller.signal });
  } catch {
    result = null;
  }

  if (run !== drawRun) {
    return;
  }

  image.value = result;
  failed.value = !result;
}

/**
 * Отказ декодирования картинки возвращает исходник и понятное пояснение.
 * Повторной отрисовки здесь нет, поэтому битый результат не создаёт цикл запросов.
 */
function imageFailed(): void {
  image.value = null;
  failed.value = true;
}

watch(() => [props.code, props.closed], draw, { immediate: true });
onUnmounted(() => {
  drawRun += 1;
  controller?.abort();
});
</script>

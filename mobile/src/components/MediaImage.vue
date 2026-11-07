<template>
  <figure ref="target" class="mobile-media">
    <UiButton
      v-if="source"
      class="mobile-image-button"
      :aria-label="alt || 'Открыть изображение'"
      @click="opened = true"
      ><img :src="source" :alt="alt || 'Изображение'" @error="failed"
    /></UiButton>
    <div v-else class="mobile-image-placeholder">
      <span>{{ alt || 'Изображение' }}</span>
      <p v-if="error" role="status">Изображение недоступно</p>
      <UiButton v-if="error" :busy="busy" @click="load">Повторить</UiButton>
      <span v-else>{{ busy ? 'Загрузка…' : 'Загрузится при просмотре' }}</span>
    </div>
    <UiDialog
      v-if="opened"
      :title="alt || 'Изображение'"
      confirm="Закрыть"
      @close="opened = false"
      @confirm="opened = false"
    >
      <img class="mobile-full-image" :src="source" :alt="alt || 'Изображение'" />
    </UiDialog>
  </figure>
</template>

<script setup lang="ts">
import { Capacitor } from '@capacitor/core';
import { onMounted, onUnmounted, ref, watch } from 'vue';

import { UiButton, UiDialog } from '../ui.ts';
import { useLinkStore } from '../stores/link.ts';

const props = defineProps<{
  chatId: string;
  mediaRef: string;
  alt: string;
}>();
const link = useLinkStore();
const target = ref<HTMLElement | null>(null);
const source = ref('');
const error = ref(false);
const busy = ref(false);
const opened = ref(false);
let observer: IntersectionObserver | null = null;
let epoch = 0;
let visible = false;

/**
 * Изображение загружается только из native media API и только в текущем поколении связи.
 * Внешний URL из текста агента не становится src; поздний ответ после lock отбрасывается.
 */
async function load() {
  if (busy.value || source.value || !link.state?.unlocked) {
    return;
  }

  const captured = ++epoch;
  const generation = link.state.generation;

  busy.value = true;
  error.value = false;

  try {
    const result = await link.bridge!.fetchMedia({
      chatId: props.chatId,
      ref: props.mediaRef,
    });

    if (captured !== epoch || !link.state?.unlocked || link.state.generation !== generation) {
      return;
    }
    if (!result.path || result.error) {
      error.value = true;
    } else {
      source.value = Capacitor.isNativePlatform()
        ? Capacitor.convertFileSrc(result.path)
        : result.path;
    }
  } catch {
    if (captured === epoch) {
      error.value = true;
    }
  } finally {
    if (captured === epoch) {
      busy.value = false;
    }
  }
}

const failed = () => {
  source.value = '';
  error.value = true;
};

onMounted(() => {
  observer = new IntersectionObserver((entries) => {
    visible = entries.some((entry) => entry.isIntersecting);

    if (visible) {
      void load();
    }
  });

  if (target.value) {
    observer.observe(target.value);
  }
});
watch(
  () => [props.chatId, props.mediaRef],
  () => {
    epoch += 1;
    source.value = '';
    error.value = false;
    busy.value = false;
    opened.value = false;

    if (visible) {
      void load();
    }
  },
);
onUnmounted(() => {
  epoch += 1;
  observer?.disconnect();
  source.value = '';
});
</script>

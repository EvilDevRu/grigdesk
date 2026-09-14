<template>
  <video
    ref="element"
    class="ui-video"
    controls
    playsinline
    preload="metadata"
    :src="src"
    :poster="poster || undefined"
    :aria-label="label"
  ></video>
</template>

<script setup lang="ts">
import { ref } from 'vue';

/**
 * Общий проигрыватель видео. Как и у звука, нативные `controls` оставлены
 * намеренно: полноэкранный режим, клавиатура и дорожки субтитров у браузера уже
 * работают, а свой скин повторял бы их хуже.
 *
 * Ролик отдаётся сервером с поддержкой диапазонов, поэтому `preload="metadata"`
 * достаточно: браузер тянет начало файла, а не весь ролик ради первой секунды.
 */
withDefaults(
  defineProps<{
    src: string;
    poster?: string;
    label?: string;
  }>(),
  { poster: '', label: 'Готовый ролик' },
);

const element = ref<HTMLVideoElement | null>(null);

/**
 * Переход к секунде ролика с запуском воспроизведения. Нужен разделам, где ролик
 * состоит из частей и у каждой части есть свой адрес во времени: зритель нажимает
 * на часть, а не ищет её ползунком.
 */
function seek(seconds: number): void {
  const video = element.value;

  if (!video || !Number.isFinite(seconds)) {
    return;
  }

  video.currentTime = Math.max(0, seconds);
  void video.play()?.catch(() => {});
}

defineExpose({
  play: () => element.value?.play(),
  pause: () => element.value?.pause(),
  seek,
});
</script>


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

defineExpose({
  play: () => element.value?.play(),
  pause: () => element.value?.pause(),
});
</script>


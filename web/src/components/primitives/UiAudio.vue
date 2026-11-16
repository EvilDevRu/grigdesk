<template>
  <audio
    ref="element"
    class="ui-audio"
    controls
    preload="metadata"
    :src="src"
    :aria-label="label ?? t('core.coreZvukStseny')"
  ></audio>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { t } from '../../services/locale.ts';

/**
 * Общий проигрыватель звука. Нативные `controls` оставлены намеренно: они уже
 * дают клавиатуру, чтение экраном и системную регулировку громкости, а свой скин
 * пришлось бы повторять всё это заново и хуже.
 *
 * Живёт в примитивах, потому что нативный тег принадлежит им: продуктовый код
 * берёт плеер из общей границы `ui.ts`, а не заводит свой в каждом разделе.
 */
defineProps<{
  src: string;
  label?: string;
}>();

const element = ref<HTMLAudioElement | null>(null);

defineExpose({
  play: () => element.value?.play(),
  pause: () => element.value?.pause(),
});
</script>


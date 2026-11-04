<template>
  <Teleport :to="target"
            :disabled="!phone" defer>
    <slot />
  </Teleport>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';

const props = defineProps<{
  phone: boolean;
  menuOpen: boolean;
}>();

const target = ref(props.menuOpen ? '#phone-sections-actions' : '#phone-actions-parking');

// defer откладывает только начальный монтаж Teleport, но не смену назначения.
// Ждём обновления DOM диалога, чтобы новая цель уже существовала при переносе.
watch(() => props.menuOpen, (open) => {
  target.value = open ? '#phone-sections-actions' : '#phone-actions-parking';
}, { flush: 'post' });
</script>

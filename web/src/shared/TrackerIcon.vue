<template>
  <img v-if="logoUrl && !failed" class="tracker-icon" :src="logoUrl" alt=""
       :style="iconStyle" @error="failed = true" />
  <span v-else class="tracker-icon tracker-icon--monogram" :style="iconStyle" aria-hidden="true">
    {{ (name || '?').slice(0, 1) }}
  </span>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

// Знак доски трекера: логотип подключения, а при его отсутствии или ошибке
// загрузки — монограмма имени. Презентационный: реквизиты приходят снаружи.
const props = withDefaults(defineProps<{
  name: string;
  logoUrl?: string;
  size?: number;
}>(), {
  logoUrl: '',
  size: 14,
});

const failed = ref(false);
const iconStyle = computed(() => ({
  width: `${props.size}px`,
  height: `${props.size}px`,
  fontSize: `${Math.round(props.size * 0.62)}px`,
}));

watch(() => props.logoUrl, () => {
  failed.value = false;
});
</script>

<style scoped>
.tracker-icon { display: block; flex: none; object-fit: contain; }
.tracker-icon--monogram { display: inline-grid; place-items: center; font-weight: 700; line-height: 1; }
</style>
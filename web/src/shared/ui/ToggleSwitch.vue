<script setup>
// Тумблер-переключатель с подписью. Переиспользуемый: v-model + label.
defineProps({
  modelValue: { type: Boolean, required: true },
  label: { type: String, default: '' },
});
const emit = defineEmits(['update:modelValue']);
</script>

<template>
  <button class="tsw" :class="{ on: modelValue }" type="button" role="switch" :aria-checked="modelValue"
          @click="emit('update:modelValue', !modelValue)">
    <span class="track"><span class="knob"></span></span>
    <span v-if="label" class="tlbl">{{ label }}</span>
  </button>
</template>

<style scoped>
.tsw {
  display: inline-flex; align-items: center; gap: 7px;
  background: none; border: none; padding: 4px 2px; cursor: pointer;
  color: var(--ink-mid); font-size: 12px; font-family: var(--mono);
}
.tsw:hover { color: var(--ink); }
.tsw.on { color: var(--accent); }

.track {
  position: relative; width: 30px; height: 17px; border-radius: 9px;
  background: var(--surface-2); border: 1px solid var(--line-2);
  transition: background .18s ease, border-color .18s ease;
  flex: none;
}
.tsw.on .track {
  background: color-mix(in srgb, var(--accent) 30%, var(--surface-2));
  border-color: color-mix(in srgb, var(--accent) 60%, var(--line-2));
}
.knob {
  position: absolute; top: 2px; left: 2px; width: 11px; height: 11px; border-radius: 50%;
  background: var(--ink-mid);
  transition: left .18s ease, background .18s ease;
}
.tsw.on .knob { left: 15px; background: var(--accent); }

.tsw:focus-visible { outline: none; }
.tsw:focus-visible .track { border-color: var(--accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 30%, transparent); }

@media (prefers-reduced-motion: reduce) { .track, .knob { transition: none; } }
</style>

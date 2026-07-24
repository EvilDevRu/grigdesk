<script setup>
// Числовое поле в стиле кокпита: нативные белые стрелки браузера скрыты,
// вместо них свой тёмный степпер ▴/▾. Переиспользуемый: v-model + min/step/placeholder.
const props = defineProps({
  modelValue: { type: Number, default: 0 },
  min: { type: Number, default: 0 },
  step: { type: Number, default: 1 },
  placeholder: { type: String, default: '' },
});
const emit = defineEmits(['update:modelValue']);

function set(v) {
  emit('update:modelValue', Math.max(props.min, Number(v) || 0));
}
function bump(dir) {
  set((Number(props.modelValue) || 0) + dir * props.step);
}
</script>

<template>
  <span class="nf">
    <input class="nf-in mono" type="number" :min="min" :step="step" :placeholder="placeholder"
           :value="modelValue" @input="set($event.target.value)" />
    <span class="nf-step">
      <button type="button" class="nf-btn" tabindex="-1" aria-label="Больше" @click="bump(1)">▴</button>
      <button type="button" class="nf-btn" tabindex="-1" aria-label="Меньше" @click="bump(-1)">▾</button>
    </span>
  </span>
</template>

<style scoped>
.nf { position: relative; display: flex; width: 100%; }
.nf-in {
  background: var(--surface); border: 1px solid var(--line); color: var(--ink); border-radius: 8px;
  padding: 7px 30px 7px 10px; font-size: 13px; width: 100%;
  appearance: textfield; -moz-appearance: textfield;
}
.nf-in::-webkit-outer-spin-button, .nf-in::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.nf-in:focus { outline: none; border-color: var(--line-2); }

.nf-step {
  position: absolute; top: 4px; right: 4px; bottom: 4px; width: 22px;
  display: flex; flex-direction: column; opacity: 0; transition: opacity .15s ease;
}
.nf:hover .nf-step, .nf-in:focus ~ .nf-step { opacity: 1; }
.nf-btn {
  flex: 1; background: var(--surface-2); border: 1px solid var(--line); color: var(--ink-mid);
  font-size: 8px; line-height: 1; cursor: pointer; padding: 0;
}
.nf-btn:first-child { border-radius: 5px 5px 0 0; border-bottom-width: 0; }
.nf-btn:last-child { border-radius: 0 0 5px 5px; }
.nf-btn:hover { color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, var(--surface-2)); }
.nf-btn:active { background: color-mix(in srgb, var(--accent) 22%, var(--surface-2)); }
</style>

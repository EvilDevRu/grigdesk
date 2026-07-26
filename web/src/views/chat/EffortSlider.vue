<script setup>
import { computed } from 'vue';

// Слайдер усилия рассуждения — как переключатель в расширении VS Code:
// дискретные точки, клик по точке (или трек) задаёт уровень.
// УРОВНИ НЕ ЗАХАРДКОЖЕНЫ: приходят пропсом levels из реестра моделей
// (у каждой модели свой набор; появится новый уровень — отрисуется сам).
const props = defineProps({
  modelValue: { type: String, default: 'high' },
  levels: { type: Array, default: () => ['low', 'medium', 'high', 'max'] },
});
const emit = defineEmits(['update:modelValue']);

// Красивые подписи известных уровней; неизвестный — капитализируем как есть.
const KNOWN = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Ultra', max: 'Max', minimal: 'Min' };
function labelOf(l) { return KNOWN[l] || (l ? l[0].toUpperCase() + l.slice(1) : ''); }
const idx = computed(() => {
  const i = props.levels.indexOf(props.modelValue);
  return i < 0 ? Math.min(2, props.levels.length - 1) : i;
});
const pct = computed(() => (idx.value / Math.max(1, props.levels.length - 1)) * 100);
function posOf(i) { return (i / Math.max(1, props.levels.length - 1)) * 100; }
function set(i) { emit('update:modelValue', props.levels[i]); }
// Клик по треку — ближайшая точка.
function onTrack(e) {
  const r = e.currentTarget.getBoundingClientRect();
  const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  set(Math.round(f * (props.levels.length - 1)));
}
</script>

<template>
  <div class="eff" :data-lvl="modelValue" :title="`Усилие рассуждения: ${labelOf(modelValue)}`">
    <span class="cap">эффорт</span>
    <div class="track" @click="onTrack">
      <div class="rail"></div>
      <div class="fill" :style="{ width: pct + '%' }"></div>
      <button v-for="(l, i) in levels" :key="l" type="button" class="node" :class="{ on: i <= idx, cur: i === idx }"
              :style="{ left: posOf(i) + '%' }" :aria-label="labelOf(l)" @click.stop="set(i)"></button>
    </div>
    <span class="val">{{ labelOf(modelValue) }}</span>
  </div>
</template>

<style scoped>
/* Без своей коробки: панель чата — строка состояния, а не набор форм */
.eff { display: inline-flex; align-items: center; gap: 8px; height: 28px; background: none; border: none;
  padding: 0; user-select: none; flex: none; }
.cap { font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em; color: var(--ink-mid); opacity: .75; flex: none; }
.track { position: relative; width: 78px; height: 16px; flex: none; cursor: pointer; }
.rail { position: absolute; top: 50%; left: 0; right: 0; height: 3px; transform: translateY(-50%); background: var(--surface-2); border-radius: 999px; }
.fill { position: absolute; top: 50%; left: 0; height: 3px; transform: translateY(-50%); border-radius: 999px; background: var(--accent); transition: width .15s; }
.node { position: absolute; top: 50%; width: 8px; height: 8px; border-radius: 50%; transform: translate(-50%, -50%);
  background: var(--surface-2); border: none; padding: 0; cursor: pointer; transition: background .15s, box-shadow .15s, width .15s, height .15s; }
.node.on { background: var(--accent); }
.node.cur { width: 14px; height: 14px; box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent); }
.val { font-size: 12px; font-weight: 600; color: var(--accent); flex: none; min-width: 46px; }

/* Уровни не красим в warn/bad — это цвета ошибок, настройка не должна «тревожить».
   Всё в акценте, только low приглушён. */
.eff[data-lvl="low"] .fill, .eff[data-lvl="low"] .node.on { background: var(--ink-mid); }
.eff[data-lvl="low"] .node.cur { box-shadow: 0 0 0 3px color-mix(in srgb, var(--ink-mid) 22%, transparent); }
.eff[data-lvl="low"] .val { color: var(--ink-mid); }
</style>

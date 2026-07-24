<script setup>
import { computed } from 'vue';

// Слайдер усилия рассуждения — как переключатель в расширении VS Code:
// дискретные точки Low/Medium/High/Max, клик по точке (или трек) задаёт уровень.
const props = defineProps({ modelValue: { type: String, default: 'high' } });
const emit = defineEmits(['update:modelValue']);

const LEVELS = ['low', 'medium', 'high', 'max'];
const LABELS = { low: 'Low', medium: 'Medium', high: 'High', max: 'Max' };
const idx = computed(() => { const i = LEVELS.indexOf(props.modelValue); return i < 0 ? 2 : i; });
const pct = computed(() => (idx.value / (LEVELS.length - 1)) * 100);
function posOf(i) { return (i / (LEVELS.length - 1)) * 100; }
function set(i) { emit('update:modelValue', LEVELS[i]); }
// Клик по треку — ближайшая точка.
function onTrack(e) {
  const r = e.currentTarget.getBoundingClientRect();
  const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  set(Math.round(f * (LEVELS.length - 1)));
}
</script>

<template>
  <div class="eff" :data-lvl="modelValue" :title="`Усилие рассуждения: ${LABELS[modelValue]}`">
    <span class="cap">эффорт</span>
    <div class="track" @click="onTrack">
      <div class="rail"></div>
      <div class="fill" :style="{ width: pct + '%' }"></div>
      <button v-for="(l, i) in LEVELS" :key="l" type="button" class="node" :class="{ on: i <= idx, cur: i === idx }"
              :style="{ left: posOf(i) + '%' }" :aria-label="LABELS[l]" @click.stop="set(i)"></button>
    </div>
    <span class="val">{{ LABELS[modelValue] }}</span>
  </div>
</template>

<style scoped>
.eff { display: inline-flex; align-items: center; gap: 8px; height: 34px; background: var(--ground); border: 1px solid var(--line);
  border-radius: 8px; padding: 0 10px; user-select: none; flex: none; }
.cap { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--ink-mid); flex: none; }
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

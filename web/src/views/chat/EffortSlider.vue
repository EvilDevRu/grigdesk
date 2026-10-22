<template>
  <div class="eff" :class="{ off: disabled }" :data-lvl="model"
       v-tooltip="hint || effortTooltip">
    <span class="cap">эффорт</span>
    <UiDiscreteSlider v-model="sliderIndex" class="eff-slider" :min="0"
                      :max="Math.max(0, levels.length - 1)" :step="1"
                      :labels="sliderLabels" :value-text="selectedDescription"
                      ticks :disabled="disabled" label="Усилие рассуждения" />
    <span class="val">{{ model || '—' }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed, type PropType } from 'vue';
import { UiDiscreteSlider, vTooltip } from '../../ui';

// Слайдер усилия рассуждения — как переключатель в расширении VS Code:
// дискретные точки, клик по точке (или трек) задаёт уровень.
// УРОВНИ НЕ ЗАХАРДКОЖЕНЫ: приходят пропсом levels из реестра моделей
// (у каждой модели свой набор; появится новый уровень — отрисуется сам).
const props = defineProps({
  levels: { type: Array as PropType<string[]>, default: () => [] },
  hints: { type: Object as PropType<Record<string, string>>, default: () => ({}) },
  // Уровень показан, но менять его здесь нельзя (замороженный разговор). Слайдер
  // тогда остаётся индикатором и молча ничего не эмитит.
  disabled: { type: Boolean, default: false },
  // Чем заменить обычную подсказку: неактивный слайдер обязан объяснить, где менять.
  hint: { type: String, default: '' },
});

const model = defineModel({ type: String, default: '' });

// Скринридер получает выбранный уровень вместе с его смыслом.
// Пустой выбор означает умолчание исполнителя, а не первую риску слайдера.
const selectedDescription = computed(() => {
  if (!model.value) {
    return 'Усилие по умолчанию исполнителя';
  }

  const description = props.hints[model.value];

  return description ? `${model.value} — ${description}` : model.value;
});

// Справка позволяет сравнить все доступные ступени до смены значения.
// Список задаёт модель, поэтому чужие и неподдерживаемые уровни сюда не попадают.
const effortTooltip = computed(() => {
  const heading = model.value
    ? `Усилие рассуждения: ${model.value}`
    : 'Усилие рассуждения: по умолчанию исполнителя';
  const descriptions = props.levels.map((level) => {
    const description = props.hints[level] || 'Описание этого уровня пока недоступно.';

    return `${level} — ${description}`;
  });

  return [heading, ...descriptions].join('\n');
});

const sliderLabels = computed(() => Object.fromEntries(
  props.levels.map((level, index) => [index, level]),
));
const idx = computed(() => {
  return props.levels.indexOf(model.value);
});
const sliderIndex = computed({
  get: () => Math.max(0, idx.value),
  set: (value: number) => {
    if (!props.disabled && props.levels[value] !== undefined) {
      model.value = props.levels[value];
    }
  },
});
</script>

<style scoped>
/* Без своей коробки: панель чата — строка состояния, а не набор форм */
.eff { display: inline-flex; align-items: center; gap: 8px; height: 28px; background: none; border: none;
  padding: 0; user-select: none; flex: none; }
.cap { font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em; color: var(--ink-mid); opacity: .75; flex: none; }
.eff-slider { width: 78px; flex: none; }
.val { font-size: 12px; font-weight: 600; color: var(--accent); flex: none; min-width: 46px; }

/* Только индикатор: курсор не обещает клика, но значение остаётся читаемым —
   человек обязан видеть, каким усилием уйдёт ход. */
.eff.off { opacity: .72; }

/* Уровни не красим в warn/bad — это цвета ошибок, настройка не должна «тревожить».
   Всё в акценте, только low приглушён. */
.eff[data-lvl="low"] .val { color: var(--ink-mid); }
</style>

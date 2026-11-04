<template>
  <div class="eff" :class="{ off: disabled, 'eff--expanded': expanded }" :data-lvl="model"
       v-tooltip="expanded ? '' : hint || effortTooltip">
    <template v-if="expanded">
      <div class="eff-options" role="group" :aria-label="t('core.chatOptionEffort')"
           :style="{ gridTemplateColumns: `repeat(${Math.min(levels.length, 3)}, minmax(0, 1fr))` }">
        <UiButton v-for="level in levels" :key="level" variant="outline"
                  :tone="model === level ? 'accent' : 'neutral'"
                  :pressed="model === level" :disabled="disabled"
                  data-context="chat-effort-level" @click="model = level">
          {{ level }}
        </UiButton>
      </div>
      <p class="eff-hint">{{ hint || selectedDescription }}</p>
    </template>
    <template v-else>
      <span class="cap">эффорт</span>
      <UiDiscreteSlider v-model="sliderIndex" class="eff-slider" :min="0"
                        :max="Math.max(0, levels.length - 1)" :step="1"
                        :labels="sliderLabels" :value-text="selectedDescription"
                        :unselected="idx < 0"
                        thin ticks :disabled="disabled" label="Усилие рассуждения" />
      <span class="val">{{ model || '—' }}</span>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, type PropType } from 'vue';
import { t, UiButton, UiDiscreteSlider, vTooltip } from '../../ui';

// Слайдер усилия рассуждения — как переключатель в расширении VS Code:
// дискретные риски, клик по риске (или треку) задаёт уровень.
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
  // В настройках телефона уровни выбираются отдельными сенсорными кнопками.
  expanded: { type: Boolean, default: false },
});

const model = defineModel({ type: String, default: '' });

// Скринридер получает выбранный уровень вместе с его смыслом.
// Пустой выбор означает умолчание исполнителя, а не первую риску слайдера.
const selectedDescription = computed(() => {
  if (!model.value) {
    return t('core.chatEffortDefault');
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
.val { font-size: 12px; font-weight: 600; color: var(--accent); flex: none; }

/* Только индикатор: курсор не обещает клика, но значение остаётся читаемым —
   человек обязан видеть, каким усилием уйдёт ход. */
.eff.off { opacity: .72; }

/* Уровни не красим в warn/bad — это цвета ошибок, настройка не должна «тревожить».
   Всё в акценте, только low приглушён. */
.eff[data-lvl="low"] .val { color: var(--ink-mid); }

/* В развёрнутой форме нет короткого трека и повторных подписей.
   До трёх уровней в ряду: каждый остаётся отдельной площадкой для касания. */
.eff.eff--expanded { display: grid; height: auto; min-width: 0; gap: 8px; }
.eff-options { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
.eff-hint { margin: 0; color: var(--ink-mid); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
</style>

<script setup>
import { computed, ref } from 'vue';
import CompanionRobot from './CompanionRobot.vue';

const props = defineProps({
  expanded: { type: Boolean, default: false },
  controls: { type: String, default: 'cockpit-companion-bubble' },
  interaction: { type: String, default: 'idle' },
  attention: { type: Object, default: () => ({ kind: 'none', count: 0 }) },
});
const emit = defineEmits(['toggle']);
const button = ref(null);
const attentionLabel = computed(() => {
  if (props.attention?.kind === 'stall') return `Остановившихся задач: ${props.attention.count}`;
  if (props.attention?.kind === 'wait') return `Нужно решений: ${props.attention.count}`;
  if (props.attention?.kind === 'info') return `Новых событий: ${props.attention.count}`;
  return '';
});
const ariaLabel = computed(() => {
  const action = props.expanded ? 'Закрыть голосового компаньона' : 'Открыть голосового компаньона';
  const state = {
    listening: 'Слушаю',
    transcribing: 'Распознаю речь',
    thinking: 'Агент думает',
    speaking: 'Озвучиваю ответ',
  }[props.interaction] || '';
  return [action, state, attentionLabel.value].filter(Boolean).join('. ');
});

defineExpose({ focus: () => button.value?.focus?.() });
</script>

<template>
  <button
    ref="button"
    type="button"
    class="companion-avatar"
    :class="[`is-${interaction}`, `attention-${attention?.kind || 'none'}`]"
    :data-interaction="interaction"
    :data-attention="attention?.kind || 'none'"
    :aria-label="ariaLabel"
    :aria-expanded="expanded"
    :aria-controls="controls"
    @click="emit('toggle')"
  >
    <CompanionRobot class="avatar-art" :interaction="interaction" :attention="attention?.kind || 'none'" />
    <span
      v-if="attention?.count"
      class="attention-badge"
      role="status"
      :aria-label="attentionLabel"
    >{{ attention.count > 99 ? '99+' : attention.count }}</span>
  </button>
</template>

<style scoped>
/* Фигурка робота, а не клавиша: ни рамки, ни подложки — форму держит сам силуэт. */
.companion-avatar {
  --attention-tone: var(--accent);
  position: relative;
  display: grid;
  place-items: center;
  width: clamp(56px, 5.5vw, 72px);
  height: clamp(56px, 5.5vw, 72px);
  min-width: 56px;
  min-height: 56px;
  padding: 0;
  border: 0;
  border-radius: 18px;
  color: var(--accent);
  background: none;
  cursor: pointer;
}
.companion-avatar:focus-visible { outline: 3px solid color-mix(in srgb, var(--accent) 55%, transparent); outline-offset: 3px; }
/* «Хочется потрогать» — это РЕАКЦИЯ, а не форма: наведение приподнимает,
   нажатие ПРИСЕДАЕТ к земле и пружинит обратно (back-out). Жёсткое линейное
   масштабирование той же фигурки читается мёртвой картинкой.
   Трансформируем только рисунок: чип от сплющивания искажал бы цифру. */
.avatar-art {
  width: 100%;
  height: 100%;
  transform-origin: 50% 92%;
  transition: transform .18s cubic-bezier(.34, 1.56, .64, 1);
}
.companion-avatar:hover .avatar-art { transform: translateY(-3px) scale(1.05); }
.companion-avatar:active .avatar-art { transform: translateY(2px) scale(1.07, .9); }
/* Счётчик — единственное, что меняет цвет: это сигнал «сколько ждёт», а не настроение. */
.companion-avatar.attention-stall { --attention-tone: var(--bad); }
.companion-avatar.attention-wait { --attention-tone: var(--warn); }
/* Тот же чип, что в навигации (`.navbadge`): 14px, без «наклеечной» рамки и с тем
   же пульсом. Прежний вариант был вдвое крупнее и с толстым кольцом — он читался
   стикером, прилепленным поверх фигурки, а не её состоянием.
   Прижат к УГЛУ КОРПУСА, а не к углу кнопки: корпус занимает не весь бокс, и от
   угла кнопки чип отставал на несколько пикселей — висел в воздухе. Проценты
   зеркалят `shell` из CompanionRobot (x 9..55, y 11 при вьюбоксе 64). */
.attention-badge {
  position: absolute;
  top: calc(17.2% - 7px);
  right: calc(14.1% - 7px);
  display: grid;
  min-width: 14px;
  height: 14px;
  padding: 0 3px;
  place-items: center;
  border-radius: 999px;
  background: var(--attention-tone);
  color: #fff;
  font-size: 9.5px;
  font-weight: 700;
  line-height: 1;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ground) 62%, transparent);
}
.companion-avatar.attention-wait .attention-badge { color: #1a1206; }
.companion-avatar.attention-wait .attention-badge,
.companion-avatar.attention-stall .attention-badge { animation: badgepulse 1.9s ease-in-out infinite; }
@keyframes badgepulse { 50% { transform: scale(1.12); } }
@media (prefers-reduced-motion: reduce) {
  .companion-avatar { transition: none; }
  .companion-avatar:hover { transform: none; }
  .attention-badge { animation: none !important; }
}
</style>

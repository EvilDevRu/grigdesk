<template>
  <!-- Стоит в ряду исполнителей и обёрнут точками: компаньон — «ещё один
       исполнитель» по языку топбара, поэтому и знак, и разделители те же. -->
  <template v-if="visible">
    <HelpTip align="right" class="companion-tb-tip" :text="tip">
      <UiPressable
        class="companion-tb"
        :class="[`is-${companion.interaction}`, `attention-${attentionKind}`]"
        :data-interaction="companion.interaction"
        :data-attention="attentionKind"
        :aria-label="tip"
        :aria-expanded="onChats ? undefined : expanded"
        :aria-controls="expanded ? BUBBLE_ID : undefined"
        @click="activate"
      >
        <CompanionRobot
          class="companion-tb-art"
          variant="mark"
          :interaction="companion.interaction"
          :attention="attentionKind"
        />
      </UiPressable>
    </HelpTip>
    <span class="sep" aria-hidden="true">·</span>
  </template>
</template>

<script setup>
// Дубль компаньона в топбаре. Нужен потому, что на /chats плавающая фигурка
// намеренно не показывается (полная страница остаётся единственным композером),
// и добраться до компаньона оттуда было нечем.
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { useCompanionStore } from '../../stores/companion.js';
import HelpTip from '../../shared/ui/HelpTip.vue';
import CompanionRobot from './CompanionRobot.vue';
import { UiPressable } from '../../ui';

const BUBBLE_ID = 'cockpit-companion-bubble';
const route = useRoute();
const companion = useCompanionStore();

const onChats = computed(() => route.path === '/chats');
const visible = computed(() => companion.deviceEnabled);
const expanded = computed(() => !onChats.value && companion.bubbleOpen);
const attentionKind = computed(() => companion.attention?.kind || 'none');
const attentionLabel = computed(() => {
  const count = companion.attention?.count || 0;
  if (!count) return '';
  if (attentionKind.value === 'stall') return `Остановившихся задач: ${count}`;
  if (attentionKind.value === 'wait') return `Нужно решений: ${count}`;
  if (attentionKind.value === 'info') return `Новых событий: ${count}`;
  return '';
});
const stateLabel = computed(() => ({
  listening: 'Слушаю',
  transcribing: 'Распознаю речь',
  thinking: 'Агент думает',
  speaking: 'Озвучиваю ответ',
}[companion.interaction] || ''));
// На /chats кнопка не открывает пузырь, а выбирает разговор компаньона в списке:
// второй композер поверх страницы чатов заводить нельзя.
const action = computed(() => (onChats.value
  ? 'Открыть разговор с компаньоном'
  : (expanded.value ? 'Закрыть голосового компаньона' : 'Открыть голосового компаньона')));
const tip = computed(() => [action.value, stateLabel.value, attentionLabel.value].filter(Boolean).join(' · '));

function activate() {
  if (onChats.value) void companion.openConversation();
  else companion.toggleBubble();
}
</script>

<style scoped>
/* Тот же обвес, что у знаков исполнителей: без кнопочного контейнера и с нулевой
   высотой строки, иначе baseline-зазор SVG сбивает знак с общей оптической оси. */
.companion-tb-tip { display: inline-flex; align-items: center; vertical-align: middle; }
.companion-tb-tip :deep(.ht-tr) { line-height: 0; }
.companion-tb {
  display: inline-grid;
  place-items: center;
  padding: 0;
  border: 0;
  background: none;
  line-height: 0;
  color: var(--accent);
  cursor: pointer;
  transition: opacity .12s;
}
.companion-tb:hover { opacity: .82; }
.companion-tb:focus-visible { outline: 2px solid color-mix(in srgb, var(--accent) 60%, transparent); outline-offset: 3px; border-radius: 4px; }
.companion-tb-art { width: 15px; height: 15px; }
.sep { color: var(--ink-mid); margin: 0 -4px; }
</style>

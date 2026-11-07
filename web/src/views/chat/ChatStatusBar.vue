<template>
  <div class="chat-status" data-role="chat-status">
    <div class="chat-status__row">
      <div class="chat-status__activity">
        <ChatThinking v-if="status.thinking" :key="status.runKey"
                      :steps="steps" :tokens="tokens" :tokens-estimate="tokensEstimate"
                      :started-at="startedAt" />
        <span v-else class="chat-status__phase">
          <UiSpinner v-if="status.phase === 'compact'" decorative />
          {{ status.phaseLabel }}
        </span>
      </div>
      <div v-if="status.phase !== 'compact'" ref="summaryEl" class="chat-status__summary"
           data-role="chat-status-summary" v-tooltip="fullSummary">
        <span class="chat-status__facts">
          <span v-if="layout.model" class="chat-status__model" data-role="chat-status-model">
            <span v-if="layout.kind && shortModelKind" class="chat-status__kind" aria-hidden="true">
              {{ shortModelKind }}
            </span>
            <span class="chat-status__value">{{ status.modelLabel || 'Модель не выбрана' }}</span>
          </span>
          <template v-if="layout.cwd">
            <span class="chat-status__sep" aria-hidden="true">·</span>
            <span class="chat-status__cwd" data-role="chat-status-cwd">{{ status.cwdLabel }}</span>
          </template>
          <template v-if="shownUsage.length">
            <span v-if="layout.model" class="chat-status__sep" aria-hidden="true">·</span>
            <span class="chat-status__usage" :class="usage.tone" data-role="chat-status-usage">
              <template v-for="(item, index) in shownUsage" :key="item.key">
                <span v-if="index" class="chat-status__sep" aria-hidden="true">·</span>
                <span class="chat-status__item">
                  <span v-if="layout.labels" class="chat-status__value">{{ item.label }}:</span>
                  <span>{{ item.value }}</span>
                </span>
              </template>
              <span v-if="usage.stale" class="chat-status__stale">устарели</span>
            </span>
          </template>
          <!-- «+N» — сколько сведений не поместилось; по нажатию общая всплывашка
               показывает именно их, с подписями и полным путём. -->
          <UiPopover v-if="overflow.length" placement="top-end" aria-label="Не поместилось в строку"
                     :style="{ width: 'min(320px, calc(100vw - 20px))' }">
            <template #trigger>
              <UiPressable data-context="chat-status-more" data-role="chat-status-more"
                           :aria-label="`Ещё ${overflow.length}: показать, что не поместилось`">
                +{{ overflow.length }}
              </UiPressable>
            </template>
            <dl class="chat-status__overflow" data-role="chat-status-popover">
              <div v-for="entry in overflow" :key="entry.key" class="chat-status__overflow-row"
                   :class="{ [usage.tone]: entry.key.startsWith('usage:') }">
                <dt>{{ entry.label }}</dt>
                <dd>{{ entry.value }}</dd>
              </div>
              <p v-if="usage.stale && usageItems.length" class="chat-status__overflow-note">
                Данные лимитов устарели
              </p>
            </dl>
          </UiPopover>
        </span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';

import { UiPopover, UiPressable, UiSpinner, vTooltip } from '../../ui';
import { clockOf, resetIn } from '../../features/providers/providerUsage.ts';
import type { UsageSummary } from '../../features/providers/providerUsageSummary.ts';
import type { ChatStatus } from './chatStatus.ts';
import { statusOverflow, statusSummaryLayout } from './chatStatusLayout.ts';
import ChatThinking from './ChatThinking.vue';

const props = withDefaults(defineProps<{
  chatKey: string;
  status: ChatStatus;
  usage: UsageSummary;
  steps?: unknown[];
  tokens?: number;
  tokensEstimate?: boolean;
  startedAt?: number;
}>(), {
  steps: () => [],
  tokens: 0,
  tokensEstimate: false,
  startedAt: 0,
});

const shortModelKind = computed(() => ({
  выбрана: 'выбр.',
  запрошена: 'запр.',
  сообщена: '',
} as Record<string, string>)[props.status.modelKind] || '');
const usageItems = computed(() => props.usage.label
  ? []
  : props.usage.items.filter((item) => item.value !== 'нет данных'));

// Ширина блока сведений; пока не измерена — бесконечность, то есть «видно всё».
const summaryEl = ref<HTMLElement | null>(null);
const summaryWidth = ref(Number.POSITIVE_INFINITY);
const squeeze = reactive({
  cwd: false,
  model: false,
  windows: 0,
});
let summaryObserver: ResizeObserver | null = null;

const layout = computed(() => statusSummaryLayout(summaryWidth.value, usageItems.value.length, squeeze));
const shownUsage = computed(() => usageItems.value.slice(0, layout.value.windows));
const overflow = computed(() => statusOverflow(layout.value, {
  modelKind: props.status.modelKind,
  modelLabel: props.status.modelLabel || 'Модель не выбрана',
  cwd: props.status.cwd || props.status.cwdLabel,
  extraDirs: props.status.extraDirs,
  usageItems: usageItems.value,
}));

const fullSummary = computed(() => [
  `${props.status.modelKind} ${props.status.modelLabel}`.trim(),
  props.status.cwd || props.status.cwdLabel,
  props.status.extraDirs.length ? `Дополнительные каталоги: ${props.status.extraDirs.join(', ')}` : '',
  usageItems.value.length ? `Осталось по аккаунту: ${usageItems.value.map((item) => {
    const reset = resetIn(item.resetsAt);

    return `${item.label}: ${item.value}${reset ? ` (${reset})` : ''}`;
  }).join(' · ')}` : '',
  usageItems.value.length && props.usage.measuredAt
    ? `замер ${clockOf(new Date(props.usage.measuredAt))}` : '',
  usageItems.value.length && props.usage.stale ? 'Данные устарели' : '',
].filter(Boolean).join(' · '));

function truncated(selector: string): boolean {
  const element = summaryEl.value?.querySelector(selector);

  return Boolean(element && element.scrollWidth > element.clientWidth + 1);
}

// Окна лимитов не сжимаются, поэтому их лишнее место видно по обрезке модели или папки.
function factsCut(): boolean {
  return truncated('[data-role="chat-status-model"] .chat-status__value')
    || (layout.value.cwd && truncated('[data-role="chat-status-cwd"]'));
}

/*
 * Пороги ширины зависят от шрифта устройства, поэтому после отрисовки проверяем факт:
 * обрезанное уходит во «+N» целиком. Сначала по одному уходят окна лимитов сверх двух,
 * затем папка — она освобождает место и модели; модель уходит, только если не влезла
 * и без папки. Перерисовка идёт в том же кадре (ResizeObserver и микрозадачи Vue — до
 * отрисовки).
 */
async function fitSummary(): Promise<void> {
  await nextTick();

  while (shownUsage.value.length > 2 && factsCut()) {
    squeeze.windows += 1;
    await nextTick();
  }

  const modelCut = truncated('[data-role="chat-status-model"] .chat-status__value');

  if (layout.value.cwd && (modelCut || truncated('[data-role="chat-status-cwd"]'))) {
    squeeze.cwd = true;
    await nextTick();
  }

  if (layout.value.model && truncated('[data-role="chat-status-model"] .chat-status__value')) {
    squeeze.model = true;
  }
}

/*
 * Ширина или содержимое сменились — замер начинается заново, с полной строки:
 * на расширившемся экране снятые окна и папка должны вернуться.
 */
function refitSummary(): void {
  squeeze.cwd = false;
  squeeze.model = false;
  squeeze.windows = 0;
  void fitSummary();
}

watch(() => [
  summaryWidth.value,
  props.status.modelLabel,
  props.status.cwdLabel,
  usageItems.value.map((item) => `${item.label}: ${item.value}`).join(' · '),
], refitSummary);

/*
 * Блок сведений пропадает на время сжатия и возвращается новым узлом, поэтому
 * наблюдатель перевешивается вслед за ref. Без ResizeObserver (старый браузер, тесты)
 * ширина остаётся «неизмеренной» — строка показывает всё, как раньше.
 */
watch(summaryEl, (element) => {
  summaryObserver?.disconnect();
  summaryObserver = null;

  if (!element || typeof ResizeObserver === 'undefined') {
    summaryWidth.value = Number.POSITIVE_INFINITY;

    return;
  }

  summaryObserver = new ResizeObserver(([entry]) => {
    if (!entry) {
      return;
    }

    summaryWidth.value = entry.contentRect.width;
  });
  summaryObserver.observe(element);
});

onBeforeUnmount(() => {
  summaryObserver?.disconnect();
  summaryObserver = null;
});
</script>

<style scoped>
/* Строка хода — служебная: слово набрано чуть мельче текста переписки (12.5 против
   13–14), числа и сведения справа — ещё мельче и тише (см. .fact и __summary). */
.chat-status {
  --chat-status-font-size: 12.5px;
  container: chat-status / inline-size;
  min-width: 0;
  font-size: var(--chat-status-font-size);
  line-height: 1.4;
  color: var(--ink-mid);
  font-variant-numeric: tabular-nums;
}
.chat-status__row {
  display: flex;
  align-items: baseline;
  gap: 12px;
  min-width: 0;
}
.chat-status__activity {
  flex: 0 0 auto;
  min-width: 0;
  max-width: calc(100% - min(6em, 32%) - 12px);
}
/* Ячейка слова держит резерв 12em под штатные слова (иначе числа ездили бы за каждым
   словом), но длинная фраза — «Работаю через <сервер>» — растёт в свободное место справа:
   сведения уступят ей модель и папку во «+N». На узкой строке резерв снимается. */
.chat-status__activity :deep(.said) {
  flex: 0 1 auto;
  min-width: 12em;
}
/* Сведения — фон хода, а не его новость: кегль мельче слова и цвет тише чисел времени
   и расхода. Блок занимает всё место справа от индикатора; при нехватке места куски
   уходят целиком (правило — chatStatusLayout.ts, ширину меряет ResizeObserver), а не
   режутся все разом до обрубков вида «Op… · Workspac… · Се…». Ушедшее показывает «+N». */
.chat-status__summary {
  color: color-mix(in srgb, var(--ink-low) 70%, var(--surface));
  flex: 1 1 0;
  min-width: 0;
  font-size: 11.5px;
}
.chat-status__phase {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 2px 5px;
  white-space: nowrap;
}
.chat-status__facts {
  display: flex;
  justify-content: flex-end;
  align-items: baseline;
  gap: 6px;
  width: 100%;
  min-width: 0;
  text-align: left;
}
.chat-status__model {
  display: flex;
  align-items: baseline;
  flex: 0 1 auto;
  gap: 4px;
  min-width: 0;
}
.chat-status__kind { flex: none; }
.chat-status__cwd {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Окна лимитов не режутся: их числа — главное в блоке, место уступают модель и папка. */
.chat-status__usage {
  display: flex;
  flex: none;
  align-items: baseline;
  gap: 6px;
}
.chat-status__item { display: flex; align-items: baseline; gap: 3px; min-width: 0; }
.chat-status__value { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-status__sep, .chat-status__stale { flex: none; }
.chat-status__sep { color: inherit; }
.chat-status__usage.muted { color: inherit; }
.chat-status__usage.warn { color: var(--warn); }
.chat-status__usage.bad { color: var(--bad); }

/* Содержимое всплывашки «+N»: подпись слева, значение справа, длинный путь переносится. */
.chat-status__overflow {
  display: grid;
  gap: 6px;
  margin: 0;
  font-size: 12px;
  line-height: 1.35;
}
.chat-status__overflow-row {
  display: grid;
  grid-template-columns: minmax(80px, auto) 1fr;
  gap: 10px;
  align-items: baseline;
}
.chat-status__overflow-row dt { color: var(--ink-mid); }
.chat-status__overflow-row dd {
  margin: 0;
  color: var(--ink);
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.chat-status__overflow-row.warn dd { color: var(--warn); }
.chat-status__overflow-row.bad dd { color: var(--bad); }
.chat-status__overflow-note {
  margin: 2px 0 0;
  color: var(--ink-low);
}

@container chat-status (max-width: 480px) {
  /* В узком чате активность и метрики получают отдельные строки: несжимаемые числа
     больше не заходят на квоты справа. Смена слова не меняет число строк и высоту. */
  .chat-status__row {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 0;
  }
  .chat-status__activity { max-width: none; }
  .chat-status__summary { padding-left: 27px; }
  .chat-status__activity :deep(.think) { gap: 5px; }
  .chat-status__activity :deep(.said) { min-width: 0; }
  .chat-status__activity :deep(.fact) { margin-left: 0; }
  .chat-status__activity :deep(.dots) { display: none; }
  .chat-status__activity :deep(.tok-unit) { display: none; }
}
</style>

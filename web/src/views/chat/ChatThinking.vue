<template>
  <div class="think" data-role="chat-thinking">
    <!-- Знак хода вместо спиннера: мозг появляется на старте хода и дальше мягко дышит.
         Появление и пульсация — две анимации на разных узлах: одна короткая и разовая,
         вторая бесконечная и только по прозрачности, чтобы знак не «дёргался» размером.
         Рисунок намеренно простой — доли и борозда: извилины в этом кегле давали кашу. -->
    <span class="brain-wrap">
      <svg class="brain" viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M12 5a2.3 2.3 0 0 0-4.1 1.5 2.5 2.5 0 0 0-3.4 3.1 2.7 2.7 0 0 0-.3 4.6 2.6 2.6 0 0 0 2.5 4.3 2.2 2.2 0 0 0 5.2.7"
        />
        <path
          d="M12 5a2.3 2.3 0 0 1 4.1 1.5 2.5 2.5 0 0 1 3.4 3.1 2.7 2.7 0 0 1 .3 4.6 2.6 2.6 0 0 1-2.5 4.3 2.2 2.2 0 0 1-5.2.7"
        />
        <path d="M12 5v14.2" />
      </svg>
    </span>
    <!-- Ключ по слову: смена слова пересоздаёт узел, и CSS-анимация проигрывает её входом.
         Троеточие — отдельный блок внутри той же ячейки: оно не участвует в подмене слова и
         потому не перезапускается вместе с ним. -->
    <span ref="saidEl" class="said" :class="{ cut: wordCut }">
      <span :key="word" ref="wordEl" class="word">{{ word }}</span>
      <!-- Точки проявляются по одной — одна, две, три — и цикл идёт заново. Блок всегда
           занимает место всех трёх, поэтому счётчик времени и расход не дёргаются. -->
      <span class="dots" aria-hidden="true">
        <span class="dot">.</span>
        <span class="dot">.</span>
        <span class="dot">.</span>
      </span>
    </span>
    <!-- Факты подписаны знаками, а не словами: секундомер у времени, монета у расхода —
         строка остаётся короткой, а два числа рядом не путаются между собой. Знаки
         декоративные (aria-hidden): смысл чисел объясняют подсказки v-tooltip. -->
    <span v-if="elapsed" class="fact" v-tooltip="ELAPSED_HINT">
      <svg class="fico" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="13.5" r="7.5" />
        <path d="M12 9.6v3.9l2.6 1.6" />
        <path d="M9.6 2.6h4.8" />
      </svg>{{ elapsed }}
    </span>
    <span v-if="tokensText" class="fact tok" v-tooltip="tokensHint">
      <svg class="fico" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="8.6" />
        <circle cx="12" cy="12" r="3.4" />
      </svg>{{ tokensText }}<span class="tok-unit">{{ t('core.chatThinkingTokens') }}</span>
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import {
  THINKING_WORDS, formatElapsed, formatTurnTokens, formatTurnTokensShort, shuffledOrder, thinkingWord,
} from './chatThinking.ts';
import { vTooltip, t } from '../../ui';

// Живая строка идущего хода. Три факта рядом: чем агент занят сейчас (слово), сколько
// ход идёт (по часам ЭТОГО окна) и сколько токенов вывода он потратил (если исполнитель
// их публикует). Слово меняется раз в WORD_MS — иначе «думаю» выглядит застывшим.
const props = withDefaults(defineProps<{
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

const WORD_MS = 4_000;
const TICK_MS = 1_000;

const ELAPSED_HINT = computed(() => t('core.chatSkolkoIdetEtotHod'));

const mountedAt = ref(Date.now());
const now = ref(mountedAt.value);
let timer: ReturnType<typeof setInterval> | null = null;

// Слово выбирается по номеру «четвёрки секунд» с момента открытия строки: тик — не
// состояние, а функция от времени, поэтому строка не копит счётчики между ходами.
// Порядок слов тасуется один раз на ход (строка живёт ровно ход): без повторов подряд,
// и соседние ходы начинаются с разных слов.
const order = shuffledOrder(THINKING_WORDS.length);
const tick = computed(() => Math.floor((now.value - mountedAt.value) / WORD_MS));
const word = computed(() => thinkingWord(props.steps, tick.value, order));
const elapsed = computed(() => formatElapsed(props.startedAt, now.value));
// В строке — короткая запись («113 тыс.»), точное число — в подсказке.
const tokensText = computed(() => formatTurnTokensShort(props.tokens, props.tokensEstimate));
const tokensHint = computed(() => {
  const value = formatTurnTokens(props.tokens, props.tokensEstimate).replace('≈ ', '≈');

  return t('core.chatTokenshintValue', { tOKENSHINT: t('core.chatVyhodTekuschegoHoda'), value });
});

// Слово, не влезшее в ячейку, уже кончается многоточием обрезки — анимированные точки
// после него дали бы второе («Работаю с инструме… ...»). Поэтому обрезанное слово точки
// прячет. Замер — только на смене слова и ширины ячейки, а не на своём же переключении:
// спрятанные точки освобождают место, и замер по нему качал бы строку туда-обратно.
const saidEl = ref<HTMLElement | null>(null);
const wordEl = ref<HTMLElement | null>(null);
const wordCut = ref(false);
let saidObserver: ResizeObserver | null = null;
let saidWidth = 0;

// Замер с чистого листа: точки сначала возвращаются, чтобы слово мерилось в той же
// ячейке, в какой его увидит человек, и только потом решается, прятать ли их снова.
async function measureWord(): Promise<void> {
  wordCut.value = false;
  await nextTick();

  const element = wordEl.value;

  wordCut.value = Boolean(element && element.scrollWidth > element.clientWidth + 1);
}

watch(word, () => {
  void measureWord();
});

onMounted(() => {
  timer = setInterval(() => {
    now.value = Date.now();
  }, TICK_MS);

  if (saidEl.value && typeof ResizeObserver !== 'undefined') {
    saidObserver = new ResizeObserver(([entry]) => {
      if (!entry) {
        return;
      }

      const width = Math.round(entry.contentRect.width);

      if (width !== saidWidth) {
        saidWidth = width;
        void measureWord();
      }
    });
    saidObserver.observe(saidEl.value);
  }
});
onUnmounted(() => {
  if (timer) {
    clearInterval(timer);
  }

  timer = null;
  saidObserver?.disconnect();
  saidObserver = null;
});
</script>

<style scoped>
/* Строка — последняя в блоке идущего хода, сразу под лентой шагов (см. ChatSession), и
   читается как ещё одна её строка: ни подложки, ни жирного шрифта. Столбцы — как у строки
   шага (StepList): её кнопка несёт поле 4px и рамку 1px, отсюда вставка 5px; дальше столбец
   знака 15px и зазор 7px, чтобы знак стоял под знаками шагов, а слово — под их заголовками
   (замер: знак 582 = 582, слово 604 = 604). Ряд всегда один: перенос менял бы высоту блока
   на смене слова, и переписка «скакала» бы.
   Слово, точки и числа стоят на ОДНОЙ базовой линии. Она сохраняет выравнивание и с общим
   кеглем строки сведений, и с исходными размерами при отдельном использовании индикатора. */
.think {
  display: flex;
  flex-wrap: nowrap;
  align-items: baseline;
  gap: 7px;
  min-width: 0;
  max-width: 100%;
  padding: 2px 5px;
  font-size: var(--chat-status-font-size, 12.5px);
  line-height: 1.4;
  color: var(--ink-mid);
}

/* Мозг — знак хода в столбце знака строки шага: столбец 15px, знак по его центру.
   Появляется один раз, когда ход начался. Базовая линия строки для знака не годится
   (у SVG она проходит по нижнему краю) — знак центруем по строке. */
.brain-wrap {
  display: flex;
  flex: none;
  justify-content: center;
  width: 15px;
  align-self: center;
  animation: brain-in .45s ease-out both;
}
@keyframes brain-in {
  from { opacity: 0; transform: scale(.7); }
  to { opacity: 1; transform: none; }
}

/* Дальше — только дыхание прозрачностью: размер не меняем, иначе знак дрожит. */
.brain {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: var(--accent);
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
  animation: brain-pulse 2.4s ease-in-out infinite;
}
@keyframes brain-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: .68; }
}

/* Слово с троеточием — одна ячейка строки: точки должны стоять вплотную к слову, а не
   через общий зазор, и сидеть с ним на одной базовой линии. Ячейка уступает место фактам:
   в узкой колонке усекается слово, а троеточие и числа остаются целыми.
   Ширина ячейки зарезервирована под самые длинные штатные слова («Выполняю команду» и
   «Жду твоего ответа» с точками — 146 и 144 px по замеру, резерв 12em = 150): слово
   меняется каждые четыре секунды, и без резерва числа справа ездили бы вслед за ним.
   Более длинное слово (MCP-сервер) ячейку растянет, а в узкой колонке (док открыт) резерв
   уступает фактам — не больше трети строки. */
.said {
  display: flex;
  align-items: baseline;
  min-width: min(12em, 35%);
}

.word {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--ink);
  font-size: var(--chat-status-font-size, 13px);
  animation: word-in .3s ease both;
}
/* Вход слова — сдвигом ВВЕРХ на 2px, внутри собственного поля строки. Сдвиг вниз на 3px
   на один кадр вылезал за нижний край прокручиваемой ленты: scrollHeight рос на 1px и
   возвращался, и вся переписка вздрагивала на каждой смене слова (замер: 1414 → 1415 → 1414). */
@keyframes word-in {
  from { opacity: 0; transform: translateY(-2px); }
  to { opacity: 1; transform: none; }
}

/* Троеточие: первая точка видна всегда, вторая включается на второй трети цикла, третья —
   на последней. Ширина блока при этом не меняется вовсе, поэтому время и расход стоят
   на месте; step-end держит точки, а не размазывает их появлением. */
.dots {
  display: flex;
  flex: none;
}
.said.cut .dots { display: none; }
.dot {
  animation-duration: 1.5s;
  animation-timing-function: step-end;
  animation-iteration-count: infinite;
}
.dot:nth-child(2) { animation-name: dot-second; }
.dot:nth-child(3) { animation-name: dot-third; }
@keyframes dot-second {
  0% { opacity: 0; }
  33.33% { opacity: 1; }
  100% { opacity: 1; }
}
@keyframes dot-third {
  0% { opacity: 0; }
  66.66% { opacity: 1; }
  100% { opacity: 1; }
}

/* Числа — табличными цифрами: иначе строка дёргается на каждом тике секунд. Кегль
   мельче слова, цвет тише: это фон хода, а не ответ, — но ярче сведений справа
   (ChatStatusBar), потому что время и расход меняются на глазах. Зазор между словом и
   числами чуть шире зазора столбцов (7 + 2): числа — отдельные факты. */
.fact {
  flex: none;
  margin-left: 2px;
  font-size: 11.5px;
  color: color-mix(in srgb, var(--ink-mid) 72%, var(--surface));
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* Знак факта стоит в тексте, а не отдельным flex-элементом: так факт остаётся текстовым
   узлом и держит общую базовую линию строки. Кегль знака — как у цифр, линия — как у мозга,
   цвет наследует приглушённый цвет факта. */
.fico {
  width: 11px;
  height: 11px;
  margin-right: 3px;
  vertical-align: -1px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* Телефон: резерв ячейки слова в одну колонку не помещается вместе с двумя фактами —
   слово усекается многоточием, а числа остаются на месте. */
@media (max-width: 759px) {
  .said { min-width: 0; }
}

@media (prefers-reduced-motion: reduce) {
  .brain-wrap { animation: none; }
  .brain { animation: none; }
  .word { animation: none; }
  .think .dots .dot { animation: none; }
}
</style>

<script setup>
// Фигурка компаньона — ОДИН источник рисунка на обе поверхности. Вариантов два:
// `figure` — плавающий аватар (объём, визор, мимика), `mark` — знак в топбаре,
// упрощённый до контура в том же весе линии, что знаки исполнителей рядом.
defineProps({
  variant: { type: String, default: 'figure' },
  interaction: { type: String, default: 'idle' },
  attention: { type: String, default: 'none' },
});
</script>

<template>
  <svg
    class="companion-robot"
    :class="[variant, `is-${interaction}`, `attention-${attention || 'none'}`]"
    :viewBox="variant === 'mark' ? '0 0 24 24' : '0 0 64 64'"
    fill="none"
    aria-hidden="true"
  >
    <template v-if="variant === 'mark'">
      <rect class="shell-line" x="3.6" y="5" width="16.8" height="15.4" rx="5.4" />
      <path class="ear-line" d="M1.7 11.2v3.6M22.3 11.2v3.6" />
      <rect class="eye eye-l" x="6.9" y="10" width="2.7" height="5.6" rx="1.35" />
      <rect class="eye eye-r" x="14.4" y="10" width="2.7" height="5.6" rx="1.35" />
    </template>
    <template v-else>
      <defs>
        <linearGradient id="companion-shell" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="var(--robot-top)" />
          <stop offset="1" stop-color="var(--robot-bottom)" />
        </linearGradient>
      </defs>
      <!-- Тень под собой: он СТОИТ, а не висит. Без неё фигурка читается наклейкой. -->
      <ellipse class="ground" cx="32" cy="58.5" rx="16" ry="3.2" />
      <rect class="ear" x="5.5" y="27" width="5" height="13" rx="2.5" />
      <rect class="ear" x="53.5" y="27" width="5" height="13" rx="2.5" />
      <rect class="shell" x="9" y="11" width="46" height="45" rx="18" fill="url(#companion-shell)" />
      <path class="gloss" d="M16 20c3-5 9-7.5 16-7.5S45 15 48 20c-8-4-24-4-32 0Z" />
      <rect class="visor" x="14" y="20" width="36" height="24" rx="11.5" />
      <rect class="eye eye-l" x="21.5" y="25" width="6" height="14" rx="3" />
      <rect class="eye eye-r" x="36.5" y="25" width="6" height="14" rx="3" />
    </template>
  </svg>
</template>

<style scoped>
/* Фигурка монохромна через currentColor — цвет задаёт место (везде это основной
   синий кокпита). Цветной точки-маячка нет вовсе: она дублировала чип рядом и
   читалась раздражителем. Состояние несёт движение, количество — чип, слова — тултип. */
.companion-robot {
  --robot-top: #2b3646;
  --robot-bottom: #141a24;
  display: block;
  overflow: visible;
}
.eye { fill: currentColor; }
.eye { transform-box: fill-box; transform-origin: center; }

/* Знак топбара: контур того же веса, что у соседних знаков исполнителей. */
.mark .shell-line { stroke: currentColor; stroke-width: 1.8; fill: none; }
.mark .ear-line { stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; }

/* Аватар: объём вместо плоской заливки — градиент бока, блик по верхней кромке,
   утопленный тёмный визор. Полоски светятся узко: широкий ореол размывал силуэт. */
.figure .shell { stroke: color-mix(in srgb, currentColor 62%, var(--ground)); stroke-width: 2; }
.figure .gloss { fill: #ffffff14; }
.figure .visor { fill: #0b0f16; stroke: color-mix(in srgb, currentColor 26%, var(--ground)); stroke-width: 1.2; }
.figure .ear { fill: color-mix(in srgb, var(--surface-2) 40%, currentColor); }
.figure .ground { fill: #000; opacity: .55; filter: blur(2.5px); }
.figure .eye { filter: drop-shadow(0 0 1.2px currentColor); }
/* Мимика — только «глаза»: лица у робота нет, поэтому пугать нечем.
   В знаке 15px её нет вовсе — там она читалась бы дрожанием, а не состоянием. */
.figure .eye { transition: transform .18s ease; }
.figure.is-listening .eye { transform: scaleY(1.16); }
.figure.is-transcribing .eye, .figure.is-thinking .eye { transform: scaleY(.52); }
.figure.is-idle .eye { animation: companion-blink 7s ease-in-out infinite; }
.figure.is-speaking .eye { animation: companion-speak 1.05s ease-in-out infinite; }
.figure.is-thinking .eye-l, .figure.is-transcribing .eye-l { animation: companion-dim 1.5s ease-in-out infinite; }
.figure.is-thinking .eye-r, .figure.is-transcribing .eye-r { animation: companion-dim 1.5s ease-in-out .75s infinite; }
@keyframes companion-blink { 0%, 90%, 100% { transform: scaleY(1); } 94%, 96% { transform: scaleY(.16); } }
@keyframes companion-speak { 50% { transform: scaleY(.78); } }
@keyframes companion-dim { 50% { opacity: .55; } }
@media (prefers-reduced-motion: reduce) {
  .eye { transition: none; animation: none !important; }
}
</style>

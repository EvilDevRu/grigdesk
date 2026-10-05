<template>
  <!-- Экран входа: рейки ещё нет, а API версии закрыт сессией, поэтому остаётся одно
       громкое состояние — полоса «сборка готова». Она внизу, там же, где после входа
       стоит плитка: обновление всегда живёт снизу. -->
  <aside
    v-if="standalone && pwa.needRefresh"
    class="version-strip"
    role="status"
    aria-live="polite"
  >
    <UiPressable
      data-context="cockpit-version-strip"
      :loading="pwa.updating"
      :aria-label="REFRESH_HINT"
      v-tooltip="REFRESH_HINT"
      @click="pwa.doUpdate()"
    >
      <svg class="version-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path :d="REFRESH_ICON" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
              stroke-linejoin="round" />
      </svg>
      <span class="version-label">{{ refreshLabel }}</span>
    </UiPressable>
  </aside>

  <!-- В рейке плитка постоянная: меняются только цвет, знак и подпись, поэтому конец
       рейки не прыгает, когда сборка готова. Живая область объявляет смену состояния. -->
  <span
    v-else-if="!standalone"
    class="version-tile"
    :class="`is-${view.kind}`"
    role="status"
    aria-live="polite"
  >
    <!-- Громко: один клик перезапускает вкладку, как в Телеграме. Всплывашка с версиями
         здесь не нужна — про них рассказывает подсказка. -->
    <UiTooltip v-if="view.kind === 'refresh'" placement="top-start" :text="REFRESH_HINT">
      <template #trigger>
        <UiPressable
          data-context="cockpit-version"
          :class="view.kind"
          :loading="pwa.updating"
          :aria-label="REFRESH_HINT"
          @click="pwa.doUpdate()"
        >
          <span class="version-mark">
            <svg class="version-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path :d="REFRESH_ICON" stroke="currentColor" stroke-width="1.8"
                    stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </span>
          <!-- Плитке телефона хватает одного слова: «Обновить кокпит» в 62px не влезает. -->
          <span class="version-label version-label-full">{{ refreshLabel }}</span>
          <span class="version-label version-label-short">{{ refreshShortLabel }}</span>
        </UiPressable>
      </template>
    </UiTooltip>

    <!-- Тихо: версия и точка состояния; во время установки — стадия со спиннером.
         Всплывашка та же, что раньше жила у ◧ в топбаре. -->
    <UiPopover
      v-else
      trigger-mode="both"
      focus-policy="none"
      placement="top-start"
      :style="{ maxWidth: 'min(340px, calc(100vw - 20px))' }"
    >
      <template #trigger>
        <UiPressable
          data-context="cockpit-version"
          :class="view.kind"
          :aria-label="view.title"
          v-tooltip="view.title"
        >
          <span class="version-mark">
            <UiSpinner v-if="view.kind === 'busy'" role="standalone" decorative />
            <!-- «◧» рисуем SVG: текстовый глиф сидел ниже геометрического центра. -->
            <svg v-else class="version-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 5h7v14H5z" fill="currentColor" />
              <rect x="5" y="5" width="14" height="14" fill="none" stroke="currentColor"
                    stroke-width="1.8" />
            </svg>
            <span v-if="view.dot" class="version-dot" aria-hidden="true"></span>
          </span>
          <span class="version-label" :class="{ mono: view.mono }">{{ view.label }}</span>
        </UiPressable>
      </template>

      <template #default="{ close }">
        <span class="version-popover">
          <b>{{ view.title }}</b>
          <template v-if="status">
            <span>
              Запущено: {{ status.running.version }} ·
              <span class="mono">{{ shortSha(status.running.sha) }}</span>
            </span>
            <span v-if="status.checkoutChanged || status.checkout.dirty">
              Checkout: {{ status.checkout.version }} ·
              <span class="mono">{{ shortSha(status.checkout.sha) }}</span> ·
              {{ status.checkout.branch || 'detached HEAD' }}<template v-if="status.checkout.dirty"> · dirty</template>
            </span>
            <span v-if="status.latest">Доступно: {{ status.latest.tag }}</span>
            <span class="version-popover-muted">Проверено: {{ checkedLabel(status.checkedAt) }}</span>
            <span v-if="status.checkError" class="version-popover-warn">
              {{ status.checkError.message }}
            </span>
            <span v-if="status.installBlockReasons?.length" class="version-popover-muted">
              {{ blockReasonLabel(status.installBlockReasons[0]) }}
            </span>
          </template>
          <span v-else class="version-popover-muted">Версия ещё не получена от сервера.</span>
          <span class="version-popover-footer">
            <UiButton
              block
              data-context="topbar-popover-footer"
              variant="outline"
              @click="close('action'); toCockpitSettings()"
            >
              Настройки обновления
            </UiButton>
          </span>
        </span>
      </template>
    </UiPopover>
  </span>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { ReleaseStatus, UpdateJob } from '../../../../shared/cockpitUpdateContracts.ts';
import { usePwaStore } from '../../stores/pwa.js';
import {
  UPDATE_STAGE_LABELS,
  UPDATE_STAGE_SHORT_LABELS,
  blockReasonLabel,
  useCockpitUpdateStore,
} from '../../stores/cockpit-update.js';
import { UiButton, UiPopover, UiPressable, UiSpinner, UiTooltip, vTooltip } from '../../ui';

type TileKind = 'refresh' | 'busy' | 'idle' | 'release' | 'checkout' | 'error';

interface TileView {
  kind: TileKind;
  label: string;
  title: string;
  mono: boolean;
  dot: boolean;
}

// Экран входа рисует только громкое состояние: рейки там нет, а API версии закрыт.
withDefaults(defineProps<{ standalone?: boolean }>(), { standalone: false });

const REFRESH_ICON = 'M20 7v5h-5 M4 17v-5h5 M6.1 8.2A7 7 0 0 1 18.7 7 M17.9 15.8A7 7 0 0 1 5.3 17';
const REFRESH_HINT = 'Новая сборка интерфейса уже загружена. Нажми, чтобы перезапустить вкладку.';
const TONE_TITLES: Record<string, string> = {
  error: 'Последнее обновление Cockpit завершилось ошибкой',
  checkout: 'Checkout Cockpit изменился после запуска сервера',
  release: 'Доступен новый стабильный релиз Cockpit',
};
const STAGE_LABELS: Record<string, string> = UPDATE_STAGE_LABELS;
const STAGE_SHORT_LABELS: Record<string, string> = UPDATE_STAGE_SHORT_LABELS;

const pwa = usePwaStore();
const cockpitUpdate = useCockpitUpdateStore();
// Стор ещё на JavaScript и не знает формы снимка; контракт общий с сервером.
const status = computed(() => cockpitUpdate.status as ReleaseStatus | null);
const router = useRouter();

const refreshLabel = computed(() => (pwa.updating ? 'Обновляю…' : 'Обновить кокпит'));
const refreshShortLabel = computed(() => (pwa.updating ? 'Обновляю…' : 'Обновить'));

/**
 * Одна плитка — весь путь обновления. Приоритет от громкого к тихому: готовая сборка
 * важнее идущей установки, установка важнее точки «есть релиз», а без новостей плитка
 * просто называет запущенную версию. Пока снимок не пришёл, подпись пустая: высота
 * плитки от неё не зависит, и рейка не дёрнется при загрузке.
 */
const view = computed<TileView>(() => {
  if (pwa.needRefresh) {
    return {
      kind: 'refresh',
      label: '',
      title: REFRESH_HINT,
      mono: false,
      dot: false,
    };
  }

  const job = status.value?.job;

  if (job && cockpitUpdate.active) {
    const stage = job.stage || job.status;
    const full = STAGE_LABELS[stage] || stage;

    return {
      kind: 'busy',
      label: STAGE_SHORT_LABELS[stage] || full,
      title: `Обновление: ${full}`,
      mono: false,
      dot: false,
    };
  }

  const tone = String(cockpitUpdate.tone || '');

  return {
    kind: (tone || 'idle') as TileKind,
    label: status.value?.running?.version || '',
    title: TONE_TITLES[tone] || 'Версия Cockpit актуальна',
    mono: true,
    dot: Boolean(tone),
  };
});

const shortSha = (sha: string | null | undefined): string => sha?.slice(0, 7) || '—';

/**
 * Момент последней проверки релизов по-русски и коротко. Исходная ISO-строка остаётся
 * запасным вариантом: сломанная дата не должна ронять всплывашку.
 */
function checkedLabel(value: string | null | undefined): string {
  if (!value) {
    return 'ещё не проверялось';
  }

  try {
    return new Intl.DateTimeFormat('ru', { dateStyle: 'short', timeStyle: 'short' })
      .format(new Date(value));
  } catch {
    return value;
  }
}

function toCockpitSettings(): void {
  localStorage.setItem('cockpit-settings-tab', 'server');
  router.push('/settings');
}

// Серверный воркер докатил новый web/dist и перезапустил кокпит: просим регистрацию
// проверить service worker сейчас, а не через страховочные 30 секунд. Плитка стоит на
// каждой странице, поэтому «Обновить кокпит» загорается где бы человек ни был.
watch(() => status.value?.job ?? null, (job: UpdateJob | null, previous: UpdateJob | null) => {
  const finished = job?.status === 'done'
    && previous?.id === job.id
    && previous.status !== 'done';

  if (finished) {
    pwa.checkForUpdate();
  }
});
</script>

<style scoped>
.version-tile {
  display: block;
  width: 100%;
  min-width: 0;
}

.version-mark {
  position: relative;
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 19px;
  height: 19px;
}

.version-icon {
  width: 18px;
  height: 18px;
  flex: none;
}

/* Точка состояния сидит на углу знака, как чипы у пунктов навигации: так она видна
   и в свёрнутой рейке, где подписи нет. */
.version-dot {
  position: absolute;
  top: -3px;
  right: -4px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
  border: 2px solid var(--sidebar);
  box-sizing: content-box;
}

/* Тон состояния красит только знак с точкой; подпись остаётся тихой, чтобы цвет
   читался как сигнал, а не как подсветка строки. Цвета те же, что у точки в настройках. */
.is-release .version-mark {
  color: var(--warn, #e0a33a);
}

.is-checkout .version-mark {
  color: var(--accent);
}

.is-error .version-mark {
  color: var(--bad);
}

.version-label {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.version-label-short {
  display: none;
}

/* Узкая рейка (свёрнутая или планшетная) оставляет только знак: подпись читается
   из title и всплывашки. Порог — ширина самой рейки, а не окна: так плитка идёт за
   раскладкой AppShell при любом способе сжатия. */
@container rail (max-width: 100px) {
  .version-label {
    display: none;
  }
}

.version-popover {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 260px;
  text-align: left;
}

.version-popover-muted {
  font-size: 10.5px;
  color: var(--ink-mid);
}

.version-popover-warn {
  padding-top: 7px;
  border-top: 1px solid var(--line);
  font-size: 11px;
  line-height: 1.45;
  color: var(--warn);
}

/* Переход в настройки остаётся полосой во всю ширину: это единственное действие
   всплывашки, сжимать его в иконку нечего ради. */
.version-popover-footer {
  display: flex;
  padding-top: 8px;
  border-top: 1px solid var(--line);
}

.version-strip {
  position: fixed;
  inset: auto 0 0;
  z-index: 200;
  display: flex;
  padding-bottom: env(safe-area-inset-bottom, 0px);
  border-top: 1px solid color-mix(in srgb, var(--accent) 44%, var(--line));
  background: var(--topbar);
}

/* Нижний ряд телефона: подпись уходит под знак, как у соседних пунктов навигации. */
@media (max-width: 759px) {
  .version-tile {
    width: auto;
  }

  .version-label {
    max-width: 58px;
  }

  .version-label-full {
    display: none;
  }

  .version-label-short {
    display: block;
  }
}
</style>

<template>
  <aside
    v-if="pwa.needRefresh"
    class="update-notice"
    :class="{ 'is-standalone': standalone }"
    role="status"
    aria-live="polite"
  >
    <UiButton
      class="update-action"
      variant="text"
      tone="accent"
      :loading="pwa.updating"
      loading-label="Обновляю"
      aria-label="Доступно обновление. Применить"
      title="Применить доступное обновление"
      @click="pwa.doUpdate()"
    >
      <template #leading>
        <svg class="update-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M20 7v5h-5 M4 17v-5h5 M6.1 8.2A7 7 0 0 1 18.7 7 M17.9 15.8A7 7 0 0 1 5.3 17"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </template>
      <span class="update-action-label">Доступно обновление</span>
    </UiButton>
  </aside>
</template>

<script setup>
import { usePwaStore } from '../../stores/pwa.js';
import { UiButton } from '../../ui';

// Внутри AppShell уведомление занимает место в топбаре. На экране входа тот же компонент
// становится самостоятельной верхней полосой: обновление service worker не требует сессии.
defineProps({
  standalone: {
    type: Boolean,
    default: false,
  },
});

const pwa = usePwaStore();
</script>

<style scoped>
.update-notice {
  display: inline-flex;
  flex: none;
  align-items: center;
  min-width: 0;
  white-space: nowrap;
}

.update-icon {
  width: 13px;
  height: 13px;
}

.update-notice.is-standalone {
  position: fixed;
  inset: 0 0 auto;
  z-index: 200;
  justify-content: center;
  height: 54px;
  padding: 0 16px;
  border-bottom: 1px solid var(--line);
  background: var(--topbar);
  color: var(--ink);
}

/* Весь планшетный диапазон AppShell уже работает с компактными рейками. Длинная
   подпись здесь переполняет системную часть топбара, поэтому оставляем только знак. */
@media (max-width: 1099px) {
  .update-notice:not(.is-standalone) .update-action-label {
    display: none;
  }
}
</style>

<script setup>
// Баннер «доступно обновление» — вынесен из AppShell намеренно.
//
// Причина: AppShell рендерится только после входа, а service worker может держать старую
// сборку и на ЭКРАНЕ ВХОДА. Если баннер живёт внутри оболочки, обновить приложение оттуда
// нечем — кнопки просто нет, и залипшая версия не лечится из интерфейса.
// Сам механизм обновления авторизации не требует: он работает с service worker'ом,
// а не с API (`sw.js` отдаётся как публичная статика).
import { usePwaStore } from '../../stores/pwa.js';

const pwa = usePwaStore();
</script>

<template>
  <div v-if="pwa.needRefresh" class="updbar">
    <span>Доступно обновление кокпита</span>
    <button :disabled="pwa.updating" @click="pwa.doUpdate()">
      <span v-if="pwa.updating" class="spin"></span>{{ pwa.updating ? 'Обновляю…' : 'Обновить' }}
    </button>
  </div>
</template>

<style scoped>
.updbar {
  position: fixed; top: 14px; left: 50%; transform: translateX(-50%); z-index: 200;
  display: flex; align-items: center; gap: 12px;
  background: var(--accent); color: #fff; border-radius: 999px;
  padding: 8px 10px 8px 18px; font-size: 13px; box-shadow: 0 8px 26px #0009;
}
.updbar button {
  display: flex; align-items: center; gap: 7px;
  background: #fff; color: var(--accent); border: none; border-radius: 999px;
  padding: 6px 14px; font-size: 13px; font-weight: 600; cursor: pointer;
}
.updbar button:disabled { opacity: .7; cursor: default; }
.spin {
  width: 12px; height: 12px; border-radius: 50%;
  border: 2px solid #5aa2ff59; border-top-color: var(--accent);
  animation: sp .7s linear infinite;
}
@keyframes sp { to { transform: rotate(360deg); } }
</style>

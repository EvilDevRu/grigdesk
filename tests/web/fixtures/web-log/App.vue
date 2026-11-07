<template>
  <div class="shell">
    <header class="topbar">
      <strong>Fixture</strong>
      <button id="explode" type="button" @click="explode">Сломать обработчик</button>
    </header>
    <main>
      <router-view />
    </main>
  </div>
</template>

<script setup lang="ts">
// Обработчик нарочно бросает: журнал должен записать vue.error с источником
// native-event и именем компонента, а консоль — по-прежнему показать ошибку.
function explode(): void {
  throw new Error('synthetic_handler_failure');
}
</script>

<style>
html, body, #app { margin: 0; min-height: 100%; }
.topbar { display: flex; gap: 12px; align-items: center; padding: 8px; background: #eee; }
main { padding: 16px; }
</style>

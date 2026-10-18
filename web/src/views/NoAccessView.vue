<template>
  <main class="no-access">
    <h1>Нет входа</h1>
    <p>GrigDesk открывается в приложении.</p>
    <p>Закройте и снова запустите приложение — оно войдёт заново по ключу.</p>
  </main>
</template>

<script setup lang="ts">
defineOptions({ name: 'NoAccessView' });
</script>

<style scoped>
.no-access {
  display: grid;
  min-height: 100dvh;
  place-content: center;
  padding: 24px;
  text-align: center;
}
</style>

<template>
  <section class="route-conflict" role="alert">
    <strong>Черновик изменился в другой вкладке</strong>
    <p>Ваши несохранённые правки остались здесь. Можно сохранить их отдельной копией
      или перечитать версию сервера после подтверждения.</p>
    <div class="route-conflict__actions">
      <UiButton @click="$emit('copy')">Сохранить отдельной копией</UiButton>
      <UiButton @click="$emit('reload')">Перечитать</UiButton>
    </div>
  </section>
</template>

<script setup lang="ts">
import { UiButton } from '../../ui';

defineEmits<{ copy: []; reload: [] }>();
</script>

<style scoped>
.route-conflict { border: 1px solid var(--bad); border-radius: 8px; padding: 12px; }
.route-conflict p { margin: 6px 0 10px; }
.route-conflict__actions { display: flex; flex-wrap: wrap; gap: 8px; }
</style>

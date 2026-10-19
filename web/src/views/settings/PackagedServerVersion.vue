<template>
  <div data-testid="packaged-server-version">
    <p>Версия сервера: <b>{{ version }}</b></p>
    <p>Интерфейс приложения: {{ clientVersion }}</p>
    <p>{{ message }}</p>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  version: string;
  clientVersion: string;
  message: string;
}>();
</script>

<template>
  <UiInlineMessage tone="danger"
    data-perf-error>
    Не удалось загрузить раздел. Закройте и снова запустите приложение.
    Если ошибка повторится, переустановите пакет приложения.
  </UiInlineMessage>
</template>

<script setup lang="ts">
import { UiInlineMessage } from '../ui.ts';
</script>

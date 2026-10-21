<template>
  <main class="no-access">
    <h1>{{ t('core.noAccess') }}</h1>
    <p>{{ t('core.grigdeskOpensInTheApplication') }}</p>
    <p>{{ t('core.closeAndRestartTheApplicationItWill') }}</p>
  </main>
</template>

<script setup lang="ts">
import { t } from '../ui.ts';

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

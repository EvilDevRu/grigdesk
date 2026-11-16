<template>
  <section class="route-conflict" role="alert">
    <strong>{{ t('core.routeChernovikIzmenilsyaVDrugoy') }}</strong>
    <p>{{ t('core.routeVashiNesohranennyePravkiOstalis') }}</p>
    <div class="route-conflict__actions">
      <UiButton @click="$emit('copy')">{{ t('core.routeSohranitOtdelnoyKopiey') }}</UiButton>
      <UiButton @click="$emit('reload')">{{ t('core.routePerechitat') }}</UiButton>
    </div>
  </section>
</template>

<script setup lang="ts">
import { UiButton, t } from '../../ui';

defineEmits<{ copy: []; reload: [] }>();
</script>

<style scoped>
.route-conflict { border: 1px solid var(--bad); border-radius: 8px; padding: 12px; }
.route-conflict p { margin: 6px 0 10px; }
.route-conflict__actions { display: flex; flex-wrap: wrap; gap: 8px; }
</style>

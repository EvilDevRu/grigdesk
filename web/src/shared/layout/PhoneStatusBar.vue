<template>
  <aside class="phone-status-bar" data-ui-phone-status :aria-label="t('core.systemStatus')">
    <div id="phone-status-metrics" class="phone-status-metrics-host"></div>
    <div id="phone-status-providers" class="phone-status-providers" role="group"
         :aria-label="t('settings.providers')"></div>
  </aside>
</template>

<script setup lang="ts">
import { t } from '../../ui.ts';
</script>

<template>
  <span v-if="providers.usageRefreshErrorId === providerId && providers.usageRefreshError"
    class="pu-state is-unavailable" role="alert" data-usage-refresh-error>
    {{ providers.usageRefreshError }}
  </span>
</template>

<script setup lang="ts">
import { useProvidersStore } from '../../stores/providers.ts';

defineProps<{ providerId: string }>();

const providers = useProvidersStore();
</script>

<template>
  <UiButton class="chat-context" variant="ghost" :aria-label="label" :title="label" @click="$emit('click')">
    <svg viewBox="0 0 24 24" aria-hidden="true" :data-known="percent !== null">
      <circle class="context-track" cx="12" cy="12" r="9" />
      <circle
        v-if="percent !== null"
        class="context-value"
        cx="12"
        cy="12"
        r="9"
        pathLength="100"
        :stroke-dasharray="`${Math.min(100, percent)} 100`"
        :data-tone="percent >= 95 ? 'bad' : percent >= 75 ? 'warn' : 'good'"
      />
      <text v-else x="12" y="16" text-anchor="middle">?</text>
    </svg>
  </UiButton>
</template>

<script setup lang="ts">
import UiButton from './UiButton.vue';

defineProps<{ percent: number | null; label: string }>();
defineEmits<{ click: [] }>();
</script>

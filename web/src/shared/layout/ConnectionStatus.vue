<template>
  <span class="connection-status" :data-status="disconnected ? 'none' : status">
    <span class="connection-status-dot" aria-hidden="true" />
    <span v-if="!compact">{{ text || CONNECTION_TEXT[status] }}</span>
  </span>
</template>

<script setup lang="ts">
import { CONNECTION_TEXT } from '../../../../shared/client/clientShell.ts';
import type { ConnectionStatus } from '../../../../shared/client/clientShell.ts';

withDefaults(defineProps<{
  status: ConnectionStatus;
  text?: string;
  compact?: boolean;
  disconnected?: boolean;
}>(), {
  text: '',
  compact: false,
  disconnected: false,
});
</script>

<style scoped>
.connection-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.4;
}

.connection-status-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.connection-status[data-status='online'] {
  color: var(--good);
}

.connection-status[data-status='offline'],
.connection-status[data-status='connecting'],
.connection-status[data-status='locked'] {
  color: var(--warn);
}

.connection-status[data-status='revoked'],
.connection-status[data-status='identityMismatch'],
.connection-status[data-status='incompatible'] {
  color: var(--bad);
}
</style>

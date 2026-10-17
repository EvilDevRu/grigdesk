<template>
  <SpeechProvider>
    <AppShell><router-view /></AppShell>
    <UiDialogHost />
    <UiTooltipHost />
    <UiToastHost />
  </SpeechProvider>
</template>

<script setup>
import AppShell from '../../../../web/src/shared/layout/AppShell.vue';
import { SpeechProvider } from '../../../../web/src/features/speech/provider.js';
import { UiDialogHost, UiTooltipHost, UiToastHost } from '../../../../web/src/ui.ts';
</script>

<template>
  <section>
    <p>Установка из git выполняется отдельно от применения параметров.</p>
    <p v-if="installer.job">Есть задание установки: {{ installer.job.status }}.</p>
    <p v-if="installer.recoveryError" role="alert">{{ installer.recoveryError.message }}</p>
    <UiButton @click="open = true">Открыть установку из git</UiButton>
    <PluginInstallDialog
      v-if="open"
      v-model:open="open"
      mode="install"
      :plugin="null"
    />
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { UiButton } from '../../../ui.ts';
import { usePluginInstallStore } from '../../../stores/pluginInstall.ts';
import PluginInstallDialog from '../PluginInstallDialog.vue';

const installer = usePluginInstallStore();
const open = ref(true);
</script>

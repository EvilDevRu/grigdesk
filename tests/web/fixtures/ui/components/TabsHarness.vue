<template>
  <UiTabs v-model="value" label="Разделы" :activation="activation">
    <UiTab value="first">Первый</UiTab>
    <UiTab value="second">Второй</UiTab>
    <UiTab value="off" disabled>Недоступный</UiTab>
  </UiTabs>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { UiTab, UiTabs, type UiTabsActivation } from '../../../../../web/src/ui';

withDefaults(defineProps<{ activation?: UiTabsActivation }>(), { activation: 'automatic' });
const value = ref<string | number>('first');
</script>

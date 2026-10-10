<template>
  <div class="chat-list-head" data-touch-density="compact">
    <div class="chat-list-search-row">
    <label class="list-search">
      <UiIcon name="search" />
      <input
        v-model="query"
        class="ui-input"
        type="search"
        :aria-label="archived ? 'Поиск в архиве' : 'Поиск чатов'"
        :placeholder="archived ? 'Поиск в архиве' : 'Поиск'"
      />
    </label>
      <UiButton class="chat-create" aria-label="Новый чат" @click="$emit('create')">
        <UiIcon name="plus" />
      </UiButton>
    </div>
    <UiSwitch v-model="archived" aria-label="Показывать архив">
      Показывать архив<span v-if="archiveCount"> · {{ archiveCount }}{{ partial ? '+' : '' }}</span>
    </UiSwitch>
  </div>
</template>

<script setup lang="ts">
import UiIcon from './UiIcon.vue';
import UiSwitch from './UiSwitch.vue';
import UiButton from './UiButton.vue';

defineEmits<{ create: [] }>();

const query = defineModel<string>('query', { default: '' });
const archived = defineModel<boolean>('archived', { default: false });

defineProps<{
  archiveCount: number;
  partial?: boolean;
}>();
</script>

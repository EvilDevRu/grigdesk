<template>
  <div class="list-tools">
    <label class="list-search">
      <UiIcon name="search" />
      <input
        v-model="query"
        class="ui-input"
        type="search"
        :aria-label="placeholder"
        :placeholder="placeholder"
      />
    </label>
    <div class="list-filters" role="group" aria-label="Фильтр списка">
      <UiButton
        v-for="option in filters"
        :key="option.value"
        variant="ghost"
        :aria-pressed="filter === option.value"
        @click="filter = option.value"
      >
        {{ option.label }}
      </UiButton>
      <span class="list-count" role="status">Найдено: {{ count }}</span>
    </div>
    <p v-if="partial" class="list-scope">Поиск по загруженным. Остальные — «Показать ещё».</p>
  </div>
</template>

<script setup lang="ts">
import UiButton from './UiButton.vue';
import UiIcon from './UiIcon.vue';

const query = defineModel<string>('query', { default: '' });
const filter = defineModel<string>('filter', { default: 'all' });

defineProps<{
  placeholder: string;
  count: number;
  partial?: boolean;
  filters: { value: string; label: string }[];
}>();
</script>

<template>
  <UiField label="Модель" required hint="Пояснение поля">
    <UiSelect searchable>
      <option value="">Без выбора</option>
      <option value="model">Модель</option>
      <template #header>
        <UiInput data-select-extra-field aria-label="Дополнительное поле" />
      </template>
    </UiSelect>
  </UiField>
</template>

<script setup lang="ts">
import { UiField, UiInput, UiSelect } from '../../../../../web/src/ui';
</script>

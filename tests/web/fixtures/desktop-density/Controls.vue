<template>
  <div>
    <UiInput v-model="value" label="Поле фикстуры" />
    <UiButton>Кнопка формы</UiButton>
    <UiSelect v-model="choice" data-context="chat-session-toolbar" label="Модель"
              >
      <option value="fixture">Синтетическая модель</option>
    </UiSelect>
    <ToolDock mode="dock" label="Синтетическая панель" :width="width" :expanded="expanded" :expanded-width="wide"
              @resize="width = $event" @resize-end="width = $event" @toggle-expanded="expand" :min-width="320" :max-width="800">
      <p>Содержимое фикстуры. Редактор и PTY не запускаются.</p>
    </ToolDock>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { UiInput, UiButton, UiSelect } from '../../../../web/src/ui.ts';
import ToolDock from '../../../../web/src/shared/layout/ToolDock.vue';

const value = ref('Синтетическое поле');
const width = ref(400);
const wide = ref(0);
const expanded = ref(false);

function expand() {
  wide.value = document.querySelector('.content').getBoundingClientRect().width;
  expanded.value = !expanded.value;
}

const choice = ref('fixture');
</script>

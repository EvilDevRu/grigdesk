<template>
  <main class="ui-gallery">
    <header class="ui-gallery__header">
      <p class="muted">Dev/test entry · без store, API и авторизации</p>
      <h1>UI-kit Cockpit</h1>
    </header>

    <section class="ui-gallery__section">
      <h2>Actions</h2>
      <div v-for="variant in variants" :key="variant" class="ui-gallery__row" data-geometry-row>
        <UiButton
          v-for="tone in tones"
          :key="tone"
          :variant="variant"
          :tone="tone"
        >{{ variant }} · {{ tone }}</UiButton>
      </div>
      <div class="ui-gallery__row" data-geometry-row>
        <UiButton loading>Стабильная загрузка</UiButton>
        <UiButton disabled>Disabled</UiButton>
        <UiButton aria-disabled>Aria disabled</UiButton>
        <UiButton pressed>Pressed</UiButton>
        <UiIconButton label="Обновить">↻</UiIconButton>
        <UiActionLink href="#gallery-fields">Action link</UiActionLink>
      </div>
    </section>

    <section id="gallery-fields" class="ui-gallery__section">
      <h2>Fields</h2>
      <div class="ui-gallery__grid">
        <UiField label="Обычное поле" hint="Подсказка связана через aria-describedby">
          <UiInput v-model="text" placeholder="Текст" />
        </UiField>
        <UiField label="Ошибка" error="Значение нужно исправить" required>
          <UiInput v-model="invalidText" />
        </UiField>
        <UiField label="Пароль"><UiPasswordInput v-model="password" /></UiField>
        <UiField label="Поиск"><UiSearchInput v-model="search" /></UiField>
        <UiField label="Число"><UiNumberField v-model="number" :min="0" :max="10" /></UiField>
        <UiField label="Select">
          <UiSelect v-model="selectValue">
            <option value="one">Первый вариант</option>
            <optgroup label="Группа"><option value="two">Второй вариант</option></optgroup>
          </UiSelect>
        </UiField>
        <UiField label="Многострочный текст">
          <UiTextarea v-model="longText" rows="4" />
        </UiField>
        <UiField label="Файл"><UiFilePicker multiple /></UiField>
      </div>
    </section>

    <section class="ui-gallery__section">
      <h2>Selection and patterns</h2>
      <div class="ui-gallery__row" data-geometry-row>
        <UiCheckbox v-model="checked">Checkbox</UiCheckbox>
        <UiSwitch v-model="switched">Switch</UiSwitch>
        <UiToggleButton v-model="toggled">Toggle</UiToggleButton>
      </div>
      <UiDiscreteSlider v-model="slider" :min="0" :max="2" :labels="sliderLabels" />
      <UiSegmentedControl v-model="segment" label="Режим" :options="segmentOptions" />
      <UiTabs v-model="tab" label="Пример вкладок">
        <UiTab value="first">Первая</UiTab>
        <UiTab value="second">Вторая</UiTab>
        <UiTab value="disabled" disabled>Недоступная</UiTab>
      </UiTabs>
      <UiChoiceList
        v-model="choice"
        label="Длинные варианты"
        :options="choiceOptions"
      />
      <UiProgress :value="62" label="Пример прогресса" value-text="62 процента" />
      <UiInlineMessage tone="warning">Busy региона не блокирует вложенные controls автоматически.</UiInlineMessage>
    </section>
  </main>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import {
  UiActionLink,
  UiButton,
  UiCheckbox,
  UiChoiceList,
  UiDiscreteSlider,
  UiField,
  UiFilePicker,
  UiIconButton,
  UiInlineMessage,
  UiInput,
  UiNumberField,
  UiPasswordInput,
  UiProgress,
  UiSearchInput,
  UiSegmentedControl,
  UiSelect,
  UiSwitch,
  UiTab,
  UiTabs,
  UiTextarea,
  UiToggleButton,
  type UiActionTone,
  type UiActionVariant,
  type UiSelectionOption,
} from '../../src/ui';

const variants: UiActionVariant[] = ['solid', 'outline', 'ghost', 'text'];
const tones: UiActionTone[] = ['neutral', 'accent', 'success', 'warning', 'danger'];
const text = ref('Cockpit');
const invalidText = ref('');
const password = ref('секрет');
const search = ref('длинная строка поиска');
const number = ref<number | '' | null>(4);
const selectValue = ref<string | number | null>('one');
const longText = ref('Многострочное содержимое остаётся многострочным.');
const checked = ref(true);
const switched = ref(true);
const toggled = ref(false);
const slider = ref(1);
const sliderLabels = { 0: 'Быстро', 1: 'Обычно', 2: 'Глубоко' };
const segment = ref<'one' | 'two'>('one');
const segmentOptions: Array<UiSelectionOption<'one' | 'two'>> = [
  { value: 'one', label: 'Один' },
  { value: 'two', label: 'Два' },
];
const tab = ref<string | number>('first');
const choice = ref<string | null>(null);
const choiceOptions: Array<UiSelectionOption<string>> = [
  { value: 'approve', label: 'Подтвердить план и продолжить выполнение' },
  { value: 'revise', label: 'Вернуть агенту с подробным замечанием, которое может занимать несколько строк' },
];
</script>

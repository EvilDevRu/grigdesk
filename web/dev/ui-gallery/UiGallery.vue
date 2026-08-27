<template>
  <main class="ui-gallery">
    <header class="ui-gallery__header">
      <p class="muted">Dev/test entry · без store, API и авторизации</p>
      <h1>UI-kit Cockpit</h1>
    </header>

    <section class="ui-gallery__section">
      <h2>Actions</h2>
      <div
        v-for="variant in variants"
        :key="variant"
        class="ui-gallery__row"
        data-geometry-row="peer"
      >
        <UiButton
          v-for="tone in tones"
          :key="tone"
          :variant="variant"
          :tone="tone"
        >{{ variant }} · {{ tone }}</UiButton>
      </div>
      <div class="ui-gallery__row" data-geometry-row="peer">
        <UiButton data-geometry-loading="idle">Стабильная загрузка</UiButton>
        <UiButton data-geometry-loading="active" loading>
          Стабильная загрузка
        </UiButton>
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
      <h2>Product compositions</h2>
      <article class="ui-gallery__ssh-card" data-geometry-ssh-card>
        <strong>Боевой код — server.internal:22</strong>
        <span>Пользователь: root · sudo</span>
        <pre data-geometry-ssh-command>{{ 'x'.repeat(10_000) + 'SSH_COMMAND_TAIL' }}</pre>
        <div class="ui-gallery__ssh-actions" data-geometry-ssh-actions>
          <UiButton variant="solid" tone="accent">Разрешить</UiButton>
          <UiButton tone="danger">Отказать</UiButton>
        </div>
      </article>
      <div class="ui-gallery__composer" data-geometry-composer>
        <UiTextarea
          v-model="composerText"
          aria-label="Сообщение агенту"
          data-role="chat-composer"
          data-geometry-composer-input
          rows="2"
        />
        <UiIconButton
          data-context="chat-context"
          data-geometry-context-ring
          label="Контекст: 44 процента"
          role="embedded"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle
              class="rbg"
              cx="12"
              cy="12"
              r="9"
              fill="none"
              stroke-width="3"
            />
            <circle
              class="rfg"
              cx="12"
              cy="12"
              r="9"
              fill="none"
              stroke-width="3"
              stroke-linecap="round"
              stroke-dasharray="56.5487"
              stroke-dashoffset="31.0918"
              transform="rotate(-90 12 12)"
            />
          </svg>
        </UiIconButton>
      </div>
      <div
        class="ui-gallery__dock-actions"
        data-geometry-row="compact"
        data-geometry-dock-actions
      >
        <UiButton
          data-context="tool-dock-navigator"
          data-geometry-dock-action="navigator"
          variant="ghost"
        >
          <template #leading>
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <rect x="2.5" y="3" width="15" height="14" rx="2" />
              <path d="M7 3v14" />
            </svg>
          </template>
          Дерево
        </UiButton>
        <UiIconButton
          data-context="tool-dock-expand"
          data-geometry-dock-action="expand"
          label="Во весь экран"
          role="embedded"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8 3H3v5 M16 3h5v5 M8 21H3v-5 M16 21h5v-5" />
          </svg>
        </UiIconButton>
        <UiIconButton
          data-context="tool-dock-hide"
          data-geometry-dock-action="hide"
          label="Скрыть панель"
          role="embedded"
          tone="danger"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12 M18 6 6 18" />
          </svg>
        </UiIconButton>
      </div>
      <div class="ui-gallery__chat-list-actions">
        <UiIconButton
          data-context="chat-list-new"
          data-geometry-chat-list-button="new"
          label="Новый чат"
          tone="accent"
        >
          ＋
        </UiIconButton>
        <UiIconButton
          data-context="chat-list-action"
          data-geometry-chat-list-button="rename"
          label="Переименовать чат"
          role="rail"
        >
          ✎
        </UiIconButton>
        <UiIconButton
          data-context="chat-list-action"
          data-geometry-chat-list-button="archive"
          label="Переместить чат в архив"
          role="rail"
          tone="accent"
        >
          ✕
        </UiIconButton>
      </div>
      <div class="ui-gallery__task-footer">
        <UiButton
          data-context="task-footer-action"
          data-geometry-task-footer-action="timer"
          tone="accent"
          variant="solid"
        >
          ▶ Начать учёт
        </UiButton>
        <UiButton
          data-context="task-footer-action"
          data-geometry-task-footer-action="complete"
          tone="success"
          variant="solid"
        >
          ✓ Завершить
        </UiButton>
        <UiButton
          data-context="task-footer-action"
          data-geometry-task-footer-action="diff"
        >
          ± Диф
        </UiButton>
      </div>
      <div class="ui-gallery__topbar-popover-actions">
        <UiButton
          data-context="topbar-popover-action"
          data-geometry-topbar-action
          variant="outline"
        >
          Использовать сброс лимита
        </UiButton>
        <UiButton
          block
          data-context="topbar-popover-footer"
          data-geometry-topbar-footer
          variant="outline"
        >
          Настройки исполнителей
        </UiButton>
      </div>
    </section>

    <section class="ui-gallery__section">
      <h2>Selection and patterns</h2>
      <div class="ui-gallery__row" data-geometry-row="flow">
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
      <UiDisclosureButton
        v-model:open="disclosureOpen"
        class="ui-gallery__disclosure"
        data-geometry-disclosure
        controls="gallery-disclosure-body"
        density="compact"
      >
        <span>
          Bash · полноширинная строка инструмента с длинным недоверенным заголовком
        </span>
      </UiDisclosureButton>
      <p v-if="disclosureOpen" id="gallery-disclosure-body">
        Содержимое раскрытой строки.
      </p>
      <UiProgress :value="62" label="Пример прогресса" value-text="62 процента" />
      <UiInlineMessage tone="warning">
        Busy региона не блокирует вложенные controls автоматически.
      </UiInlineMessage>
    </section>

    <section class="ui-gallery__section">
      <h2>Overlays</h2>
      <div class="ui-gallery__row" data-geometry-row="peer">
        <UiPopover
          class="ui-gallery__popover"
          data-geometry-provider-popover
          placement="bottom-end"
        >
          <template #trigger>
            <UiButton data-geometry-popover-trigger>Открыть popover</UiButton>
          </template>

          <div
            class="ui-gallery__provider-resource"
            data-geometry-popover-content
          >
            <span>Extra usage (доплата)</span>
            <UiSwitch
              v-model="providerUsageEnabled"
              data-geometry-provider-switch
            >
              доплата выключена
            </UiSwitch>
            <UiActionLink
              data-context="topbar-popover-resource-link"
              data-geometry-provider-link
              href="https://claude.ai/settings/billing"
              target="_blank"
              variant="text"
            >
              Карта, история и доплата без потолка — на claude.ai
            </UiActionLink>
          </div>
        </UiPopover>
        <UiButton
          data-geometry-dialog-trigger
          @click="dialogOpen = true"
        >
          Открыть диалог
        </UiButton>
      </div>

      <UiDialog
        v-model:open="dialogOpen"
        data-geometry-dialog
        title="Проверка геометрии"
        description="Диалог должен помещаться в каждый viewport матрицы."
        size="content"
      >
        <template #default="{ close }">
          <p class="ui-gallery__dialog-copy">
            Длинное содержимое не создаёт горизонтальный scroll и не обрезает focus ring.
          </p>
          <UiButton @click="close('action')">Закрыть</UiButton>
        </template>
      </UiDialog>
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
  UiDisclosureButton,
  UiDialog,
  UiField,
  UiFilePicker,
  UiIconButton,
  UiInlineMessage,
  UiInput,
  UiNumberField,
  UiPasswordInput,
  UiProgress,
  UiPopover,
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
const composerText = ref('Внутри составного composer-а нет второй рамки фокуса.');
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
const disclosureOpen = ref(false);
const dialogOpen = ref(false);
const providerUsageEnabled = ref(false);
const choiceOptions: Array<UiSelectionOption<string>> = [
  { value: 'approve', label: 'Подтвердить план и продолжить выполнение' },
  { value: 'revise', label: 'Вернуть агенту с подробным замечанием, которое может занимать несколько строк' },
];
</script>

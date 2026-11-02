<template>
  <span class="ui-select-wrap" :class="{ 'ui-select-wrap--compact': compact }">
    <select
      ref="element"
      v-bind="nativeAttrs"
      :id="controlId + '-native'"
      hidden
      aria-hidden="true"
      tabindex="-1"
      :value="model ?? ''"
      :disabled="disabled"
      :required="fieldState.required.value"
      @change="onChange"
      @invalid.prevent="onInvalid"
    >
      <slot />
    </select>

    <UiPopover
      :open="open"
      :style="popupStyle"
      :data-ui-workspace="workspaceMode || groupNavigation || undefined"
      :data-ui-touch="touchMode || undefined"
      :data-group-navigation="groupNavigation || undefined"
      :data-density="compact ? 'compact' : undefined"
      class="ui-select-popup"
      has-popup="dialog"
      focus-policy="none"
      :return-focus="false"
      :aria-label="pickerLabel"
      @update:open="setOpen"
      @close="onPopoverClose"
    >
      <template #trigger>
        <button
          ref="trigger"
          v-bind="triggerAttrs"
          :id="controlId"
          type="button"
          role="combobox"
          class="ui-select"
          :class="{ 'ui-select--compact': compact }"
          :disabled="disabled"
          :aria-disabled="ariaDisabled ? 'true' : undefined"
          :aria-required="fieldState.required.value ? 'true' : undefined"
          :aria-invalid="(fieldState.invalid.value || nativeInvalid) ? 'true' : undefined"
          :aria-describedby="fieldState.describedBy.value"
          @keydown="onTriggerKeydown"
          @focus="$emit('focus', $event)"
          @blur="$emit('blur', $event)"
        >
          <span v-if="$slots['value-leading']" class="ui-select__leading" aria-hidden="true">
            <slot name="value-leading" :option="selectedOption" :value="model" />
          </span>
          <span class="ui-select__label">
            <slot name="value" :option="selectedOption" :value="model">{{ selectedLabel }}</slot>
          </span>
        </button>
      </template>

      <div class="ui-select-panel" @keydown="onPopupTab">
        <div v-if="$slots.header" class="ui-select-header">
          <slot name="header" :close="closeFromAction" :value="model" />
        </div>
        <div v-if="showSearch" class="ui-select-search">
          <svg class="ui-select-search__icon" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="1.7" aria-hidden="true">
            <circle cx="10.5" cy="10.5" r="6.5" />
            <path d="m16 16 4.5 4.5" stroke-linecap="round" />
          </svg>
          <UiSearchInput
            ref="searchInput"
            v-model="query"
            data-context="select-search"
            :aria-label="t('core.search')"
            :placeholder="t('core.search')"
            :aria-controls="controlId + '-list'"
            :aria-activedescendant="activeId"
            role="combobox"
            aria-expanded="true"
            aria-autocomplete="list"
            @keydown="onSearchKeydown"
          />
        </div>
        <div
          v-if="groupNavigation && navigationGroups.length"
          class="ui-select-group-nav"
          role="group"
          :aria-label="t('core.selectGroups')"
        >
          <UiButton
            variant="ghost"
            size="compact"
            :pressed="effectiveGroupKey === null"
            :aria-label="t('core.selectAllGroups')"
            :title="t('core.selectAllGroups')"
            data-group-icon
            data-select-group="all"
            @click="selectGroup(null)"
          >
            <template #leading>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" stroke-width="1.7" aria-hidden="true">
                <rect x="3" y="3" width="6" height="6" rx="1" />
                <rect x="15" y="3" width="6" height="6" rx="1" />
                <rect x="3" y="15" width="6" height="6" rx="1" />
                <rect x="15" y="15" width="6" height="6" rx="1" />
              </svg>
            </template>
            {{ t('core.selectAllGroups') }}
            <span class="ui-select-group-nav__count">{{ options.length }}</span>
          </UiButton>
          <UiButton
            v-for="group in navigationGroups"
            :key="group.key"
            variant="ghost"
            size="compact"
            :pressed="effectiveGroupKey === group.key"
            :aria-label="group.label"
            :title="group.label"
            :data-group-icon="$slots['group-leading'] ? '' : undefined"
            :data-select-group="group.key"
            @click="selectGroup(group.key)"
          >
            <template v-if="$slots['group-leading']" #leading>
              <span aria-hidden="true"><slot name="group-leading" :option="group.option" /></span>
            </template>
            {{ group.label }}
            <span class="ui-select-group-nav__count">{{ group.count }}</span>
          </UiButton>
        </div>
        <div
          :id="controlId + '-list'"
          ref="list"
          class="ui-select-list"
          role="listbox"
          :aria-label="pickerLabel"
          :tabindex="showSearch && !touchMode ? -1 : 0"
          :aria-activedescendant="activeId"
          @keydown="onListKeydown"
        >
          <div
            v-for="group in optionGroups"
            :key="group.key"
            :role="group.label ? 'group' : undefined"
            :aria-label="group.label || undefined"
          >
            <div v-if="group.label && (!groupNavigation || effectiveGroupKey === null)"
                 class="ui-select-group" aria-hidden="true">{{ group.label }}</div>
            <button
              v-for="option in group.options"
              :id="controlId + '-option-' + option.index"
              :key="option.index"
              type="button"
              role="option"
              class="ui-select-option"
              tabindex="-1"
              :data-option-index="option.index"
              :data-active="option.index === activeIndex || undefined"
              :disabled="option.disabled"
              :aria-disabled="option.disabled ? 'true' : undefined"
              :aria-selected="option.value === String(model ?? '')"
              @mousemove="activate(option)"
              @click="choose(option)"
            >
              <span class="ui-select-option__content">
                <span v-if="$slots['option-leading']" class="ui-select-option__leading" aria-hidden="true">
                  <slot name="option-leading" :option="option" />
                </span>
                <span class="ui-select-option__text">
                  <slot
                    name="option"
                    :option="option"
                    :selected="option.value === String(model ?? '')"
                  >
                    <span class="ui-select-option__label">{{ option.label }}</span>
                    <span v-if="option.description" class="ui-select-option__description">
                      {{ option.description }}
                    </span>
                  </slot>
                </span>
              </span>
              <span
                v-if="option.value === String(model ?? '')"
                class="ui-select-option__check"
                aria-hidden="true"
              >✓</span>
            </button>
          </div>
          <p v-if="!visibleOptions.length" class="ui-select-empty" role="status">
            {{ t('core.selectNoResults') }}
          </p>
        </div>
        <div v-if="$slots.footer" class="ui-select-footer">
          <slot name="footer" :close="closeFromAction" :value="model" />
        </div>
      </div>
    </UiPopover>
    <span v-if="$slots.actions" class="ui-select-actions">
      <slot name="actions" :value="model" :disabled="disabled || ariaDisabled" />
    </span>
  </span>
</template>

<script setup lang="ts">
import {
  computed,
  getCurrentInstance,
  nextTick,
  onBeforeUnmount,
  onMounted,
  onUpdated,
  ref,
  shallowRef,
  useAttrs,
  useId,
  watch,
} from 'vue';

import { provideUiFieldContext, useResolvedFieldState } from '../../composables/useUiFieldContext';
import {
  filterUiSelectOptions,
  normalizeUiSelectValue,
  readUiSelectOptions,
  type UiSelectOptionSnapshot,
} from '../../composables/useUiFieldSelect';
import { t } from '../../services/locale.ts';
import type { UiModelModifiers, UiSelectValue } from '../../types/uiFields';
import type { UiPopoverCloseReason } from '../../types/uiOverlays';
import UiPopover from '../overlays/UiPopover.vue';
import UiSearchInput from '../composites/UiSearchInput.vue';
import UiButton from './UiButton.vue';

defineOptions({ inheritAttrs: false });

const props = withDefaults(defineProps<{
  id?: string;
  disabled?: boolean;
  ariaDisabled?: boolean;
  invalid?: boolean;
  required?: boolean;
  compact?: boolean;
  searchable?: boolean | 'auto';
  groupNavigation?: boolean;
  modelValue?: UiSelectValue;
  modelModifiers?: UiModelModifiers;
}>(), {
  id: undefined,
  disabled: false,
  ariaDisabled: false,
  invalid: false,
  required: false,
  compact: false,
  searchable: 'auto',
  groupNavigation: false,
  modelValue: undefined,
  modelModifiers: () => ({}),
});

defineSlots<{
  default(): unknown;
  value?(props: { option: UiSelectOptionSnapshot | undefined; value: UiSelectValue }): unknown;
  'value-leading'?(props: { option: UiSelectOptionSnapshot | undefined; value: UiSelectValue }): unknown;
  'group-leading'?(props: { option: UiSelectOptionSnapshot }): unknown;
  'option-leading'?(props: { option: UiSelectOptionSnapshot }): unknown;
  option?(props: { option: UiSelectOptionSnapshot; selected: boolean }): unknown;
  actions?(props: { value: UiSelectValue; disabled: boolean }): unknown;
  header?(props: { close: () => void; value: UiSelectValue }): unknown;
  footer?(props: { close: () => void; value: UiSelectValue }): unknown;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: UiSelectValue];
  change: [event: Event];
  focus: [event: FocusEvent];
  blur: [event: FocusEvent];
}>();

const instance = getCurrentInstance();
const localValue = ref<UiSelectValue>('');
const model = computed<UiSelectValue>({
  get: () => {
    const incoming = props.modelValue;

    return hasModelBinding() ? (incoming === undefined ? '' : incoming) : localValue.value;
  },
  set: (value) => {
    if (Object.is(value, model.value)) {
      return;
    }
    if (!hasModelBinding()) {
      localValue.value = value;
    }

    emit('update:modelValue', value);
  },
});
const attrs = useAttrs();
const element = ref<HTMLSelectElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
const list = ref<HTMLElement | null>(null);
const open = ref(false);
const popupStyle = ref<Record<string, string>>({});
const workspaceMode = ref(false);
const touchMode = ref(false);
let triggerObserver: ResizeObserver | null = null;
const nativeInvalid = ref(false);
let boundForm: HTMLFormElement | null = null;
const options = shallowRef<UiSelectOptionSnapshot[]>([]);
const fallbackId = 'ui-select-' + useId().replaceAll(':', '');
let optionsStamp = '';

const query = ref('');
const activeGroupKey = ref<string | null>(null);
const searchInput = ref<InstanceType<typeof UiSearchInput> | null>(null);

const navigationGroups = computed(() => {
  const groups = new Map<string, {
    key: string;
    label: string;
    count: number;
    option: UiSelectOptionSnapshot;
  }>();

  for (const option of options.value) {
    if (!option.groupLabel) {
      continue;
    }

    const group = groups.get(option.groupKey);

    if (group) {
      group.count += 1;
    } else {
      groups.set(option.groupKey, {
        key: option.groupKey,
        label: option.groupLabel,
        count: 1,
        option,
      });
    }
  }

  return [...groups.values()];
});
const effectiveGroupKey = computed(() => props.groupNavigation
  && navigationGroups.value.some((group) => group.key === activeGroupKey.value)
  ? activeGroupKey.value
  : null);
const showSearch = computed(() => props.searchable === true
  || (props.searchable === 'auto' && options.value.length >= 10));
const visibleOptions = computed(() => filterUiSelectOptions(options.value, query.value).filter((option) => {
  return effectiveGroupKey.value === null || option.groupKey === effectiveGroupKey.value;
}));
const optionGroups = computed(() => {
  const groups: Array<{
    key: string;
    sourceKey: string;
    label: string;
    options: UiSelectOptionSnapshot[];
  }> = [];

  for (const option of visibleOptions.value) {
    const previous = groups.at(-1);

    if (previous && previous.sourceKey === option.groupKey) {
      previous.options.push(option);
    } else {
      groups.push({
        key: 'part-' + option.index,
        sourceKey: option.groupKey,
        label: option.groupLabel,
        options: [option],
      });
    }
  }

  return groups;
});

const activeIndex = ref(-1);
let typeahead = '';
let typeaheadTimer: ReturnType<typeof setTimeout> | undefined;

const enabledOptions = computed(() => visibleOptions.value.filter((option) => !option.disabled));
const activeId = computed(() => activeIndex.value < 0
  ? undefined
  : controlId.value + '-option-' + activeIndex.value);

const fieldState = useResolvedFieldState({
  id: () => props.id,
  describedBy: () => attrs['aria-describedby'] as string | undefined,
  invalid: () => props.invalid,
  required: () => props.required,
});

provideUiFieldContext({
  controlId: computed(() => ''),
  required: computed(() => false),
  invalid: computed(() => false),
  describedBy: computed(() => undefined),
});

const controlId = computed(() => fieldState.id.value || fallbackId);
const pickerLabel = computed(() => String(attrs['aria-label'] || t('core.select')));
const selectedOption = computed(() => options.value.find((option) => {
  return option.value === String(model.value ?? '');
}));
const selectedLabel = computed(() => {
  const selected = options.value.find((option) => option.value === String(model.value ?? ''));

  return selected?.label ?? (String(model.value ?? '') || t('core.select'));
});
const triggerAttrs = computed(() => {
  const {
    id: _id,
    name: _name,
    form: _form,
    autocomplete: _autocomplete,
    'aria-describedby': _describedBy,
    ...rest
  } = attrs;

  return rest;
});
const nativeAttrs = computed(() => Object.fromEntries(Object.entries(attrs).filter(([key]) => {
  return ['name', 'form', 'autocomplete', 'aria-label', 'aria-description'].includes(key)
    || (key.startsWith('data-') && !key.startsWith('data-geometry-'));
})));

/**
 * Переданный undefined остаётся управляемой пустотой, отсутствие prop — локальным режимом.
 * Это различие не даёт вернуть старый локальный выбор после внешнего сброса формы.
 */
function hasModelBinding(): boolean {
  const incoming = instance?.vnode.props;

  return Boolean(incoming && ('modelValue' in incoming || 'model-value' in incoming));
}

/**
 * Снимок обновляется после Vue-рендера слота и только при содержательном изменении.
 * Проверка подписи не допускает бесконечный updated → render → updated.
 */
function syncOptions(): void {
  const select = element.value;

  if (!select) {
    return;
  }

  select.value = String(model.value ?? '');

  const next = readUiSelectOptions(select);
  const stamp = JSON.stringify(next);

  if (stamp !== optionsStamp) {
    optionsStamp = stamp;
    options.value = next;
  }

  if (nativeInvalid.value && select.validity.valid) {
    nativeInvalid.value = false;
  }

  if (boundForm !== select.form) {
    boundForm?.removeEventListener('reset', onFormReset);
    boundForm = select.form;
    boundForm?.addEventListener('reset', onFormReset);
  }
}

/**
 * Открытие запрещено настоящим и фокусируемым disabled.
 * Барьер render → place → render ждёт видимую surface, затем переносит фокус.
 */
async function setOpen(value: boolean): Promise<void> {
  if (value && (props.disabled || props.ariaDisabled)) {
    return;
  }

  open.value = value;

  if (value) {
    query.value = '';
    syncOptions();
    activeGroupKey.value = props.groupNavigation ? selectedOption.value?.groupKey ?? null : null;
    resetActive();
    await nextTick();
    await Promise.resolve();
    await nextTick();

    if (!open.value || props.disabled || props.ariaDisabled) {
      return;
    }

    startPopupMetrics();

    if (showSearch.value && !touchMode.value) {
      searchInput.value?.focus({ preventScroll: true });
    } else {
      list.value?.focus({ preventScroll: true });
    }

    scrollToActive();
  }
}

/**
 * Смена группы фильтрует только каталог и никогда не выбирает модель за человека.
 * Поиск сбрасывается, чтобы выбранная группа показывала все свои варианты.
 */
function selectGroup(key: string | null): void {
  query.value = '';
  activeGroupKey.value = key;
}

function scrollToActive(): void {
  document.getElementById(activeId.value || '')?.scrollIntoView?.({ block: 'nearest' });
}

/**
 * Компонент сам возвращает фокус после выбора и Escape.
 * Закрытие от внешнего клика сохраняет фокус на внешнем элементе.
 */
function closePicker(restoreFocus = false): void {
  open.value = false;
  stopPopupMetrics();

  if (restoreFocus && !props.disabled) {
    trigger.value?.focus({ preventScroll: true });
  }
}

function onPopoverClose(reason: UiPopoverCloseReason): void {
  closePicker(reason === 'escape');
}

/**
 * Клик списка изменяет именно native индекс и отправляет настоящее событие.
 * Старые consumers получают прежний target; выбор текущего варианта только закрывает список.
 */
function choose(option: UiSelectOptionSnapshot): void {
  const select = element.value;

  if (!select || props.disabled || props.ariaDisabled || option.disabled) {
    return;
  }

  if (option.value !== String(model.value ?? '')) {
    select.selectedIndex = option.index;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  closePicker(true);
}

/**
 * Сохраняем прежний change и нормализацию, включая программный native change.
 * ariaDisabled откатывает DOM, но передаёт отменённое событие как раньше.
 */
function onChange(event: Event): void {
  const select = event.target as HTMLSelectElement;

  if (props.ariaDisabled) {
    event.preventDefault();
    select.value = String(model.value ?? '');
    emit('change', event);

    return;
  }

  model.value = normalizeUiSelectValue(select.value, props.modelModifiers);
  nativeInvalid.value = !select.validity.valid;
  emit('change', event);
}

function activate(option: UiSelectOptionSnapshot): void {
  if (!option.disabled) {
    activeIndex.value = option.index;
  }
}

/**
 * Выбранное значение остаётся источником начальной активности.
 * Недоступные варианты сохраняются в списке, но не получают клавиатурную активность.
 */
function resetActive(): void {
  const selected = enabledOptions.value.find((option) => option.value === String(model.value ?? ''));

  activeIndex.value = (selected ?? enabledOptions.value[0])?.index ?? -1;
}

/**
 * Индекс живёт в native коллекции; перемещение считает позиции доступного списка.
 * Прокрутка подводит активный вариант, не двигая страницу и соседние панели.
 */
function moveActive(direction: 'next' | 'previous' | 'first' | 'last'): void {
  const rows = enabledOptions.value;

  if (!rows.length) {
    activeIndex.value = -1;

    return;
  }

  const current = rows.findIndex((row) => row.index === activeIndex.value);
  let position = direction === 'last' ? rows.length - 1 : 0;

  if (direction === 'next') {
    position = (current + 1 + rows.length) % rows.length;
  } else if (direction === 'previous') {
    position = (current - 1 + rows.length) % rows.length;
  }

  const target = rows[position];

  if (!target) {
    return;
  }

  activeIndex.value = target.index;
  document.getElementById(activeId.value || '')?.scrollIntoView?.({ block: 'nearest' });
}

/**
 * Кнопка использует нативную активацию Enter/Space.
 * ArrowUp открывает список, ArrowDown уже поддерживается общим UiPopover.
 */
function onTriggerKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    void setOpen(true);
  }
}

/**
 * Буквенный набор нужен короткому списку без поискового поля.
 * Таймер принадлежит компоненту и снимается вместе с ним.
 */
function findByPrefix(key: string): void {
  clearTimeout(typeaheadTimer);
  typeahead += key.toLocaleLowerCase();

  const match = enabledOptions.value.find((option) => option.label.toLocaleLowerCase().startsWith(typeahead));

  if (match) {
    activeIndex.value = match.index;
    document.getElementById(activeId.value || '')?.scrollIntoView?.({ block: 'nearest' });
  }

  typeaheadTimer = setTimeout(() => {
    typeahead = '';
  }, 650);
}

/**
 * В базовом режиме listbox удерживает DOM-фокус, а aria-activedescendant сообщает активность.
 * Escape принадлежит общему стеку; Tab не превращается в подтверждение выбора.
 */
function onListKeydown(event: KeyboardEvent): void {
  if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) {
    return;
  }

  const directions: Record<string, 'next' | 'previous' | 'first' | 'last'> = {
    ArrowDown: 'next',
    ArrowUp: 'previous',
    Home: 'first',
    End: 'last',
  };
  const direction = directions[event.key];

  if (direction) {
    event.preventDefault();
    moveActive(direction);

    return;
  }

  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();

    const option = options.value.find((row) => row.index === activeIndex.value);

    if (option) {
      choose(option);
    }

    return;
  }

  if (event.key.length === 1) {
    event.preventDefault();
    findByPrefix(event.key);
  }
}

/**
 * Внутренние действия участвуют в обычном Tab-порядке.
 * На границе popup возвращаем точку последовательной навигации к trigger без отмены Tab.
 */
function onPopupTab(event: KeyboardEvent): void {
  if (event.key !== 'Tab') {
    return;
  }

  const panel = event.currentTarget as HTMLElement;
  const controls = [...panel.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), [tabindex="0"]',
  )].filter((node) => node.tabIndex >= 0 && !node.hidden);
  const current = controls.indexOf(document.activeElement as HTMLElement);
  const atEdge = event.shiftKey ? current <= 0 : current === controls.length - 1;

  if (atEdge) {
    closePicker();
    trigger.value?.focus({ preventScroll: true });
  }
}

onBeforeUnmount(() => {
  // Отложенное открытие может продолжиться после unmount.
  // Гасим флаг до очистки, чтобы барьер не создал подписки заново.
  open.value = false;
  stopPopupMetrics();
  clearTimeout(typeaheadTimer);
  boundForm?.removeEventListener('reset', onFormReset);
});

/**
 * В поиске Space и Home/End принадлежат тексту, а IME не подтверждает недописанное слово.
 * Только стрелки и Enter управляют результатами, не уводя DOM-фокус из строки поиска.
 */
function onSearchKeydown(event: KeyboardEvent): void {
  if (event.isComposing) {
    return;
  }

  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    moveActive(event.key === 'ArrowDown' ? 'next' : 'previous');
  } else if (event.key === 'Enter') {
    event.preventDefault();

    const option = visibleOptions.value.find((row) => row.index === activeIndex.value);

    if (option) {
      choose(option);
    }
  }
}

watch(query, (value) => {
  if (value.trim()) {
    activeGroupKey.value = null;
  }
}, { flush: 'sync' });

watch(visibleOptions, async () => {
  resetActive();
  await nextTick();

  if (open.value) {
    scrollToActive();
  }
});

function closeFromAction(): void {
  closePicker(false);
}

function onInvalid(): void {
  nativeInvalid.value = true;
  trigger.value?.focus({ preventScroll: true });
}

/**
 * Reset не изменяет контролируемую модель и не имитирует пользовательское событие.
 * После стандартного reset возвращаем адаптеру значение модели.
 */
async function onFormReset(): Promise<void> {
  await nextTick();
  syncOptions();
}

watch(() => [props.disabled, props.ariaDisabled], ([disabled, ariaDisabled]) => {
  if (disabled || ariaDisabled) {
    closePicker();
  }
});

watch(model, () => {
  if (open.value) {
    resetActive();
  }
});

/**
 * Размер списка ограничен реально видимой областью, включая экранную клавиатуру.
 * Ширина не наследуется от короткого названия модели и не раздувает закрытое поле.
 */
function updatePopupMetrics(): void {
  const button = trigger.value;

  if (!button) {
    return;
  }

  const viewport = window.visualViewport;
  const width = viewport?.width || window.innerWidth;
  const height = viewport?.height || window.innerHeight;
  const top = viewport?.offsetTop || 0;
  const rect = button.getBoundingClientRect();
  const above = rect.top - top - 12;
  const below = top + height - rect.bottom - 12;
  const groupedWidth = props.compact ? 320 : 360;
  const groupedHeight = props.compact ? 420 : 520;
  const preferredWidth = props.groupNavigation ? groupedWidth : 280;
  const preferredHeight = props.groupNavigation ? groupedHeight : 360;

  workspaceMode.value = Boolean(button.closest('[data-ui-workspace]'));
  touchMode.value = Boolean(button.closest('[data-ui-touch]'));
  popupStyle.value = {
    width: Math.max(0, Math.min(Math.max(rect.width, preferredWidth), width - 16)) + 'px',
    maxWidth: Math.max(0, width - 16) + 'px',
    maxHeight: Math.max(0, Math.min(preferredHeight, Math.max(above, below))) + 'px',
  };
}

/**
 * Подписки существуют только во время раскрытия и снимаются при любом закрытии.
 * Изменение ширины trigger отслеживается отдельно от ResizeObserver общего popup.
 */
function startPopupMetrics(): void {
  stopPopupMetrics();
  updatePopupMetrics();
  window.addEventListener('resize', updatePopupMetrics, { passive: true });
  window.addEventListener('scroll', updatePopupMetrics, { passive: true, capture: true });
  window.visualViewport?.addEventListener('resize', updatePopupMetrics, { passive: true });
  window.visualViewport?.addEventListener('scroll', updatePopupMetrics, { passive: true });

  if (typeof ResizeObserver !== 'undefined' && trigger.value) {
    triggerObserver = new ResizeObserver(updatePopupMetrics);
    triggerObserver.observe(trigger.value);
  }
}

/**
 * Снимаем только собственные listeners; UiPopover владеет своим позиционированием.
 * Метод повторяем, чтобы unmount после закрытия не оставлял наблюдателей.
 */
function stopPopupMetrics(): void {
  window.removeEventListener('resize', updatePopupMetrics);
  window.removeEventListener('scroll', updatePopupMetrics, true);
  window.visualViewport?.removeEventListener('resize', updatePopupMetrics);
  window.visualViewport?.removeEventListener('scroll', updatePopupMetrics);
  triggerObserver?.disconnect();
  triggerObserver = null;
}

onMounted(syncOptions);
onUpdated(syncOptions);

defineExpose({
  get el() {
    return element.value;
  },
  get triggerEl() {
    return trigger.value;
  },
  focus: (options?: FocusOptions) => trigger.value?.focus(options),
});
</script>

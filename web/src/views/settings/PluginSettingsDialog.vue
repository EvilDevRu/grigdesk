<template>
  <!-- У плагина с блоком готовности высота модалки задана по окну (см. overlays.css):
       список готовности приходит с сервера после открытия, и модалка по содержимому
       прыгала бы у человека на глазах. -->
  <UiDialog
    :open="open"
    class="plugin-dialog"
    data-role="plugin-settings"
    :data-setup="setupAvailable ? 'true' : undefined"
    size="content"
    :label="`Плагин ${plugin?.name || ''}`"
    @update:open="(value) => emit('update:open', value)"
  >
    <template v-if="plugin" #header>
      <div class="pd-head">
        <span class="pd-icon" :class="{ off: !plugin.enabled }" aria-hidden="true">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path :d="pluginIconPath(plugin)" />
          </svg>
        </span>
        <div class="pd-title">
          <div class="pd-name">
            <b>{{ plugin.name }}</b>
            <span class="pd-version">v{{ plugin.version }}</span>
          </div>
          <div class="pd-meta">
            <span class="pd-tag" :class="{ user: !plugin.system }">
              {{ plugin.system ? 'системный' : 'пользовательский' }}
            </span>
            <span class="pd-category">{{ pluginCategoryLabel(pluginCategoryOf(plugin)) }}</span>
            <span v-if="plugin.nav?.label" class="pd-place">
              раздел «{{ plugin.nav.label }}»
            </span>
          </div>
        </div>
        <div class="pd-switch" :class="{ on: plugin.enabled }">
          <span>{{ plugin.enabled ? 'Включён' : 'Выключен' }}</span>
          <UiSwitch
            :model-value="plugin.enabled"
            :disabled="toggling"
            :aria-label="`${plugin.enabled ? 'Выключить' : 'Включить'} ${plugin.name}`"
            @update:model-value="(value) => emit('toggle', value)"
          />
        </div>
      </div>
    </template>

    <template v-if="plugin">
      <p class="pd-desc">{{ plugin.description }}</p>

      <p v-if="plugin.needsRestart" class="pd-restart">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M20 11a8 8 0 1 0-2.3 5.7 M20 4v7h-7" />
        </svg>
        Изменение состояния серверной части применится после рестарта Cockpit.
      </p>

      <div v-if="!plugin.enabled" class="pd-state">
        <span class="pd-state-icon" aria-hidden="true">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M8 11V8a4 4 0 0 1 8 0v3 M6 11h12v10H6z" />
          </svg>
        </span>
        <span>
          <b>Плагин выключен</b>
          <small>
            {{ plugin.settings.length
              ? 'Функции неактивны, но параметры можно подготовить заранее.'
              : 'Включите его, чтобы использовать.' }}
          </small>
        </span>
      </div>

      <div v-if="plugin.enabled && !plugin.settings.length" class="pd-state ready">
        <span class="pd-state-icon" aria-hidden="true">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M5 12l4 4L19 6" />
          </svg>
        </span>
        <span>
          <b>Готов к работе</b>
          <small>У этого плагина нет отдельных параметров.</small>
        </span>
      </div>

      <div v-if="plugin.settings.length" class="plugset">
        <div class="plugset-head">
          <div>
            <span>Параметры</span>
            <b>Настройки плагина</b>
          </div>
          <small>{{ settingCountLabel(plugin.settings.length) }}</small>
        </div>
        <template v-for="s in plugin.settings" :key="s.key">
          <div v-if="s.type === 'checkbox'" class="plugrow plugcheck">
            <UiCheckbox
              :model-value="flagValue(s.key)"
              @update:model-value="(value) => setValue(s.key, value)"
            >
              <span class="plugcheck-copy">
                <b>{{ s.label }}</b>
                <small v-if="s.hint">{{ s.hint }}</small>
              </span>
            </UiCheckbox>
          </div>
          <template v-else>
            <div
              v-if="s.type === 'model'"
              class="plug-model-grid"
              :class="{
                solo: !(pluginEffortLevels(modelValue(s.key)).length
                  || pluginEffortLost(plugin, s.key)),
              }"
            >
              <!-- Модель берётся из общего реестра исполнителей — того же, что рисует
                   селект в чате. Значение хранится парой «исполнитель + модель»: у
                   локальных исполнителей id сам бывает со слэшами и двоеточиями
                   (`hf.co/user/repo:tag`). -->
              <div class="plugrow wide">
                <label :for="pluginSettingId(plugin, s)">{{ s.label }}</label>
                <UiSelect
                  :id="pluginSettingId(plugin, s)"
                  class="inp"
                  data-context="settings-field"
                  :aria-describedby="s.hint ? pluginSettingId(plugin, s, 'hint') : undefined"
                  :model-value="pluginModelValue(plugin, s.key)"
                  @change="setPluginModel(plugin, s.key, selectValue($event))"
                >
                  <option value="">— не выбрана —</option>
                  <!-- Выбор мог пропасть из каталога или перестать подходить задаче.
                       Молча показать «не выбрана» нельзя: сервер всё ещё пытается
                       ходить именно этой моделью. -->
                  <option
                    v-if="pluginModelUnavailable(plugin, s)"
                    :value="pluginModelValue(plugin, s.key)"
                    disabled
                  >
                    {{ pluginModelUnavailable(plugin, s) }}
                  </option>
                  <!-- «недоступен» — итог последней проверки исполнителя, а не запрет:
                       причина бывает временной, и модель остаётся выбираемой. -->
                  <optgroup
                    v-for="g in pluginModelGroups(s)"
                    :key="g.id"
                    :label="g.name + (g.available ? '' : ' — недоступен')"
                  >
                    <option
                      v-for="m in g.models"
                      :key="m.id"
                      :value="`${g.id}:${m.id}`"
                    >
                      {{ m.name }}
                    </option>
                  </optgroup>
                </UiSelect>
              </div>
              <!-- Усилие — свойство запуска, а не модели. Поэтому контрол остаётся
                   отдельным, но визуально стоит с моделью в одной строке. -->
              <div
                v-if="pluginEffortLevels(modelValue(s.key)).length
                  || pluginEffortLost(plugin, s.key)"
                class="plugrow effort-row"
              >
                <label :for="pluginSettingId(plugin, s, 'effort')">Усилие</label>
                <UiSelect
                  :id="pluginSettingId(plugin, s, 'effort')"
                  class="inp"
                  data-context="settings-field"
                  :model-value="modelValue(s.key)?.effort || ''"
                  @change="setPluginEffort(plugin, s.key, selectValue($event))"
                >
                  <option value="">по умолчанию исполнителя</option>
                  <!-- Устаревший уровень остаётся видимым: сервер снимет его и пойдёт
                       с умолчанием, что нельзя скрывать от человека. -->
                  <option
                    v-if="pluginEffortLost(plugin, s.key)"
                    :value="pluginEffortLost(plugin, s.key)"
                  >
                    {{ pluginEffortLost(plugin, s.key) }} — нет у этой модели
                  </option>
                  <option
                    v-for="e in pluginEffortLevels(modelValue(s.key))"
                    :key="e"
                    :value="e"
                  >
                    {{ e }}
                  </option>
                </UiSelect>
              </div>
            </div>
            <div v-else class="plugrow">
              <label :for="pluginSettingId(plugin, s)">{{ s.label }}</label>
              <UiNumberInput
                v-if="s.type === 'number'"
                :id="pluginSettingId(plugin, s)"
                :model-value="numberValue(s.key)"
                class="inp"
                data-context="settings-field"
                :aria-describedby="s.hint ? pluginSettingId(plugin, s, 'hint') : undefined"
                :min="s.min"
                :max="s.max"
                :step="s.step"
                @update:model-value="(value) => setValue(s.key, value)"
              />
              <UiSelect
                v-else-if="s.type === 'select'"
                :id="pluginSettingId(plugin, s)"
                :model-value="textValue(s.key)"
                class="inp"
                data-context="settings-field"
                :aria-describedby="s.hint ? pluginSettingId(plugin, s, 'hint') : undefined"
                @update:model-value="(value) => setValue(s.key, value)"
              >
                <option v-for="o in s.options" :key="o" :value="o">{{ o }}</option>
              </UiSelect>
              <UiInput
                v-else
                :id="pluginSettingId(plugin, s)"
                :model-value="textValue(s.key)"
                class="inp"
                data-context="settings-field"
                :aria-describedby="s.hint ? pluginSettingId(plugin, s, 'hint') : undefined"
                @update:model-value="(value) => setValue(s.key, value)"
              />
            </div>
            <p
              v-if="s.hint"
              :id="pluginSettingId(plugin, s, 'hint')"
              class="plughint"
            >
              {{ s.hint }}
            </p>
          </template>
        </template>
      </div>

      <!-- Готовность: что плагину нужно на машине и что он ставит сам. Ход установки
           живёт на сервере, модалка его только показывает и перечитывает, пока идёт. -->
      <div v-if="setupAvailable" class="plugset pd-setup" data-role="plugin-setup">
        <div class="plugset-head">
          <div>
            <span>Готовность</span>
            <b>Что нужно для работы</b>
          </div>
          <small>{{ setupSummary }}</small>
        </div>
        <p v-if="setupError" class="pd-error" role="alert">{{ setupError }}</p>
        <ul v-else-if="setup" class="pd-setup-list">
          <li v-for="item in setup.items" :key="item.id" :data-setup-id="item.id">
            <span class="pd-setup-dot" :data-status="item.status" aria-hidden="true"></span>
            <span class="pd-setup-copy">
              <b>{{ item.title }}</b>
              <small>{{ item.reason }}</small>
              <small v-if="item.job?.state === 'running'" class="pd-setup-job">
                {{ item.job.label }}
              </small>
              <small v-else-if="item.job?.error" class="pd-setup-job failed">
                {{ item.job.error }}
              </small>
              <small v-else-if="item.action" class="pd-setup-hint">{{ item.action.hint }}</small>
            </span>
            <UiButton
              v-if="item.job?.state === 'running'"
              variant="ghost"
              data-role="settings-action"
              :loading="setupBusy === item.id"
              @click="cancelSetup(item)"
            >
              Отменить
            </UiButton>
            <UiButton
              v-else-if="item.action"
              data-role="settings-action"
              :loading="setupBusy === item.id"
              @click="runSetup(item)"
            >
              {{ item.action.label }}
            </UiButton>
          </li>
        </ul>
        <p v-else class="plughint pd-setup-loading" role="status">
          <UiSpinner decorative role="standalone" />
          <span>Проверяем, что есть на машине…</span>
        </p>
      </div>
    </template>

    <template v-if="plugin" #footer>
      <p v-if="error" class="pd-error" role="alert">{{ error }}</p>
      <span v-else class="ui-visually-hidden" aria-live="polite">
        {{ saved ? 'Настройки плагина сохранены.' : '' }}
      </span>
      <div class="pd-actions">
        <UiButton variant="ghost" data-role="settings-action" @click="emit('update:open', false)">
          Закрыть
        </UiButton>
        <UiButton
          v-if="plugin.settings.length"
          class="plugin-save"
          :class="{ saved }"
          data-role="settings-action"
          :loading="saving"
          loading-label="Сохраняю настройки"
          @click="save"
        >
          <svg
            v-if="saved"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M5 12l4 4L19 6" />
          </svg>
          {{ saved ? 'Сохранено' : 'Сохранить' }}
        </UiButton>
      </div>
    </template>
  </UiDialog>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import {
  UiButton,
  UiCheckbox,
  UiDialog,
  UiInput,
  UiNumberInput,
  UiSelect,
  UiSpinner,
  UiSwitch,
} from '../../ui';
import { pluginCategoryOf, usePluginsStore } from '../../stores/plugins.js';
import { useProvidersStore } from '../../stores/providers.js';
import { pluginIconPath } from '../../shared/navIcons.ts';
import { pluginCategoryLabel } from '../../../../shared/pluginsContracts.ts';
import type { ProviderEntry } from '../../../../shared/providersContracts.ts';
import type {
  PluginListItem,
  PluginModelValue,
  PluginSetting,
  PluginSetupItem,
  PluginSetupStatus,
} from '../../../../shared/pluginsContracts.ts';

// Настройки одного плагина. Раздел показывает каталог плитками, а форма существует
// только для того модуля, который человек открыл, — поэтому она живёт в модалке, а не
// во второй колонке: до параметров редких плагинов иначе доходит половина экрана.
const props = withDefaults(
  defineProps<{
    open?: boolean;
    plugin?: PluginListItem | null;
    toggling?: boolean;
  }>(),
  {
    open: false,
    plugin: null,
    toggling: false,
  },
);

const emit = defineEmits<{
  'update:open': [value: boolean];
  toggle: [enabled: boolean];
}>();

const pluginsStore = usePluginsStore();
const prov = useProvidersStore();

const saving = ref(false);
const saved = ref(false);
const error = ref('');

// Итог прошлого сохранения относится к прошлому плагину: и «Сохранено», и ошибка
// обязаны исчезнуть, когда в модалке оказался другой модуль или её открыли заново.
watch(
  () => [props.open, props.plugin?.id],
  () => {
    saved.value = false;
    error.value = '';
  },
);

// Значения приходят из общего store как «что объявил манифест», поэтому каждый контрол
// получает своё значение приведённым, а не через общий v-model по unknown.
function storedValue(key: string): unknown {
  return props.plugin?.values?.[key];
}

function flagValue(key: string): boolean {
  return storedValue(key) === true;
}

function numberValue(key: string): number | undefined {
  const stored = storedValue(key);

  return typeof stored === 'number' ? stored : undefined;
}

function textValue(key: string): string {
  const stored = storedValue(key);

  return stored == null ? '' : String(stored);
}

/** Сохранённая пара «исполнитель + модель»; иначе настройка ещё не заполнена. */
function modelValue(key: string): PluginModelValue | null {
  const stored = storedValue(key);

  return stored && typeof stored === 'object' ? stored as PluginModelValue : null;
}

function setValue(key: string, value: unknown): void {
  if (props.plugin) {
    props.plugin.values[key] = value;
  }
}

function selectValue(event: Event): string {
  return (event.target as HTMLSelectElement).value;
}

// Русские формы счётчика параметров в шапке формы: «1 параметр», «2 параметра»,
// «5 параметров». Числительные второго десятка идут по общему правилу многих.
function settingCountLabel(value: number): string {
  const normalized = Math.abs(Number(value)) % 100;
  const digit = normalized % 10;
  let word = 'параметров';

  if (normalized < 11 || normalized > 19) {
    if (digit === 1) {
      word = 'параметр';
    } else if (digit >= 2 && digit <= 4) {
      word = 'параметра';
    }
  }

  return `${value} ${word}`;
}

function pluginSettingId(plugin: PluginListItem, setting: PluginSetting, suffix = 'value'): string {
  return `plugin-${plugin.id}-${setting.key}-${suffix}`;
}

// Готовность плагина: список требований с кнопками установки. Показывается только
// включённому плагину, который объявил ручку, — остальным показывать нечего.
const setup = ref<PluginSetupStatus | null>(null);
const setupError = ref('');
const setupBusy = ref('');
let setupTimer: ReturnType<typeof setTimeout> | null = null;

const setupAvailable = computed(() => Boolean(props.plugin?.enabled && props.plugin?.setup));

const setupSummary = computed(() => {
  const items = setup.value?.items ?? [];
  const ready = items.filter((item) => item.status === 'ready').length;

  return items.length ? `${ready} из ${items.length} готово` : '';
});

function stopSetupPolling(): void {
  if (setupTimer) {
    clearTimeout(setupTimer);
    setupTimer = null;
  }
}

function setupRunning(status: PluginSetupStatus | null): boolean {
  return Boolean(status?.items.some((item) => item.job?.state === 'running'));
}

/**
 * Пока хоть одна установка идёт, готовность перечитывается раз в пару секунд:
 * скачивание длится минуты, и человек должен видеть, что оно движется.
 */
function scheduleSetupPoll(): void {
  stopSetupPolling();

  if (props.open && setupRunning(setup.value)) {
    setupTimer = setTimeout(() => {
      void loadSetup();
    }, 2500);
  }
}

function setupFailure(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Чтение готовности. Ошибка чтения показывается на месте списка, а не глотается:
 * пустой блок человек прочитал бы как «всё установлено».
 */
async function loadSetup(): Promise<void> {
  const plugin = props.plugin;

  if (!plugin?.setup) {
    return;
  }

  try {
    setup.value = await pluginsStore.loadSetup(plugin) as PluginSetupStatus;
    setupError.value = '';
  } catch (error) {
    setupError.value = setupFailure(error, 'Не удалось прочитать готовность плагина.');
  }

  scheduleSetupPoll();
}

/**
 * Запуск установки по пункту. Сервер отвечает уже обновлённым списком, поэтому
 * кнопка сменяется на «Отменить» сразу, а дальше ход читается опросом.
 */
async function runSetup(item: PluginSetupItem): Promise<void> {
  const plugin = props.plugin;

  if (!plugin?.setup) {
    return;
  }

  setupBusy.value = item.id;

  try {
    setup.value = await pluginsStore.runSetup(plugin, item.id) as PluginSetupStatus;
    setupError.value = '';
  } catch (error) {
    setupError.value = setupFailure(error, 'Установка не запустилась.');
  } finally {
    setupBusy.value = '';
  }

  scheduleSetupPoll();
}

/**
 * Отмена идущей установки. Скачанное остаётся на диске — повтор нажатия не
 * качает его заново, и об этом говорит сам пункт после отмены.
 */
async function cancelSetup(item: PluginSetupItem): Promise<void> {
  const plugin = props.plugin;

  if (!plugin?.setup) {
    return;
  }

  setupBusy.value = item.id;

  try {
    setup.value = await pluginsStore.cancelSetup(plugin, item.id) as PluginSetupStatus;
    setupError.value = '';
  } catch (error) {
    setupError.value = setupFailure(error, 'Установка не остановилась.');
  } finally {
    setupBusy.value = '';
  }

  scheduleSetupPoll();
}

// Готовность относится к открытому плагину: при смене модуля или закрытии старый
// список и его опрос снимаются, а для нового читаются заново.
watch(
  () => [props.open, props.plugin?.id, props.plugin?.enabled] as const,
  () => {
    stopSetupPolling();
    setup.value = null;
    setupError.value = '';

    if (props.open && setupAvailable.value) {
      void loadSetup();
    }
  },
  { immediate: true },
);

onUnmounted(stopSetupPolling);

// Настройка типа `model` — тот же выбор, что в чате: исполнители группами, внутри их
// модели. Правило видимости общее (`visibleModels`): в кратком списке только свежие
// версии, остальные — под настройкой «показывать все модели».
const modelGroups = computed(() => (prov.providers as ProviderEntry[])
  .map((p) => ({ ...p, models: prov.visibleModels(p) as ProviderEntry['models'] }))
  .filter((p) => p.models?.length));

// Настройка может требовать возможности исполнителя (например, безопасного разбора
// недоверенного текста): тогда неподходящие исполнители из выбора уходят совсем.
function pluginModelGroups(setting: PluginSetting) {
  const capability = String(setting?.requiresCapability || '');

  if (!capability) {
    return modelGroups.value;
  }

  return modelGroups.value.filter((provider) => provider.capabilities?.[capability] === true);
}

// Сохранённая пара → значение опции «исполнитель:модель». Пустая строка означает
// «не выбрана»: половина пары для запуска бесполезна, поэтому её тоже не показываем.
function pluginModelValue(p: PluginListItem, key: string): string {
  const stored = modelValue(key);

  if (!stored) {
    return '';
  }

  const provider = String(stored.provider || '');
  const model = String(stored.model || '');

  return provider && model ? `${provider}:${model}` : '';
}

/**
 * Сохранённый, но недоступный для настройки выбор остаётся видимым: иначе пустой
 * select соврёт, будто сервер не продолжает запускать прежнюю модель.
 */
function pluginModelUnavailable(p: PluginListItem, setting: PluginSetting): string | null {
  const value = pluginModelValue(p, setting?.key);

  if (!value) {
    return null;
  }

  const { provider, model } = prov.modelOf(storedValue(String(setting?.key || '')));

  if (!provider || !model) {
    return `${value} — нет в реестре`;
  }

  const capability = String(setting?.requiresCapability || '');

  if (capability && provider.capabilities?.[capability] !== true) {
    return `${provider.name}: ${model.name} — не подходит для этой настройки`;
  }

  return null;
}

// id исполнителя двоеточий не содержит, а id модели содержит сплошь и рядом
// (`qwen3.6:latest`), поэтому строку выбора режем по ПЕРВОМУ двоеточию.
function setPluginModel(p: PluginListItem, key: string, value: string): void {
  const at = String(value || '').indexOf(':');

  if (at <= 0) {
    p.values[key] = null;

    return;
  }

  const next: PluginModelValue = { provider: value.slice(0, at), model: value.slice(at + 1) };
  // Эффорт переносим, только если новая модель такой уровень объявляет: у моделей
  // разные лестницы, и `xhigh` на модели без него роняет запуск CLI, а не игнорируется.
  const effort = modelValue(key)?.effort;

  if (effort && pluginEffortLevels(next).includes(effort)) {
    next.effort = effort;
  }

  p.values[key] = next;
}

// Уровни эффорта объявляет сама модель. Пустой список — не «выбери низкий», а
// «этой модели уровень передать нечем», и тогда контрола не будет вовсе.
function pluginEffortLevels(stored: unknown): string[] {
  if (!stored || typeof stored !== 'object') {
    return [];
  }

  const { model } = prov.modelOf(stored);

  return Array.isArray(model?.efforts) ? model.efforts : [];
}

// Сохранённый уровень, которого у модели больше нет, показываем с оговоркой: сервер
// снимет его и пойдёт на умолчании, и молчать об этом нельзя.
function pluginEffortLost(p: PluginListItem, key: string): string | null {
  const stored = modelValue(key);
  const effort = stored?.effort;

  if (!effort) {
    return null;
  }

  return pluginEffortLevels(stored).includes(effort) ? null : effort;
}

// Пустой выбор СНИМАЕТ ключ: пустая строка в effort означала бы «уровень выбран и он
// пустой», и запуск ушёл бы не на умолчание исполнителя, а в отказ CLI.
function setPluginEffort(p: PluginListItem, key: string, value: string): void {
  const stored = modelValue(key);

  if (!stored) {
    return;
  }

  const effort = String(value || '');

  if (effort) {
    p.values[key] = { ...stored, effort };

    return;
  }

  const { effort: _drop, ...rest } = stored;

  p.values[key] = rest;
}

/**
 * Сохранение оставляет модалку открытой: человек часто правит соседний параметр
 * следом, а отметка «Сохранено» на кнопке гаснет сама.
 */
async function save(): Promise<void> {
  const plugin = props.plugin;

  if (!plugin || saving.value) {
    return;
  }

  saving.value = true;
  error.value = '';

  try {
    await pluginsStore.saveSettings(plugin.id, plugin.values);
    saved.value = true;
    setTimeout(() => {
      saved.value = false;
    }, 2000);
  } catch (err) {
    const failure = err as { data?: { message?: string }; message?: string } | null;

    error.value = failure?.data?.message || failure?.message
      || 'Не удалось сохранить настройки.';
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
/* Модалка не наследует scoped-стили раздела настроек, поэтому описана целиком здесь. */
.pd-head { flex: 1; min-width: 0; display: flex; align-items: center; gap: 12px; }
.pd-icon {
  flex: none; display: grid; place-items: center; width: 38px; height: 38px;
  border: 1px solid color-mix(in srgb, var(--accent) 34%, var(--line));
  border-radius: 11px; background: color-mix(in srgb, var(--accent) 11%, var(--surface));
  color: var(--accent);
}
.pd-icon.off { border-color: var(--line); background: var(--surface-2); color: var(--ink-mid); }
.pd-icon svg { width: 21px; height: 21px; }
.pd-title { min-width: 0; display: grid; gap: 5px; }
.pd-name { min-width: 0; display: flex; align-items: baseline; gap: 7px; }
.pd-name b { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 15px; font-weight: 650; }
.pd-version { flex: none; color: var(--ink-mid); font-family: var(--mono); font-size: 10.5px; }
.pd-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; min-width: 0; }
.pd-tag {
  padding: 2px 8px; border: 1px solid var(--line-2); border-radius: 999px;
  background: var(--surface-2); color: var(--ink-mid); font-size: 10px;
}
.pd-tag.user { border-color: color-mix(in srgb, var(--accent) 40%, var(--line));
  background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--accent); }
.pd-category, .pd-place { color: var(--ink-mid); font-size: 10.5px; }
.pd-switch { flex: none; display: flex; align-items: center; gap: 9px; color: var(--ink-mid);
  font-size: 11.5px; }
.pd-switch.on { color: var(--accent); }
.pd-desc { margin: 0 0 12px; color: var(--ink-mid); font-size: 12.5px; line-height: 1.55; }
.pd-restart {
  display: flex; align-items: flex-start; gap: 7px; margin: 0 0 12px; padding: 9px 11px;
  border: 1px solid color-mix(in srgb, var(--warn) 34%, var(--line)); border-radius: 9px;
  background: color-mix(in srgb, var(--warn) 8%, var(--surface));
  color: var(--ink-mid); font-size: 11.5px; line-height: 1.45;
}
.pd-restart svg { flex: none; width: 14px; height: 14px; margin-top: 1px; color: var(--warn); }
.pd-state {
  display: flex; align-items: center; gap: 11px; padding: 12px 13px;
  border: 1px solid var(--line); border-radius: 10px; background: var(--surface-2);
}
.pd-state.ready { border-color: color-mix(in srgb, var(--good) 30%, var(--line));
  background: color-mix(in srgb, var(--good) 6%, var(--surface)); }
.pd-state-icon {
  flex: none; display: grid; place-items: center; width: 30px; height: 30px;
  border-radius: 9px; background: var(--ground); color: var(--ink-mid);
}
.pd-state.ready .pd-state-icon { color: var(--good); }
.pd-state-icon svg { width: 17px; height: 17px; }
.pd-state > span:last-child { min-width: 0; display: grid; gap: 2px; }
.pd-state b { font-size: 12.5px; font-weight: 620; }
.pd-state small { color: var(--ink-mid); font-size: 11px; line-height: 1.45; }
.plugset { display: grid; gap: 12px; }
.plugset-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 10px;
  padding-bottom: 9px; border-bottom: 1px solid var(--line); }
.plugset-head > div { display: grid; gap: 1px; }
.plugset-head span { color: var(--accent); font-size: 9.5px; font-weight: 740;
  letter-spacing: .09em; text-transform: uppercase; }
.plugset-head b { font-size: 12.5px; font-weight: 650; }
.plugset-head small { color: var(--ink-mid); font-size: 9.5px; }
.plugrow { min-width: 0; display: grid; gap: 6px; }
.plugrow label { color: var(--ink-mid); font-size: 11.5px; }
.plugrow .inp { width: min(100%, 320px); }
.plug-model-grid { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, .6fr);
  align-items: end; gap: 10px; }
.plug-model-grid.solo { grid-template-columns: minmax(0, 1fr); }
.plug-model-grid .plugrow .inp { width: 100%; }
.plughint { max-width: 720px; margin: -4px 0 1px; color: var(--ink-mid); font-size: 11px;
  line-height: 1.5; }
.plugcheck {
  align-items: flex-start; gap: 10px; padding: 10px 11px; border: 1px solid var(--line);
  border-radius: 9px; background: var(--surface);
}
.plugcheck-copy { min-width: 0; display: grid; gap: 2px; }
.plugcheck-copy b { color: var(--ink); font-size: 12px; font-weight: 590; }
.plugcheck-copy small { color: var(--ink-mid); font-size: 10.5px; line-height: 1.45; }
.pd-error { flex: 1; min-width: 0; margin: 0; color: var(--bad); font-size: 11.5px; }
.pd-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px;
  margin-left: auto; }
.plugin-save { display: inline-flex; align-items: center; gap: 6px; }

.pd-setup-loading {
  display: flex; align-items: center; gap: 8px; min-height: 40px; margin: 0;
}
.pd-setup-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.pd-setup-list li {
  display: grid; grid-template-columns: 8px minmax(0, 1fr) auto; align-items: center; gap: 10px;
  padding: 10px 11px; border: 1px solid var(--line); border-radius: 9px; background: var(--surface);
}
.pd-setup-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ink-mid); }
.pd-setup-dot[data-status='ready'] { background: var(--good); }
.pd-setup-dot[data-status='blocked'] { background: var(--bad); }
.pd-setup-dot[data-status='warning'] { background: var(--warn); }
.pd-setup-copy { min-width: 0; display: grid; gap: 2px; }
.pd-setup-copy b { color: var(--ink); font-size: 12px; font-weight: 590; }
.pd-setup-copy small { color: var(--ink-mid); font-size: 10.5px; line-height: 1.45; }
.pd-setup-job { color: var(--accent); }
.pd-setup-job.failed { color: var(--bad); }

@media (max-width: 639px) {
  .pd-head { flex-wrap: wrap; }
  .pd-setup-list li { grid-template-columns: 8px minmax(0, 1fr); }
  .pd-setup-list li > .ui-button { grid-column: 2; justify-self: start; }
  .pd-switch { width: 100%; justify-content: space-between; }
  .plug-model-grid { grid-template-columns: minmax(0, 1fr); }
  .pd-actions { width: 100%; }
  .pd-actions .ui-button { flex: 1; }
}
</style>

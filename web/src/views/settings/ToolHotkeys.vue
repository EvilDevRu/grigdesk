<template>
  <div class="hotkeys" data-testid="tool-hotkeys">
    <div class="hotkeys-head">
      <div>
        <h3>Горячие клавиши инструментов</h3>
        <p>
          Открывают панель инструмента поверх страницы, а на узком экране — его страницу.
          Повторное нажатие той же клавиши панель закрывает.
        </p>
      </div>
      <span class="hotkeys-scope">Это устройство</span>
    </div>

    <ul class="hotkey-list">
      <li v-for="row in rows" :key="row.id" class="hotkey-row" :data-tool="row.id">
        <span class="hotkey-name">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path :d="NAV_ICONS[row.icon] || NAV_ICONS.plugin" />
          </svg>
          <b>{{ row.label }}</b>
          <small v-if="!row.available">плагин выключен — клавиша молчит</small>
        </span>

        <span class="hotkey-combo" :data-testid="`hotkey-combo-${row.id}`">
          <em v-if="recording === row.id">Нажмите сочетание…</em>
          <kbd v-else-if="row.combo">{{ row.combo }}</kbd>
          <em v-else class="off">выключено</em>
        </span>

        <span class="hotkey-actions">
          <UiButton data-role="settings-action" :pressed="recording === row.id"
                    :data-testid="`hotkey-record-${row.id}`" @click="toggleRecording(row.id)">
            {{ recording === row.id ? 'Отменить' : 'Изменить' }}
          </UiButton>
          <UiButton variant="text" :data-testid="`hotkey-secondary-${row.id}`"
                    @click="toggleBinding(row)">
            {{ row.combo ? 'Выключить' : 'Вернуть' }}
          </UiButton>
        </span>
      </li>
    </ul>

    <p v-if="error" class="hotkey-msg err" role="alert" data-testid="hotkey-error">{{ error }}</p>
    <p v-else class="hotkey-msg muted">
      Сочетание запоминается по физической клавише, поэтому срабатывает и в русской раскладке.
      Комбинации браузера и рабочего стола настройка не принимает. Escape отменяет запись.
    </p>

    <div class="hotkey-foot">
      <UiButton data-role="settings-action" :disabled="allDefault" data-testid="hotkey-reset-all"
                @click="resetAll">
        Вернуть стандартные
      </UiButton>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useHotkeysStore } from '../../stores/hotkeys.js';
import { usePluginsStore } from '../../stores/plugins.js';
import { NAV_ICONS } from '../../shared/navIcons.ts';
import { TOOL_CATALOG, toolAvailability } from '../../shared/tools/catalog.ts';
import { comboFromEvent, formatCombo, isLayoutSwitch } from '../../shared/hotkeys/combo.ts';
import { UiButton } from '../../ui';

const hotkeys = useHotkeysStore();
const plugins = usePluginsStore();

const error = ref('');

const recording = computed(() => hotkeys.recording);
const allDefault = computed(() => TOOL_CATALOG.every((item) => hotkeys.isDefault(item.id)));
const rows = computed(() => TOOL_CATALOG.map((item) => ({
  id: item.id,
  label: item.label,
  icon: item.icon,
  available: toolAvailability(item, plugins) === 'enabled',
  combo: formatCombo(hotkeys.comboOf(item.id)),
})));

function toggleRecording(id) {
  error.value = '';
  if (recording.value === id) hotkeys.stopRecording();
  else hotkeys.startRecording(id);
}

/**
 * Вторая кнопка строки меняет смысл: у назначенной клавиши она выключает её,
 * у выключенной — возвращает сочетание по умолчанию. Отдельной кнопки «вернуть»
 * рядом с живой клавишей нет: сброс всех умолчаний живёт внизу карточки.
 */
function toggleBinding(row) {
  error.value = '';
  hotkeys.stopRecording();
  if (row.combo) hotkeys.disable(row.id);
  else hotkeys.restore(row.id);
}

function resetAll() {
  error.value = '';
  hotkeys.stopRecording();
  hotkeys.resetAll();
}

/**
 * Пока идёт запись, окно забирает клавиатуру себе целиком: и Escape общего стека
 * слоёв, и системные сочетания страницы. Иначе выбранная комбинация одновременно
 * закрыла бы настройки или открыла панель, которую человек только настраивает.
 */
function onRecordKey(event) {
  if (!recording.value || event.isComposing) return;
  event.preventDefault();
  event.stopImmediatePropagation();

  if (event.key === 'Escape') {
    hotkeys.stopRecording();
    return;
  }

  // Пара Alt+Shift на машине с двумя раскладками до страницы не доходит целиком:
  // вторую клавишу пары забирает переключатель групп. Молчать тут нельзя — человек
  // решит, что не работает сама запись, и будет жать то же сочетание снова.
  if (isLayoutSwitch(event)) {
    error.value = 'Эту клавишу забрал системный переключатель раскладки: сочетание с ней '
      + 'до кокпита не дойдёт. Возьмите пару с Ctrl — например Ctrl + Shift + цифра.';
    return;
  }

  const combo = comboFromEvent(event);
  if (!combo) return;

  const result = hotkeys.assign(recording.value, combo);
  error.value = result.ok ? '' : result.error;
  if (result.ok) hotkeys.stopRecording();
}

onMounted(() => {
  window.addEventListener('keydown', onRecordKey, true);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onRecordKey, true);
  hotkeys.stopRecording();
});
</script>

<style scoped>
/* Подраздел не наследует scoped-стили SettingsView, поэтому карточка описана здесь целиком. */
.hotkeys { display: flex; flex-direction: column; gap: 14px; }
.hotkeys-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.hotkeys-head h3 { margin: 0 0 4px; font-size: 15px; }
.hotkeys-head p { margin: 0; max-width: 62ch; color: var(--ink-mid); font-size: 12.5px; line-height: 1.5; }
.hotkeys-scope {
  flex: none; padding: 3px 9px; border: 1px solid var(--line-2); border-radius: 999px;
  background: var(--surface-2); color: var(--ink-mid); font-size: 11px; white-space: nowrap;
}
.hotkey-list { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
.hotkey-row {
  display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 12px;
  padding: 9px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface);
}
.hotkey-name { min-width: 0; display: flex; align-items: center; gap: 9px; }
.hotkey-name svg { flex: none; width: 18px; height: 18px; color: var(--ink-mid); }
.hotkey-name b { font-size: 13px; font-weight: 620; }
.hotkey-name small { color: var(--warn); font-size: 11.5px; }
.hotkey-combo { min-width: 148px; text-align: right; }
.hotkey-combo kbd {
  display: inline-block; padding: 3px 9px; border: 1px solid var(--line-2); border-radius: 7px;
  background: var(--surface-2); color: var(--ink); font-family: inherit; font-size: 12px; font-weight: 620;
}
.hotkey-combo em { color: var(--ink-mid); font-size: 12px; font-style: normal; }
.hotkey-combo em.off { opacity: .75; }
.hotkey-actions { display: flex; align-items: center; gap: 6px; }
.hotkey-msg { margin: 0; max-width: 78ch; font-size: 12.5px; line-height: 1.5; }
.hotkey-msg.muted { color: var(--ink-mid); }
.hotkey-msg.err { color: var(--bad); }
.hotkey-foot { display: flex; justify-content: flex-end; }
@media (max-width: 719px) {
  .hotkey-row { grid-template-columns: minmax(0, 1fr); }
  .hotkey-combo { text-align: left; }
  .hotkey-actions { justify-content: flex-start; }
}
</style>

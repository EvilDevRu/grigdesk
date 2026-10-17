<template>
  <div class="launcher" data-testid="server-launcher">
    <div class="launcher-head">
      <div>
        <h3>Автозапуск и ярлык</h3>
        <p>
          Механизм — юнит systemd: он ждёт VPN, поднимает сервер после падения и стартует
          до входа в систему. Здесь — только решение, нужен ли такой старт, и ярлык «Кокпит»,
          который открывает окно, а спящий сервер поднимает сам.
        </p>
      </div>
      <span v-if="state" class="launcher-pill" :class="pillTone" data-testid="launcher-mode">
        <span class="dot"></span>{{ modeLabel }}
      </span>
    </div>

    <p v-if="!state && loading" class="launcher-note">Читаю состояние…</p>
    <template v-else-if="state">
      <div class="launcher-row">
        <UiSwitch
          :model-value="autostartOn"
          :disabled="busy || autostartUnavailable"
          data-testid="autostart-switch"
          @update:model-value="setAutostart"
        >
          Запускать при включении машины
        </UiSwitch>
        <p class="launcher-note" data-testid="autostart-note">{{ autostartNote }}</p>
        <p v-if="systemd === false && mode === 'desktop'" class="launcher-note">
          Сейчас сервером управляет приложение Кокпита — переключатель касается юнита, а не этого
          процесса.
        </p>
        <p v-else-if="systemd === false" class="launcher-note">
          Сейчас сервер запущен вручную — переключатель касается юнита, а не этого процесса.
        </p>
      </div>

      <div class="launcher-row">
        <div class="launcher-shortcut">
          <span class="launcher-shortcut__state">
            <b>Ярлык «Кокпит»</b>
            <span class="launcher-note" data-testid="shortcut-state">{{ shortcutLabel }}</span>
          </span>
          <UiButton
            data-role="settings-action"
            data-testid="shortcut-toggle"
            :disabled="busy || (!shortcutPresent && !state.shortcut.desktopDir)"
            @click="toggleShortcut"
          >
            {{ shortcutPresent ? 'Убрать ярлык' : 'Создать ярлык' }}
          </UiButton>
        </div>
        <p class="launcher-note">
          Файл кладётся на рабочий стол и в меню приложений и запускает <code>cockpit open</code>:
          открывает кокпит в браузере, а если сервер не отвечает — сначала поднимает его.
        </p>
      </div>

      <p v-if="message" class="launcher-msg" :class="message.type" data-testid="launcher-message">
        {{ message.text }}
      </p>
    </template>
    <p v-else class="launcher-msg err">Не удалось прочитать состояние автозапуска.</p>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { api } from '../../shared/apiClient.ts';
import { UiButton, UiSwitch } from '../../ui';

// Режим процесса из карточки «Процесс Cockpit»: null — ещё не известен.
// mode — 'desktop', 'systemd' или 'manual'; у сервера до перезапуска его нет.
defineProps({
  systemd: { type: Boolean, default: null },
  mode: { type: String, default: null },
});

// { autostart: { unit, active, linger, mode }, shortcut: { desktopDir, desktop, menu } }
const state = ref(null);
const loading = ref(false);
const busy = ref(false);
const message = ref(null);

const autostartOn = computed(() => state.value?.autostart.unit === 'enabled');
const autostartUnavailable = computed(() => state.value?.autostart.unit === 'missing');
const shortcutPresent = computed(() => !!(state.value?.shortcut.desktop || state.value?.shortcut.menu));

const MODE_LABELS = {
  boot: 'При включении машины',
  login: 'Только при входе',
  off: 'Выключен',
  unavailable: 'Недоступен',
};

const modeLabel = computed(() => MODE_LABELS[state.value?.autostart.mode] || 'Недоступен');

const pillTone = computed(() => {
  const mode = state.value?.autostart.mode;

  if (mode === 'boot') return 'ok';
  if (mode === 'off') return '';

  return 'warn';
});

// Текст под переключателем называет, что именно случится после перезагрузки, и что делать,
// если желаемого режима с этой страницы не добиться (linger выдаёт только сессия).
const autostartNote = computed(() => {
  const autostart = state.value?.autostart;

  if (!autostart) return '';
  if (autostart.unit === 'missing') {
    return 'Юнит systemd не установлен — один раз выполни deploy/install.sh, тогда переключатель заработает.';
  }
  if (autostart.unit === 'disabled') {
    return 'После перезагрузки сервер поднимет ярлык «Кокпит», cockpit open'
      + ' или systemctl --user start cockpit-server.';
  }
  if (autostart.linger === true) {
    return 'Сервер стартует при включении машины, до входа в систему — Telegram-пульт жив сразу.';
  }
  if (autostart.linger === false) {
    return 'Сервер стартует только при входе в систему. Чтобы стартовал до входа, выполни в терминале '
      + 'loginctl enable-linger — сервису без сессии это право не выдаётся.';
  }

  return 'Автозапуск включён; стартует ли сервер до входа в систему, узнать не удалось (logind не ответил).';
});

const shortcutLabel = computed(() => {
  const shortcut = state.value?.shortcut;

  if (!shortcut) return '';
  if (shortcut.desktop && shortcut.menu) return 'на рабочем столе и в меню приложений';
  if (shortcut.desktop) return 'на рабочем столе';
  if (shortcut.menu) return 'только в меню приложений';
  if (!shortcut.desktopDir) return 'не создан — каталог рабочего стола не найден';

  return 'не создан';
});

async function load() {
  loading.value = true;
  try {
    state.value = await api.get('/api/system/launcher');
  } catch {
    state.value = null;
  } finally {
    loading.value = false;
  }
}

/**
 * Переключение не трогает живой процесс: меняется только enable юнита (и linger при
 * включении). Ответ сервера — свежее состояние, из него же берётся подсказка под тумблером.
 */
async function setAutostart(enabled) {
  if (busy.value) return;
  busy.value = true;
  message.value = null;
  try {
    const { autostart } = await api.put('/api/system/launcher/autostart', { enabled });

    state.value = { ...state.value, autostart };
    message.value = {
      type: 'ok',
      text: enabled ? 'Автозапуск включён.' : 'Автозапуск выключен: живой сервер не тронут.',
    };
  } catch (error) {
    message.value = { type: 'err', text: error?.message || 'Не удалось переключить автозапуск.' };
  } finally {
    busy.value = false;
  }
}

async function toggleShortcut() {
  if (busy.value) return;
  busy.value = true;
  message.value = null;
  const removing = shortcutPresent.value;
  try {
    const { shortcut } = removing
      ? await api.del('/api/system/launcher/shortcut')
      : await api.post('/api/system/launcher/shortcut');

    state.value = { ...state.value, shortcut };
    message.value = {
      type: 'ok',
      text: removing
        ? 'Ярлык убран с рабочего стола и из меню.'
        : `Ярлык создан: ${shortcut.desktopDir}/cockpit.desktop и меню приложений.`,
    };
  } catch (error) {
    message.value = { type: 'err', text: error?.message || 'Не удалось изменить ярлык.' };
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
/* Подраздел не наследует scoped-стили SettingsView, поэтому карточка описана здесь целиком. */
.launcher { display: flex; flex-direction: column; gap: 14px; }
.launcher-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.launcher-head h3 { margin: 0 0 4px; font-size: 14px; font-weight: 660; letter-spacing: -.01em; }
.launcher-head p { margin: 0; max-width: 66ch; color: var(--ink-mid); font-size: 12.5px; line-height: 1.5; }
.launcher-pill {
  flex: none; display: inline-flex; align-items: center; gap: 6px; min-height: 25px; padding: 3px 9px;
  border: 1px solid var(--line); border-radius: 999px; background: var(--ground);
  color: var(--ink-mid); font-size: 10.5px; white-space: nowrap;
}
.launcher-pill .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ink-mid); }
.launcher-pill.ok { border-color: color-mix(in srgb, var(--good) 34%, var(--line)); color: var(--good); }
.launcher-pill.ok .dot { background: var(--good); }
.launcher-pill.warn { border-color: color-mix(in srgb, var(--warn) 38%, var(--line)); color: var(--warn); }
.launcher-pill.warn .dot { background: var(--warn); }
.launcher-row { display: grid; gap: 6px; }
.launcher-note { margin: 0; max-width: 78ch; color: var(--ink-mid); font-size: 12px; line-height: 1.5; }
.launcher-note code { background: var(--surface-2); border-radius: 4px; padding: 1px 5px; font-size: 12px; }
.launcher-shortcut { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.launcher-shortcut__state {
  display: flex; flex-direction: column; gap: 2px; min-width: 0; font-size: 13.5px;
}
.launcher-shortcut__state b { font-weight: 640; }
.launcher-msg { margin: 0; font-size: 13px; white-space: pre-line; }
.launcher-msg.ok { color: var(--good); }
.launcher-msg.err { color: var(--bad); }
@media (max-width: 719px) {
  .launcher-shortcut { flex-direction: column; align-items: flex-start; }
}
</style>

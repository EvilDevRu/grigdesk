<script setup>
import { ref, onMounted, onUnmounted, watchEffect } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../shared/api-client.js';
import { useProvidersStore } from '../stores/providers.js';
import { useUiContextStore } from '../stores/ui-context.js';
import ProviderIcon from '../shared/ProviderIcon.vue';
import ToggleSwitch from '../shared/ui/ToggleSwitch.vue';

// Настройки сгруппированы по табам — новые разделы добавляются записью в TABS.
const TABS = [
  { id: 'b24', label: 'Битрикс24' },
  { id: 'providers', label: 'Исполнители' },
  { id: 'runs', label: 'Запуски' },
];
const tab = ref(localStorage.getItem('cockpit-settings-tab') || 'b24');
function setTab(id) { tab.value = id; localStorage.setItem('cockpit-settings-tab', id); }

// Репортим открытый таб в UI-контекст — чат с агентом знает, что открыто.
const ui = useUiContextStore();
watchEffect(() => ui.set('settings', { tab: TABS.find((t) => t.id === tab.value)?.label || tab.value }));
onUnmounted(() => ui.clear('settings'));

// ── Битрикс24 ──
const form = ref({ baseUrl: '', login: '', password: '' });
const configured = ref(false);
const saving = ref(false);
const testing = ref(false);
const msg = ref(null);

async function loadCurrent() {
  try {
    const v = await api.get('/api/settings/b24');
    configured.value = v.configured;
    form.value.baseUrl = v.baseUrl;
    form.value.login = v.login;
  } catch (e) { msg.value = { type: 'err', text: e.message }; }
}
async function save() {
  saving.value = true; msg.value = null;
  try {
    await api.post('/api/settings/b24', { ...form.value });
    configured.value = true;
    form.value.password = '';
    msg.value = { type: 'ok', text: 'Сохранено.' };
    await loadCurrent();
  } catch (e) { msg.value = { type: 'err', text: e.message }; } finally { saving.value = false; }
}
async function testAuth() {
  testing.value = true; msg.value = null;
  try {
    const r = await api.post('/api/settings/b24/test');
    msg.value = r.ok ? { type: 'ok', text: `Авторизация успешна (userId ${r.userId}).` } : { type: 'err', text: `Не удалось: ${r.error}` };
  } catch (e) { msg.value = { type: 'err', text: e.message }; } finally { testing.value = false; }
}

// ── Исполнители (реестр LLM-агентов) ──
const prov = useProvidersStore();
const refreshing = ref(false);
async function refreshProv() {
  refreshing.value = true;
  await prov.load(true);
  refreshing.value = false;
}
// Команда установки недоступного исполнителя — клик открывает терминал
// с уже введённой командой (выполнение — Enter'ом пользователя).
const router = useRouter();
function installInTerminal(p) {
  sessionStorage.setItem('cockpit-term-insert', p.install);
  router.push('/terminal');
}

// ── Запуски (правила перед стартом триажа/конвейера) ──
const prefs = ref(null);
const prefsMsg = ref(null);
async function loadPrefs() {
  try { prefs.value = await api.get('/api/settings/prefs'); } catch { prefs.value = null; }
}
async function toggleGitRefresh(v) {
  prefsMsg.value = null;
  try {
    prefs.value = await api.post('/api/settings/prefs', { gitRefreshBeforeRun: v });
    prefsMsg.value = { type: 'ok', text: 'Сохранено.' };
  } catch (e) { prefsMsg.value = { type: 'err', text: e.message }; }
}

onMounted(() => { loadCurrent(); prov.load(); loadPrefs(); });
</script>

<template>
  <div class="settings">
    <nav class="tabs">
      <button v-for="t in TABS" :key="t.id" class="tabbtn" :class="{ active: tab === t.id }" @click="setTab(t.id)">
        {{ t.label }}
      </button>
    </nav>

    <!-- Битрикс24 -->
    <section v-if="tab === 'b24'">
      <p class="muted">Кокпит — единственный владелец сессии портала. Креды хранятся на сервере (не в git).</p>
      <div class="card">
        <label>Портал<input v-model="form.baseUrl" placeholder="https://ваш-портал.bitrix24.ru" /></label>
        <label>Логин<input v-model="form.login" autocomplete="username" placeholder="user@example.com" /></label>
        <label>Пароль
          <input v-model="form.password" type="password" autocomplete="current-password"
                 :placeholder="configured ? '•••••• (задан, введите новый для замены)' : 'пароль портала'" />
        </label>
        <div class="row">
          <button class="primary" :disabled="saving || !form.login || !form.password" @click="save">{{ saving ? 'Сохранение…' : 'Сохранить' }}</button>
          <button :disabled="testing || !configured" @click="testAuth">{{ testing ? 'Проверка…' : 'Проверить авторизацию' }}</button>
        </div>
        <p v-if="msg" class="msg" :class="msg.type">{{ msg.text }}</p>
      </div>
    </section>

    <!-- Исполнители: реестр LLM-агентов (/api/providers) -->
    <section v-else-if="tab === 'providers'">
      <p class="muted">
        Реестр агентов-исполнителей. Его же читают топбар (иконки) и в перспективе схемы —
        исполнителем шага сможет быть не только Claude. Авторизация — на хосте
        (<code>claude login</code>), кокпит только показывает статус.
      </p>
      <div class="card">
        <div v-if="!prov.loaded" class="muted">Загрузка…</div>
        <div v-for="p in prov.providers" :key="p.id" class="pv">
          <span class="pvicon" :style="{ color: p.available ? p.color : 'var(--ink-mid)' }">
            <ProviderIcon :provider="p" :size="20" />
          </span>
          <div class="pvmid">
            <div class="pvname">{{ p.name }} <span class="muted">· {{ p.vendor }} · {{ p.kind }}</span></div>
            <div class="pvsub muted">{{ p.authLabel }}<template v-if="p.version"> · {{ p.version }}</template></div>
            <div v-if="!p.available && p.install" class="pvinstall">
              {{ p.installed ? 'Авторизация' : 'Установка' }}:
              <code class="click" title="Кликни — откроется терминал с введённой командой"
                    @click="installInTerminal(p)">{{ p.install }}</code>
            </div>
          </div>
          <span class="pvstate" :class="p.available ? 'ok' : 'err'">
            <span class="dot"></span>{{ p.available ? 'доступен' : 'недоступен' }}
          </span>
        </div>
        <div class="row">
          <button :disabled="refreshing" @click="refreshProv">{{ refreshing ? 'Проверка…' : 'Перепроверить' }}</button>
        </div>
      </div>
    </section>

    <!-- Запуски: обязательные правила перед стартом триажа/конвейера -->
    <section v-else-if="tab === 'runs'">
      <p class="muted">
        Правила, которые кокпит применяет перед каждым запуском — триажем задачи
        и стартом конвейера фабрики.
      </p>
      <div class="card">
        <div v-if="!prefs" class="muted">Загрузка…</div>
        <template v-else>
          <ToggleSwitch :model-value="prefs.gitRefreshBeforeRun" label="Обновлять репозитории перед запуском"
                        @update:model-value="toggleGitRefresh" />
          <p class="muted small">
            Перед триажем и конвейером: <code>git fetch</code> всегда; <code>git pull --ff-only</code> —
            только если репозиторий стоит на чистом master (ветка задачи или незакоммиченные
            правки не трогаются, в результате запуска фиксируется причина пропуска).
          </p>
          <p v-if="prefsMsg" class="msg" :class="prefsMsg.type">{{ prefsMsg.text }}</p>
        </template>
      </div>
    </section>
  </div>
</template>

<style scoped>
.settings { max-width: 56ch; display: flex; flex-direction: column; gap: 16px; }
section { display: flex; flex-direction: column; gap: 8px; }

.tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--line); }
.tabbtn { background: none; border: none; border-bottom: 2px solid transparent; margin-bottom: -1px;
  color: var(--ink-mid); font-size: 14px; padding: 8px 12px 9px; cursor: pointer; }
.tabbtn:hover { color: var(--ink); }
.tabbtn.active { color: var(--ink); border-bottom-color: var(--accent); font-weight: 600; }

.muted code { background: var(--surface-2); border-radius: 4px; padding: 1px 5px; font-size: 12px; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px; display: flex; flex-direction: column; gap: 12px; margin-top: 4px; }
label { display: flex; flex-direction: column; gap: 5px; font-size: 13px; color: var(--ink-mid); }
input { padding: 9px 11px; border: 1px solid var(--line); border-radius: 9px; background: var(--ground); color: var(--ink); font-size: 14px; }
input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
.row { display: flex; gap: 8px; flex-wrap: wrap; }
button { padding: 9px 14px; border-radius: 9px; border: 1px solid var(--line); background: var(--surface-2); color: var(--ink); font-size: 14px; cursor: pointer; }
button:disabled { opacity: .5; cursor: default; }
button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
.msg { font-size: 13px; margin: 0; }
.small { font-size: 12px; line-height: 1.5; }
.msg.ok { color: var(--good); }
.msg.err { color: var(--bad); }

/* Строка исполнителя */
.pv { display: flex; align-items: center; gap: 12px; }
.pvicon { flex: none; display: grid; place-items: center; width: 34px; height: 34px;
  border: 1px solid var(--line); border-radius: 9px; background: var(--ground); }
.pvmid { flex: 1; min-width: 0; }
.pvname { font-size: 14px; font-weight: 600; }
.pvsub { font-size: 12.5px; }
.pvstate { flex: none; display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; }
.pvstate .dot { width: 8px; height: 8px; border-radius: 50%; }
.pvstate.ok { color: var(--good); }
.pvstate.ok .dot { background: var(--good); box-shadow: 0 0 6px color-mix(in srgb, var(--good) 60%, transparent); }
.pvstate.err { color: var(--bad); }
.pvstate.err .dot { background: var(--bad); }
/* Подсказка установки недоступного исполнителя */
.pvinstall { font-size: 12px; color: var(--ink-mid); margin-top: 4px; }
.pvinstall code.click { background: var(--ground); border: 1px solid var(--line); border-radius: 5px;
  padding: 2px 7px; font-size: 11.5px; cursor: pointer; user-select: all; }
.pvinstall code.click:hover { border-color: var(--line-2); color: var(--ink); }
</style>

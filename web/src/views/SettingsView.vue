<script setup>
import { ref, onMounted, onUnmounted, watchEffect } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../shared/api-client.js';
import { useProvidersStore } from '../stores/providers.js';
import { useUiContextStore } from '../stores/ui-context.js';
import ProviderIcon from '../shared/ProviderIcon.vue';
import ToggleSwitch from '../shared/ui/ToggleSwitch.vue';
import { useAuthStore } from '../stores/auth.js';
import { usePluginsStore } from '../stores/plugins.js';
import { confirmDialog } from '../shared/ui/confirm.js';
import { FACTORY_DEBUG_LEVELS, factoryDebugPayload } from '../shared/factory-debug.js';

// Настройки сгруппированы по табам — новые разделы добавляются записью в TABS.
const TABS = [
  { id: 'b24', label: 'Битрикс24' },
  { id: 'providers', label: 'Исполнители' },
  { id: 'runs', label: 'Запуски' },
  { id: 'plugins', label: 'Плагины' },
  { id: 'server', label: 'Сервер' },
  { id: 'access', label: 'Доступ' },
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

// Проверка новых версий CLI. Сервер и сам проверяет раз в 6 часов (индикатор в топбаре),
// эта кнопка — «посмотреть прямо сейчас». Обновление НИКОГДА не запускается само.
const checking = ref(false);
async function checkUpdates() {
  checking.value = true;
  try {
    await api.post('/api/providers/check-updates', {});
    await prov.load(true);
  } catch { /* сеть недоступна — индикатор просто останется прежним */ }
  finally { checking.value = false; }
}

// Обновление CLI исполнителя. Версия CLI и доступ аккаунта определяют набор моделей:
// после обновления Кокпит принудительно перечитывает каталог самого исполнителя.
const updating = ref('');
const updMsg = ref({});
async function updateProvider(p) {
  updating.value = p.id;
  updMsg.value = { ...updMsg.value, [p.id]: null };
  try {
    const r = await api.post(`/api/providers/${p.id}/update`, {});
    updMsg.value = {
      ...updMsg.value,
      [p.id]: r.changed
        ? { type: 'ok', text: `Обновлён: ${r.before || '?'} → ${r.after}. Список моделей пересобран.` }
        : { type: r.ok ? 'ok' : 'err', text: r.ok ? `Уже последняя версия (${r.after || r.before}).` : `Не получилось: ${(r.output || '').slice(-300)}` },
    };
    await prov.load(true);
  } catch (e) {
    updMsg.value = { ...updMsg.value, [p.id]: { type: 'err', text: e.message } };
  } finally { updating.value = ''; }
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
async function toggleAutoRecover(v) {
  prefsMsg.value = null;
  try {
    prefs.value = await api.post('/api/settings/prefs', { autoRecoverPipelines: v });
    prefsMsg.value = {
      type: 'ok',
      text: v
        ? 'Автовосстановление включено и применится при следующем запуске Cockpit.'
        : 'Автовосстановление выключено.',
    };
  } catch (e) { prefsMsg.value = { type: 'err', text: e.message }; }
}

// Подробный trace фабрики. Сам файл настроек принадлежит engine writer-у; UI работает
// только через /api/settings/factory-debug.
const factoryDebug = ref(null);
const factoryDebugBusy = ref(false);
const factoryDebugMsg = ref(null);

async function loadFactoryDebug({ keepMessage = false } = {}) {
  try {
    factoryDebug.value = await api.get('/api/settings/factory-debug?scope=global');
    if (!keepMessage) factoryDebugMsg.value = null;
  } catch (e) {
    factoryDebug.value = null;
    factoryDebugMsg.value = { type: 'err', text: e.message };
  }
}

async function saveFactoryDebug(level) {
  factoryDebugBusy.value = true;
  factoryDebugMsg.value = null;
  try {
    factoryDebug.value = await api.post(
      '/api/settings/factory-debug',
      factoryDebugPayload(level),
    );
    factoryDebugMsg.value = {
      type: 'ok',
      text: level === 'off' ? 'Подробное логирование выключено.' : 'Уровень логирования сохранён.',
    };
  } catch (e) {
    factoryDebugMsg.value = { type: 'err', text: e.message };
    await loadFactoryDebug({ keepMessage: true });
  } finally {
    factoryDebugBusy.value = false;
  }
}

// Сколько моделей исполнителя сейчас скрыто из выбора — считаем тем же правилом,
// по которому строится селект в чате (стор providers), а не своей копией условия.
function hiddenCount(p) {
  return (p.models || []).length - prov.visibleModels(p).length;
}

// Показ старых версий моделей в выборе чата. Сохраняем на сервере (настройка общая для всех
// окон) и сразу отражаем в сторе — селект перестраивается без перезагрузки.
const modelsMsg = ref(null);
async function toggleShowAllModels(v) {
  modelsMsg.value = null;
  try {
    prefs.value = await api.post('/api/settings/prefs', { showAllModels: v });
    prov.showAllModels = !!prefs.value.showAllModels;
  } catch (e) { modelsMsg.value = { type: 'err', text: e.message }; }
}

// ── Доступ (вход в кокпит) ──
const auth = useAuthStore();
const acc = ref({ currentPassword: '', login: '', password: '', password2: '' });
const accBusy = ref(false);
const accMsg = ref(null);

async function saveAccount() {
  accMsg.value = null;
  if (acc.value.password.length < 8) { accMsg.value = { type: 'err', text: 'Новый пароль — не короче 8 символов.' }; return; }
  if (acc.value.password !== acc.value.password2) { accMsg.value = { type: 'err', text: 'Пароли не совпадают.' }; return; }
  accBusy.value = true;
  try {
    const r = await api.post('/api/auth/password', {
      currentPassword: acc.value.currentPassword,
      login: acc.value.login,
      password: acc.value.password,
    });
    acc.value = { currentPassword: '', login: acc.value.login, password: '', password2: '' };
    accMsg.value = { type: 'ok', text: `Сохранено. ${r.note || ''}`.trim() };
    await auth.load();
  } catch (e) {
    accMsg.value = { type: 'err', text: e.data?.message || e.message };
  } finally { accBusy.value = false; }
}

async function logoutAll() {
  if (!confirm('Разлогинить все устройства, включая это?')) return;
  try { await api.post('/api/auth/logout-all'); } catch { /* всё равно уходим на вход */ }
  auth.authenticated = false;
}

// ── Плагины ──
const pluginsStore = usePluginsStore();
const plugMsg = ref(null);
async function savePlugin(p) {
  await pluginsStore.saveSettings(p.id, p.values);
  plugMsg.value = p.id;
  setTimeout(() => { if (plugMsg.value === p.id) plugMsg.value = null; }, 2000);
}

// ── Сервер (режим запуска и перезапуск) ──
const srv = ref(null);          // { systemd, pid, uptimeSec }
const restarting = ref(false);
const srvMsg = ref(null);

async function loadServer() { try { srv.value = await api.get('/api/system/server'); } catch { srv.value = null; } }

function fmtUptime(s) {
  if (s >= 86400) return `${Math.floor(s / 86400)}д ${Math.floor((s % 86400) / 3600)}ч`;
  if (s >= 3600) return `${Math.floor(s / 3600)}ч ${Math.floor((s % 3600) / 60)}м`;
  if (s >= 60) return `${Math.floor(s / 60)}м`;
  return `${s}с`;
}

async function restartServer() {
  // Рестарт обрывает идущие ходы агентов в чатах (они — дочерние процессы сервера):
  // честно предупреждаем числом, а не общими словами.
  let active = 0;
  try { active = ((await api.get('/api/chat/active')).active || []).length; } catch { /* счётчик не критичен */ }
  const mode = srv.value?.systemd
    ? 'Сервер выйдет, юнит systemd поднимет его сам.'
    : 'Сервер запущен вручную — перезапустится через bin/restart.';
  const warn = active ? ` Сейчас идут ходы агентов: ${active} — они ОБОРВУТСЯ.` : '';
  if (!(await confirmDialog(`Перезапустить сервер кокпита? ${mode}${warn}`, { danger: !!active, okText: 'Перезапустить' }))) return;
  restarting.value = true; srvMsg.value = null;
  try { await api.post('/api/system/restart'); } catch { /* процесс мог умереть раньше ответа — это норм */ }
  // Ждём возвращения по публичному /api/auth/state (как bin/restart) и перезагружаем
  // страницу — она подтянет свежий бандл; ради применения нового кода кнопка и нужна.
  const t0 = Date.now();
  while (Date.now() - t0 < 40_000) {
    await new Promise((r) => { setTimeout(r, 1000); });
    try { await api.get('/api/auth/state'); location.reload(); return; }
    catch { /* ещё поднимается */ }
  }
  restarting.value = false;
  srvMsg.value = { type: 'err', text: 'Сервер не вернулся за 40 секунд — смотри journalctl --user -u cockpit-server или server/.state/cockpit-server.log.' };
}

onMounted(() => {
  loadCurrent();
  prov.load();
  loadPrefs();
  loadFactoryDebug();
  pluginsStore.load();
  loadServer();
  acc.value.login = auth.login || '';
});
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
            <div v-if="p.models?.length" class="pvsub muted">
              моделей в каталоге: {{ p.models.length }}<template v-if="hiddenCount(p)"> (в выборе {{ p.models.length - hiddenCount(p) }} — остальные скрыты)</template><template v-if="p.models.some((m) => m.unknown)"> · есть неизвестные CLI (помечены «?»)</template>
            </div>
            <!-- Индикатор новой версии: кокпит только сообщает, обновление — по кнопке -->
            <div v-if="p.updateAvailable" class="pvupd">
              ● Доступно обновление: <b>{{ p.latest }}</b> — нажми «Обновить»
            </div>
            <div v-else-if="p.latest" class="pvsub muted">последняя версия ({{ p.latest }})</div>
            <p v-if="updMsg[p.id]" class="msg" :class="updMsg[p.id].type">{{ updMsg[p.id].text }}</p>
          </div>
          <div class="pvright">
            <span class="pvstate" :class="p.available ? 'ok' : 'err'">
              <span class="dot"></span>{{ p.available ? 'доступен' : 'недоступен' }}
            </span>
            <button v-if="p.installed && p.canUpdate" class="upd" :class="{ hot: p.updateAvailable }" :disabled="!!updating"
                    title="Обновить CLI исполнителя. После обновления каталог моделей перечитается."
                    @click="updateProvider(p)">
              {{ updating === p.id ? 'Обновление…' : 'Обновить' }}
            </button>
          </div>
        </div>
        <!-- Что показывать в выборе модели: только свежие версии или вообще всё, что помнит CLI -->
        <div class="prow">
          <ToggleSwitch :model-value="prefs?.showAllModels === true" label="Показывать все модели: скрытые и старые версии"
                        @update:model-value="toggleShowAllModels" />
          <div class="muted small">
            По умолчанию в выборе — актуальные модели из каталогов установленных исполнителей.
            Скрытые, устаревающие и старые версии доступны по этому флажку; дублирующие алиасы
            схлопываются с канонической моделью.
          </div>
          <p v-if="modelsMsg" class="msg" :class="modelsMsg.type">{{ modelsMsg.text }}</p>
        </div>
        <div class="row">
          <button :disabled="refreshing" @click="refreshProv">{{ refreshing ? 'Проверка…' : 'Перепроверить' }}</button>
          <button :disabled="checking" title="Кокпит и сам проверяет раз в 6 часов; обновление никогда не запускается автоматически"
                  @click="checkUpdates">{{ checking ? 'Смотрю…' : 'Проверить обновления' }}</button>
        </div>
        <p class="muted small">
          Новые версии проверяются автоматически раз в 6 часов (индикатор — точка на иконке
          исполнителя в шапке). Обновление ставится только по кнопке.
        </p>
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
          <ToggleSwitch :model-value="prefs.autoRecoverPipelines" label="Продолжать незакрытые конвейеры после запуска Cockpit"
                        @update:model-value="toggleAutoRecover" />
          <p class="muted small">
            Кокпит возобновит только прогон с погибшим демоном. Ворота, остановка для
            человека, завершённая задача и повторяющийся сбой остаются заблокированными.
            После трёх аварийных перезапусков потребуется ручное решение.
          </p>
          <p v-if="prefsMsg" class="msg" :class="prefsMsg.type">{{ prefsMsg.text }}</p>
        </template>
      </div>
      <div class="card">
        <div>
          <b>Диагностическое логирование фабрики</b>
          <p class="muted small debug-copy">
            Помогает разбирать выбор модели, переключение ИИ и ошибки runner-а.
            Не меняет маршрут или результат этапа. Короткий обязательный audit остаётся
            даже в режиме «Выключено».
          </p>
        </div>
        <div v-if="!factoryDebug && !factoryDebugMsg" class="muted">Загрузка…</div>
        <div v-else class="debug-setting">
          <label>
            Уровень
            <select class="settings-select"
                    :value="factoryDebug?.effective || 'off'"
                    :disabled="factoryDebugBusy"
                    @change="saveFactoryDebug($event.target.value)">
              <option v-for="level in FACTORY_DEBUG_LEVELS"
                      :key="level.value"
                      :value="level.value">
                {{ level.label }}
              </option>
            </select>
          </label>
          <span v-if="factoryDebug" class="debug-effective">
            действует: <b>{{ factoryDebug.effective }}</b>
            <span class="muted"> · источник: {{ factoryDebug.source }}</span>
          </span>
        </div>
        <p class="muted small">
          Подробные журналы имеют ограничение размера и срок хранения; prompt, credentials
          и status/control tokens в них не записываются. Выключение не удаляет уже созданные логи.
        </p>
        <p v-if="factoryDebugMsg" class="msg" :class="factoryDebugMsg.type">
          {{ factoryDebugMsg.text }}
        </p>
      </div>
    </section>

    <!-- Плагины: отключаемые блоки кокпита. Системные — из коробки; пользовательские —
         папки plugins/<id>/ (plugin.json + server.js), подхватываются на старте сервера. -->
    <section v-else-if="tab === 'plugins'">
      <p class="muted">
        Плагин — отключаемый раздел кокпита: пункт в сайдбаре (под разделителем), свои API и настройки.
        Свой плагин — папка <code>plugins/&lt;id&gt;/</code> с манифестом <code>plugin.json</code>
        (+ опционально <code>server.js</code>), появится здесь после рестарта сервера.
      </p>
      <div v-if="!pluginsStore.loaded" class="muted">Загрузка…</div>
      <div v-else class="plugcards">
        <div v-for="p in pluginsStore.list" :key="p.id" class="card plugcard">
          <div class="plughead">
            <div>
              <b>{{ p.name }}</b>
              <span class="plugver">v{{ p.version }}</span>
              <span class="plugtag" :class="{ user: !p.system }">{{ p.system ? 'системный' : 'пользовательский' }}</span>
            </div>
            <ToggleSwitch :model-value="p.enabled" label="" @update:model-value="(v) => pluginsStore.toggle(p.id, v)" />
          </div>
          <p class="muted small">{{ p.description }}</p>
          <p v-if="p.needsRestart" class="muted small">Серверная часть подключается на старте — вкл/выкл подействует после рестарта кокпита.</p>
          <div v-if="p.enabled && p.settings.length" class="plugset">
            <div v-for="s in p.settings" :key="s.key" class="plugrow">
              <label>{{ s.label }}</label>
              <select v-if="s.type === 'select'" v-model="p.values[s.key]" class="inp">
                <option v-for="o in s.options" :key="o" :value="o">{{ o }}</option>
              </select>
              <input v-else-if="s.type === 'checkbox'" v-model="p.values[s.key]" type="checkbox" />
              <input v-else v-model="p.values[s.key]" class="inp" type="text" />
            </div>
            <button class="btn" @click="savePlugin(p)">Сохранить</button>
            <span v-if="plugMsg === p.id" class="msg ok">Сохранено</span>
          </div>
        </div>
      </div>
    </section>

    <!-- Сервер: демон systemd, перезапуск для применения нового кода (плагины, правки сервера) -->
    <section v-else-if="tab === 'server'">
      <p class="muted">
        Боевой режим — демон systemd: юнит ставится один раз командой <code>deploy/install.sh</code>,
        дальше сервер живёт сам (<code>Restart=always</code>, ждёт VPN, переживает перезагрузки) —
        ручные запуски не нужны. Кнопка ниже применяет новый код: свежие плагины и правки
        сервера подхватываются перезапуском.
      </p>
      <div class="card">
        <div v-if="!srv" class="muted">Загрузка…</div>
        <template v-else>
          <p class="srvline">
            Режим: <b>{{ srv.systemd ? 'демон systemd' : 'запущен вручную' }}</b>
            <span class="muted"> · PID {{ srv.pid }} · работает {{ fmtUptime(srv.uptimeSec) }}</span>
          </p>
          <p v-if="!srv.systemd" class="muted small">
            Ручной запуск — режим разработки. Чтобы демон поднимался сам, один раз выполни
            <code>deploy/install.sh</code>. Режимы не смешивать: ручной экземпляр держит порт,
            и юнит будет падать в цикле (уже наступали — 7553 падения).
          </p>
          <button class="btn" :disabled="restarting" @click="restartServer">
            {{ restarting ? 'Перезапускаю… жду возвращения' : 'Перезапустить сервер' }}
          </button>
          <p v-if="srvMsg" class="msg" :class="srvMsg.type">{{ srvMsg.text }}</p>
        </template>
      </div>
    </section>

    <!-- Доступ: вход в сам кокпит (один пользователь) -->
    <section v-else-if="tab === 'access'">
      <p class="muted">
        Вход в кокпит. Пароль хранится хешем на сервере (<code>.state</code>, не в git) и в браузер
        не попадает — клиент получает только сессионную cookie.
      </p>

      <!-- Предупреждение только когда оно по делу: на localhost соединение и так не выходит
           за пределы машины, а за шлюзом браузер идёт по https. -->
      <p v-if="!auth.secure && !auth.isLocal" class="msg err">
        Соединение без HTTPS — пароль передаётся открытым текстом. Для доступа из сети нужен
        шлюз (<code>COCKPIT_TRUST_PROXY</code>) либо свой сертификат
        (<code>COCKPIT_TLS_KEY</code> и <code>COCKPIT_TLS_CERT</code>).
      </p>

      <div class="card">
        <label>Логин<input v-model="acc.login" autocomplete="username" placeholder="необязательно" /></label>
        <label>Текущий пароль
          <input v-model="acc.currentPassword" type="password" autocomplete="current-password" />
        </label>
        <label>Новый пароль
          <input v-model="acc.password" type="password" autocomplete="new-password" placeholder="минимум 8 символов" />
        </label>
        <label>Новый пароль ещё раз
          <input v-model="acc.password2" type="password" autocomplete="new-password" />
        </label>
        <p class="muted small">
          Смена пароля разлогинивает все устройства — украденная cookie перестаёт работать.
          Текущее устройство останется в системе.
        </p>
        <div class="row">
          <button class="primary" :disabled="accBusy || !acc.currentPassword || !acc.password" @click="saveAccount">
            {{ accBusy ? 'Сохранение…' : 'Сменить пароль' }}
          </button>
          <button @click="auth.doLogout()">Выйти</button>
          <button @click="logoutAll">Выйти со всех устройств</button>
        </div>
        <p v-if="accMsg" class="msg" :class="accMsg.type">{{ accMsg.text }}</p>
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
/* Карточки плагинов — горизонтальной линией, с переносом на узких экранах. */
.plugcards { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 12px; align-items: start; }
.plugcard { gap: 8px; }
.plughead { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.plugver { color: var(--mut); font-size: 12px; margin-left: 8px; }
.plugtag { font-size: 11px; border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px; margin-left: 8px; color: var(--mut); }
.plugtag.user { border-color: color-mix(in srgb, var(--accent) 45%, transparent); color: var(--accent); }
.plugcard .small { flex: 1; }
.plugset { display: flex; flex-direction: column; gap: 8px; border-top: 1px dashed var(--line); padding-top: 10px; }
.plugrow { display: flex; align-items: center; gap: 10px; }
.plugrow label { min-width: 140px; color: var(--mut); font-size: 13px; }
.plugrow .inp { max-width: 220px; }
/* Нормальный селект вместо нативного: свой фон, рамка и шеврон. */
.plugrow select.inp {
  appearance: none; -webkit-appearance: none;
  background: var(--bg) url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23888da8' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") no-repeat right 10px center;
  border: 1px solid var(--line); border-radius: 8px; color: var(--ink);
  padding: 6px 28px 6px 10px; font: inherit; font-size: 13px; cursor: pointer;
}
.plugrow select.inp:hover { border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); }
.plugrow select.inp:focus { outline: none; border-color: var(--accent); }
label { display: flex; flex-direction: column; gap: 5px; font-size: 13px; color: var(--ink-mid); }
input { padding: 9px 11px; border: 1px solid var(--line); border-radius: 9px; background: var(--ground); color: var(--ink); font-size: 14px; }
input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
.row { display: flex; gap: 8px; flex-wrap: wrap; }
.debug-copy { margin: 5px 0 0; }
.debug-setting { display: flex; align-items: end; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.debug-setting label { min-width: 230px; }
.debug-effective { font-size: 12px; padding-bottom: 8px; color: var(--ink-mid); }
.settings-select {
  appearance: none; -webkit-appearance: none;
  background: var(--ground) url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23888da8' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") no-repeat right 11px center;
  border: 1px solid var(--line); border-radius: 9px; color: var(--ink);
  padding: 9px 32px 9px 11px; font: inherit; font-size: 14px; cursor: pointer;
}
.settings-select:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
.settings-select:disabled { opacity: .55; cursor: default; }
/* Настройка показа моделей — отделена от списка исполнителей */
.prow { border-top: 1px solid var(--line); margin-top: 12px; padding-top: 12px; display: grid; gap: 6px; }
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
/* Правая колонка карточки исполнителя: статус + обновление CLI */
.pvright { flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: 7px; }
.upd { background: var(--surface-2); border: 1px solid var(--line); color: var(--ink); border-radius: 8px;
  padding: 5px 11px; font-size: 12px; cursor: pointer; }
.upd:hover:not(:disabled) { border-color: var(--line-2); }
.upd:disabled { opacity: .55; cursor: default; }
/* Есть новая версия — кнопка заметная, но ничего не делает сама */
.upd.hot { border-color: color-mix(in srgb, var(--warn, #e0a33a) 55%, var(--line));
  background: color-mix(in srgb, var(--warn, #e0a33a) 14%, transparent); color: var(--warn, #e0a33a); }
.pvupd { margin-top: 3px; font-size: 12.5px; color: var(--warn, #e0a33a); }
.pvupd b { font-weight: 600; }
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

/* Сервер: строка режима + кнопка перезапуска */
.srvline { margin: 0; font-size: 13.5px; }
.srvline b { font-weight: 640; }
</style>

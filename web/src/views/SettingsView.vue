<script setup>
import { computed, nextTick, ref, onMounted, onUnmounted, watchEffect } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../shared/api-client.js';
import { useProvidersStore } from '../stores/providers.js';
import { useUiContextStore } from '../stores/ui-context.js';
import ProviderIcon from '../shared/ProviderIcon.vue';
import ToggleSwitch from '../shared/ui/ToggleSwitch.vue';
import NumberField from '../shared/ui/NumberField.vue';
import { useAuthStore } from '../stores/auth.js';
import { usePluginsStore } from '../stores/plugins.js';
import { useChatStore } from '../stores/chat.js';
import { usePwaStore } from '../stores/pwa.js';
import { confirmDialog } from '../shared/ui/confirm.js';
import { FACTORY_DEBUG_LEVELS, factoryDebugPayload } from '../shared/factory-debug.js';

// Настройки сгруппированы по табам — новые разделы добавляются записью в TABS.
const TABS = [
  {
    id: 'app', label: 'Приложение', group: 'Основное', short: 'Экран и PWA',
    description: 'Поведение Cockpit на этом устройстве: экран, установка и локальные возможности браузера.',
    icon: 'M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M9 21h6 M12 17v4',
  },
  {
    id: 'b24', label: 'Битрикс24', group: 'Основное', short: 'Портал и сессия',
    description: 'Подключение к порталу и проверка серверной сессии Битрикс24.',
    icon: 'M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z M8 8h8 M8 12h5 M8 16h3',
  },
  {
    id: 'providers', label: 'Исполнители', group: 'Автоматизация', short: 'ИИ и модели',
    description: 'Состояние CLI-исполнителей, доступные модели, обновления и общие каталоги.',
    icon: 'M12 3v3 M8 6h8a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3z M9 12h.01 M15 12h.01 M9.5 16h5',
  },
  {
    id: 'runs', label: 'Запуски', group: 'Автоматизация', short: 'Правила и контекст',
    description: 'Правила подготовки запусков, восстановление конвейеров и диагностика фабрики.',
    icon: 'M8 5v14l11-7z M4 5v14',
  },
  {
    id: 'plugins', label: 'Плагины', group: 'Автоматизация', short: 'Модули Cockpit',
    description: 'Включение системных и пользовательских модулей и их собственные параметры.',
    icon: 'M8 3v4 M16 3v4 M5 7h14v4a7 7 0 0 1-14 0z M12 18v3',
  },
  {
    id: 'server', label: 'Сервер', group: 'Система', short: 'Процесс и рестарт',
    description: 'Состояние процесса Cockpit и безопасное применение серверных обновлений.',
    icon: 'M5 4h14v6H5z M5 14h14v6H5z M8 7h.01 M8 17h.01',
  },
  {
    id: 'access', label: 'Доступ', group: 'Система', short: 'Вход, HTTPS и шлюз',
    description: 'Учётная запись, активные способы подключения и сертификаты для других устройств.',
    icon: 'M7 10V7a5 5 0 0 1 10 0v3 M5 10h14v11H5z M12 14v3',
  },
];
const TAB_GROUPS = ['Основное', 'Автоматизация', 'Система'].map((label) => ({
  label,
  items: TABS.filter((item) => item.group === label),
}));
const savedTab = localStorage.getItem('cockpit-settings-tab');
const tab = ref(TABS.some((item) => item.id === savedTab) ? savedTab : 'app');
const currentTab = computed(() => TABS.find((item) => item.id === tab.value) || TABS[0]);
const settingsNav = ref(null);
function revealTab(id, smooth = true) {
  nextTick(() => {
    const nav = settingsNav.value;
    const button = nav?.querySelector(`[data-settings-tab="${id}"]`);
    if (!nav || !button || nav.scrollWidth <= nav.clientWidth) return;
    nav.scrollTo({
      left: button.offsetLeft - (nav.clientWidth - button.offsetWidth) / 2,
      behavior: smooth ? 'smooth' : 'auto',
    });
  });
}
function setTab(id) {
  tab.value = id;
  localStorage.setItem('cockpit-settings-tab', id);
  revealTab(id);
}

// Репортим открытый таб в UI-контекст — чат с агентом знает, что открыто.
const ui = useUiContextStore();
watchEffect(() => ui.set('settings', { tab: TABS.find((t) => t.id === tab.value)?.label || tab.value }));
onUnmounted(() => ui.clear('settings'));

// ── Приложение (настройки именно этого окна/устройства) ──
const pwa = usePwaStore();
const wakeLockNeedsHttps = typeof window !== 'undefined' && window.isSecureContext === false;
const notificationNeedsHttps = typeof window !== 'undefined' && window.isSecureContext === false;

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

// Свои настройки исполнителя (тумблеры в его плашке): что за ключ — знает сам исполнитель,
// UI только передаёт выбор. Ошибку показываем у той настройки, где кликнули.
const setMsg = ref({});
async function saveProviderSetting(p, s, value) {
  const key = `${p.id}:${s.id}`;
  setMsg.value = { ...setMsg.value, [key]: '' };
  const r = await prov.saveSetting(p.id, s.id, value);
  if (!r.ok) setMsg.value = { ...setMsg.value, [key]: `Не сохранилось: ${r.error}` };
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
const trustedDirectories = ref([]);
const trustedDirectoryInput = ref('');
const trustedDirectoriesBusy = ref(false);
const trustedDirectoriesMsg = ref(null);
async function loadPrefs() {
  try {
    prefs.value = await api.get('/api/settings/prefs');
    trustedDirectories.value = [...(prefs.value.trustedDirectories || [])];
  } catch {
    prefs.value = null;
    trustedDirectories.value = [];
  }
}

function addTrustedDirectory() {
  const value = trustedDirectoryInput.value.trim();
  trustedDirectoriesMsg.value = null;
  if (!value) return true;
  if (!value.startsWith('/')) {
    trustedDirectoriesMsg.value = { type: 'err', text: 'Укажите абсолютный путь, начиная с /.' };
    return false;
  }
  if (!trustedDirectories.value.includes(value)) trustedDirectories.value.push(value);
  trustedDirectoryInput.value = '';
  return true;
}

function removeTrustedDirectory(index) {
  trustedDirectories.value.splice(index, 1);
  trustedDirectoriesMsg.value = null;
}

async function applyTrustedDirectories() {
  if (!addTrustedDirectory()) return;
  trustedDirectoriesBusy.value = true;
  trustedDirectoriesMsg.value = null;
  try {
    const result = await api.post('/api/settings/trusted-directories', {
      directories: trustedDirectories.value,
    });
    trustedDirectories.value = [...result.directories];
    if (prefs.value) prefs.value.trustedDirectories = [...result.directories];
    trustedDirectoriesMsg.value = {
      type: 'ok',
      text: 'Применено. Новые ходы всех ИИ получат доступ к этим каталогам.',
    };
  } catch (e) {
    trustedDirectoriesMsg.value = { type: 'err', text: e.data?.message || e.message };
  } finally {
    trustedDirectoriesBusy.value = false;
  }
}

async function toggleGitRefresh(v) {
  prefsMsg.value = null;
  try {
    prefs.value = await api.post('/api/settings/prefs', { gitRefreshBeforeRun: v });
    prefsMsg.value = { type: 'ok', text: 'Сохранено.' };
  } catch (e) { prefsMsg.value = { type: 'err', text: e.message }; }
}

// Порог автокомпакта чатов. Правится числом, а не тумблером: подходящее значение
// зависит от того, как человек работает, а 0 — осознанное «не вмешиваться».
const compactWindow = ref(0);
watchEffect(() => { compactWindow.value = Number(prefs.value?.chatAutoCompactWindow) || 0; });
async function saveCompactWindow() {
  prefsMsg.value = null;
  const value = Math.max(0, Math.round(Number(compactWindow.value) || 0));
  try {
    prefs.value = await api.post('/api/settings/prefs', { chatAutoCompactWindow: value });
    // Тот же порог красит кольцо контекста в открытых чатах — стор его получает при
    // загрузке истории, поэтому новое значение отдаём ему сразу, а не до следующего F5.
    useChatStore().compactWindow = value;
    prefsMsg.value = {
      type: 'ok',
      text: value
        ? `Чаты будут сжиматься при ${value.toLocaleString('ru')} токенах контекста. Применится к новым ходам.`
        : 'Порог снят: у каждого CLI останется свой (у Claude — почти у самого потолка окна модели).',
    };
  } catch (e) { prefsMsg.value = { type: 'err', text: e.message }; }
}
// Порог молчания хода конвейера. Секунды в поле показываем минутами: человек мыслит
// «полчаса висит», а не «1800».
const silenceWindowMin = ref(0);
watchEffect(() => {
  silenceWindowMin.value = Math.round((Number(prefs.value?.runSilenceWindow) || 0) / 60);
});
async function saveSilenceWindow() {
  prefsMsg.value = null;
  const value = Math.max(0, Math.round(Number(silenceWindowMin.value) || 0)) * 60;
  try {
    prefs.value = await api.post('/api/settings/prefs', { runSilenceWindow: value });
    prefsMsg.value = {
      type: 'ok',
      text: value
        ? `Позовём, если ход конвейера замолчит дольше ${value / 60} мин.`
        : 'Оповещение о зависших ходах выключено.',
    };
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

// ── Режимы доступа ──
// Тумблер — намерение человека: он и открывает настройки режима, и решает, поднимать ли сокет.
// Выключенный режим ничего не стирает (сертификат, корень на устройствах остаются) — обратно
// включается тем же тумблером и перезапуском.
const accessBusy = ref('');

async function setAccessMode(key, on) {
  if (key === 'accessLocalHttps' && !on) {
    const ok = await confirmDialog(
      'Выключить локальный HTTPS? После перезапуска сервера кокпит перестанет слушать порт '
      + `${tls.value?.https?.port || 8143}, и с планшета откроется только по http — PWA ставиться не будет. `
      + 'Сертификат и корень остаются на месте: обратно включается тем же тумблером.',
      { danger: true, okText: 'Выключить' },
    );
    if (!ok) return;
  }
  accessBusy.value = key;
  try {
    prefs.value = await api.post('/api/settings/prefs', { [key]: on });
    if (key === 'accessLocalHttps') {
      tlsMsg.value = {
        type: 'ok',
        text: on
          ? 'Режим включён. Сокет https поднимется при следующем перезапуске сервера.'
          : 'Режим выключен. Сокет https погаснет при следующем перезапуске сервера.',
      };
      await loadTls({ keepMessage: true });
    }
  } catch (e) {
    accMsg.value = { type: 'err', text: e.data?.message || e.message };
  } finally { accessBusy.value = ''; }
}

// ── Локальный HTTPS (свой корневой сертификат) ──
// Без него на планшете нет PWA: `navigator.serviceWorker` существует только в secure context,
// а публичный сертификат на домашний адрес не выпишет никто.
const tls = ref(null);          // ответ /api/settings/tls
const tlsPicked = ref([]);      // адреса, отмеченные галками
const tlsBusy = ref(false);
const tlsMsg = ref(null);

async function loadTls({ keepMessage = false } = {}) {
  if (!keepMessage) tlsMsg.value = null;
  try {
    tls.value = await api.get('/api/settings/tls');
    // По умолчанию отмечаем то, что уже в сертификате, иначе — все адреса машины:
    // дома их один-два, и лишняя галка дешевле, чем «почему не открывается».
    const covered = tls.value.leaf?.addresses || [];
    const all = (tls.value.addresses || []).map((a) => a.address);
    tlsPicked.value = covered.length ? all.filter((a) => covered.includes(a)) : all;
    if (!tlsPicked.value.length) tlsPicked.value = all;
  } catch (e) {
    tls.value = null;
    tlsMsg.value = { type: 'err', text: e.data?.message || e.message };
  }
}

function toggleTlsAddress(addr, on) {
  const set = new Set(tlsPicked.value);
  if (on) set.add(addr); else set.delete(addr);
  tlsPicked.value = [...set];
}

async function generateTls() {
  tlsBusy.value = true; tlsMsg.value = null;
  try {
    const r = await api.post('/api/settings/tls/generate', { addresses: tlsPicked.value });
    tls.value = r.status;
    tlsMsg.value = {
      type: 'ok',
      text: `Сертификат выпущен до ${new Date(r.notAfter).toLocaleDateString('ru-RU')}. `
        + 'Поставь корень на устройства (QR ниже) и перезапусти сервер — HTTPS включается только при старте.',
    };
  } catch (e) {
    tlsMsg.value = { type: 'err', text: e.data?.message || e.message };
  } finally { tlsBusy.value = false; }
}

// Отдельно от тумблера режима: тот просто не поднимает сокет, а это — стереть выпущенное.
// Нужно редко (сменилась сеть, хочется чистого листа), поэтому и кнопка вторичная.
async function dropTlsCertificate() {
  const ok = await confirmDialog(
    'Удалить выпущенный сертификат? Кокпит с планшета снова откроется только по http, и PWA '
    + 'перестанет ставиться. Корень на устройствах останется — после нового выпуска '
    + 'переустанавливать его не нужно.',
    { danger: true, okText: 'Удалить' },
  );
  if (!ok) return;
  tlsBusy.value = true; tlsMsg.value = null;
  try {
    const r = await api.post('/api/settings/tls/disable', { confirm: true });
    tls.value = r.status;
    tlsMsg.value = { type: 'ok', text: 'Сертификат удалён. HTTPS погаснет после перезапуска сервера.' };
  } catch (e) {
    tlsMsg.value = { type: 'err', text: e.data?.message || e.message };
  } finally { tlsBusy.value = false; }
}

// Адрес для QR и подсказок — первый из тех, что в сертификате.
const tlsAddress = () => tls.value?.leaf?.addresses?.[0] || '';
const tlsUrl = () => (tlsAddress() && tls.value?.https?.port
  ? `https://${tlsAddress()}:${tls.value.https.port}` : '');

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
  revealTab(tab.value, false);
  loadCurrent();
  prov.load();
  loadPrefs();
  loadFactoryDebug();
  pluginsStore.load();
  loadServer();
  loadTls();
  acc.value.login = auth.login || '';
});
</script>

<template>
  <div class="settings">
    <header class="settings-hero">
      <div>
        <p class="eyebrow">Центр управления</p>
        <h2>Настройте Cockpit под свой процесс</h2>
        <p>
          Подключения, исполнители и системные параметры собраны в одном месте.
          Изменения применяются только там, где это явно указано.
        </p>
      </div>
      <div class="hero-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 6h10 M18 6h2 M10 12h10 M4 12h2 M4 18h7 M15 18h5 M14 4v4 M6 10v4 M11 16v4" />
        </svg>
      </div>
    </header>

    <div class="settings-layout">
      <aside class="settings-nav-wrap">
        <nav ref="settingsNav" class="settings-nav" aria-label="Разделы настроек">
          <div v-for="group in TAB_GROUPS" :key="group.label" class="nav-group">
            <div class="nav-group-label">{{ group.label }}</div>
            <button
              v-for="item in group.items"
              :key="item.id"
              type="button"
              class="settings-nav-item"
              :data-settings-tab="item.id"
              :class="{ active: tab === item.id }"
              :aria-current="tab === item.id ? 'page' : undefined"
              @click="setTab(item.id)"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path :d="item.icon" />
              </svg>
              <span>
                <strong>{{ item.label }}</strong>
                <small>{{ item.short }}</small>
              </span>
            </button>
          </div>
        </nav>
      </aside>

      <div class="settings-workspace" :class="{ wide: tab === 'providers' || tab === 'plugins' }">
        <header class="section-intro">
          <span class="section-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
              <path :d="currentTab.icon" />
            </svg>
          </span>
          <div>
            <p class="eyebrow">{{ currentTab.group }}</p>
            <h2>{{ currentTab.label }}</h2>
            <p>{{ currentTab.description }}</p>
          </div>
        </header>

    <!-- Приложение: локальные настройки устройства, не уезжают на другие окна -->
    <section v-if="tab === 'app'">
      <div class="card">
        <div class="card-head">
          <div>
            <h3>Экран устройства</h3>
            <p class="muted small">Локальная настройка — не влияет на другие компьютеры и планшеты.</p>
          </div>
          <span class="scope-pill">Это устройство</span>
        </div>
        <div class="mode">
          <ToggleSwitch
            :model-value="pwa.wakeLockEnabled"
            :disabled="pwa.wakeLockBusy || (!pwa.wakeLockSupported && !pwa.wakeLockEnabled)"
            label="Не гасить экран"
            @update:model-value="pwa.setWakeLockEnabled"
          />
          <p class="muted small">
            Удерживает экран включённым на всех страницах кокпита. При сворачивании PWA
            блокировка снимается системой и автоматически возвращается после открытия.
          </p>
        </div>
        <p v-if="pwa.wakeLockActive" class="msg ok">Экран удерживается включённым.</p>
        <p v-else-if="pwa.wakeLockError" class="msg err">{{ pwa.wakeLockError }}</p>
        <p v-else-if="!pwa.wakeLockSupported" class="msg warn">
          {{ wakeLockNeedsHttps
            ? 'Функция доступна только при открытии кокпита через HTTPS.'
            : 'Этот браузер не поддерживает удержание экрана.' }}
        </p>
        <p v-else-if="pwa.wakeLockEnabled" class="muted small">
          Блокировка включится, когда приложение снова станет активным.
        </p>

        <div class="mode notification-mode">
          <div class="notification-line">
            <div>
              <b>Системные оповещения</b>
              <p class="muted small">
                Ответы агентов, вопросы и остановки конвейера, пока приложение запущено.
              </p>
            </div>
            <button
              :disabled="pwa.notificationBusy || !pwa.notificationSupported"
              @click="pwa.testNotification"
            >
              {{ pwa.notificationBusy
                ? 'Проверяю…'
                : (pwa.notificationPermission === 'granted' ? 'Проверить' : 'Включить и проверить') }}
            </button>
          </div>
          <p v-if="pwa.notificationPermission === 'granted'" class="msg ok">
            Оповещения разрешены на этом устройстве.
          </p>
          <p v-else-if="pwa.notificationError" class="msg err">{{ pwa.notificationError }}</p>
          <p v-else-if="!pwa.notificationSupported" class="msg warn">
            {{ notificationNeedsHttps
              ? 'Оповещения доступны только при открытии кокпита через HTTPS.'
              : 'Этот браузер не поддерживает системные оповещения.' }}
          </p>
          <p v-else class="muted small">
            Разрешение спрашивается только по этой кнопке — автоматический запрос PWA браузер блокирует.
          </p>
        </div>
      </div>
    </section>

    <!-- Битрикс24 -->
    <section v-else-if="tab === 'b24'">
      <div class="card">
        <div class="card-head">
          <div>
            <h3>Подключение к порталу</h3>
            <p class="muted small">Учётные данные хранятся только на сервере и не попадают в git.</p>
          </div>
          <span class="status-pill" :class="configured ? 'ok' : 'neutral'">
            <span class="dot"></span>{{ configured ? 'Настроено' : 'Не настроено' }}
          </span>
        </div>
        <div class="form-grid">
          <label class="full">Портал<input v-model="form.baseUrl" placeholder="https://ваш-портал.bitrix24.ru" /></label>
          <label>Логин<input v-model="form.login" autocomplete="username" placeholder="user@example.com" /></label>
          <label>Пароль
            <input v-model="form.password" type="password" autocomplete="current-password"
                   :placeholder="configured ? '•••••• (задан, введите новый для замены)' : 'пароль портала'" />
          </label>
        </div>
        <div class="row">
          <button class="primary" :disabled="saving || !form.login || !form.password" @click="save">{{ saving ? 'Сохранение…' : 'Сохранить' }}</button>
          <button :disabled="testing || !configured" @click="testAuth">{{ testing ? 'Проверка…' : 'Проверить авторизацию' }}</button>
        </div>
        <p v-if="msg" class="msg" :class="msg.type">{{ msg.text }}</p>
      </div>
    </section>

    <!-- Исполнители: реестр LLM-агентов (/api/providers) -->
    <section v-else-if="tab === 'providers'">
      <p class="section-note">
        Реестр агентов-исполнителей. Его же читают топбар (иконки) и в перспективе схемы —
        исполнителем шага сможет быть не только Claude. Авторизация — на хосте
        (<code>claude login</code>), кокпит только показывает статус.
      </p>
      <!-- Плашка на исполнителя, плашки — горизонтальной линией: у каждого ИИ свои
           ручки, и мешать их в один список нельзя. -->
      <div v-if="!prov.loaded" class="card muted">Загрузка…</div>
      <div v-else class="pvcards">
        <div v-for="p in prov.providers" :key="p.id" class="card pvcard">
          <div class="pvhead">
            <span class="pvicon" :style="{ color: p.available ? p.color : 'var(--ink-mid)' }">
              <ProviderIcon :provider="p" :size="20" />
            </span>
            <div class="pvtitle">
              <div class="pvname">{{ p.name }}</div>
              <div class="pvsub muted">{{ p.vendor }} · {{ p.kind }}</div>
            </div>
            <span class="pvstate" :class="p.available ? 'ok' : 'err'">
              <span class="dot"></span>{{ p.available ? 'доступен' : 'недоступен' }}
            </span>
          </div>
          <div class="pvfacts">
            <div class="pvsub muted">{{ p.authLabel }}<template v-if="p.version"> · {{ p.version }}</template></div>
            <div v-if="p.models?.length" class="pvsub muted">
              моделей в каталоге: {{ p.models.length }}<template v-if="hiddenCount(p)"> (в выборе {{ p.models.length - hiddenCount(p) }} — остальные скрыты)</template><template v-if="p.models.some((m) => m.unknown)"> · есть неизвестные CLI (помечены «?»)</template>
            </div>
            <!-- Индикатор новой версии: кокпит только сообщает, обновление — по кнопке -->
            <div v-if="p.updateAvailable" class="pvupd">
              ● Доступно обновление: <b>{{ p.latest }}</b> — нажми «Обновить»
            </div>
            <div v-else-if="p.latest" class="pvsub muted">последняя версия ({{ p.latest }})</div>
          </div>
          <div v-if="!p.available && p.install" class="pvinstall">
            {{ p.installed ? 'Авторизация' : 'Установка' }}:
            <code class="click" title="Кликни — откроется терминал с введённой командой"
                  @click="installInTerminal(p)">{{ p.install }}</code>
          </div>
          <p v-if="updMsg[p.id]" class="msg" :class="updMsg[p.id].type">{{ updMsg[p.id].text }}</p>
          <!-- Свои настройки исполнителя. Список объявляет сам executor (поле settings),
               фронт про вендоров не знает и рисует по kind; выбор сохраняется в prefs. -->
          <div class="pvset">
            <div class="pvsetttl">Настройки исполнителя</div>
            <template v-if="p.settings?.length">
              <div v-for="s in p.settings" :key="s.id" class="pvsetrow">
                <div class="pvsetline">
                  <ToggleSwitch v-if="s.kind === 'toggle'" :model-value="!!s.value"
                                :disabled="s.disabled === true" :label="s.label"
                                @update:model-value="(v) => saveProviderSetting(p, s, v)" />
                  <span v-else class="pvsetlbl">{{ s.label }}</span>
                  <span v-if="s.note" class="pvsoon">{{ s.note }}</span>
                </div>
                <div v-if="s.hint" class="muted small">{{ s.hint }}</div>
                <p v-if="setMsg[`${p.id}:${s.id}`]" class="msg err">{{ setMsg[`${p.id}:${s.id}`] }}</p>
              </div>
            </template>
            <p v-else class="muted small">Своих настроек у этого исполнителя пока нет.</p>
          </div>
          <div class="pvfoot">
            <button v-if="p.installed && p.canUpdate" class="upd" :class="{ hot: p.updateAvailable }" :disabled="!!updating"
                    title="Обновить CLI исполнителя. После обновления каталог моделей перечитается."
                    @click="updateProvider(p)">
              {{ updating === p.id ? 'Обновление…' : 'Обновить' }}
            </button>
          </div>
        </div>
      </div>
      <!-- Общее для всех исполнителей — отдельной карточкой под плашками -->
      <div class="card narrow">
        <div class="prow first">
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
      <div class="card narrow">
        <div>
          <b>Доверенные каталоги</b>
          <p class="muted small trusted-copy">
            Дополнительные деревья, которые Cockpit открывает каждому новому ходу Claude,
            Codex и будущих локальных исполнителей. Текущий каталог проекта доступен и без
            этого списка; корень <code>/</code> добавить нельзя.
          </p>
        </div>
        <div v-if="trustedDirectories.length" class="trusted-list">
          <div v-for="(directory, index) in trustedDirectories" :key="directory" class="trusted-item">
            <code :title="directory">{{ directory }}</code>
            <button type="button" :disabled="trustedDirectoriesBusy" @click="removeTrustedDirectory(index)">
              Убрать
            </button>
          </div>
        </div>
        <p v-else class="muted small">Дополнительных каталогов пока нет.</p>
        <div class="trusted-add">
          <input v-model="trustedDirectoryInput"
                 :disabled="trustedDirectoriesBusy"
                 placeholder="/home/user/Workspace"
                 aria-label="Абсолютный путь к доверенному каталогу"
                 @keyup.enter="addTrustedDirectory" />
          <button type="button"
                  :disabled="trustedDirectoriesBusy || !trustedDirectoryInput.trim()"
                  @click="addTrustedDirectory">
            Добавить
          </button>
        </div>
        <div class="row">
          <button class="primary" type="button" :disabled="trustedDirectoriesBusy" @click="applyTrustedDirectories">
            {{ trustedDirectoriesBusy ? 'Применяю…' : 'Применить ко всем ИИ' }}
          </button>
        </div>
        <p class="muted small">
          Настройка действует внутри Cockpit и не переписывает глобальные конфиги CLI.
          Режим подтверждений выбранного исполнителя продолжает действовать отдельно.
        </p>
        <p v-if="trustedDirectoriesMsg" class="msg" :class="trustedDirectoriesMsg.type">
          {{ trustedDirectoriesMsg.text }}
        </p>
      </div>
    </section>

    <!-- Запуски: обязательные правила перед стартом триажа/конвейера -->
    <section v-else-if="tab === 'runs'">
      <div class="card">
        <div class="card-head">
          <div>
            <h3>Поведение запусков</h3>
            <p class="muted small">Действует перед триажем задачи и стартом конвейера фабрики.</p>
          </div>
        </div>
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
          <div class="compact-setting">
            <label>
              Сжимать контекст чата при
              <NumberField v-model="compactWindow" :min="0" :step="10000" placeholder="0 — не вмешиваться" />
              <span class="unit">токенах</span>
            </label>
            <button class="btn" @click="saveCompactWindow">Сохранить</button>
          </div>
          <p class="muted small">
            CLI умеет сжимать разговор сам, но включает это у самого потолка своего окна:
            на окне 1M — около 950 000 токенов. А дорожает чат гораздо раньше — примерно
            с 250 000: кокпит поднимает процесс агента на каждое сообщение, и выше этого
            порога переписка перестаёт читаться из кэша и пишется в него заново по двойному
            тарифу. <b>0</b> — не вмешиваться. Настройка применяется
            к тем CLI, у которых есть эта ручка (сейчас — Claude); Codex её не предлагает.
            По этому же порогу краснеет кольцо контекста в чате — у моделей с маленьким
            окном оно не ждёт порога, а срабатывает на 80% окна, что бы здесь ни стояло.
          </p>
          <div class="compact-setting">
            <label>
              Звать, если ход конвейера молчит дольше
              <NumberField v-model="silenceWindowMin" :min="0" :step="5" placeholder="0 — не звать" />
              <span class="unit">мин</span>
            </label>
            <button class="btn" @click="saveSilenceWindow">Сохранить</button>
          </div>
          <p class="muted small">
            Зависший вызов инструмента не выглядит аварией: демон жив, этап работает,
            а движок вмешается только когда сгорит весь лимит этапа — это часы.
            Замер по прошлым прогонам: законное молчание доходит до 10 минут (сборка,
            прогон тестов), зависший вызов упирается в 30 — потолок MCP. <b>0</b> — не звать.
            Кокпит только оповещает: остановить ход и решить, что с ним делать, — твоё.
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
      <p class="section-note">
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
      <p class="section-note">
        Боевой режим — демон systemd: юнит ставится один раз командой <code>deploy/install.sh</code>,
        дальше сервер живёт сам (<code>Restart=always</code>, ждёт VPN, переживает перезагрузки) —
        ручные запуски не нужны. Кнопка ниже применяет новый код: свежие плагины и правки
        сервера подхватываются перезапуском.
      </p>
      <div class="card">
        <div class="card-head">
          <div>
            <h3>Процесс Cockpit</h3>
            <p class="muted small">Перезапуск применяет свежий серверный код и состав плагинов.</p>
          </div>
          <span v-if="srv" class="status-pill" :class="srv.systemd ? 'ok' : 'warn'">
            <span class="dot"></span>{{ srv.systemd ? 'Под управлением systemd' : 'Ручной запуск' }}
          </span>
        </div>
        <div v-if="!srv" class="muted">Загрузка…</div>
        <template v-else>
          <p class="srvline">
            Режим: <b>{{ srv.systemd ? 'демон systemd' : 'запущен вручную' }}</b>
            <span class="muted"> · PID {{ srv.pid }} · работает {{ fmtUptime(srv.uptimeSec) }}</span>
          </p>
          <p v-if="!srv.systemd" class="muted small">
            Ручной запуск — режим разработки. Чтобы демон поднимался сам, один раз выполни
            <code>deploy/install.sh</code>. Режимы не смешивать: ручной экземпляр держит порт,
            и юнит будет падать в цикле.
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
      <p class="section-note">
        Вход в кокпит. Пароль хранится хешем на сервере (<code>.state</code>, не в git) и в браузер
        не попадает — клиент получает только сессионную cookie.
      </p>

      <!-- Предупреждение только когда оно по делу: на localhost соединение и так не выходит
           за пределы машины, а за шлюзом браузер идёт по https. -->
      <p v-if="!auth.secure && !auth.isLocal" class="msg err">
        Соединение без HTTPS — пароль передаётся открытым текстом. Включи режим доступа ниже.
      </p>

      <div class="card">
        <div class="card-head">
          <div>
            <h3>Учётная запись</h3>
            <p class="muted small">Один пользователь Cockpit и его активные сессии.</p>
          </div>
          <span class="scope-pill">Сервер</span>
        </div>
        <div class="form-grid">
          <label class="full">Логин<input v-model="acc.login" autocomplete="username" placeholder="необязательно" /></label>
          <label class="full">Текущий пароль
            <input v-model="acc.currentPassword" type="password" autocomplete="current-password" />
          </label>
          <label>Новый пароль
            <input v-model="acc.password" type="password" autocomplete="new-password" placeholder="минимум 8 символов" />
          </label>
          <label>Новый пароль ещё раз
            <input v-model="acc.password2" type="password" autocomplete="new-password" />
          </label>
        </div>
        <p class="muted small">
          Смена пароля разлогинивает все устройства — украденная cookie перестаёт работать.
          Текущее устройство останется в системе.
        </p>
        <div class="row">
          <button class="primary" :disabled="accBusy || !acc.currentPassword || !acc.password" @click="saveAccount">
            {{ accBusy ? 'Сохранение…' : 'Сменить пароль' }}
          </button>
          <button @click="auth.doLogout()">Выйти</button>
          <button class="danger-ghost" @click="logoutAll">Выйти со всех устройств</button>
        </div>
        <p v-if="accMsg" class="msg" :class="accMsg.type">{{ accMsg.text }}</p>
      </div>

      <!-- Режимы доступа. Тумблер не только прячет настройки, но и гасит сам режим:
           при выключенном сокет не поднимается вовсе (решается один раз при старте). -->
      <h3 class="sechead">Как открывать кокпит</h3>
      <p class="muted">
        По умолчанию кокпит отвечает только на самом мозге. Режимы ниже добавляют способы зайти
        снаружи — каждый включается отдельно, и настройки режима видны, только пока он включён.
      </p>
      <div v-if="!prefs" class="card"><span class="muted">Загрузка…</span></div>
      <div v-else class="card">
        <div class="mode">
          <ToggleSwitch
            :model-value="prefs.accessLocalHttps === true" :disabled="accessBusy === 'accessLocalHttps'"
            label="Из домашней сети — локальный HTTPS"
            @update:model-value="setAccessMode('accessLocalHttps', $event)"
          />
          <p class="muted small">
            Планшет и рабочий комп заходят по адресу мозга. Свой корневой сертификат, замок
            без предупреждений, PWA ставится.
          </p>
        </div>
        <div class="mode">
          <ToggleSwitch
            :model-value="prefs.accessGateway === true" :disabled="accessBusy === 'accessGateway'"
            label="Снаружи — через VPS-шлюз"
            @update:model-value="setAccessMode('accessGateway', $event)"
          />
          <p class="muted small">
            Публичный домен и обратные SSH-туннели с мозга. Пока раздел только описывает настройку.
          </p>
        </div>
      </div>

      <!-- Локальный HTTPS: свой корень + сертификат на адрес мозга -->
      <template v-if="prefs?.accessLocalHttps">
      <h3 class="sechead">Локальный HTTPS</h3>
      <p class="muted">
        Дома PWA не ставится без HTTPS: <code>navigator.serviceWorker</code> существует только
        в защищённом контексте, а сертификат на домашний адрес публичный центр не выпишет.
        Кокпит выпускает свой: корень ставится на устройства один раз, дальше всё как в интернете.
        Порт <code>{{ tls?.httpPort || 8140 }}</code> остаётся как был — по нему кокпит ходит
        сам с собой (фабрика, <code>bin/b24</code>, терминал с мозга).
      </p>

      <!-- Ошибку показываем прямо здесь: до перезапуска сервера этих эндпоинтов ещё нет,
           и «Загрузка…» навсегда выглядела бы как зависший запрос. -->
      <div v-if="!tls" class="card">
        <span v-if="!tlsMsg" class="muted">Загрузка…</span>
        <template v-else>
          <p class="msg err">{{ tlsMsg.text }}</p>
          <p class="muted small">
            Если сервер ещё не перезапускался после обновления — перезапусти его на вкладке
            «Сервер»: раздел появится вместе с новыми эндпоинтами.
          </p>
        </template>
      </div>
      <template v-else>
        <p v-if="!tls.openssl" class="msg err">
          На машине нет <code>openssl</code> — выпустить сертификат нечем.
          Поставь его (<code>sudo apt install openssl</code>) и обнови страницу.
        </p>

        <div class="card">
          <p class="tlsline">
            Состояние:
            <b v-if="tls.https.up" class="ok">работает на порту {{ tls.https.port }}</b>
            <b v-else-if="tls.enabled" class="warn">выпущен, но не поднят</b>
            <b v-else class="off">выключен</b>
            <span v-if="tls.source === 'env'" class="muted"> · сертификат задан переменными окружения</span>
          </p>
          <p v-if="tls.https.error" class="msg err">{{ tls.https.error }}</p>
          <p v-if="tls.needsRestart" class="msg warn">
            Изменения вступят в силу после перезапуска сервера — сертификат читается один раз
            при старте. Кнопка на вкладке «Сервер».
          </p>

          <p v-if="tls.leaf.exists" class="muted small">
            Выписан на {{ tls.leaf.addresses.join(', ') }} ·
            действует до {{ new Date(tls.leaf.notAfter).toLocaleDateString('ru-RU') }}
            ({{ tls.leaf.daysLeft }} дн.)
            <template v-if="tls.ca.exists">
              · корень до {{ new Date(tls.ca.notAfter).toLocaleDateString('ru-RU') }}
            </template>
          </p>
          <p v-if="tls.missingAddresses.length" class="msg warn small">
            Адрес машины изменился: {{ tls.missingAddresses.join(', ') }} нет в сертификате.
            Перевыпусти — устройства при этом трогать не нужно, корень остаётся прежним.
          </p>

          <div class="tlsaddrs">
            <span class="muted small">Адреса, по которым будешь открывать кокпит:</span>
            <label v-for="a in tls.addresses" :key="a.address" class="tlsaddr">
              <input
                type="checkbox"
                :checked="tlsPicked.includes(a.address)"
                @change="toggleTlsAddress(a.address, $event.target.checked)"
              />
              <code>{{ a.address }}</code><span class="muted small">{{ a.iface }}</span>
            </label>
            <p v-if="!tls.addresses.length" class="muted small">
              Сетевых адресов не видно — машина не в сети?
            </p>
          </div>

          <div class="row">
            <button class="primary" :disabled="tlsBusy || !tlsPicked.length || !tls.openssl" @click="generateTls">
              {{ tlsBusy ? 'Выпускаю…' : (tls.leaf.exists ? 'Перевыпустить сертификат' : 'Выпустить сертификат') }}
            </button>
            <button v-if="tls.enabled" class="danger-ghost" :disabled="tlsBusy" @click="dropTlsCertificate">Удалить сертификат</button>
          </div>
          <p v-if="tlsMsg" class="msg" :class="tlsMsg.type">{{ tlsMsg.text }}</p>
        </div>

        <!-- Установка корня. QR ведёт на HTTP-адрес намеренно: он работает и до перезапуска,
             и после (http отдаёт корень даже клиентам из сети). Веди он на https — файл
             пришлось бы качать через то самое предупреждение, которое он и убирает. -->
        <div v-if="tls.ca.exists && tlsAddress()" class="card">
          <p class="tlsline"><b>Поставить корень на устройство</b></p>
          <div class="tlsqr">
            <img :src="`/api/settings/tls/ca.svg?address=${tlsAddress()}`" alt="QR со ссылкой на корневой сертификат" width="180" height="180" />
            <ol class="tlssteps small">
              <li>Наведи камеру планшета — откроется скачивание <code>cockpit-ca.crt</code>.</li>
              <li>Android: «Настройки → Безопасность → Шифрование → Установить сертификат →
                Сертификат ЦС». iOS/iPadOS: профиль установится сам, потом
                «Настройки → Основные → Об устройстве → Доверие сертификатам» — включить тумблер.</li>
              <li>Открой <code>{{ tlsUrl() || `https://${tlsAddress()}:8143` }}</code> — замок без предупреждений,
                и «Установить приложение» появится в меню браузера.</li>
            </ol>
          </div>
          <p class="muted small">
            На самом мозге ставить ничего не нужно: <code>http://localhost:{{ tls.httpPort || 8140 }}</code>
            и так защищённый контекст.
            <a :href="'/api/settings/tls/ca.crt'" download>Скачать корень файлом</a> ·
            отпечаток <code class="fp">{{ (tls.ca.fingerprint || '').slice(0, 29) }}…</code>
          </p>
        </div>
      </template>
      </template>

      <!-- Шлюз: пока заглушка. Настройка живёт в скриптах deploy/gateway/ и .env —
           врать тумблером, что отсюда что-то настраивается, нельзя. -->
      <template v-if="prefs?.accessGateway">
      <h3 class="sechead">Доступ снаружи (VPS-шлюз)</h3>
      <p class="muted">
        Кокпит виден по публичному домену, а домашний адрес наружу не выставлен: с мозга на VPS
        идут два исходящих SSH-туннеля (один — кокпит, второй — стенды, чтобы трафик стендов не
        придавливал SSE и терминал). Схема не зависит ни от CGNAT, ни от смены сети.
      </p>
      <div class="card">
        <p class="msg warn">Отсюда шлюз пока не настраивается — раздел показывает, что нужно сделать руками.</p>
        <ol class="tlssteps small">
          <li>На VPS: <code>deploy/gateway/bootstrap.sh</code> (Caddy, сертификаты, forward_auth).</li>
          <li>На мозге: <code>deploy/gateway/brain-setup.sh</code> — юниты обратных туннелей.</li>
          <li>В <code>.env</code>: <code>COCKPIT_PUBLIC_DOMAIN</code> и
            <code>COCKPIT_TRUST_PROXY=127.0.0.1</code> (именно адрес соседа, не <code>true</code>),
            затем перезапуск сервера.</li>
        </ol>
        <p class="muted small">
          Оба скрипта идемпотентные — повторный прогон безопасен. Что появится здесь потом:
          состояние туннелей, домен и диапазоны портов стендов.
        </p>
      </div>
      </template>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings {
  width: min(100%, 1280px);
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 24px;
}
.settings-hero {
  position: relative;
  min-height: 150px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 28px;
  padding: 28px 30px;
  border: 1px solid var(--line);
  border-radius: 18px;
  background:
    radial-gradient(circle at 82% 20%, color-mix(in srgb, var(--accent) 16%, transparent), transparent 28%),
    linear-gradient(135deg, color-mix(in srgb, var(--surface) 94%, var(--accent)) 0%, var(--surface) 72%);
  box-shadow: var(--shadow);
}
.settings-hero::after {
  content: '';
  position: absolute;
  inset: auto -70px -110px auto;
  width: 280px;
  height: 220px;
  border: 1px solid color-mix(in srgb, var(--accent) 18%, transparent);
  border-radius: 50%;
}
.settings-hero > div:first-child { position: relative; z-index: 1; max-width: 680px; }
.settings-hero h2, .section-intro h2 { margin: 0; letter-spacing: -.025em; }
.settings-hero h2 { font-size: clamp(23px, 2vw, 30px); line-height: 1.2; }
.settings-hero p:last-child { max-width: 620px; margin: 10px 0 0; color: var(--ink-mid); }
.eyebrow {
  margin: 0 0 6px;
  color: var(--accent);
  font-size: 11px;
  font-weight: 720;
  letter-spacing: .095em;
  line-height: 1.2;
  text-transform: uppercase;
}
.hero-mark {
  position: relative;
  z-index: 1;
  flex: none;
  display: grid;
  place-items: center;
  width: 72px;
  height: 72px;
  border: 1px solid color-mix(in srgb, var(--accent) 34%, var(--line));
  border-radius: 22px;
  background: color-mix(in srgb, var(--accent) 10%, var(--ground));
  color: var(--accent);
  transform: rotate(3deg);
}
.hero-mark svg { width: 34px; height: 34px; }

.settings-layout {
  display: grid;
  grid-template-columns: 232px minmax(0, 1fr);
  align-items: start;
  gap: 28px;
}
.settings-nav-wrap { min-width: 0; }
.settings-nav {
  position: sticky;
  top: 0;
  display: grid;
  gap: 14px;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: color-mix(in srgb, var(--surface) 86%, transparent);
}
.nav-group { display: grid; gap: 3px; }
.nav-group-label {
  padding: 5px 10px 4px;
  color: var(--ink-mid);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .08em;
  text-transform: uppercase;
}
.settings-nav-item {
  position: relative;
  width: 100%;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 10px;
  border: 1px solid transparent;
  border-radius: 10px;
  background: transparent;
  color: var(--ink-mid);
  cursor: pointer;
  text-align: left;
  transition: border-color .15s, background .15s, color .15s;
}
.settings-nav-item::before {
  content: '';
  position: absolute;
  left: -11px;
  width: 3px;
  height: 22px;
  border-radius: 0 4px 4px 0;
  background: transparent;
}
.settings-nav-item:hover { border-color: var(--line); background: var(--surface-2); color: var(--ink); }
.settings-nav-item.active {
  border-color: color-mix(in srgb, var(--accent) 30%, var(--line));
  background: color-mix(in srgb, var(--accent) 11%, var(--surface-2));
  color: var(--ink);
}
.settings-nav-item.active::before { background: var(--accent); }
.settings-nav-item svg { flex: none; width: 20px; height: 20px; color: currentColor; }
.settings-nav-item.active svg { color: var(--accent); }
.settings-nav-item > span { min-width: 0; display: grid; gap: 1px; }
.settings-nav-item strong { overflow: hidden; font-size: 13.5px; font-weight: 630; text-overflow: ellipsis; }
.settings-nav-item small { overflow: hidden; color: var(--ink-mid); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }

.settings-workspace { min-width: 0; max-width: 860px; }
.settings-workspace.wide { max-width: none; }
.section-intro {
  min-height: 80px;
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding: 2px 0 20px;
  border-bottom: 1px solid var(--line);
}
.section-icon {
  flex: none;
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  border: 1px solid color-mix(in srgb, var(--accent) 32%, var(--line));
  border-radius: 12px;
  background: color-mix(in srgb, var(--accent) 9%, var(--surface));
  color: var(--accent);
}
.section-icon svg { width: 21px; height: 21px; }
.section-intro h2 { font-size: 22px; line-height: 1.2; }
.section-intro p:last-child { max-width: 700px; margin: 5px 0 0; color: var(--ink-mid); font-size: 13.5px; }
section { display: flex; flex-direction: column; gap: 14px; padding-top: 18px; }
.section-note {
  max-width: 760px;
  margin: 0;
  padding: 11px 13px;
  border-left: 2px solid color-mix(in srgb, var(--accent) 58%, var(--line));
  border-radius: 0 9px 9px 0;
  background: color-mix(in srgb, var(--accent) 6%, transparent);
  color: var(--ink-mid);
  font-size: 12.5px;
}
.section-note code { background: var(--surface-2); border-radius: 4px; padding: 1px 5px; font-size: 12px; }

.muted code { background: var(--surface-2); border-radius: 4px; padding: 1px 5px; font-size: 12px; }
.card {
  min-width: 0;
  background: linear-gradient(180deg, color-mix(in srgb, var(--surface) 96%, #fff) 0%, var(--surface) 100%);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 13px;
  box-shadow: inset 0 1px 0 #ffffff08;
}
.card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.card-head h3 { margin: 0; font-size: 14px; font-weight: 660; letter-spacing: -.01em; }
.card-head p { margin: 4px 0 0; }
.scope-pill, .status-pill {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 25px;
  padding: 3px 9px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--ground);
  color: var(--ink-mid);
  font-size: 10.5px;
  white-space: nowrap;
}
.status-pill .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ink-mid); }
.status-pill.ok { border-color: color-mix(in srgb, var(--good) 34%, var(--line)); color: var(--good); }
.status-pill.ok .dot { background: var(--good); box-shadow: 0 0 6px color-mix(in srgb, var(--good) 55%, transparent); }
.status-pill.warn { border-color: color-mix(in srgb, var(--warn) 38%, var(--line)); color: var(--warn); }
.status-pill.warn .dot { background: var(--warn); }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.form-grid .full { grid-column: 1 / -1; }
/* Карточки плагинов — горизонтальной линией, с переносом на узких экранах. */
.plugcards { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 340px), 1fr)); gap: 14px; align-items: start; }
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
.plugrow input[type="checkbox"] { width: 16px; height: 16px; accent-color: var(--accent); }
/* Нормальный селект вместо нативного: свой фон, рамка и шеврон. */
.plugrow select.inp {
  appearance: none; -webkit-appearance: none;
  background: var(--bg) url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23888da8' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") no-repeat right 10px center;
  border: 1px solid var(--line); border-radius: 8px; color: var(--ink);
  padding: 6px 28px 6px 10px; font: inherit; font-size: 13px; cursor: pointer;
}
.plugrow select.inp:hover { border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); }
.plugrow select.inp:focus { outline: none; border-color: var(--accent); }
label { min-width: 0; display: flex; flex-direction: column; gap: 5px; font-size: 13px; color: var(--ink-mid); }
input { width: 100%; min-width: 0; padding: 10px 11px; border: 1px solid var(--line); border-radius: 9px; background: var(--ground); color: var(--ink); font-size: 14px; }
input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
.row { display: flex; gap: 8px; flex-wrap: wrap; }
.debug-copy { margin: 5px 0 0; }
.trusted-copy { margin: 5px 0 0; }
.trusted-list { display: grid; gap: 7px; }
.trusted-item { display: flex; align-items: stretch; gap: 8px; min-width: 0; }
.trusted-item code { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; background: var(--ground); border: 1px solid var(--line);
  border-radius: 7px; padding: 0 9px; height: 36px; box-sizing: border-box;
  display: flex; align-items: center; font-size: 12px; }
.trusted-item button { flex: none; height: 36px; box-sizing: border-box; padding: 0 10px; font-size: 12px; }
.trusted-add { display: flex; align-items: stretch; gap: 8px; }
.trusted-add input { flex: 1; min-width: 0; height: 38px; box-sizing: border-box; }
.trusted-add button { height: 38px; box-sizing: border-box; }
.debug-setting { display: flex; align-items: end; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.debug-setting label { min-width: 230px; }
/* Порог автокомпакта: подпись, поле и единица в одну строку — значение читается как
   фраза («сжимать при N токенах»), а не как безымянное число в форме. */
.compact-setting { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 12px; }
.compact-setting label { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.compact-setting label :deep(.nf) { width: 130px; }
.compact-setting .unit { color: var(--ink-mid); }
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
/* Первый блок своей карточки — отбивать сверху не от чего */
.prow.first { border-top: none; margin-top: 0; padding-top: 0; }
button { padding: 9px 14px; border-radius: 9px; border: 1px solid var(--line); background: var(--surface-2); color: var(--ink); font-size: 14px; cursor: pointer; }
button:disabled { opacity: .5; cursor: default; }
button.primary { background: var(--accent); color: #07101d; border-color: var(--accent); font-weight: 650; }
button.danger-ghost { border-color: color-mix(in srgb, var(--bad) 42%, var(--line)); color: color-mix(in srgb, var(--bad) 82%, #fff); }
button.danger-ghost:hover:not(:disabled) { background: color-mix(in srgb, var(--bad) 10%, var(--surface-2)); border-color: var(--bad); }
.msg { font-size: 13px; margin: 0; }
.small { font-size: 12px; line-height: 1.5; }
.msg.ok { color: var(--good); }
.msg.err { color: var(--bad); }

/* Плашка исполнителя: у каждого ИИ своя карточка, карточки — горизонтальным рядом */
.pvcards { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 350px), 1fr)); gap: 14px; align-items: start; }
.pvcard { gap: 10px; }
.pvhead { display: flex; align-items: center; gap: 10px; }
.pvtitle { flex: 1; min-width: 0; }
.pvfacts { display: grid; gap: 2px; }
.pvicon { flex: none; display: grid; place-items: center; width: 34px; height: 34px;
  border: 1px solid var(--line); border-radius: 9px; background: var(--ground); }
.pvname { font-size: 14px; font-weight: 600; }
.pvsub { font-size: 12.5px; }
/* Свои настройки исполнителя — отбиты от фактов о CLI, как у карточек плагинов */
.pvset { display: flex; flex-direction: column; gap: 8px; border-top: 1px dashed var(--line); padding-top: 10px; }
.pvsetttl { font-size: 12px; color: var(--ink-mid); text-transform: uppercase; letter-spacing: .04em; }
.pvsetrow { display: grid; gap: 3px; }
.pvsetline { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pvsetlbl { font-size: 13px; }
/* Ручка объявлена исполнителем, но ещё не подключена к ходу */
.pvsoon { font-size: 11px; border: 1px solid var(--line); border-radius: 999px;
  padding: 1px 8px; color: var(--mut, var(--ink-mid)); }
.pvfoot { display: flex; justify-content: flex-end; }
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

/* Локальный HTTPS */
.sechead { margin: 12px 0 0; font-size: 14px; font-weight: 640; }

/* Режим доступа: тумблер + пояснение под ним, выровненное по подписи тумблера. */
.mode { display: grid; gap: 2px; }
.mode > p { margin: 0 0 0 39px; }
.mode + .mode { border-top: 1px solid var(--line); padding-top: 12px; }
.notification-mode > p { margin-left: 0; }
.notification-line { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.notification-line > div { display: grid; gap: 2px; }
.notification-line p { margin: 0; }
.notification-line button { flex: none; }
.tlsline { margin: 0; font-size: 13.5px; }
.tlsline b { font-weight: 640; }
.tlsline b.ok { color: var(--good); }
.tlsline b.warn { color: var(--warn, #e0a33a); }
.tlsline b.off { color: var(--ink-mid); }
.msg.warn { color: var(--warn, #e0a33a); }
.tlsaddrs { display: grid; gap: 6px; }
.tlsaddr { flex-direction: row; align-items: center; gap: 8px; }
.tlsaddr input { flex: none; width: 15px; height: 15px; accent-color: var(--accent); padding: 0; }
.tlsaddr code { background: var(--ground); border: 1px solid var(--line); border-radius: 6px;
  padding: 2px 7px; font-size: 12.5px; }
.tlsqr { display: flex; gap: 14px; align-items: flex-start; flex-wrap: wrap; }
/* QR всегда на белом: тёмный фон карточки камера читает через раз */
.tlsqr img { flex: none; background: #fff; border-radius: 8px; padding: 6px; }
.tlssteps { flex: 1; min-width: 240px; margin: 0; padding-left: 18px; display: grid; gap: 6px;
  color: var(--ink-mid); }
.tlssteps code { background: var(--surface-2); border-radius: 4px; padding: 1px 5px; font-size: 12px; }
.fp { font-size: 11px; }

/* Планшет: вертикальная рейка превращается в липкую горизонтальную навигацию. */
@media (max-width: 1099px) {
  .settings { gap: 18px; }
  .settings-layout { display: block; }
  .settings-nav-wrap {
    position: sticky;
    top: -1px;
    z-index: 20;
    margin: 0 -1px;
    padding: 8px 1px;
    background: linear-gradient(var(--ground) 78%, transparent);
  }
  .settings-nav {
    position: static;
    display: flex;
    gap: 6px;
    overflow-x: auto;
    padding: 7px;
    scroll-snap-type: x proximity;
    scrollbar-width: none;
  }
  .settings-nav::-webkit-scrollbar { display: none; }
  .nav-group { display: contents; }
  .nav-group-label { display: none; }
  .settings-nav-item {
    flex: 0 0 auto;
    width: auto;
    min-width: 132px;
    padding: 9px 11px;
    scroll-snap-align: start;
  }
  .settings-nav-item::before { display: none; }
  .settings-workspace, .settings-workspace.wide { max-width: 920px; margin: 16px auto 0; }
}

/* Мобильный: одна колонка без горизонтального переполнения и с крупными действиями. */
@media (max-width: 639px) {
  .settings { gap: 12px; }
  .settings-hero { min-height: 0; padding: 19px; border-radius: 14px; }
  .settings-hero h2 { font-size: 21px; }
  .settings-hero p:last-child { display: none; }
  .hero-mark { width: 48px; height: 48px; border-radius: 14px; }
  .hero-mark svg { width: 24px; height: 24px; }
  .settings-nav-wrap { margin: 0 -16px; padding: 7px 16px; }
  .settings-nav { margin: 0 -7px; }
  .settings-nav-item { min-width: auto; padding: 9px 11px; }
  .settings-nav-item small { display: none; }
  .section-intro { min-height: 0; gap: 11px; padding: 4px 0 16px; }
  .section-icon { width: 38px; height: 38px; border-radius: 10px; }
  .section-intro h2 { font-size: 19px; }
  .section-intro p:last-child { font-size: 12.5px; }
  section { gap: 12px; padding-top: 14px; }
  .card { padding: 15px; border-radius: 12px; }
  .card-head { flex-wrap: wrap; gap: 10px; }
  .form-grid { grid-template-columns: minmax(0, 1fr); }
  .form-grid .full { grid-column: auto; }
  .pvcards, .plugcards { grid-template-columns: minmax(0, 1fr); }
  .pvhead { align-items: flex-start; flex-wrap: wrap; }
  .pvstate { margin-left: 44px; }
  .plughead { align-items: flex-start; }
  .plugrow { align-items: stretch; flex-direction: column; gap: 5px; }
  .plugrow label, .plugrow .inp { min-width: 0; max-width: none; }
  .row { display: grid; grid-template-columns: minmax(0, 1fr); }
  .row > button { width: 100%; }
  .compact-setting { align-items: stretch; flex-direction: column; }
  .compact-setting label { align-items: stretch; flex-direction: column; }
  .compact-setting label :deep(.nf) { width: 100%; }
  .trusted-add { flex-direction: column; }
  .trusted-add button { width: 100%; }
  .debug-setting { align-items: stretch; flex-direction: column; }
  .debug-setting label { min-width: 0; }
  .mode > p { margin-left: 0; padding-left: 39px; }
  .notification-line { align-items: stretch; flex-direction: column; }
  .notification-line button { width: 100%; }
  .tlsaddr { flex-wrap: wrap; }
  .tlsqr { display: grid; justify-items: center; }
  .tlsqr img { width: min(180px, 100%); height: auto; }
  .tlssteps { min-width: 0; width: 100%; }
  .fp { overflow-wrap: anywhere; }
}
</style>

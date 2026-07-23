<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../shared/api-client.js';

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

// ── Авторизация Claude (для чата с агентами) ──
const claude = ref({ mode: 'none', configured: false, keyHint: null, hostLoggedIn: false });
const claudeKey = ref('');
const claudeSaving = ref(false);
const claudeTesting = ref(false);
const claudeMsg = ref(null);

const claudeStatus = computed(() => {
  const m = claude.value.mode;
  if (m === 'apikey') return { text: `Свой API-ключ кокпита (${claude.value.keyHint})`, cls: 'ok' };
  if (m === 'cli') return { text: 'Авторизация хостового CLI (claude login)', cls: 'ok' };
  if (m === 'env') return { text: 'Переменная окружения ANTHROPIC_API_KEY', cls: 'ok' };
  return { text: 'Не авторизован — залогиньтесь в терминале (claude login) или задайте ключ ниже', cls: 'err' };
});

async function loadClaude() {
  try { claude.value = await api.get('/api/settings/claude'); } catch { /* игнор */ }
}
async function saveClaude() {
  claudeSaving.value = true; claudeMsg.value = null;
  try {
    claude.value = await api.post('/api/settings/claude', { apiKey: claudeKey.value });
    claudeKey.value = '';
    claudeMsg.value = { type: 'ok', text: claude.value.configured ? 'Ключ сохранён.' : 'Ключ очищен — используется авторизация хоста.' };
  } catch (e) { claudeMsg.value = { type: 'err', text: e.message }; } finally { claudeSaving.value = false; }
}
async function testClaude() {
  claudeTesting.value = true; claudeMsg.value = null;
  try {
    const r = await api.post('/api/settings/claude/test');
    claudeMsg.value = r.ok
      ? { type: 'ok', text: `Успешно — ответ «${r.reply}»${r.cost ? ` ($${r.cost.toFixed(4)})` : ''}.` }
      : { type: 'err', text: `Не удалось: ${r.error}` };
  } catch (e) { claudeMsg.value = { type: 'err', text: e.message }; } finally { claudeTesting.value = false; }
}

onMounted(() => { loadCurrent(); loadClaude(); });
</script>

<template>
  <div class="settings">
    <!-- Битрикс24 -->
    <section>
      <h2>Битрикс24</h2>
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

    <!-- Авторизация Claude -->
    <section>
      <h2>Авторизация Claude</h2>
      <p class="muted">
        Чат с агентами гоняет CLI <code>claude</code>. По умолчанию используется авторизация хостового CLI
        (<code>claude login</code> или <code>ANTHROPIC_API_KEY</code>). Можно задать отдельный API-ключ для кокпита —
        он хранится на сервере (не в git) и передаётся агенту.
      </p>
      <div class="card">
        <div class="status">
          <span class="dot" :class="claudeStatus.cls"></span>
          <span :class="claudeStatus.cls === 'err' ? 'muted' : ''">{{ claudeStatus.text }}</span>
        </div>
        <label>Свой API-ключ (sk-ant-…)
          <input v-model="claudeKey" type="password" autocomplete="off"
                 :placeholder="claude.configured ? '•••••• (задан, введите новый для замены)' : 'оставьте пустым — авторизация хоста'" />
        </label>
        <div class="row">
          <button class="primary" :disabled="claudeSaving" @click="saveClaude">{{ claudeSaving ? 'Сохранение…' : (claudeKey ? 'Сохранить ключ' : 'Очистить ключ') }}</button>
          <button :disabled="claudeTesting || !claude.hostLoggedIn && !claude.configured" @click="testClaude">{{ claudeTesting ? 'Проверка…' : 'Проверить (haiku-пинг)' }}</button>
        </div>
        <p v-if="claudeMsg" class="msg" :class="claudeMsg.type">{{ claudeMsg.text }}</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.settings { max-width: 56ch; display: flex; flex-direction: column; gap: 22px; }
section { display: flex; flex-direction: column; gap: 8px; }
h2 { margin: 0; font-size: 18px; }
.muted code { background: var(--surface-2); border-radius: 4px; padding: 1px 5px; font-size: 12px; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px; display: flex; flex-direction: column; gap: 12px; margin-top: 4px; }
.status { display: flex; align-items: center; gap: 9px; font-size: 13.5px; }
.status .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.status .dot.ok { background: var(--good); box-shadow: 0 0 6px color-mix(in srgb, var(--good) 60%, transparent); }
.status .dot.err { background: var(--bad); }
label { display: flex; flex-direction: column; gap: 5px; font-size: 13px; color: var(--ink-mid); }
input { padding: 9px 11px; border: 1px solid var(--line); border-radius: 9px; background: var(--ground); color: var(--ink); font-size: 14px; }
input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
.row { display: flex; gap: 8px; flex-wrap: wrap; }
button { padding: 9px 14px; border-radius: 9px; border: 1px solid var(--line); background: var(--surface-2); color: var(--ink); font-size: 14px; cursor: pointer; }
button:disabled { opacity: .5; cursor: default; }
button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
.msg { font-size: 13px; margin: 0; }
.msg.ok { color: var(--good); }
.msg.err { color: var(--bad); }
</style>

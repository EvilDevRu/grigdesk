<script setup>
import { ref, onMounted } from 'vue';
import { api } from '../shared/api-client.js';

const form = ref({ baseUrl: '', login: '', password: '' });
const configured = ref(false);
const saving = ref(false);
const testing = ref(false);
const msg = ref(null); // { type: 'ok'|'err', text }

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
  } catch (e) {
    msg.value = { type: 'err', text: e.message };
  } finally { saving.value = false; }
}

async function testAuth() {
  testing.value = true; msg.value = null;
  try {
    const r = await api.post('/api/settings/b24/test');
    msg.value = r.ok
      ? { type: 'ok', text: `Авторизация успешна (userId ${r.userId}).` }
      : { type: 'err', text: `Не удалось: ${r.error}` };
  } catch (e) {
    msg.value = { type: 'err', text: e.message };
  } finally { testing.value = false; }
}

onMounted(loadCurrent);
</script>

<template>
  <div class="settings">
    <h2>Настройки · Битрикс24</h2>
    <p class="muted">Кокпит — единственный владелец сессии портала. Креды хранятся на сервере (не в git).</p>

    <div class="card">
      <label>Портал
        <input v-model="form.baseUrl" placeholder="https://ваш-портал.bitrix24.ru" />
      </label>
      <label>Логин
        <input v-model="form.login" autocomplete="username" placeholder="user@example.com" />
      </label>
      <label>Пароль
        <input v-model="form.password" type="password" autocomplete="current-password"
               :placeholder="configured ? '•••••• (задан, введите новый для замены)' : 'пароль портала'" />
      </label>

      <div class="row">
        <button class="primary" :disabled="saving || !form.login || !form.password" @click="save">
          {{ saving ? 'Сохранение…' : 'Сохранить' }}
        </button>
        <button :disabled="testing || !configured" @click="testAuth">
          {{ testing ? 'Проверка…' : 'Проверить авторизацию' }}
        </button>
      </div>

      <p v-if="msg" class="msg" :class="msg.type">{{ msg.text }}</p>
    </div>
  </div>
</template>

<style scoped>
.settings { max-width: 52ch; display: flex; flex-direction: column; gap: 10px; }
h2 { margin: 0; font-size: 20px; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px; display: flex; flex-direction: column; gap: 12px; margin-top: 6px; }
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

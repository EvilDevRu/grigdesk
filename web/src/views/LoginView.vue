<script setup>
// Экран входа. Он же — первичная настройка пароля, пока учётка не создана.
//
// Показывается САМИМ приложением по состоянию `/api/auth/state`, а не серверным редиректом:
// фронт — PWA, и редирект на навигации конфликтует с service worker'ом (тот отдаёт
// закешированную оболочку вместо страницы логина). Оболочка публична и секретов не содержит,
// закрыт весь `/api` — поэтому такой порядок безопасен.
import { ref, computed, onMounted, nextTick } from 'vue';
import { useAuthStore } from '../stores/auth.js';

const auth = useAuthStore();
const login = ref('');
const password = ref('');
const password2 = ref('');
const localErr = ref(null);
const reveal = ref(false);
const pwField = ref(null);

const isSetup = computed(() => !auth.configured);
const canSubmit = computed(() => {
  if (auth.busy || !password.value) return false;
  if (isSetup.value) return password.value.length >= 8 && password.value === password2.value;
  return true;
});

// Возвращаем курсор в поле: иначе после клика по «глазу» надо тапать по полю заново.
async function toggleReveal() {
  reveal.value = !reveal.value;
  await nextTick();
  pwField.value?.focus();
}

async function submit() {
  localErr.value = null;
  if (isSetup.value) {
    if (password.value.length < 8) { localErr.value = 'Пароль короче 8 символов'; return; }
    if (password.value !== password2.value) { localErr.value = 'Пароли не совпадают'; return; }
    await auth.doSetup({ login: login.value, password: password.value });
  } else {
    await auth.doLogin({ login: login.value, password: password.value });
  }
  password.value = '';
  password2.value = '';
}

onMounted(async () => {
  login.value = auth.login || '';
  // Фокус сразу в пароль: логин обычно уже подставлен и меняется редко.
  await nextTick();
  pwField.value?.focus();
});
</script>

<template>
  <div class="wrap">
    <form class="card" @submit.prevent="submit">
      <div class="brand">
        <span class="mark"></span>
        <span class="name">Кокпит</span>
      </div>

      <!-- Единственная подсказка, которая реально нужна: объясняет второе поле пароля. -->
      <p v-if="isSetup" class="hint">Первый запуск — задайте пароль</p>

      <div class="field">
        <label for="lg">Логин</label>
        <input id="lg" v-model="login" autocomplete="username" spellcheck="false" />
      </div>

      <div class="field">
        <label for="pw">Пароль</label>
        <div class="pw">
          <input id="pw" ref="pwField" v-model="password" :type="reveal ? 'text' : 'password'"
                 :autocomplete="isSetup ? 'new-password' : 'current-password'" />
          <button type="button" class="eye" tabindex="-1" :title="reveal ? 'Скрыть' : 'Показать'"
                  @click="toggleReveal">
            <svg viewBox="0 0 20 20" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.6">
              <path v-if="!reveal" d="M1.7 10S4.9 4.6 10 4.6 18.3 10 18.3 10 15.1 15.4 10 15.4 1.7 10 1.7 10Z" />
              <circle v-if="!reveal" cx="10" cy="10" r="2.5" />
              <path v-else d="M3 3l14 14M8.2 5.1C8.8 4.8 9.4 4.6 10 4.6c5.1 0 8.3 5.4 8.3 5.4s-1 1.7-2.7 3.1M5.4 6.6C3.1 8.2 1.7 10 1.7 10S4.9 15.4 10 15.4c.9 0 1.7-.2 2.4-.5" />
            </svg>
          </button>
        </div>
      </div>

      <div v-if="isSetup" class="field">
        <label for="pw2">Пароль ещё раз</label>
        <input id="pw2" v-model="password2" :type="reveal ? 'text' : 'password'" autocomplete="new-password" />
      </div>

      <button class="submit" type="submit" :disabled="!canSubmit">
        <span v-if="auth.busy" class="spin"></span>
        {{ auth.busy ? 'Проверяю' : isSetup ? 'Задать пароль' : 'Войти' }}
      </button>

      <p v-if="localErr || auth.error" class="err">{{ localErr || auth.error }}</p>
    </form>
  </div>
</template>

<style scoped>
.wrap {
  min-height: 100vh; display: grid; place-items: center; padding: 24px;
  /* Мягкое свечение акцентом сверху — чтобы карточка не висела в пустоте. */
  background:
    radial-gradient(60% 42% at 50% 0%, rgba(90, 162, 255, .13), transparent 70%),
    var(--ground);
}

.card {
  width: 100%; max-width: 372px;
  display: flex; flex-direction: column; gap: 14px;
  padding: 30px 28px 26px;
  border: 1px solid var(--line); border-radius: 18px;
  background: linear-gradient(180deg, #ffffff08, #ffffff00 40%), var(--surface);
  box-shadow: 0 24px 70px #00000073, inset 0 1px 0 #ffffff0d;
}

.brand { display: flex; align-items: center; gap: 10px; }
.mark {
  width: 22px; height: 22px; flex: none; border-radius: 6px;
  border: 2.6px solid var(--accent);
  box-shadow: 0 0 16px #5aa2ff4d;
}
.name { font-size: 17px; font-weight: 600; letter-spacing: .01em; }

.hint { margin: -4px 0 2px; font-size: 12.5px; color: var(--ink-mid); }

.field { display: flex; flex-direction: column; gap: 6px; }
label { font-size: 11.5px; font-weight: 500; letter-spacing: .04em; text-transform: uppercase; color: var(--ink-mid); }

input {
  width: 100%; box-sizing: border-box;
  /* 44px по высоте — палец на планшете, а кокпит открывают именно с него. */
  padding: 12px 13px; font-size: 15px;
  color: var(--ink); background: var(--ground);
  border: 1px solid var(--line); border-radius: 11px;
  transition: border-color .14s, box-shadow .14s;
}
input:focus {
  outline: none; border-color: var(--accent);
  box-shadow: 0 0 0 3px #5aa2ff2b;
}

/* Пароль с кнопкой «показать» — на планшете попасть по нужным символам иначе тяжело. */
.pw { position: relative; display: flex; }
.pw input { padding-right: 44px; }
.eye {
  position: absolute; right: 4px; top: 50%; transform: translateY(-50%);
  display: grid; place-items: center; width: 36px; height: 36px;
  background: none; border: none; border-radius: 9px; cursor: pointer;
  color: var(--ink-mid);
}
.eye:hover { color: var(--ink); background: var(--surface-2); }

.submit {
  margin-top: 6px; display: flex; align-items: center; justify-content: center; gap: 8px;
  padding: 13px 16px; font-size: 15px; font-weight: 600;
  color: #fff; background: var(--accent);
  border: none; border-radius: 11px; cursor: pointer;
  transition: filter .14s, opacity .14s;
}
.submit:hover:not(:disabled) { filter: brightness(1.09); }
.submit:disabled { opacity: .45; cursor: default; }

.spin {
  width: 13px; height: 13px; border-radius: 50%;
  border: 2px solid #ffffff59; border-top-color: #fff;
  animation: sp .7s linear infinite;
}
@keyframes sp { to { transform: rotate(360deg); } }

.err { margin: 0; font-size: 13px; color: var(--bad); }
</style>

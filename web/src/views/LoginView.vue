<template>
  <div class="wrap">
    <form class="card" @submit.prevent="submit">
      <div class="brand">
        <span class="mark"></span>
        <span class="name">Кокпит</span>
      </div>

      <!-- Единственная подсказка, которая реально нужна: объясняет второе поле пароля. -->
      <p v-if="isSetup" class="hint">Первый запуск — задайте пароль</p>

      <UiField label="Логин" id="lg">
        <UiInput id="lg" v-model="login" autocomplete="username" spellcheck="false" />
      </UiField>

      <UiField label="Пароль" id="pw">
        <UiPasswordInput
          id="pw"
          ref="pwField"
          v-model="password"
          :autocomplete="isSetup ? 'new-password' : 'current-password'"
        />
      </UiField>

      <UiField v-if="isSetup" label="Пароль ещё раз" id="pw2">
        <UiPasswordInput id="pw2" v-model="password2" autocomplete="new-password" />
      </UiField>

      <UiButton
        class="submit-layout"
        type="submit"
        variant="solid"
        tone="accent"
        :loading="auth.busy"
        loading-label="Проверяю"
        :disabled="!canSubmit"
        block
      >{{ isSetup ? 'Задать пароль' : 'Войти' }}</UiButton>

      <p v-if="localErr || auth.error" class="err">{{ localErr || auth.error }}</p>
    </form>
  </div>
</template>

<script setup>
// Экран входа. Он же — первичная настройка пароля, пока учётка не создана.
//
// Показывается САМИМ приложением по состоянию `/api/auth/state`, а не серверным редиректом:
// фронт — PWA, и редирект на навигации конфликтует с service worker'ом (тот отдаёт
// закешированную оболочку вместо страницы логина). Оболочка публична и секретов не содержит,
// закрыт весь `/api` — поэтому такой порядок безопасен.
import { ref, computed, onMounted, nextTick } from 'vue';
import { useAuthStore } from '../stores/auth.js';
import { UiButton, UiField, UiInput, UiPasswordInput } from '../ui';

const auth = useAuthStore();
const login = ref('');
const password = ref('');
const password2 = ref('');
const localErr = ref(null);
const pwField = ref(null);

const isSetup = computed(() => !auth.configured);
const canSubmit = computed(() => {
  if (auth.busy || !password.value) return false;
  if (isSetup.value) return password.value.length >= 8 && password.value === password2.value;
  return true;
});

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

.submit-layout { margin-top: 6px; }

.err { margin: 0; font-size: 13px; color: var(--bad); }
</style>

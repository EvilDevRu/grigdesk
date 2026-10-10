<template>
  <UiAuthLayout>
    <div class="auth-head">
      <span class="auth-icon" :data-tone="link.state?.revoked ? 'bad' : 'accent'">
        <UiIcon :name="link.state?.revoked ? 'unlink' : 'lock'" />
      </span>
      <h1>{{ link.state?.revoked ? 'Телефон отозван в кокпите' : 'Приложение заблокировано' }}</h1>
      <p class="mobile-muted">{{ link.state?.brainName }}</p>
    </div>
    <p v-if="!link.state?.revoked">Подтвердите вход отпечатком пальца или кодом телефона.</p>
    <p v-else>Чтобы снова пользоваться приложением, привяжите телефон по новому QR-коду.</p>
    <UiButton
      v-if="!link.state?.revoked"
      kind="primary"
      variant="solid"
      :busy="link.busy"
      @click="link.unlock"
    >
      Разблокировать
    </UiButton>
    <UiButton kind="danger" variant="ghost" :busy="link.busy" @click="reset = true">
      Отвязать
    </UiButton>
    <UiError v-if="link.error" :text="link.error" />
    <UiDialog
      v-if="reset"
      title="Отвязать телефон?"
      confirm="Отвязать"
      danger
      :busy="link.busy"
      @close="reset = false"
      @confirm="
        link.reset();
        reset = false;
      "
    >
      <p>Для следующего входа понадобится новый QR-код из кокпита.</p>
    </UiDialog>
  </UiAuthLayout>
</template>

<script setup lang="ts">
import { ref } from 'vue';

import { UiAuthLayout, UiButton, UiDialog, UiError, UiIcon } from '../ui.ts';
import { useLinkStore } from '../stores/link.ts';

const link = useLinkStore();
const reset = ref(false);
</script>

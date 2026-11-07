<template>
  <div class="pair-form">
    <ol class="pair-steps">
      <li>Откройте в GrigDesk «Настройки → Доступ».</li>
      <li v-if="!isDesktop">Нажмите «Сканировать QR» и наведите камеру на код.</li>
    </ol>
    <UiButton v-if="!isDesktop" kind="primary" variant="solid" :busy="link.busy" @click="scan">
      <UiIcon name="camera" />
      <span>Сканировать QR</span>
    </UiButton>
    <p class="pair-or"><span>или вставьте код текстом</span></p>
    <UiField
      v-model="text"
      label="Вставить код"
      multiline
      :rows="3"
      :max-length="4096"
      placeholder="grigdesklink:1:…"
      :disabled="link.busy"
    />
    <UiButton :busy="link.busy" :disabled="!text.trim()" @click="add">Добавить</UiButton>
    <UiError
      v-if="link.error || error || link.state?.error"
      :text="link.error || error || link.state?.error || ''"
    />
  </div>
</template>

<script setup lang="ts">
import { onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { UiButton, UiError, UiField, UiIcon } from '../ui.ts';
import { useLinkStore } from '../stores/link.ts';
import { isDesktop } from '../platform.ts';

const link = useLinkStore();
const router = useRouter();
const text = ref('');
const error = ref('');

/**
 * QR проходит тот же разбор, что вставленный текст; код не остаётся в экранном состоянии.
 * Переход разрешён после записи привязки, а отказ native остаётся видимым.
 */
async function add() {
  const wasPaired = Boolean(link.state?.paired);
  const source = router.currentRoute.value.fullPath;

  await link.add(text.value.trim());
  text.value = '';

  // Первая привязка уже открывает оболочку через App. Запоздалый переход формы
  // не должен забирать человека из раздела, выбранного после появления навигации.
  if (!link.error && link.state?.paired && wasPaired && router.currentRoute.value.fullPath === source) {
    await router.replace('/relays');
  }
}

/**
 * Камера принадлежит native, браузер не запрашивает доступ и не имитирует успешное сканирование.
 * Отмена оставляет экран вставки, ошибка показывается без текста QR.
 */
async function scan() {
  error.value = '';

  try {
    const result = await link.bridge!.scanQr();

    if (result.text) {
      text.value = result.text;
      await add();
    }
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : 'Камера недоступна.';
  }
}

onUnmounted(() => {
  text.value = '';
});
</script>

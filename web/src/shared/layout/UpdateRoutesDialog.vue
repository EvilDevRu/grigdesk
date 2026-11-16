<template>
  <UiDialog :open="open" :title="t('core.routeUpdateTitle')" size="compact" mobile-sheet
            @update:open="$emit('update:open', $event)">
    <div class="update-routes">
      <p>{{ profile?.name }}</p>
      <p>{{ t('core.routeUpdateHint') }}</p>
      <template v-if="!editing">
        <UiButton @click="editing = true">{{ t('core.routeUpdateQr') }}</UiButton>
        <UiButton @click="direct">{{ t('core.routeUpdateDirect') }}</UiButton>
      </template>
      <template v-else>
        <UiButton v-if="shell.capabilities.includes('scan')" :disabled="scanning" @click="scan">
          {{ t('core.scanQRCode') }}
        </UiButton>
        <UiInlineMessage v-if="scanned">{{ t('core.machineCodeReady') }}</UiInlineMessage>
        <UiField v-else :label="t('settings.pairingString')">
          <UiTextarea v-model="pairing" autocomplete="off" spellcheck="false" />
        </UiField>
        <UiButton :disabled="busy || scanning || !pairing.trim()" @click="update">
          {{ t('core.routeUpdateConfirm') }}
        </UiButton>
      </template>
      <UiInlineMessage v-if="error" tone="danger">{{ error }}</UiInlineMessage>
    </div>
    <template #footer>
      <UiButton @click="$emit('update:open', false)">{{ t('settings.close') }}</UiButton>
    </template>
  </UiDialog>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';

import type { MachineProfile } from '../../../../shared/client/clientShell.ts';
import { UiButton, UiDialog, UiField, UiInlineMessage, UiTextarea, promptDialog, messageRef, t }
  from '../../ui.ts';
import { useShellStore } from '../../stores/shell.ts';
import { useAuthStore } from '../../stores/auth.ts';

const props = defineProps<{ open: boolean; profile: MachineProfile | null }>();
const emit = defineEmits<{ 'update:open': [value: boolean] }>();
const shell = useShellStore();
const auth = useAuthStore();
const editing = ref(false);
const pairing = ref('');
const scanned = ref(false);
const busy = ref(false);
const scanning = ref(false);
const error = ref('');
let generation = 0;

/**
 * Строка принадлежит одному открытию и выбранному профилю, а не всему shell store.
 * Поздний сканер после закрытия или смены сессии не сохраняет и не отправляет секрет.
 */
function reset(): void {
  generation += 1;
  pairing.value = '';
  scanned.value = false;
  editing.value = false;
  busy.value = false;
  scanning.value = false;
  error.value = '';
}

/**
 * Сканирование получает только строку для последующего явного подтверждения.
 * Считанный секрет не показывается текстом на экране и не сохраняется в профиле web.
 */
async function scan(): Promise<void> {
  if (scanning.value) {
    return;
  }

  const epoch = generation;

  scanning.value = true;

  try {
    const result = await shell.scan();

    if (generation === epoch && props.open) {
      pairing.value = result.pairing;
      scanned.value = true;
    }
  } catch {
    if (generation === epoch) {
      error.value = t('core.couldNotReadTheQRCode');
    }
  } finally {
    if (generation === epoch) {
      scanning.value = false;
    }
  }
}

/**
 * Оболочка проверяет pin, прежний ключ и hello до атомарной замены маршрутов.
 * Web отправляет отдельную форму PATCH существующего профиля и сразу очищает строку.
 */
async function update(): Promise<void> {
  const profile = props.profile;

  if (!profile || busy.value || !pairing.value.trim()) {
    return;
  }

  const epoch = generation;
  const text = pairing.value.trim();

  pairing.value = '';
  busy.value = true;

  try {
    await shell.editProfile(profile.id, { routePairing: text });

    if (generation === epoch) {
      emit('update:open', false);
    }
  } catch {
    if (generation === epoch) {
      error.value = t('core.couldNotChangeTheConnection');
    }
  } finally {
    if (generation === epoch) {
      busy.value = false;
    }
  }
}

/**
 * Прежняя смена direct-адреса доступна рядом с новым route-only действием.
 * Отмена либо смена владельца во время prompt не отправляют PATCH другой машине.
 */
async function direct(): Promise<void> {
  const epoch = generation;
  const profile = props.profile;

  if (!profile) {
    return;
  }

  const address = await promptDialog({ title: messageRef('core.changeAddress'), value: profile.address });

  if (generation === epoch && address !== null) {
    try {
      await shell.editProfile(profile.id, { address });
    } catch {
      // Отказ прямой смены адреса виден в диалоге, как и отказ обновления маршрута.
      if (generation === epoch) {
        error.value = t('core.couldNotChangeTheConnection');
      }

      return;
    }

    if (generation === epoch) {
      emit('update:open', false);
    }
  }
}

watch(() => [props.open, props.profile?.id, shell.profile?.id, auth.clientScope], reset,
  { immediate: true, flush: 'sync' });
onBeforeUnmount(reset);
</script>

<style scoped>
.update-routes {
  display: grid;
  gap: 12px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.update-routes p {
  margin: 0;
}
</style>

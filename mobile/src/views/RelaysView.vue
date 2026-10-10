<template>
  <section class="app-page pane">
    <UiPaneHeader title="Посредники" back="/more" back-label="Настройки" />
    <div class="pane-body">
      <div class="pane-content pane-narrow">
        <UiError v-if="link.error" :text="link.error" @retry="link.refresh" />
        <UiCard v-for="relay in link.state?.relays" :key="relay.id">
          <div class="settings-head">
            <span class="row-avatar" :data-tone="relay.state === 'online' ? 'good' : 'warn'">
              <UiIcon name="relay" />
            </span>
            <div class="settings-name">
              <h2>{{ relay.name }}</h2>
              <span class="mobile-muted mono">{{ relay.host }}:{{ relay.port }}</span>
            </div>
          </div>
          <div class="mobile-actions">
            <UiChip :tone="relay.state === 'online' ? 'good' : 'warn'">
              {{ status(relay.state) }}
            </UiChip>
            <UiChip v-if="relay.id === link.state?.activeRelayId" tone="accent">Активный</UiChip>
          </div>
          <div class="mobile-actions">
            <UiButton
              :disabled="relay.id === link.state?.activeRelayId"
              :busy="link.busy"
              @click="link.select(relay.id)"
            >
              Выбрать
            </UiButton>
            <UiButton
              kind="danger"
              variant="ghost"
              :disabled="link.busy"
              @click="removing = relay.id"
            >
              Удалить
            </UiButton>
          </div>
        </UiCard>
        <UiEmpty v-if="!link.state?.relays.length" icon="relay" text="Посредников пока нет" />
        <UiListRow to="/relays/add" label="Добавить посредника">
          <template #lead><UiIcon name="plus" /></template>
          <span class="row-title row-title-wrap">Добавить посредника</span>
        </UiListRow>
      </div>
    </div>
    <UiDialog
      v-if="removing"
      title="Удалить посредника?"
      confirm="Удалить"
      danger
      :busy="link.busy"
      @close="removing = ''"
      @confirm="remove"
    >
      <p>Вы сможете добавить его снова по QR-коду из кокпита.</p>
    </UiDialog>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue';

import {
  UiButton,
  UiCard,
  UiChip,
  UiDialog,
  UiEmpty,
  UiError,
  UiIcon,
  UiListRow,
  UiPaneHeader,
} from '../ui.ts';
import { useLinkStore } from '../stores/link.ts';

const link = useLinkStore();
const removing = ref('');
const status = (state?: string) =>
  ({
    online: 'В сети',
    offline: 'Нет связи',
    connecting: 'Подключение',
    waiting_vpn: 'Ждёт VPN',
  })[state || 'offline'] || 'Нет связи';
const remove = async () => {
  await link.remove(removing.value);
  removing.value = '';
};
</script>

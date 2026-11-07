<template>
  <section v-if="link.state?.paired" class="app-page pane">
    <UiPaneHeader title="Добавить посредника" back="/relays" back-label="Посредники" />
    <div class="pane-body">
      <div class="pane-content pane-narrow">
        <UiCard>
          <PairForm />
        </UiCard>
      </div>
    </div>
  </section>
  <UiAuthLayout v-else>
    <div class="auth-head">
      <h1>Подключить GrigDesk</h1>
      <p class="mobile-muted">Привяжите телефон к GrigDesk на компьютере.</p>
    </div>
    <PairForm />
    <UiButton v-if="isDesktop && link.state?.error" :busy="link.busy" @click="link.unlock">
      Повторить
    </UiButton>
    <UiButton
      v-if="link.state?.brainName || link.state?.error"
      kind="danger"
      variant="ghost"
      @click="reset = true"
    >
      Отвязать незавершённую привязку
    </UiButton>
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
      <p>Ключ и очередь будут удалены. Для входа понадобится новый QR-код.</p>
    </UiDialog>
  </UiAuthLayout>
</template>

<script setup lang="ts">
import { ref } from 'vue';

import PairForm from '../components/PairForm.vue';
import { UiAuthLayout, UiButton, UiCard, UiDialog, UiPaneHeader } from '../ui.ts';
import { useLinkStore } from '../stores/link.ts';
import { isDesktop } from '../platform.ts';

const link = useLinkStore();
const reset = ref(false);
</script>

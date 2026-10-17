<template>
  <UiDialog
    :open="true"
    :title="pair ? 'Подключить телефон' : 'Добавить адрес на телефон'"
    size="compact"
    data-ui-touch
    @update:open="emit('close')"
  >
    <div class="pairing-content" :aria-busy="loading">
      <p class="pairing-relay">Посредник: {{ relay.name }}</p>
      <ol class="pairing-steps">
        <li>Откройте приложение Кокпита на телефоне.</li>
        <li>
          {{ pair
            ? 'На экране «Подключить Кокпит» отсканируйте этот QR-код.'
            : 'В разделе «Посредники» нажмите «Добавить посредника» и отсканируйте QR-код.' }}
        </li>
      </ol>
      <div class="pairing-code-stage">
        <div v-if="loading" class="pairing-placeholder" role="status">
          <UiSpinner decorative />
          Готовим QR-код…
        </div>
        <div v-else-if="expired" class="pairing-placeholder pairing-expired" role="status">
          <b>Срок действия QR-кода истёк</b>
          <p>Создайте новый код, чтобы продолжить подключение.</p>
          <UiButton variant="solid" tone="accent" data-testid="mobile-refresh-qr" @click="loadQr">
            Создать новый QR
          </UiButton>
        </div>
        <div v-else-if="qr" class="pairing-code">
          <img :src="qrImage" alt="QR-код подключения к Кокпиту" width="320" height="320" />
        </div>
        <div v-else class="pairing-placeholder">
          <UiInlineMessage v-if="error" tone="danger">{{ error }}</UiInlineMessage>
          <UiButton data-role="settings-action" @click="loadQr">Повторить загрузку QR</UiButton>
        </div>
      </div>
      <p class="pairing-expiry" aria-live="off">
        <template v-if="qr?.expiresAt && !expired && !loading">
          Код действует ещё <b>{{ remainingLabel }}</b>
        </template>
      </p>
      <div class="pairing-copy">
        <UiButton
          data-role="settings-action"
          data-testid="mobile-copy-qr"
          :disabled="!qr || expired || loading"
          @click="copyQr"
        >
          {{ copied ? 'Код скопирован' : 'Скопировать код подключения' }}
        </UiButton>
        <p class="pairing-hint" role="status">{{ copied ? 'Вставьте код в приложении на телефоне.' : '' }}</p>
      </div>
      <UiInlineMessage v-if="qr && error && !loading" tone="danger">{{ error }}</UiInlineMessage>
      <UiDisclosureButton
        v-model:open="textOpen"
        controls="mobile-qr-manual"
        :disabled="!qr || expired || loading"
      >
        Подключить без камеры
      </UiDisclosureButton>
      <div v-if="textOpen && qr && !expired && !loading" id="mobile-qr-manual" class="pairing-manual">
        <UiField id="mobile-qr-text" label="Код подключения" hint="Скопируйте и вставьте в приложении.">
          <UiTextarea :model-value="qr.text" readonly rows="4" spellcheck="false" />
        </UiField>
      </div>
    </div>
    <template #footer>
      <UiButton data-role="settings-action" @click="emit('close')">Закрыть</UiButton>
    </template>
  </UiDialog>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';

import {
  UiButton,
  UiDialog,
  UiDisclosureButton,
  UiField,
  UiInlineMessage,
  UiSpinner,
  UiTextarea,
} from '../../ui';
import { api } from '../../shared/apiClient.ts';

type Qr = {
  svg: string;
  text: string;
  expiresAt: number | null;
};

const props = defineProps<{
  relay: { id: string; name: string };
  pair: boolean;
}>();
const emit = defineEmits<{ close: [] }>();

const qr = ref<Qr | null>(null);
const loading = ref(false);
const error = ref('');
const copied = ref(false);
const textOpen = ref(false);
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;
let disposed = false;

const qrImage = computed(() => qr.value ? `data:image/svg+xml,${encodeURIComponent(qr.value.svg)}` : '');
const remaining = computed(() => Math.max(0, Math.ceil(((qr.value?.expiresAt ?? 0) - now.value) / 1000)));
const expired = computed(() => qr.value?.expiresAt != null && remaining.value === 0);
const remainingLabel = computed(() =>
  `${Math.floor(remaining.value / 60)}:${String(remaining.value % 60).padStart(2, '0')}`,
);

/**
 * Запрашивает код только при открытии диалога или явном обновлении истёкшего QR.
 * Поздний ответ после закрытия не возвращает секреты в интерфейс.
 */
async function loadQr() {
  if (loading.value || disposed) {
    return;
  }

  loading.value = true;
  error.value = '';
  copied.value = false;

  try {
    const value = await api.post(`/api/mobile/relays/${props.relay.id}/qr`, { pair: props.pair }) as Qr;

    if (!disposed) {
      qr.value = value;
      now.value = Date.now();
    }
  } catch (cause) {
    if (!disposed) {
      error.value = cause instanceof Error ? cause.message : 'Не удалось получить QR-код.';
    }
  } finally {
    loading.value = false;
  }
}

/**
 * Копирует только действующий код и подтверждает результат рядом с кнопкой.
 * При недоступном буфере раскрывает поле для ручного копирования.
 */
async function copyQr() {
  if (!qr.value || (qr.value.expiresAt !== null && qr.value.expiresAt <= Date.now())) {
    now.value = Date.now();

    return;
  }

  error.value = '';
  copied.value = false;

  try {
    await navigator.clipboard.writeText(qr.value.text);

    if (!disposed) {
      copied.value = true;
    }
  } catch {
    if (!disposed) {
      error.value = 'Не удалось скопировать автоматически. Выделите и скопируйте код в поле ниже.';
      textOpen.value = true;
    }
  }
}

onMounted(() => {
  void loadQr();
  timer = setInterval(() => {
    now.value = Date.now();
  }, 1000);
});
onUnmounted(() => {
  disposed = true;
  clearInterval(timer);
  qr.value = null;
});
</script>

<style scoped>
.pairing-content {
  display: grid;
  gap: 1rem;
  min-width: 0;
}
.pairing-steps {
  display: grid;
  gap: 0.5rem;
  margin: 0;
  padding-left: 1.25rem;
  color: var(--ink-mid);
  font-size: 0.875rem;
  line-height: 1.6;
}
.pairing-steps li::marker {
  color: var(--accent);
  font-weight: 600;
}
.pairing-code-stage {
  width: min(100%, 320px);
  aspect-ratio: 1;
  margin-inline: auto;
}
.pairing-code {
  height: 100%;
  padding: 0.75rem;
  border-radius: var(--radius);
  background: #fff;
}
.pairing-code img {
  display: block;
  width: 100%;
  height: auto;
}
.pairing-expiry,
.pairing-hint,
.pairing-relay {
  margin: 0;
  color: var(--ink-mid);
  font-size: 0.8125rem;
  text-align: center;
}
.pairing-expiry,
.pairing-hint {
  min-height: 1.25rem;
  line-height: 1.25rem;
}
.pairing-copy {
  display: grid;
  gap: 0.25rem;
}
.pairing-relay {
  text-align: left;
  overflow-wrap: anywhere;
}
.pairing-expiry b {
  color: var(--ink);
  font-variant-numeric: tabular-nums;
}
.pairing-placeholder {
  display: grid;
  justify-items: center;
  align-content: center;
  gap: 1rem;
  height: 100%;
  padding: 1.25rem;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--ground);
  color: var(--ink-mid);
  text-align: center;
}
.pairing-expired b {
  color: var(--warn);
}
.pairing-placeholder p {
  margin: 0;
  font-size: 0.875rem;
  line-height: 1.5;
}
.pairing-manual {
  min-width: 0;
}
</style>

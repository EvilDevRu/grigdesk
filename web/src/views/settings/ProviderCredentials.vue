<template>
  <div class="creds" data-testid="provider-credentials">
    <ul class="creds__list">
      <li v-for="item in credentials" :key="item.env" class="creds__row">
        <span class="creds__label">{{ item.label }}</span>
        <span class="creds__state" :class="{ 'creds__state--missing': !item.set }">
          {{ stateText(item) }}
        </span>
      </li>
    </ul>
    <div class="creds__actions">
      <UiButton
        :tone="anyMissing ? 'accent' : 'neutral'"
        data-role="settings-action"
        data-testid="provider-credentials-open"
        @click="openDialog"
      >
        {{ anyMissing ? 'Задать ключи…' : 'Изменить ключи…' }}
      </UiButton>
    </div>

    <UiDialog
      :open="open"
      :title="`Ключи доступа · ${providerName}`"
      :busy="saving"
      data-testid="provider-credentials-dialog"
      @update:open="(value) => (value ? openDialog() : closeDialog())"
    >
      <form class="creds__form" autocomplete="off" @submit.prevent="save">
        <p class="creds__note">
          Значения сохраняются в корневой .env сервера и действуют сразу, без перезапуска.
        </p>
        <div v-for="item in credentials" :key="item.env" class="creds__field">
          <UiField :label="item.label" :hint="fieldHint(item)">
            <UiPasswordInput
              v-if="item.kind === 'secret'"
              v-model="drafts[item.env]"
              :name="item.env"
              autocomplete="new-password"
              spellcheck="false"
              :placeholder="item.set ? 'Оставьте пустым, чтобы не менять' : 'Вставьте ключ'"
              :disabled="saving"
            />
            <UiSelect v-else v-model="choices[item.env]" :name="item.env" :disabled="saving">
              <option v-if="!item.value" value="">Не выбран</option>
              <option v-for="option in item.options" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </UiSelect>
          </UiField>
          <UiButton
            v-if="item.inFile"
            class="creds__remove"
            variant="text"
            tone="danger"
            :disabled="saving"
            @click="remove(item)"
          >
            Удалить из .env
          </UiButton>
        </div>
        <UiInlineMessage v-if="error" tone="danger">{{ error }}</UiInlineMessage>
      </form>
      <template #footer>
        <UiFormActions>
          <UiButton variant="ghost" :disabled="saving" @click="closeDialog">Отмена</UiButton>
          <UiButton
            variant="solid"
            tone="accent"
            :loading="saving"
            loading-label="Сохраняю"
            :disabled="!hasChanges"
            @click="save"
          >
            Сохранить
          </UiButton>
        </UiFormActions>
      </template>
    </UiDialog>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue';

import { useProvidersStore } from '../../stores/providers.js';
import {
  UiButton,
  UiDialog,
  UiField,
  UiFormActions,
  UiInlineMessage,
  UiPasswordInput,
  UiSelect,
  confirmDialog,
} from '../../ui.ts';

interface CredentialOption {
  value: string;
  label: string;
}

// Проекция сервера: у секрета нет значения, только признак, хвост и источник.
interface CredentialView {
  env: string;
  kind: 'secret' | 'choice';
  label: string;
  hint?: string;
  options?: readonly CredentialOption[];
  set: boolean;
  inFile: boolean | null;
  preview: string | null;
  value: string | null;
}

const props = defineProps<{
  providerId: string;
  providerName: string;
  credentials: readonly CredentialView[];
}>();

const prov = useProvidersStore();

const open = ref(false);
const saving = ref(false);
const error = ref('');
// Введённые секреты живут только пока открыто окно: закрытие стирает их из памяти страницы.
const drafts = reactive<Record<string, string>>({});
const choices = reactive<Record<string, string>>({});

const anyMissing = computed(() => props.credentials.some((item) => item.kind === 'secret' && !item.set));

const changes = computed(() => {
  const values: Record<string, string> = {};

  for (const item of props.credentials) {
    const next = item.kind === 'secret' ? (drafts[item.env] || '').trim() : choices[item.env] || '';

    if (next && (item.kind === 'secret' || next !== item.value)) {
      values[item.env] = next;
    }
  }

  return values;
});

const hasChanges = computed(() => Object.keys(changes.value).length > 0);

/**
 * Строка состояния в карточке: задан ли ключ и откуда. Значение секрета неизвестно
 * и браузеру, поэтому видны только признак и хвост длинного ключа.
 */
function stateText(item: CredentialView): string {
  if (!item.set) {
    return 'не задан';
  }

  if (item.kind === 'choice') {
    return item.options?.find((option) => option.value === item.value)?.label || item.value || 'задан';
  }

  const tail = item.preview ? ` · ${item.preview}` : '';

  return item.inFile === false ? `задан вне .env${tail}` : `задан${tail}`;
}

function fieldHint(item: CredentialView): string {
  const outside = item.set && item.inFile === false
    ? 'Сейчас значение задано вне .env; сохранение запишет его в .env.'
    : '';

  return [item.hint, outside].filter(Boolean).join(' ');
}

/**
 * Готовит окно с чистыми полями секретов и текущими вариантами выбора.
 * Прежний ввод не переживает закрытие окна.
 */
function openDialog(): void {
  for (const item of props.credentials) {
    drafts[item.env] = '';
    choices[item.env] = item.value || '';
  }

  error.value = '';
  open.value = true;
}

/**
 * Закрывает окно и стирает введённые секреты. Во время сохранения окно не закрывается,
 * иначе ответ сервера пришёл бы в уже закрытую форму.
 */
function closeDialog(): void {
  if (saving.value) {
    return;
  }

  for (const key of Object.keys(drafts)) {
    drafts[key] = '';
  }

  open.value = false;
}

/**
 * Отправляет правку на сервер и показывает отказ в окне. Пока запрос идёт, окно
 * не закрывается и поля заблокированы. Возвращает, принял ли сервер правку.
 */
async function submit(values: Record<string, string | null>, failure: string): Promise<boolean> {
  saving.value = true;
  error.value = '';

  const result = await prov.saveCredentials(props.providerId, values);

  saving.value = false;

  if (!result.ok) {
    error.value = result.error || failure;
  }

  return result.ok;
}

// Успех закрывает окно; при отказе введённые значения остаются, чтобы их поправить.
async function save(): Promise<void> {
  if (hasChanges.value && !saving.value && await submit(changes.value, 'Не удалось сохранить ключи.')) {
    closeDialog();
  }
}

/**
 * Удаляет переменную из .env после подтверждения. Окно остаётся открытым:
 * состояние полей обновится из нового снимка исполнителя.
 */
async function remove(item: CredentialView): Promise<void> {
  const confirmed = await confirmDialog(
    `Удалить «${item.label}» из .env? Исполнитель перестанет видеть значение сразу.`,
    { okText: 'Удалить', danger: true },
  );

  if (confirmed && await submit({ [item.env]: null }, 'Не удалось удалить значение.')) {
    drafts[item.env] = '';
    choices[item.env] = '';
  }
}
</script>

<style scoped>
.creds {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.creds__list {
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.creds__row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
}

.creds__state {
  color: var(--ink-mid);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.creds__state--missing {
  color: var(--warn, #e0a33a);
}

.creds__actions {
  display: flex;
  justify-content: flex-start;
}

.creds__form {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: min(440px, 100%);
}

.creds__note {
  margin: 0;
  color: var(--ink-mid);
  font-size: 12.5px;
}

.creds__field {
  display: grid;
  gap: 4px;
}

.creds__remove {
  justify-self: start;
}
</style>

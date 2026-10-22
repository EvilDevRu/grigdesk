<template>
  <div class="perm" :class="{ plan: isPlan }">
    <div class="col">
      <div class="p-row">
        <span class="p-t">
          <template v-if="isPlan">План готов — утвердить?</template>
          <template v-else-if="isSsh">Выполнить команду на сервере?</template>
          <template v-else-if="isDb">Выполнить запрос к базе?</template>
          <template v-else-if="isExternalUrl">
            Открыть внешнюю страницу для <span class="p-tool">{{ req.tool }}</span>?
          </template>
          <template v-else>
            Разрешить <span class="p-tool">{{ req.tool }}</span>?
          </template>
        </span>

        <UiFormActions v-if="isExternalUrl" class="p-act">
          <UiActionLink
            v-if="externalUrl"
            :href="externalUrl"
            target="_blank"
            variant="solid"
            tone="accent"
          >
            {{ externalLinkLabel }}
          </UiActionLink>
          <UiButton
            variant="solid"
            tone="success"
            :disabled="!externalUrl"
            @click="emit('answer', true, false)"
          >
            {{ externalApproveLabel }}
          </UiButton>
          <UiButton tone="danger" @click="reject()">
            {{ externalRejectLabel }}
          </UiButton>
        </UiFormActions>

        <UiFormActions v-else-if="!choices.length" class="p-act">
          <UiButton
            variant="solid"
            tone="success"
            @click="emit('answer', true, remember)"
          >
            {{ isPlan ? 'Утвердить' : 'Разрешить' }}
          </UiButton>
          <UiButton tone="danger" @click="reject()">
            {{ isPlan ? 'Доработать' : 'Отклонить' }}
          </UiButton>
        </UiFormActions>
      </div>

      <UiChoiceList
        v-if="choices.length"
        v-model="selectedChoice"
        class="p-choices"
        label="Вариант решения"
        :options="choiceOptions"
        @update:model-value="chooseById"
      />

      <div v-if="isSsh" class="p-ssh-meta">
        <div data-ssh-server>
          {{ req.server?.label }} — {{ req.server?.host }}:{{ req.server?.port }}
        </div>
        <div>
          Пользователь: <strong data-ssh-user>{{ req.user }}</strong>
          <span v-if="req.isRoot" class="p-ssh-badge" data-ssh-privilege>root</span>
          <span v-if="req.usesSudo" class="p-ssh-badge" data-ssh-privilege>sudo</span>
        </div>
      </div>

      <div v-if="isDb" class="p-db-meta">
        <div>
          <strong data-db-profile>{{ req.profile?.label }} — {{ dbRole }}</strong>
          <span v-if="req.prod" class="p-db-prod" data-db-prod>прод</span>
        </div>
        <div>Движок: <strong data-db-engine>{{ req.engine?.label || req.engine?.id }}</strong></div>
        <div>Класс: <strong data-db-class>{{ dbQueryClass }}</strong></div>
        <div>Таблицы: <span data-db-tables>{{ dbTables }}</span></div>
        <div v-if="req.rowEstimate != null">
          Оценка строк: <strong data-db-row-estimate>{{ req.rowEstimate }}</strong>
        </div>
        <div v-if="dbSpecial" data-db-special>
          Особые конструкции: <strong>{{ dbSpecial }}</strong>
        </div>
        <pre class="p-in cmd" data-db-query>{{ req.query }}</pre>
        <div v-if="req.autoReadReason?.message" class="p-db-reason" data-db-auto-read-reason>
          {{ req.autoReadReason.message }}
        </div>
      </div>

      <div v-if="description" class="p-desc">{{ description }}</div>
      <div v-if="isExternalUrl && externalUrl" class="p-url-host">
        Внешний сайт: {{ externalHost }}. После завершения вернись и нажми «{{ externalApproveLabel }}».
      </div>
      <div v-else-if="isExternalUrl" class="p-url-bad">
        Ссылка отклонена как небезопасная. Продолжить через неё нельзя.
      </div>
      <div v-if="filePath" class="p-path">{{ filePath }}</div>
      <pre
        v-if="command"
        class="p-in cmd"
        :class="{ ssh: isSsh }"
        :data-ssh-command="isSsh ? '' : undefined"
      >{{ command }}</pre>
      <pre v-if="plan" class="p-in big">{{ plan }}</pre>

      <div v-if="diff" class="p-diff">
        <div class="dhead">
          <span>было</span>
          <span>стало {{ diff.stat }}</span>
        </div>
        <div v-for="(row, index) in diff.split" :key="index" class="drow">
          <div class="dcell" :class="row.l?.t || 'nil'">
            {{ row.l ? row.l.text || ' ' : '' }}
          </div>
          <div class="dcell" :class="row.r?.t || 'nil'">
            {{ row.r ? row.r.text || ' ' : '' }}
          </div>
        </div>
      </div>

      <pre v-if="details" class="p-in">{{ details }}</pre>
      <pre v-if="rest" class="p-in">{{ rest }}</pre>

      <div v-if="canRemember" class="p-rem">
        <UiCheckbox v-model="remember">
          не спрашивать про «{{ req.tool }}» до конца сессии
        </UiCheckbox>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { PropType } from 'vue';
import type { ChatPermission, PermissionChoice } from '../../shared/chatContracts.ts';
import { lineDiff, splitRows } from '../../shared/diff.ts';
import {
  promptDialog,
  UiActionLink,
  UiButton,
  UiCheckbox,
  UiChoiceList,
  UiFormActions,
} from '../../ui';

// Плашка показывает разобранный permission-запрос или готовый план на утверждение.
const props = defineProps({
  req: {
    type: Object as PropType<ChatPermission>,
    required: true,
  },
});
const emit = defineEmits(['answer']);

const remember = ref(false);
const selectedChoice = ref<string | string[] | null>(null);

watch(
  () => props.req?.pid,
  () => {
    remember.value = false;
    selectedChoice.value = null;
  },
  { immediate: true },
);

const input = computed(() => props.req?.input || {});
const isSsh = computed(() => props.req?.origin === 'ssh');
const isDb = computed(() => props.req?.origin === 'db');
const isExternalUrl = computed(() => input.value.kind === 'external_url');
const isPlan = computed(() => (
  Boolean(input.value.plan) || props.req?.tool === 'ExitPlanMode'
));
const plan = computed(() => String(input.value.plan || ''));
const command = computed(() => String(isSsh.value ? props.req?.command || '' : input.value.command || ''));
const filePath = computed(() => String(input.value.file_path || ''));
const details = computed(() => String(input.value.details || ''));
const description = computed(() => String(input.value.description || ''));
const externalUrl = computed(() => safeExternalUrl(input.value.url));
const externalHost = computed(() => {
  try { return new URL(externalUrl.value).host; } catch { return ''; }
});
const externalLinkLabel = computed(() => String(input.value.link_label || 'Открыть страницу'));
const externalApproveLabel = computed(() => String(input.value.approve_label || 'Готово'));
const externalRejectLabel = computed(() => String(input.value.reject_label || 'Не открывать'));
const canRemember = computed(() => (
  !isPlan.value
  && !isSsh.value
  && !isDb.value
  && !isExternalUrl.value
  && props.req?.canRemember !== false
));
const DB_ROLES: Record<string, string> = { read: 'чтение', write: 'запись' };
const DB_CLASSES: Record<string, string> = {
  read: 'чтение',
  write: 'запись',
  ddl: 'DDL',
  admin: 'администрирование',
  unknown: 'неизвестный',
};

const dbRole = computed(() => (DB_ROLES[props.req?.profile?.role || '']
  || String(props.req?.profile?.role || '')));
const dbQueryClass = computed(() => (DB_CLASSES[props.req?.queryClass || '']
  || String(props.req?.queryClass || '')));
const dbTables = computed(() => Array.isArray(props.req?.tables) && props.req.tables.length
  ? props.req.tables.join(', ')
  : 'не определены');

// Табличная функция и запрещённая конструкция — единственное в карточке, что говорит
// о выходе запроса за саму базу; без строки человек увидел бы обычный SELECT.
const dbSpecial = computed(() => [
  ...(Array.isArray(props.req?.tableFunctions) ? props.req.tableFunctions : []),
  ...(Array.isArray(props.req?.forbidden) ? props.req.forbidden : []),
].map(String).join(', '));

const diff = computed(() => {
  const source = input.value.diff;

  if (!source || (!source.old && !source.new)) {
    return null;
  }

  const rows = lineDiff(source.old, source.new);

  return {
    split: splitRows(rows.rows),
    stat: `+${rows.added} −${rows.removed}`,
  };
});

const choices = computed(() => (
  Array.isArray(input.value.choices)
    ? input.value.choices.filter((choice) => (
      choice && choice.id && choice.label
    ))
    : []
));
const choiceOptions = computed(() => choices.value.map((choice) => ({
  value: String(choice.id),
  label: String(choice.label),
})));

function isAllowChoice(choice: PermissionChoice) {
  return choice.kind === 'allow_once' || choice.kind === 'allow_always';
}

const KNOWN_FIELDS = new Set([
  'kind',
  'description',
  'details',
  'plan',
  'command',
  'file_path',
  'diff',
  'choices',
  'url',
  'link_label',
  'approve_label',
  'reject_label',
]);

const rest = computed(() => {
  const extra = Object.fromEntries(
    Object.entries(input.value).filter(([key, value]) => (
      !KNOWN_FIELDS.has(key) && value !== '' && value != null
    )),
  );

  if (Object.keys(extra).length) {
    return JSON.stringify(extra);
  }

  const shown = plan.value
    || command.value
    || filePath.value
    || details.value
    || description.value
    || diff.value;

  if (shown) {
    return '';
  }

  const serialized = JSON.stringify(input.value);

  return serialized === '{}' ? '' : serialized;
});

/**
 * Отказ спрашивает пояснение до emit: отмена диалога должна оставить permission
 * висеть, а введённый текст уезжает третьим аргументом прежнего контракта.
 */
async function reject(choice = '') {
  if (isExternalUrl.value) {
    emit('answer', false, false, '', choice);

    return;
  }

  const text = await promptDialog({
    title: isPlan.value ? 'Что доработать в плане?' : 'Почему отклоняете?',
    placeholder: isSsh.value ? 'Пояснение обязательно' : 'можно оставить пустым',
  });

  if (text === null) {
    selectedChoice.value = null;

    return;
  }

  if (isSsh.value && !text.trim()) {
    return;
  }

  emit('answer', false, false, text.trim(), choice);
}

/**
 * Внешняя ссылка повторяет серверную политику допустимых протоколов.
 * Credentials и активные схемы не передаются браузеру из permission-запроса.
 */
function safeExternalUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 4_000) {
    return '';
  }

  try {
    const parsed = new URL(value);

    if (parsed.username || parsed.password) {
      return '';
    }

    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);

    return parsed.protocol === 'https:' || (parsed.protocol === 'http:' && loopback)
      ? parsed.href
      : '';
  } catch {
    return '';
  }
}

function choose(choice: PermissionChoice) {
  if (isAllowChoice(choice)) {
    emit('answer', true, remember.value, '', choice.id);

    return;
  }

  void reject(choice.id);
}

function chooseById(value: unknown) {
  const choice = choices.value.find((entry) => String(entry.id) === String(value));

  if (choice) {
    choose(choice);
  }
}
</script>

<style scoped>
/* Плашка не расширяет страницу: длинная команда переносится внутри bounded-region. */
.perm { padding: 8px 22px 9px; border-top: 1px solid color-mix(in srgb, var(--warn, #e0a33a) 45%, var(--line));
  background: color-mix(in srgb, var(--warn, #e0a33a) 7%, transparent); overflow: hidden;
  max-height: 38vh; overflow-y: auto; }
.col { width: 100%; min-width: 0; }
.p-row { display: flex; align-items: center; justify-content: space-between; gap: 10px;
  min-width: 0; flex-wrap: wrap; }
.p-t { min-width: 0; font-size: 13px; }
.p-tool { color: var(--warn, #e0a33a); font-family: var(--mono, monospace); }
.p-act { margin-left: auto; }
.p-choices { margin-top: 7px; }
.p-desc { margin-top: 5px; color: var(--ink); font-size: 12.5px; overflow-wrap: anywhere; }
.p-url-host { margin-top: 5px; color: var(--ink-mid); font-size: 11.5px; overflow-wrap: anywhere; }
.p-url-bad { margin-top: 5px; color: var(--bad); font-size: 11.5px; }
.p-path { margin-top: 4px; color: var(--ink-mid); font-family: var(--mono, monospace);
  font-size: 11.5px; overflow-wrap: anywhere; }
.p-in { margin: 6px 0 0; padding: 7px 10px; background: var(--ground); border: 1px solid var(--line);
  border-radius: 8px; color: var(--ink-mid); font-size: 11.5px; line-height: 1.5;
  white-space: pre-wrap; overflow-wrap: anywhere; max-height: 132px; overflow-y: auto; }
.p-in.cmd { color: var(--ink); font-family: var(--mono, monospace); }
.p-in.cmd.ssh { max-height: none; min-width: 0; max-width: 100%; word-break: break-word; }
.p-ssh-meta { display: grid; gap: 4px; margin-top: 6px; min-width: 0; overflow-wrap: anywhere; }
.p-db-meta { display: grid; gap: 4px; margin-top: 6px; min-width: 0; overflow-wrap: anywhere; }
.p-db-prod { margin-left: 6px; color: var(--bad); }
.p-db-reason { color: var(--ink-mid); font-size: 11.5px; }
.p-ssh-badge { margin-left: 5px; padding: 1px 6px; border-radius: 999px;
  background: color-mix(in srgb, var(--bad) 14%, transparent); color: var(--bad); }
.p-in.big { max-height: 320px; color: var(--ink); font-size: 12px;
  word-break: normal; overflow-wrap: anywhere; }
.perm.plan { border-top-color: color-mix(in srgb, var(--accent) 45%, var(--line));
  background: color-mix(in srgb, var(--accent) 7%, transparent); }
.p-rem { margin-top: 7px; color: var(--ink-mid); font-size: 11.5px; }

/* Дифф правки — те же две колонки, что в ленте хода. */
.p-diff { margin-top: 6px; border: 1px solid var(--line); border-radius: 8px;
  overflow: auto; max-height: 240px; background: var(--ground); }
.dhead, .drow { display: grid; grid-template-columns: 1fr 1fr; }
.dhead { position: sticky; top: 0; z-index: 1; background: var(--surface-2);
  color: var(--ink-mid); font-size: 10.5px; text-transform: uppercase; letter-spacing: .04em; }
.dhead span { padding: 3px 10px; }
.dhead span + span, .drow .dcell + .dcell { border-left: 1px solid var(--line); }
.dcell { min-width: 0; padding: 0 10px; color: var(--ink-mid);
  font-family: var(--mono, monospace); font-size: 11.5px; line-height: 1.5;
  white-space: pre-wrap; word-break: break-word; }
.dcell.del { background: color-mix(in srgb, var(--bad) 14%, transparent);
  color: color-mix(in srgb, var(--bad) 85%, var(--ink)); }
.dcell.add { background: color-mix(in srgb, var(--good) 14%, transparent);
  color: color-mix(in srgb, var(--good) 85%, var(--ink)); }
.dcell.nil { background: color-mix(in srgb, var(--surface-2) 60%, transparent); }
.dcell.del::before { content: '− '; opacity: .7; }
.dcell.add::before { content: '+ '; opacity: .7; }
</style>

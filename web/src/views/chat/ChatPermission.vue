<template>
  <ChatIntervention
    class="perm"
    :heading="title"
    :source="req.tool"
    :tone="isPlan ? 'question' : 'permission'"
  >
    <div v-if="description" class="p-desc">{{ description }}</div>

    <div v-if="isSsh" class="p-ssh-meta">
      <div data-ssh-server>
        <span class="p-label">{{ t('core.interventionSshServer') }}:</span>
        {{ req.server?.label }} — {{ req.server?.host }}:{{ req.server?.port }}
      </div>
      <div v-if="req.tab" data-ssh-tab>
        <span class="p-label">{{ t('core.interventionSshTab') }}: </span>
        <strong>{{ req.tab.projectId }} — {{ req.tab.label }}</strong>
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

    <div v-if="isExternalUrl && externalUrl" class="p-url-host">
      Внешний сайт: {{ externalHost }}. После завершения вернись и нажми «{{ externalApproveLabel }}».
    </div>
    <div v-else-if="isExternalUrl" class="p-url-bad">
      Ссылка отклонена как небезопасная. Продолжить через неё нельзя.
    </div>
    <div v-if="filePath" class="p-section">
      <div class="p-label">{{ t('core.interventionFile') }}</div>
      <div class="p-path">{{ filePath }}</div>
    </div>
    <div v-if="command" class="p-label p-section">{{ t('core.interventionCommand') }}</div>
    <pre v-if="command && isSsh" class="p-in cmd ssh" data-ssh-command><span
      v-for="(part, index) in commandParts"
      :key="index"
      class="p-ssh-command-part"
      data-ssh-command-part
    >{{ part }}</span></pre>
    <pre v-else-if="command" class="p-in cmd">{{ command }}</pre>
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

    <div v-if="justification" class="p-section">
      <div class="p-label">{{ t('core.interventionJustification') }}</div>
      <div class="p-desc" data-permission-justification>{{ justification }}</div>
    </div>

    <div v-if="sandboxPermissions || timeout" class="p-permission-meta p-section">
      <div v-if="sandboxPermissions" data-permission-access>
        <span class="p-label">{{ t('core.interventionAccess') }}:</span> {{ sandboxPermissions }}
      </div>
      <div v-if="timeout" data-permission-timeout>
        <span class="p-label">{{ t('core.interventionTimeout') }}:</span> {{ timeout }}
      </div>
    </div>

    <div v-if="details || rest" class="p-section">
      <div class="p-label">{{ t('core.interventionDetails') }}</div>
      <pre v-if="details" class="p-in">{{ details }}</pre>
      <pre v-if="rest" class="p-in">{{ rest }}</pre>
    </div>

    <template #footer>
      <div class="p-footer">
        <div v-if="canRemember" class="p-rem">
          <UiCheckbox v-model="remember">
            не спрашивать про «{{ req.tool }}» до конца сессии
          </UiCheckbox>
        </div>

        <UiChoiceList
          v-if="choices.length"
          v-model="selectedChoice"
          class="p-choices"
          label="Вариант решения"
          :options="choiceOptions"
          @update:model-value="chooseById"
        />

        <UiFormActions v-else class="p-act">
          <template v-if="isExternalUrl">
            <UiActionLink
              v-if="externalUrl"
              :href="externalUrl"
              target="_blank"
              variant="outline"
              tone="accent"
            >
              {{ externalLinkLabel }}
            </UiActionLink>
            <UiButton size="compact" tone="danger" @click="reject()">{{ externalRejectLabel }}</UiButton>
            <UiButton
              size="compact"
              variant="solid"
              tone="accent"
              :disabled="!externalUrl"
              @click="emit('answer', true, false)"
            >
              {{ externalApproveLabel }}
            </UiButton>
          </template>
          <template v-else>
            <UiButton size="compact" tone="neutral" @click="reject()">
              {{ isPlan ? 'Доработать' : 'Отклонить' }}
            </UiButton>
            <UiButton
              size="compact"
              variant="solid"
              tone="accent"
              @click="emit('answer', true, remember)"
            >
              {{ isPlan ? 'Утвердить' : 'Разрешить' }}
            </UiButton>
          </template>
        </UiFormActions>
      </div>
    </template>
  </ChatIntervention>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { PropType } from 'vue';
import { formatNumber } from '../../../../shared/i18n/formats.ts';
import type { ChatPermission, PermissionChoice } from '../../shared/chatContracts.ts';
import { lineDiff, splitRows } from '../../shared/diff.ts';
import { sshCommandParts } from '../../shared/sshCommandParts.ts';
import ChatIntervention from './ChatIntervention.vue';
import {
  t,
  uiLocale,
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
const title = computed(() => {
  if (isPlan.value) {
    return t('core.interventionPlanTitle');
  }
  if (isSsh.value) {
    return 'Выполнить команду на сервере?';
  }
  if (isDb.value) {
    return 'Выполнить запрос к базе?';
  }

  return t(isExternalUrl.value ? 'core.interventionExternalTitle' : 'core.interventionPermissionTitle');
});
const plan = computed(() => displayText(input.value.plan));
const command = computed(() => displayText(isSsh.value ? props.req.command : input.value.command));
const commandParts = computed(() => sshCommandParts(command.value));
const filePath = computed(() => displayText(input.value.file_path));
const details = computed(() => displayText(
  input.value.details ?? (typeof input.value.content === 'string' ? input.value.content : null),
));
const description = computed(() => {
  const text = displayText(input.value.description);

  return text === command.value || text === details.value ? '' : text;
});
const justification = computed(() => {
  const text = typeof input.value.justification === 'string' ? input.value.justification : '';

  return [description.value, command.value, details.value].includes(text) ? '' : text;
});
const accessLabels = computed<Record<string, string>>(() => ({
  'read-only': t('core.interventionAccessReadOnly'),
  'workspace-write': t('core.interventionAccessWorkspaceWrite'),
  'danger-full-access': t('core.interventionAccessFull'),
}));
const sandboxPermissions = computed(() => {
  const value = input.value.sandbox_permissions;

  if (typeof value !== 'string') {
    return '';
  }

  return Object.hasOwn(accessLabels.value, value) ? accessLabels.value[value] : value;
});
const timeoutMs = computed(() => {
  const value = input.value.timeoutMs;

  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
});
const timeout = computed(() => timeoutMs.value === null ? '' : t('core.interventionTimeoutSeconds', {
  seconds: formatNumber(timeoutMs.value / 1000, uiLocale, { maximumFractionDigits: 6 }),
}));
const externalUrl = computed(() => safeExternalUrl(input.value.url));
const externalHost = computed(() => {
  try {
    return new URL(externalUrl.value).host;
  } catch {
    return '';
  }
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

// Native-запросы несут исходную пару строк, адаптеры могут прислать готовый diff.
// Обе формы показываются одинаково; пустая строка остаётся допустимой стороной правки.
const diffSource = computed(() => {
  if (input.value.diff) {
    return input.value.diff;
  }
  if (typeof input.value.old_string === 'string' && typeof input.value.new_string === 'string') {
    return {
      old: input.value.old_string,
      new: input.value.new_string,
    };
  }

  return null;
});

const diff = computed(() => {
  const source = diffSource.value;

  if (!source || (typeof source.old !== 'string' && typeof source.new !== 'string')) {
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
  const knownFields = new Set(KNOWN_FIELDS);

  if (typeof input.value.justification === 'string') {
    knownFields.add('justification');
  }
  if (typeof input.value.sandbox_permissions === 'string') {
    knownFields.add('sandbox_permissions');
  }
  if (timeoutMs.value !== null) {
    knownFields.add('timeoutMs');
  }
  if (diff.value && !input.value.diff) {
    knownFields.add('old_string');
    knownFields.add('new_string');
  }
  if (input.value.details == null && typeof input.value.content === 'string') {
    knownFields.add('content');
  }

  const extra = Object.fromEntries(
    Object.entries(input.value).filter(([key, value]) => (
      !knownFields.has(key) && value !== '' && value != null
    )),
  );

  if (Object.keys(extra).length) {
    return JSON.stringify(extra, null, 2);
  }

  return '';
});

/**
 * Незнакомое структурное поле остаётся читаемым JSON вместо строки object Object.
 * Исходные строки сохраняют пробелы и переводы строк команды или содержимого файла.
 */
function displayText(value: unknown): string {
  if (value == null) {
    return '';
  }

  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

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
.p-desc {
  margin-bottom: 10px;
  color: var(--ink);
  font-size: 13px;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.p-section {
  margin-top: 10px;
}

.p-label {
  margin-bottom: 5px;
  color: var(--ink-mid);
  font-size: 11px;
  font-weight: 500;
}

.p-url-host,
.p-url-bad,
.p-db-reason {
  margin-top: 6px;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.p-url-bad {
  color: var(--bad);
}

.p-path {
  color: var(--ink);
  font-family: var(--mono, monospace);
  font-size: 12px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.p-in {
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--control-border);
  border-radius: var(--control-radius);
  background: var(--control-background);
  color: var(--ink-mid);
  font-family: var(--mono, monospace);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.p-in + .p-in {
  margin-top: 8px;
}

.p-in.cmd,
.p-in.big {
  color: var(--ink);
}

.p-ssh-command-part {
  display: block;
}

.p-ssh-command-part + .p-ssh-command-part {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--control-border);
}

.p-ssh-meta,
.p-db-meta,
.p-permission-meta {
  display: grid;
  gap: 6px;
  min-width: 0;
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.p-db-prod {
  margin-left: 6px;
  color: var(--bad);
}

.p-ssh-badge {
  margin-left: 5px;
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--bad) 14%, transparent);
  color: var(--bad);
}

.p-rem {
  flex: 1 1 240px;
  min-width: 0;
  color: var(--ink-mid);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.p-footer {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  min-width: 0;
}

.p-choices {
  flex: 1 0 100%;
}

.p-act {
  margin-left: auto;
}

/* Дифф сохраняет две колонки; длинные строки переносятся внутри своей ячейки.
   Вся правка прокручивается вместе с телом карточки, оставляя действия на месте. */
.p-diff {
  margin-top: 10px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--ground);
}

.dhead,
.drow {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
}

.dhead {
  background: var(--surface-2);
  color: var(--ink-mid);
  font-size: 11px;
}

.dhead span {
  padding: 6px 10px;
}

.dhead span + span,
.drow .dcell + .dcell {
  border-left: 1px solid var(--line);
}

.dcell {
  min-width: 0;
  padding: 1px 10px;
  color: var(--ink-mid);
  font-family: var(--mono, monospace);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.dcell.del {
  background: color-mix(in srgb, var(--bad) 14%, transparent);
  color: color-mix(in srgb, var(--bad) 85%, var(--ink));
}

.dcell.add {
  background: color-mix(in srgb, var(--good) 14%, transparent);
  color: color-mix(in srgb, var(--good) 85%, var(--ink));
}

.dcell.nil {
  background: color-mix(in srgb, var(--surface-2) 60%, transparent);
}

.dcell.del::before {
  content: '− ';
  opacity: .7;
}

.dcell.add::before {
  content: '+ ';
  opacity: .7;
}
</style>

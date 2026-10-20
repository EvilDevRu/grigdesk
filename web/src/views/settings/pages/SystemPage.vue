<template>
  <section
    class="settings-system"
    :data-system-page="settings.pageId"
    :data-ready="ready"
  >
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="message" role="status">{{ message }}</p>
    <template v-if="settings.pageId === 'system.startup'">
      <SettingsSection heading="Процесс GrigDesk" description="Текущее состояние сервера на этой машине.">
        <dl v-if="server" class="settings-system-facts">
          <div><dt>Режим работы</dt><dd>{{ serverText.pill }}</dd></div>
          <div><dt>Время работы</dt><dd>{{ uptime }}</dd></div>
          <div><dt>Процесс</dt><dd>PID {{ server.pid }}</dd></div>
        </dl>
        <p v-if="serverText.hint">{{ serverText.hint }}</p>
        <UiButton :disabled="busy || !server" @click="restart">Перезапустить сервер</UiButton>
      </SettingsSection>
      <SettingsSection heading="Автозапуск">
        <SettingsScope scope="Эта машина">
          Автозапуск применяется по «Применить», живой процесс продолжает работу.
        </SettingsScope>
        <SettingsField
          v-for="field in startupFields"
          :key="field.key"
          :address="field.address"
        >
          <UiSwitch
            :model-value="autostartValue"
            :disabled="!launcher || launcher.autostart.unit === 'missing' || busy"
            :aria-label="field.label"
            @update:model-value="settings.setField('autostart', 'enabled', $event)"
          />
        </SettingsField>
        <template v-if="launcher">
          <div class="settings-autostart-note">
            <p>{{ autostartNote }}</p>
            <p v-if="server?.mode === 'desktop'">
              Сервером управляет приложение. Переключатель касается юнита.
            </p>
            <p v-else-if="server && !server.systemd">Сервер запущен вручную. Переключатель касается юнита.</p>
          </div>
        </template>
      </SettingsSection>
      <template v-if="launcher">
        <SettingsSection
          heading="Ярлык приложения"
          description="Быстрый доступ с рабочего стола и из меню приложений."
        >
          <p>Ярлык: {{ shortcutLabel }}</p>
          <UiButton :disabled="busy || (!shortcutPresent && !launcher.shortcut.desktopDir)" @click="shortcut">
            {{ shortcutPresent ? 'Убрать ярлык' : 'Создать ярлык' }}
          </UiButton>
        </SettingsSection>
      </template>
    </template>
    <template v-else>
      <SettingsSection
        heading="Версия GrigDesk"
        description="Установленная версия, стабильный канал и проверка обновлений."
      >
        <PackagedServerVersion
          v-if="packageCapability"
          :version="release?.running.version || '—'"
          :client-version="buildVersion"
          :message="packageCapability.message"
        />
        <template v-else-if="release">
          <p>Запущено: {{ release.running.version }} · {{ shortSha(release.running.sha) }}</p>
          <p>
            Checkout: {{ release.checkout.version }} · {{ shortSha(release.checkout.sha) }} ·
            {{ release.checkout.branch || 'detached HEAD' }}
            <span v-if="release.checkout.dirty">· Есть изменения</span>
          </p>
          <p>Интерфейс приложения: {{ buildVersion }} · {{ shortSha(buildSha) }}</p>
          <p v-if="release.latest">
            Стабильный канал: {{ release.latest.tag }} · {{ shortSha(release.latest.sha) }}
            <UiActionLink
              v-if="release.latest.url"
              :href="release.latest.url"
              target="_blank"
            >
              Что изменилось
            </UiActionLink>
          </p>
          <p v-else>Релизы пока не найдены</p>
          <p>Последняя проверка: {{ release.checkedAt || 'Ещё не проверялось' }}</p>
          <p v-if="release.checkError">
            {{ release.checkError.message }} Последний успешный результат сохранён.
          </p>
          <p v-if="release.checkoutChanged">
            Checkout изменился после запуска.
            Примените локальные изменения, чтобы сервер использовал новый код.
          </p>
          <p>Интерфейс приложения обновляется установкой нового пакета.</p>
          <p v-if="release.job">
            {{ stageLabel }} · {{ release.job.kind === 'update' ? 'Релиз' : 'Локальный checkout' }} ·
            {{ shortSha(release.job.targetSha) }}
            <span v-if="release.job.error">{{ release.job.error.message }}</span>
          </p>
          <div class="settings-system-actions">
            <UiButton :disabled="updates.checking || updates.active || busy" @click="updates.check()">
              Проверить обновления
            </UiButton>
            <UiButton
              :disabled="!release.canApplyCheckout || updates.actionBusy || busy"
              @click="update('apply')"
            >
              Применить локальные изменения
            </UiButton>
            <UiButton
              v-if="release.latest"
              :disabled="!release.canInstallRelease || updates.actionBusy || busy"
              @click="update('update')"
            >
              Обновить до {{ release.latest.tag }}
            </UiButton>
          </div>
          <p v-for="reason in release.applyBlockReasons" :key="`apply:${reason}`">
            Локальное применение: {{ blockReasonLabel(reason) }}
          </p>
          <p v-for="reason in release.installBlockReasons" :key="`install:${reason}`">
            Установка релиза: {{ blockReasonLabel(reason) }}
          </p>
        </template>
        <p v-if="updates.error" role="alert">{{ updates.error }}</p>
      </SettingsSection>
      <SettingsSection v-if="!packageCapability" heading="Сборка интерфейса">
        <UiButton :disabled="busy || updates.active" @click="rebuild">Пересобрать web-бандл</UiButton>
        <p>
          Сборка из рабочего дерева включает незакоммиченные правки. Состояние задания перечитывается при
          возвращении на страницу.
        </p>
      </SettingsSection>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import SettingsSection from '../SettingsSection.vue';
import SettingsScope from '../SettingsScope.vue';
import { UiSwitch, UiButton, UiActionLink, confirmDialog } from '../../../ui.ts';
import { api, ApiError, failureText } from '../../../shared/apiClient.ts';
import { useSettingsStore } from '../../../stores/settings.ts';
import { useGrigDeskUpdateStore } from '../../../stores/grigdesk-update.js';
import { serverModeText } from '../serverMode.ts';
import { blockReasonLabel, UPDATE_STAGE_LABELS } from '../../../shared/grigdesk-update.js';
import { SETTINGS_FIELDS } from '../../../features/settings/catalog.ts';
import { createAutostartResource } from '../../../features/settings/resources/startup.ts';
import { sseSubscribe } from '../../../composables/useSse.ts';
import type { LauncherState } from '../../../../../shared/runtime/launcherContracts.ts';
import type { ReleaseStatus } from '../../../../../shared/runtime/grigDeskUpdateContracts.ts';
import SettingsField from '../SettingsField.vue';
import PackagedServerVersion from '../PackagedServerVersion.vue';

type ServerView = {
  mode?: string;
  systemd?: boolean;
  pid: number;
  uptimeSec: number;
};
type RebuildView = { status: string; error?: { message?: string } };

declare const __GRIGDESK_VERSION__: string;
declare const __GRIGDESK_SHA__: string;

const props = defineProps<{ active: boolean }>();
const settings = useSettingsStore();
const updates = useGrigDeskUpdateStore();
const server = ref<ServerView | null>(null);
const launcher = ref<LauncherState | null>(null);
const ready = ref(false);
const error = ref('');
const message = ref('');
const busy = ref(false);
const controller = new AbortController();
const opening = settings.snapshot.sessionId;
const startupFields = SETTINGS_FIELDS.filter((field) => field.resourceId === 'autostart');
const serverText = computed(() => serverModeText(server.value));
const release = computed(() => updates.status as ReleaseStatus | null);
const packageCapability = computed(() => {
  const capability = release.value?.updateCapability;

  return capability?.kind === 'package' ? capability : null;
});
const stageLabel = computed(() =>
  (UPDATE_STAGE_LABELS as Record<string, string>)[release.value?.job?.stage ?? '']
  || release.value?.job?.stage);
const buildVersion = typeof __GRIGDESK_VERSION__ === 'undefined' ? '—' : __GRIGDESK_VERSION__;
const buildSha = typeof __GRIGDESK_SHA__ === 'undefined' ? '' : __GRIGDESK_SHA__;
const autostartValue = computed(() => {
  settings.snapshot;

  return settings.getValue('autostart', 'enabled') === true;
});
const shortcutPresent = computed(() => launcher.value?.shortcut.desktop || launcher.value?.shortcut.menu);
const shortcutLabel = computed(() => launcher.value?.shortcut.desktop && launcher.value.shortcut.menu
  ? 'На рабочем столе и в меню приложений' : launcher.value?.shortcut.desktop ? 'На рабочем столе'
    : launcher.value?.shortcut.menu ? 'В меню приложений' : 'Не создан');
const uptime = computed(() => {
  const seconds = server.value?.uptimeSec ?? 0;

  return seconds >= 86400 ? `${Math.floor(seconds / 86400)} дн`
    : seconds >= 3600 ? `${Math.floor(seconds / 3600)} ч`
      : seconds >= 60 ? `${Math.floor(seconds / 60)} мин` : `${seconds} с`;
});
const autostartNote = computed(() => {
  const state = launcher.value?.autostart;

  if (!state || state.unit === 'missing') {
    return 'Юнит systemd не установлен. Автозапуск недоступен.';
  }
  if (state.unit === 'disabled') {
    return 'Автозапуск выключен. После перезагрузки сервер можно открыть ярлыком или вручную.';
  }

  return state.linger === true ? 'Сервер стартует при включении машины, до входа в систему.'
    : state.linger === false ? 'Только при входе в систему. Для старта раньше нужен loginctl enable-linger.'
      : 'Автозапуск включён; logind не сообщил, возможен ли старт до входа.';
});

function current(): boolean {
  return props.active && settings.isOpen && settings.snapshot.sessionId === opening
    && !controller.signal.aborted;
}

function shortSha(sha: string | null | undefined): string {
  return sha?.slice(0, 7) || '—';
}

/**
 * Таймер принадлежит странице и завершается немедленно при её размонтировании.
 * Ожидание не вызывает reload документа и не удерживает фоновую цепочку чтений.
 */
function pause(ms: number): Promise<boolean> {
  if (!current()) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const done = (value: boolean) => {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', abort);
      resolve(value);
    };
    const abort = () => done(false);
    const timer = setTimeout(() => done(current()), ms);

    controller.signal.addEventListener('abort', abort, { once: true });
  });
}

async function readServer(): Promise<void> {
  const view = await api.get('/api/system/server', { signal: controller.signal }) as ServerView;

  if (current()) {
    server.value = view;
  }
}

/**
 * Подтверждение получает актуальное число идущих ходов из общего API.
 * Сбой чтения сохраняет прежнюю совместимость ручной операции сервера.
 */
async function activeTurns(): Promise<number> {
  try {
    const result = await api.get('/api/chat/active', { signal: controller.signal }) as { active?: unknown[] };

    return result.active?.length ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Число активных ходов входит в подтверждение перед немедленной операцией.
 * Отказ или позднее согласие закрытой страницы не начинают запрос перезапуска.
 */
async function restart(): Promise<void> {
  if (!current() || busy.value) {
    return;
  }

  busy.value = true;

  try {
    const active = await activeTurns();
    const warning = active
      ? ` Сейчас идут ходы агентов: ${active}; незавершённая работа может прерваться.` : '';
    const text = `Перезапустить сервер GrigDesk? ${serverText.value.restartConfirm}${warning}`;
    const accepted = await confirmDialog(text, {
      danger: active > 0,
      okText: 'Перезапустить',
    });

    if (!accepted || !current()) {
      return;
    }

    try {
      await api.post('/api/system/restart');
    } catch (cause) {
      if (cause instanceof ApiError && cause.status < 500) {
        error.value = failureText(cause);

        return;
      }

      // После принятого POST сервер может уйти раньше доставки ответа.
      // Исход уточняется чтением доступности, повторного POST нет.
    }

    const deadline = Date.now() + 60000;

    while (current() && Date.now() < deadline && await pause(1000)) {
      try {
        await api.get('/api/auth/state', { signal: controller.signal });
        await readServer();
        message.value = 'Сервер снова доступен.';

        return;
      } catch {
        // Новое поколение ещё запускается; следующее чтение ограничено сроком ожидания.
      }
    }

    if (current()) {
      error.value = 'Сервер не вернулся за 60 секунд. Проверьте журнал сервера.';
    }
  } finally {
    busy.value = false;
  }
}

/**
 * Ярлык изменяется сразу и не меняет staged-состояние автозапуска.
 * Ответ обновляет только свой раздел снимка после подтверждённой операции.
 */
async function shortcut(): Promise<void> {
  if (busy.value || !launcher.value) {
    return;
  }

  busy.value = true;

  try {
    const result = await (shortcutPresent.value ? api.del('/api/system/launcher/shortcut')
      : api.post('/api/system/launcher/shortcut')) as { shortcut: LauncherState['shortcut'] };

    if (current()) {
      launcher.value = { ...launcher.value, shortcut: result.shortcut };
      message.value = 'Ярлык обновлён.';
    }
  } catch (cause) {
    error.value = failureText(cause);
  } finally {
    busy.value = false;
  }
}

/**
 * Общий update store сохраняет durable job и допуски checkout/release.
 * Подтверждение содержит точную цель; после ответа UI остаётся в том же документе.
 */
async function update(kind: 'apply' | 'update'): Promise<void> {
  const status = release.value;

  if (!status || packageCapability.value || busy.value || updates.actionBusy || !current()
      || (kind === 'apply' ? !status.canApplyCheckout : !status.canInstallRelease)) {
    return;
  }

  busy.value = true;

  try {
    const active = await activeTurns();
    const target = kind === 'apply' ? `текущий checkout ${status.checkout.branch || 'detached HEAD'} · `
      + shortSha(status.checkout.sha) : `релиз ${status.latest?.tag} · ${shortSha(status.latest?.sha)}`;
    const accepted = await confirmDialog(`Применить ${target}? GrigDesk ненадолго станет недоступен.`
      + (active ? ` Сейчас идут ходы агентов: ${active}; их работа может прерваться.` : ''), {
      danger: active > 0,
      okText: kind === 'apply' ? 'Применить checkout' : 'Обновить',
    });

    if (accepted && current()) {
      await (kind === 'apply' ? updates.applyCheckout() : updates.installRelease());
    }
  } finally {
    busy.value = false;
  }
}

/**
 * Пересборка и её опрос относятся к операции, а не к Apply параметров.
 * При возвращении на страницу running снова читается, server-owned job не отменяется.
 */
async function pollRebuild(): Promise<void> {
  const deadline = Date.now() + 12 * 60000;

  error.value = '';
  message.value = '';

  while (current() && Date.now() < deadline) {
    try {
      const result = await api.get('/api/system/web-rebuild', {
        signal: controller.signal,
        retry: false,
      }) as { rebuild?: RebuildView };

      if (!current()) {
        return;
      }
      if (result.rebuild?.status !== 'running') {
        message.value = result.rebuild?.status === 'done'
          ? 'Рабочая сборка готова. Интерфейс приложения обновляется установкой нового пакета.'
          : result.rebuild?.status === 'failed'
            ? result.rebuild.error?.message || 'Пересборка завершилась ошибкой.'
            : 'Нет выполняемой пересборки.';

        return;
      }
    } catch {
      // Краткий отказ чтения не отменяет серверную сборку и следующий опрос.
      // Срок всей операции ограничен независимо от количества неудачных GET.
    }

    if (!await pause(2000)) {
      return;
    }
  }

  if (current()) {
    error.value = 'Статус неизвестен: пересборка не подтвердила завершение за 12 минут. '
      + 'Проверьте журнал сервера.';
  }
}

/**
 * Пересборка требует отдельного согласия и не выполняется при другом действии сервера.
 * Отказ чтения или POST показывается в этой странице без перезагрузки рабочего документа.
 */
async function rebuild(): Promise<void> {
  if (packageCapability.value || busy.value || updates.active || !current()) {
    return;
  }

  busy.value = true;

  try {
    const accepted = await confirmDialog('Пересобрать web-бандл из текущего рабочего дерева? '
      + 'В сборку попадут и незакоммиченные правки.', { okText: 'Пересобрать' });

    if (accepted && current()) {
      await api.post('/api/system/web-rebuild');
      await pollRebuild();
    }
  } catch (cause) {
    error.value = failureText(cause);
  } finally {
    busy.value = false;
  }
}

/**
 * Страница читает только свою область; данные соседних разделов не загружаются заранее.
 * Автозапуск использует прежний адаптер этого открытия и его подтверждённый снимок.
 */
async function load(): Promise<void> {
  if (!current()) {
    return;
  }

  try {
    if (settings.pageId === 'system.startup') {
      await readServer();

      const resource = settings.sessionService('autostart-resource', () => createAutostartResource(api));

      settings.registerResource(resource.adapter, startupFields);
      await settings.loadResource('autostart');
      launcher.value = resource.view();
    } else {
      await updates.load();

      if (!packageCapability.value) {
        await pollRebuild();
      }
    }

    ready.value = true;
  } catch (cause) {
    if (current()) {
      error.value = failureText(cause);
    }
  }
}

const unsubscribe = sseSubscribe((name) => {
  if (current() && name === 'hello') {
    void readServer().catch(() => undefined);
  }
});

watch(() => settings.snapshot.lastResult, () => {
  const resource = settings.sessionService('autostart-resource', () => createAutostartResource(api));

  launcher.value = resource.view();
});
watch(() => release.value?.job?.status, (status) => {
  if (status === 'done' && current()) {
    void readServer().catch(() => undefined);
  }
});
watch(() => props.active, load, { immediate: true });
onBeforeUnmount(() => {
  controller.abort();
  unsubscribe();
});
</script>

<style scoped>
.settings-system {
  display: grid;
  gap: 28px;
  align-content: start;
  min-width: 0;
}
.settings-system p, .settings-system h4 {
  margin: 0;
}
.settings-system-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.settings-system-facts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
  width: 100%;
  margin: 0 0 4px;
}
.settings-system-facts > div {
  display: grid;
  gap: 7px;
  align-content: start;
}
.settings-system-facts dt {
  color: var(--ink-mid);
  font-size: 11px;
}
.settings-system-facts dd {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
}
.settings-autostart-note {
  display: grid;
  gap: 6px;
  color: var(--ink-mid);
  font-size: 11px;
  line-height: 1.6;
}
@media (max-width: 600px) {
  .settings-system-facts {
    grid-template-columns: minmax(0, 1fr);
    gap: 12px;
  }
  .settings-system-facts > div {
    grid-template-columns: 110px minmax(0, 1fr);
    gap: 12px;
  }
}
</style>

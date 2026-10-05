<template>
  <div class="access-overview">
    <div class="access-overview-head">
      <div>
        <h3 id="access-paths-title">Пути подключения</h3>
        <p>
          Это три отдельные точки входа. Изменение одной не переключает и не отключает остальные.
        </p>
      </div>
      <span class="independent-pill">Независимые способы</span>
    </div>

    <div class="access-route-grid" aria-labelledby="access-paths-title">
      <article class="access-route-card" data-testid="access-route-computer">
        <div class="access-route-head">
          <span class="access-route-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="4" width="18" height="13" rx="2" />
              <path d="M8 21h8M12 17v4" />
            </svg>
          </span>
          <span class="access-status ok"><i></i>Доступен на мозге</span>
        </div>
        <div class="access-route-copy">
          <span class="access-route-kicker">На самом мозге</span>
          <h4>Прямой вход на мозге</h4>
          <p>Этот адрес работает только в браузере, запущенном на машине-мозге.</p>
        </div>
        <code class="access-route-url">http://localhost:{{ httpPort }}</code>
        <p class="access-route-note">Соединение не выходит в сеть, поэтому браузер считает localhost защищённым.</p>
      </article>

      <article class="access-route-card" data-testid="access-route-home">
        <div class="access-route-head">
          <span class="access-route-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
              <path d="M5 11.5a10 10 0 0 1 14 0M8.5 15a5 5 0 0 1 7 0M12 19h.01" />
            </svg>
          </span>
          <span class="access-status" :class="localStatus.kind" role="status" aria-live="polite">
            <i></i>{{ localStatus.label }}
          </span>
        </div>
        <div class="access-route-copy">
          <span class="access-route-kicker">В домашней сети</span>
          <h4>Напрямую к мозгу</h4>
          <p>Планшет и рабочий компьютер заходят по локальному адресу машины.</p>
        </div>
        <code class="access-route-url" v-tooltip="localUrl">{{ localUrl }}</code>
        <div class="access-route-control">
          <UiSwitch
            :model-value="localControlOn"
            :disabled="localHttpsBusy || localHttpsManagedExternally || tlsState !== 'ready'"
            @update:model-value="emit('set-local-https', $event)"
          >{{ localHttpsManagedExternally
              ? 'HTTPS управляется системой'
              : 'Защищать подключение по HTTPS' }}</UiSwitch>
          <p>{{ localExplanation }}</p>
          <p
            v-if="localMessage"
            class="access-inline-message"
            :class="localMessage.type"
            :role="localMessage.type === 'err' ? 'alert' : 'status'"
            aria-live="polite"
          >
            {{ localMessage.text }}
          </p>
          <UiButton
            v-if="tlsState === 'error'"
            class="route-action"
            data-testid="tls-retry"
            @click="emit('reload-tls')"
          >
            Повторить проверку
          </UiButton>
          <UiDisclosureButton
            v-else-if="localDetailsAvailable"
            class="route-action"
            data-testid="local-details-toggle"
            :open="localDetailsOpen"
            controls="local-https-settings"
            @click="emit('toggle-details', 'local')"
          >
            {{ localDetailsOpen ? 'Скрыть настройки' : 'Сертификат и устройства' }}
          </UiDisclosureButton>
        </div>
      </article>

      <article class="access-route-card" data-testid="access-route-internet">
        <div class="access-route-head">
          <span class="access-route-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
            </svg>
          </span>
          <span class="access-status" :class="gatewayStatus.kind" role="status" aria-live="polite">
            <i></i>{{ gatewayStatus.label }}
          </span>
        </div>
        <div class="access-route-copy">
          <span class="access-route-kicker">Из интернета</span>
          <h4>Через VPS-шлюз</h4>
          <p>Публичный домен ведёт в отдельные обратные туннели кокпита и стендов.</p>
        </div>
        <code
          class="access-route-url"
          v-tooltip="`https://${gatewayDomain}`"
        >https://{{ gatewayDomain }}</code>
        <div class="access-route-control gateway-control">
          <UiDisclosureButton
            class="route-action"
            data-testid="gateway-details-toggle"
            :open="activeDetails === 'gateway'"
            controls="gateway-settings"
            :disabled="gatewayState === 'loading'"
            @click="emit('toggle-details', 'gateway')"
          >
            {{ gatewayAction }}
          </UiDisclosureButton>
          <p>
            <template v-if="gatewayJob?.state === 'running'">
              Настраиваем <code>{{ gatewayJob.domain }}</code>. Действующий внешний путь от этого пока не отключается.
            </template>

            <template v-else-if="gatewayJob?.state === 'failed'">
              Последняя настройка сорвалась. Ранее работавший внешний путь автоматически не отключался.
            </template>
            <template v-else-if="gatewayRestartPending">
              Новый домен <code>{{ desiredGatewayDomain }}</code> включится после перезапуска.
              <template v-if="gatewayPublicDomain">Сейчас активен <code>{{ gatewayPublicDomain }}</code>.</template>
            </template>
            <template v-else-if="gatewayState === 'loading'">
              Сверяем сохранённую установку с доменом, который использует сервер.
            </template>
            <template v-else-if="gatewayState === 'error'">
              Состояние шлюза не удалось прочитать<span v-if="gatewayError">: {{ gatewayError }}</span>.
            </template>
            <template v-else-if="gatewayVerified">
              Внешний путь проверен. Скрытие настроек не останавливает шлюз.
            </template>
            <template v-else-if="gatewayConfigured">
              Настройка сохранена, но доступность нужно проверить. Скрытие панели шлюз не останавливает.
            </template>
            <template v-else>
              Нужны VPS и домен. Домашний способ подключения останется как был.
            </template>
          </p>
        </div>
      </article>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { UiButton, UiDisclosureButton, UiSwitch, vTooltip } from '../../ui';

const props = defineProps({
  localHttpsEnabled: { type: Boolean, default: false },
  localHttpsBusy: { type: Boolean, default: false },
  localMessage: { type: Object, default: null },
  tls: { type: Object, default: null },
  tlsState: { type: String, default: 'ready' },
  tlsError: { type: String, default: '' },
  gatewaySetup: { type: Object, default: null },
  gatewayJob: { type: Object, default: null },
  gatewayPublicDomain: { type: String, default: '' },
  gatewayChecks: { type: Object, default: null },
  gatewayState: { type: String, default: 'ready' },
  gatewayError: { type: String, default: '' },
  activeDetails: { type: String, default: '' },
});

const emit = defineEmits(['set-local-https', 'reload-tls', 'toggle-details']);

const httpPort = computed(() => props.tls?.httpPort || 8140);
const httpsPort = computed(() => props.tls?.https?.port || 8143);
const localHttpsManagedExternally = computed(() => props.tls?.source === 'env');
const localControlOn = computed(() => localHttpsManagedExternally.value
  ? !!props.tls?.https?.up
  : props.localHttpsEnabled);
// Показываем текущий адрес интерфейса, а не первый SAN сертификата на диске: после
// смены сети старый SAN может быть недоступен, даже если сам HTTPS-сокет ещё жив.
const localAddress = computed(() => props.tls?.addresses?.[0]?.address
  || props.tls?.leaf?.addresses?.[0]
  || 'адрес-мозга');
const gatewayDomain = computed(() => props.gatewayPublicDomain
  || props.gatewaySetup?.domain
  || props.gatewayJob?.domain
  || 'ваш-домен');
const desiredGatewayDomain = computed(() => (props.gatewayJob?.state === 'done' ? props.gatewayJob.domain : '')
  || props.gatewaySetup?.domain
  || '');
// Домен сравнивается без регистра и без точки на конце: «Пример.RU.» и «пример.ru» —
// один и тот же адрес, и расхождение здесь читалось бы как «шлюз не настроен».
const normalizeDomain = (value: unknown): string => (
  String(value || '').trim().toLowerCase().replace(/\.$/, '')
);
const gatewayRestartPending = computed(() => {
  if (props.gatewayJob?.state === 'done' && props.gatewayJob.needsRestart) return true;
  const desired = normalizeDomain(desiredGatewayDomain.value);
  if (!desired) return false;
  return desired !== normalizeDomain(props.gatewayPublicDomain);
});
const gatewayConfigured = computed(() => !!(props.gatewaySetup || props.gatewayPublicDomain));
const gatewayCheckMatches = computed(() => {
  const checked = normalizeDomain(props.gatewayChecks?.domain);
  if (!checked || checked !== normalizeDomain(gatewayDomain.value)) return false;
  const configuredGateway = String(props.gatewaySetup?.gateway || '').trim();
  if (!configuredGateway) return true;
  return String(props.gatewayChecks?.gateway || '').trim() === configuredGateway;
});
const gatewayJobVerifyStep = computed(() => props.gatewayJob?.steps
  ?.find((step: { key?: string }) => step.key === 'verify') || null);
const gatewayJobMatches = computed(() => normalizeDomain(props.gatewayJob?.domain)
  === normalizeDomain(gatewayDomain.value));
const gatewayVerified = computed(() => (
  gatewayCheckMatches.value && props.gatewayChecks?.ok
) || (
  props.gatewayJob?.state === 'done'
  && gatewayJobMatches.value
  && gatewayJobVerifyStep.value?.state === 'ok'
));
const gatewayHasRemarks = computed(() => (
  gatewayCheckMatches.value && props.gatewayChecks && !props.gatewayChecks.ok
) || (
  props.gatewayJob?.state === 'done'
  && gatewayJobMatches.value
  && gatewayJobVerifyStep.value?.state === 'fail'
));

const localStatus = computed(() => {
  const tls = props.tls;
  if (props.tlsState === 'loading') return { kind: 'idle', label: 'Проверяем…' };
  if (props.tlsState === 'error') return { kind: 'danger', label: 'Статус недоступен' };
  if (!tls) return { kind: 'danger', label: 'Нет данных' };
  if (tls.source === 'env') {
    return tls.https?.up
      ? { kind: 'ok', label: 'HTTPS задан системой' }
      : { kind: 'danger', label: 'Системный HTTPS не поднялся' };
  }
  if (!props.localHttpsEnabled) {
    if (tls.https?.up) return { kind: 'warn', label: 'Отключится после рестарта' };
    return { kind: 'off', label: 'HTTP без шифрования' };
  }
  if (tls.https?.error) return { kind: 'danger', label: 'HTTPS не поднялся' };
  if (!tls.leaf?.exists) return { kind: 'warn', label: 'Нужен сертификат' };
  if (tls.missingAddresses?.length) return { kind: 'warn', label: 'Адрес не в сертификате' };
  if (tls.needsRestart) return { kind: 'warn', label: 'Нужен перезапуск' };
  if (tls.https?.up) return { kind: 'ok', label: 'HTTPS работает' };
  return { kind: 'danger', label: 'HTTPS не поднялся' };
});

const localUrl = computed(() => {
  if (props.tlsState === 'loading') return 'проверяем адрес…';
  if (props.tlsState === 'error') return 'адрес не удалось определить';
  if (props.tls?.source === 'env' && props.tls?.https?.up) {
    return 'HTTPS · адрес задаётся системой';
  }
  if (props.tls?.https?.up) return `https://${localAddress.value}:${httpsPort.value}`;
  return `http://${localAddress.value}:${httpPort.value}`;
});

const localExplanation = computed(() => {
  if (props.tlsState === 'loading') return 'Сверяем настройку с фактически поднятым сокетом.';
  if (props.tlsState === 'error') {
    return `Состояние HTTPS не удалось прочитать${props.tlsError ? `: ${props.tlsError}` : ''}.`;
  }
  if (props.tls?.source === 'env') {
    return props.tls?.https?.up
      ? 'Сертификат задан на уровне системы. Переключатель Cockpit его не отключает.'
      : 'Системный HTTPS настроен, но не поднялся. Исправить его можно только в конфигурации сервера.';
  }
  if (props.localHttpsEnabled) {
    return 'После настройки сетевой HTTP перенаправляется на HTTPS. Внешний шлюз от этого не меняется.';
  }

  return `Доступ дома остаётся по HTTP :${httpPort.value}. Сертификаты сохраняются,`
    + ' внешний шлюз не меняется.';
});

const gatewayStatus = computed(() => {
  if (props.gatewayJob?.state === 'running') return { kind: 'warn', label: 'Настройка идёт' };
  if (props.gatewayJob?.state === 'failed') return { kind: 'danger', label: 'Настройка сорвалась' };
  if (gatewayRestartPending.value) return { kind: 'warn', label: 'Нужен перезапуск' };
  if (props.gatewayState === 'loading') return { kind: 'idle', label: 'Проверяем…' };
  if (props.gatewayState === 'error') return { kind: 'danger', label: 'Статус недоступен' };
  if (gatewayVerified.value) return { kind: 'ok', label: 'Связь проверена' };
  if (gatewayHasRemarks.value) return { kind: 'warn', label: 'Есть замечания' };
  if (gatewayConfigured.value) return { kind: 'warn', label: 'Не проверен' };
  return { kind: 'off', label: 'Не настроен' };
});

const gatewayAction = computed(() => {
  if (props.activeDetails === 'gateway') return 'Скрыть настройки';
  if (props.gatewayState === 'loading') return 'Проверяем состояние…';
  if (props.gatewayState === 'error') return 'Повторить и открыть';
  return gatewayConfigured.value ? 'Управление и проверка' : 'Настроить шлюз';
});
const localDetailsOpen = computed(() => props.activeDetails === 'local');
const localDetailsAvailable = computed(() => props.tlsState === 'ready'
  && !localHttpsManagedExternally.value
  && !!(props.localHttpsEnabled || props.tls?.leaf?.exists || props.tls?.ca?.exists));
</script>

<style scoped>
.access-overview { container-type: inline-size; display: grid; gap: 12px; }
.access-overview-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
}
.access-overview-head h3 { margin: 0; font-size: 14px; font-weight: 660; }
.access-overview-head p { max-width: 650px; margin: 5px 0 0; color: var(--ink-mid); font-size: 12.5px; line-height: 1.5; }
.independent-pill {
  flex: none;
  padding: 4px 9px;
  border: 1px solid color-mix(in srgb, var(--accent) 34%, var(--line));
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent) 8%, var(--ground));
  color: var(--accent);
  font-size: 10.5px;
  white-space: nowrap;
}
.access-route-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr)); gap: 10px; }
.access-route-card {
  min-width: 0;
  min-height: 286px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 15px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background:
    radial-gradient(circle at 0 0, color-mix(in srgb, var(--accent) 8%, transparent), transparent 36%),
    linear-gradient(180deg, color-mix(in srgb, var(--surface) 96%, #fff), var(--surface));
  box-shadow: inset 0 1px 0 #ffffff08;
}
.access-route-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.access-route-icon {
  flex: none;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border: 1px solid color-mix(in srgb, var(--accent) 28%, var(--line));
  border-radius: 10px;
  background: color-mix(in srgb, var(--accent) 8%, var(--ground));
  color: var(--accent);
}
.access-route-icon svg { width: 18px; height: 18px; }
.access-status {
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 7px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--ground);
  color: var(--ink-mid);
  font-size: 10px;
  line-height: 1.25;
  text-align: right;
}
.access-status i { flex: none; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.access-status.ok { border-color: color-mix(in srgb, var(--good) 34%, var(--line)); color: var(--good); }
.access-status.warn { border-color: color-mix(in srgb, var(--warn) 38%, var(--line)); color: var(--warn); }
.access-status.danger { border-color: color-mix(in srgb, var(--bad) 38%, var(--line)); color: var(--bad); }
.access-status.off, .access-status.idle { color: var(--ink-mid); }
.access-route-copy { display: grid; gap: 4px; }
.access-route-kicker {
  color: var(--accent);
  font-size: 10px;
  font-weight: 720;
  letter-spacing: .065em;
  text-transform: uppercase;
}
.access-route-copy h4 { margin: 0; color: var(--ink); font-size: 14px; font-weight: 660; letter-spacing: -.01em; }
.access-route-copy p, .access-route-note, .access-route-control p {
  margin: 0;
  color: var(--ink-mid);
  font-size: 11.5px;
  line-height: 1.45;
}
.access-route-control .access-inline-message.ok { color: var(--good); }
.access-route-control .access-inline-message.warn { color: var(--warn); }
.access-route-control .access-inline-message.err { color: var(--bad); }
.access-route-url {
  width: 100%;
  box-sizing: border-box;
  overflow-wrap: anywhere;
  padding: 7px 8px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--ground);
  color: var(--ink);
  font-size: 11px;
  white-space: normal;
}
.access-route-note, .access-route-control { margin-top: auto; }
.access-route-control {
  display: grid;
  gap: 4px;
  padding-top: 11px;
  border-top: 1px solid var(--line);
}
.access-route-control > :first-child { justify-self: start; }
.gateway-control { gap: 7px; }
.route-action {
  justify-self: start;
}

@container (min-width: 530px) and (max-width: 799px) {
  .access-route-card:last-child { grid-column: 1 / -1; }
}

@media (max-width: 759px) {
  .access-overview-head { align-items: flex-start; flex-direction: column; gap: 8px; }
  .access-route-grid { grid-template-columns: minmax(0, 1fr); }
  .access-route-card { min-height: 0; }
  .access-route-note, .access-route-control { margin-top: 0; }
}
</style>

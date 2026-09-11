<template>
  <div class="showcase-create">
    <div
      v-if="!loaded && (loading || !error)"
      class="showcase-create__blocked"
      role="status"
    >
      <span class="showcase-create__blocked-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
          <rect x="3.5" y="4.5" width="17" height="12" rx="2" />
          <path d="M8 20h8 M12 16.5V20" />
        </svg>
      </span>
      <div class="showcase-create__blocked-copy">
        <strong>Ищем доступные стенды…</strong>
        <p>Постоянные стенды и поднятые песочницы появятся здесь автоматически.</p>
      </div>
    </div>

    <div v-else-if="!loaded" class="showcase-create__blocked" role="status">
      <span class="showcase-create__blocked-mark" aria-hidden="true">!</span>
      <div class="showcase-create__blocked-copy">
        <strong>Не удалось загрузить стенды</strong>
        <p>Проверьте сообщение выше и нажмите «Обновить», чтобы повторить.</p>
      </div>
    </div>

    <div v-else-if="!readyTargets.length" class="showcase-create__blocked">
      <span class="showcase-create__blocked-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
          <rect x="3.5" y="4.5" width="17" height="12" rx="2" />
          <path d="M8 20h8 M12 16.5V20" />
        </svg>
      </span>
      <div class="showcase-create__blocked-copy" role="status">
        <strong>
          {{ targets.length ? 'Стенды сейчас недоступны' : 'Нет стендов для записи' }}
        </strong>
        <p>
          Запустите постоянный стенд или поднимите песочницу — вводить адрес и номер
          вручную не понадобится.
        </p>
        <ul v-if="blockedTargets.length" class="showcase-create__unavailable">
          <li v-for="target in blockedTargets" :key="choiceKey(target)">
            <strong>{{ target.label }}</strong>
            <span>{{ target.reason || 'Цель сейчас недоступна.' }}</span>
          </li>
        </ul>
      </div>
      <UiActionLink href="#/sandboxes" variant="outline">
        Открыть песочницы
      </UiActionLink>
    </div>

    <form v-else class="showcase-create__form" @submit.prevent="submit">
      <div class="showcase-create__fields">
        <UiField label="Где снимать" hint="Только известные Cockpit стенды.">
          <UiSelect
            v-model="targetKey"
            data-testid="showcase-create-target"
            :disabled="busy"
          >
            <option value="" disabled>Выберите стенд</option>
            <optgroup v-if="projectTargets.length" label="Постоянные стенды">
              <option
                v-for="target in projectTargets"
                :key="choiceKey(target)"
                :value="choiceKey(target)"
                :disabled="target.status !== 'ready'"
              >
                {{ optionLabel(target) }}
              </option>
            </optgroup>
            <optgroup v-if="sandboxTargets.length" label="Песочницы">
              <option
                v-for="target in sandboxTargets"
                :key="choiceKey(target)"
                :value="choiceKey(target)"
                :disabled="target.status !== 'ready'"
              >
                {{ optionLabel(target) }}
              </option>
            </optgroup>
          </UiSelect>
        </UiField>
      </div>

      <div v-if="selectedTarget" class="showcase-create__target">
        <span class="showcase-create__target-dot" aria-hidden="true"></span>
        <div class="showcase-create__target-copy">
          <strong>{{ selectedTarget.label }}</strong>
        </div>
        <UiActionLink
          v-if="selectedTargetUrl"
          class="showcase-create__target-link"
          :href="selectedTargetUrl"
          variant="ghost"
          target="_blank"
          rel="noopener noreferrer"
        >
          Открыть стенд <span aria-hidden="true">↗</span>
        </UiActionLink>
        <span
          class="showcase-create__screens"
          :data-empty="selectedTarget.screenCount === 0 ? 'yes' : 'no'"
        >
          {{ selectedTarget.screenCount
            ? `Экранов: ${selectedTarget.screenCount}`
            : 'Только начальный экран' }}
        </span>
      </div>

      <UiInlineMessage
        v-if="selectedTarget?.screenCount === 0"
        tone="warning"
        data-testid="showcase-create-screens-warning"
      >
        <template v-if="selectedTarget.profileBinding === 'inferred'">
          Привязка профиля к песочнице не подтверждена. Можно безопасно записать
          начальный экран; вход, переходы, действия и подготовка данных отключены.
        </template>
        <template v-else>
          Карта экранов не настроена. Можно записать начальный экран; переходы и
          автоматические действия пока недоступны.
        </template>
      </UiInlineMessage>

      <div
        v-if="blockedTargets.length"
        class="showcase-create__unavailable-note"
        role="status"
      >
        <strong>Сейчас недоступны:</strong>
        <span>{{ blockedSummary }}</span>
      </div>

      <div class="showcase-create__footer">
        <div class="showcase-create__note">
          <span aria-hidden="true">✓</span>
          <p>Адрес и профиль Cockpit подставляет сам и перепроверяет перед записью.</p>
        </div>
        <div class="showcase-create__footer-actions">
          <UiActionLink href="#/sandboxes" variant="ghost">Открыть песочницы</UiActionLink>
          <UiButton
            type="submit"
            variant="solid"
            tone="accent"
            :loading="busy"
            :aria-disabled="!canSubmit"
          >
            Далее
          </UiButton>
        </div>
      </div>
    </form>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import {
  UiActionLink,
  UiButton,
  UiField,
  UiInlineMessage,
  UiSelect,
} from '../../ui';
import { sandboxUrl } from '../../shared/sandbox.js';
import type {
  ShowcaseOverview,
  ShowcaseSelectableTargetRef,
} from '../../../../shared/showcaseContracts';

type TargetChoice = ShowcaseOverview['targets'][number];

const props = defineProps<{
  targets: ShowcaseOverview['targets'];
  busy: boolean;
  loaded: boolean;
  loading: boolean;
  error: string;
}>();

interface CreatePayload {
  ref: ShowcaseSelectableTargetRef;
}

const emit = defineEmits<{
  create: [payload: CreatePayload];
}>();

const targetKey = ref('');

const supportedTargets = computed(() => props.targets.filter((target) => (
  target.ref.kind === 'project' || target.ref.kind === 'sandbox'
)));
const readyTargets = computed(() => (
  supportedTargets.value.filter((target) => target.status === 'ready')
));
const blockedTargets = computed(() => (
  supportedTargets.value.filter((target) => target.status === 'blocked')
));
const blockedSummary = computed(() => blockedTargets.value.map((target) => (
  `${target.label} — ${target.reason || 'нет связи'}`
)).join('; '));
const projectTargets = computed(() => (
  supportedTargets.value.filter((target) => target.ref.kind === 'project')
));
const sandboxTargets = computed(() => (
  supportedTargets.value.filter((target) => target.ref.kind === 'sandbox')
));
const selectedTarget = computed(() => (
  supportedTargets.value.find((target) => choiceKey(target) === targetKey.value) ?? null
));
const selectedTargetUrl = computed(() => {
  const target = selectedTarget.value;

  if (!target) {
    return null;
  }

  return target.ref.kind === 'sandbox'
    ? sandboxUrl(target.viewPort)
    : target.viewUrl;
});
const canSubmit = computed(() => (
  !props.busy && selectedTarget.value?.status === 'ready'
));

function choiceKey(target: TargetChoice): string {
  return `${target.ref.kind}:${target.ref.id}`;
}

function optionLabel(target: TargetChoice): string {
  return target.status === 'ready' || !target.reason
    ? target.label
    : `${target.label} — ${target.reason}`;
}

// Первая доступная цель подставляется сама: профиль и адрес уже определил сервер,
// поэтому дополнительного решения от человека здесь нет. Исчезнувший стенд
// снимает старый выбор, чтобы форма не отправила ссылку на прежнюю песочницу.
watch(supportedTargets, (targets) => {
  const selectedIsReady = targets.some((target) => (
    target.status === 'ready' && choiceKey(target) === targetKey.value
  ));

  if (!selectedIsReady) {
    const first = targets.find((target) => target.status === 'ready');

    targetKey.value = first ? choiceKey(first) : '';
  }
}, { immediate: true });

// В запрос уходит только выбранная ссылка из доверенного обзора. Профиль, адрес и
// состояние стенда сервер выводит заново, поэтому устаревшие данные формы не могут
// перенаправить запись на произвольный URL.
function submit() {
  const target = selectedTarget.value;

  if (!canSubmit.value || !target) {
    return;
  }

  emit('create', { ref: { ...target.ref } });
}
</script>

<style scoped>
.showcase-create {
  min-width: 0;
}

.showcase-create__form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.showcase-create__fields {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 14px;
  min-width: 0;
}

.showcase-create__target {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: color-mix(in srgb, var(--ground) 52%, transparent);
}

.showcase-create__target-dot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 50%;
  background: var(--good);
}

.showcase-create__target-copy {
  display: flex;
  flex: 1 1 auto;
  align-items: baseline;
  gap: 7px;
  min-width: 0;
}

.showcase-create__target-copy strong {
  overflow: hidden;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.showcase-create__screens {
  color: var(--ink-mid);
  font-size: 11.5px;
}

.showcase-create__target-link {
  flex: none;
}

.showcase-create__screens {
  flex: none;
  padding: 2px 7px;
  border: 1px solid color-mix(in srgb, var(--good) 34%, var(--line));
  border-radius: 999px;
  color: var(--good);
}

.showcase-create__screens[data-empty='yes'] {
  border-color: color-mix(in srgb, var(--warn) 38%, var(--line));
  color: var(--warn);
}

.showcase-create__unavailable-note {
  display: flex;
  align-items: baseline;
  gap: 6px;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.45;
}

.showcase-create__unavailable-note strong {
  flex: none;
  color: var(--ink);
  font-size: inherit;
}

.showcase-create__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  flex-wrap: wrap;
  padding-top: 14px;
  border-top: 1px solid var(--line);
}

.showcase-create__footer-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.showcase-create__note {
  display: flex;
  flex: 1 1 390px;
  align-items: flex-start;
  gap: 9px;
  min-width: 0;
}

.showcase-create__note > span {
  display: grid;
  flex: none;
  width: 20px;
  height: 20px;
  place-items: center;
  border-radius: 50%;
  background: color-mix(in srgb, var(--good) 13%, var(--surface-2));
  color: var(--good);
  font-size: 11px;
  font-weight: 800;
}

.showcase-create__note p {
  margin: 0;
  min-width: 0;
  color: var(--ink-mid);
  font-size: 12.5px;
  line-height: 1.5;
}

.showcase-create__blocked {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 13px 14px;
  border: 1px solid var(--line);
  border-radius: 11px;
  background: color-mix(in srgb, var(--accent) 3%, var(--surface-2));
}

.showcase-create__blocked-mark {
  display: grid;
  flex: none;
  width: 36px;
  height: 36px;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--accent) 34%, var(--line));
  border-radius: 10px;
  background: color-mix(in srgb, var(--accent) 8%, var(--surface));
  color: var(--accent);
}

.showcase-create__blocked-mark svg {
  width: 18px;
  height: 18px;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.showcase-create__blocked-copy {
  flex: 1 1 auto;
  min-width: 0;
}

.showcase-create__blocked-copy strong {
  font-size: 14px;
}

.showcase-create__blocked-copy p {
  max-width: 680px;
  margin: 4px 0 0;
  color: var(--ink-mid);
  font-size: 12.5px;
  line-height: 1.5;
}

.showcase-create__unavailable {
  display: grid;
  gap: 5px;
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
}

.showcase-create__unavailable li {
  display: flex;
  align-items: baseline;
  gap: 6px;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.4;
}

.showcase-create__unavailable li strong {
  flex: none;
  color: var(--ink);
  font-size: inherit;
}

@media (max-width: 720px) {
  .showcase-create__fields {
    grid-template-columns: minmax(0, 1fr);
  }

  .showcase-create__target {
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .showcase-create__target-copy {
    flex-basis: calc(100% - 20px);
  }

  .showcase-create__target-link {
    margin-left: 17px;
  }

  .showcase-create__blocked {
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .showcase-create__blocked > :last-child:not(:nth-child(2)) {
    margin-left: 48px;
  }

  .showcase-create__unavailable-note,
  .showcase-create__unavailable li {
    align-items: flex-start;
    flex-direction: column;
    gap: 2px;
  }
}

@media (max-width: 480px) {
  .showcase-create__target-copy {
    align-items: flex-start;
    flex-direction: column;
    gap: 2px;
  }

  .showcase-create__screens {
    margin-left: 17px;
  }
}
</style>

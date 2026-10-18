<template>
  <section class="sandboxes ui-page" aria-labelledby="sandboxes-title">
    <header class="sandboxes__head ui-page-head">
      <div class="sandboxes__intro">
        <h1 id="sandboxes-title">Песочницы</h1>
        <p>Стенды задач для проверки и ручной работы.</p>
      </div>
      <UiButton v-if="store.manualSandboxes.length" tone="accent" @click="createOpen = !createOpen">
        {{ createOpen ? 'Скрыть создание' : 'Поднять стенд' }}
      </UiButton>
      <UiButton
        class="sandboxes__refresh"
        variant="ghost"
        :loading="store.loading"
        @click="loadSandboxes()"
      >
        Обновить
      </UiButton>
    </header>

    <UiInlineMessage v-if="store.error" tone="danger">{{ store.error }}</UiInlineMessage>

    <section v-show="createOpen || !store.manualSandboxes.length" class="sandboxes__panel" aria-labelledby="sandboxes-raise-title">
      <h2 id="sandboxes-raise-title" class="sandboxes__panel-title">Поднять стенд</h2>
      <SandboxRaiseForm
        :options="store.capableProfiles"
        :range="store.manualRange"
        :busy="raising"
        @raise="raise"
      />
    </section>

    <section class="sandboxes__block" aria-labelledby="sandboxes-manual-title">
      <div class="sandboxes__block-head">
        <h2 id="sandboxes-manual-title">Ручные стенды</h2>
        <span v-if="store.manualSandboxes.length" class="sandboxes__count">
          {{ store.manualSandboxes.length }}
        </span>
      </div>

      <div v-if="!store.manualSandboxes.length" class="sandboxes__empty">
        <strong>{{ store.loaded ? 'Ни одного стенда не поднято' : 'Читаем состояние…' }}</strong>
        <p v-if="store.loaded">
          Поднятый отсюда стенд встанет сюда: с адресами фронта и API, ветками worktree
          и кнопкой сноса.
        </p>
      </div>
      <div v-else class="sandboxes__list">
        <SandboxCard
          v-for="entry in store.manualSandboxes"
          :key="entry.task"
          :entry="entry"
          :job="store.jobOf(entry.task)"
          :busy="store.isBusy(entry.task)"
          @dismantle="dismantle"
          @run="run"
        />
      </div>
    </section>

    <section
      v-if="store.orphanJobs.length"
      class="sandboxes__block"
      aria-labelledby="sandboxes-jobs-title"
    >
      <div class="sandboxes__block-head">
        <h2 id="sandboxes-jobs-title">Недавние задания</h2>
      </div>
      <p class="sandboxes__note">Стендов этих заданий в реестре уже нет — остался их итог.</p>

      <ul class="sandboxes__jobs">
        <li v-for="job in store.orphanJobs" :key="job.task">
          <span class="sandboxes__job-dot" :data-state="job.state" aria-hidden="true"></span>
          <strong>t{{ job.task }}</strong>
          <span class="sandboxes__job-state">
            {{ jobKind(job) }} · {{ jobState(job) }}
          </span>
          <span v-if="job.message" class="sandboxes__job-message">{{ job.message }}</span>
        </li>
      </ul>
    </section>

    <section
      v-if="store.pipelineSandboxes.length"
      class="sandboxes__block"
      aria-labelledby="sandboxes-pipeline-title"
    >
      <div class="sandboxes__block-head">
        <h2 id="sandboxes-pipeline-title">Стенды конвейера</h2>
        <span class="sandboxes__count">{{ store.pipelineSandboxes.length }}</span>
      </div>
      <p class="sandboxes__note">
        Их жизненным циклом владеет попытка движка; действия профиля на них доступны.
      </p>

      <div class="sandboxes__list">
        <SandboxCard
          v-for="entry in store.pipelineSandboxes"
          :key="entry.task"
          :entry="entry"
          :job="store.jobOf(entry.task)"
          :busy="store.isBusy(entry.task)"
          @dismantle="dismantle"
          @run="run"
        />
      </div>
    </section>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import {
  UiButton, UiInlineMessage, confirmDialog, promptDialog,
} from '../ui';
import {
  dismantleSandbox,
  loadSandboxes,
  raiseSandbox,
  runSandboxAction,
  useSandboxesStore,
  watchSandboxes,
} from '../actions/sandboxes';
import type { SandboxActionDecl, SandboxJob } from '../../../shared/plugins/sandboxes/sandboxContracts';
import SandboxCard from './sandboxes/SandboxCard.vue';
import SandboxRaiseForm from './sandboxes/SandboxRaiseForm.vue';

const store = useSandboxesStore();
const raising = ref(false);
const createOpen = ref(false);

onMounted(() => {
  watchSandboxes();
  void loadSandboxes();
});

/**
 * Род задания словами: подъём, снос или прогон — подписью действия из манифеста
 * профиля, чтобы в списке недавних заданий было видно, ЧТО именно гоняли.
 */
function jobKind(job: SandboxJob) {
  if (job.action === 'run') {
    return job.actionLabel || 'прогон';
  }

  return job.action === 'up' ? 'подъём' : 'снос';
}

// Состояние задания словами: у стенда, которого уже нет в реестре, это единственное,
// что остаётся человеку от подъёма или сноса.
function jobState(job: SandboxJob) {
  if (job.state === 'running') {
    return 'идёт';
  }

  return job.state === 'done' ? 'выполнено' : 'отказ';
}

/**
 * Подъём подтверждается человеком: он занимает слот стенда и четверть часа, а
 * скрипт профиля создаёт контейнеры и схемы данных. Отказ показывает сам стор.
 */
async function raise(payload: { profile: string; task: string | null }) {
  const target = payload.task ? `задачи ${payload.task}` : 'без задачи (служебный номер)';
  const accepted = await confirmDialog(
    `Поднять песочницу профиля «${payload.profile}» ${target}?\n\n`
      + 'Скрипт профиля создаст worktree, контейнеры и свои схемы данных. '
      + 'Обычно это 12–15 минут и один занятый слот стенда.',
    {
      title: 'Подъём песочницы',
      okText: 'Поднять',
    },
  );

  if (!accepted) {
    return;
  }

  raising.value = true;

  try {
    await raiseSandbox(payload.profile, payload.task);
  } finally {
    raising.value = false;
  }
}

/**
 * Снос необратим для инфраструктуры, поэтому спрашиваем всегда, а разницу двух
 * кнопок проговариваем прямо в вопросе: обычный снос оставляет незакоммиченное,
 * второй забирает worktree вместе с ним (профиль снимает патч в архив).
 */
async function dismantle(payload: { task: string; force: boolean }) {
  const accepted = await confirmDialog(
    `Снести стенд t${payload.task}?\n\n`
      + (payload.force
        ? 'Worktree будет удалён вместе с незакоммиченными изменениями — профиль сохранит их патчем в архив.'
        : 'Контейнеры и схемы данных будут удалены. Незакоммиченное в worktree сохраняется: '
          + 'скрипт профиля оставит каталог и предупредит об этом.'),
    {
      title: 'Снос стенда',
      okText: 'Снести',
      danger: true,
    },
  );

  if (!accepted) {
    return;
  }

  await dismantleSandbox(payload.task, payload.force);
}

/**
 * Прогон профиля: аргументы спрашиваются по одному в порядке объявления, а сам
 * запуск подтверждается словами профиля — он гоняет стенд по-настоящему (очереди,
 * лимиты, публикация), и что именно произойдёт, знает только его описание.
 */
async function run(payload: { task: string; action: SandboxActionDecl }) {
  const { task, action } = payload;
  const args: Record<string, string> = {};

  for (const arg of action.args) {
    const answer = await promptDialog({
      title: `${action.label} — стенд t${task}`,
      text: arg.hint ? `${arg.label}. ${arg.hint}` : arg.label,
      placeholder: arg.type === 'number' ? 'целое число' : '',
      okText: 'Дальше',
    });

    if (answer === null) {
      return;
    }

    if (!answer.trim() && arg.required) {
      return;
    }

    args[arg.key] = answer.trim();
  }

  const accepted = await confirmDialog(
    `${action.label} на стенде t${task}?\n\n${action.confirm || action.description}`,
    {
      title: 'Прогон на стенде',
      okText: 'Запустить',
    },
  );

  if (!accepted) {
    return;
  }

  await runSandboxAction(task, action.id, args);
}
</script>

<style scoped>
.sandboxes {
  display: flex;
  flex-direction: column;
  gap: 24px;
  min-width: 0;
  margin-inline: auto;
}

.sandboxes__head {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px 16px;
}

.sandboxes__intro {
  flex: 1 1 320px;
}

.sandboxes__refresh {
  flex: none;
}

.sandboxes__head h1 {
  margin: 0 0 6px;
  font-size: 22px;
}

.sandboxes__intro p {
  margin: 0;
  max-width: 620px;
  color: var(--ink-mid);
  font-size: 13px;
  line-height: 1.5;
}

/* Подъём — единственное действие раздела, поэтому его форма собрана в карточку. */
.sandboxes__panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow);
}

.sandboxes__panel-title {
  margin: 0;
  font-size: 15px;
  font-weight: 650;
}

.sandboxes__block {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.sandboxes__block-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sandboxes__block-head h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 650;
}

.sandboxes__count {
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--ink-mid);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}

.sandboxes__note {
  margin: -6px 0 0;
  color: var(--ink-mid);
  font-size: 12.5px;
}

.sandboxes__list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.sandboxes__empty {
  padding: 28px 20px;
  border: 1px dashed var(--line-2);
  border-radius: var(--radius);
  text-align: center;
}

.sandboxes__empty strong {
  font-size: 14px;
}

.sandboxes__empty p {
  margin: 8px auto 0;
  max-width: 460px;
  color: var(--ink-mid);
  font-size: 13px;
  line-height: 1.5;
}

.sandboxes__jobs {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  list-style: none;
  font-size: 13px;
}

.sandboxes__jobs li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  padding: 10px 14px;
}

.sandboxes__jobs li + li {
  border-top: 1px solid var(--line);
}

.sandboxes__job-dot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 50%;
  background: var(--accent);
}

.sandboxes__job-dot[data-state='done'] {
  background: var(--good);
}

.sandboxes__job-dot[data-state='failed'] {
  background: var(--bad);
}

.sandboxes__job-state,
.sandboxes__job-message {
  color: var(--ink-mid);
  font-size: 12px;
}

.sandboxes__job-message {
  flex: 1;
  min-width: 0;
  text-align: right;
}
</style>

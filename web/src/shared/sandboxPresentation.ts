import type { SandboxEntry, SandboxJob } from '../../../shared/plugins/sandboxes/sandboxContracts.ts';
import { pipelineTopbarItems } from './pipelineNavBadge.ts';
import type { SandboxPipelineSnapshot } from './sandboxPipelineSnapshot.ts';
import { localeTranslator } from '../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from './uiLocalePort.ts';

const t = localeTranslator(uiLocalePort);


export type SandboxCategory = 'running' | 'waiting' | 'error' | 'manual' | 'inactive' | 'unknown';

export interface SandboxRow {
  task: string;
  profile: string | null;
  entry: SandboxEntry | null;
  job: SandboxJob | null;
  title: string;
  category: SandboxCategory;
  stateLabel: string;
  detail: string;
  step: string;
  age: {
    label: string;
    hint: string;
    old: boolean;
  };
}

export const SANDBOX_STATES = [
  { value: 'all', get label() {
    return t('core.sandboxVseStendy');
  } },
  { value: 'running', get label() {
    return t('core.sandboxIdetRabota');
  } },
  { value: 'waiting', get label() {
    return t('core.awaitingDecision2');
  } },
  { value: 'error', get label() {
    return t('core.stalled');
  } },
  { value: 'manual', get label() {
    return t('core.sandboxRuchnyeStendy');
  } },
  { value: 'inactive', get label() {
    return t('core.sandboxNeaktiven');
  } },
  { value: 'unknown', get label() {
    return t('settings.unknownStatus');
  } },
  { value: 'pipeline', get label() {
    return t('core.sandboxVseKonveyernye');
  } },
];

const DAY = 24 * 60 * 60 * 1000;
export const NO_PROFILE = '__without_profile__';

/**
 * Возраст относится к текущему подъёму только при подтверждённой привязке профиля.
 * Остальные записи дают явно приблизительную оценку, а прогоны её не обнуляют.
 */
function standAge(entry: SandboxEntry | null, job: SandboxJob | null, now: number) {
  const upTime = job?.startedAt ? Date.parse(job.startedAt) : NaN;
  const exact = !entry || (entry.profileBinding === 'verified' && job?.action === 'up'
    && job.state === 'done' && Boolean(entry.profile) && job.profile === entry.profile
    && Number.isFinite(upTime) && upTime <= now);
  const value = exact ? job?.startedAt : entry?.updatedAt;
  const timestamp = value ? Date.parse(value) : NaN;
  const elapsed = now - timestamp;

  if (!Number.isFinite(timestamp) || elapsed < 0) {
    return {
      label: t('core.sandboxDavnostNeizvestna'),
      hint: t('core.sandboxDataPodemaNeizvestna'),
      old: false,
    };
  }

  const duration = elapsed >= DAY
    ? t('core.coreFloorelapseddayDn', { floorelapsedDAY: Math.floor(elapsed / DAY) })

    : elapsed >= 3600000
      ? t('core.coreFloorelapsed3600000Ch', { floorelapsed3600000: Math.floor(elapsed / 3600000) })

      : t('core.coreFloorelapsed60000Min', { floorelapsed60000: Math.floor(elapsed / 60000) });
  const old = elapsed >= 7 * DAY;
  const hint = exact
    ? (entry ? t('core.sandboxOtNachalaPodemaStenda') : t('core.sandboxOtNachalaTekuschegoPodema'))
    : t('core.sandboxOtsenkaPoObnovleniyuZapisi');

  return {
    label: t('core.sandboxExactDuration', { exact: exact ? '' : '≈ ', duration }),
    hint: old ? t('core.sandboxHintDavnoStoitNe', { hint }) : hint,
    old,
  };
}

/**
 * Шаг присутствует и до записи реестра, и после неё до конца задания.
 * Завершённый прогон не оставляет в компактной строке устаревший шаг.
 */
function jobStep(job: SandboxJob | null) {
  if (job?.state !== 'running') {
    return '';
  }

  const defaults = {
    up: t('core.sandboxIdetPodem2'),
    down: t('core.sandboxIdetSnos2'),
    run: t('core.sandboxIdetProgon2'),
  };
  const label = job.label || defaults[job.action];

  return job.total ? `${job.index}/${job.total} · ${label}` : label;
}

/**
 * Строит независимые от стора строки, объединяя реестр с ещё не записанным подъёмом.
 * Состояние конвейера использует его общий приоритет и не связывает чужие профили.
 */
export function sandboxRows(
  entries: SandboxEntry[], jobs: SandboxJob[], snapshot: SandboxPipelineSnapshot, now: number,
): SandboxRow[] {
  const tasks = new Map(snapshot.tasks.map((task) => [String(task.task).trim(), task]));
  const active = (items: SandboxPipelineSnapshot['running']) => items.filter((item) =>
    !tasks.get(String(item.task).trim())?.readOnly);
  const classified = new Map(pipelineTopbarItems({
    stalled: active(snapshot.stalled),
    silent: active(snapshot.silent),
    waiting: active(snapshot.waiting),
    running: active(snapshot.running),
  }).map((item) => [item.task, item]));
  const byTask = new Map(jobs.map((job) => [String(job.task).trim(), job]));
  const rows = entries.map((entry): SandboxRow => {
    const task = String(entry.task).trim();
    const known = tasks.get(task);
    const matching = entry.owner === 'manual'
      ? Boolean(entry.profile && known?.profile === entry.profile)
      : Boolean(known && !(entry.profile && known.profile && entry.profile !== known.profile));
    const metadata = matching ? known : null;
    const item = metadata ? classified.get(task) : null;
    const observed = snapshot.observedByTask[task];
    let category: SandboxCategory = 'unknown';
    let stateLabel = t('settings.unknownStatus');
    let detail = '';

    if (entry.owner === 'manual') {
      category = 'manual';
      stateLabel = t('core.sandboxManualLabel');
    } else if (metadata && snapshot.loadedAt) {
      if (metadata.readOnly) {
        category = 'inactive';
        stateLabel = t('core.sandboxNeaktiven');
        detail = t('core.sandboxReadOnlyDetail');
      } else if (item) {
        category = item.kind as SandboxCategory;
        stateLabel = item.kind === 'error'
          ? (snapshot.stalled.some((notice) => notice.task === task) ? t('core.stalled') : t('core.silent'))
          : item.kind === 'waiting' ? t('core.awaitingDecision2') : t('core.sandboxIdetRabota');
        detail = item.detail;
      } else if (observed?.gateKnown) {
        category = 'inactive';
        stateLabel = t('core.sandboxNeaktiven');
        detail = metadata.result === 'stopped' ? t('core.corePopytkaOstanovlena')
          : metadata.result ? t('core.corePopytkaZavershena') : t('core.coreNetAktivnoyRaboty');
      }
    }

    const job = byTask.get(task) || null;

    return {
      task,
      profile: entry.profile,
      entry,
      job,
      title: metadata?.title?.trim()
        || (entry.owner === 'manual'
          ? t('core.sandboxRuchnoyStend')
          : t('core.sandboxNazvanieZadachiNeizvestno')),
      category,
      stateLabel,
      detail,
      step: jobStep(job),
      age: standAge(entry, job, now),
    };
  });
  const registered = new Set(rows.map((row) => row.task));

  for (const job of jobs) {
    const task = String(job.task).trim();

    if (registered.has(task) || job.action !== 'up' || job.state !== 'running') {
      continue;
    }

    registered.add(task);
    rows.push({
      task,
      profile: job.profile,
      entry: null,
      job,
      title: t('core.sandboxRuchnoyStend'),
      category: 'manual',
      stateLabel: t('core.coreRuchnoyPodgotovkaIdet'),
      detail: '',
      step: jobStep(job),
      age: standAge(null, job, now),
    });
  }

  return rows;
}

/**
 * Поиск дополняет прежние поля названием задачи из уже прочитанного снимка.
 * Фильтры не изменяют ни реестр, ни журнал заданий.
 */
export function sandboxMatches(row: SandboxRow, query: string) {
  const repos = row.entry?.repos || [];
  const text = [row.task, `t${row.task}`, row.profile, row.title,
    ...repos.flatMap((repo) => [repo.name, repo.branch, repo.path])].join(' ').toLowerCase();

  return text.includes(query.trim().toLowerCase());
}

/**
 * Срез всех конвейерных стендов сохраняет прежний фильтр владельца.
 * Основные категории при этом остаются взаимоисключающими для счётчиков.
 */
export function sandboxStateMatches(row: SandboxRow, state: string) {
  return state === 'all' || (state === 'pipeline' ? row.entry?.owner === 'pipeline' : row.category === state);
}

/**
 * Пустой профиль имеет отдельное значение фильтра и не превращается в строку null.
 * Одна и та же нормализация нужна группам и фасетным счётчикам.
 */
export function sandboxProfileKey(row: SandboxRow) {
  return row.profile || NO_PROFILE;
}

/**
 * Группы показывают занятые слоты полного реестра, даже когда поиск скрывает строки.
 * Номер сравнивается без потери точности на допустимых девятнадцати цифрах.
 */
export function sandboxGroups(visible: SandboxRow[], all: SandboxRow[]) {
  const profiles = [...new Set(visible.map(sandboxProfileKey))].sort((left, right) => {
    if (left === NO_PROFILE || right === NO_PROFILE) {
      return left === right ? 0 : left === NO_PROFILE ? 1 : -1;
    }

    return left.localeCompare(right);
  });

  return profiles.map((profile) => ({
    profile,
    label: profile === NO_PROFILE ? t('core.sandboxBezProfilya') : profile,
    slots: [...new Set(all.filter((row) => sandboxProfileKey(row) === profile)
      .flatMap((row) => row.entry?.slot != null ? [row.entry.slot] : []))].sort((a, b) => a - b),
    rows: visible.filter((row) => sandboxProfileKey(row) === profile).sort((left, right) => {
      const a = BigInt(left.task);
      const b = BigInt(right.task);

      return a < b ? -1 : a > b ? 1 : 0;
    }),
  }));
}

// Чтение состояния песочниц: реестр фабрики (t<номер>.env) и журнал GrigDesk.
//
// Своего источника правды о стендах у раздела нет. Реестр пишет подъём профиля,
// журнал этапов (t<номер>.stage) — он же, а GrigDesk добавляет только собственную
// запись о том, ЧТО он запускал: профиль, действие, процесс и его вывод.
//
// Чтение обязано быть устойчивым к наполовину поднятому состоянию: движок кладёт
// ссылку на реестр ДО подъёма, и всё время провижининга она висит битой. На такой
// ссылке уже обрывался статус профиля, поэтому здесь она просто пропускается.
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { parsePipeline } from '../pipelineParse.ts';
import { parseSandboxRepositories } from '../sandboxEnv.ts';
import {
  parseSandboxJournalRecord,
  SANDBOX_TASK_RE,
} from '../../../../shared/plugins/sandboxes/sandboxContracts.ts';
import type {
  SandboxJournalRecord,
  SandboxRepo,
} from '../../../../shared/plugins/sandboxes/sandboxContracts.ts';

export interface SandboxRegistryEntry {
  task: string;
  slot: number | null;
  fePort: number | null;
  apiPort: number | null;
  workspaceMode: 'isolated' | 'shared' | null;
  standOwnership: string;
  repos: SandboxRepo[];
  pipeline: boolean;
  updatedAt: string | null;
}

export interface PipelineHold {
  profile: string;
  stalledHuman: boolean;
  gate: string | null;
}

export interface SandboxStage {
  state: 'running' | 'done' | 'failed';
  at: string;
  index: number;
  total: number;
  label: string;
}

const ENV_FILE = /^t([1-9][0-9]{0,18})\.env$/;
const JOURNAL_FILE = /^t([1-9][0-9]{0,18})\.json$/;
const STEP_LINE = /^([^|]*)\|(\d+)\/(\d+)\|(.*)$/;
const TERMINAL_LINE = /^([^|]*)\|(DONE|FAILED)(?:\|(.*))?$/;

function uint(value: unknown): number | null {
  return /^(?:0|[1-9][0-9]*)$/.test(String(value ?? '')) ? Number(value) : null;
}

function journalFile(journalDir: string, task: string): string {
  return path.join(journalDir, `t${task}.json`);
}

/** Общая проверка наличия файла: реестр и служба спрашивают её одинаково часто. */
export async function fileExists(file: string): Promise<boolean> {
  return fs.access(file).then(() => true).catch(() => false);
}

/**
 * Один файл реестра. Битая ссылка, чужой файл и env без своего номера задачи дают
 * null: полусостояние подъёма не должно превращаться в карточку стенда.
 */
async function readEntry(stateDir: string, task: string): Promise<SandboxRegistryEntry | null> {
  const file = path.join(stateDir, `t${task}.env`);
  let text = '';
  let updatedAt: string | null = null;

  try {
    const info = await fs.stat(file);

    if (!info.isFile()) {
      return null;
    }

    text = await fs.readFile(file, 'utf8');
    updatedAt = new Date(info.mtimeMs).toISOString();
  } catch {
    return null;
  }

  const env = parsePipeline(text);

  if (String(env.TASK || '') !== task) {
    return null;
  }

  // allowLegacy: чтение раздела — read-only показ путей и веток. Мутации идут по
  // номеру стенда в скрипты профиля и на разбор репозиториев не опираются.
  const sandbox = parseSandboxRepositories(env, { allowLegacy: true });
  const repos = sandbox.kind === 'invalid' ? [] : sandbox.repos;

  return {
    task,
    slot: uint(env.SB_K),
    fePort: uint(env.FE_PORT),
    apiPort: uint(env.API_PORT),
    workspaceMode: sandbox.workspaceMode,
    standOwnership: String(env.STAND_OWNERSHIP || ''),
    repos: repos.map((repo) => ({
      name: repo.name,
      path: repo.path,
      branch: repo.branch,
    })),
    pipeline: await fileExists(path.join(stateDir, `t${task}.pipeline`)),
    updatedAt,
  };
}

/**
 * Все поднятые стенды каталога состояния, отсортированные по номеру. Признак
 * pipeline отделяет стенд попытки движка от поднятого руками: у первого свой
 * жизненный цикл в разделе «Конвейер», и раздел песочниц его не трогает.
 */
export async function readSandboxRegistry(stateDir: string): Promise<SandboxRegistryEntry[]> {
  let names: string[] = [];

  try {
    names = await fs.readdir(stateDir);
  } catch {
    return [];
  }

  const tasks = names
    .map((name) => ENV_FILE.exec(name)?.[1])
    .filter((task): task is string => Boolean(task));
  const entries = await Promise.all(tasks.map((task) => readEntry(stateDir, task)));

  return entries
    .filter((entry): entry is SandboxRegistryEntry => entry !== null)
    .sort((left, right) => Number(left.task) - Number(right.task));
}

/**
 * Прогресс подъёма из t<номер>.stage. Пока стенд строится, портов в реестре ещё
 * нет — это единственный источник «что сейчас происходит». Терминальную отметку
 * (DONE/FAILED) ищем отдельно от последнего шага: у неё нет номера шага, а знать
 * нужно и то, и другое.
 *
 * ВТОРОЙ ЧИТАТЕЛЬ ЭТОГО ФОРМАТА — `adapters/factory-state.js#readSandboxStage`:
 * он кормит карточку задачи конвейера и знает только строку шага. Меняя формат,
 * правьте оба места.
 */
export async function readSandboxStage(stateDir: string, task: string): Promise<SandboxStage | null> {
  let lines: string[] = [];

  try {
    const text = await fs.readFile(path.join(stateDir, `t${task}.stage`), 'utf8');
    lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  } catch {
    return null;
  }

  const terminal = TERMINAL_LINE.exec(lines[lines.length - 1] || '');
  let step: RegExpExecArray | null = null;

  // С конца и до первого совпадения: актуален последний шаг, а журнал этапов
  // перечитывается на каждое изменение каталога состояния.
  for (let index = lines.length - 1; index >= 0 && !step; index -= 1) {
    step = STEP_LINE.exec(lines[index] || '');
  }

  if (!terminal && !step) {
    return null;
  }

  return {
    state: terminal ? (terminal[2] === 'DONE' ? 'done' : 'failed') : 'running',
    at: (terminal?.[1] ?? step?.[1] ?? '').trim(),
    index: step ? Number(step[2]) : 0,
    total: step ? Number(step[3]) : 0,
    label: terminal?.[3]?.trim() || step?.[4]?.trim() || '',
  };
}

/** Реестр конвейера у стенда есть — значит стендом владеет попытка движка. */
export async function hasPipelineRegistry(stateDir: string, task: string): Promise<boolean> {
  return fileExists(path.join(stateDir, `t${task}.pipeline`));
}

/**
 * Чем занята попытка, которая держит стенд. Признак остановки взят тот же, что у
 * остального сервера: движок сам ставит STALLED_HUMAN=1 и выходит, обнуляя ORCH_PID.
 * Пока попытка исполняется, стенд принадлежит ей целиком, и читатели вне раздела
 * «Конвейер» не вправе на него опираться: движок в любой момент пересоберёт или
 * снесёт его. Отдельно называется ворота: пауза у ворот — не затык, а ожидание
 * решения человека, и стенд в этот момент стоит ровно таким, каким его показали.
 */
export async function readPipelineHold(
  stateDir: string,
  task: string,
): Promise<PipelineHold | null> {
  let text = '';

  try {
    text = await fs.readFile(path.join(stateDir, `t${task}.pipeline`), 'utf8');
  } catch {
    return null;
  }

  const registry = parsePipeline(text);
  const gate = Object.keys(registry)
    .find((key) => /^GATE_[A-Z_]+$/.test(key) && registry[key] === 'waiting') ?? null;

  return {
    profile: String(registry.PROFILE || ''),
    stalledHuman: registry.STALLED_HUMAN === '1' && !registry.ORCH_PID,
    gate: gate ? gate.slice('GATE_'.length).toLowerCase() : null,
  };
}

/**
 * Запись журнала переживает перезапуск сервера, поэтому пишется атомарно и только
 * целиком: недописанный JSON после падения был бы неотличим от повреждённого.
 * Каждый writer держит собственный временный файл: refresh и итог процесса
 * могут сохранять одно задание одновременно и не должны забирать файл соседа.
 */
export async function writeSandboxJournalRecord(
  journalDir: string,
  record: SandboxJournalRecord,
): Promise<void> {
  await fs.mkdir(journalDir, { recursive: true });

  const file = journalFile(journalDir, record.task);
  const temporary = `${file}.${randomUUID()}.tmp`;

  try {
    await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/** Одна запись журнала; повреждённая читается как отсутствующая. */
export async function readSandboxJournalRecord(
  journalDir: string,
  task: string,
): Promise<SandboxJournalRecord | null> {
  if (!SANDBOX_TASK_RE.test(task)) {
    return null;
  }

  try {
    const text = await fs.readFile(journalFile(journalDir, task), 'utf8');

    return parseSandboxJournalRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * Весь журнал GrigDesk. Повреждённые записи отбрасываются молча: журнал — это
 * подсказка человеку о своих же запусках, и один битый файл не должен закрывать
 * раздел целиком.
 */
export async function readSandboxJournal(journalDir: string): Promise<SandboxJournalRecord[]> {
  let names: string[] = [];

  try {
    names = await fs.readdir(journalDir);
  } catch {
    return [];
  }

  const tasks = names
    .map((name) => JOURNAL_FILE.exec(name)?.[1])
    .filter((task): task is string => Boolean(task));
  const records = await Promise.all(tasks.map((task) => readSandboxJournalRecord(journalDir, task)));

  return records
    .filter((record): record is SandboxJournalRecord => record !== null)
    .sort((left, right) => Number(left.task) - Number(right.task));
}

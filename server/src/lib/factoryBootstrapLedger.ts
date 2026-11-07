import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { sha256 } from '../../../shared/node/hash.ts';

import { RoutesStore } from '../modules/routes/store.ts';

// Bootstrap имеет отдельный visit; sequence его журнала не является sequence этапов.
export interface BootstrapStop {
  phase: 'bootstrap';
  node: 'scout';
  visitId: string;
  recordHash: string;
  outcome: 'failed' | 'skipped' | 'exhausted';
  reason: string;
  at: string;
  verdict: unknown;
  runs: unknown[];
  state: 'waiting' | 'answered' | 'running';
  decision: { recordHash: string; answer: string } | null;
}

interface BootstrapIdentity {
  taskId: string;
  attemptId: string;
  profile: string;
  catalogHash: string;
  routeId: string;
  routeHash: string;
}

interface BootstrapEvent extends BootstrapIdentity {
  schema: number;
  protocolVersion: number;
  phase: string;
  node: string;
  runKey: string;
  sequence: number;
  previousEventHash: string | null;
  at: string;
  kind: string;
  visitId: string;
  decisionHash?: string | null;
  outcome?: 'failed' | 'skipped' | 'exhausted';
  reason?: string;
  verdict?: { owner?: string } | null;
  runs?: Array<{
    runId: string;
    epoch: number;
    result: string | null;
  }>;
  transitionHash?: string;
  stopHash?: string;
  answer?: string;
  checkpointHash?: string;
}

const EVENT_RE = /^event\.([0-9]{20})\.([a-f0-9]{64})\.json$/;
const VISIT_RE = /^b_[a-f0-9]{32}$/;
const OWNERS = new Set(['build', 'tests', 'environment', 'plan', 'human']);
const COMMON_KEYS = [
  'schema', 'protocolVersion', 'taskId', 'attemptId', 'profile', 'catalogHash',
  'routeId', 'routeHash', 'phase', 'node', 'runKey', 'sequence', 'previousEventHash',
  'at', 'kind', 'visitId',
];
const KIND_KEYS: Record<string, string[] | undefined> = {
  visit: ['decisionHash'],
  stop: ['outcome', 'reason', 'verdict', 'runs', 'transitionHash'],
  decision: ['stopHash', 'answer'],
  completed: ['checkpointHash'],
};

function invalid(reason: string): never {
  throw new Error(`bootstrap ledger: ${reason}`);
}

/**
 * Повторяет canonical JSON checkpoint/journal: отсортированные поля и indent=2.
 * Проверка байтов одновременно отклоняет дубликаты ключей и иной JSON-emitter.
 */
function canonical(value: unknown): string {
  // Сортировка рекурсивна: verdict и action входят в тот же digest contract.
  // Строки сохраняют Unicode, порядок массивов остаётся порядком хостовых записей.
  const ordered = (item: unknown): unknown => {
    if (Array.isArray(item)) {
      return item.map(ordered);
    }
    if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;

      return Object.fromEntries(Object.keys(record).sort().map((key) => [key, ordered(record[key])]));
    }

    return item;
  };

  return `${JSON.stringify(ordered(value), null, 2)}\n`;
}

/**
 * Читает защищённый immutable файл через NOFOLLOW; lstat не заменяет проверку FD.
 * Ограничение размера применяется до выделения буфера и разбора недоверенного текста.
 */
async function immutableBytes(filename: string): Promise<Buffer> {
  const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);

  try {
    const info = await file.stat();

    if (!info.isFile() || (info.mode & 0o777) !== 0o400 || info.nlink !== 1
        || info.uid !== process.geteuid?.() || info.size > 1024 * 1024) {
      invalid('небезопасный файл');
    }

    return await file.readFile();
  } finally {
    await file.close();
  }
}

function validText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && [...value].length <= 20000
    && !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value);
}

/**
 * Reader проверяет форму typed verdict до выдачи actionable вопроса.
 * Ограничения совпадают с общим stage-result; файл bootstrap не ослабляет этот протокол.
 */
function validateVerdict(value: unknown): void {
  if (value === null) {
    return;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid('неверный verdict');
  }

  const record = value as Record<string, unknown>;
  const findings = record.findings;
  const line = (text: unknown, limit: number): text is string => (
    typeof text === 'string' && [...text].length > 0 && [...text].length <= limit
    && !/[\u0000-\u001f\u007f]/.test(text)
  );
  const relative = (text: unknown): text is string => (
    line(text, 200) && !text.startsWith('/') && !text.split('/').includes('..')
  );

  if (Object.keys(record).some((key) => !['owner', 'findings', 'reviewed', 'stage'].includes(key))
      || typeof record.owner !== 'string' || !OWNERS.has(record.owner) || !Array.isArray(findings)
      || !findings.length || findings.length > 32) {
    invalid('неверный owner/findings');
  }

  const ids = new Set<string>();

  for (const raw of findings) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      invalid('неверная находка');
    }

    const finding = raw as Record<string, unknown>;

    if (Object.keys(finding).some((key) => !['id', 'summary', 'anchor', 'severity'].includes(key))
        || typeof finding.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(finding.id)
        || ids.has(finding.id) || !line(finding.summary, 500)
        || ('anchor' in finding && !relative(finding.anchor))
        || ('severity' in finding && (typeof finding.severity !== 'string'
          || !['blocking', 'deferred'].includes(finding.severity)))) {
      invalid('неверные поля находки');
    }

    ids.add(finding.id);
  }

  if (record.reviewed !== undefined && record.reviewed !== null
      && (!Array.isArray(record.reviewed) || !record.reviewed.length || record.reviewed.length > 64
        || record.reviewed.some((entry) => !relative(entry)))) {
    invalid('неверный reviewed');
  }
  if (record.stage !== undefined && record.stage !== null) {
    const stage = record.stage as Record<string, unknown>;

    if (Object.keys(stage).sort().join(',') !== 'closes,kind,summary' || stage.kind !== 'next'
        || !Array.isArray(stage.closes) || !stage.closes.length || stage.closes.length > 32
        || new Set(stage.closes).size !== stage.closes.length || !line(stage.summary, 500)
        || stage.closes.some((id) => typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id))
        || !findings.some((finding) => (finding.severity || 'blocking') === 'blocking')) {
      invalid('неверный stage');
    }
  }
}

/**
 * Сверяет run/epoch списка остановки; молчавшие исполнения не считаются committed.
 * Typed owner влияет на закреплённый переход только у failed.
 */
function validateStop(event: BootstrapEvent): void {
  if (!['failed', 'skipped', 'exhausted'].includes(event.outcome || '') || !validText(event.reason)
      || !Array.isArray(event.runs) || !event.runs.length || event.runs.length > 1000) {
    invalid('неверный stop');
  }

  const runs = event.runs;
  const seen = new Set<string>();

  for (const run of runs) {
    const key = `${run.runId}/${run.epoch}`;

    if (Object.keys(run).sort().join(',') !== 'epoch,result,runId'
        || typeof run.runId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(run.runId)
        || !Number.isSafeInteger(run.epoch) || run.epoch < 1
        || ![null, 'failed', 'skipped'].includes(run.result) || seen.has(key)) {
      invalid('неверное исполнение');
    }

    seen.add(key);
  }

  if (event.outcome === 'exhausted') {
    if (event.verdict !== null || runs.some((run) => run.result !== null)) {
      invalid('exhausted не является вердиктом агента');
    }
  } else {
    if (runs.at(-1)?.result !== event.outcome || (event.outcome === 'skipped' && event.verdict !== null)) {
      invalid('неверный committed исход');
    }
    if (event.verdict !== null && (!event.verdict || !OWNERS.has(String(event.verdict.owner)))) {
      invalid('неверный typed owner');
    }

    validateVerdict(event.verdict);
  }
}

/**
 * Проверяет отдельную цепочку до выдачи вопроса человеку при cursor=null.
 * Bundle проверяется только при наличии bootstrap-журнала; старые попытки не платят за него.
 */
export async function readBootstrapStop(
  attemptDir: string,
  expected: BootstrapIdentity,
  routesDir: string,
): Promise<BootstrapStop | null> {
  const directory = path.join(attemptDir, 'bootstrap-results');
  const info = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return null;
    }

    throw error;
  });

  if (!info) {
    return null;
  }
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o022) !== 0
      || info.uid !== process.geteuid?.()) {
    invalid('небезопасный каталог');
  }

  const names = (await fs.readdir(directory)).filter((name) => !name.startsWith('.')).sort();

  if (names.length > 4096) {
    invalid('слишком длинная цепочка');
  }

  let previous: string | null = null;
  let visit: BootstrapEvent | null = null;
  let stop: BootstrapStop | null = null;
  let decisionHash: string | null = null;
  let completed = false;
  const visits = new Set<string>();
  let catalog: Awaited<ReturnType<RoutesStore['readCatalog']>> | null = null;

  for (const [index, name] of names.entries()) {
    const match = EVENT_RE.exec(name);

    if (!match) {
      invalid('неизвестный файл');
    }

    const bytes = await immutableBytes(path.join(directory, name));
    const event = JSON.parse(bytes.toString('utf8')) as BootstrapEvent;
    const kindKeys = KIND_KEYS[event.kind];

    if (!kindKeys || Object.keys(event).sort().join(',') !== [...COMMON_KEYS, ...kindKeys].sort().join(',')
        || Object.entries(expected).some(([key, value]) => event[key as keyof BootstrapEvent] !== value)
        || event.schema !== 1 || event.protocolVersion !== 2 || event.phase !== 'bootstrap'
        || event.node !== 'scout' || event.runKey !== 'SCOUT' || event.sequence !== index + 1
        || Number(match[1]) !== event.sequence || event.previousEventHash !== previous
        || sha256(bytes) !== match[2] || bytes.toString('utf8') !== canonical(event)
        || !VISIT_RE.test(event.visitId) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(event.at)
        || !Number.isFinite(Date.parse(event.at))) {
      invalid('identity, predecessor или digest');
    }

    if (event.kind === 'visit') {
      if (completed || stop?.state === 'waiting' || event.decisionHash !== decisionHash
          || visits.has(event.visitId)) {
        invalid('визит без решения человека');
      }

      visits.add(event.visitId);
      visit = event;

      if (stop) {
        stop.state = 'running';
      }
    } else {
      if (!visit || visit.visitId !== event.visitId || completed) {
        invalid('событие другого визита');
      }

      if (event.kind === 'stop') {
        if (stop && stop.state !== 'running') {
          invalid('повторная остановка визита');
        }

        validateStop(event);
        catalog ??= await new RoutesStore({ baseDir: routesDir }).readCatalog(
          expected.profile, expected.catalogHash,
        );

        const node = catalog.bootstrap.nodes.find((item) => item.id === 'scout');
        const owner = event.verdict?.owner;
        const action = owner && node?.onFailure ? node.onFailure[owner] : node?.on?.[event.outcome || ''];
        const transition = {
          schema: 2,
          catalogHash: expected.catalogHash,
          phase: 'bootstrap',
          node: 'scout',
          outcome: event.outcome,
          action,
          retry: node?.retry ?? null,
          escalationPolicy: null,
        };

        if (catalog.catalog.routes[expected.routeId] !== expected.routeHash
            || !action || Object.keys(action).join(',') !== 'stop' || action.stop !== 'human'
            || event.transitionHash !== sha256(canonical(transition))) {
          invalid('закреплённый переход не подтверждён');
        }

        stop = {
          phase: 'bootstrap',
          node: 'scout',
          visitId: event.visitId,
          recordHash: match[2],
          outcome: event.outcome as BootstrapStop['outcome'],
          reason: event.reason || '',
          at: event.at,
          verdict: event.verdict,
          runs: event.runs || [],
          state: 'waiting',
          decision: null,
        };
        decisionHash = null;
      } else if (event.kind === 'decision') {
        if (!stop || stop.state !== 'waiting' || stop.visitId !== event.visitId
            || event.stopHash !== stop.recordHash || !validText(event.answer)) {
          invalid('ответ не адресует ожидающий stop');
        }

        decisionHash = match[2];
        stop.state = 'answered';
        stop.decision = {
          recordHash: match[2],
          answer: event.answer,
        };
      } else {
        if (stop?.state === 'waiting' || stop?.visitId === event.visitId) {
          invalid('completed содержит остановку');
        }

        const bytes = await immutableBytes(path.join(attemptDir, 'artifacts', 'bootstrap.json'));

        if (sha256(bytes) !== event.checkpointHash) {
          invalid('completed не подтверждён checkpoint');
        }

        completed = true;
        stop = null;
      }
    }

    previous = match[2];
  }

  const checkpointFile = path.join(attemptDir, 'artifacts', 'bootstrap.json');
  const checkpointPresent = await fs.lstat(checkpointFile).then(
    () => true, (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return false;
      }

      throw error;
    },
  );

  // Checkpoint публикуется раньше completed: это законное окно crash, а не старый вопрос.
  // Проверенный успех снимает только прошлый answered/running источник; waiting конфликтует.
  if (checkpointPresent) {
    if (stop && stop.state !== 'running') {
      invalid('checkpoint противоречит ожидающей остановке');
    }

    const bytes = await immutableBytes(checkpointFile);
    const value = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    const keys = Object.keys(expected).concat(
      'schema', 'protocolVersion', 'node', 'runKey', 'result', 'runId', 'epoch', 'verdict', 'transitionHash',
    );

    if (Object.keys(value).sort().join(',') !== keys.sort().join(',')
        || Object.entries(expected).some(([key, item]) => value[key] !== item)
        || value.schema !== 2 || value.protocolVersion !== 2 || value.node !== 'scout'
        || value.runKey !== 'SCOUT' || value.result !== 'done'
        || typeof value.runId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(value.runId)
        || !Number.isSafeInteger(value.epoch) || Number(value.epoch) < 1
        || canonical(value) !== bytes.toString('utf8')) {
      invalid('неверный successful checkpoint');
    }

    validateVerdict(value.verdict);

    const verdict = value.verdict as { findings?: Array<{ severity?: string }>; stage?: unknown } | null;

    if (verdict && (verdict.stage || verdict.findings?.some((item) => item.severity !== 'deferred'))) {
      invalid('done содержит blocking или stage');
    }

    catalog ??= await new RoutesStore({ baseDir: routesDir }).readCatalog(
      expected.profile, expected.catalogHash,
    );

    const node = catalog.bootstrap.nodes.find((item) => item.id === 'scout');
    const action = node?.on?.done;
    const policy = catalog.bootstrap.escalation.find((item) => item.from === 'scout');
    const transition = {
      schema: 2,
      catalogHash: expected.catalogHash,
      phase: 'bootstrap',
      node: 'scout',
      outcome: 'done',
      action,
      retry: node?.retry ?? null,
      escalationPolicy: policy,
    };

    if (!action?.escalate?.routes.includes(expected.routeId) || policy?.requiresHumanWhenPinned !== true
        || catalog.catalog.routes[expected.routeId] !== expected.routeHash
        || value.transitionHash !== sha256(canonical(transition))) {
      invalid('checkpoint не подтверждает закреплённый переход');
    }

    return null;
  }

  return stop;
}

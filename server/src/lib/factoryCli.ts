// Read-only адаптер журналов и активности. После cutover mutation helpers удалены:
// Cockpit меняет попытку только через exact route commands единственного движка.
import fs from 'node:fs';
import path from 'node:path';
import { JOURNAL_FRESH_SEC } from '../../../shared/pipeline/agentActivity.ts';
import { readProcessIdentity } from './speech/modelJobsProcess.ts';
import { parseStagesLog } from './stagesParse.ts';

// Реестр задачи — плоская проекция t<TASK>.pipeline.
type Registry = Record<string, string | undefined>;

// Артефакты активного хода: где журнал и насколько он свеж.
interface ActiveRun {
  stage: string;
  runDir: string;
  eventsFile: string;
  mtimeMs: number;
}

// Сколько молчит активный ход и на каком вызове он висит.
export interface RunSilence {
  stage: string;
  sec: number;
  tool: string | null;
}

// Живая активность прогона для карточки задачи.
export interface RunActivity {
  tail: Array<{ ts: string; event: string }>;
  journalFresh: boolean;
  journalAgeSec: number | null;
  silentTool: string | null;
  wfStatus: string | null;
}

// Одно действие ленты агента: форма общая для инструмента, текста и субагента.
export interface AgentAction {
  type: string;
  ts?: string | null;
  name?: string;
  desc?: string;
  text?: string;
  status?: string;
  tokens?: number;
  tools?: number;
  lastTool?: string;
  doneAt?: string;
}

// Блок ответа Claude: тип разбирается по месту, поэтому поля необязательны.
interface LiveBlock {
  type?: string;
  id?: string;
  name?: string;
  text?: string;
  thinking?: string;
  is_error?: boolean;
  tool_use_id?: string;
  input?: { description?: string; file_path?: string; command?: string };
}

// Элемент ленты Codex.
interface CodexItem {
  id?: string;
  type?: string;
  status?: string;
  text?: string;
  command?: string;
  tool?: string;
  name?: string;
  server?: unknown;
  arguments?: unknown;
  prompt?: string;
  query?: unknown;
  path?: string;
  changes?: unknown;
}

// Событие events.jsonl. Форма разная у Claude и Codex — общего обязательного поля нет.
interface LiveEvent {
  type?: string;
  subtype?: string;
  timestamp?: string;
  heartbeat?: unknown;
  elapsed_time_seconds?: unknown;
  tool_name?: string;
  tool_use_id?: string;
  description?: string;
  last_tool_name?: string;
  usage?: { total_tokens?: number; tool_uses?: number };
  message?: { model?: string; content?: LiveBlock[] };
  item?: CodexItem;
}

export function readInstruction({ stateDir, task }: {
  stateDir: string;
  task: string | number;
}): string {
  try { return fs.readFileSync(path.join(stateDir, `t${task}.instruction.md`), 'utf8'); }
  catch { return ''; }
}

const SAFE_TASK = /^[0-9]+$/;
const SAFE_STAGE = /^[A-Z][A-Z0-9_]*$/;
const SAFE_RUN = /^[A-Za-z0-9._-]+$/;

/**
 * Ушёл ли раннер хода. Паспорт хода — PID и STARTTIME из его meta.env: launcher берёт их
 * из /proc при старте. Номер без времени старта ничего не доказывает — после перезагрузки
 * машины он мог достаться постороннему процессу.
 * Паспорта нет (launcher ещё не дописал meta.env) — судить не о чем, ход считается живым.
 */
function runnerGone(runDir: string): boolean {
  let meta = '';

  try {
    meta = fs.readFileSync(path.join(runDir, 'meta.env'), 'utf8');
  } catch {
    return false;
  }

  const pid = Number(meta.match(/^PID=(\d+)$/m)?.[1]);
  const starttime = meta.match(/^STARTTIME=(\d+)$/m)?.[1];

  if (!pid || !starttime) {
    return false;
  }

  return readProcessIdentity(pid)?.starttime !== starttime;
}

/**
 * Возвращает артефакты именно активного запуска по каноническим ACTIVE_RUN_<STAGE>.
 * Это общий путь и для Claude, и для Codex; orch.log оставлен только для старых прогонов.
 * liveOnly отбрасывает ход, чей раннер уже умер: так выглядит этап после TERM.
 */
function activeRunArtifacts({ stateDir, task, registry = {}, liveOnly = false }: {
  stateDir: string;
  task: string | number;
  registry?: Registry;
  liveOnly?: boolean;
}): ActiveRun | null {
  if (!SAFE_TASK.test(String(task))) return null;
  const candidates: ActiveRun[] = [];
  for (const [key, runId] of Object.entries(registry)) {
    if (!key.startsWith('ACTIVE_RUN_') || !runId) continue;
    const stage = key.slice('ACTIVE_RUN_'.length);
    if (!SAFE_STAGE.test(stage) || !SAFE_RUN.test(String(runId))) continue;
    // ACTIVE_RUN живёт дольше самого прогона: это ещё и fencing-токен, его НЕ чистят
    // (сброс эпохи воскресил бы убитый ход). Значит непустой ключ у не бегущего этапа —
    // не активность, а расписка о прошлом. На паузе у ворот иначе показывается давняя
    // запись из журнала BUILD отменённой попытки.
    if (registry[stage] !== 'running') continue;
    const runDir = path.join(stateDir, 'logs', 'runs', `t${task}`, stage, String(runId));
    // TERM (выключили машину, остановили прогон) оставляет этап `running`, а ACTIVE_RUN —
    // ссылкой на убитый ход, пока следующий не зарегистрируется. Лента и дальше показывает,
    // что ход успел сделать, а молчать мёртвый ход не может: см. readRunSilence.
    if (liveOnly && runnerGone(runDir)) {
      continue;
    }

    const eventsFile = path.join(runDir, 'events.jsonl');
    try {
      const stat = fs.statSync(eventsFile);
      candidates.push({ stage, runDir, eventsFile, mtimeMs: stat.mtimeMs });
    } catch { /* run успел зарегистрироваться, но launcher ещё не создал журнал */ }
  }
  return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)[0] || null;
}

// Хвоста в несколько десятков килобайт хватает: хартбит — короткая запись, а нужен
// только сплошной их блок в самом конце журнала.
const SILENCE_TAIL_BYTES = 32 * 1024;

/**
 * Сколько активный ход МОЛЧИТ — то есть не производит осмысленного вывода.
 *
 * Свежесть файла на этот вопрос не отвечает. Зависший вызов инструмента печатает
 * хартбит каждые 30 секунд, journal всё время выглядит свежим, и кокпит рисует бодрое
 * «агент пишет» над намертво вставшим агентом. Браузерная приёмка может долго стоять
 * на мёртвой странице, пока конвейер выглядит работающим, и заметить это нечем —
 * движок ставит STALLED_HUMAN только после того, как сдастся сам, а
 * здесь он честно ждал лимита этапа. Поэтому молчание считаем по последней ОСМЫСЛЕННОЙ
 * записи, а длительность висящего вызова берём из самого хартбита: он её и сообщает.
 *
 * Исполнитель без хартбитов (Codex) даёт хвост из обычных событий, и ответ вырождается
 * в прежний возраст файла — то есть правило не требует ничего от нового исполнителя.
 *
 * null — живого активного хода нет: молчать некому. Ход, чей раннер умер, сюда не
 * попадает: после выключения машины и «Продолжить» возраст журнала убитого хода
 * выдавался за молчание нового, ещё не стартовавшего, — «молчит 599 мин».
 */
export function readRunSilence({ stateDir, task, registry = {}, now = Date.now() }: {
  stateDir: string;
  task: string | number;
  registry?: Registry;
  now?: number;
}): RunSilence | null {
  const active = activeRunArtifacts({
    stateDir,
    task,
    registry,
    liveOnly: true,
  });
  if (!active) return null;
  const fileAgeSec = Math.max(0, Math.floor((now - active.mtimeMs) / 1000));
  const tail = readTail(active.eventsFile, SILENCE_TAIL_BYTES);
  const lines = tail ? tail.raw.split('\n') : [];
  // Первая строка хвоста может быть обрезана посередине — она не наша.
  if (tail?.truncated) lines.shift();

  // Идём с конца, пока идут хартбиты: висеть может сразу несколько вызовов (модель
  // просит инструменты пачкой), и честный ответ — по самому старому из них. Первая же
  // осмысленная запись означает, что после неё ход снова что-то сказал.
  let hangingSec = 0;
  let hangingTool: string | null = null;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = (lines[i] ?? '').trim();
    if (!line.startsWith('{')) continue;
    let ev: LiveEvent;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!ev.heartbeat) break;
    const sec = Number(ev.elapsed_time_seconds) || 0;
    if (sec >= hangingSec) { hangingSec = sec; hangingTool = ev.tool_name || null; }
  }
  return { stage: active.stage, sec: Math.max(hangingSec, fileAgeSec), tool: hangingTool };
}

/**
 * Живая активность прогона: хвост stages.log (человекочитаемый) + свежесть журнала агента.
 */
export function readActivity({ stateDir, task, registry }: {
  stateDir: string;
  task: string | number;
  registry: Registry;
}): RunActivity {
  let tail: Array<{ ts: string; event: string }> = [];
  try {
    const log = fs.readFileSync(path.join(stateDir, 'logs', `t${task}.stages.log`), 'utf8');
    tail = parseStagesLog(log).slice(-12).map((e) => ({ ts: e.ts, event: e.event }));
  } catch { /* журнала нет */ }

  // «Агент пишет» = свежая ОСМЫСЛЕННАЯ запись в events.jsonl канонического активного run:
  // хартбиты висящего вызова активностью не считаются (см. readRunSilence).
  // Старые ACTIVE_DIR/JOURNAL и orch.log нужны для уже созданных legacy-прогонов.
  let journalFresh = false;
  let journalMtimeMs: number | null = null;
  const silence = readRunSilence({ stateDir, task, registry });

  // На protocol v2 каждый ход обязан зарегистрировать ACTIVE_RUN, поэтому его отсутствие —
  // это «сейчас никто не пишет», а не «поищи где-нибудь ещё». Запасные пути тут только
  // навредят: orch.log остаётся от прошлого поколения и превращает штатную паузу у ворот
  // в тревожное «нет событий N мин».
  const legacy = registry.RUN_PROTOCOL !== '2';
  const adir = legacy && (registry.ACTIVE_DIR || (registry.JOURNAL ? path.dirname(registry.JOURNAL) : ''));
  if (!silence && adir) {
    try {
      for (const f of fs.readdirSync(adir)) {
        if (!f.endsWith('.jsonl')) continue;
        const mtimeMs = fs.statSync(path.join(adir, f)).mtimeMs;
        if (journalMtimeMs == null || mtimeMs > journalMtimeMs) journalMtimeMs = mtimeMs;
      }
    } catch { /* нет каталога */ }
  }
  if (!silence && journalMtimeMs == null && legacy) {
    try {
      journalMtimeMs = fs.statSync(path.join(stateDir, 'logs', `t${task}.orch.log`)).mtimeMs;
    } catch { /* лога агента нет */ }
  }
  const journalAgeSec = silence ? silence.sec : (journalMtimeMs == null
    ? null
    : Math.max(0, Math.floor((Date.now() - journalMtimeMs) / 1000)));
  journalFresh = journalAgeSec != null && journalAgeSec < JOURNAL_FRESH_SEC;
  return {
    tail,
    journalFresh,
    journalAgeSec,
    // Чем именно занят молчащий ход: имя висящего вызова отличает честную сборку
    // от мёртвого браузера лучше любой цифры.
    silentTool: silence?.tool || null,
    wfStatus: registry.WF_STATUS || null,
  };
}

function readTail(logFile: string, maxBytes: number): { raw: string; truncated: boolean } | null {
  try {
    const stat = fs.statSync(logFile);
    if (stat.size === 0) return null;
    const fd = fs.openSync(logFile, 'r');
    try {
      const start = Math.max(0, stat.size - maxBytes);
      const buf = Buffer.alloc(Math.min(stat.size, maxBytes));
      fs.readSync(fd, buf, 0, buf.length, start);
      return { raw: buf.toString('utf8'), truncated: start > 0 };
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

function readRunModel(runDir: string | null | undefined): string | null {
  if (!runDir) return null;
  try {
    const match = fs.readFileSync(path.join(runDir, 'meta.env'), 'utf8').match(/^MODEL=(.*)$/m);
    return match?.[1]?.trim() || null;
  } catch { return null; }
}

function shortText(value: unknown, limit = 120): string {
  let source: unknown = value;
  if (source == null) source = '';
  else if (typeof source === 'object') {
    try { source = JSON.stringify(source); } catch { source = String(source); }
  }
  const text = String(source).replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function fileChangeText(item: CodexItem): string {
  if (item.path) return shortText(item.path);
  const changes: unknown[] = Array.isArray(item.changes)
    ? item.changes
    : item.changes ? [item.changes] : [];
  const paths = changes.map((change) => {
    if (typeof change === 'string') return change;
    const entry = change as { path?: string; file_path?: string; move_path?: string } | null;
    return entry?.path || entry?.file_path || entry?.move_path || '';
  }).filter(Boolean);
  return paths.length ? shortText(paths.join(', ')) : shortText(item.changes);
}

function codexAction(item: CodexItem, status: string | undefined): AgentAction | null {
  const mappedStatus = status === 'failed' || status === 'error'
    ? 'error'
    : status === 'in_progress' || status === 'running' ? 'run' : 'done';
  switch (item.type) {
    case 'command_execution':
      return { type: 'tool', name: 'Команда', desc: shortText(item.command, 160), status: mappedStatus };
    case 'collab_tool_call': {
      const subagent = item.tool === 'spawn_agent';
      const names: Record<string, string | undefined> = {
        wait: 'Ожидание субагентов',
        spawn_agent: 'Запуск субагента',
        send_message: 'Сообщение субагенту',
        followup_task: 'Задание субагенту',
      };
      return {
        type: subagent ? 'subagent' : 'tool',
        name: names[String(item.tool)] || item.tool || 'Субагенты',
        desc: shortText(item.prompt || ''),
        status: mappedStatus,
      };
    }
    case 'mcp_tool_call':
      return {
        type: 'tool',
        name: item.tool || item.name || 'Инструмент',
        desc: shortText(item.server || item.arguments || ''),
        status: mappedStatus,
      };
    case 'web_search':
      return { type: 'tool', name: 'Поиск в интернете', desc: shortText(item.query), status: mappedStatus };
    case 'file_change':
      return { type: 'tool', name: 'Изменение файлов', desc: fileChangeText(item), status: mappedStatus };
    default:
      return null;
  }
}

// Действие ленты по индексу из карты ожиданий: карта переживает сброс ленты
// на `result`, поэтому индекс может указывать в пустоту.
function indexed(actions: AgentAction[], index: number | undefined): AgentAction | null {
  return index === undefined ? null : actions[index] ?? null;
}

/**
 * Живая лента действий агента: парсит events.jsonl активного run (Claude или Codex)
 * и выдаёт последние N событий. Для legacy-прогонов читает общий orch.log.
 * Читает только последние TAIL_BYTES байт — файл может быть десятки МБ.
 */
export function readAgentLive({ stateDir, task, registry = {} }: {
  stateDir: string;
  task: string | number;
  registry?: Registry;
}): { actions: AgentAction[]; model: string | null } {
  const TAIL_BYTES = 192 * 1024;
  const MAX_ACTIONS = 25;
  const active = activeRunArtifacts({ stateDir, task, registry });
  // Тот же запрет на legacy-подмену, что и в readActivity: на v2 без активного хода
  // лента пуста, а не «взята из orch.log прошлого поколения».
  const logFile = active?.eventsFile
    || (registry.RUN_PROTOCOL !== '2' ? path.join(stateDir, 'logs', `t${task}.orch.log`) : null);
  const tail = logFile ? readTail(logFile, TAIL_BYTES) : null;
  if (!tail) return { actions: [], model: readRunModel(active?.runDir) };
  const { raw, truncated } = tail;

  // Первая строка может быть обрезана — отбрасываем её, если начали не с начала.
  const lines = raw.split('\n');
  if (truncated) lines.shift();

  const actions: AgentAction[] = [];
  const pendingTools = new Map<string, number>(); // tool_use_id → index in actions
  const subagents = new Map<string, number>();   // tool_use_id → index in actions
  const pendingCodex = new Map<string, number>(); // item id → index in actions
  let model = readRunModel(active?.runDir);

  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let ev: LiveEvent;
    try { ev = JSON.parse(t); } catch { continue; }

    if (ev.type === 'assistant' && ev.message?.content) {
      if (!model && ev.message.model) model = ev.message.model;
      const ts = ev.timestamp || null;
      for (const block of ev.message.content) {
        if (block.type === 'tool_use') {
          const desc = block.input?.description || block.input?.file_path || block.input?.command?.slice(0, 80) || '';
          const isAgent = block.name === 'Agent';
          const a: AgentAction = {
            type: isAgent ? 'subagent' : 'tool',
            ts,
            name: block.name,
            desc,
            status: 'run',
          };
          if (isAgent && block.input?.description) a.desc = block.input.description;
          actions.push(a);
          if (block.id) pendingTools.set(block.id, actions.length - 1);
          if (isAgent && block.id) subagents.set(block.id, actions.length - 1);
        } else if (block.type === 'text' && block.text) {
          const txt = block.text.length > 120 ? block.text.slice(0, 120) + '…' : block.text;
          actions.push({ type: 'text', ts, text: txt });
        } else if (block.type === 'thinking' && block.thinking) {
          const dot = block.thinking.indexOf('.');
          const nl = block.thinking.indexOf('\n');
          let end = Math.min(dot > 0 ? dot + 1 : 999, nl > 0 ? nl : 999, 100);
          if (end >= 999) end = Math.min(block.thinking.length, 100);
          actions.push({ type: 'think', ts, text: block.thinking.slice(0, end).trim() });
        }
      }
    } else if (ev.type === 'user' && ev.message?.content) {
      const ts = ev.timestamp || null;
      for (const block of ev.message.content) {
        if (block.type !== 'tool_result' || !block.tool_use_id) continue;
        const pending = indexed(actions, pendingTools.get(block.tool_use_id));
        if (!pending) continue;
        pending.status = block.is_error ? 'error' : 'done';
        if (ts) pending.doneAt = ts;
        pendingTools.delete(block.tool_use_id);
      }
    } else if (ev.type === 'system' && ev.subtype === 'task_progress') {
      const tid = ev.tool_use_id;
      const target = tid ? indexed(actions, subagents.get(tid)) : null;
      if (target) {
        target.tokens = ev.usage?.total_tokens || 0;
        target.tools = ev.usage?.tool_uses || 0;
        if (ev.last_tool_name) target.lastTool = ev.last_tool_name;
      }
    } else if (ev.type === 'system' && ev.subtype === 'task_started') {
      const tid = ev.tool_use_id;
      const target = tid ? indexed(actions, subagents.get(tid)) : null;
      if (target && ev.description) target.desc = ev.description;
    } else if (ev.type === 'result') {
      // Финальный результат текущего этапа — всё «done», лента сбрасывается.
      actions.length = 0;
      pendingTools.clear();
      subagents.clear();
      pendingCodex.clear();
      model = null;
    } else if ((ev.type === 'item.started' || ev.type === 'item.completed') && ev.item) {
      const item = ev.item;
      if (item.type === 'agent_message' && ev.type === 'item.completed' && item.text) {
        actions.push({ type: 'text', text: shortText(item.text) });
      } else if (item.type === 'reasoning' && ev.type === 'item.completed' && item.text) {
        actions.push({ type: 'think', text: shortText(item.text, 100) });
      } else {
        const existing = item.id ? indexed(actions, pendingCodex.get(item.id)) : null;
        if (existing && ev.type === 'item.completed') {
          existing.status = item.status === 'failed' ? 'error' : 'done';
          if (item.id) pendingCodex.delete(item.id);
        } else {
          const action = codexAction(item, item.status || (ev.type === 'item.started' ? 'in_progress' : 'completed'));
          if (action) {
            actions.push(action);
            if (ev.type === 'item.started' && item.id) pendingCodex.set(item.id, actions.length - 1);
          }
        }
      }
    }
  }

  return { actions: actions.slice(-MAX_ACTIONS), model };
}

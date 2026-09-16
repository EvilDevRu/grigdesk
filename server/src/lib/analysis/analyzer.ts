// Триаж задач: очередь + одиночный headless-запуск выбранной модели (read-only разведка
// кода, без стенда). Агент сам пишет результат в каталог анализа (t<ID>.analysis.json +
// t<ID>.md), раннер валидирует и обогащает (SHA репозиториев, стоимость, время).
// Очередь in-process (конкуренция 1): анализ идёт минуты, при рестарте сервера
// незавершённые помечаются failed — кнопка «Оценить» запускает заново.
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadTriageProfile } from './profile.ts';
import type { TriageProfile } from './profile.ts';
import { buildTriagePrompt, type TriageAnsweredQuestion } from './prompt.ts';
import { parseRouteMap, resolveRoute } from './routePolicy.ts';
import { createRepoHistoryTools } from './repoHistory.ts';
import { supportsScopedWorkspace } from '../executors/index.ts';
import { createWorkIpc } from '../executors/workIpc.ts';
import { refreshRepos } from '../gitRefresh.ts';
import {
  resolveChatAttachment,
  resolveLegacyChatAttachment,
} from '../chat/attachments.ts';
import { resolveLegacyModel, resolveModelRef } from '../chat/modelRef.ts';
import { stripDiscussionSection } from '../telegram/discussion.ts';
import { questionKey } from '../../../../shared/analysisContracts.ts';
import type {
  Analysis,
  AnalysisArbiterAnswerInput,
  AnalysisClarificationEntry,
  AnalysisDetail,
  AnalysisQuestion,
  AnalysisQueueOutcome,
  AnalysisRow,
  AnalysisScope,
  AnalysisState,
  AnalysisStatus,
} from '../../../../shared/analysisContracts.ts';

// Собеседники анализатора живут в соседних модулях на JavaScript: он объявляет ровно
// то, что от них зовёт, и не выводит их формы из подсказок редактора.
export interface AnalyzerConfig extends Record<string, unknown> {
  analysisDir: string;
  factoryHome?: string;
  profilesDir?: string;
  factoryProfile?: string;
  chatsDir?: string;
}

// Итог постановки в очередь. Позиция есть только у принятой задачи: у дедупа и у
// выключенного плагина её попросту нет.
export interface QueueResult {
  outcome: AnalysisQueueOutcome;
  position?: number;
}

export interface AnalyzerOptions {
  config: AnalyzerConfig;
  claudeAuth?: unknown;
  b24?: unknown;
  factoryState?: unknown;
  prefs?: unknown;
  log?: unknown;
  discussion?: unknown;
  pluginEnabled?: (id: string) => boolean;
  pluginSettings?: (id: string) => Record<string, unknown>;
  providerRegistry?: () => Promise<unknown>;
  executorFor?: (provider: string) => Promise<unknown>;
}

// Пакет ответов приходит из сети, поэтому каждое значение проверяется ниже и типом
// не считается. Имена полей при этом берутся у общего контракта: разойтись с клиентом
// они больше не могут, а разбор всё равно начинается с `unknown`.
export type ClarificationAnswer = { [Field in keyof AnalysisArbiterAnswerInput]?: unknown };

export interface ClarificationBatchResult {
  ok: boolean;
  error?: string;
  text?: string;
  entries?: AnalysisClarificationEntry[];
}

const CLARIFICATION_MARKER_RE = /<!-- cockpit-clarification:v1 ([A-Za-z0-9_-]+) -->/g;

function boundedText(value: unknown, limit = 4000): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

// Текст отказа: до сюда доезжают и ошибки Node, и брошенные строки соседних модулей.
function failureText(value: unknown): string {
  const message = value !== null && typeof value === 'object'
    ? (value as { message?: unknown }).message
    : value;

  return String(message ?? '');
}

// Имя профиля живёт рядом с его переменными, но приходит из состояния фабрики.
function profileName(profile: TriageProfile): string {
  return String((profile as { name?: unknown }).name ?? '');
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}-${createHash('sha256').update(String(value)).digest('hex').slice(0, 12)}`;
}

/**
 * Объём задачи из оценки: два списка строк без пустых и дублей. Модель может отдать
 * объект не той формы или не отдать вовсе (старые оценки) — тогда оба списка пусты,
 * и форма запуска просто ничего не предзаполняет.
 */
export function normalizeAnalysisScope(value: unknown): AnalysisScope {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const lines = (raw: unknown): string[] => {
    const result: string[] = [];
    for (const item of Array.isArray(raw) ? raw : []) {
      const line = typeof item === 'string' ? boundedText(item, 2000) : '';
      if (line && !result.includes(line)) result.push(line);
    }
    return result.slice(0, 100);
  };
  return { do: lines(source.do), skip: lines(source.skip) };
}

/**
 * Старые строки и новый объектный контракт приводятся к одному представлению только
 * в памяти. Чтение старого файла при этом не является миграцией и не меняет байты.
 */
export function normalizeAnalysisQuestions(values: unknown): AnalysisQuestion[] {
  const result: AnalysisQuestion[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(values) ? values : []) {
    const text = boundedText(typeof raw === 'string' ? raw : raw?.text, 1000);
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);

    const questionId = boundedText(raw?.id, 80) || stableId('q', text);
    const options = [];
    const optionLabels = new Set();
    for (const option of Array.isArray(raw?.options) ? raw.options : []) {
      const label = boundedText(typeof option === 'string' ? option : option?.label, 300);
      if (!label || optionLabels.has(label)) {
        continue;
      }
      optionLabels.add(label);
      options.push({
        id: boundedText(option?.id, 80) || stableId('o', `${questionId}\0${label}`),
        label,
        description: boundedText(option?.description, 600) || null,
      });
    }

    const recommendation = raw?.recommendation && typeof raw.recommendation === 'object'
      ? {
        option: boundedText(raw.recommendation.option, 300),
        reason: boundedText(raw.recommendation.reason, 800),
      }
      : null;
    result.push({
      id: questionId,
      text,
      options,
      recommendation: recommendation?.option || recommendation?.reason ? recommendation : null,
    });
  }
  return result;
}

function clarificationEntries(markdown: unknown): AnalysisClarificationEntry[] {
  const entries: AnalysisClarificationEntry[] = [];
  for (const match of String(markdown || '').matchAll(CLARIFICATION_MARKER_RE)) {
    try {
      const parsed = JSON.parse(Buffer.from(String(match[1] || ''), 'base64url').toString('utf8'));
      if (!parsed?.questionId || !['human', 'cockpit-arbiter'].includes(parsed.actor)) {
        continue;
      }
      entries.push({
        id: boundedText(parsed.id, 100),
        questionId: boundedText(parsed.questionId, 100),
        // Текст вопроса и подписи вариантов записаны в самой записи: оценка триажа
        // перезаписывается следующим заходом, и без копии ответ теряет свой вопрос.
        questionText: boundedText(parsed.questionText, 1000),
        actor: parsed.actor === 'human' ? 'human' : 'cockpit-arbiter',
        status: parsed.status === 'human_required' ? 'human_required' : 'answered',
        selection: Array.isArray(parsed.selection)
          ? parsed.selection.map((value: unknown) => boundedText(value, 100)).filter(Boolean)
          : [],
        selectionLabels: Array.isArray(parsed.selectionLabels)
          ? parsed.selectionLabels.map((value: unknown) => boundedText(value, 300)).filter(Boolean)
          : [],
        text: boundedText(parsed.text, 6000),
        attachments: Array.isArray(parsed.attachments)
          ? parsed.attachments.map((item: { file?: unknown; name?: unknown }) => ({
            file: boundedText(item?.file, 180),
            name: boundedText(item?.name, 180),
          })).filter((item: { file: string }) => item.file)
          : [],
        proof: Array.isArray(parsed.proof)
          ? parsed.proof.map((value: unknown) => boundedText(value, 500)).filter(Boolean)
          : [],
      });
    } catch {
      // Старый или повреждённый комментарий остаётся видимым markdown-текстом.
    }
  }
  return entries;
}

/**
 * Видимая часть записи уточнения. Её читают не только глазами: этот markdown целиком
 * уезжает в промпт следующего триажа и в описание тикета конвейера. Пока в блок попадал
 * только свободный текст, ответ выбором варианта выглядел там заглушкой «нужно решение
 * человека» — и триаж, и арбитр, и планировщик переспрашивали уже решённое.
 */
function clarificationBlock(entry: AnalysisClarificationEntry, heading: string): string {
  const lines = [entry.questionText ? `## ${heading} — ${entry.questionText}` : `## ${heading}`];

  if (entry.status === 'human_required') {
    lines.push('Нужно решение человека.');
  }
  if (entry.selectionLabels.length) {
    lines.push(`Выбрано: ${entry.selectionLabels.join('; ')}`);
  }
  if (entry.text) {
    lines.push(entry.text);
  }
  if (entry.proof.length) {
    lines.push(`Основание: ${entry.proof.join('; ')}`);
  }
  if (lines.length === 1) {
    lines.push('Ответ без текста и выбранного варианта.');
  }

  return lines.join('\n');
}

export class Analyzer {
  config: AnalyzerConfig;

  claudeAuth: any;

  b24: any;

  factoryState: any;

  prefs: any;

  log: any;

  // Разворот телеграм-ссылок. Ссылка ЛЕНИВАЯ: анализатор создаётся в `app.js` раньше,
  // чем регистрируется модуль telegram с его декоратором, — функция обязана искать
  // декоратор в момент вызова, а не при сборке.
  discussion: any;

  pluginEnabled: (id: string) => boolean;

  pluginSettings: (id: string) => Record<string, unknown>;

  providerRegistry: () => Promise<any>;

  executorFor: (provider: string) => Promise<any>;

  dir: string;

  _queue: string[];

  _jobs: Map<string, 'queued' | 'running'>;

  _profile: (TriageProfile & { name: string }) | null;

  _started: boolean;

  _ready: Promise<void>;

  _gitRefresh?: unknown;

  _legacyMigrationUnavailable?: boolean;

  _diffCache?: Map<string, { at: number; files: Set<string> | null }>;

  _active?: number;

  _lastRefreshAt?: number;

  onAnalyzed?: ((id: string) => unknown) | null;

  constructor({
    config, claudeAuth, b24, factoryState, prefs, log, discussion,
    pluginEnabled, pluginSettings, providerRegistry, executorFor,
  }: AnalyzerOptions) {
    this.config = config;
    this.claudeAuth = claudeAuth;
    this.b24 = b24;
    this.factoryState = factoryState;
    this.prefs = prefs;
    this.log = log;
    this.discussion = discussion || null;
    this.pluginEnabled = pluginEnabled || (() => true);
    this.pluginSettings = pluginSettings || (() => ({
      triageModel: null,
      autoArbitrate: false,
    }));
    this.providerRegistry = providerRegistry || (async () => ({}));
    this.executorFor = executorFor || (async () => null);
    this.dir = config.analysisDir;
    this._queue = [];
    this._jobs = new Map(); // id → 'queued' | 'running'
    this._profile = null;   // кеш профиля триажа
    this._started = false;
    this._ready = this._init();
  }

  async _init() {
    await fs.mkdir(this.dir, { recursive: true });
    // Осиротевшие .tmp атомарной записи (умерли между write и rename) — мусор.
    for (const f of await fs.readdir(this.dir)) {
      if (f.endsWith('.json.tmp')) await fs.rm(path.join(this.dir, f), { force: true }).catch(() => {});
    }
    await this._sweepOrphans();
  }

  /**
   * Завершает одноразовую миграцию старого env-алиаса и только после неё разрешает
   * восстановленной очереди запускать модели через живые зависимости приложения.
   */
  async start() {
    await this._ready;
    await this._migrateLegacyModel();
    this._started = true;
    this._pump();
    return { ok: true };
  }

  async _migrateLegacyModel() {
    if (!this.prefs?.write) {
      return;
    }
    const stored = this.prefs.readStored?.() || this.prefs.read?.() || {};
    const analysis = stored.pluginSettings?.analysis || {};
    if (Object.hasOwn(analysis, 'triageModel')) {
      return;
    }

    const registry = await this.providerRegistry();
    const legacy = process.env.COCKPIT_ANALYSIS_MODEL || 'sonnet';
    const resolved = resolveLegacyModel(legacy, { claude: registry?.claude || [] });
    this._legacyMigrationUnavailable = !resolved.ok;
    const next = {
      ...analysis,
      triageModel: resolved.ok ? (resolved as { modelRef?: unknown }).modelRef ?? null : null,
    };
    this.prefs.write({
      pluginSettings: {
        ...(stored.pluginSettings || {}),
        analysis: next,
      },
    });
  }

  /**
   * Незавершённые статусы прошлой жизни сервера. Агент — отдельный процесс: рестарт
   * сервера его не убивает, и результат он мог дописать. Файл анализа свежее старта
   * прогона → done (без обогащения), иначе:
   *   • queued  → ВОССТАНАВЛИВАЕМ в очередь (задачи ставили осознанно, рестарт
   *     сервера не повод терять их и заставлять перезапускать 70 штук руками);
   *   • running → interrupted (агент реально прерван — перезапуск вручную из топбара).
   */
  async _sweepOrphans() {
    const requeue = [];
    for (const f of await fs.readdir(this.dir)) {
      if (!/^t\d+\.status\.json$/.test(f)) continue;
      const p = path.join(this.dir, f);
      try {
        const st = JSON.parse(await fs.readFile(p, 'utf8'));
        if (st.state !== 'queued' && st.state !== 'running') continue;
        const jsonStat = await fs.stat(this._paths(st.task).json).catch(() => null);
        if (jsonStat && st.startedAt && jsonStat.mtimeMs > st.startedAt) {
          await this._writeStatus(st.task, { ...st, state: 'done', note: 'дописан агентом после рестарта сервера', finishedAt: Date.now() });
        } else if (st.state === 'queued') {
          requeue.push({ id: String(st.task), at: st.queuedAt || 0 });
        } else {
          await this._writeStatus(st.task, {
            ...st,
            state: 'interrupted',
            error: 'агент прерван рестартом сервера',
            finishedAt: Date.now(),
          });
        }
      } catch { /* битый статус не мешает остальным */ }
    }
    if (requeue.length) {
      requeue.sort((a, b) => a.at - b.at);
      for (const r of requeue) {
        if (this._jobs.has(r.id)) continue;
        this._jobs.set(r.id, 'queued');
        this._queue.push(r.id);
      }
      this.log?.info({ count: requeue.length }, 'триаж: очередь восстановлена после рестарта');
    }
  }

  _paths(id: string | number) {
    return {
      json: path.join(this.dir, `t${id}.analysis.json`),
      note: path.join(this.dir, `t${id}.md`),
      status: path.join(this.dir, `t${id}.status.json`),
      log: path.join(this.dir, `t${id}.log`),
      clarify: path.join(this.dir, `t${id}.clarify.md`),
    };
  }

  /**
   * Локальные уточнения человека к задаче. НЕ комментарии B24: те видит заказчик,
   * а рабочие пояснения (ответы на вопросы триажа, скрины) — внутренняя кухня.
   * Файл накапливается append'ом; его читают триаж и запуск конвейера.
   */
  async readClarifications(id: string | number): Promise<string> {
    try { return await fs.readFile(this._paths(id).clarify, 'utf8'); } catch { return ''; }
  }

  async readClarificationEntries(id: string | number): Promise<AnalysisClarificationEntry[]> {
    return clarificationEntries(await this.readClarifications(id));
  }

  /**
   * Открытые вопросы (questions) и технические неизвестные (unknowns) последнего
   * триажа. Это мост «триаж → конвейер»: запуск вклеивает их в тикет, и планировщик
   * начинает с них (секция «## Открытые решения»), а не переспрашивает человека с нуля.
   */
  async readOpenQuestions(id: string | number) {
    const analysis = await this._readJson(this._paths(id).json);
    if (!analysis) return null;
    const clean = (v: unknown) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()) : []);
    const answered = await this.answeredQuestions(id);
    const questions = normalizeAnalysisQuestions(analysis.questions)
      .filter((question) => !answered.ids.has(question.id) && !answered.keys.has(questionKey(question.text)))
      .map((question) => question.text);
    const unknowns = clean(analysis.unknowns);
    return questions.length || unknowns.length ? { questions, unknowns } : null;
  }

  /**
   * Что по задаче уже решено. Отвеченным вопрос считается и по идентификатору, и по
   * смыслу текста: заход триажа переписывает questions[] целиком, и без второго ключа
   * тот же вопрос в новой формулировке снова открыт, а ответ человека потерян.
   */
  async answeredQuestions(id: string | number): Promise<{ ids: Set<string>; keys: Set<string> }> {
    const entries = (await this.readClarificationEntries(id))
      .filter((entry) => entry.status === 'answered');

    return {
      ids: new Set(entries.map((entry) => entry.questionId)),
      keys: new Set(entries.map((entry) => questionKey(entry.questionText)).filter(Boolean)),
    };
  }

  /**
   * Закрытые вопросы прошлых заходов парами «вопрос → ответ» для промпта триажа.
   * Без них разведчик видит в уточнениях только реплики без вопросов и штатно задаёт
   * те же вопросы снова. Записи без сохранённого текста вопроса (старые файлы) сюда
   * не попадают: пара без вопроса промпту бесполезна.
   */
  async readAnsweredQuestions(id: string | number): Promise<TriageAnsweredQuestion[]> {
    const answers: TriageAnsweredQuestion[] = [];
    for (const entry of await this.readClarificationEntries(id)) {
      if (entry.status !== 'answered' || !entry.questionText) {
        continue;
      }
      const answer = [
        entry.selectionLabels.length ? `Выбрано: ${entry.selectionLabels.join('; ')}` : '',
        entry.text,
        entry.proof.length ? `Основание: ${entry.proof.join('; ')}` : '',
      ].filter(Boolean).join('. ');
      if (!answer) {
        continue;
      }
      answers.push({ question: entry.questionText, answer, actor: entry.actor });
    }
    return answers;
  }

  async appendClarification(id: string | number, text: string): Promise<string> {
    const stamp = new Date().toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
    const cur = await this.readClarifications(id);
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this._paths(id).clarify, `${cur}${cur ? '\n' : ''}## ${stamp}\n${text.trim()}\n`);
    return this.readClarifications(id);
  }

  /**
   * Сервер сверяет вопрос, варианты и token вложения с текущей оценкой, сам назначает
   * actor/status и дописывает единственный локальный clarification markdown.
   */
  async appendClarificationBatch(
    id: string | number,
    answers: ClarificationAnswer[],
    { actor = 'human' }: { actor?: 'human' | 'cockpit-arbiter' } = {},
  ): Promise<ClarificationBatchResult> {
    const analysis = await this._readJson(this._paths(id).json);
    const questions = new Map(
      normalizeAnalysisQuestions(analysis?.questions).map((question) => [question.id, question]),
    );
    if (!Array.isArray(answers) || !answers.length) {
      return { ok: false, error: 'empty_answers' };
    }

    const entries: AnalysisClarificationEntry[] = [];
    for (const answer of answers) {
      const question = questions.get(boundedText(answer?.questionId, 100));
      if (!question) {
        return { ok: false, error: 'invalid_question' };
      }
      const allowedOptions = new Set(question.options.map((option) => option.id));
      const selection = Array.isArray(answer?.optionIds)
        ? answer.optionIds.map((value) => boundedText(value, 100)).filter(Boolean)
        : [];
      if (selection.some((optionId) => !allowedOptions.has(optionId))) {
        return { ok: false, error: 'invalid_option' };
      }

      const attachments = [];
      for (const attachment of Array.isArray(answer?.attachments) ? answer.attachments : []) {
        if (Object.hasOwn(attachment || {}, 'path')) {
          return { ok: false, error: 'invalid_attachment' };
        }
        const resolved = await resolveChatAttachment(
          path.join(this.config.chatsDir || '', 'attachments'),
          attachment?.file,
        );
        if (!resolved) {
          return { ok: false, error: 'invalid_attachment' };
        }
        attachments.push({
          file: resolved.file,
          name: boundedText(attachment?.name, 180) || resolved.file,
        });
      }

      const machine = actor === 'cockpit-arbiter';
      const status = machine && answer?.status === 'human_required'
        ? 'human_required'
        : 'answered';
      const selectionLabels = selection
        .map((optionId) => question.options.find((option) => option.id === optionId)?.label || '')
        .filter(Boolean);
      entries.push({
        id: boundedText(answer?.id, 100) || `answer-${randomUUID()}`,
        questionId: question.id,
        questionText: question.text,
        actor: machine ? 'cockpit-arbiter' : 'human',
        status,
        selection,
        selectionLabels,
        text: status === 'human_required' ? '' : boundedText(answer?.text, 6000),
        attachments,
        proof: machine && Array.isArray(answer?.proof)
          ? answer.proof.map((value: unknown) => boundedText(value, 500)).filter(Boolean)
          : [],
      });
    }

    const current = await this.readClarifications(id);
    const blocks = entries.map((entry: AnalysisClarificationEntry) => {
      const heading = entry.actor === 'cockpit-arbiter'
        ? 'Разбор арбитра — машинный'
        : 'Ответ человека';
      const marker = Buffer.from(JSON.stringify(entry)).toString('base64url');
      return `${clarificationBlock(entry, heading)}\n<!-- cockpit-clarification:v1 ${marker} -->`;
    });
    const next = `${current}${current ? '\n' : ''}${blocks.join('\n\n')}\n`;
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this._paths(id).clarify, next);
    return { ok: true, text: next, entries };
  }

  async _writeStatus(id: string | number, st: Record<string, unknown>): Promise<void> {
    const p = this._paths(id).status;
    await fs.writeFile(p + '.tmp', JSON.stringify({ task: Number(id), ...st }, null, 2));
    await fs.rename(p + '.tmp', p);
  }

  async _readJson(p: string): Promise<any> {
    try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; }
  }

  async profile() {
    if (!this._profile) {
      const name = this.config.factoryProfile
        || (await this.factoryState.primaryProfile().catch(() => '')) || '';
      this._profile = { name, ...await loadTriageProfile(this.config, name) };
    }
    return this._profile;
  }

  /**
   * Опубликованный каталог маршрутов профиля. Он нужен дважды: промпту — чтобы триаж
   * не называл род работы, которого у профиля нет, и политике — чтобы не рекомендовать
   * маршрут, которого движок не примет. Каталога нет — просто работаем без рекомендации.
   */
  async _routeCatalog(profileName: string): Promise<any> {
    if (!profileName || typeof this.factoryState?.catalog !== 'function') {
      return null;
    }
    try {
      return await this.factoryState.catalog(profileName);
    } catch {
      return null;
    }
  }

  /** Сводка по всем анализам: оценки + статусы (для бейджей доски). */
  async list(): Promise<AnalysisRow[]> {
    await this._ready;
    const byTask = new Map<string, AnalysisRow>();
    for (const f of await fs.readdir(this.dir)) {
      const m = f.match(/^t(\d+)\.(analysis|status)\.json$/);
      if (!m) continue;
      const id = String(m[1]);
      const row: AnalysisRow = byTask.get(id) || { task: Number(id), analysis: null, status: null };
      const data = await this._readJson(path.join(this.dir, f));
      if (data) {
        // Вопросы нормализуются и здесь: у списка и у детали одна форма ответа,
        // иначе бейдж доски читал бы сырой ответ модели, а карточка — разобранный.
        if (m[2] === 'analysis') {
          row.analysis = {
            ...data,
            questions: normalizeAnalysisQuestions(data.questions),
            scope: normalizeAnalysisScope(data.scope),
          };
        } else {
          row.status = data;
        }
      }
      byTask.set(id, row);
    }
    // Живые статусы очереди поверх файлов (queued ещё не имеет файла).
    for (const [id, state] of this._jobs) {
      const row: AnalysisRow = byTask.get(String(id))
        || { task: Number(id), analysis: null, status: null };

      row.status = { ...(row.status || {}), task: Number(id), state } as AnalysisStatus;
      byTask.set(String(id), row);
    }
    return [...byTask.values()].sort((a, b) => b.task - a.task);
  }

  /** Деталь одного анализа: оценки + разведнота + статус + протухание. */
  async get(id: string | number): Promise<AnalysisDetail> {
    await this._ready;
    const p = this._paths(id);
    const [analysis, status] = await Promise.all([this._readJson(p.json), this._readJson(p.status)]);
    let note = null;
    try { note = await fs.readFile(p.note, 'utf8'); } catch { /* разведноты может не быть */ }
    const live = this._jobs.get(String(id));
    const normalizedAnalysis = analysis ? {
      ...analysis,
      questions: normalizeAnalysisQuestions(analysis.questions),
      scope: normalizeAnalysisScope(analysis.scope),
    } : analysis;
    return {
      task: Number(id),
      analysis: normalizedAnalysis,
      note,
      stale: normalizedAnalysis ? await this._staleFiles(normalizedAnalysis) : null,
      status: live ? { ...(status || {}), task: Number(id), state: live } : status,
    };
  }

  /**
   * Протухание анализа: какие из его files[] изменились в репо с момента оценки.
   * Движение master само по себе не сигнал (коммиты летят часто) — сигнал только
   * пересечение диффа с файлами, на которые опирается оценка.
   */
  async _staleFiles(analysis: any): Promise<string[]> {
    const out: string[] = [];
    const repos: Record<string, { dir?: string; sha?: string }> = analysis.repos || {};
    for (const [key, r] of Object.entries(repos)) {
      if (!r?.sha || !r?.dir) continue;
      const changed = await this._changedSince(r.dir, r.sha);
      if (!changed) continue;
      const mine: string[] = (analysis.files || [])
        .filter((f: unknown) => String(f).startsWith(key + ':'))
        .map((f: unknown) => String(f).slice(key.length + 1));
      out.push(...mine.filter((f) => changed.has(f)).map((f) => `${key}:${f}`));
    }
    return out;
  }

  /** Изменённые файлы sha..HEAD с кешем: анализы одной волны делят один SHA. */
  async _changedSince(dir: string, sha: string): Promise<Set<string> | null> {
    const key = `${dir}|${sha}`;
    const hit = this._diffCache?.get(key);
    if (hit && Date.now() - hit.at < 120000) return hit.files;
    const files = await new Promise<Set<string> | null>((resolve) => {
      execFile('git', ['-C', dir, 'diff', '--name-only', `${sha}..HEAD`], { timeout: 10000, maxBuffer: 8 * 1024 * 1024 },
        (err, out) => resolve(err ? null : new Set(out.split('\n').filter(Boolean))));
    });
    this._diffCache = this._diffCache || new Map();
    this._diffCache.set(key, { at: Date.now(), files });
    return files;
  }

  /** Скрыть прерванный/упавший статус (решение «не перезапускать»). Живые задачи не трогаем. */
  async dismiss(id: string | number): Promise<QueueResult> {
    await this._ready;
    id = String(id);
    if (this._jobs.has(id)) return { outcome: 'busy' };
    await fs.rm(this._paths(id).status, { force: true });
    return { outcome: 'dismissed' };
  }

  /** Поставить задачу в очередь анализа. Дедуп: уже queued/running → не дублируем. */
  async enqueue(id: string | number): Promise<QueueResult> {
    await this._ready;
    id = String(id);
    if (!this.pluginEnabled('analysis')) {
      return { outcome: 'plugin_disabled' };
    }
    if (this._jobs.has(id)) {
      return {
        outcome: this._jobs.get(id) === 'running' ? 'already_running' : 'already_queued',
      };
    }
    this._jobs.set(id, 'queued');
    this._queue.push(id);
    await this._writeStatus(id, { state: 'queued', queuedAt: Date.now() });
    this._pump();
    return { outcome: 'queued', position: this._queue.length };
  }

  _pump() {
    if (!this.pluginEnabled('analysis')) {
      return;
    }
    // Конкуренция настраиваемая: большая очередь при одном воркере обрабатывается часами.
    const max = Math.max(1, Number(this.config.analysisConcurrency) || 1);
    this._active = this._active || 0;
    while (this._active < max && this._queue.length) {
      const id = String(this._queue.shift() ?? '');
      this._active += 1;
      let result: { ok: boolean } | null = null;
      this.analyze(id)
        .then((value) => {
          result = value;
        })
        .catch((e: unknown) => this.log?.error(
          { task: id, err: failureText(e) },
          'триаж упал вне раннера',
        ))
        .finally(() => {
          this._jobs.delete(id);
          this._active = (this._active ?? 1) - 1;
          this._pump();
          if (result?.ok) {
            Promise.resolve(this.onAnalyzed?.(id)).catch((error: unknown) => {
              this.log?.warn(
                { task: id, err: failureText(error) },
                'авторазбор вопросов не запущен',
              );
            });
          }
        });
    }
  }

  pluginToggled(enabled: boolean): void {
    if (enabled) {
      this._pump();
    }
  }

  /** Полный цикл анализа одной задачи (используется очередью и CLI). */
  async analyze(id: string | number): Promise<{ ok: boolean; error?: unknown }> {
    await this._ready;
    id = String(id);
    const p = this._paths(id);
    const startedAt = Date.now();
    if (!this.pluginEnabled('analysis')) {
      return { ok: false, error: 'plugin_disabled' };
    }
    this._jobs.set(id, 'running');
    await this._writeStatus(id, { state: 'running', startedAt });
    let staging = null;
    try {
      const selected = await this._resolveRunSelection();
      if (!selected.ok) {
        throw Object.assign(new Error(selected.error), { analysisCode: selected.error });
      }
      const profile = await this.profile();
      // Оцениваем свежий код: перед запуском подтягиваем изменения (правило кокпита,
      // выключается в настройках). Безопасно: ff-only и только чистый master.
      let gitRefresh = null;
      // Не чаще раза в 10 минут: волна из десятков задач не должна дёргать pull
      // на каждую (и параллельные воркеры не гоняют git по одному репо разом).
      if (this.prefs?.read().gitRefreshBeforeRun
          && (!this._lastRefreshAt || Date.now() - this._lastRefreshAt > 10 * 60_000)) {
        this._lastRefreshAt = Date.now();
        gitRefresh = await refreshRepos(profile.repos);
        this.log?.info({ task: id, gitRefresh }, 'репозитории обновлены перед триажем');
      }
      this._gitRefresh = gitRefresh;
      const ticket = await this._fetchTicket(id);
      staging = await fs.mkdtemp(path.join(this.dir, `.t${id}.run-`));
      const inputDir = path.join(staging, 'input');
      const outputDir = path.join(staging, 'output');
      await Promise.all([
        fs.mkdir(inputDir),
        fs.mkdir(outputDir),
      ]);
      const clarifications = await this._materializeClarifications(id, inputDir);
      const outputJson = path.join(outputDir, `t${id}.analysis.json`);
      const outputNote = path.join(outputDir, `t${id}.md`);
      const catalog = await this._routeCatalog(profile.name);
      const prompt = buildTriagePrompt({
        task: id,
        title: ticket.title,
        description: ticket.description,
        comments: ticket.comments,
        clarifications,
        answered: await this.readAnsweredQuestions(id),
        discussion: await this._discussion(id, ticket),
        profile,
        routeChoice: {
          kinds: parseRouteMap(profile.routeMap).kinds,
          routes: (catalog?.routes || []).map((routeId: string) => ({
            id: routeId,
            title: catalog.routeOptions?.[routeId]?.title || '',
          })),
        },
        jsonPath: outputJson,
        notePath: outputNote,
      });
      const readableRoots = await this._readableRoots(profile, inputDir);
      const workspaceAccess = {
        readableRoots,
        writableRoots: [await fs.realpath(outputDir)],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
        allowExternalMcp: false,
        allowBash: false,
        tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'repo_history'],
      };
      const workTools = createRepoHistoryTools(profile.repos || []);
      const workIpc = selected.executor.workToolsTransport === 'mcp'
        ? await createWorkIpc({ workTools, root: staging })
        : null;
      let run;
      try {
        run = await selected.executor.run({
          config: this.config,
          env: this.claudeAuth ? this.claudeAuth.env() : process.env,
          message: prompt,
          prompt,
          cwd: outputDir,
          model: selected.model,
          effort: selected.effort,
          sessionId: null,
          permissionMode: 'acceptEdits',
          providerSettings: this.prefs?.read?.().providerSettings?.[String(selected.provider)] || {},
          workspaceAccess,
          workTools,
          ...(workIpc ? { mcpConfig: { mcpServers: { 'cockpit-work': workIpc.mcpServer } } } : {}),
        });
      } finally {
        await workIpc?.close().catch(() => {});
      }
      const analysis = await this._readJson(outputJson);
      if (!analysis || Number(analysis.task) !== Number(id)) {
        throw new Error(`агент не записал валидный ${path.basename(outputJson)}`);
      }
      const normalized = {
        ...analysis,
        task: Number(id),
        questions: normalizeAnalysisQuestions(analysis.questions),
        scope: normalizeAnalysisScope(analysis.scope),
      };
      await this._enrich(outputJson, normalized, {
        ticket,
        profile,
        catalog,
        run,
        startedAt,
        selected,
      });
      await fs.rename(outputJson, p.json);
      if (await fs.stat(outputNote).then(() => true, () => false)) {
        await fs.rename(outputNote, p.note);
      }
      await this._writeStatus(id, { state: 'done', startedAt, finishedAt: Date.now(), durationMs: Date.now() - startedAt });
      this.log?.info({ task: id, ms: Date.now() - startedAt, cost: run.cost }, 'триаж готов');
      return { ok: true };
    } catch (e) {
      const failure = e !== null && typeof e === 'object' ? e as { analysisCode?: unknown } : {};
      const error = failure.analysisCode || failureText(e).slice(0, 600);
      await this._writeStatus(id, { state: 'failed', startedAt, finishedAt: Date.now(), error });
      this.log?.warn({ task: id, err: failureText(e) }, 'триаж упал');
      return { ok: false, error };
    } finally {
      if (staging) {
        await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  async _resolveRunSelection() {
    const setting = this.pluginSettings('analysis')?.triageModel;
    if (!setting) {
      return {
        ok: false,
        error: this._legacyMigrationUnavailable
          ? 'analysis_model_unavailable'
          : 'analysis_model_unset',
      };
    }

    const registry = await this.providerRegistry();
    const resolved = resolveModelRef(setting, registry) as {
      ok: boolean;
      modelRef?: { provider: string; model: string };
      model?: { efforts?: unknown };
    };
    if (!resolved.ok || !resolved.modelRef) {
      return { ok: false, error: 'analysis_model_unavailable' };
    }
    const executor = await this.executorFor(resolved.modelRef.provider);
    if (!await supportsScopedWorkspace(executor, this.config)) {
      return { ok: false, error: 'analysis_model_unsafe' };
    }

    const efforts: unknown[] | null = Array.isArray(resolved.model?.efforts)
      ? resolved.model.efforts
      : null;
    const requestedEffort = boundedText((setting as { effort?: unknown }).effort, 80) || null;
    const effort = requestedEffort && efforts?.includes(requestedEffort) ? requestedEffort : null;
    return {
      ok: true,
      provider: resolved.modelRef.provider,
      model: resolved.modelRef.model,
      effort,
      warning: requestedEffort && effort === null ? 'analysis_effort_unavailable' : null,
      executor,
    };
  }

  async _readableRoots(profile: TriageProfile, inputDir: string): Promise<string[]> {
    const values = [
      profile.cwd,
      ...(profile.dirs || []),
      ...(profile.repos || []).map((repo) => repo.dir),
      inputDir,
    ].filter(Boolean);
    const roots: string[] = [];
    for (const value of values) {
      const canonical = await fs.realpath(value).catch(() => null);
      if (canonical && !roots.includes(canonical)) {
        roots.push(canonical);
      }
    }
    return roots;
  }

  /**
   * К конкретному запуску копируются только token-ы из локальных server-owned marker-ов.
   * В prompt попадает путь копии; общий каталог вложений исполнителю не раскрывается.
   */
  async _materializeClarifications(id: string | number, inputDir: string): Promise<string> {
    const markdown = await this.readClarifications(id);
    const lines = [];
    const root = path.join(this.config.chatsDir || '', 'attachments');
    const copyResolved = async (
      resolved: { file: string; path: string },
      requestedName?: unknown,
    ) => {
      const name = path.basename(String(requestedName || resolved.file));
      const safeName = name && name !== '.' && name !== '..' ? name : resolved.file;
      let target = path.join(inputDir, safeName);
      if (await fs.stat(target).then(() => true, () => false)) {
        target = path.join(inputDir, `${lines.length + 1}-${safeName}`);
      }
      await fs.copyFile(resolved.path, target);
      lines.push(`[приложено фото: ${target}]`);
    };
    for (const entry of clarificationEntries(markdown)) {
      for (const attachment of entry.attachments) {
        const resolved = await resolveChatAttachment(root, attachment.file);
        if (!resolved) {
          lines.push('[вложение недоступно]');
          continue;
        }
        await copyResolved(resolved, attachment.name);
      }
    }

    const legacy = /\[приложено фото:\s*([^\]\n]+)\]/g;
    let sanitized = '';
    let cursor = 0;
    for (const match of String(markdown || '').matchAll(legacy)) {
      sanitized += String(markdown).slice(cursor, match.index);
      const resolved = await resolveLegacyChatAttachment(root, match[1]);
      if (resolved) {
        await copyResolved(resolved, resolved.file);
        sanitized += `[старое вложение: ${resolved.file}]`;
      } else {
        sanitized += '[вложение недоступно]';
      }
      cursor = match.index + match[0].length;
    }
    sanitized += String(markdown || '').slice(cursor);
    if (lines.length) {
      sanitized += `${sanitized ? '\n' : ''}${lines.join('\n')}`;
    }
    return sanitized;
  }

  /** Тикет из B24: заголовок + описание + несистемные комментарии. Комментарии — best effort. */
  async _fetchTicket(id: string | number): Promise<any> {
    const detail = await this.b24.taskDetail(id);
    let comments = [];
    try {
      const page = await this.b24.taskPageData(id);
      comments = (page.comments || []).filter((c: any) => !c.isSystem && c.text);
    } catch (e) {
      this.log?.warn(
        { task: id, err: failureText(e) },
        'комментарии задачи не получены — триаж без них',
      );
    }
    return {
      title: detail?.title || `Задача ${id}`,
      description: htmlToText(detail?.description || ''),
      comments,
    };
  }

  /**
   * Переписка по телеграм-ссылкам из тикета — отдельным блоком промпта.
   *
   * Ради этого места разворот и затевался: в рубрике прямым текстом сказано
   * «есть недоступные ссылки t.me — ставь confidence low», то есть задача, вся
   * суть которой лежит в чате, приезжала оценщику заведомо мутной.
   *
   * Оценка задачи не зависит от исправности телеграма: любой отказ здесь — это
   * триаж без переписки, а не упавший триаж.
   */
  async _discussion(id: string | number, ticket: any): Promise<string> {
    if (typeof this.discussion !== 'function') return '';
    const source = [
      ticket.title,
      // Снимаем уже вставленную секцию: цитаты в ней несут те же ссылки, и без
      // этого разворот пережёвывал бы собственный вывод.
      stripDiscussionSection(String(ticket.description || '')),
      ...(ticket.comments || []).map((c: any) => String(c.text || '')),
    ].filter(Boolean).join('\n');
    if (!source.trim()) return '';
    try {
      const view = await this.discussion(source, { project: await this._taskProject(id) });
      return view?.text || '';
    } catch (e) {
      this.log?.warn(
        { task: id, err: failureText(e) },
        'триаж: разворот телеграм-ссылок не удался',
      );
      return '';
    }
  }

  /**
   * Проект задачи для allowlist — профиль её ПРОГОНА, как в чате и в тикете.
   *
   * В триаже реестра обычно ещё нет: задачу оценивают до запуска. Это значит
   * «проект неизвестен» — остаётся голый allowlist, и чат обязан быть привязан
   * хоть к чему-то. Брать сюда профиль триажа нельзя: он выводится из активных
   * задач (`primaryProfile`), то есть граница безопасности зависела бы от того,
   * что сейчас бежит на конвейере.
   */
  async _taskProject(id: string | number): Promise<any> {
    try {
      const { registry } = await this.factoryState.readRegistry(id);
      return String(registry?.PROFILE || '').trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Дописывает в analysis.json то, что агенту знать неоткуда: SHA репо, стоимость, время
   * и рекомендацию маршрута. Маршрут именно здесь, а не в промпте: род работы называет
   * модель, глубину считает политика по её же оценкам, а имена маршрутов знает профиль.
   * Профиль и hash каталога уезжают в файл, чтобы устаревшая рекомендация не применялась
   * к другому каталогу молча.
   */
  async _enrich(
    jsonPath: string,
    analysis: any,
    { ticket, profile, catalog, run, startedAt, selected }: {
      ticket: any;
      profile: TriageProfile;
      catalog: any;
      run: any;
      startedAt: number;
      selected: any;
    },
  ): Promise<void> {
    const repos: Record<string, { dir: string; sha: string | null }> = {};
    for (const r of profile.repos) {
      repos[r.key] = { dir: r.dir, sha: await gitSha(r.dir) };
    }
    const decision = resolveRoute(analysis, {
      routeMap: profile.routeMap,
      routes: catalog?.routes || [],
    });
    const enriched = {
      ...analysis,
      ...(decision.kind ? { route_kind: decision.kind } : {}),
      // route_guess остаётся именем поля для формы запуска и старых оценок, но теперь
      // это результат политики, а не свободная догадка модели.
      ...(decision.route ? { route_guess: decision.route } : {}),
      route_depth: decision.depth,
      route_reason: decision.reason,
      ...(catalog
        ? { route_profile: profileName(profile), route_catalog_hash: catalog.catalogHash }
        : {}),
      title: ticket.title,
      generated_at: new Date().toISOString(),
      repos,
      meta: {
        provider: selected.provider,
        model: run.actualModel || selected.model,
        effort: selected.effort,
        ...(run.actualModel && run.actualModel !== selected.model
          ? { requestedModel: selected.model }
          : {}),
        ...(selected.warning ? { warning: selected.warning } : {}),
        duration_ms: Date.now() - startedAt,
        cost_usd: run.cost ?? run.costUsd ?? null,
        context_tokens: run.contextTokens ?? null,
        git_refresh: this._gitRefresh,
      },
    };
    await fs.writeFile(jsonPath, JSON.stringify(enriched, null, 2));
  }
}

function gitSha(dir: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, 'rev-parse', 'HEAD'], { timeout: 5000 }, (err, out) => {
      resolve(err ? null : out.trim());
    });
  });
}

/** Описание задачи приходит HTML'ом Битрикса — сводим к тексту для промпта. */
function htmlToText(s: unknown): string {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

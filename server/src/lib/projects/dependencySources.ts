// Связи проекта, живущие вне файла настроек: правила Telegram и GitHub и записи знаний.
//
// Реестр проектов не знает, кто на проект ссылается, — об этом отвечает сам раздел.
// Правила лежат в контексте подключённого аккаунта и берутся под lease, записи знаний —
// в своей базе. Отсюда главное правило этого модуля: «связей нет» и «проверить не
// удалось» — разные ответы. Первое разрешает архив, второе обязано его запретить,
// поэтому отказ чтения пробрасывается наружу, а не превращается в ноль.
//
// Наружу уходит только число. Адреса чатов, имена репозиториев и заголовки записей —
// runtime-данные соседних разделов, и сводке проекта они не нужны.

/** Найденные связи: сводке хватает числа, список имён здесь всегда пуст. */
export interface DependencyCount {
  count: number;
  items: string[];
}

interface RuleRow {
  project?: unknown;
}

interface RulesLease {
  context?: { rules?: { read?: () => Promise<unknown> } } | null;
  isCurrent?: () => boolean;
  release?: () => unknown;
}

/** Порт аккаунта: состояние подключения и lease с правилами этого аккаунта. */
export interface RulesConnectionPort {
  status: () => Promise<{ configured?: unknown; connection?: unknown }>;
  acquireLease?: () => RulesLease | Promise<RulesLease>;
  acquireInboxLease?: () => RulesLease | Promise<RulesLease>;
}

/** Порт знаний: нужен ровно один метод — список записей проекта. */
export interface KnowledgeListPort {
  list: (input: { project: string; limit?: number }) => Promise<unknown>;
}

// Сколько записей знаний считать: больше тысячи хранилище всё равно не отдаёт, а
// сводке важно «есть и сколько примерно», а не точное число за пределами лимита.
const KNOWLEDGE_LIMIT = 1000;

function accountChanged(): Error {
  return new Error('Аккаунт сменился, пока читались правила: связи не проверены.');
}

function rulesOf(value: unknown): RuleRow[] {
  return Array.isArray(value) ? value as RuleRow[] : [];
}

/**
 * Счёт правил аккаунта под его lease. Lease берётся только у подключённого аккаунта:
 * у неподключённого правила не работают, и держать из-за них проект в активных незачем.
 * Протухший между взятием и чтением lease означает смену аккаунта — снимку уже не верим.
 */
async function countRules(
  acquire: () => RulesLease | Promise<RulesLease>,
  connection: RulesConnectionPort,
  id: string,
): Promise<DependencyCount> {
  const state = await connection.status();

  if (state?.configured !== true) {
    return { count: 0, items: [] };
  }

  const lease = await acquire();

  try {
    if (lease?.isCurrent?.() === false) {
      throw accountChanged();
    }

    const rows = rulesOf(await lease?.context?.rules?.read?.());

    if (lease?.isCurrent?.() === false) {
      throw accountChanged();
    }

    return { count: rows.filter((rule) => rule?.project === id).length, items: [] };
  } finally {
    await lease?.release?.();
  }
}

/** Правила Telegram проекта: их архив пережить не должен — правило осталось бы в никуда. */
export function countTelegramRules(
  connection: RulesConnectionPort,
  id: string,
): Promise<DependencyCount> {
  return countRules(() => connection.acquireLease?.() as RulesLease, connection, id);
}

/** Правила GitHub: тот же счёт, но lease у этого раздела зовётся по-своему. */
export function countGitHubRules(
  connection: RulesConnectionPort,
  id: string,
): Promise<DependencyCount> {
  return countRules(() => connection.acquireInboxLease?.() as RulesLease, connection, id);
}

/**
 * Записи знаний проекта. Недоступное хранилище — отказ проверки, а не ноль: знания
 * переживают архив, и прятать проект, не зная про его записи, нельзя.
 */
export async function countKnowledgeRecords(
  knowledge: KnowledgeListPort,
  id: string,
): Promise<DependencyCount> {
  const found = await knowledge.list({ project: id, limit: KNOWLEDGE_LIMIT });
  const items = (found as { items?: unknown } | null)?.items;

  return { count: Array.isArray(items) ? items.length : 0, items: [] };
}

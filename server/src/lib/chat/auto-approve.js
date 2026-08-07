// Кокпит-политика «авто» для исполнителей, чьи разрешения проходят через кокпит:
// Kimi (ACP-сессия остаётся в режиме `default` и продолжает спрашивать через
// session/request_permission) и Ollama (инструменты исполняет сам кокпит). Отвечает
// на запросы этот классификатор: безопасные действия разрешаются молча,
// деструктивные и неизвестные уходят человеку во всплывашку.
//
// Словарь действий один — ACP `toolCall.kind`; исполнитель обязан лишь назвать свой
// вызов одним из этих типов, а не заводить вторую политику рядом.
//
// ВАЖНО: это UX-политика, а не security boundary. У Kimi настоящая граница —
// contained runtime (bwrap + cgroup + egress allowlist): запись ограничена workspace,
// сети нет, credentials недоступны. У Ollama — realpath-песочница путей (см.
// executors/_ollama-tools.js), которая, однако, НЕ распространяется на `bash`.
// Обфусцированную команду классификатор может не узнать — поэтому неизвестные формы
// fail-closed уходят на подтверждение.

// ACP toolCall.kind, которые не меняют состояние либо ограничены workspace.
const SAFE_KINDS = new Set(['read', 'search', 'think', 'fetch', 'edit', 'move']);

// Всегда спрашивать: удаление — ядро деструктивных действий.
const ASK_KINDS = new Set(['delete']);

// Правила по тексту shell-команды. Каждое — повод показать всплывашку человеку.
const DESTRUCTIVE_COMMAND_RULES = [
  { re: /\brm\b[^|;&\n]*\s-[a-zA-Z]*[rR][a-zA-Z]*\s/, reason: 'рекурсивное удаление (rm -r)' },
  { re: /\brm\b[^|;&\n]*[*?]/, reason: 'удаление по маске (rm *)' },
  { re: /\brm\b[^|;&\n]*\s(--\s+)?([~/]|\.\.)/, reason: 'удаление вне рабочего каталога' },
  { re: /\bgit\s+push\b[^|;&\n]*(--force|--force-with-lease|-f\b)/, reason: 'git push --force' },
  { re: /\bgit\s+reset\s+--hard\b/, reason: 'git reset --hard' },
  { re: /\bgit\s+clean\s+-[a-zA-Z]*[fx]/, reason: 'git clean -f/-x' },
  { re: /\bgit\s+(checkout|restore)\s+(--|\.(\s|$))/, reason: 'откат изменений git checkout/restore' },
  { re: /\bgit\s+branch\s+-[dD]\b/, reason: 'удаление ветки git branch -d/-D' },
  { re: /\bgit\s+(rebase|filter-branch|update-ref\s+-d|reflog\s+expire)\b/, reason: 'перезапись истории git' },
  { re: /\b(dd|mkfs|mke2fs|shred|wipe)\b/, reason: 'низкоуровневая запись/затирание' },
  { re: /\b(sudo|doas)\b/, reason: 'повышение привилегий' },
  { re: />\s*\/(etc|usr|bin|sbin|boot|lib|dev)\//, reason: 'запись в системный каталог' },
  { re: /\b(chmod|chown)\b[^|;&\n]*-[a-zA-Z]*R[^|;&\n]*\s(\/|~)/, reason: 'рекурсивная смена прав вне workspace' },
  { re: /\b(curl|wget)\b[^|;&\n]*\|\s*(sudo\s+)?(ba|z|da|fi)?sh\b/, reason: 'запуск скрипта из сети' },
  { re: /\b(killall|pkill)\b|\bkill\s+-[A-Z9]+\s+-1\b/, reason: 'массовое завершение процессов' },
  { re: /\bnpm\s+(uninstall|un)\b/, reason: 'удаление пакетов npm' },
];

function commandTextOf(presentation) {
  const parts = [];
  if (typeof presentation?.tool === 'string') parts.push(presentation.tool);
  if (typeof presentation?.input?.description === 'string') parts.push(presentation.input.description);
  const raw = presentation?.raw?.toolCall;
  if (typeof raw?.title === 'string') parts.push(raw.title);
  return parts.filter(Boolean).join('\n');
}

/**
 * Решение авто-режима по presentation исполнителя (у Kimi её строит
 * permissionPresentation() в runtime.js, у Ollama — каталог инструментов).
 * Возвращает { verdict: 'allow' } либо { verdict: 'ask', reason }.
 * Fail-closed: неизвестный kind/пустой запрос → 'ask'.
 */
export function autoDecision(presentation) {
  if (!presentation || presentation.isQuestion) return { verdict: 'ask', reason: 'вопрос агента' };
  const kind = String(presentation?.raw?.toolCall?.kind || '');
  if (ASK_KINDS.has(kind)) return { verdict: 'ask', reason: `удаление (${kind})` };
  if (kind === 'execute') {
    const command = commandTextOf(presentation);
    if (!command.trim()) return { verdict: 'ask', reason: 'пустая команда' };
    const hit = DESTRUCTIVE_COMMAND_RULES.find((rule) => rule.re.test(command));
    if (hit) return { verdict: 'ask', reason: hit.reason };
    return { verdict: 'allow' };
  }
  if (SAFE_KINDS.has(kind)) return { verdict: 'allow' };
  // Неизвестные формы (в т.ч. ещё не снятые живым smoke) — только человеку.
  return { verdict: 'ask', reason: kind ? `неизвестный тип действия (${kind})` : 'тип действия не указан' };
}

// Загрузчик исполнителей (LLM-движков) — МОДУЛЬНОЕ подключение:
// один файл в этой папке = один ИИ. Файл экспортирует default-объект контракта:
//   id       — стабильный ключ (на него ссылаются схемы/чаты)
//   name     — человекочитаемое имя ('GPT (Codex)')
//   vendor   — производитель ('OpenAI')
//   color    — фирменный цвет иконки
//   order    — порядок в списках (меньше = выше)
//   bin(config)              — какой бинарь пробовать
//   probe(config)            — { ok, version } — установлен ли
//   auth(config, deps)       — { mode, label } — авторизован ли
//   efforts?(config)         — динамическое обнаружение уровней эффорта (или null)
//   modes?(config)           — режимы прав: [{ id, label, hint }] (или null)
//   seedModels()             — стартовый список моделей для models.json
//   catalog?(config)         — полный список моделей, поддерживаемых установленным CLI
//                              (обновляется при смене версии; см. models-registry)
//   catalogLive?             — каталог зависит от rollout/аккаунта, опрашивать каждый кэш-цикл
//   usage?()                 — состояние лимитов + provider-neutral account resources
//   usageActions?            — явная Map-подобная таблица разрешённых действий ресурсов
//   updateCmd?               — команда обновления CLI (кнопка «Обновить» в настройках)
//   run(opts)                — выполнить сообщение → { reply, sessionId, contextTokens, cost }
//                              opts.onStep — колбэк живых шагов хода (лента как в VS Code)
// Папка сканируется при старте: новый исполнитель = новый файл, код ядра не трогаем.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));

let loaded = null; // Map id → executor

/**
 * Все исполнители (скан папки, кэш на процесс).
 */
export async function getExecutors() {
  if (loaded) return loaded;
  const map = new Map();
  for (const f of readdirSync(DIR).sort()) {
    // Файлы на `_` — вспомогательные модули исполнителей (каталоги моделей и т.п.), не ИИ.
    if (!f.endsWith('.js') || f === 'index.js' || f.startsWith('_')) continue;
    const mod = await import(pathToFileURL(path.join(DIR, f)).href);
    const ex = mod.default;
    if (ex?.id && typeof ex.run === 'function') map.set(ex.id, ex);
  }
  loaded = new Map([...map.entries()].sort((a, b) => (a[1].order || 99) - (b[1].order || 99)));
  return loaded;
}

/**
 * Один исполнитель по id (null — нет такого).
 */
export async function getExecutor(id) {
  return (await getExecutors()).get(id) || null;
}

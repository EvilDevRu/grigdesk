// Загрузчик исполнителей (LLM-движков) — МОДУЛЬНОЕ подключение:
// один файл в этой папке = один ИИ. Файл экспортирует default-объект контракта:
//   id       — стабильный ключ (на него ссылаются схемы/чаты)
//   name     — человекочитаемое имя ('GPT (Codex)')
//   vendor   — производитель ('OpenAI')
//   color    — фирменный цвет иконки
//   order    — порядок в списках (меньше = выше)
//   install? — команда установки CLI для setup-карточки
//   login?   — отдельная команда авторизации уже установленного CLI; если её нет,
//              карточка использует install как совместимый запасной вариант
//   bin(config)              — какой бинарь пробовать
//   probe(config)            — { ok, version } — установлен ли
//   auth(config, deps)       — { mode, label } — авторизован ли
//   efforts?(config)         — динамическое обнаружение уровней эффорта (или null)
//   modes?(config)           — режимы прав: [{ id, label, hint }] (или null)
//   seedModels()             — стартовый список моделей для models.json
//   catalog?(config)         — полный список моделей, поддерживаемых установленным CLI
//                              (обновляется при смене версии; см. models-registry)
//   catalogLive?             — каталог зависит от rollout/аккаунта, опрашивать каждый кэш-цикл
//   modelFamily?(model)      — стабильное семейство записи каталога для model policy
//   familyClass?(family)     — класс семейства (reasoning|balanced|cheap) для сверки
//                              рекомендаций шаблонов агентов с политикой профиля.
//                              Не объявлен → сверка для этого ИИ не проводится
//   usage?()                 — состояние лимитов + provider-neutral account resources
//   usageActions?            — явная Map-подобная таблица разрешённых действий ресурсов
//   mcpStatus?(config)       — состояние MCP-серверов этого CLI для его плашки:
//                              { state: 'ok'|'error', error?, servers: [{ name, target,
//                              scope: 'user'|'project'|'account', state: 'ok'|'failed'|
//                              'needs-auth'|'unknown', detail }] }. Метод ЛЕНИВЫЙ: его
//                              зовёт только `GET /api/providers/:id/mcp`, потому что
//                              health-check живых серверов стоит секунд. Не объявлен —
//                              у исполнителя нет блока MCP (у него может не быть и
//                              самого понятия MCP, как у HTTP-исполнителя)
//   updateCmd?               — команда обновления CLI (кнопка «Обновить» в настройках)
//   settings?                — СВОИ настройки исполнителя для его плашки в
//                              «Настройках → Исполнители»: [{ id, kind, label, hint?,
//                              value, disabled?, note?, min?, max?, step? }] ЛИБО
//                              async-функция (config) → такой же массив — для деклараций,
//                              зависящих от живого железа/демона (потолок ползунка num_ctx
//                              у Ollama считается от памяти машины). kind: 'toggle' |
//                              'text' | 'number' | 'range' (ползунок, обязаны min/max/step;
//                              значение приводится к числу, как у 'number'). Ручки у разных
//                              ИИ разные, поэтому список объявляет сам executor, а UI только
//                              рисует его по kind. `disabled: true` + `note` — ручка
//                              объявлена, но ещё не подключена к ходу (тумблер показан и
//                              не работает).
//   trustedDirectories?      — применяет ли исполнитель `opts.extraDirs` как доступные
//                              рабочие каталоги новых ходов. `true` либо
//                              `(config) => boolean`, если поддержка зависит от режима
//                              запуска (например, contained/host). Не объявлен → false.
//                              Признак уезжает в `/api/providers`, чтобы UI называл
//                              поддерживающих исполнителей без списка вендоров в Vue.
//   autoCompactEnv?          — имя переменной окружения, которой CLI задаётся ПОРОГ
//                              автокомпакта в токенах. Есть → кокпит подставляет туда
//                              значение из «Настроек → Запуски». Нет → у этого CLI
//                              может быть свой transport через opts.compactWindow.
//   compaction?              — как сжимать контекст по кнопке на кольце:
//                              { kind: 'native', message } — CLI понимает слэш-команду
//                              и в неинтерактивном режиме, сессия сохраняется;
//                              { kind: 'summary' } — родного компакта нет, кокпит
//                              заказывает выжимку текстом и начинает новую сессию с неё.
//                              Поле не объявлено = 'summary' (безопасный дефолт).
//   commands?(config)        — команды CLI/навыки для меню чата:
//                              [{ cmd, desc, run, hint?, args? }]. cmd — '/name'
//                              либо нативное '$name' Codex, без аргументов;
//                              desc — однострочное описание
//                              (сервер режет до 120); run: 'prompt' — исполняется отправкой
//                              текста ходом (доказано гейтом исполняемости), 'none' — только
//                              информационный показ (в кокпите не исполняется, живёт в TUI),
//                              тогда hint — короткая пометка («только в TUI»); args: true —
//                              обязательный аргумент: команда вставляется в композер, а не
//                              отправляется. Не объявлен → у исполнителя нет секции в меню.
//   run(opts)                — выполнить сообщение → { reply, sessionId, contextTokens,
//                              contextWindow?, contextMetric?, contextIsEstimate?, cost }
//                              opts.extraDirs — единый список доверенных/служебных каталогов
//                              opts.providerSettings — выбор из настроек этого исполнителя
//                              opts.chatHistory — server-owned история чата (массив сохранённых
//                              сообщений; для stateless HTTP-исполнителей, реплеящих разговор
//                              из неё; содержит текущее сообщение последним user-блоком)
//                              opts.compactWindow — порог автокомпакта из общих настроек
//                              opts.onStep — колбэк нейтральных шагов хода:
//                              start/think/text/tool/res/note. Каждый executor сам
//                              разбирает свой CLI-поток и показывает только
//                              опубликованное provider-ом резюме рассуждений.
//   untrustedInput?          — capability отдельного model-only transport для текста,
//                              пришедшего извне: { text, images, maxImages, mediaTypes }.
//   runUntrusted?(opts)      — одноразовый ход без coding tools, cwd, project rules,
//                              MCP, сессии и файловых путей. Изображения приходят как
//                              [{ mediaType, data: base64 }]. Обычный run() НЕ является
//                              fallback: permission mode не изолирует prompt injection.
// Карточка установки может не иметь run(): такой адаптер виден в настройках, но не
// попадает в runtime-реестр и потому физически не может получить ход чата. Это нужно
// для поэтапного подключения нового CLI: сначала обычная установка/авторизация, затем
// отдельным изменением transport и модели.
// Папка сканируется при старте: новый исполнитель = новый файл, код ядра не трогаем.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));

let loadedAdapters = null; // Map id → provider adapter
let loadedExecutors = null; // Map id → adapter с run()

/**
 * Все карточки CLI для «Настройки → Исполнители». Адаптер без run() остаётся
 * setup-only: probe/auth/update работают, а выбрать его модель и запустить чат нельзя.
 */
export async function getProviderAdapters() {
  if (loadedAdapters) return loadedAdapters;
  const map = new Map();
  for (const f of readdirSync(DIR).sort()) {
    // Файлы на `_` — вспомогательные модули исполнителей (каталоги моделей и т.п.), не ИИ.
    if (!f.endsWith('.js') || f === 'index.js' || f.startsWith('_')) continue;
    const mod = await import(pathToFileURL(path.join(DIR, f)).href);
    const adapter = mod.default;
    if (adapter?.id && typeof adapter.probe === 'function' && typeof adapter.auth === 'function') {
      map.set(adapter.id, adapter);
    }
  }
  loadedAdapters = new Map(
    [...map.entries()].sort((a, b) => (a[1].order || 99) - (b[1].order || 99)),
  );
  return loadedAdapters;
}

/**
 * Только реально подключённые исполнители. Setup-only карточки намеренно отфильтрованы:
 * наличие CLI на машине не означает, что Cockpit уже умеет безопасно передать ему ход.
 */
export async function getExecutors() {
  if (loadedExecutors) return loadedExecutors;
  loadedExecutors = new Map(
    [...(await getProviderAdapters()).entries()].filter(([, adapter]) => typeof adapter.run === 'function'),
  );
  return loadedExecutors;
}

/**
 * Один исполнитель по id (null — нет такого).
 */
export async function getExecutor(id) {
  return (await getExecutors()).get(id) || null;
}

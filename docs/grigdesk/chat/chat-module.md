# Чат (modules/chat)

- Сервер определяет executor по выбранной модели из `/api/providers`. Claude запускается как
  `claude -p … --output-format stream-json --verbose [--model][--effort][--resume]`;
  Codex поднимает `codex app-server` на один ход: `initialize`/`initialized` →
  `thread/start` для нового разговора либо `thread/resume` по сохранённому thread id →
  `turn/start`. Следующий ход запускает новый app-server process и возобновляет тот же thread.
  По задаче cwd = первый worktree из exact-списка `REPO_COUNT`/`REPO_<i>_*`, остальные
  передаются executor-у как `extraDirs`.
  Для старых песочниц без `REPO_*` совместимо читаются `BE_WT` и `FE_WT`.
  Без задачи cwd задаёт сохранённый выбор `workdir`: GrigDesk, проект или абсолютный путь.
  У задачи без копий читается доверенно связанный проект, затем сохранённый выбор чата.
  Контекст страницы cwd не меняет. [Резолвер и границы](chat-workspace.md),
  [переход памяти](workdir-transition-preconditions.md).

- **Рабочие корни** приходят из выбранной папки, репозиториев проекта и копий задачи.
  Вложения добавляются отдельно. Адаптер публикует `workdir.switch` (resume/reseed) и
  `workdir.roots` (multi/single); UI использует серверный предпросмотр. Общая настройка
  доверенных каталогов и её API удалены. DeepSeek не расширяет cwd до общего предка,
  Kimi contained проверяет запреты монтирования тем же валидатором в preview и runtime.
- **Метрики кольца описаны в продуктовом контракте**
  `docs/grigdesk/guide/chat-context.md`. Claude и Codex измеряют вход последнего
  основного model request; Kimi — статус открытой ACP-сессии после хода;
  DeepSeek — ACP `usage_update.used` во время хода. Накопительный расход не становится контекстом.
  Полный снимок (`contextTokens`, `contextWindow`, `contextMetric`,
  `contextIsEstimate`) проходит через `onProgress`, SSE, `/api/chat/active`,
  остановку и runtime `liveContextUsage` в браузере без записи истории на каждый запрос.
  Codex отправляет собственные `thread/tokenUsage/updated` сразу, а fallback берёт
  из последнего `token_count` точного rollout-файла. Claude не принимает
  `result.usage` и события субагента за основной контекст, после `compact_boundary`
  ждёт новый замер.
  Kimi добирает `/usage`, когда `/status` не содержит размера (`kimi/runtime.ts`).
  Ноль — измерение; `unavailable` и `legacy-unavailable` — отсутствие точной цифры.
  Неизвестное окно не заменяется видимыми 200k. Пока свежего замера нет, подсказка
  называет показанную цифру замером прошлого хода.
  Настройка автосжатия учитывается лишь при `capabilities.chatAutoCompact`:
  её применяют Claude и Codex, а Kimi/DeepSeek используют шкалу 80% окна.
- **Prompt cache — отдельная provider-neutral метрика ПОСЛЕДНЕГО model request**, а не часть
  шкалы кольца и не накопительный расход сессии. Executor отдаёт
  `contextCache: { scope: 'request', status, readTokens?, writeTokens?, uncachedTokens? }`,
  где `status` — `reported`, `unavailable` или `not-applicable`. Claude сообщает чтение,
  запись и некэшированный вход; Codex — чтение и некэшированный вход, но не выдумывает
  отсутствующую у CLI запись; Kimi явно отдаёт `unavailable`.
  Отсутствующее числовое поле означает «provider не сообщил», а не ноль. По одному размеру
  контекста GrigDesk не делает вывод ни о cache hit, ни о цене: подсказка показывает только
  фактические read/write/uncached, которые пришли в `contextCache`.
- Память агента — в сессиях выбранного CLI. Для Claude/Codex GrigDesk хранит `sessionId`
  в записи чата; у Kimi resume id принадлежит отдельному server-owned CAS sidecar-у
  (`ChatSessionBindingStore`), поэтому stale/поддельный PUT браузера не может назначить session.
- **Пустой ответ Claude («пусто»):** `claude -p` может вернуть result без текста — агент завершил ход
  tool-call'ом, который plan-режим запретил (Bash/Write и т.п.), или упёрся в лимит шагов.
  Сервер маппит это в понятное «⚠ …»-сообщение (по `subtype` и `permission_denials`) и пишет
  warn в лог. Типичный триггер: просьба «сделай/запусти/разбери файл» — чат только читает.
- Один Pinia-стор `chat` остаётся владельцем всех разговоров, pending и SSE. Полный
  `ChatSession` монтируется только на странице `/chats`; глобальный `CompanionHost`
  показывает компактный avatar/bubble поверх той же истории и не создаёт второй transport.
- **Плашки над композером — отдельные компоненты** рядом с `ChatSession.vue`: `StepList.vue` (лента шагов
  хода), `ChatQuestion.vue` (вопрос агента), `ChatPermission.vue` (запрос разрешения / план на
  утверждение). Каждая держит свою разметку, стили и мелкое состояние; ChatSession только решает,
  какую показать, и передаёт ответ в стор. Разрешение и вопрос приходят по SSE в стор глобально —
  компонент показывается, если `chatKey` совпал с открытым чатом (`forThisChat`).
